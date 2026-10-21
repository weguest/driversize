import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DriveInfo, FsEntry, ScanTotals } from './types';
import { APP_NAME, LANGS, Lang, MAIN, MainDict, fill, isLang, matchLang } from './i18n';
import { makeExcluder } from './scanner/filter';
import { allocBytes } from './scanner/alloc';

// Writing to a closed stdout/stderr (e.g. the app was launched from a terminal that
// has since exited) must never crash the main process: swallow EPIPE instead of
// letting it surface as an uncaught exception.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

/** Diagnostic logging that is safe even when no console is attached. */
function log(message: string): void {
  try {
    console.log(message);
  } catch {
    /* no usable stdout */
  }
}

let win: BrowserWindow | null = null;

// ---- scan state -----------------------------------------------------------
let workers: Worker[] = [];
const control = new SharedArrayBuffer(4);
const cancelFlag = new Int32Array(control);
let queue: string[] = [];
let outstanding = 0;
let totals: ScanTotals = { files: 0, folders: 0, bytes: 0 };
let scanning = false;
let startedAt = 0;
let currentRoot: string | null = null;
/** Last "currently walking" folder forwarded to the renderer (throttled). */
let lastScanDir = '';
let lastScanDirAt = 0;
let tray: Tray | null = null;
let isQuitting = false;

// ---- language (native menu / tray / dialogs) ------------------------------
// The renderer owns the choice (settings: `lang`); the main process mirrors it so
// the native menu bar and the OS dialogs are in the same language.
let menuLang: Lang = 'en';

/** Current dictionary for the main process. */
function T(): MainDict {
  return MAIN[menuLang];
}

/** Persisted language, falling back to the OS locale and then to English. */
function resolveLang(): Lang {
  const saved = readSettings()['lang'];
  return isLang(saved) ? saved : matchLang(app.getLocale());
}

/**
 * Forwards an event to the renderer. A worker can still be delivering messages
 * while the window is being torn down, so the target is checked first: sending to
 * a destroyed `webContents` throws in the main process and pops up an error box
 * right when the user closes the window.
 */
function send(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* the window went away between the check and the send */
  }
}

// ---- settings persistence -------------------------------------------------
// The settings live next to the other per-user data, in a folder named after the
// product (Electron derives it from `productName`).
function settingsFile(): string {
  return path.join(app.getPath('userData'), 'driversize-settings.json');
}

function readSettings(): Record<string, unknown> {
  try {
    const text = fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function writeSettings(patch: Record<string, unknown>): boolean {
  try {
    const next = { ...readSettings(), ...patch };
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Exclusion patterns from the settings (name globs or absolute paths). */
function readExcludes(): string[] {
  const v = readSettings()['exclude'];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Taskbar progress: 0..1, 2 = indeterminate, -1 = clear. */
function taskbarProgress(value: number): void {
  if (win && !win.isDestroyed()) win.setProgressBar(value);
}

// ---- icons ----------------------------------------------------------------
/** Product icon shipped in `assets/`, next to the compiled main process. */
function iconPath(ext: 'ico' | 'png'): string {
  return path.join(__dirname, '..', 'assets', 'icon.' + ext);
}

/** Height of the title bar drawn by the renderer (the overlay buttons match it). */
const TITLEBAR_HEIGHT = 44;

// ---- splash (startup screen) ----------------------------------------------
// A small frameless window that paints `assets/splash.jpg` while the renderer
// boots. It is skipped in the taskbar, carries no UI and takes no part in the
// app lifecycle: as soon as the main window reports its first paint it fades
// away, and it can be turned off in Options… ▸ Show.
let splash: BrowserWindow | null = null;
let splashFade: ReturnType<typeof setInterval> | null = null;
let splashShownAt = 0;
/** Minimum time on screen, so a fast start does not flash a single frame. */
const SPLASH_MIN_MS = 1200;
/** Safety net: never keep the splash (or a hidden window) if a paint never comes. */
const SPLASH_REVEAL_MS = 10000;

/** Is the startup screen enabled? (Options… ▸ Show ▸ Splash screen) */
function splashEnabled(): boolean {
  return readSettings()['showSplash'] !== false;
}

/**
 * The splash document: the artwork inlined as a data URL (so nothing has to be
 * fetched) with the window sized to the artwork itself, which keeps the image
 * pixel-exact instead of letterboxed.
 */
function splashMarkup(): { html: string; width: number; height: number } | null {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'splash.jpg'));
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const width = 640;
    const height =
      size.width > 0 && size.height > 0 ? Math.round((size.height / size.width) * width) : 360;
    const html =
      '<!doctype html><meta charset="utf-8"><style>' +
      'html,body{margin:0;height:100%;overflow:hidden;background:#08265c}' +
      'img{display:block;width:100%;height:100%;object-fit:contain}' +
      '</style><img alt="" src="' +
      img.toDataURL() +
      '">';
    return { html, width, height };
  } catch (err) {
    log('[splash] indisponivel: ' + String(err));
    return null;
  }
}

/** Cross-fades the splash; the timer is dropped if the window goes away. */
function fadeSplash(target: number, ms: number, done?: () => void): void {
  const el = splash;
  if (!el) return;
  if (splashFade) clearInterval(splashFade);
  const from = el.getOpacity();
  const steps = 10;
  let step = 0;
  splashFade = setInterval(() => {
    step++;
    const target2 = splash;
    if (!target2 || target2.isDestroyed()) {
      if (splashFade) clearInterval(splashFade);
      splashFade = null;
      return;
    }
    try {
      target2.setOpacity(from + ((target - from) * step) / steps);
    } catch {
      /* setOpacity is a no-op on some window managers */
    }
    if (step >= steps) {
      if (splashFade) clearInterval(splashFade);
      splashFade = null;
      done?.();
    }
  }, Math.max(16, Math.round(ms / steps)));
  splashFade.unref?.();
}

function showSplash(): void {
  if (splash || !splashEnabled()) return;
  const art = splashMarkup();
  if (!art) return; // no artwork on disk -> start without a startup screen
  splashShownAt = Date.now();
  splash = new BrowserWindow({
    width: art.width,
    height: art.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Built hidden and revealed on its first painted frame: a window that is
    // shown before Chromium has drawn the artwork would sit there transparent.
    show: false,
    backgroundColor: '#08265c',
    icon: iconPath('ico'),
    title: APP_NAME,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.setMenuBarVisibility(false);
  splash.webContents.on('did-fail-load', (_e, code, desc) => log('[splash] falhou: ' + code + ' ' + desc));
  splash.once('ready-to-show', () => {
    if (!splash || splash.isDestroyed()) return;
    // The minimum on-screen time counts from the moment the artwork is up.
    splashShownAt = Date.now();
    splash.show();
  });
  splash.on('closed', () => {
    if (splashFade) clearInterval(splashFade);
    splashFade = null;
    splash = null;
  });
  void splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(art.html));
}

/** Retires the splash (honouring the minimum on-screen time) and fades it out. */
function hideSplash(immediate = false): void {
  if (!splash) return;
  const wait = immediate ? 0 : Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  const retire = (): void => {
    if (!splash) return;
    fadeSplash(0, 180, () => {
      if (splash && !splash.isDestroyed()) splash.destroy();
      splash = null;
    });
  };
  if (wait === 0) {
    retire();
    return;
  }
  const timer = setTimeout(retire, wait);
  timer.unref?.();
}

/** Drops the splash right now (used when the app is quitting). */
function destroySplash(): void {
  if (splashFade) {
    clearInterval(splashFade);
    splashFade = null;
  }
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

// ---- tray (run in the background) -----------------------------------------
/** The tray glyph is the product icon at 16x16; a drawn folder is the fallback. */
function trayIcon(): Electron.NativeImage {
  try {
    const img = nativeImage.createFromPath(iconPath('png'));
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16, quality: 'best' });
  } catch {
    /* no asset on disk -> draw it */
  }
  return drawnTrayIcon();
}

/** Drawn 16x16 folder glyph as a raw BGRA bitmap (used when the asset is missing). */
function drawnTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const body = y >= 5 && y <= 12 && x >= 1 && x <= 14;
      const tab = y >= 3 && y <= 5 && x >= 1 && x <= 7;
      const hole = y >= 7 && y <= 11 && x >= 3 && x <= 12;
      let b = 0;
      let g = 0;
      let r = 0;
      let a = 0;
      if (body || tab) {
        r = 0x2e;
        g = 0x7d;
        b = 0x32;
        a = 255;
      }
      if (hole) {
        r = 0xff;
        g = 0xff;
        b = 0xff;
        a = 255;
      }
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
  } catch {
    tray = null;
    log('[tray] indisponivel');
    return;
  }
  log('[tray] icone criado');
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: T().trayOpen, click: () => showWindow() },
      { type: 'separator' },
      {
        label: T().trayRescan,
        click: () => {
          if (currentRoot && !scanning) send('app:rescan', currentRoot);
          showWindow();
        },
      },
      { type: 'separator' },
      {
        label: T().trayQuit,
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
    log('[tray] removido');
  }
}

// ---- application menu -----------------------------------------------------
// Menu bar: File | Scan | View | Help. The window is frameless, so the renderer
// draws these items in its own "⋮" dropdown; the definition stays here so the
// labels come from the same dictionaries as the tray/dialogs and the structure
// keeps being dumped to the log for diagnostics. No accelerators are shown.
/** Serializable menu node handed to the renderer. */
interface MenuNode {
  label?: string;
  type?: 'separator';
  checked?: boolean;
  enabled?: boolean;
  cmd?: string;
  arg?: unknown;
  submenu?: MenuNode[];
}

/** Last state pushed by the renderer, so the tree mirrors the app state. */
const menuState = { scanning: false, unit: 'auto', driveInfo: true, chart: true };

const MENU_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * The ⋮ menu. Size items are plain check-boxes whose marks are owned by
 * syncMenuState() (radio groups would be split by the separator before "Auto").
 */
function menuTree(): MenuNode[] {
  const t = T();
  const sizeSub: MenuNode[] = MENU_UNITS.map((u) => ({
    label: u,
    checked: menuState.unit.toLowerCase() === u.toLowerCase(),
    cmd: 'set-unit',
    arg: u,
  }));
  sizeSub.push({ type: 'separator' });
  sizeSub.push({
    label: 'Auto',
    checked: menuState.unit.toLowerCase() === 'auto',
    cmd: 'set-unit',
    arg: 'auto',
  });

  return [
    {
      label: t.file,
      submenu: [
        { label: t.mnNew, cmd: 'file-new' },
        { label: t.mnLoad, cmd: 'file-load' },
        { label: t.mnSave, cmd: 'file-save' },
        { type: 'separator' },
        { label: t.mnExportChart, cmd: 'export-chart' },
        { label: t.mnExportAs, cmd: 'export-as' },
        { label: t.mnExportDetails, cmd: 'export-details' },
        { type: 'separator' },
        { label: t.mnOptions, cmd: 'options' },
        { type: 'separator' },
        { label: t.mnPrintTree, cmd: 'print-tree' },
        { label: t.mnPrintDetails, cmd: 'print-details' },
        { type: 'separator' },
        { label: t.mnExit, cmd: 'quit' },
      ],
    },
    {
      label: t.scan,
      submenu: [
        { label: t.mnScanDrive, cmd: 'scan-drive' },
        { label: t.mnScanFolder, cmd: 'scan-folder' },
        { type: 'separator' },
        { label: t.mnStopScan, enabled: menuState.scanning, cmd: 'scan-stop' },
        { type: 'separator' },
        { label: t.mnFilter, cmd: 'filter' },
      ],
    },
    {
      label: t.tools,
      submenu: [
        { label: t.mnFind, cmd: 'find' },
        { type: 'separator' },
        { label: t.mnDupes, cmd: 'dupes' },
        { label: t.mnCleanup, cmd: 'cleanup' },
        { type: 'separator' },
        { label: t.mnInspect, cmd: 'inspect-element' },
      ],
    },
    {
      label: t.view,
      submenu: [
        { label: t.mnSize, submenu: sizeSub },
        { type: 'separator' },
        {
          label: t.mnLanguage,
          submenu: LANGS.map((l) => ({ label: l.name, checked: menuLang === l.id, cmd: 'set-lang', arg: l.id })),
        },
        { type: 'separator' },
        { label: t.mnDriveInfo, checked: menuState.driveInfo, cmd: 'toggle-driveinfo' },
        { label: t.mnChart, checked: menuState.chart, cmd: 'toggle-chart' },
      ],
    },
    {
      label: t.help,
      submenu: [
        { label: t.mnHelp, cmd: 'help' },
        { type: 'separator' },
        { label: t.mnAbout, cmd: 'about' },
      ],
    },
  ];
}

/** Diagnostic: the full menu structure in the active language. */
function dumpMenu(nodes: MenuNode[]): string {
  return nodes
    .map((n) =>
      n.submenu ? `${n.label || '-'}[${n.submenu.map((s) => (s.type === 'separator' ? '—' : s.label)).join(', ')}]` : n.label || '-',
    )
    .join(' | ');
}

/** The renderer is the source of truth for the check marks and "Stop Scan". */
function syncMenuState(patch: { scanning?: boolean; unit?: string; driveInfo?: boolean; chart?: boolean; lang?: unknown }): void {
  if (patch.lang !== undefined && isLang(patch.lang) && patch.lang !== menuLang) {
    menuLang = patch.lang;
    log('[menu] idioma: ' + menuLang);
    log('[menu] ' + dumpMenu(menuTree()));
    if (tray) {
      destroyTray();
      createTray();
    }
    return;
  }
  if (typeof patch.scanning === 'boolean') menuState.scanning = patch.scanning;
  if (typeof patch.unit === 'string') menuState.unit = patch.unit;
  if (typeof patch.driveInfo === 'boolean') menuState.driveInfo = patch.driveInfo;
  if (typeof patch.chart === 'boolean') menuState.chart = patch.chart;
}

// ---- window ---------------------------------------------------------------
function createWindow(): void {
  const saved = readSettings()['window'] as { x?: number; y?: number; width?: number; height?: number } | undefined;

  // Frameless shell with a custom title bar drawn by the renderer; the real
  // caption buttons are painted by Windows over it (titleBarOverlay), so snap
  // layouts and the native hover states keep working. The overlay follows the
  // stored theme (the renderer re-applies it when the user switches).
  const themePref = readSettings()['theme'];
  const darkTheme = themePref === 'dark' || (themePref !== 'light' && nativeTheme.shouldUseDarkColors);
  const overlay =
    process.platform === 'win32' || process.platform === 'linux'
      ? {
          titleBarOverlay: {
            color: darkTheme ? '#1e2126' : '#ffffff',
            symbolColor: darkTheme ? '#e7e9ec' : '#202124',
            height: TITLEBAR_HEIGHT,
          },
        }
      : {};

  win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    minWidth: 1060,
    minHeight: 640,
    ...(typeof saved?.x === 'number' && typeof saved?.y === 'number' ? { x: saved.x, y: saved.y } : {}),
    backgroundColor: darkTheme ? '#15171a' : '#f1f3f4',
    icon: iconPath('ico'),
    title: APP_NAME,
    titleBarStyle: 'hidden',
    // Built hidden and revealed on the first paint, so the splash stays visible
    // until the shell is actually ready (and there is no white flash).
    show: false,
    ...overlay,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // The renderer owns the whole menu (⋮ dropdown), so no native menu bar.
  win.setMenuBarVisibility(false);

  // First paint: swap the splash for the real window. The timer is the safety
  // net for a renderer that never reports a paint (or a load error).
  const reveal = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
    hideSplash();
  }, SPLASH_REVEAL_MS);
  reveal.unref?.();
  win.once('ready-to-show', () => {
    clearTimeout(reveal);
    if (!win || win.isDestroyed()) return;
    win.show();
    hideSplash();
  });

  const saveBounds = (): void => {
    if (win && !win.isMinimized()) writeSettings({ window: win.getBounds() });
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('close', saveBounds);
  // Coming back to the window: refresh the drive list/space right away.
  win.on('focus', () => void pollDrives());
  // "minimize to tray": closing the window keeps the app alive in the tray.
  win.on('close', (e) => {
    if (!isQuitting && readSettings()['minimizeToTray'] === true) {
      e.preventDefault();
      win?.hide();
    }
  });
  // The window is gone: drop the reference (the tray can recreate it) and make
  // sure the scan workers stop instead of pushing events to a dead window.
  win.on('closed', () => {
    win = null;
    stopScan();
    stopDupes();
    stopWatch();
  });
  // forward renderer console to the terminal (diagnostics)
  win.webContents.on('console-message', (...args: any[]) => {
    const d = args[0];
    const msg = d && typeof d === 'object' && 'message' in d ? (d as any).message : args[2];
    log('[renderer] ' + msg);
  });

  const devUrl = process.env['FS_DEV_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'driversize', 'browser', 'index.html'));
  }
}

// ---- drives ---------------------------------------------------------------
function clusterSizeFor(p: string): number {
  try {
    const s = fs.statfsSync(p);
    return Number(s.bsize) || 4096;
  } catch {
    return 4096;
  }
}

/** Non-recursive listing of a folder (fast on-demand view, used when selecting a
 *  folder that is not part of the scanned tree). */
function listOnce(dir: string): FsEntry[] {
  const cluster = clusterSizeFor(dir);
  const out: FsEntry[] = [];
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const de of ents) {
    const full = path.join(dir, de.name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const isDir = st.isDirectory();
    const size = isDir ? 0 : st.size;
    out.push({
      path: full,
      parent: dir,
      name: de.name,
      isDir,
      size,
      allocated: isDir ? 0 : Math.ceil(size / cluster) * cluster,
      mtime: st.mtimeMs,
      atime: st.atimeMs,
      ctime: st.birthtimeMs,
      attrs: (isDir ? 0x10 : 0) | ((st.mode & 0o222) === 0 ? 0x01 : 0),
    });
  }
  return out;
}

/** Shell folders offered by the sidebar (Downloads, Documents, …). */
function knownFolders(): { id: string; path: string }[] {
  const ids = ['downloads', 'documents', 'desktop', 'videos', 'pictures', 'music'] as const;
  const out: { id: string; path: string }[] = [];
  for (const id of ids) {
    try {
      out.push({ id, path: app.getPath(id) });
    } catch {
      /* not available on this platform */
    }
  }
  return out;
}

/**
 * The same drive list, read asynchronously. Used by the watcher so a slow or
 * unreachable letter (a detached network drive, an empty card reader) can never
 * block the main process while the letters are being probed.
 */
async function listDrivesAsync(): Promise<DriveInfo[]> {
  const roots: string[] = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) roots.push(String.fromCharCode(c) + ':\\');
  } else {
    roots.push('/');
  }
  const out: DriveInfo[] = [];
  await Promise.all(
    roots.map(async (root) => {
      try {
        const s = await fs.promises.statfs(root);
        const bsize = Number(s.bsize) || 4096;
        const total = Number(s.blocks) * bsize;
        const free = Number(s.bavail) * bsize;
        if (!total) return;
        out.push({ root, label: root.slice(0, 2), total, free, used: total - free, clusterSize: bsize });
      } catch {
        /* no media, not ready or no such letter */
      }
    }),
  );
  out.sort((a, b) => a.root.localeCompare(b.root));
  return out;
}

// ---- plug-and-play drives (pendrive / external disk) ---------------------
// Electron has no "volume mounted" event, so the letters are polled. A pendrive
// or external disk shows up (or goes away) within a couple of seconds and the
// renderer refreshes the sidebar and the "Este computador" panel.
const DRIVE_POLL_MS = 3000;
let driveTimer: NodeJS.Timeout | null = null;
let drivePolling = false;
let drivesKey = '';
let drivesRoots: string[] = [];

function drivesSignature(list: DriveInfo[]): string {
  // Root + capacity: a letter appearing/disappearing, or a volume of another
  // size being mounted on the same letter, is a change worth reporting.
  return list.map((d) => `${d.root}:${d.total}:${d.used}`).join(';');
}

async function pollDrives(): Promise<void> {
  if (drivePolling) return; // a slow probe is still running: skip this tick
  drivePolling = true;
  try {
    const list = await listDrivesAsync();
    const key = drivesSignature(list);
    if (key === drivesKey) return;
    const previous = drivesRoots;
    drivesKey = key;
    drivesRoots = list.map((d) => d.root);
    if (!previous.length) return; // first reading: it is the baseline
    send('drives:changed', {
      drives: list,
      added: drivesRoots.filter((r) => !previous.includes(r)),
      removed: previous.filter((r) => !drivesRoots.includes(r)),
    });
  } finally {
    drivePolling = false;
  }
}

function startDriveWatch(): void {
  void pollDrives();
  if (driveTimer) clearInterval(driveTimer);
  driveTimer = setInterval(() => void pollDrives(), DRIVE_POLL_MS);
}

// ---- scan orchestration ---------------------------------------------------
function dispatch(w: Worker): void {
  if (queue.length > 0) {
    w.postMessage({ cmd: 'scan', dir: queue.shift()! });
  } else {
    w.postMessage({ cmd: 'exit' });
    outstanding--;
    if (outstanding === 0) finish();
  }
}

function onWorkerMessage(w: Worker, msg: any): void {
  // A worker may deliver a queued message right after a cancel/close.
  if (!scanning) return;
  switch (msg.type) {
    case 'boot':
      dispatch(w);
      break;
    case 'batch':
      send('scan:batch', msg.entries as FsEntry[]);
      break;
    case 'progress':
      send('scan:progress', { ...totals, ...msg, type: undefined });
      // Which folder is being walked right now: the workers tick every 200 ms,
      // so the status bar can follow the scan into subfolders. Throttled here so
      // several workers do not flood the renderer.
      if (typeof msg.dir === 'string' && msg.dir) {
        const now = Date.now();
        if (msg.dir !== lastScanDir && now - lastScanDirAt > 120) {
          lastScanDir = msg.dir;
          lastScanDirAt = now;
          send('scan:current', msg.dir);
        }
      }
      break;
    case 'ready':
      totals.files += msg.files;
      totals.folders += msg.folders;
      totals.bytes += msg.bytes;
      send('scan:progress', { ...totals, type: undefined });
      dispatch(w);
      break;
  }
}

function finish(): void {
  scanning = false;
  for (const w of workers) void w.terminate();
  workers = [];
  taskbarProgress(-1);
  send('scan:done', { ...totals, elapsedMs: Date.now() - startedAt });
  if (currentRoot) startWatch(currentRoot);
}

function startScan(root: string): { ok: boolean; error?: string } {
  if (scanning) return { ok: false, error: T().errBusy };
  scanning = true;
  taskbarProgress(2); // indeterminate: the total is unknown before walking the tree
  startedAt = Date.now();
  totals = { files: 0, folders: 0, bytes: 0 };
  lastScanDir = root;
  lastScanDirAt = Date.now();
  send('scan:current', root);
  Atomics.store(cancelFlag, 0, 0);
  queue = [];
  stopWatch();
  currentRoot = root;

  const cluster = clusterSizeFor(root);
  const excludes = readExcludes();
  const isExcluded = makeExcluder(excludes);

  // root's direct children are enumerated by the main process; subdirectories are
  // queued to workers (one work item per subfolder).
  let rootEnts: fs.Dirent[] = [];
  try {
    rootEnts = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    scanning = false;
    taskbarProgress(-1);
    return { ok: false, error: fill(T().errCannotRead, { path: root, msg: (e as Error).message }) };
  }
  const rootBatch: FsEntry[] = [];
  for (const de of rootEnts) {
    const full = path.join(root, de.name);
    if (isExcluded(full, de.name)) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const isDir = st.isDirectory();
    const size = isDir ? 0 : st.size;
    const allocated = isDir ? 0 : allocBytes(st, size, cluster);
    if (isDir) {
      totals.folders++;
      queue.push(full);
    } else {
      totals.files++;
      totals.bytes += size;
    }
    rootBatch.push({
      path: full,
      parent: root,
      name: de.name,
      isDir,
      size,
      allocated,
      mtime: st.mtimeMs,
      atime: st.atimeMs,
      ctime: st.birthtimeMs,
      attrs: (isDir ? 0x10 : 0) | ((st.mode & 0o222) === 0 ? 0x01 : 0),
    });
  }
  send('scan:batch', rootBatch);

  if (queue.length === 0) {
    finish();
    return { ok: true };
  }

  const n = Math.max(1, Math.min(queue.length, Math.max(2, os.cpus().length)));
  workers = [];
  outstanding = n;
  for (let i = 0; i < n; i++) {
    const w = new Worker(path.join(__dirname, 'scanner', 'worker.js'), {
      workerData: { cluster, control, batchSize: 500, exclude: excludes },
    });
    w.on('message', (m) => onWorkerMessage(w, m));
    w.on('error', (e) => {
      if (scanning) send('scan:error', String(e));
    });
    workers.push(w);
  }
  return { ok: true };
}

function cancelScan(): void {
  stopScan();
  taskbarProgress(-1);
  send('scan:done', { ...totals, elapsedMs: Date.now() - startedAt, cancelled: true });
  if (currentRoot) startWatch(currentRoot);
}

/**
 * Aborts the running scan without talking to the renderer. Used when the window
 * (or the app) goes away: the worker threads must not outlive the UI, and no
 * message may be sent to a window that no longer exists.
 */
function stopScan(): void {
  scanning = false;
  queue = [];
  outstanding = 0;
  Atomics.store(cancelFlag, 0, 1);
  for (const w of workers) {
    w.removeAllListeners('message');
    w.removeAllListeners('error');
    w.removeAllListeners('exit');
    void w.terminate();
  }
  workers = [];
}

// ---- duplicate finder (hash worker) ---------------------------------------
// The renderer sends the files whose size repeats; the worker hashes them in
// two passes (partial then full) and streams back the identical groups.
interface DupeFile {
  path: string;
  size: number;
}
let dupeWorker: Worker | null = null;
let dupeControl: SharedArrayBuffer | null = null;

function stopDupes(): void {
  taskbarProgress(-1);
  if (dupeControl) {
    try {
      Atomics.store(new Int32Array(dupeControl), 0, 1);
    } catch {
      /* already detached */
    }
  }
  if (dupeWorker) {
    dupeWorker.removeAllListeners();
    void dupeWorker.terminate();
    dupeWorker = null;
  }
  dupeControl = null;
}

function startDupes(files: DupeFile[]): { ok: boolean; error?: string } {
  stopDupes();
  if (!files.length) return { ok: true };
  taskbarProgress(2);
  dupeControl = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(dupeControl), 0, 0);
  const control = dupeControl;
  let w: Worker;
  try {
    w = new Worker(path.join(__dirname, 'dupes', 'worker.js'), { workerData: { files, control } });
  } catch (e) {
    dupeControl = null;
    return { ok: false, error: String(e) };
  }
  dupeWorker = w;
  w.on('message', (m: { type?: string; phase?: string; done?: number; total?: number }) => {
    if (m.type === 'progress') {
      send('dupes:progress', m);
      const total = Number(m.total) || 0;
      const done = Number(m.done) || 0;
      if (total > 0) {
        const frac = Math.min(1, done / total);
        taskbarProgress(m.phase === 'full' ? 0.45 + frac * 0.55 : frac * 0.45);
      }
    } else if (m.type === 'done') {
      taskbarProgress(-1);
      send('dupes:done', m);
      w.removeAllListeners();
      void w.terminate();
      if (dupeWorker === w) {
        dupeWorker = null;
        dupeControl = null;
      }
    }
  });
  w.on('error', (e) => {
    taskbarProgress(-1);
    send('dupes:error', String(e));
    if (dupeWorker === w) {
      dupeWorker = null;
      dupeControl = null;
    }
  });
  return { ok: true };
}

// ---- safe cleanup ---------------------------------------------------------
// Known locations that accumulate junk. Sizes are measured in the background
// (the list is filled in progressively) and nothing is deleted without an
// explicit confirmation from the renderer.
type CleanKind = 'temp' | 'update' | 'recycle' | 'downloads' | 'cache' | 'thumbs' | 'hiberfil';
type CleanState = 'pending' | 'measuring' | 'ready' | 'denied' | 'cleared' | 'error';

interface CleanTarget {
  id: string;
  kind: CleanKind;
  paths: string[];
  needsAdmin: boolean;
  viaRecycle: boolean;
  olderThanDays?: number;
  infoOnly?: boolean;
  size: number;
  files: number;
  state: CleanState;
}

const CLEAN_MAX_FILES = 400_000;
let cleanCancelled = false;
let cleanRunning = false;
const execFileP = promisify(execFile);

function localAppData(...parts: string[]): string {
  const base = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, ...parts);
}

/** Cache folders of the Chromium browsers and Firefox that exist on this machine. */
function browserCacheRoots(): string[] {
  const roots: string[] = [];
  const userData = (vendor: string, name: string): string => localAppData(vendor, name, 'User Data');
  for (const [vendor, name] of [
    ['Google', 'Chrome'],
    ['Microsoft', 'Edge'],
    ['BraveSoftware', 'Brave-Browser'],
  ] as [string, string][]) {
    const base = userData(vendor, name);
    let profiles: string[] = [];
    try {
      profiles = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (/^Default$/.test(d.name) || /^Profile \d+$/.test(d.name)))
        .map((d) => path.join(base, d.name));
    } catch {
      continue;
    }
    for (const profile of profiles) {
      for (const rel of ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')]) {
        const p = path.join(profile, rel);
        try {
          if (fs.statSync(p).isDirectory()) roots.push(p);
        } catch {
          /* not present */
        }
      }
    }
  }
  try {
    const ff = localAppData('Mozilla', 'Firefox', 'Profiles');
    for (const d of fs.readdirSync(ff, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(ff, d.name, 'cache2');
      try {
        if (fs.statSync(p).isDirectory()) roots.push(p);
      } catch {
        /* not present */
      }
    }
  } catch {
    /* no Firefox */
  }
  return roots;
}

function buildCleanTargets(): CleanTarget[] {
  const list: CleanTarget[] = [
    {
      id: 'userTemp',
      kind: 'temp',
      paths: [os.tmpdir()],
      needsAdmin: false,
      viaRecycle: false,
      size: 0,
      files: 0,
      state: 'pending',
    },
  ];
  const sysRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const winTemp = path.join(sysRoot, 'Temp');
  if (fs.existsSync(winTemp)) {
    list.push({ id: 'winTemp', kind: 'temp', paths: [winTemp], needsAdmin: true, viaRecycle: false, size: 0, files: 0, state: 'pending' });
  }
  const wuCache = path.join(sysRoot, 'SoftwareDistribution', 'Download');
  if (fs.existsSync(wuCache)) {
    list.push({ id: 'updateCache', kind: 'update', paths: [wuCache], needsAdmin: true, viaRecycle: false, size: 0, files: 0, state: 'pending' });
  }
  list.push({
    id: 'recycle',
    kind: 'recycle',
    paths: [`${process.env['SystemDrive'] ?? 'C:'}\\$Recycle.Bin`],
    needsAdmin: false,
    viaRecycle: false,
    size: 0,
    files: 0,
    state: 'pending',
  });
  list.push({
    id: 'downloadsOld',
    kind: 'downloads',
    paths: [app.getPath('downloads')],
    needsAdmin: false,
    viaRecycle: true,
    olderThanDays: 90,
    size: 0,
    files: 0,
    state: 'pending',
  });
  const caches = browserCacheRoots();
  if (caches.length) {
    list.push({ id: 'browserCache', kind: 'cache', paths: caches, needsAdmin: false, viaRecycle: false, size: 0, files: 0, state: 'pending' });
  }
  const explorer = localAppData('Microsoft', 'Windows', 'Explorer');
  if (fs.existsSync(explorer)) {
    list.push({ id: 'thumbnails', kind: 'thumbs', paths: [explorer], needsAdmin: false, viaRecycle: false, size: 0, files: 0, state: 'pending' });
  }
  const hiberfil = `${process.env['SystemDrive'] ?? 'C:'}\\hiberfil.sys`;
  if (fs.existsSync(hiberfil)) {
    list.push({
      id: 'hibernation',
      kind: 'hiberfil',
      paths: [hiberfil],
      needsAdmin: true,
      viaRecycle: false,
      infoOnly: true,
      size: 0,
      files: 0,
      state: 'pending',
    });
  }
  return list;
}

const THUMB_RE = /^(thumbcache|iconcache)_.*\.(db|json)$/i;

/** Walks a folder summing files (optionally only recent/old ones or matching a name). */
async function measureDir(
  root: string,
  opts: { olderThanMs?: number; onlyNames?: RegExp },
): Promise<{ size: number; files: number; denied: boolean }> {
  let size = 0;
  let files = 0;
  let denied = false;
  let seen = 0;
  const stack: string[] = [root];
  while (stack.length) {
    if (cleanCancelled || seen > CLEAN_MAX_FILES) break;
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      denied = true;
      continue;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      seen++;
      if (opts.onlyNames && !opts.onlyNames.test(e.name)) continue;
      try {
        const st = await fs.promises.stat(full);
        if (opts.olderThanMs && Date.now() - st.mtimeMs < opts.olderThanMs) continue;
        size += st.size;
        files++;
      } catch {
        denied = true;
      }
    }
  }
  return { size, files, denied };
}

/** Deletes the contents of a folder, tolerating files that are in use. */
async function purgeDir(dir: string, onlyNames?: RegExp): Promise<{ size: number; files: number; errors: number }> {
  let size = 0;
  let files = 0;
  let errors = 0;
  let ents: fs.Dirent[];
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { size, files, errors: 1 };
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = await purgeDir(full);
      size += r.size;
      files += r.files;
      errors += r.errors;
      try {
        await fs.promises.rmdir(full);
      } catch {
        /* still in use: keep the folder */
      }
      continue;
    }
    if (onlyNames && !onlyNames.test(e.name)) continue;
    let st: fs.Stats | null = null;
    try {
      st = await fs.promises.stat(full);
    } catch {
      st = null;
    }
    try {
      await fs.promises.unlink(full);
      size += st?.size ?? 0;
      files++;
    } catch {
      errors++;
    }
  }
  return { size, files, errors };
}

async function measureTarget(t: CleanTarget): Promise<void> {
  t.state = 'measuring';
  send('clean:target', { id: t.id, size: t.size, files: t.files, state: t.state });
  if (t.kind === 'hiberfil') {
    try {
      const st = await fs.promises.stat(t.paths[0]);
      t.size = st.size;
      t.files = 1;
      t.state = 'ready';
    } catch {
      t.state = 'denied';
    }
  } else {
    const older = t.olderThanDays ? t.olderThanDays * 86_400_000 : undefined;
    const only = t.kind === 'thumbs' ? THUMB_RE : undefined;
    let size = 0;
    let files = 0;
    let denied = false;
    for (const p of t.paths) {
      if (cleanCancelled) break;
      const r = await measureDir(p, { olderThanMs: older, onlyNames: only });
      size += r.size;
      files += r.files;
      denied = denied || r.denied;
    }
    if (cleanCancelled) return;
    t.size = size;
    t.files = files;
    t.state = size > 0 || files > 0 ? 'ready' : denied ? 'denied' : 'cleared';
  }
  send('clean:target', { id: t.id, size: t.size, files: t.files, state: t.state });
}

async function runCleanScan(): Promise<void> {
  if (cleanRunning) return;
  cleanRunning = true;
  cleanCancelled = false;
  taskbarProgress(2);
  const targets = buildCleanTargets();
  send('clean:start', targets.map((t) => ({ id: t.id, needsAdmin: t.needsAdmin, infoOnly: !!t.infoOnly, state: t.state })));
  for (const t of targets) {
    if (cleanCancelled) break;
    await measureTarget(t);
  }
  cleanRunning = false;
  taskbarProgress(-1);
  send('clean:done', { cancelled: cleanCancelled, deleted: false });
}

/** Writes a JSON record of a cleanup run (next to the settings) and returns its path. */
function writeCleanupLog(ids: string[], freed: number, files: number, errors: number): string | null {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const stamp =
      `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_` +
      `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    const file = path.join(dir, `cleanup-${stamp}.json`);
    const body = {
      at: d.toISOString(),
      app: APP_NAME,
      version: app.getVersion(),
      targets: ids,
      freed,
      files,
      errors,
    };
    fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

async function runCleanDelete(ids: string[]): Promise<{ freed: number; files: number; errors: number; log: string | null }> {
  taskbarProgress(2);
  const wanted = new Set(ids);
  const targets = buildCleanTargets().filter((t) => wanted.has(t.id) && !t.infoOnly);
  let freed = 0;
  let files = 0;
  let errors = 0;
  for (const t of targets) {
    send('clean:target', { id: t.id, size: t.size, files: t.files, state: 'measuring' });
    if (t.kind === 'recycle') {
      try {
        await execFileP('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Clear-RecycleBin -Force -ErrorAction SilentlyContinue; exit 0',
        ], { timeout: 180_000, windowsHide: true });
      } catch {
        errors++;
      }
      send('clean:target', { id: t.id, size: 0, files: 0, state: 'cleared' });
      continue;
    }
    if (t.kind === 'downloads') {
      const older = (t.olderThanDays ?? 90) * 86_400_000;
      const found: string[] = [];
      const collect = async (dir: string): Promise<void> => {
        let ents: fs.Dirent[];
        try {
          ents = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          errors++;
          return;
        }
        for (const e of ents) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await collect(full);
            continue;
          }
          if (!e.isFile()) continue;
          try {
            const st = await fs.promises.stat(full);
            if (Date.now() - st.mtimeMs >= older) found.push(full);
          } catch {
            errors++;
          }
        }
      };
      for (const p of t.paths) await collect(p);
      for (const f of found) {
        let st: fs.Stats | null = null;
        try {
          st = await fs.promises.stat(f);
        } catch {
          st = null;
        }
        try {
          await shell.trashItem(f);
          freed += st?.size ?? 0;
          files++;
        } catch {
          errors++;
        }
      }
      send('clean:target', { id: t.id, size: 0, files: 0, state: 'cleared' });
      continue;
    }
    let size = 0;
    let count = 0;
    let failed = 0;
    for (const p of t.paths) {
      const r = t.kind === 'thumbs' ? await purgeDir(p, THUMB_RE) : await purgeDir(p);
      size += r.size;
      count += r.files;
      failed += r.errors;
    }
    freed += size;
    files += count;
    errors += failed;
    send('clean:target', { id: t.id, size: 0, files: 0, state: 'cleared' });
  }
  const log = writeCleanupLog(ids, freed, files, errors);
  const lastCleanup = { at: Date.now(), freed, files, errors, log };
  writeSettings({ lastCleanup });
  send('clean:done', { cancelled: false, deleted: true, freed, files, errors, log });
  taskbarProgress(-1);
  return { freed, files, errors, log };
}

// ---- real-time monitoring (fs.watch) --------------------------------------
// Watch the scanned root recursively; batch bursts of changes and notify the
// renderer so it can offer a "rescan" instead of rescanning automatically.
let watcher: fs.FSWatcher | null = null;
let watchDebounce: NodeJS.Timeout | null = null;
let changedPaths = new Set<string>();
let monitorEnabled = true;

function stopWatch(): void {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
  changedPaths = new Set();
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
}

function flushChanges(): void {
  watchDebounce = null;
  if (!changedPaths.size) return;
  const paths = [...changedPaths];
  changedPaths = new Set();
  log('[watch] ' + paths.length + ' alteracao(oes) detectada(s)');
  send('fs:changed', { count: paths.length, paths: paths.slice(0, 50), at: Date.now() });
}

function startWatch(root: string): void {
  stopWatch();
  if (!monitorEnabled) return;
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, filename) => {
      changedPaths.add(filename ? path.join(root, filename.toString()) : root);
      if (!watchDebounce) watchDebounce = setTimeout(flushChanges, 600);
    });
    watcher.on('error', () => stopWatch());
    log('[watch] monitorando ' + root);
  } catch {
    watcher = null; // e.g. unsupported filesystem -> silently disable
    log('[watch] indisponivel para ' + root);
  }
}

// ---- export ---------------------------------------------------------------
function toCsv(rows: FsEntry[]): string {
  const esc = (v: string) => '"' + v.replace(/"/g, '""') + '"';
  const head = 'Name,Path,Type,Size,Allocated,Modified';
  const body = rows
    .map((r) =>
      [esc(r.name), esc(r.path), r.isDir ? 'Folder' : 'File', String(r.size), String(r.allocated), new Date(r.mtime).toISOString()].join(','),
    )
    .join('\r\n');
  return head + '\r\n' + body;
}

function toXml(rows: FsEntry[], root: string): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // XML attribute names: fo/s(note: s=size), n(name), a(allocated), at(attributes), m(modified)
  const lines = rows.map((r) => {
    const at = r.isDir ? 16 : 0;
    return `  <fo at="${at}" s="${r.size}" a="${r.allocated}" m="${new Date(r.mtime).toISOString()}"><n><![CDATA[${r.name}]]></n><p><![CDATA[${esc(r.path)}]]></p></fo>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<fs root="${esc(root)}" count="${rows.length}">\n${lines.join('\n')}\n</fs>\n`;
}

/** Render HTML in a hidden window and hand it to the OS print dialog. */
async function printHtml(html: string): Promise<boolean> {
  const tmp = path.join(os.tmpdir(), `driversize-print-${Date.now()}.html`);
  try {
    await fs.promises.writeFile(tmp, html, 'utf8');
  } catch {
    return false;
  }
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const cleanup = (): void => {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (!printer.isDestroyed()) printer.destroy();
  };
  printer.webContents.once('did-finish-load', () => {
    printer.webContents.print({ silent: false, printBackground: true }, () => cleanup());
    // safety net in case the print callback never fires (dialog dismissed by the OS)
    setTimeout(() => {
      if (!printer.isDestroyed()) cleanup();
    }, 120000);
  });
  try {
    await printer.loadFile(tmp);
  } catch {
    cleanup();
    return false;
  }
  return true;
}

// ---- IPC ------------------------------------------------------------------
/** Show the OS Properties dialog for a path via the shell verb. */
function showProperties(p: string): void {
  const dir = path.dirname(p);
  const name = path.basename(p);
  const q = (s: string) => s.replace(/'/g, "''");
  const ps =
    `$ErrorActionPreference='SilentlyContinue';` +
    `$sh=New-Object -ComObject Shell.Application;` +
    `$f=$sh.Namespace('${q(dir)}');` +
    `$i=$f.ParseName('${q(name)}');` +
    `if($i){$i.InvokeVerb('Properties')}`;
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* ignore */
  }
}

/** Native addon (IContextMenu) — the full Windows shell context menu. */
let shellMenuModule: { showContextMenu(hwnd: Buffer, paths: string[]): boolean } | null | undefined;
function getShellMenu(): { showContextMenu(hwnd: Buffer, paths: string[]): boolean } | null {
  if (shellMenuModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      shellMenuModule = require(path.join(__dirname, '..', 'native', 'shellmenu', 'build', 'Release', 'shellmenu.node'));
    } catch {
      shellMenuModule = null;
    }
  }
  return shellMenuModule ?? null;
}

function openWith(p: string): void {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  try {
    spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', p], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* ignore */
  }
}

/** Native right-click menu for one or more files/folders (Explorer-like). */
function showItemContextMenu(win: BrowserWindow, paths: string[]): void {
  const t = T();
  const count = paths.length;
  const single = count === 1;
  const p = paths[0];
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: single ? t.mnOpen : fill(t.mnOpenN, { n: count }),
      click: () => paths.forEach((x) => void shell.openPath(x)),
    },
  ];
  if (single) items.push({ label: t.mnOpenWith, click: () => openWith(p) });
  items.push({ type: 'separator' });
  items.push({ label: t.mnReveal, click: () => paths.forEach((x) => shell.showItemInFolder(x)) });
  items.push({
    label: single ? t.mnCopyPath : fill(t.mnCopyPaths, { n: count }),
    click: () => clipboard.writeText(paths.join('\r\n')),
  });
  items.push({ type: 'separator' });
  if (single) items.push({ label: t.mnRename, click: () => send('shell:askRename', { path: p, name: path.basename(p) }) });
  items.push({
    label: single ? t.mnDeleteOne : fill(t.mnDeleteMany, { n: count }),
    click: () => {
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          buttons: [t.dlgCancel, t.dlgDelete],
          defaultId: 0,
          cancelId: 0,
          message: single ? t.dlgDeleteOne : fill(t.dlgDeleteMany, { n: count }),
          detail: single ? p : paths.slice(0, 10).join('\n') + (count > 10 ? `\n… (+${count - 10})` : ''),
        })
        .then(async (r) => {
          if (r.response !== 1) return;
          for (const x of paths) {
            try {
              await shell.trashItem(x);
              send('shell:deleted', x);
            } catch {
              /* ignore */
            }
          }
        });
    },
  });
  items.push({ type: 'separator' });
  items.push({ label: t.mnProperties, click: () => paths.forEach((x) => showProperties(x)) });

  const shellMenu = getShellMenu();
  if (shellMenu) {
    items.push({ type: 'separator' });
    items.push({
      label: t.mnFullShell,
      click: () => {
        try {
          shellMenu.showContextMenu(win.getNativeWindowHandle(), paths);
        } catch {
          /* ignore */
        }
      },
    });
  }

  Menu.buildFromTemplate(items).popup({ window: win });
}

function registerIpc(): void {
  ipcMain.handle('fs:listDrives', async () => {
    // Seed the watcher baseline: the renderer starts from exactly this list.
    const list = await listDrivesAsync();
    drivesKey = drivesSignature(list);
    drivesRoots = list.map((d) => d.root);
    return list;
  });
  ipcMain.handle('app:knownFolders', () => knownFolders());
  ipcMain.handle('app:quit', () => {
    isQuitting = true;
    app.quit();
    return true;
  });
  /** The ⋮ menu definition (labels come from the main-process dictionaries). */
  ipcMain.handle('menu:tree', () => menuTree());
  ipcMain.handle('fs:listOnce', (_e, dir: string) => listOnce(dir));
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_e, patch: Record<string, unknown>) => writeSettings(patch ?? {}));
  // Theme switch: repaint the window background and the native caption buttons
  // (they are drawn by Windows, outside the renderer, so CSS cannot reach them).
  ipcMain.handle('app:theme', (_e, value: unknown) => {
    const dark = value === 'dark';
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(dark ? '#15171a' : '#f1f3f4');
      try {
        win.setTitleBarOverlay({
          color: dark ? '#1e2126' : '#ffffff',
          symbolColor: dark ? '#e7e9ec' : '#202124',
          height: TITLEBAR_HEIGHT,
        });
      } catch {
        /* platform without a title bar overlay */
      }
    }
    return true;
  });
  // "Inspect element": the renderer sends the page coordinates of the picked
  // element; Electron opens DevTools (if needed) and selects that node.
  ipcMain.handle('app:inspect', (_e, point: { x: number; y: number }) => {
    if (!win || win.isDestroyed()) return false;
    const x = Math.max(0, Math.round(Number(point?.x) || 0));
    const y = Math.max(0, Math.round(Number(point?.y) || 0));
    win.webContents.inspectElement(x, y);
    return true;
  });
  ipcMain.handle('shell:contextMenu', (e, payload: { paths: string[] }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || !payload.paths.length) return false;
    // Default: show the real Windows shell menu directly.
    const sm = getShellMenu();
    if (sm) {
      try {
        sm.showContextMenu(w.getNativeWindowHandle(), payload.paths);
        return true;
      } catch {
        /* fall through to the app menu */
      }
    }
    showItemContextMenu(w, payload.paths); // fallback when the native addon is unavailable
    return true;
  });
  ipcMain.handle('shell:open', (_e, p: string) => {
    void shell.openPath(p);
    return true;
  });
  // Reveal in Explorer ("Mostrar na pasta") — the window is opened by the shell,
  // so the app keeps its current folder and selection.
  ipcMain.handle('shell:showItem', (_e, p: string) => {
    try {
      shell.showItemInFolder(p);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('shell:delete', async (e, paths: string[]) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || !paths.length) return 0;
    const t = T();
    const r = await dialog.showMessageBox(w, {
      type: 'warning',
      buttons: [t.dlgCancel, t.dlgDelete],
      defaultId: 0,
      cancelId: 0,
      message: paths.length === 1 ? t.dlgDeleteOne : fill(t.dlgDeleteMany, { n: paths.length }),
      detail: paths.slice(0, 10).join('\n') + (paths.length > 10 ? `\n… (+${paths.length - 10})` : ''),
    });
    if (r.response !== 1) return 0;
    let n = 0;
    for (const p of paths) {
      try {
        await shell.trashItem(p);
        send('shell:deleted', p);
        n++;
      } catch {
        /* ignore */
      }
    }
    return n;
  });
  ipcMain.handle('shell:rename', async (_e, payload: { path: string; name: string }) => {
    const newPath = path.join(path.dirname(payload.path), payload.name);
    try {
      await fs.promises.rename(payload.path, newPath);
      send('shell:renamed', { from: payload.path, to: newPath });
      return { ok: true, path: newPath };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle('fs:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle('scan:start', (_e, root: string) => startScan(root));
  ipcMain.handle('scan:cancel', () => {
    cancelScan();
    return true;
  });
  ipcMain.handle('dupes:start', (_e, files: DupeFile[]) => startDupes(Array.isArray(files) ? files : []));
  ipcMain.handle('dupes:cancel', () => {
    stopDupes();
    return true;
  });
  ipcMain.handle('clean:scan', () => {
    void runCleanScan();
    return true;
  });
  ipcMain.handle('clean:cancel', () => {
    cleanCancelled = true;
    return true;
  });
  ipcMain.handle('clean:delete', (_e, ids: string[]) => runCleanDelete(Array.isArray(ids) ? ids : []));
  ipcMain.handle('clean:last', () => {
    const last = readSettings()['lastCleanup'];
    return last && typeof last === 'object' ? last : null;
  });
  ipcMain.handle('clean:openLog', (_e, file: unknown) => {
    if (typeof file !== 'string' || !file) return false;
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else {
      const dir = path.dirname(file);
      if (fs.existsSync(dir)) void shell.openPath(dir);
    }
    return true;
  });
  ipcMain.handle('export:csv', async (_e, payload: { root: string; rows: FsEntry[] }) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: 'driversize.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, toCsv(payload.rows), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('export:xml', async (_e, payload: { root: string; rows: FsEntry[] }) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: 'driversize.xml', filters: [{ name: 'XML', extensions: ['xml'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, toXml(payload.rows, payload.root), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('export:html', async (_e, payload: { root: string; html: string }) => {
    const name = (path.basename(payload.root.replace(/[\\/]+$/, '')) || 'driversize') + '-report.html';
    const r = await dialog.showSaveDialog(win!, { defaultPath: name, filters: [{ name: T().fltHtml, extensions: ['html'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, payload.html, 'utf8');
    return r.filePath;
  });
  // ---- menu-driven commands (see buildAppMenu) -----------------------------
  ipcMain.handle('session:save', async (_e, payload: { root: string; entries: unknown[] }) => {
    const base = path.basename(String(payload.root).replace(/[\\/]+$/, '')) || 'driversize';
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: base + '.fsjson',
      filters: [{ name: T().fltSession, extensions: ['fsjson', 'json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const body = { app: 'driversize', version: 1, root: payload.root, savedAt: new Date().toISOString(), entries: payload.entries };
    await fs.promises.writeFile(r.filePath, JSON.stringify(body), 'utf8');
    log('[menu] varredura salva em ' + r.filePath);
    return r.filePath;
  });
  ipcMain.handle('session:load', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: T().fltSession, extensions: ['fsjson', 'json'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    try {
      const text = fs.readFileSync(r.filePaths[0], 'utf8').replace(/^\uFEFF/, '');
      const s = JSON.parse(text) as { root?: unknown; entries?: unknown };
      if (typeof s?.root !== 'string' || !Array.isArray(s.entries)) return { ok: false, error: T().errBadSession };
      log('[menu] varredura carregada de ' + r.filePaths[0]);
      return { ok: true, root: s.root, entries: s.entries };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  ipcMain.handle('export:png', async (_e, payload: { suggested: string; dataUrl: string }) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: payload.suggested || 'driversize-chart.png',
      filters: [{ name: T().fltPng, extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const b64 = String(payload.dataUrl).replace(/^data:image\/png;base64,/, '');
    await fs.promises.writeFile(r.filePath, Buffer.from(b64, 'base64'));
    return r.filePath;
  });
  /** "Export As...": one dialog, the format follows the chosen extension. */
  ipcMain.handle('export:any', async (_e, payload: { root: string; rows: FsEntry[] }) => {
    const base = path.basename(String(payload.root).replace(/[\\/]+$/, '')) || 'driversize';
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: base + '.csv',
      filters: [
        { name: T().fltCsv, extensions: ['csv'] },
        { name: T().fltXml, extensions: ['xml'] },
      ],
    });
    if (r.canceled || !r.filePath) return null;
    const ext = path.extname(r.filePath).toLowerCase();
    if (ext === '.xml') await fs.promises.writeFile(r.filePath, toXml(payload.rows, payload.root), 'utf8');
    else await fs.promises.writeFile(r.filePath, toCsv(payload.rows), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('print:html', async (_e, payload: { html: string }) => printHtml(payload.html));
  ipcMain.on('menu:state', (_e, patch: { scanning?: boolean; unit?: string; driveInfo?: boolean; chart?: boolean; lang?: unknown }) => {
    syncMenuState(patch ?? {});
  });

  ipcMain.handle('watch:setEnabled', (_e, enabled: boolean) => {
    monitorEnabled = !!enabled;
    writeSettings({ monitorEnabled });
    if (!monitorEnabled) stopWatch();
    else if (currentRoot && !scanning) startWatch(currentRoot);
    return monitorEnabled;
  });
  ipcMain.handle('tray:setEnabled', (_e, enabled: boolean) => {
    writeSettings({ minimizeToTray: !!enabled });
    if (enabled) createTray();
    else destroyTray();
    return !!enabled;
  });
}

app.whenReady().then(() => {
  // The app UI is light, so keep the native title bar / menu bar light too
  // (light native chrome) instead of following the OS dark theme.
  nativeTheme.themeSource = 'light';
  // Publish the app version so the preload can hand it to the renderer's About box.
  process.env['FS_APP_VERSION'] = app.getVersion();
  log('[menu] dados do usuario: ' + app.getPath('userData'));
  log('[shellmenu] ' + (getShellMenu() ? 'addon carregado' : 'addon indisponivel'));
  // Temporary diagnostic: FS_DUMP_MENU="E:\" logs the Windows menu items of that path.
  const dbgMenu = process.env['FS_DUMP_MENU'];
  if (dbgMenu) {
    const sm = getShellMenu() as unknown as { dumpMenu?: (p: string) => string[] } | null;
    log('[dump] ' + JSON.stringify(sm?.dumpMenu?.(dbgMenu) ?? null));
  }
  monitorEnabled = readSettings()['monitorEnabled'] !== false;
  // Language + marks come from the persisted settings so the very first menu bar
  // is already correct (the renderer re-pushes them as soon as it is ready).
  const saved = readSettings();
  menuLang = resolveLang();
  if (typeof saved['sizeUnit'] === 'string') menuState.unit = saved['sizeUnit'];
  if (typeof saved['showDriveInfo'] === 'boolean') menuState.driveInfo = saved['showDriveInfo'];
  if (typeof saved['showChart'] === 'boolean') menuState.chart = saved['showChart'];
  log('[menu] idioma: ' + menuLang);
  log('[menu] ' + dumpMenu(menuTree()));
  Menu.setApplicationMenu(null); // the renderer draws the whole menu (⋮)
  registerIpc();
  showSplash();
  createWindow();
  startDriveWatch();
  if (readSettings()['minimizeToTray'] === true) createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  destroySplash();
  stopScan(); // no worker may outlive the app (and none may message a dead window)
  stopDupes();
  stopWatch();
});

app.on('window-all-closed', () => {
  destroySplash();
  stopScan();
  stopDupes();
  stopWatch();
  if (process.platform !== 'darwin') app.quit();
});

