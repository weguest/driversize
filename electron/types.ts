// Shared types for DriverSize (main + preload). Renderer keeps its own copy in src/app/models.ts
export interface FsEntry {
  path: string;
  parent: string;
  name: string;
  isDir: boolean;
  size: number;      // logical size in bytes (0 for directories; aggregates computed in UI)
  allocated: number; // bytes on disk (cluster-aligned) for files; 0 for directories
  mtime: number;     // ms since epoch (modified)
  atime: number;     // ms since epoch (accessed)
  ctime: number;     // ms since epoch (created / birth)
  attrs: number;     // best-effort Win32 attribute bits (Directory=0x10, ReadOnly=0x01)
}

export interface ScanTotals {
  files: number;
  folders: number;
  bytes: number;
}

export interface DriveInfo {
  root: string;
  label: string;
  total: number;
  free: number;
  used: number;
  clusterSize: number;
}

export interface WorkerData {
  cluster: number;
  control: SharedArrayBuffer;
  batchSize: number;
  /** Exclusion patterns from the settings (name globs or absolute paths). */
  exclude?: string[];
}

export type WorkerInbound = { cmd: 'scan'; dir: string } | { cmd: 'exit' };

export type WorkerOutbound =
  | { type: 'boot' }
  | { type: 'batch'; entries: FsEntry[] }
  | { type: 'progress'; files: number; folders: number; bytes: number; dir: string }
  | { type: 'ready'; files: number; folders: number; bytes: number };
