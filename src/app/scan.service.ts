import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import {
  CATEGORY_IDS,
  CategoryId,
  CategoryStat,
  CleanTarget,
  DEFAULT_FILTER,
  DriveInfo,
  DupeGroup,
  DupeProgress,
  DupeResult,
  FilterSpec,
  FindHit,
  FolderNode,
  FsEntry,
  LargestFile,
  LastCleanup,
  PieSlice,
  Row,
  ScanTotals,
  SizeUnit,
  SortKey,
  SortOption,
  TypeStat,
  ViewMode,
  categoryOf,
} from './models';
import { I18n } from './i18n.service';
import { APP_NAME, I18nKey } from './i18n';

/** Localized label / parenthetical hint of each coarse file category. */
const CAT_LABEL: Record<CategoryId, I18nKey> = {
  folders: 'catFolders',
  apps: 'catApps',
  system: 'catSystem',
  archives: 'catArchives',
  models3d: 'catModels3d',
  images: 'catImages',
  videos: 'catVideos',
  audio: 'catAudio',
  documents: 'catDocuments',
  code: 'catCode',
  other: 'catOther',
};
const CAT_HINT: Record<CategoryId, I18nKey> = {
  folders: 'catHintFolders',
  apps: 'catHintApps',
  system: 'catHintSystem',
  archives: 'catHintArchives',
  models3d: 'catHintModels3d',
  images: 'catHintImages',
  videos: 'catHintVideos',
  audio: 'catHintAudio',
  documents: 'catHintDocuments',
  code: 'catHintCode',
  other: 'catHintOther',
};

/** How many "largest files" the right panel and its dialog keep. */
const LARGEST_LIMIT = 300;
/** How many rows the "largest files of the drive" dialog keeps. */
const GLOBAL_LARGEST_LIMIT = 500;

/** Case-insensitive wildcard match supporting `*` and `?`. */
function wildcardMatch(name: string, mask: string): boolean {
  const rx = mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    return new RegExp('^' + rx + '$', 'i').test(name);
  } catch {
    return false;
  }
}

const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1',
  '#ff9da7', '#9c755f', '#bab0ac', '#86bcb6', '#d37295', '#8cd17d', '#f1ce63', '#79706e',
];

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}
function dirName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return p;
  if (i === 2 && s[1] === ':') return s.slice(0, 3); // "C:\"
  return s.slice(0, i);
}

/** Lowercased file extension without the dot ('' when there is none). */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** Build donut slices (SVG path `d`) from label/size data, keeping the top N. */
function makeSlices(dataIn: { label: string; size: number }[], total: number, restLabel = 'Other', top = 14): PieSlice[] {
  if (!total || !dataIn.length) return [];
  let data = dataIn.slice();
  if (data.length > top) {
    const rest = data.slice(top).reduce((a, b) => a + b.size, 0);
    data = data.slice(0, top);
    data.push({ label: restLabel, size: rest });
  }
  const cx = 120;
  const cy = 120;
  const r = 108;
  let angle = -Math.PI / 2;
  return data.map((it, i) => {
    const frac = it.size / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const d =
      frac >= 0.9999
        ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
        : `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
    return { label: it.label, size: it.size, percent: frac * 100, color: PALETTE[i % PALETTE.length], d };
  });
}

@Injectable({ providedIn: 'root' })
export class ScanService {
  private readonly i18n = inject(I18n);
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly drives = signal<DriveInfo[]>([]);
  readonly totals = signal<ScanTotals>({ files: 0, folders: 0, bytes: 0 });
  readonly scanning = signal(false);
  /** Folder being walked right now (workers tick every ~200 ms). */
  readonly currentDir = signal<string | null>(null);
  readonly elapsedMs = signal(0);
  readonly error = signal<string | null>(null);
  /** Transient message in the status bar (e.g. a drive was plugged in). */
  readonly notice = signal<string | null>(null);
  readonly selectedPath = signal<string | null>(null);
  readonly sizeUnit = signal<SizeUnit>('auto');
  readonly showChart = signal(true);
  /** drives/volumes panel (View ▸ Drive Info) */
  readonly showDriveInfo = signal(true);
  /** startup screen (read by the main process on the next launch) */
  readonly showSplash = signal(true);
  /** appearance: light or dark (Options ▸ Appearance) */
  /** Theme preference: light/dark, or "system" to follow the Windows setting. */
  readonly themePref = signal<'light' | 'dark' | 'system'>('system');
  /** Effective theme applied to the UI (resolved from the preference). */
  readonly theme = signal<'light' | 'dark'>('light');
  /** Files per second, smoothed over the last progress ticks (scan only). */
  readonly rate = signal(0);
  /** Show the "on disk" column (real allocation, not the logical size). */
  readonly showDisk = signal(true);
  /** Paths/name globs skipped by the scan (main process + workers). */
  readonly excludes = signal<string[]>([]);
  /** Result of the last safe-cleanup run (kept in the settings). */
  readonly lastCleanup = signal<{ at: number; freed: number; files: number; errors: number; log: string | null } | null>(null);
  /** table row density */
  readonly density = signal<'normal' | 'compact'>('normal');
  readonly rootPath = signal<string | null>(null);
  /** real-time monitoring state (mirrors the main-process watcher) */
  readonly monitorEnabled = signal(true);
  /** "minimize to tray" (main process keeps running in the background) */
  readonly minimizeToTray = signal(false);
  readonly pendingChanges = signal(0);
  readonly pendingPaths = signal<string[]>([]);
  /** extension filter driven by the "Tipos de arquivo" panel (independent of the modal filter) */
  readonly extFilter = signal<ReadonlySet<string>>(new Set<string>());

  // ---- duplicate finder -----------------------------------------------------
  /** Byte-identical groups of the last search (empty until it finishes). */
  readonly dupes = signal<DupeGroup[]>([]);
  readonly dupeState = signal<'idle' | 'running' | 'done' | 'error'>('idle');
  readonly dupeProgress = signal<DupeProgress | null>(null);
  readonly dupeElapsedMs = signal(0);
  readonly dupeError = signal<string | null>(null);
  /** Smallest file considered (bytes). */
  readonly dupeMinSize = signal(1024 * 1024);
  /** Total size that can be reclaimed (one copy of each group is kept). */
  readonly dupeWasted = computed(() => this.dupes().reduce((sum, g) => sum + g.size * (g.paths.length - 1), 0));
  readonly dupeFileCount = computed(() => this.dupes().reduce((n, g) => n + g.paths.length, 0));
  private dupeDisposers: (() => void)[] = [];

  // ---- safe cleanup ---------------------------------------------------------
  /** Targets sent by the main process (sizes are filled in while it measures). */
  readonly cleanTargets = signal<CleanTarget[]>([]);
  readonly cleanState = signal<'idle' | 'measuring' | 'deleting'>('idle');
  readonly cleanSummary = signal<{ freed: number; files: number; errors: number } | null>(null);
  private cleanDisposers: (() => void)[] = [];
  /** Rows from an on-demand listing when the selected folder is outside the scanned tree. */
  private readonly externalRows = signal<Row[]>([]);

  /** bumped whenever the tree changes, so computed() signals recompute */
  /** Bumped whenever the tree/rows change (mutable nodes are not signals). */
  readonly revision = signal(0);

  /** active filter (applied to the listing/tree/pie) */
  readonly filter = signal<FilterSpec>({ ...DEFAULT_FILTER });

  /** result-list sorting */
  readonly sortKey = signal<SortKey>('size');
  readonly sortDir = signal<'asc' | 'desc'>('desc');

  /** live text filter over the visible list (search box) */
  readonly search = signal('');
  /** list | grid rendering of the result list */
  readonly viewMode = signal<ViewMode>('list');
  /** when the last scan finished (folder header "última análise") */
  readonly lastScanAt = signal<number | null>(null);
  /** user-pinned folders shown in the sidebar (persisted) */
  readonly favorites = signal<string[]>([]);
  /** recently scanned roots, offered by the path box dropdown (persisted) */
  readonly recentRoots = signal<string[]>([]);
  /** shell folders (Downloads, Documents, …) resolved by the main process */
  readonly knownFolders = signal<{ id: string; path: string }[]>([]);

  /** Toolbar sort combo <-> (sortKey, sortDir). */
  readonly sortOption = computed<SortOption>(() => {
    const asc = this.sortDir() === 'asc';
    switch (this.sortKey()) {
      case 'name':
        return asc ? 'name-asc' : 'name-desc';
      case 'modified':
        return asc ? 'modified-asc' : 'modified-desc';
      case 'files':
      case 'folders':
      case 'items':
        return 'items-desc';
      default:
        return asc ? 'size-asc' : 'size-desc';
    }
  });

  setSortOption(id: string): void {
    const [key, dir] = id.split('-');
    const keys: Record<string, SortKey> = { name: 'name', size: 'size', modified: 'modified', items: 'items' };
    this.sortKey.set(keys[key] ?? 'size');
    this.sortDir.set(dir === 'asc' ? 'asc' : 'desc');
    this.persist();
  }

  setSearch(v: string): void {
    this.search.set(v);
  }

  setViewMode(v: ViewMode): void {
    this.viewMode.set(v);
    this.persist();
  }

  // ---- sidebar: favorite folders + recent roots -----------------------------
  async loadKnownFolders(): Promise<void> {
    if (!window.driversize?.knownFolders) return;
    this.knownFolders.set(((await window.driversize.knownFolders()) ?? []) as { id: string; path: string }[]);
  }

  addFavorite(p: string): void {
    if (!p) return;
    this.favorites.update((list) => (list.includes(p) ? list : [...list, p]));
    this.persist();
  }

  removeFavorite(p: string): void {
    this.favorites.update((list) => list.filter((x) => x !== p));
    this.persist();
  }

  private pushRecentRoot(p: string): void {
    this.recentRoots.update((list) => [p, ...list.filter((x) => x !== p)].slice(0, 8));
    this.persist();
  }

  // ---- type column ----------------------------------------------------------
  categoryName(id: CategoryId): string {
    return this.i18n.t(CAT_LABEL[id]);
  }
  categoryHint(id: CategoryId): string {
    return this.i18n.t(CAT_HINT[id]);
  }
  rowCategory(r: Row): CategoryId {
    if (r.kind === 'folder') return 'folders';
    return categoryOf(extOf(r.name));
  }
  /** "Aplicação" for apps, "Arquivo ZIP" for the rest, "Pasta" for folders. */
  rowType(r: Row): string {
    if (r.kind === 'folder') return this.i18n.t('typeFolder');
    return this.extTypeName(extOf(r.name));
  }

  /** Same label derived from an extension (file-type table + largest files). */
  extTypeName(ext: string): string {
    if (!ext) return this.i18n.t('typeFile');
    if (categoryOf(ext) === 'apps') return this.i18n.t('typeApp');
    return this.i18n.t('typeFile') + ' ' + ext.toUpperCase();
  }

  setSort(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortKey.set(key);
      this.sortDir.set(key === 'name' ? 'asc' : 'desc');
    }
    this.persist();
  }

  setSizeUnit(u: SizeUnit): void {
    this.sizeUnit.set(u);
    this.persist();
  }

  toggleChart(): void {
    this.showChart.update((v) => !v);
    this.persist();
  }

  toggleDriveInfo(): void {
    this.showDriveInfo.update((v) => !v);
    this.persist();
  }

  setShowChart(v: boolean): void {
    this.showChart.set(!!v);
    this.persist();
  }

  setShowDriveInfo(v: boolean): void {
    this.showDriveInfo.set(!!v);
    this.persist();
  }

  setShowSplash(v: boolean): void {
    this.showSplash.set(!!v);
    this.persist();
  }

  /** Theme preference (light/dark/system); "system" follows the Windows setting. */
  setThemePref(v: 'light' | 'dark' | 'system'): void {
    this.themePref.set(v === 'dark' || v === 'light' ? v : 'system');
    this.applyTheme();
    this.persist();
  }
  setTheme(v: 'light' | 'dark'): void {
    this.setThemePref(v);
  }
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');
  /** Resolves the preference into the effective theme and repaints the window. */
  private applyTheme(): void {
    const pref = this.themePref();
    const dark = pref === 'dark' || (pref === 'system' && this.media.matches);
    this.theme.set(dark ? 'dark' : 'light');
    void window.driversize?.setTheme(this.theme());
  }
  setShowDisk(v: boolean): void {
    this.showDisk.set(!!v);
    this.persist();
  }
  /** Exclusion list edited in Options ▸ Scan (applied on the next scan). */
  setExcludes(list: string[]): void {
    this.excludes.set(
      list
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    this.persist();
  }

  setDensity(v: 'normal' | 'compact'): void {
    this.density.set(v === 'compact' ? 'compact' : 'normal');
    this.persist();
  }

  // ---- persistence ---------------------------------------------------------
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private persist(): void {
    if (!window.driversize?.setSettings) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void window.driversize!.setSettings({
        sortKey: this.sortKey(),
        sortDir: this.sortDir(),
        sizeUnit: this.sizeUnit(),
        filter: this.filter(),
        showChart: this.showChart(),
        showDriveInfo: this.showDriveInfo(),
        showSplash: this.showSplash(),
        theme: this.themePref(),
        density: this.density(),
        showDisk: this.showDisk(),
        exclude: this.excludes(),
        viewMode: this.viewMode(),
        favorites: this.favorites(),
        recentRoots: this.recentRoots(),
      });
    }, 400);
  }

  async loadSettings(): Promise<void> {
    const s = (await window.driversize?.getSettings()) as Record<string, unknown> | undefined;
    if (!s) return;
    if (typeof s['sortKey'] === 'string') this.sortKey.set(s['sortKey'] as SortKey);
    if (s['sortDir'] === 'asc' || s['sortDir'] === 'desc') this.sortDir.set(s['sortDir']);
    if (typeof s['sizeUnit'] === 'string') this.sizeUnit.set(s['sizeUnit'] as SizeUnit);
    if (s['filter'] && typeof s['filter'] === 'object') {
      this.filter.set({ ...DEFAULT_FILTER, ...(s['filter'] as Partial<FilterSpec>) });
    }
    if (typeof s['showChart'] === 'boolean') this.showChart.set(s['showChart']);
    if (typeof s['showDriveInfo'] === 'boolean') this.showDriveInfo.set(s['showDriveInfo']);
    if (typeof s['showSplash'] === 'boolean') this.showSplash.set(s['showSplash']);
    if (s['theme'] === 'light' || s['theme'] === 'dark' || s['theme'] === 'system') this.themePref.set(s['theme']);
    if (typeof s['showDisk'] === 'boolean') this.showDisk.set(s['showDisk']);
    if (Array.isArray(s['exclude'])) {
      this.excludes.set((s['exclude'] as unknown[]).filter((x): x is string => typeof x === 'string'));
    }
    if (s['density'] === 'normal' || s['density'] === 'compact') this.density.set(s['density']);
    // Resolve light/dark/system and paint the native caption buttons.
    this.applyTheme();
    if (typeof s['monitorEnabled'] === 'boolean') this.monitorEnabled.set(s['monitorEnabled']);
    if (typeof s['minimizeToTray'] === 'boolean') this.minimizeToTray.set(s['minimizeToTray']);
    if (s['viewMode'] === 'list' || s['viewMode'] === 'grid') this.viewMode.set(s['viewMode']);
    if (Array.isArray(s['favorites'])) this.favorites.set((s['favorites'] as unknown[]).filter((x): x is string => typeof x === 'string'));
    if (Array.isArray(s['recentRoots'])) this.recentRoots.set((s['recentRoots'] as unknown[]).filter((x): x is string => typeof x === 'string'));
  }

  private applySort(list: Row[]): Row[] {
    const k = this.sortKey();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    // Size-based columns keep folders grouped at the top, then files — both
    // still ordered by size (ascending/descending) inside their own group.
    const foldersFirst = k === 'size' || k === 'allocated' || k === 'percent';
    return list.slice().sort((a, b) => {
      if (foldersFirst) {
        const fa = a.kind === 'folder' ? 0 : 1;
        const fb = b.kind === 'folder' ? 0 : 1;
        if (fa !== fb) return fa - fb;
      }
      return this.compare(a, b, k) * dir;
    });
  }

  private compare(a: Row, b: Row, k: SortKey): number {
    switch (k) {
      case 'name':
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      case 'allocated':
        return a.allocated - b.allocated;
      case 'files':
        return a.files - b.files;
      case 'folders':
        return a.folders - b.folders;
      case 'items':
        return (a.items ?? 0) - (b.items ?? 0);
      case 'modified':
        return a.mtime - b.mtime;
      case 'percent':
      case 'size':
      default:
        return a.size - b.size;
    }
  }

  /** Same ordering for tree nodes (folders only, no `items`/allocated columns). */
  private compareNodes(a: FolderNode, b: FolderNode, k: SortKey): number {
    switch (k) {
      case 'name':
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      case 'files':
        return a.files - b.files;
      case 'folders':
        return a.folders - b.folders;
      case 'items':
        return a.children.length + a.childFiles.length - (b.children.length + b.childFiles.length);
      case 'modified':
        return a.mtime - b.mtime;
      case 'allocated':
        return a.allocated - b.allocated;
      default:
        return a.size - b.size;
    }
  }

  private root: FolderNode | null = null;
  private readonly folders = new Map<string, FolderNode>();

  // ---- navigation history (back/forward) -----------------------------------
  private history: string[] = [];
  private historyIndex = -1;
  private readonly navRev = signal(0);

  // Electron IPC callbacks fire outside Angular's zone -> run them inside it so
  // the view refreshes as data streams in (instead of only on the next click).
  private readonly zone = inject(NgZone);
  constructor() {
    // Follow the Windows light/dark setting live while the preference is "system".
    this.media.addEventListener('change', () => {
      if (this.themePref() === 'system') this.applyTheme();
    });
  }
  private disposers: (() => void)[] = [];

  // ---- tree ----------------------------------------------------------------
  private ensureFolder(path: string): FolderNode {
    const existing = this.folders.get(path);
    if (existing) return existing;
    const parent = dirName(path);
    const node: FolderNode = {
      path,
      name: baseName(path) || path,
      parent,
      size: 0,
      allocated: 0,
      files: 0,
      folders: 0,
      mtime: 0,
      expanded: false,
      children: [],
      childFiles: [],
    };
    this.folders.set(path, node);
    if (this.root && parent && parent !== path) {
      const p = this.ensureFolder(parent);
      if (!p.children.includes(node)) p.children.push(node);
    }
    return node;
  }

  private onBatch(entries: FsEntry[]): void {
    if (!this.root) return;
    for (const e of entries) {
      if (e.isDir) {
        const node = this.ensureFolder(e.path);
        node.mtime = e.mtime;
        // count this folder and every ancestor (bounded: malformed parent
        // chains must never spin forever)
        let cur: FolderNode | undefined = node;
        for (let hops = 0; hops < 4096; hops++) {
          const p = this.folders.get(cur.parent);
          if (!p || p === cur) break;
          p.folders += 1;
          if (p === this.root) break;
          cur = p;
        }
      } else {
        const parent = this.ensureFolder(e.parent);
        parent.childFiles.push(e);
        // climb adding size/alloc/files (mirrors bottom-up aggregation)
        let cur: FolderNode | undefined = parent;
        for (let hops = 0; hops < 4096; hops++) {
          cur.size += e.size;
          cur.allocated += e.allocated;
          cur.files += 1;
          if (cur === this.root) break;
          const p = this.folders.get(cur.parent);
          if (!p || p === cur) break;
          cur = p;
        }
      }
    }
    if (entries.length) this.scheduleRevision();
  }

  // Batches arrive every few milliseconds during a big scan; re-rendering the
  // tree/table/chart for each one saturates the main thread and makes the window
  // feel stuck. Coalesce them into at most one refresh every 120 ms.
  private revTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleRevision(): void {
    if (this.revTimer) return;
    this.revTimer = setTimeout(() => {
      this.revTimer = null;
      this.revision.update((v) => v + 1);
    }, 120);
  }

  private flushRevision(): void {
    if (this.revTimer) {
      clearTimeout(this.revTimer);
      this.revTimer = null;
      this.revision.update((v) => v + 1);
    }
  }

  // ---- scan speed -----------------------------------------------------------
  private rateSample = { t: 0, files: 0 };

  /** Totals tick: also derives the files/second shown in the status bar. */
  private onTotals(p: ScanTotals): void {
    this.totals.set(p);
    const now = performance.now();
    const prev = this.rateSample;
    if (!prev.t) {
      this.rateSample = { t: now, files: p.files };
      return;
    }
    const dt = now - prev.t;
    if (dt < 300) return; // keep the baseline; the ticks come every ~200 ms
    this.rateSample = { t: now, files: p.files };
    const instant = Math.max(0, ((p.files - prev.files) * 1000) / dt);
    this.rate.set(this.rate() * 0.55 + instant * 0.45);
  }

  /** Global name search over the whole scanned tree (files and folders). */
  findAll(query: string, limit = 400): FindHit[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: FindHit[] = [];
    for (const node of this.folders.values()) {
      if (node !== this.root && node.name.toLowerCase().includes(q)) {
        out.push({
          path: node.path,
          name: node.name,
          kind: 'folder',
          size: node.size,
          allocated: node.allocated,
          mtime: node.mtime,
          parent: node.parent,
        });
      }
      for (const f of node.childFiles) {
        if (f.name.toLowerCase().includes(q)) {
          out.push({
            path: f.path,
            name: f.name,
            kind: 'file',
            size: f.size,
            allocated: f.allocated,
            mtime: f.mtime,
            parent: node.path,
          });
        }
      }
      if (out.length > limit * 12) break; // bounded work on huge trees
    }
    out.sort((a, b) => b.size - a.size);
    return out.slice(0, limit);
  }

  // ---- filter (applied to the listing/tree/pie) ----------------------------
  setFilter(patch: Partial<FilterSpec>): void {
    this.filter.update((f) => ({ ...f, ...patch }));
    this.persist();
  }

  clearFilter(): void {
    this.filter.set({ ...DEFAULT_FILTER });
    this.persist();
  }

  private matchesMasks(name: string, spec: FilterSpec): boolean {
    const seps = spec.maskSeparator || ';';
    const masks = spec.masks
      .split(seps)
      .map((m) => m.trim())
      .filter(Boolean);
    if (!masks.length) return true;
    return masks.some((m) => wildcardMatch(name, m));
  }

  /** Decide whether an entry is included by the filter (mirrors the observed 4 dimensions). */
  private passes(f: FsEntry, spec: FilterSpec): boolean {
    if (f.isDir && !spec.includeFolders) return false;
    if (!f.isDir && !spec.includeFiles) return false;

    const dimsActive = !!spec.masks.trim() || spec.sizeEnabled || spec.attrEnabled || spec.dateEnabled;
    if (!dimsActive) return true;

    let ok = true;
    if (spec.masks.trim()) ok = ok && this.matchesMasks(f.name, spec);
    if (spec.sizeEnabled) {
      const factor = spec.sizeUnit === 'KB' ? 1024 : spec.sizeUnit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024;
      const min = spec.sizeMinMB * factor;
      const max = spec.sizeMaxMB * factor;
      ok =
        ok &&
        (spec.sizeMode === 'gt'
          ? f.size > min
          : spec.sizeMode === 'lt'
            ? f.size < min
            : spec.sizeMode === 'between'
              ? f.size >= min && f.size <= max
              : f.size < min || f.size > max);
    }
    if (spec.attrEnabled) {
      const m = spec.attrMask;
      ok =
        ok &&
        (spec.attrMode === 'none'
          ? (f.attrs & m) === 0
          : spec.attrMode === 'exact'
            ? f.attrs === m
            : (f.attrs & m) === m);
    }
    if (spec.dateEnabled) {
      const t = spec.dateField === 'created' ? f.ctime : spec.dateField === 'accessed' ? f.atime : f.mtime;
      const from = spec.dateFrom ? Date.parse(spec.dateFrom + 'T00:00:00') : NaN;
      const to = spec.dateTo ? Date.parse(spec.dateTo + 'T23:59:59') : NaN;
      ok =
        ok &&
        (spec.dateMode === 'before'
          ? !Number.isNaN(from) && t < from
          : spec.dateMode === 'after'
            ? !Number.isNaN(from) && t > from
            : !Number.isNaN(from) && !Number.isNaN(to) && t >= from && t <= to);
    }

    return spec.invert ? !ok : ok;
  }

  /** A folder seen as a filterable entry: its size is the REAL aggregate size. */
  private dirEntry(n: FolderNode): FsEntry {
    return { path: n.path, parent: n.parent, name: n.name, isDir: true, size: n.size, allocated: n.allocated, mtime: n.mtime, atime: n.mtime, ctime: n.mtime, attrs: 0x10 };
  }

  /**
   * Build the filtered view by PRUNING the scanned tree: a file is kept when it
   * passes the filter; a folder is kept when it passes itself (by its real
   * aggregate size / name / dates) or when it has any kept descendant. Sizes and
   * counts shown remain the REAL ones (filters never change a size).
   */
  private buildFiltered(raw: FolderNode, spec: FilterSpec): FolderNode {
    const childFiles = raw.childFiles.filter((f) => this.passes(f, spec));
    const children: FolderNode[] = [];
    for (const c of raw.children) {
      const cv = this.buildFiltered(c, spec);
      const keep = cv.children.length > 0 || cv.childFiles.length > 0 || this.passes(this.dirEntry(c), spec);
      if (keep) children.push(cv);
    }
    return {
      path: raw.path,
      name: raw.name,
      parent: raw.parent,
      size: raw.size,
      allocated: raw.allocated,
      files: raw.files,
      folders: raw.folders,
      mtime: raw.mtime,
      expanded: raw.expanded,
      children,
      childFiles,
    };
  }

  /** Root of the (optionally filtered) view used by the tree/table/pie. */
  readonly viewRoot = computed<FolderNode | null>(() => {
    this.revision();
    const spec = this.filter();
    if (!this.root) return null;
    if (!spec.enabled) return this.root;
    return this.buildFiltered(this.root, spec);
  });

  readonly viewIndex = computed<Map<string, FolderNode>>(() => {
    const map = new Map<string, FolderNode>();
    const root = this.viewRoot();
    if (root) {
      const walk = (n: FolderNode): void => {
        map.set(n.path, n);
        for (const c of n.children) walk(c);
      };
      walk(root);
    }
    return map;
  });

  // ---- api -----------------------------------------------------------------
  async loadDrives(): Promise<void> {
    if (!window.driversize) return;
    this.drives.set((await window.driversize.listDrives()) as DriveInfo[]);
  }

  /** Hot-plug refresh: the main process re-read the drives (pendrive, external disk). */
  setDrives(list: DriveInfo[]): void {
    this.drives.set(list);
  }

  /** Show a transient message in the status bar (nothing happens if it is empty). */
  notify(message: string): void {
    if (!message) return;
    this.notice.set(message);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), 8000);
  }

  /**
   * Drop the current folder/scan state — used when the drive being viewed is
   * unplugged, so the app does not keep showing a path that no longer exists.
   */
  reset(): void {
    this.folders.clear();
    this.root = null;
    this.rootPath.set(null);
    this.selectedPath.set(null);
    this.currentDir.set(null);
    this.clearDupes();
    this.history = [];
    this.historyIndex = -1;
    this.navRev.update((v) => v + 1);
    this.totals.set({ files: 0, folders: 0, bytes: 0 });
    this.elapsedMs.set(0);
    this.lastScanAt.set(null);
    this.search.set('');
    this.clearPending();
    this.error.set(null);
    this.revision.update((v) => v + 1);
  }

  async pickFolder(): Promise<string | null> {
    return window.driversize ? await window.driversize.pickFolder() : null;
  }

  async startScan(root: string): Promise<void> {
    if (!window.driversize) {
      this.error.set(this.i18n.t('errApi'));
      return;
    }
    this.folders.clear();
    this.root = null;
    this.root = this.ensureFolder(root);
    this.root.expanded = true;
    this.rootPath.set(root);
    // Remember the current folder so a "rescan" keeps the user where they were.
    const previous = this.selectedPath();
    this.selectedPath.set(root);
    this.history = [root];
    this.historyIndex = 0;
    this.navRev.update((v) => v + 1);
    this.totals.set({ files: 0, folders: 0, bytes: 0 });
    this.elapsedMs.set(0);
    this.clearPending();
    this.clearDupes();
    this.error.set(null);
    this.search.set('');
    this.pushRecentRoot(root);
    this.scanning.set(true);
    this.currentDir.set(root);
    this.rate.set(0);
    this.rateSample = { t: 0, files: 0 };
    if (this.revTimer) clearTimeout(this.revTimer);
    this.revTimer = null;
    this.revision.update((v) => v + 1);

    for (const d of this.disposers) d();
    this.disposers = [
      window.driversize.onBatch((entries) => this.zone.run(() => this.onBatch(entries as FsEntry[]))),
      window.driversize.onProgress((p) => this.zone.run(() => this.onTotals(p as ScanTotals))),
      window.driversize.onCurrent((dir) => this.zone.run(() => this.currentDir.set(dir || null))),
      window.driversize.onDone((s) =>
        this.zone.run(() => {
          const sum = s as ScanTotals & { elapsedMs: number; cancelled?: boolean };
          this.totals.set({ files: sum.files, folders: sum.folders, bytes: sum.bytes });
          this.elapsedMs.set(sum.elapsedMs || 0);
          this.scanning.set(false);
          this.currentDir.set(null);
          this.rate.set(0);
          this.flushRevision();
          this.revision.update((v) => v + 1);
          if (!sum.cancelled) this.lastScanAt.set(Date.now());
          // After a rescan, go back to the folder the user was viewing (if it still exists).
          if (!sum.cancelled && previous && previous !== root && previous.startsWith(root) && this.folders.has(previous)) {
            void this.select(previous, false);
          }
        }),
      ),
      window.driversize.onError((m) =>
        this.zone.run(() => {
          this.error.set(String(m));
          this.scanning.set(false);
          this.currentDir.set(null);
        }),
      ),
    ];

    const r = await window.driversize.startScan(root);
    if (!r.ok) {
      this.zone.run(() => {
        this.error.set(r.error ?? 'erro');
        this.scanning.set(false);
      });
    }
  }

  async cancel(): Promise<void> {
    if (window.driversize) await window.driversize.cancelScan();
    this.currentDir.set(null);
  }

  // ---- duplicate finder -----------------------------------------------------
  /**
   * Files whose size repeats are the only possible duplicates, so the renderer
   * filters those out before hashing; the worker confirms them byte by byte.
   */
  private collectDupeCandidates(minSize: number): { path: string; size: number }[] {
    const root = this.root;
    if (!root) return [];
    const bySize = new Map<number, string[]>();
    const walk = (node: FolderNode): void => {
      for (const f of node.childFiles) {
        if (f.size < minSize) continue;
        const list = bySize.get(f.size);
        if (list) list.push(f.path);
        else bySize.set(f.size, [f.path]);
      }
      for (const c of node.children) walk(c);
    };
    walk(root);
    const out: { path: string; size: number }[] = [];
    for (const [size, paths] of bySize) {
      if (paths.length < 2) continue;
      for (const path of paths) out.push({ path, size });
    }
    return out;
  }

  /** Starts a duplicate search over the analysed root (hash worker in the main process). */
  async startDupeSearch(minSize = this.dupeMinSize()): Promise<void> {
    const api = window.driversize;
    if (!api || !this.root || this.scanning()) return;
    this.dupeMinSize.set(minSize);
    this.dupes.set([]);
    this.dupeError.set(null);
    this.dupeElapsedMs.set(0);
    const files = this.collectDupeCandidates(minSize);
    if (!files.length) {
      this.dupeProgress.set(null);
      this.dupeState.set('done');
      return;
    }
    this.dupeState.set('running');
    this.dupeProgress.set({ phase: 'partial', done: 0, total: files.length });
    this.bindDupeEvents();
    const r = await api.startDupes(files);
    if (!r.ok) {
      this.dupeState.set('error');
      this.dupeError.set(r.error ?? 'error');
      this.dupeProgress.set(null);
    }
  }

  async cancelDupeSearch(): Promise<void> {
    await window.driversize?.cancelDupes();
    this.dupeProgress.set(null);
    this.dupeState.set('idle');
    this.dupes.set([]);
  }

  /** Forget a whole duplicate search (closing the dialog). */
  clearDupes(): void {
    for (const d of this.dupeDisposers) d();
    this.dupeDisposers = [];
    this.dupes.set([]);
    this.dupeProgress.set(null);
    this.dupeState.set('idle');
    this.dupeError.set(null);
  }

  /** Deleted/renamed files leave the groups; a group shorter than two disappears. */
  pruneDupes(paths: string[]): void {
    if (!this.dupes().length || !paths.length) return;
    const gone = new Set(paths);
    this.dupes.set(
      this.dupes()
        .map((g) => ({ ...g, paths: g.paths.filter((p) => !gone.has(p)) }))
        .filter((g) => g.paths.length > 1),
    );
  }

  private bindDupeEvents(): void {
    for (const d of this.dupeDisposers) d();
    this.dupeDisposers = [];
    const api = window.driversize;
    if (!api) return;
    this.dupeDisposers = [
      api.onDupeProgress((p) => this.zone.run(() => this.dupeProgress.set(p as DupeProgress))),
      api.onDupesDone((r) =>
        this.zone.run(() => {
          const res = r as DupeResult;
          this.dupeProgress.set(null);
          this.dupeElapsedMs.set(res.elapsedMs || 0);
          if (res.cancelled) {
            this.dupeState.set('idle');
            this.dupes.set([]);
            return;
          }
          this.dupes.set(res.groups ?? []);
          this.dupeState.set('done');
        }),
      ),
      api.onDupesError((m) =>
        this.zone.run(() => {
          this.dupeProgress.set(null);
          this.dupeState.set('error');
          this.dupeError.set(String(m));
        }),
      ),
    ];
  }

  // ---- safe cleanup ---------------------------------------------------------
  /** Ask the main process to measure the known junk locations. */
  scanCleanTargets(): void {
    const api = window.driversize;
    if (!api) return;
    this.bindCleanEvents();
    this.cleanSummary.set(null);
    this.cleanState.set('measuring');
    this.cleanTargets.set([]);
    void api.cleanScan();
  }

  cancelClean(): void {
    void window.driversize?.cancelClean();
    this.cleanState.set('idle');
  }

  /** Clears the selected targets (the dialog confirms before calling this). */
  async cleanSelected(ids: string[]): Promise<void> {
    const api = window.driversize;
    if (!api || !ids.length) return;
    this.cleanState.set('deleting');
    try {
      const r = await api.cleanDelete(ids);
      const result = { freed: r.freed ?? 0, files: r.files ?? 0, errors: r.errors ?? 0 };
      this.cleanSummary.set(result);
      this.lastCleanup.set({ at: Date.now(), ...result, log: r.log ?? null });
    } finally {
      this.cleanState.set('idle');
    }
  }

  /** Last cleanup recorded in the settings (the modal shows it before a new run). */
  async loadLastCleanup(): Promise<void> {
    try {
      const v = await window.driversize?.cleanLast();
      if (v && typeof v === 'object') this.lastCleanup.set(v as LastCleanup);
    } catch {
      /* settings unavailable */
    }
  }

  private bindCleanEvents(): void {
    for (const d of this.cleanDisposers) d();
    this.cleanDisposers = [];
    const api = window.driversize;
    if (!api) return;
    this.cleanDisposers = [
      api.onCleanStart((list) =>
        this.zone.run(() => {
          const rows = (list as { id: string; needsAdmin?: boolean; infoOnly?: boolean }[]).map((t) => ({
            id: t.id,
            needsAdmin: !!t.needsAdmin,
            infoOnly: !!t.infoOnly,
            size: 0,
            files: 0,
            state: 'pending' as const,
          }));
          this.cleanTargets.set(rows);
          this.cleanState.set('measuring');
        }),
      ),
      api.onCleanTarget((v) =>
        this.zone.run(() => {
          const t = v as CleanTarget;
          this.cleanTargets.update((list) => list.map((x) => (x.id === t.id ? { ...x, ...t } : x)));
        }),
      ),
      api.onCleanDone((v) =>
        this.zone.run(() => {
          const d = v as { deleted?: boolean; freed?: number; files?: number; errors?: number };
          this.cleanState.set('idle');
          if (d.deleted) this.cleanSummary.set({ freed: d.freed ?? 0, files: d.files ?? 0, errors: d.errors ?? 0 });
        }),
      ),
    ];
  }

  toggle(path: string): void {
    const n = this.folders.get(path);
    if (n) {
      n.expanded = !n.expanded;
      this.revision.update((v) => v + 1);
    }
  }

  has(path: string): boolean {
    return this.folders.has(path);
  }

  /** Expand all ancestors of `path` so the node is visible in the tree. */
  private expandTo(path: string): void {
    let cur = path;
    for (;;) {
      const n = this.folders.get(cur);
      if (n) n.expanded = true;
      const parent = dirName(cur);
      if (!parent || parent === cur || !this.folders.has(parent)) break;
      cur = parent;
    }
  }

  // ---- reflect fs changes (from the context menu) without a rescan ----------
  removeEntry(p: string): void {
    const parent = this.folders.get(dirName(p));
    if (parent) {
      const fi = parent.childFiles.findIndex((f) => f.path === p);
      if (fi >= 0) {
        const f = parent.childFiles[fi];
        parent.childFiles.splice(fi, 1);
        let cur: FolderNode | undefined = parent;
        while (cur) {
          cur.size -= f.size;
          cur.allocated -= f.allocated;
          cur.files -= 1;
          if (cur === this.root) break;
          cur = this.folders.get(cur.parent);
        }
      } else {
        const ci = parent.children.findIndex((c) => c.path === p);
        if (ci >= 0) {
          const c = parent.children[ci];
          parent.children.splice(ci, 1);
          let cur: FolderNode | undefined = parent;
          while (cur) {
            cur.size -= c.size;
            cur.allocated -= c.allocated;
            cur.files -= c.files;
            cur.folders -= 1 + c.folders;
            if (cur === this.root) break;
            cur = this.folders.get(cur.parent);
          }
          const walk = (n: FolderNode): void => {
            this.folders.delete(n.path);
            for (const ch of n.children) walk(ch);
          };
          walk(c);
        }
      }
    }
    this.folders.delete(p);
    this.revision.update((v) => v + 1);
  }

  private rebase(node: FolderNode, newParent: string): void {
    const sep = /[\\/]$/.test(newParent) ? '' : '\\';
    const newPath = newParent + sep + node.name;
    this.folders.delete(node.path);
    node.path = newPath;
    node.parent = newParent;
    this.folders.set(newPath, node);
    for (const f of node.childFiles) {
      f.parent = newPath;
      f.path = newPath + '\\' + f.name;
    }
    for (const c of node.children) this.rebase(c, newPath);
  }

  /** Reflect a rename done on disk. */
  renameEntry(from: string, to: string): void {
    const newName = to.slice(Math.max(to.lastIndexOf('\\'), to.lastIndexOf('/')) + 1);
    const parent = this.folders.get(dirName(from));
    if (parent) {
      const f = parent.childFiles.find((x) => x.path === from);
      if (f) {
        f.name = newName;
        f.path = to;
      } else {
        const c = parent.children.find((x) => x.path === from);
        if (c) {
          c.name = newName;
          this.rebase(c, parent.path);
        }
      }
    }
    this.revision.update((v) => v + 1);
  }

  private record(path: string): void {
    this.history = this.history.slice(0, this.historyIndex + 1);
    if (this.history[this.historyIndex] !== path) {
      this.history.push(path);
      this.historyIndex = this.history.length - 1;
    }
    this.navRev.update((v) => v + 1);
  }

  /**
   * Select a folder and immediately show its contents on the right.
   * - If the folder is part of the scanned tree -> use the aggregated data.
   * - Otherwise -> on-demand (non-recursive) listing so the contents appear at once.
   */
  async select(path: string, recordHistory = true): Promise<void> {
    this.selectedPath.set(path);
    if (recordHistory) this.record(path);
    if (this.folders.has(path)) {
      this.externalRows.set([]);
      this.expandTo(path);
    } else {
      this.externalRows.set([]);
      await this.loadListing(path);
    }
    this.revision.update((v) => v + 1);
  }

  private async loadListing(path: string): Promise<void> {
    if (!window.driversize?.listOnce) return;
    const entries = (await window.driversize.listOnce(path)) as FsEntry[];
    if (this.selectedPath() !== path) return; // user navigated away meanwhile
    const spec = this.filter();
    this.zone.run(() => {
      this.externalRows.set(
        entries
          .filter((e) => this.passes(e, spec))
          .map((e) => ({
            path: e.path,
            name: e.name,
            kind: e.isDir ? ('folder' as const) : ('file' as const),
            size: e.size,
            allocated: e.allocated,
            files: 0,
            folders: 0,
            mtime: e.mtime,
          })),
      );
      this.revision.update((v) => v + 1);
    });
  }

  back(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.navRev.update((v) => v + 1);
      void this.select(this.history[this.historyIndex], false);
    }
  }

  forward(): void {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.navRev.update((v) => v + 1);
      void this.select(this.history[this.historyIndex], false);
    }
  }

  up(): void {
    const p = this.selectedPath();
    if (!p) return;
    const parent = dirName(p);
    if (parent && parent !== p) void this.select(parent);
  }

  readonly canBack = computed<boolean>(() => {
    this.navRev();
    return this.historyIndex > 0;
  });

  readonly canForward = computed<boolean>(() => {
    this.navRev();
    return this.historyIndex < this.history.length - 1;
  });

  readonly breadcrumb = computed<{ name: string; path: string }[]>(() => {
    const p = this.selectedPath();
    if (!p) return [];
    const norm = p.replace(/\//g, '\\');
    const out: { name: string; path: string }[] = [];
    const drive = /^([a-zA-Z]:\\)(.*)$/.exec(norm);
    if (drive) {
      out.push({ name: drive[1].slice(0, 2), path: drive[1] });
      let cur = drive[1];
      for (const seg of drive[2].split('\\').filter(Boolean)) {
        cur = cur.endsWith('\\') ? cur + seg : cur + '\\' + seg;
        out.push({ name: seg, path: cur });
      }
    } else {
      let cur = '';
      for (const seg of norm.split('\\').filter(Boolean)) {
        cur = cur ? cur + '\\' + seg : seg;
        out.push({ name: seg, path: cur });
      }
    }
    return out;
  });

  // ---- derived -------------------------------------------------------------
  readonly flatTree = computed<{ node: FolderNode; depth: number }[]>(() => {
    this.revision();
    const out: { node: FolderNode; depth: number }[] = [];
    const walk = (n: FolderNode, d: number): void => {
      out.push({ node: n, depth: d });
      // Children follow the active sort (the tree is a size report too).
      if (n.expanded) for (const c of this.sortedChildren(n.children)) walk(c, d + 1);
    };
    const root = this.viewRoot();
    if (root) walk(root, 0);
    return out;
  });

  /** Copy of a node's subfolders in the active sort order (display only). */
  private sortedChildren(children: FolderNode[]): FolderNode[] {
    const k = this.sortKey();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    return children.slice().sort((a, b) => this.compareNodes(a, b, k) * dir);
  }

  readonly selectedNode = computed<FolderNode | null>(() => {
    // A scan rebuilds the tree with the same selected path, so the cached lookup
    // (folder missing -> null, e.g. after browsing a folder that was not part of
    // the previous scan) has to be redone whenever the tree changes.
    this.revision();
    const spec = this.filter();
    const p = this.selectedPath();
    if (!p) return null;
    if (!spec.enabled) return this.folders.get(p) ?? null;
    return this.viewIndex().get(p) ?? null;
  });

  private folderRow(c: FolderNode, sub?: string): Row {
    return {
      path: c.path,
      name: c.name,
      kind: 'folder',
      size: c.size,
      allocated: c.allocated,
      files: c.files,
      folders: c.folders,
      mtime: c.mtime,
      sub,
      items: c.children.length + c.childFiles.length,
    };
  }
  private fileRow(f: FsEntry, sub?: string): Row {
    return { path: f.path, name: f.name, kind: 'file', size: f.size, allocated: f.allocated, files: 0, folders: 0, mtime: f.mtime, sub };
  }

  /** Direct contents of the selected folder (optionally pruned by the modal filter). */
  private readonly listingRows = computed<Row[]>(() => {
    // Read revision directly: selectedNode() returns the same (mutated) object, so
    // Angular's referential equality would not notify this computed of tree changes.
    this.revision();
    const n = this.selectedNode();
    if (!n) return this.externalRows();
    const spec = this.filter();

    // With a filter active, show a RESULT LIST over the selected subtree,
    // honouring the "Incluir Arquivos/Pastas" gates.
    if (spec.enabled) {
      // Only items RELATIVE to the selected folder (its direct contents), no subtree
      // flattening -> no nested duplicates. Container folders are not "results".
      const out: Row[] = [];
      for (const c of n.children) if (this.passes(this.dirEntry(c), spec)) out.push(this.folderRow(c));
      for (const f of n.childFiles) if (this.passes(f, spec)) out.push(this.fileRow(f));
      return this.applySort(out);
    }

    return this.applySort([
      ...n.children.map((c) => this.folderRow(c)),
      ...n.childFiles.map((f) => this.fileRow(f)),
    ]);
  });

  /** Flattened files of the selected subtree matching the active extension filter. */
  private extFilteredRows(n: FolderNode, spec: FilterSpec, exts: ReadonlySet<string>): Row[] {
    const out: Row[] = [];
    const walk = (node: FolderNode, rel: string): void => {
      for (const f of node.childFiles) {
        if (exts.has(extOf(f.name)) && this.passes(f, spec)) out.push(this.fileRow(f, rel));
      }
      for (const c of node.children) walk(c, rel ? rel + '\\' + c.name : c.name);
    };
    walk(n, '');
    return this.applySort(out);
  }

  /** Result list before the search box narrows it down. */
  private readonly baseRows = computed<Row[]>(() => {
    this.revision();
    const exts = this.extFilter();
    if (exts.size) {
      // The extension filter spans the whole subtree -> flattened result list.
      const n = this.selectedNode();
      if (n) return this.extFilteredRows(n, this.filter(), exts);
      return this.externalRows().filter((r) => r.kind === 'file' && exts.has(extOf(r.name)));
    }
    return this.listingRows();
  });

  readonly rows = computed<Row[]>(() => {
    const list = this.baseRows();
    const q = this.search().trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => r.name.toLowerCase().includes(q) || (r.sub ?? '').toLowerCase().includes(q));
  });

  /** Total size used for the percent column and the chart center. */
  readonly selectedTotal = computed<number>(() => {
    this.revision();
    const n = this.selectedNode();
    if (n) return n.size;
    return this.listingRows().reduce((a, b) => a + b.size, 0);
  });

  /** Size of the scanned root (denominator of the "visão geral" tree). */
  readonly rootSize = computed<number>(() => {
    this.revision();
    return this.root?.size ?? 0;
  });

  /** Pie/donut slices for the currently selected folder (children by size). */
  readonly pie = computed<PieSlice[]>(() => {
    this.revision();
    return makeSlices(
      this.listingRows().map((r) => ({ label: r.name, size: r.size })),
      this.selectedTotal(),
      this.i18n.t('sliceOther'),
    );
  });

  /** Files in the selected subtree grouped by extension (for the "Tipos" panel). */
  readonly typeStats = computed<TypeStat[]>(() => {
    this.revision();
    const noExt = this.i18n.t('repNoExt');
    const n = this.selectedNode();
    if (!n) return [];
    const spec = this.filter();
    const map = new Map<string, { files: number; bytes: number }>();
    let total = 0;
    const walk = (node: FolderNode): void => {
      for (const f of node.childFiles) {
        if (!this.passes(f, spec)) continue;
        const e = extOf(f.name);
        const cur = map.get(e) ?? { files: 0, bytes: 0 };
        cur.files++;
        cur.bytes += f.size;
        map.set(e, cur);
        total += f.size;
      }
      for (const c of node.children) walk(c);
    };
    walk(n);
    return [...map.entries()]
      .map(([ext, v]) => ({ ext, files: v.files, bytes: v.bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .map((s, i) => ({
        ...s,
        label: s.ext ? '.' + s.ext : noExt,
        percent: total ? (s.bytes / total) * 100 : 0,
        color: PALETTE[i % PALETTE.length],
      }));
  });

  /** Donut for the type panel (top extensions + "Outros"). */
  readonly typePie = computed<PieSlice[]>(() => {
    const stats = this.typeStats();
    const total = stats.reduce((a, b) => a + b.bytes, 0);
    return makeSlices(
      stats.map((s) => ({ label: s.label, size: s.bytes })),
      total,
      this.i18n.t('sliceOther'),
    );
  });

  // ---- coarse categories ("distribuição por tipo de arquivo") ----------------
  /**
   * Bytes per coarse category over the selected subtree: the direct child
   * folders land in "Pastas" (their size already aggregates their contents) and
   * every file is classified by extension.
   */
  readonly categoryStats = computed<CategoryStat[]>(() => {
    this.revision();
    const spec = this.filter();
    const acc = new Map<CategoryId, { bytes: number; files: number }>();
    const add = (id: CategoryId, bytes: number, files: number): void => {
      const cur = acc.get(id) ?? { bytes: 0, files: 0 };
      cur.bytes += bytes;
      cur.files += files;
      acc.set(id, cur);
    };
    let total = 0;
    const n = this.selectedNode();
    if (n) {
      for (const c of n.children) {
        if (!this.passes(this.dirEntry(c), spec)) continue;
        add('folders', c.size, 0);
        total += c.size;
      }
      const walk = (node: FolderNode): void => {
        for (const f of node.childFiles) {
          if (!this.passes(f, spec)) continue;
          add(categoryOf(extOf(f.name)), f.size, 1);
          total += f.size;
        }
        for (const c of node.children) walk(c);
      };
      walk(n);
    } else {
      for (const r of this.externalRows()) {
        if (r.kind === 'folder') add('folders', r.size, 0);
        else add(categoryOf(extOf(r.name)), r.size, 1);
        total += r.size;
      }
    }
    return CATEGORY_IDS.filter((id) => (acc.get(id)?.bytes ?? 0) > 0).map((id) => {
      const v = acc.get(id)!;
      return {
        id,
        bytes: v.bytes,
        files: v.files,
        percent: total ? (v.bytes / total) * 100 : 0,
        color: PALETTE[CATEGORY_IDS.indexOf(id) % PALETTE.length],
      };
    });
  });

  /** Donut of the coarse categories (label carries the hinted extension list). */
  readonly categoryPie = computed<PieSlice[]>(() => {
    const stats = this.categoryStats();
    const total = stats.reduce((a, b) => a + b.bytes, 0);
    return makeSlices(
      stats.map((s) => ({ label: this.categoryLabel(s.id), size: s.bytes })),
      total,
      this.i18n.t('catOther'),
    );
  });

  /** "Aplicações (.exe)" — the legend label of a category. */
  categoryLabel(id: CategoryId): string {
    const hint = this.categoryHint(id);
    return hint ? `${this.categoryName(id)} ${hint}` : this.categoryName(id);
  }

  /**
   * Largest files of the whole analysed root (dialog "Maiores da unidade").
   * Walks every node but keeps only a bounded top list, so a million-entry scan
   * does not have to be sorted just to show 500 rows.
   */
  readonly globalLargestFiles = computed<LargestFile[]>(() => {
    this.revision();
    const root = this.root;
    if (!root) return [];
    const spec = this.filter();
    const top: FsEntry[] = [];
    const limit = GLOBAL_LARGEST_LIMIT;
    const consider = (f: FsEntry): void => {
      if (top.length < limit) {
        top.push(f);
        if (top.length === limit) top.sort((a, b) => a.size - b.size);
        return;
      }
      if (f.size <= top[0].size) return;
      // Replace the smallest kept entry, then restore the ascending order.
      top[0] = f;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < limit && top[l].size < top[m].size) m = l;
        if (r < limit && top[r].size < top[m].size) m = r;
        if (m === i) break;
        [top[i], top[m]] = [top[m], top[i]];
        i = m;
      }
    };
    const walk = (node: FolderNode): void => {
      for (const f of node.childFiles) if (this.passes(f, spec)) consider(f);
      for (const c of node.children) walk(c);
    };
    walk(root);
    const total = root.size || 0;
    return top
      .sort((a, b) => b.size - a.size)
      .map((f) => {
        const ext = extOf(f.name);
        return {
          path: f.path,
          name: f.name,
          size: f.size,
          percent: total ? (f.size / total) * 100 : 0,
          ext,
          category: categoryOf(ext),
          dir: dirName(f.path),
        };
      });
  });

  /** Largest files of the selected subtree (right panel + "Ver todos"). */
  readonly largestFiles = computed<LargestFile[]>(() => {
    this.revision();
    const spec = this.filter();
    const found: FsEntry[] = [];
    const walk = (node: FolderNode): void => {
      for (const f of node.childFiles) if (this.passes(f, spec)) found.push(f);
      for (const c of node.children) walk(c);
    };
    const n = this.selectedNode();
    if (n) {
      walk(n);
    } else {
      for (const r of this.externalRows()) {
        if (r.kind === 'file') {
          found.push({ path: r.path, parent: dirName(r.path), name: r.name, isDir: false, size: r.size, allocated: r.allocated, mtime: r.mtime, atime: r.mtime, ctime: r.mtime, attrs: 0 });
        }
      }
    }
    const total = this.selectedTotal();
    return found
      .sort((a, b) => b.size - a.size)
      .slice(0, LARGEST_LIMIT)
      .map((f) => {
        const ext = extOf(f.name);
        return {
          path: f.path,
          name: f.name,
          size: f.size,
          percent: total ? (f.size / total) * 100 : 0,
          ext,
          category: categoryOf(ext),
          dir: dirName(f.path),
        };
      });
  });

  // ---- file-type panel (extension filter) ----------------------------------
  toggleExt(ext: string): void {
    this.extFilter.update((cur) => {
      const next = new Set(cur);
      if (next.has(ext)) next.delete(ext);
      else next.add(ext);
      return next;
    });
  }

  clearExtFilter(): void {
    this.extFilter.set(new Set<string>());
  }

  /** Bytes matched by the active extension filter (shown in the chips bar). */
  readonly extMatchedBytes = computed<number>(() => {
    const exts = this.extFilter();
    if (!exts.size) return 0;
    return this.typeStats()
      .filter((s) => exts.has(s.ext))
      .reduce((a, b) => a + b.bytes, 0);
  });

  // ---- real-time monitoring -------------------------------------------------
  async setMonitorEnabled(enabled: boolean): Promise<void> {
    this.monitorEnabled.set(enabled);
    if (!enabled) this.clearPending();
    await window.driversize?.setMonitorEnabled?.(enabled);
  }

  /** A debounced change notification from the main-process watcher. */
  noteChanged(count: number, paths: string[]): void {
    if (!this.monitorEnabled() || this.scanning()) return;
    this.pendingChanges.update((c) => c + count);
    this.pendingPaths.set(paths.slice(0, 50));
  }

  clearPending(): void {
    this.pendingChanges.set(0);
    this.pendingPaths.set([]);
  }

  /** Toggle "minimize to tray" (persisted; the main process applies it live). */
  async setMinimizeToTray(enabled: boolean): Promise<void> {
    this.minimizeToTray.set(enabled);
    if (!window.driversize?.setTrayEnabled) return;
    await window.driversize.setTrayEnabled(enabled);
  }

  // ---- helpers -------------------------------------------------------------
  formatBytes(bytes: number): string {
    const u = this.sizeUnit();
    /** Locale-aware fixed-precision number (1,50 in pt/fr/es vs 1.50 in en). */
    const num = (v: number, digits: number): string =>
      digits === 0 ? this.i18n.int(Math.round(v)) : this.i18n.num(v, digits);
    if (u === 'B') return `${this.i18n.int(bytes)} B`;
    const units = [
      { k: 'B', v: 1 },
      { k: 'KB', v: 1024 },
      { k: 'MB', v: 1024 ** 2 },
      { k: 'GB', v: 1024 ** 3 },
      { k: 'TB', v: 1024 ** 4 },
    ];
    if (u === 'auto') {
      let i = 0;
      let val = bytes;
      while (val >= 1024 && i < units.length - 1) {
        val /= 1024;
        i++;
      }
      return `${num(val, i === 0 ? 0 : 2)} ${units[i].k}`;
    }
    const f = units.find((x) => x.k === u)!;
    return `${num(bytes / f.v, 2)} ${u}`;
  }

  percent(size: number, parent: number): string {
    if (!parent) return '';
    return this.i18n.num((size / parent) * 100, 1) + '%';
  }

  async exportCsv(): Promise<void> {
    if (window.driversize && this.root) {
      const flat = this.flatTree().map((x) => ({ ...x.node, isDir: true, parent: x.node.parent } as unknown as FsEntry));
      await window.driversize.exportCsv(this.root.path, [...flat, ...collectFiles(this.root)]);
    }
  }

  async exportXml(): Promise<void> {
    if (window.driversize && this.root) {
      const flat = this.flatTree().map((x) => ({ ...x.node, isDir: true, parent: x.node.parent } as unknown as FsEntry));
      await window.driversize.exportXml(this.root.path, [...flat, ...collectFiles(this.root)]);
    }
  }

  async exportHtml(): Promise<void> {
    if (!window.driversize || !this.root) return;
    await window.driversize.exportHtml(this.root.path, this.buildReportHtml());
  }

  /** Self-contained HTML report: totals, top entries, file types (with donut) and the tree. */
  private buildReportHtml(): string {
    const root = this.root!;
    const i18n = this.i18n;
    const tr = (k: I18nKey): string => i18n.t(k);
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmt = (n: number): string => this.formatBytes(n);
    const total = root.size || 1;

    // top-level entries, largest first
    const kids = [
      ...root.children.map((c) => ({ label: c.name, size: c.size, files: c.files, folders: c.folders, dir: true })),
      ...root.childFiles.map((f) => ({ label: f.name, size: f.size, files: 0, folders: 0, dir: false })),
    ].sort((a, b) => b.size - a.size);

    // file types over the whole scan
    const types = new Map<string, { files: number; bytes: number }>();
    for (const f of collectFiles(root)) {
      const e = extOf(f.name);
      const cur = types.get(e) ?? { files: 0, bytes: 0 };
      cur.files++;
      cur.bytes += f.size;
      types.set(e, cur);
    }
    const typeRows = [...types.entries()].map(([ext, v]) => ({ ext, ...v })).sort((a, b) => b.bytes - a.bytes);
    const typeTotal = typeRows.reduce((a, b) => a + b.bytes, 0) || 1;

    // donut of the top-level entries
    const slices = makeSlices(kids.map((k) => ({ label: k.label, size: k.size })), root.size, tr('sliceOther'), 12);
    const donut = slices
      .map(
        (s) =>
          `<path d="${s.d}" fill="${s.color}" stroke="#fff" stroke-width="1"><title>${esc(s.label)} — ${fmt(s.size)} (${i18n.num(s.percent, 1)}%)</title></path>`,
      )
      .join('');

    // nested tree, capped so a huge scan doesn't produce an enormous file
    const CAP = 50000;
    let rendered = 0;
    const treeHtml = (n: FolderNode, depth: number): string => {
      if (rendered >= CAP) return '';
      rendered++;
      let out = `<div class="trow dir" style="padding-left:${depth * 16}px"><span class="ic">📁</span><span class="tn">${esc(n.name)}</span><span class="ts">${fmt(n.size)}</span><span class="tc">${i18n.tf('repRowCounts', { files: i18n.int(n.files), folders: i18n.int(n.folders) })}</span></div>`;
      for (const c of n.children.slice().sort((a, b) => b.size - a.size)) {
        if (rendered >= CAP) break;
        out += treeHtml(c, depth + 1);
      }
      for (const f of n.childFiles.slice().sort((a, b) => b.size - a.size)) {
        if (rendered >= CAP) break;
        rendered++;
        out += `<div class="trow file" style="padding-left:${(depth + 1) * 16}px"><span class="ic">📄</span><span class="tn">${esc(f.name)}</span><span class="ts">${fmt(f.size)}</span><span class="tc"></span></div>`;
      }
      return out;
    };
    const tree = treeHtml(root, 0);

    const kidRows = kids
      .slice(0, 500)
      .map(
        (k) =>
          `<tr><td>${k.dir ? '📁' : '📄'} ${esc(k.label)}</td><td class="n">${fmt(k.size)}</td><td class="n">${i18n.num((k.size / total) * 100, 1)}%</td><td class="n">${k.dir ? i18n.int(k.files) : ''}</td><td class="n">${k.dir ? i18n.int(k.folders) : ''}</td></tr>`,
      )
      .join('');

    const typeTable = typeRows
      .map(
        (t, i) =>
          `<tr><td><span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span> ${esc(t.ext ? '.' + t.ext : tr('repNoExt'))}</td><td class="n">${i18n.int(t.files)}</td><td class="n">${fmt(t.bytes)}</td><td class="n">${i18n.num((t.bytes / typeTotal) * 100, 1)}%</td></tr>`,
      )
      .join('');

    const tot = this.totals();
    const truncNote =
      rendered >= CAP ? `<div class="trow"><span class="tc">${esc(i18n.tf('repTruncated', { n: i18n.int(CAP) }))}</span></div>` : '';

    return `<!doctype html>
<html lang="${i18n.locale()}">
<head>
<meta charset="utf-8">
<title>${APP_NAME} — ${esc(root.path)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 "Segoe UI", Tahoma, sans-serif; color: #1f2933; margin: 0; background: #f5f7fa; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #627d98; margin-bottom: 18px; word-break: break-all; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 22px; }
  .card { background: #fff; border: 1px solid #d9e2ec; border-radius: 8px; padding: 12px 16px; min-width: 150px; }
  .card .k { color: #627d98; font-size: 12px; }
  .card .v { font-size: 20px; font-weight: 600; }
  h2 { font-size: 16px; margin: 26px 0 10px; border-bottom: 1px solid #d9e2ec; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9e2ec; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eef2f6; }
  th { background: #eef2f6; font-weight: 600; color: #486581; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
  .cols { display: flex; gap: 22px; flex-wrap: wrap; align-items: flex-start; }
  .grow { flex: 1 1 380px; min-width: 320px; }
  .donut { width: 260px; height: 260px; flex: 0 0 auto; }
  .tree { background: #fff; border: 1px solid #d9e2ec; border-radius: 8px; padding: 8px 0; font-size: 12.5px; max-height: 720px; overflow: auto; }
  .trow { display: flex; gap: 8px; padding: 1px 10px; white-space: nowrap; }
  .trow:hover { background: #f0f4f8; }
  .trow .ic { width: 16px; }
  .trow .tn { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .trow.dir .tn { font-weight: 600; }
  .trow .ts { text-align: right; color: #334e68; font-variant-numeric: tabular-nums; }
  .trow .tc { color: #9fb3c8; font-size: 11.5px; min-width: 150px; text-align: right; }
  footer { margin-top: 26px; color: #9fb3c8; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(tr('repTitle'))}</h1>
  <div class="sub">${esc(root.path)}</div>
  <div class="cards">
    <div class="card"><div class="k">${esc(tr('repTotal'))}</div><div class="v">${fmt(root.size)}</div></div>
    <div class="card"><div class="k">${esc(tr('repFiles'))}</div><div class="v">${i18n.int(tot.files)}</div></div>
    <div class="card"><div class="k">${esc(tr('repFolders'))}</div><div class="v">${i18n.int(tot.folders)}</div></div>
    <div class="card"><div class="k">${esc(tr('repAllocated'))}</div><div class="v">${fmt(root.allocated)}</div></div>
    <div class="card"><div class="k">${esc(tr('repElapsed'))}</div><div class="v">${this.elapsedMs() ? i18n.num(this.elapsedMs() / 1000, 1) + ' s' : '—'}</div></div>
  </div>

  <h2>${esc(tr('repTop'))}</h2>
  <div class="cols">
    <div class="grow">
      <table><thead><tr><th>${esc(tr('colName'))}</th><th class="n">${esc(tr('colSize'))}</th><th class="n">%</th><th class="n">${esc(tr('repFiles'))}</th><th class="n">${esc(tr('repFolders'))}</th></tr></thead>
      <tbody>${kidRows}</tbody></table>
    </div>
    <svg class="donut" viewBox="0 0 240 240" role="img" aria-label="${esc(tr('repTop'))}">
      ${donut}
      <circle cx="120" cy="120" r="54" fill="#fff"/>
      <text x="120" y="114" text-anchor="middle" font-size="15" font-weight="600" fill="#1f2933">${fmt(root.size)}</text>
      <text x="120" y="134" text-anchor="middle" font-size="11" fill="#829ab1">${esc(i18n.tf('chartItems', { n: i18n.int(kids.length) }))}</text>
    </svg>
  </div>

  <h2>${esc(tr('repTypes'))}</h2>
  <div class="grow">
    <table><thead><tr><th>${esc(tr('repExt'))}</th><th class="n">${esc(tr('repFiles'))}</th><th class="n">${esc(tr('colSize'))}</th><th class="n">%</th></tr></thead>
    <tbody>${typeTable}</tbody></table>
  </div>

  <h2>${esc(tr('repTree'))}</h2>
  <div class="tree">${tree}${truncNote}</div>

  <footer>${esc(i18n.tf('repGenerated', { date: i18n.dateLong(new Date()) }))}</footer>
</div>
</body>
</html>`;
  }

  // ---- File menu: New / Load / Save ----------------------------------------
  /** Flat entry list (every folder + every file) that reproduces the current tree. */
  private scanEntries(): FsEntry[] {
    if (!this.root) return [];
    const out: FsEntry[] = [];
    for (const n of this.folders.values()) out.push(this.dirEntry(n));
    out.push(...collectFiles(this.root));
    return out;
  }

  /** File ▸ New... — clear the results and start over. */
  newScan(): void {
    this.folders.clear();
    this.root = null;
    this.rootPath.set(null);
    this.selectedPath.set(null);
    this.history = [];
    this.historyIndex = -1;
    this.navRev.update((v) => v + 1);
    this.externalRows.set([]);
    this.totals.set({ files: 0, folders: 0, bytes: 0 });
    this.elapsedMs.set(0);
    this.error.set(null);
    this.clearPending();
    this.clearExtFilter();
    this.revision.update((v) => v + 1);
  }

  /** File ▸ Save... — write the current tree to a .fsjson file (via the main process). */
  async saveSession(): Promise<void> {
    if (!window.driversize || !this.root) return;
    await window.driversize.saveSession(this.root.path, this.scanEntries());
  }

  /** File ▸ Load... — replay a saved scan without touching the disk. */
  async openSession(): Promise<void> {
    const r = await window.driversize?.loadSession();
    if (!r) return;
    if (!r.ok || typeof r.root !== 'string' || !Array.isArray(r.entries)) {
      this.error.set(r.error ?? this.i18n.t('errLoadFailed'));
      return;
    }
    this.loadEntries(r.root, r.entries as FsEntry[]);
  }

  /** Rebuild the tree from a flat entry list (same shape the scanner streams). */
  private loadEntries(root: string, entries: FsEntry[]): void {
    this.folders.clear();
    this.root = this.ensureFolder(root);
    this.root.expanded = true;
    this.rootPath.set(root);
    this.selectedPath.set(root);
    this.history = [root];
    this.historyIndex = 0;
    this.navRev.update((v) => v + 1);
    this.externalRows.set([]);
    this.error.set(null);
    this.scanning.set(false);
    this.elapsedMs.set(0);
    this.clearPending();
    this.clearExtFilter();
    this.onBatch(entries);
    this.totals.set({ files: this.root.files, folders: this.root.folders, bytes: this.root.size });
    this.revision.update((v) => v + 1);
  }

  // ---- File menu: exports ---------------------------------------------------
  /** File ▸ Export As... — whole scan; CSV or XML depending on the chosen extension. */
  async exportAs(): Promise<void> {
    if (!window.driversize || !this.root) return;
    await window.driversize.exportAny(this.root.path, this.scanEntries());
  }

  /** File ▸ Export Details View... — just what the details list is showing. */
  async exportDetailsView(): Promise<void> {
    if (!window.driversize || !this.root) return;
    const rows = this.rows().map(
      (r): FsEntry => ({
        path: r.path,
        parent: dirName(r.path),
        name: r.name,
        isDir: r.kind === 'folder',
        size: r.size,
        allocated: r.allocated,
        mtime: r.mtime,
        atime: r.mtime,
        ctime: r.mtime,
        attrs: r.kind === 'folder' ? 0x10 : 0,
      }),
    );
    await window.driversize.exportAny(this.selectedPath() || this.root.path, rows);
  }

  /** File ▸ Export Chart Image... — the on-screen donut, rendered to a PNG. */
  async exportChartImage(): Promise<void> {
    if (!window.driversize) return;
    const dataUrl = await this.chartDataUrl();
    if (!dataUrl) {
      this.error.set(this.i18n.t('errNothingToExport'));
      return;
    }
    const name = (this.selectedNode()?.name || baseName(this.root?.path ?? '') || 'driversize') + '-chart.png';
    await window.driversize.exportPng(name, dataUrl);
  }

  /** Rasterize the donut SVG that the right panel is currently showing. */
  private async chartDataUrl(): Promise<string | null> {
    const svg = document.querySelector('svg.pie') as SVGSVGElement | null;
    if (!svg || !svg.querySelector('path')) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', '480');
    clone.setAttribute('height', '480');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent =
      '.pie-total{font:600 15px "Segoe UI",Tahoma,sans-serif;fill:#1f2933}.pie-sub{font:11px "Segoe UI",Tahoma,sans-serif;fill:#829ab1}';
    clone.insertBefore(style, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    const img = new Image();
    try {
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('svg'));
        img.src = url;
      });
    } catch {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 480, 480);
    ctx.drawImage(img, 0, 0, 480, 480);
    return canvas.toDataURL('image/png');
  }

  // ---- File menu: printing ---------------------------------------------------
  private printCss(): string {
    return `
  body { font: 12px/1.45 "Segoe UI", Tahoma, sans-serif; color: #1f2933; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .sub { color: #627d98; font-size: 11.5px; margin-bottom: 12px; word-break: break-all; }
  .trow { display: flex; gap: 8px; padding: 1px 0; white-space: nowrap; }
  .trow .tn { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .trow.dir .tn { font-weight: 600; }
  .trow .ts { text-align: right; font-variant-numeric: tabular-nums; }
  .trow .tc { min-width: 120px; text-align: right; color: #829ab1; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #e0e6ed; font-size: 11.5px; }
  th { background: #eef2f6; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  @page { margin: 12mm; }`;
  }

  private printShell(title: string, subtitle: string, body: string): string {
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<!doctype html>
<html lang="${this.i18n.locale()}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${this.printCss()}</style></head>
<body><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div>${body}</body></html>`;
  }

  /** File ▸ Print Folder Tree... */
  async printTree(): Promise<void> {
    const root = this.root;
    if (!window.driversize || !root) return;
    const i18n = this.i18n;
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows: string[] = [];
    const walk = (n: FolderNode, depth: number): void => {
      rows.push(
        `<div class="trow dir" style="padding-left:${depth * 14}px"><span class="tn">${esc(n.name)}</span><span class="ts">${this.formatBytes(n.size)}</span><span class="tc">${i18n.tf('repRowCounts', { files: i18n.int(n.files), folders: i18n.int(n.folders) })}</span></div>`,
      );
      for (const c of n.children.slice().sort((a, b) => b.size - a.size)) walk(c, depth + 1);
      for (const f of n.childFiles.slice().sort((a, b) => b.size - a.size)) {
        rows.push(
          `<div class="trow" style="padding-left:${(depth + 1) * 14}px"><span class="tn">${esc(f.name)}</span><span class="ts">${this.formatBytes(f.size)}</span><span class="tc"></span></div>`,
        );
      }
    };
    walk(root, 0);
    const counts = i18n.tf('subCounts', { files: i18n.int(this.totals().files), folders: i18n.int(this.totals().folders) });
    const sub = `${root.path} — ${this.formatBytes(root.size)} · ${counts}`;
    await window.driversize.printHtml(this.printShell(i18n.t('printTreeTitle'), sub, rows.join('')));
  }

  /** File ▸ Print Details View... */
  async printDetails(): Promise<void> {
    if (!window.driversize || !this.root) return;
    const i18n = this.i18n;
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const total = this.selectedTotal();
    const rows = this.rows()
      .slice(0, 5000)
      .map(
        (r) =>
          `<tr><td>${esc(r.name)}${r.sub ? ' — ' + esc(r.sub) : ''}</td><td class="n">${this.formatBytes(r.size)}</td><td class="n">${r.allocated ? this.formatBytes(r.allocated) : ''}</td><td class="n">${this.percent(r.size, total)}</td><td class="n">${r.kind === 'folder' ? i18n.int(r.files) : ''}</td><td class="n">${r.kind === 'folder' ? i18n.int(r.folders) : ''}</td><td class="n">${r.mtime ? i18n.dateLong(r.mtime) : ''}</td></tr>`,
      )
      .join('');
    const head = ['colName', 'colSize', 'colAllocated', 'colPercent', 'colFiles', 'colFolders', 'colModified']
      .map((k) => `<th${k === 'colName' ? '' : ' class="n"'}>${esc(i18n.t(k as I18nKey))}</th>`)
      .join('');
    const body = `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    const sub = `${this.selectedPath() || this.root.path} — ${this.formatBytes(total)}`;
    await window.driversize.printHtml(this.printShell(i18n.t('printDetailsTitle'), sub, body));
  }
}

function collectFiles(n: FolderNode): FsEntry[] {
  const out: FsEntry[] = [];
  const walk = (folder: FolderNode): void => {
    out.push(...folder.childFiles);
    for (const c of folder.children) walk(c);
  };
  walk(n);
  return out;
}
