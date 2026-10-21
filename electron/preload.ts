import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const api = {
  autoscan: process.env['FS_AUTOSCAN'] ?? null,
  autofilter: process.env['FS_FILTER'] ?? null,
  filterDelay: Number(process.env['FS_FILTER_DELAY'] ?? 2500),
  appVersion: process.env['FS_APP_VERSION'] ?? '',
  versions: {
    electron: process.versions['electron'] ?? '',
    chrome: process.versions['chrome'] ?? '',
    node: process.versions['node'] ?? '',
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  /** light | dark — also repaints the native caption buttons */
  setTheme: (v: string) => ipcRenderer.invoke('app:theme', v),
  inspectElement: (x: number, y: number) => ipcRenderer.invoke('app:inspect', { x, y }),
  listDrives: () => ipcRenderer.invoke('fs:listDrives'),
  listOnce: (dir: string) => ipcRenderer.invoke('fs:listOnce', dir),
  knownFolders: () => ipcRenderer.invoke('app:knownFolders'),
  menuTree: () => ipcRenderer.invoke('menu:tree'),
  quit: () => ipcRenderer.invoke('app:quit'),
  pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
  startScan: (root: string) => ipcRenderer.invoke('scan:start', root),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  startDupes: (files: { path: string; size: number }[]) => ipcRenderer.invoke('dupes:start', files),
  cancelDupes: () => ipcRenderer.invoke('dupes:cancel'),
  onDupeProgress: (cb: (v: { phase: string; done: number; total: number }) => void) => {
    const h = (_e: IpcRendererEvent, v: { phase: string; done: number; total: number }) => cb(v);
    ipcRenderer.on('dupes:progress', h);
    return () => ipcRenderer.off('dupes:progress', h);
  },
  onDupesDone: (cb: (v: unknown) => void) => {
    const h = (_e: IpcRendererEvent, v: unknown) => cb(v);
    ipcRenderer.on('dupes:done', h);
    return () => ipcRenderer.off('dupes:done', h);
  },
  onDupesError: (cb: (v: string) => void) => {
    const h = (_e: IpcRendererEvent, v: string) => cb(v);
    ipcRenderer.on('dupes:error', h);
    return () => ipcRenderer.off('dupes:error', h);
  },
  cleanScan: () => ipcRenderer.invoke('clean:scan'),
  cancelClean: () => ipcRenderer.invoke('clean:cancel'),
  cleanDelete: (ids: string[]) => ipcRenderer.invoke('clean:delete', ids),
  cleanLast: () => ipcRenderer.invoke('clean:last'),
  openCleanLog: (file: string) => ipcRenderer.invoke('clean:openLog', file),
  onCleanStart: (cb: (v: unknown[]) => void) => {
    const h = (_e: IpcRendererEvent, v: unknown[]) => cb(v);
    ipcRenderer.on('clean:start', h);
    return () => ipcRenderer.off('clean:start', h);
  },
  onCleanTarget: (cb: (v: unknown) => void) => {
    const h = (_e: IpcRendererEvent, v: unknown) => cb(v);
    ipcRenderer.on('clean:target', h);
    return () => ipcRenderer.off('clean:target', h);
  },
  onCleanDone: (cb: (v: unknown) => void) => {
    const h = (_e: IpcRendererEvent, v: unknown) => cb(v);
    ipcRenderer.on('clean:done', h);
    return () => ipcRenderer.off('clean:done', h);
  },
  contextMenu: (paths: string[]) => ipcRenderer.invoke('shell:contextMenu', { paths }),
  openPath: (p: string) => ipcRenderer.invoke('shell:open', p),
  showItem: (p: string) => ipcRenderer.invoke('shell:showItem', p),
  deletePaths: (paths: string[]) => ipcRenderer.invoke('shell:delete', paths),
  rename: (path: string, name: string) => ipcRenderer.invoke('shell:rename', { path, name }),
  onAskRename: (cb: (v: { path: string; name: string }) => void) => {
    const h = (_e: IpcRendererEvent, v: { path: string; name: string }) => cb(v);
    ipcRenderer.on('shell:askRename', h);
    return () => ipcRenderer.off('shell:askRename', h);
  },
  onDeleted: (cb: (path: string) => void) => {
    const h = (_e: IpcRendererEvent, p: string) => cb(p);
    ipcRenderer.on('shell:deleted', h);
    return () => ipcRenderer.off('shell:deleted', h);
  },
  onRenamed: (cb: (v: { from: string; to: string }) => void) => {
    const h = (_e: IpcRendererEvent, v: { from: string; to: string }) => cb(v);
    ipcRenderer.on('shell:renamed', h);
    return () => ipcRenderer.off('shell:renamed', h);
  },
  /** A drive was plugged in or removed (pendrive, external disk, mounted volume). */
  onDrivesChanged: (cb: (v: { drives: unknown[]; added: string[]; removed: string[] }) => void) => {
    const h = (_e: IpcRendererEvent, v: { drives: unknown[]; added: string[]; removed: string[] }) => cb(v);
    ipcRenderer.on('drives:changed', h);
    return () => ipcRenderer.off('drives:changed', h);
  },
  exportCsv: (root: string, rows: unknown[]) => ipcRenderer.invoke('export:csv', { root, rows }),
  exportXml: (root: string, rows: unknown[]) => ipcRenderer.invoke('export:xml', { root, rows }),
  exportHtml: (root: string, html: string) => ipcRenderer.invoke('export:html', { root, html }),
  /** "Export As..." — one save dialog, the extension picks CSV or XML. */
  exportAny: (root: string, rows: unknown[]) => ipcRenderer.invoke('export:any', { root, rows }),
  exportPng: (suggested: string, dataUrl: string) => ipcRenderer.invoke('export:png', { suggested, dataUrl }),
  saveSession: (root: string, entries: unknown[]) => ipcRenderer.invoke('session:save', { root, entries }),
  loadSession: () => ipcRenderer.invoke('session:load'),
  printHtml: (html: string) => ipcRenderer.invoke('print:html', { html }),
  /** Push the authoritative menu state (check/radio marks, "Stop Scan" enable). */
  setMenuState: (patch: Record<string, unknown>) => ipcRenderer.send('menu:state', patch),
  onMenu: (cb: (v: { cmd: string; arg?: unknown }) => void) => {
    const h = (_e: IpcRendererEvent, v: { cmd: string; arg?: unknown }) => cb(v);
    ipcRenderer.on('menu:action', h);
    return () => ipcRenderer.off('menu:action', h);
  },
  setMonitorEnabled: (enabled: boolean) => ipcRenderer.invoke('watch:setEnabled', enabled),
  setTrayEnabled: (enabled: boolean) => ipcRenderer.invoke('tray:setEnabled', enabled),
  onChanged: (cb: (v: unknown) => void) => {
    const h = (_e: IpcRendererEvent, v: unknown) => cb(v);
    ipcRenderer.on('fs:changed', h);
    return () => ipcRenderer.off('fs:changed', h);
  },
  onRescan: (cb: (root: string) => void) => {
    const h = (_e: IpcRendererEvent, root: string) => cb(root);
    ipcRenderer.on('app:rescan', h);
    return () => ipcRenderer.off('app:rescan', h);
  },
  onBatch: (cb: (entries: unknown[]) => void) => {
    const h = (_e: IpcRendererEvent, entries: unknown[]) => cb(entries);
    ipcRenderer.on('scan:batch', h);
    return () => ipcRenderer.off('scan:batch', h);
  },
  onProgress: (cb: (p: unknown) => void) => {
    const h = (_e: IpcRendererEvent, p: unknown) => cb(p);
    ipcRenderer.on('scan:progress', h);
    return () => ipcRenderer.off('scan:progress', h);
  },
  onCurrent: (cb: (dir: string) => void) => {
    const h = (_e: IpcRendererEvent, dir: string) => cb(dir);
    ipcRenderer.on('scan:current', h);
    return () => ipcRenderer.off('scan:current', h);
  },
  onDone: (cb: (s: unknown) => void) => {
    const h = (_e: IpcRendererEvent, s: unknown) => cb(s);
    ipcRenderer.on('scan:done', h);
    return () => ipcRenderer.off('scan:done', h);
  },
  onError: (cb: (m: string) => void) => {
    const h = (_e: IpcRendererEvent, m: string) => cb(m);
    ipcRenderer.on('scan:error', h);
    return () => ipcRenderer.off('scan:error', h);
  },
};

contextBridge.exposeInMainWorld('driversize', api);
