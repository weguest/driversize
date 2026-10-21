import { ChangeDetectionStrategy, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScanService } from './scan.service';
import { CategoryId, CleanTarget, DEFAULT_FILTER, DriveInfo, DupeGroup, FilterSpec, FindHit, FolderNode, Row, SizeUnit, SortKey, SortOption, ViewMode, categoryOf } from './models';
import { I18n } from './i18n.service';
import { APP_NAME, I18nKey, LANGS, Lang } from './i18n';

function normalizeRoot(p: string): string {
  const t = p.trim();
  if (/^[a-zA-Z]:$/.test(t)) return t + '\\';
  return t;
}

/** One node of the ⋮ menu (built by the main process, rendered here). */
interface MenuNode {
  label?: string;
  type?: 'separator';
  checked?: boolean;
  enabled?: boolean;
  cmd?: string;
  arg?: unknown;
  submenu?: MenuNode[];
}

/** Optional icon of each row, by coarse category. */
const GLYPH: Record<CategoryId, string> = {
  folders: '📁',
  apps: '🚀',
  system: '⚙️',
  archives: '🗜️',
  models3d: '🧊',
  images: '🖼️',
  videos: '🎬',
  audio: '🎵',
  documents: '📄',
  code: '📜',
  other: '📄',
};

/** Icon of the shell folders offered by the sidebar. */
const KNOWN_GLYPH: Record<string, string> = {
  downloads: '⬇️',
  documents: '📄',
  desktop: '🖥️',
  videos: '🎬',
  pictures: '🖼️',
  music: '🎵',
};

/** i18n key of a shell folder id returned by the main process. */
const KNOWN_KEY: Record<string, I18nKey> = {
  downloads: 'knownDownloads',
  documents: 'knownDocuments',
  desktop: 'knownDesktop',
  videos: 'knownVideos',
  pictures: 'knownPictures',
  music: 'knownMusic',
};

/** Rows of the "limpeza segura" dialog, in display order (ids come from the main process). */
const CLEAN_META: { id: string; label: I18nKey; desc: I18nKey }[] = [
  { id: 'userTemp', label: 'cleanUserTemp', desc: 'cleanUserTempDesc' },
  { id: 'winTemp', label: 'cleanWinTemp', desc: 'cleanWinTempDesc' },
  { id: 'updateCache', label: 'cleanUpdateCache', desc: 'cleanUpdateCacheDesc' },
  { id: 'recycle', label: 'cleanRecycle', desc: 'cleanRecycleDesc' },
  { id: 'downloadsOld', label: 'cleanDownloads', desc: 'cleanDownloadsDesc' },
  { id: 'browserCache', label: 'cleanBrowsers', desc: 'cleanBrowsersDesc' },
  { id: 'thumbnails', label: 'cleanThumbs', desc: 'cleanThumbsDesc' },
  { id: 'hibernation', label: 'cleanHiberfil', desc: 'cleanHiberfilDesc' },
];

/** Items checked by default: the safe ones, never the admin-only or info-only rows. */
const CLEAN_PRESELECT = ['userTemp', 'recycle', 'downloadsOld', 'browserCache', 'thumbnails'];

/** i18n key of each sort preset. */
const SORT_KEY: Record<SortOption, I18nKey> = {
  'name-asc': 'sortNameAsc',
  'name-desc': 'sortNameDesc',
  'size-desc': 'sortSizeDesc',
  'size-asc': 'sortSizeAsc',
  'modified-desc': 'sortModifiedDesc',
  'modified-asc': 'sortModifiedAsc',
  'items-desc': 'sortItemsDesc',
};

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit, OnDestroy {
  readonly scan = inject(ScanService);
  readonly i18n = inject(I18n);
  private readonly zone = inject(NgZone);
  private readonly disposers: (() => void)[] = [];
  /** Translation shortcut for the template (`t('scan')`). */
  readonly t = (k: I18nKey): string => this.i18n.t(k);
  /** Translation with placeholders (`tf('hdrFiles', {n: 3})`). */
  readonly tf = (k: I18nKey, p: Record<string, string | number>): string => this.i18n.tf(k, p);
  readonly langs = LANGS;
  readonly renameTarget = signal<{ path: string; name: string } | null>(null);
  readonly renameName = signal('');
  readonly selectedPaths = signal<Set<string>>(new Set());
  private anchor = -1;
  readonly pathInput = signal('C:\\');
  /** Path box: the breadcrumb track is shown until the field is focused for typing. */
  readonly pathEditing = signal(false);
  private readonly pbInput = viewChild<ElementRef<HTMLInputElement>>('pbInput');
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly findInput = viewChild<ElementRef<HTMLInputElement>>('findInput');
  /** Status-bar label with the folder being scanned (written directly on events). */
  private readonly sbDirText = viewChild<ElementRef<HTMLElement>>('sbDirText');
  readonly units: SizeUnit[] = ['B', 'KB', 'MB', 'GB', 'auto'];
  readonly showFilter = signal(false);
  /** main content: the result list ("items") or the file-type table */
  readonly contentTab = signal<'items' | 'types'>('items');
  readonly rightTab = signal<'chart' | 'types' | 'exts'>('chart');
  /** ⋮ dropdown (its items are built by the main process) */
  readonly showMenu = signal(false);
  readonly menuTree = signal<MenuNode[]>([]);
  readonly openSub = signal<string | null>(null);
  /** path box history dropdown */
  readonly showRecent = signal(false);
  /** "maiores arquivos" dialog */
  readonly showLargest = signal(false);
  /** "maiores arquivos da unidade" (whole analysed root) */
  readonly showLargestDrive = signal(false);
  readonly sortOptions: SortOption[] = ['name-asc', 'name-desc', 'size-desc', 'size-asc', 'modified-desc', 'modified-asc', 'items-desc'];
  /** Biggest visible row: the inline size bars are relative to it. */
  readonly maxRowSize = computed<number>(() => {
    let max = 0;
    for (const r of this.scan.rows()) if (r.size > max) max = r.size;
    return max || 1;
  });
  /** Volume that hosts the current folder (status bar usage). */
  readonly currentDrive = computed<DriveInfo | null>(() => {
    const p = this.scan.selectedPath() ?? this.scan.rootPath() ?? '';
    const m = /^([a-zA-Z]):/.exec(p);
    const letter = m ? m[1].toUpperCase() : '';
    const drives = this.scan.drives();
    if (!letter) return drives[0] ?? null;
    return drives.find((d) => d.root.toUpperCase().startsWith(letter)) ?? null;
  });
  readonly draft = signal<FilterSpec>({ ...DEFAULT_FILTER });
  /** Options… dialog (a draft is edited locally and applied on OK) */
  readonly showOptions = signal(false);
  /** "Duplicados" dialog */
  readonly showDupes = signal(false);
  /** Checked copies in the duplicate dialog (the keeper of each group is never checked). */
  readonly dupeSelected = signal<ReadonlySet<string>>(new Set<string>());
  /** Bytes held by the checked copies. */
  readonly dupeSelectedBytes = computed<number>(() => {
    const sel = this.dupeSelected();
    let total = 0;
    for (const g of this.scan.dupes()) for (const p of g.paths) if (sel.has(p)) total += g.size;
    return total;
  });
  /** Minimum-size choices of the duplicate finder. */
  readonly dupeMinOptions = [
    { v: 100 * 1024, label: '100 KB' },
    { v: 1024 * 1024, label: '1 MB' },
    { v: 10 * 1024 * 1024, label: '10 MB' },
    { v: 100 * 1024 * 1024, label: '100 MB' },
  ];
  /** Tracks the previous duplicate state so defaults are applied once per run. */
  private lastDupeState = 'idle';

  // ---- safe cleanup ---------------------------------------------------------
  readonly showCleanup = signal(false);
  readonly cleanSelectedIds = signal<ReadonlySet<string>>(new Set<string>());
  /** Two-step confirmation: the first click only arms the action. */
  readonly cleanConfirm = signal(false);
  readonly cleanSelectedBytes = computed<number>(() => {
    const sel = this.cleanSelectedIds();
    let total = 0;
    for (const t of this.scan.cleanTargets()) if (sel.has(t.id) && !t.infoOnly) total += t.size;
    return total;
  });
  /** The measured targets, in display order, with their translated labels. */
  readonly cleanRows = computed<{ target: CleanTarget; label: string; desc: string }[]>(() => {
    const byId = new Map(this.scan.cleanTargets().map((t) => [t.id, t]));
    const rows: { target: CleanTarget; label: string; desc: string }[] = [];
    for (const m of CLEAN_META) {
      const t = byId.get(m.id);
      if (!t) continue;
      rows.push({ target: t, label: this.i18n.t(m.label), desc: this.i18n.t(m.desc) });
    }
    return rows;
  });
  readonly showHelp = signal(false);
  readonly showAbout = signal(false);
  /** "Inspect element": the next click sends its coordinates to DevTools. */
  readonly inspectMode = signal(false);
  // ---- global search (modal) ------------------------------------------------
  readonly showFind = signal(false);
  readonly findQuery = signal('');
  readonly findHits = signal<FindHit[]>([]);
  readonly findSel = signal(0);
  private findTimer: ReturnType<typeof setTimeout> | null = null;
  readonly optDraft = signal<{
    unit: SizeUnit;
    chart: boolean;
    driveInfo: boolean;
    splash: boolean;
    monitor: boolean;
    tray: boolean;
    lang: Lang;
    theme: 'light' | 'dark' | 'system';
    density: 'normal' | 'compact';
    showDisk: boolean;
    exclude: string;
  }>({
    unit: 'auto',
    chart: true,
    driveInfo: true,
    splash: true,
    monitor: true,
    tray: false,
    lang: 'en',
    theme: 'system',
    density: 'normal',
    showDisk: true,
    exclude: '',
  });
  readonly optUnits: SizeUnit[] = ['B', 'KB', 'MB', 'GB', 'auto'];
  readonly appName = APP_NAME;
  readonly appVersion = window.driversize?.appVersion ?? '';
  readonly engineVersions = window.driversize?.versions ?? { electron: '', chrome: '', node: '' };
  readonly shortcuts = computed<{ keys: string; what: string }[]>(() => [
    { keys: 'Ctrl+A', what: this.i18n.t('scGetAll') },
    { keys: 'F2', what: this.i18n.t('scRename') },
    { keys: 'Delete', what: this.i18n.t('scDelete') },
    { keys: 'Enter', what: this.i18n.t('scOpen') },
    { keys: '↑ ↓', what: this.i18n.t('scNav') },
    { keys: 'Home / End', what: this.i18n.t('scHomeEnd') },
    { keys: 'Alt+← / Alt+→', what: this.i18n.t('scHistory') },
    { keys: 'Alt+↑', what: this.i18n.t('scUp') },
    { keys: 'F5', what: this.i18n.t('scRescan') },
    { keys: 'Esc', what: this.i18n.t('scEsc') },
  ]);
  readonly attrBits = computed<{ bit: number; label: string }[]>(() => [
    { bit: 0x01, label: this.i18n.t('attrReadOnly') },
    { bit: 0x02, label: this.i18n.t('attrHidden') },
    { bit: 0x04, label: this.i18n.t('attrSystem') },
    { bit: 0x10, label: this.i18n.t('attrFolder') },
    { bit: 0x20, label: this.i18n.t('attrArchive') },
  ]);

  constructor() {
    // Keep the native menu marks ("Stop Scan", View ▸ Size / Drive Info / Chart) in sync
    // with the app state: the renderer owns the state, the menu only mirrors it.
    // `lang` also rides along so the main process can relabel the native menu.
    effect(() => {
      const state = {
        scanning: this.scan.scanning(),
        unit: this.scan.sizeUnit(),
        driveInfo: this.scan.showDriveInfo(),
        chart: this.scan.showChart(),
      };
      // `lang` only after the persisted choice is known, so the menu the main
      // process built at startup is not rebuilt (en -> stored language) on boot.
      const lang = this.i18n.lang();
      window.driversize?.setMenuState(this.i18n.loaded() ? { ...state, lang } : state);
    });
    // The ⋮ menu labels live in the main process: refetch them on every language
    // change (and once, as soon as the persisted choice is known).
    effect(() => {
      this.i18n.lang();
      if (!this.i18n.loaded()) return;
      void this.loadMenuTree();
    });
    // The path field mirrors the folder on screen, so "Escanear" scans what the
    // breadcrumb shows after navigating with the breadcrumb or ← → ↑ (and not the
    // previously typed/scanned root). `pathEditing` is read untracked: while the
    // field is being typed the effect must not fire and overwrite the text.
    effect(() => {
      const p = this.scan.selectedPath() ?? this.scan.rootPath() ?? '';
      if (!p) return;
      if (untracked(this.pathEditing)) return;
      this.pathInput.set(p);
    });
    // Duplicate search finished: pre-check every copy except the keeper (the first
    // path of each group), so one click sends the extras to the Recycle Bin.
    effect(() => {
      const state = this.scan.dupeState();
      const finished = state === 'done';
      if (finished && this.lastDupeState !== 'done') {
        const groups = this.scan.dupes();
        untracked(() => {
          const sel = new Set<string>();
          for (const g of groups) for (const p of g.paths.slice(1)) sel.add(p);
          this.dupeSelected.set(sel);
        });
      }
      this.lastDupeState = state;
    });
  }

  async loadMenuTree(): Promise<void> {
    // The definition lives in the main process (it is the same data the native menu
    // used to be built from). If the bridge is missing the ⋮ menu simply stays empty.
    try {
      const tree = (await window.driversize?.menuTree()) as MenuNode[] | undefined;
      if (Array.isArray(tree)) this.menuTree.set(tree);
    } catch {
      this.menuTree.set([]);
    }
  }

  ngOnInit(): void {
    void this.i18n.load();
    void this.scan.loadSettings();
    void this.scan.loadDrives();
    void this.scan.loadKnownFolders();
    const auto = window.driversize?.autoscan;
    if (auto) {
      this.pathInput.set(auto);
      void this.scan.startScan(auto);
    } else {
      // Normal launch: land on the logged-in user's Documents folder.
      void this.startInDocuments();
    }
    const fs = window.driversize;
    if (fs) {
      this.disposers.push(fs.onAskRename((v) => this.zone.run(() => { this.renameTarget.set(v); this.renameName.set(v.name); })));
      this.disposers.push(fs.onDeleted((p) => this.zone.run(() => this.scan.removeEntry(p))));
      this.disposers.push(fs.onRenamed((v) => this.zone.run(() => this.scan.renameEntry(v.from, v.to))));
      this.disposers.push(fs.onChanged((v) => this.zone.run(() => this.scan.noteChanged(v.count, v.paths))));
      this.disposers.push(fs.onRescan(() => this.zone.run(() => this.rescan())));
      this.disposers.push(fs.onMenu((v) => this.zone.run(() => this.runMenu(v.cmd, v.arg))));
      this.disposers.push(fs.onDrivesChanged((p) => this.zone.run(() => this.onDrivesChanged(p))));
      // The "folder being scanned" label is written straight into the DOM: while a
      // big scan streams batches, change detection can be seconds apart and the
      // signal binding alone would look frozen on the first folder.
      this.disposers.push(
        fs.onCurrent((dir) => {
          const el = this.sbDirText()?.nativeElement;
          if (el) el.textContent = this.shortDir(dir);
        }),
      );
    }
    const af = window.driversize?.autofilter;
    if (af) {
      setTimeout(() => {
        try {
          this.scan.setFilter(JSON.parse(af));
        } catch {
          /* ignore */
        }
      }, window.driversize?.filterDelay ?? 2500);
    }
  }

  /**
   * Landing folder of a normal launch: the logged-in user's Documents.
   * Resolved through the shell (`app.getPath('documents')`), so a redirected
   * folder (OneDrive, another drive) is honoured. The folder is only *opened*
   * (one-level listing) — the scan starts when the user asks for it.
   */
  private async startInDocuments(): Promise<void> {
    if (!window.driversize?.knownFolders) return;
    if (this.scan.rootPath() || this.scan.selectedPath()) return;
    await this.scan.loadKnownFolders();
    // The user may have navigated while the shell folders were loading.
    if (this.scan.rootPath() || this.scan.selectedPath()) return;
    const doc = this.scan.knownFolders().find((f) => f.id === 'documents')?.path;
    if (!doc) return;
    this.overview.set(false);
    this.pathInput.set(doc);
    await this.scan.select(doc);
  }

  /**
   * The main process noticed a drive being plugged in or removed. Refresh the
   * list (sidebar + "Este computador"), tell the user, and leave a folder that
   * went away together with its drive.
   */
  private onDrivesChanged(p: { drives: unknown[]; added: string[]; removed: string[] }): void {
    const first = this.scan.drives().length === 0;
    const short = (r: string): string => r.replace(/[\\/]+$/, '');
    this.scan.setDrives(p.drives as DriveInfo[]);
    if (first) return; // the initial load: nothing was hot-plugged
    if (p.removed.length) this.scan.notify(this.tf('driveRemoved', { d: p.removed.map(short).join(', ') }));
    if (p.added.length) this.scan.notify(this.tf('driveAdded', { d: p.added.map(short).join(', ') }));
    const current = this.scan.selectedPath() ?? this.scan.rootPath();
    const gone = current ? p.removed.some((r) => current.toLowerCase().startsWith(r.toLowerCase())) : false;
    if (gone) {
      if (this.scan.scanning()) void this.scan.cancel();
      this.scan.reset();
      void this.startInDocuments();
    }
  }

  scanPath(): void {
    const p = normalizeRoot(this.pathInput());
    if (p) {
      this.overview.set(false);
      this.pathEditing.set(false);
      void this.scan.startScan(p);
      // "Escanear" must never leave focus (and hidden text) behind the breadcrumb.
      this.pbInput()?.nativeElement.blur();
    }
  }

  async pick(): Promise<void> {
    const p = await this.scan.pickFolder();
    if (p) {
      this.pathInput.set(p);
      this.pathEditing.set(false);
      await this.scan.startScan(p);
    }
  }

  cancel(): void {
    void this.scan.cancel();
  }

  setUnit(u: SizeUnit): void {
    this.scan.setSizeUnit(u);
  }
  showChart(): boolean {
    return this.scan.showChart();
  }

  ngOnDestroy(): void {
    for (const d of this.disposers) d();
  }

  // ---- keyboard shortcuts --------------------------------------------------
  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    const tag = (ev.target as HTMLElement | null)?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

    if (ev.key === 'Escape') {
      if (this.inspectMode()) {
        this.inspectMode.set(false);
        ev.preventDefault();
        return;
      }
      if (this.showFind()) {
        this.closeFind();
        ev.preventDefault();
        return;
      }
      if (this.showMenu() || this.showRecent()) {
        this.closeMenu();
        this.showRecent.set(false);
        ev.preventDefault();
        return;
      }
      if (this.showLargestDrive()) {
        this.showLargestDrive.set(false);
        ev.preventDefault();
        return;
      }
      if (this.showDupes()) {
        this.closeDupes();
        ev.preventDefault();
        return;
      }
      if (this.showCleanup()) {
        this.closeCleanup();
        ev.preventDefault();
        return;
      }
      if (this.showLargest()) {
        this.showLargest.set(false);
        ev.preventDefault();
        return;
      }
      if (this.showFilter()) {
        this.showFilter.set(false);
        ev.preventDefault();
        return;
      }
      if (this.showOptions()) {
        this.showOptions.set(false);
        ev.preventDefault();
        return;
      }
      if (this.showHelp()) {
        this.showHelp.set(false);
        ev.preventDefault();
        return;
      }
      if (this.showAbout()) {
        this.showAbout.set(false);
        ev.preventDefault();
        return;
      }
      if (this.renameTarget()) {
        this.renameTarget.set(null);
        ev.preventDefault();
        return;
      }
      if (!typing) {
        this.selectedPaths.set(new Set());
        ev.preventDefault();
      }
      return;
    }
    if (typing) return;

    // Ctrl+Shift+F opens the global search; Ctrl+F focuses the folder filter.
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === 'F' || ev.key === 'f')) {
      this.openFind();
      ev.preventDefault();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'f' || ev.key === 'F')) {
      const el = this.searchInput()?.nativeElement;
      if (el) {
        el.focus();
        el.select();
      }
      ev.preventDefault();
      return;
    }

    // F5 rescans the analysed root (same as the Resscanear button).
    if (ev.key === 'F5') {
      if (this.scan.rootPath() && !this.scan.scanning()) this.rescan();
      ev.preventDefault();
      return;
    }

    // Navigation (the shell has no back/forward buttons: the path box, the
    // sidebar and the "visão geral" tree cover it, these are the shortcuts).
    if (ev.altKey && ev.key === 'ArrowLeft') {
      this.scan.back();
      ev.preventDefault();
      return;
    }
    if (ev.altKey && ev.key === 'ArrowRight') {
      this.scan.forward();
      ev.preventDefault();
      return;
    }
    if (ev.altKey && ev.key === 'ArrowUp') {
      this.scan.up();
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Backspace') {
      this.scan.up();
      ev.preventDefault();
      return;
    }

    const rows = this.scan.rows();

    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
      this.selectedPaths.set(new Set(rows.map((r) => r.path)));
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Delete') {
      const paths = [...this.selectedPaths()];
      if (paths.length) {
        void this.deleteSelected(paths);
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === 'F2') {
      const sel = [...this.selectedPaths()];
      const r = rows.find((x) => x.path === sel[0]);
      if (sel.length === 1 && r) {
        this.renameTarget.set({ path: r.path, name: r.name });
        this.renameName.set(r.name);
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === 'Enter') {
      const sel = [...this.selectedPaths()];
      const r = rows.find((x) => x.path === sel[0]);
      if (sel.length === 1 && r) {
        if (r.kind === 'folder') void this.scan.select(r.path);
        else void window.driversize?.openPath(r.path);
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
      if (!rows.length) return;
      let idx = rows.findIndex((r) => this.selectedPaths().has(r.path));
      if (ev.key === 'ArrowDown') idx = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
      else if (ev.key === 'ArrowUp') idx = idx <= 0 ? 0 : idx - 1;
      else if (ev.key === 'Home') idx = 0;
      else idx = rows.length - 1;
      const r = rows[idx];
      if (r) {
        this.selectedPaths.set(new Set([r.path]));
        this.anchor = idx;
        this.scrollRowIntoView(r.path);
      }
      ev.preventDefault();
    }
  }

  private scrollRowIntoView(p: string): void {
    setTimeout(() => {
      const el = document.querySelector(`.table-body [data-path="${CSS.escape(p)}"]`);
      (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    });
  }

  private async deleteSelected(paths: string[]): Promise<void> {
    const n = await window.driversize?.deletePaths(paths);
    if (n && n > 0) this.selectedPaths.set(new Set());
  }

  // ---- sorting -------------------------------------------------------------
  setSort(k: SortKey): void {
    this.scan.setSort(k);
  }
  arrow(k: SortKey): string {
    return this.scan.sortKey() === k ? (this.scan.sortDir() === 'asc' ? '▲' : '▼') : '';
  }

  // ---- multi-selection -----------------------------------------------------
  isSelected(path: string): boolean {
    return this.selectedPaths().has(path);
  }

  onRowClick(ev: MouseEvent, r: Row, index: number): void {
    const rows = this.scan.rows();
    const set = new Set(this.selectedPaths());
    if (ev.shiftKey && this.anchor >= 0) {
      const lo = Math.min(this.anchor, index);
      const hi = Math.max(this.anchor, index);
      if (!ev.ctrlKey) set.clear();
      for (let i = lo; i <= hi; i++) set.add(rows[i].path);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (set.has(r.path)) set.delete(r.path);
      else set.add(r.path);
      this.anchor = index;
    } else {
      set.clear();
      set.add(r.path);
      this.anchor = index;
    }
    this.selectedPaths.set(set);
  }

  onRowDblClick(r: Row): void {
    if (r.kind === 'folder') void this.scan.select(r.path);
  }

  // ---- OS context menu -----------------------------------------------------
  onRowContextMenu(ev: MouseEvent, r: Row): void {
    ev.preventDefault();
    let set = this.selectedPaths();
    if (!set.has(r.path)) {
      set = new Set([r.path]);
      this.selectedPaths.set(set);
    }
    void window.driversize?.contextMenu([...set]);
  }
  onNodeContextMenu(ev: MouseEvent, node: FolderNode): void {
    ev.preventDefault();
    this.selectedPaths.set(new Set([node.path]));
    void window.driversize?.contextMenu([node.path]);
  }
  /**
   * Right-click on a drive: the real Windows menu of the volume (Abrir, Formatar,
   * Propriedades with the disk tools, BitLocker, ...) instead of a menu built here.
   */
  onDriveContextMenu(ev: MouseEvent, d: DriveInfo): void {
    ev.preventDefault();
    ev.stopPropagation();
    void window.driversize?.contextMenu([d.root]);
  }
  async confirmRename(): Promise<void> {
    const t = this.renameTarget();
    const name = this.renameName().trim();
    if (!t || !name || name === t.name) {
      this.renameTarget.set(null);
      return;
    }
    const r = await window.driversize?.rename(t.path, name);
    if (r?.ok && r.path) this.scan.renameEntry(t.path, r.path);
    this.renameTarget.set(null);
  }
  cancelRename(): void {
    this.renameTarget.set(null);
  }

  /**
   * Sidebar (favorites / known folders / drives): just open the folder and show
   * its contents — no scan. The scan is started only from the Scan button
   * (or Scan ▸ Scan Selected Drive).
   */
  openSidebar(path: string): void {
    this.overview.set(false);
    this.pathInput.set(path);
    this.pathEditing.set(false);
    void this.scan.select(path);
  }

  scanDrive(root: string): void {
    this.overview.set(false);
    this.pathInput.set(root);
    this.pathEditing.set(false);
    void this.scan.startScan(root);
  }

  selectNode(path: string): void {
    this.selectedPaths.set(new Set());
    void this.scan.select(path);
  }

  /** Breadcrumb level: select the folder and immediately show its contents on the right. */
  gotoSeg(path: string): void {
    void this.scan.select(path);
  }

  back(): void {
    this.overview.set(false);
    this.scan.back();
  }
  forward(): void {
    this.overview.set(false);
    this.scan.forward();
  }
  up(): void {
    const p = this.scan.selectedPath();
    // At a volume root the parent is the volume itself, so ↑ goes up to "Este computador".
    if (!p || /^[a-zA-Z]:[\\/]?$/.test(p)) {
      this.overview.set(true);
      return;
    }
    this.overview.set(false);
    this.scan.up();
  }
  /** ↑ is offered whenever there is something above the current folder. */
  readonly canUp = computed<boolean>(
    () => !this.overview() && !!(this.scan.selectedPath() ?? this.scan.rootPath()),
  );
  /** Breadcrumb segment that is a volume root ("C:"). */
  isDrive(name: string): boolean {
    return /^[a-zA-Z]:$/.test(name);
  }
  /** Click on the breadcrumb track: turn it into an editable path field. */
  editPath(): void {
    this.pathInput.set(this.scan.selectedPath() ?? this.scan.rootPath() ?? this.pathInput());
    this.pathEditing.set(true);
    this.pbInput()?.nativeElement.focus();
  }
  /**
   * Leaving the field restores the folder on screen: the path field and the
   * breadcrumb must always agree on what "Escanear" is about to scan.
   */
  endEditPath(): void {
    this.pathEditing.set(false);
    const p = this.scan.selectedPath() ?? this.scan.rootPath() ?? '';
    if (p) this.pathInput.set(p);
  }
  /** Keeps the typed path alive while a toolbar button is pressed (mousedown). */
  keepFocus(ev: Event): void {
    if (this.pathEditing()) ev.preventDefault();
  }
  toggleChart(): void {
    this.scan.toggleChart();
  }

  // ---- filter modal (edits a local draft; applies on "Aplicar") -------------
  openFilter(): void {
    this.draft.set({ ...this.scan.filter() });
    this.showFilter.set(true);
  }
  closeFilter(): void {
    this.showFilter.set(false);
  }
  setDraft(patch: Partial<FilterSpec>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }
  draftAttr(bit: number): boolean {
    return (this.draft().attrMask & bit) !== 0;
  }
  toggleDraftAttr(bit: number): void {
    this.draft.update((d) => ({ ...d, attrMask: d.attrMask ^ bit, attrEnabled: true }));
  }
  /** Reset the filter and turn it off (keeps the scanned results). */
  clearFilterNow(): void {
    this.scan.setFilter({ ...DEFAULT_FILTER });
    this.draft.set({ ...DEFAULT_FILTER });
    this.showFilter.set(false);
  }
  /** Apply the draft criteria; "Aplicar" always turns the filter on. */
  applyFilter(): void {
    this.scan.setFilter({ ...this.draft(), enabled: true });
    this.showFilter.set(false);
  }

  // ---- file-type panel + real-time monitoring ------------------------------
  extList(): string[] {
    return [...this.scan.extFilter()];
  }
  isExtActive(ext: string): boolean {
    return this.scan.extFilter().has(ext);
  }
  toggleExt(ext: string): void {
    this.scan.toggleExt(ext);
  }
  clearExtFilter(): void {
    this.scan.clearExtFilter();
  }
  toggleMonitor(ev: Event): void {
    void this.scan.setMonitorEnabled((ev.target as HTMLInputElement).checked);
  }
  toggleTray(ev: Event): void {
    void this.scan.setMinimizeToTray((ev.target as HTMLInputElement).checked);
  }
  rescan(): void {
    const root = this.scan.rootPath();
    if (root && !this.scan.scanning()) {
      this.pathInput.set(root);
      void this.scan.startScan(root);
    }
  }
  exportHtml(): void {
    void this.scan.exportHtml();
  }

  // ---- redesigned shell: title bar / top bar / sidebar ---------------------
  /** ⋮ dropdown (items come from the main process). */
  toggleMenu(): void {
    this.showRecent.set(false);
    this.openSub.set(null);
    this.showMenu.update((v) => !v);
  }
  closeMenu(): void {
    this.showMenu.set(false);
    this.openSub.set(null);
  }
  toggleSub(label: string): void {
    this.openSub.update((cur) => (cur === label ? null : label));
  }
  menuClick(n: MenuNode): void {
    if (n.submenu) {
      this.toggleSub(n.label ?? '');
      return;
    }
    if (n.enabled === false) return;
    this.closeMenu();
    if (n.cmd) this.runMenu(n.cmd, n.arg);
  }
  menuChecked(n: MenuNode): boolean {
    return n.checked === true;
  }

  /** Path box history. */
  toggleRecent(): void {
    this.showMenu.set(false);
    this.showRecent.update((v) => !v);
  }
  pickRecent(p: string): void {
    this.showRecent.set(false);
    this.pathInput.set(p);
    this.pathEditing.set(false);
    void this.scan.startScan(p);
  }

  /** Sidebar: favorites, known folders, drives. */
  knownLabel(id: string, path: string): string {
    const key = KNOWN_KEY[id];
    if (key) return this.i18n.t(key);
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }
  favName(p: string): string {
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
  }
  addFavorite(): void {
    void this.pickFavorite();
  }
  private async pickFavorite(): Promise<void> {
    const p = await this.scan.pickFolder();
    if (p) this.scan.addFavorite(p);
  }
  removeFavorite(ev: Event, p: string): void {
    ev.stopPropagation();
    this.scan.removeFavorite(p);
  }
  isFav(p: string): boolean {
    return this.scan.favorites().includes(p);
  }
  driveLetter(d: DriveInfo): string {
    return d.root.replace(/[\\/]+$/, '');
  }
  drivePct(d: DriveInfo): number {
    return d.total ? Math.min(100, (d.used / d.total) * 100) : 0;
  }
  driveLow(d: DriveInfo): boolean {
    return d.total > 0 && d.used / d.total > 0.9;
  }

  /**
   * Status-bar path: long paths keep the drive plus the tail (the part that keeps
   * changing while the scan goes deeper), aligned to a folder boundary.
   */
  shortDir(p: string): string {
    const max = 74;
    if (!p || p.length <= max) return p;
    const drive = /^[a-zA-Z]:\\/.test(p) ? p.slice(0, 2) : '';
    const budget = max - (drive ? drive.length + 3 : 1);
    let tail = p.slice(-budget);
    const sep = tail.indexOf('\\');
    if (sep > 0 && sep < 14) tail = tail.slice(sep + 1);
    return (drive ? drive + '\\…\\' : '…') + tail;
  }

  /** Content header + result toolbar. */
  setSearch(ev: Event): void {
    this.scan.setSearch((ev.target as HTMLInputElement).value);
  }
  clearSearch(): void {
    this.scan.setSearch('');
  }
  setView(m: ViewMode): void {
    this.scan.setViewMode(m);
  }
  onSortOption(ev: Event): void {
    this.scan.setSortOption((ev.target as HTMLSelectElement).value);
  }
  sortLabel(o: SortOption): string {
    return this.i18n.t(SORT_KEY[o]);
  }
  rowGlyph(r: Row): string {
    return GLYPH[this.scan.rowCategory(r)];
  }
  barWidth(r: Row): number {
    return Math.max(2, Math.round((r.size / this.maxRowSize()) * 100));
  }
  itemsLabel(r: Row): string {
    return r.kind === 'folder' && r.items ? this.i18n.int(r.items) : '';
  }
  lastScanText(): string {
    const ts = this.scan.lastScanAt();
    return ts ? this.i18n.tf('lastScanLabel', { date: this.i18n.dateShort(ts) }) : this.i18n.t('neverScanned');
  }
  // ---- global search (⌕ over the whole scanned tree) ------------------------
  openFind(): void {
    if (!this.scan.rootPath()) return;
    // Never stack dialogs: the shortcut/menu entry is ignored while another one is open.
    if (this.showOptions() || this.showCleanup() || this.showDupes() || this.showFilter() || this.showLargest() ||
        this.showLargestDrive() || this.showHelp() || this.showAbout() || this.showRecent() || this.renameTarget()) return;
    this.showMenu.set(false);
    this.showFind.set(true);
    this.findSel.set(0);
    setTimeout(() => this.findInput()?.nativeElement.focus(), 40);
  }
  closeFind(): void {
    this.showFind.set(false);
    this.findQuery.set('');
    this.findHits.set([]);
    this.findSel.set(0);
  }
  setFindQuery(ev: Event): void {
    const v = (ev.target as HTMLInputElement).value;
    this.findQuery.set(v);
    this.findSel.set(0);
    if (this.findTimer) clearTimeout(this.findTimer);
    this.findTimer = setTimeout(() => this.findHits.set(this.scan.findAll(v)), 160);
  }
  findKey(ev: KeyboardEvent): void {
    const hits = this.findHits();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.findSel.update((i) => Math.min(hits.length - 1, i + 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      this.findSel.update((i) => Math.max(0, i - 1));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const h = hits[this.findSel()];
      if (h) this.goFind(h);
    }
  }
  goFind(h: FindHit): void {
    this.closeFind();
    this.revealFile(h.path);
  }

  openCleanLog(): void {
    const log = this.scan.lastCleanup()?.log;
    if (log) void window.driversize?.openCleanLog(log);
  }

  /** Whole files/second for the status bar (the signal holds a smoothed float). */
  rateInt(): number {
    return Math.round(this.scan.rate());
  }

  openLargest(): void {
    this.showLargest.set(true);
  }
  closeLargest(): void {
    this.showLargest.set(false);
  }
  openLargestDrive(): void {
    this.showLargestDrive.set(true);
  }
  closeLargestDrive(): void {
    this.showLargestDrive.set(false);
  }

  // ---- duplicate finder -----------------------------------------------------
  openDupes(): void {
    this.showDupes.set(true);
    this.dupeSelected.set(new Set());
  }
  closeDupes(): void {
    // Closing while the hashes are still running stops the worker: it is only
    // started from here, so leaving it running in the background helps nobody.
    if (this.scan.dupeState() === 'running') void this.scan.cancelDupeSearch();
    this.showDupes.set(false);
    this.dupeSelected.set(new Set());
  }
  /** Start (or restart) the search over the analysed root. */
  startDupes(): void {
    this.dupeSelected.set(new Set());
    this.lastDupeState = 'idle';
    void this.scan.startDupeSearch(this.scan.dupeMinSize());
  }
  cancelDupes(): void {
    void this.scan.cancelDupeSearch();
  }
  setDupeMin(ev: Event): void {
    const v = Number((ev.target as HTMLSelectElement).value);
    if (v > 0) this.scan.dupeMinSize.set(v);
  }
  /** The first path of a group is kept; it can never be checked. */
  isDupeKeeper(g: DupeGroup, p: string): boolean {
    return g.paths[0] === p;
  }
  isDupeChecked(p: string): boolean {
    return this.dupeSelected().has(p);
  }
  toggleDupe(p: string): void {
    const s = new Set(this.dupeSelected());
    if (s.has(p)) s.delete(p);
    else s.add(p);
    this.dupeSelected.set(s);
  }
  /** Check/uncheck every copy of a group except the keeper. */
  toggleDupeGroup(g: DupeGroup): void {
    const extras = g.paths.slice(1);
    const s = new Set(this.dupeSelected());
    const all = extras.every((p) => s.has(p));
    for (const p of extras) {
      if (all) s.delete(p);
      else s.add(p);
    }
    this.dupeSelected.set(s);
  }
  dupeGroupChecked(g: DupeGroup): number {
    const sel = this.dupeSelected();
    return g.paths.reduce((n, p) => n + (sel.has(p) ? 1 : 0), 0);
  }
  /** File name / folder of a duplicate path (the dialog shows both columns). */
  dupeName(p: string): string {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i >= 0 ? p.slice(i + 1) : p;
  }
  dupeDir(p: string): string {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : p;
  }
  async deleteDupeSelected(): Promise<void> {
    const api = window.driversize;
    const paths = [...this.dupeSelected()];
    if (!api || !paths.length) return;
    const n = await api.deletePaths(paths);
    if (n && n > 0) {
      this.scan.pruneDupes(paths);
      this.dupeSelected.set(new Set());
      this.scan.notify(this.i18n.tf('dupesDeleted', { n: this.i18n.int(n) }));
    }
  }

  // ---- safe cleanup ---------------------------------------------------------
  openCleanup(): void {
    this.showCleanup.set(true);
    this.cleanConfirm.set(false);
    this.cleanSelectedIds.set(new Set(CLEAN_PRESELECT));
    void this.scan.loadLastCleanup();
    // Measure once; reopening shows the numbers already computed.
    if (!this.scan.cleanTargets().length && this.scan.cleanState() === 'idle') this.scan.scanCleanTargets();
  }
  closeCleanup(): void {
    if (this.scan.cleanState() === 'measuring') this.scan.cancelClean();
    this.showCleanup.set(false);
    this.cleanConfirm.set(false);
  }
  /** Measure again (after a cleanup, or to pick up new junk). */
  restartCleanup(): void {
    this.cleanSelectedIds.set(new Set(CLEAN_PRESELECT));
    this.cleanConfirm.set(false);
    this.scan.scanCleanTargets();
  }
  isCleanChecked(id: string): boolean {
    return this.cleanSelectedIds().has(id);
  }
  toggleClean(id: string): void {
    const s = new Set(this.cleanSelectedIds());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.cleanSelectedIds.set(s);
    this.cleanConfirm.set(false);
  }
  /** First click arms the action, the second one deletes (no native dialog needed). */
  async applyCleanup(): Promise<void> {
    const ids = [...this.cleanSelectedIds()];
    if (!ids.length) return;
    if (!this.cleanConfirm()) {
      this.cleanConfirm.set(true);
      return;
    }
    this.cleanConfirm.set(false);
    await this.scan.cleanSelected(ids);
    this.cleanSelectedIds.set(new Set());
  }
  cleanStateLabel(t: CleanTarget): string {
    if (t.state === 'measuring') return this.i18n.t('cleanupMeasuring');
    if (t.state === 'denied') return this.i18n.t('cleanupDenied');
    if (t.state === 'cleared') return this.i18n.t('cleanupCleared');
    return '';
  }

  // ---- developer tools ------------------------------------------------------
  /** Arms the element picker: the next click opens DevTools on that element. */
  startInspect(): void {
    this.showMenu.set(false);
    this.showRecent.set(false);
    this.inspectMode.set(true);
  }
  cancelInspect(): void {
    this.inspectMode.set(false);
  }
  onInspectPick(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const x = ev.clientX;
    const y = ev.clientY;
    this.inspectMode.set(false);
    void window.driversize?.inspectElement(x, y);
  }
  /** Reveal a file in its Explorer window (the app stays where it is). */
  showInFolder(p: string): void {
    void window.driversize?.showItem(p);
  }
  openFile(p: string): void {
    void window.driversize?.openPath(p);
  }
  /** Right-click on a row of the "largest files" dialogs: the Windows menu. */
  onFileContextMenu(ev: MouseEvent, p: string): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.selectedPaths.set(new Set([p]));
    void window.driversize?.contextMenu([p]);
  }

  /** Folder header + status bar numbers (see `revision`: nodes are mutated). */
  readonly headName = computed<string>(() => {
    this.scan.revision();
    const n = this.scan.selectedNode();
    if (n) return n.name;
    const p = this.scan.selectedPath() ?? '';
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  });
  readonly headFiles = computed<number>(() => {
    this.scan.revision();
    const n = this.scan.selectedNode();
    return n ? n.files : this.scan.rows().filter((r) => r.kind === 'file').length;
  });
  readonly headFolders = computed<number>(() => {
    this.scan.revision();
    const n = this.scan.selectedNode();
    return n ? n.folders : this.scan.rows().filter((r) => r.kind === 'folder').length;
  });
  /**
   * Live scan totals while scanning; on the "Visão geral" the analysed root, and
   * the selected folder otherwise.
   */
  readonly statFiles = computed<number>(() => (this.scan.scanning() ? this.scan.totals().files : (this.overviewRoot()?.files ?? this.headFiles())));
  readonly statFolders = computed<number>(() => (this.scan.scanning() ? this.scan.totals().folders : (this.overviewRoot()?.folders ?? this.headFolders())));
  readonly statBytes = computed<number>(() => (this.scan.scanning() ? this.scan.totals().bytes : (this.overviewRoot()?.size ?? this.scan.selectedTotal())));

  /** Total capacity of the listed drives (the "Este computador" numbers). */
  readonly drivesTotal = computed<number>(() => this.scan.drives().reduce((sum, d) => sum + (d.total || 0), 0));
  readonly drivesUsed = computed<number>(() => this.scan.drives().reduce((sum, d) => sum + (d.used || 0), 0));
  readonly drivesFree = computed<number>(() => this.scan.drives().reduce((sum, d) => sum + (d.free || 0), 0));
  readonly drivesUsedPct = computed<number>(() => {
    const total = this.drivesTotal();
    return total ? (this.drivesUsed() / total) * 100 : 0;
  });

  /** "Visão geral" screen (the folder tree that used to be the left pane). */
  readonly overview = signal(false);

  /** What the overview shows: the analysed tree, or the drives when nothing was analysed. */
  private readonly overviewRoot = computed(() => (this.overview() ? this.scan.viewRoot() : null));
  readonly overviewHasTree = computed<boolean>(() => this.overviewRoot() !== null);

  openOverview(): void {
    this.overview.set(true);
  }

  /** Enter a folder (from the tree/overview or the table). */
  enterFolder(path: string): void {
    this.overview.set(false);
    this.selectNode(path);
  }

  knownGlyph(id: string): string {
    return KNOWN_GLYPH[id] ?? '📁';
  }
  fileGlyph(ext: string): string {
    return GLYPH[categoryOf(ext)];
  }
  /** Sidebar highlight: the folder currently shown (scanned root or opened folder). */
  isCurrent(p: string): boolean {
    const cur = this.scan.selectedPath() ?? this.scan.rootPath();
    if (!cur) return false;
    const norm = (s: string): string => s.replace(/[\\/]+$/, '').toLowerCase();
    return norm(cur) === norm(p);
  }
  toggleRow(r: Row, ev: Event): void {
    void ev;
    const set = new Set(this.selectedPaths());
    if (set.has(r.path)) set.delete(r.path);
    else set.add(r.path);
    this.selectedPaths.set(set);
  }
  allSelected(): boolean {
    const rows = this.scan.rows();
    return rows.length > 0 && rows.every((r) => this.selectedPaths().has(r.path));
  }
  toggleAll(ev: Event): void {
    const on = (ev.target as HTMLInputElement).checked;
    this.selectedPaths.set(on ? new Set(this.scan.rows().map((r) => r.path)) : new Set());
  }
  rowTooltip(r: Row): string {
    return `${r.path}\n${this.t('colAllocated')}: ${this.scan.formatBytes(r.allocated)}`;
  }
  /** Jump from "maiores arquivos" to the file in its folder. */
  revealFile(p: string): void {
    const dir = p.replace(/[\\/][^\\/]*$/, '') || p;
    this.overview.set(false);
    if (dir && dir !== this.scan.selectedPath()) void this.scan.select(dir);
    this.selectedPaths.set(new Set([p]));
  }
  toggleMonitorBtn(): void {
    void this.scan.setMonitorEnabled(!this.scan.monitorEnabled());
  }

  // ---- menu bar commands ---------------------------------------------------
  runMenu(cmd: string, arg?: unknown): void {
    switch (cmd) {
      case 'file-new':
        this.scan.newScan();
        break;
      case 'file-load':
        void this.scan.openSession();
        break;
      case 'file-save':
        void this.scan.saveSession();
        break;
      case 'export-chart':
        void this.scan.exportChartImage();
        break;
      case 'export-as':
        void this.scan.exportAs();
        break;
      case 'export-details':
        void this.scan.exportDetailsView();
        break;
      case 'options':
        this.openOptions();
        break;
      case 'print-tree':
        void this.scan.printTree();
        break;
      case 'print-details':
        void this.scan.printDetails();
        break;
      case 'scan-drive':
        this.scanSelectedDrive();
        break;
      case 'scan-folder':
        void this.pick();
        break;
      case 'scan-stop':
        this.cancel();
        break;
      case 'filter':
        this.openFilter();
        break;
      case 'dupes':
        this.openDupes();
        break;
      case 'find':
        this.openFind();
        break;
      case 'cleanup':
        this.openCleanup();
        break;
      case 'inspect-element':
        this.startInspect();
        break;
      case 'set-unit':
        this.scan.setSizeUnit(String(arg) as SizeUnit);
        break;
      case 'toggle-driveinfo':
        this.scan.toggleDriveInfo();
        break;
      case 'toggle-chart':
        this.scan.toggleChart();
        break;
      case 'set-lang':
        this.setLang(String(arg));
        break;
      case 'help':
        this.showHelp.set(true);
        break;
      case 'about':
        this.showAbout.set(true);
        break;
      case 'quit':
        void window.driversize?.quit();
        break;
      default:
        break;
    }
  }

  /** Scan ▸ Scan Selected Drive: the drive of the current folder, else the first one. */
  scanSelectedDrive(): void {
    const cur = this.scan.selectedPath() ?? this.scan.rootPath() ?? '';
    const m = /^([a-zA-Z]):/.exec(cur);
    const root = m ? m[1].toUpperCase() + ':\\' : (this.scan.drives()[0]?.root ?? '');
    if (root) this.scanDrive(root);
  }

  showDriveInfo(): boolean {
    return this.scan.showDriveInfo();
  }

  // ---- Options… dialog -----------------------------------------------------
  openOptions(): void {
    this.optDraft.set({
      unit: this.scan.sizeUnit(),
      chart: this.scan.showChart(),
      driveInfo: this.scan.showDriveInfo(),
      splash: this.scan.showSplash(),
      monitor: this.scan.monitorEnabled(),
      tray: this.scan.minimizeToTray(),
      lang: this.i18n.lang(),
      theme: this.scan.themePref(),
      density: this.scan.density(),
      showDisk: this.scan.showDisk(),
      exclude: this.scan.excludes().join('\n'),
    });
    this.showOptions.set(true);
  }
  closeOptions(): void {
    this.showOptions.set(false);
  }
  setOpt(
    patch: Partial<{
      unit: SizeUnit;
      chart: boolean;
      driveInfo: boolean;
      splash: boolean;
      monitor: boolean;
      tray: boolean;
      lang: Lang;
      theme: 'light' | 'dark' | 'system';
      density: 'normal' | 'compact';
      showDisk: boolean;
      exclude: string;
    }>,
  ): void {
    this.optDraft.update((d) => ({ ...d, ...patch }));
  }
  restoreOptDefaults(): void {
    this.optDraft.set({
      unit: 'auto',
      chart: true,
      driveInfo: true,
      splash: true,
      monitor: true,
      tray: false,
      lang: this.i18n.lang(),
      theme: 'system',
      density: 'normal',
      showDisk: true,
      exclude: '',
    });
  }
  applyOptions(): void {
    const d = this.optDraft();
    this.scan.setSizeUnit(d.unit);
    this.scan.setShowChart(d.chart);
    this.scan.setShowDriveInfo(d.driveInfo);
    this.scan.setShowSplash(d.splash);
    this.scan.setThemePref(d.theme);
    this.scan.setDensity(d.density);
    this.scan.setShowDisk(d.showDisk);
    this.scan.setExcludes(d.exclude.split(/\r?\n/));
    void this.scan.setMonitorEnabled(d.monitor);
    void this.scan.setMinimizeToTray(d.tray);
    if (d.lang !== this.i18n.lang()) this.i18n.set(d.lang);
    this.showOptions.set(false);
  }

  /** Language picker (status bar + Options…). */
  setLang(v: string): void {
    if (v === 'pt' || v === 'en' || v === 'es' || v === 'fr') this.i18n.set(v);
  }

  toggleNode(ev: Event, path: string): void {
    ev.stopPropagation();
    this.scan.toggle(path);
  }
}
