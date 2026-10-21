export {};

declare global {
  interface Window {
    driversize?: {
      getSettings(): Promise<Record<string, unknown>>;
      setSettings(patch: Record<string, unknown>): Promise<boolean>;
      setTheme(value: 'light' | 'dark'): Promise<boolean>;
      inspectElement(x: number, y: number): Promise<boolean>;
      autoscan: string | null;
      autofilter: string | null;
      filterDelay: number;
      appVersion: string;
      versions: { electron: string; chrome: string; node: string };
      listDrives(): Promise<unknown[]>;
      listOnce(dir: string): Promise<unknown[]>;
      knownFolders(): Promise<{ id: string; path: string }[]>;
      menuTree(): Promise<unknown[]>;
      quit(): Promise<boolean>;
      pickFolder(): Promise<string | null>;
      startScan(root: string): Promise<{ ok: boolean; error?: string }>;
      cancelScan(): Promise<boolean>;
      startDupes(files: { path: string; size: number }[]): Promise<{ ok: boolean; error?: string }>;
      cancelDupes(): Promise<boolean>;
      onDupeProgress(cb: (v: { phase: string; done: number; total: number }) => void): () => void;
      onDupesDone(cb: (v: unknown) => void): () => void;
      onDupesError(cb: (v: string) => void): () => void;
      cleanScan(): Promise<boolean>;
      cancelClean(): Promise<boolean>;
      cleanDelete(ids: string[]): Promise<{ freed: number; files: number; errors: number; log?: string | null }>;
      cleanLast(): Promise<{ at: number; freed: number; files: number; errors: number; log: string | null } | null>;
      openCleanLog(file: string): Promise<boolean>;
      onCleanStart(cb: (v: unknown[]) => void): () => void;
      onCleanTarget(cb: (v: unknown) => void): () => void;
      onCleanDone(cb: (v: unknown) => void): () => void;
      contextMenu(paths: string[]): Promise<boolean>;
      openPath(path: string): Promise<boolean>;
      showItem(path: string): Promise<boolean>;
      deletePaths(paths: string[]): Promise<number>;
      rename(path: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
      onAskRename(cb: (v: { path: string; name: string }) => void): () => void;
      onDeleted(cb: (path: string) => void): () => void;
      onRenamed(cb: (v: { from: string; to: string }) => void): () => void;
      exportCsv(root: string, rows: unknown[]): Promise<string | null>;
      exportXml(root: string, rows: unknown[]): Promise<string | null>;
      exportHtml(root: string, html: string): Promise<string | null>;
      exportAny(root: string, rows: unknown[]): Promise<string | null>;
      exportPng(suggested: string, dataUrl: string): Promise<string | null>;
      saveSession(root: string, entries: unknown[]): Promise<string | null>;
      loadSession(): Promise<{ ok: boolean; root?: string; entries?: unknown[]; error?: string } | null>;
      printHtml(html: string): Promise<boolean>;
      setMenuState(patch: Record<string, unknown>): void;
      onMenu(cb: (v: { cmd: string; arg?: unknown }) => void): () => void;
      setMonitorEnabled(enabled: boolean): Promise<boolean>;
      setTrayEnabled(enabled: boolean): Promise<boolean>;
      onChanged(cb: (v: { count: number; paths: string[]; at: number }) => void): () => void;
      onDrivesChanged(cb: (v: { drives: unknown[]; added: string[]; removed: string[] }) => void): () => void;
      onRescan(cb: (root: string) => void): () => void;
      onBatch(cb: (entries: unknown[]) => void): () => void;
      onProgress(cb: (p: unknown) => void): () => void;
      onCurrent(cb: (dir: string) => void): () => void;
      onDone(cb: (s: unknown) => void): () => void;
      onError(cb: (m: string) => void): () => void;
    };
  }
}
