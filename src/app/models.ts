export interface FsEntry {
  path: string;
  parent: string;
  name: string;
  isDir: boolean;
  size: number;
  allocated: number;
  mtime: number;
  atime: number;
  ctime: number;
  attrs: number;
}

/** Filter model (masks, size, attributes and date dimensions). */
export interface FilterSpec {
  enabled: boolean;
  /** exclude mode (inverted match) */
  invert: boolean;
  includeFiles: boolean;
  includeFolders: boolean;

  /** name masks, separated by `maskSeparator` */
  masks: string;
  maskSeparator: string;

  sizeEnabled: boolean;
  sizeMode: 'gt' | 'lt' | 'between' | 'outside';
  sizeUnit: 'KB' | 'MB' | 'GB';
  sizeMinMB: number; // value expressed in sizeUnit
  sizeMaxMB: number;

  attrEnabled: boolean;
  attrMode: 'none' | 'all' | 'exact';
  attrMask: number; // Win32 attribute bits

  dateEnabled: boolean;
  dateField: 'created' | 'accessed' | 'modified';
  dateMode: 'before' | 'after' | 'between';
  dateFrom: string; // yyyy-mm-dd
  dateTo: string;   // yyyy-mm-dd
}

export const DEFAULT_FILTER: FilterSpec = {
  enabled: false,
  invert: false,
  includeFiles: true,
  includeFolders: true,
  masks: '',
  maskSeparator: ';',
  sizeEnabled: false,
  sizeMode: 'gt',
  sizeUnit: 'MB',
  sizeMinMB: 0,
  sizeMaxMB: 0,
  attrEnabled: false,
  attrMode: 'all',
  attrMask: 0,
  dateEnabled: false,
  dateField: 'modified',
  dateMode: 'after',
  dateFrom: '',
  dateTo: '',
};

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

export interface FolderNode {
  path: string;
  name: string;
  parent: string;
  size: number;
  allocated: number;
  files: number;
  folders: number;
  mtime: number;
  expanded: boolean;
  children: FolderNode[];
  childFiles: FsEntry[];
}

export type SizeUnit = 'auto' | 'B' | 'KB' | 'MB' | 'GB';

export type SortKey = 'name' | 'size' | 'allocated' | 'percent' | 'files' | 'folders' | 'modified' | 'items';

export interface PieSlice {
  label: string;
  size: number;
  percent: number;
  color: string;
  d: string;
}

/** Aggregated stats for one file extension (the "tipos de arquivo" panel). */
export interface TypeStat {
  /** lowercased extension without the dot; '' for files without extension */
  ext: string;
  label: string;
  files: number;
  bytes: number;
  percent: number;
  color: string;
}

export interface Row {
  path: string;
  name: string;
  kind: 'folder' | 'file';
  size: number;
  allocated: number;
  files: number;
  folders: number;
  mtime: number;
  /** Relative parent path (used in the filtered result list to disambiguate duplicates). */
  sub?: string;
  /** Number of direct children (folders only). */
  items?: number;
}

/** One hit of the global name search (modal "Busca global"). */
export interface FindHit {
  path: string;
  name: string;
  kind: 'folder' | 'file';
  size: number;
  allocated: number;
  mtime: number;
  parent: string;
}

/** Result of the last safe-cleanup run. */
export interface LastCleanup {
  at: number;
  freed: number;
  files: number;
  errors: number;
  log: string | null;
}

/** How the result list is rendered. */
export type ViewMode = 'list' | 'grid';

/** Sort presets offered by the toolbar combo. */
export type SortOption =
  | 'name-asc'
  | 'name-desc'
  | 'size-desc'
  | 'size-asc'
  | 'modified-desc'
  | 'modified-asc'
  | 'items-desc';

/**
 * Coarse file categories used by the "distribuição por tipo de arquivo" donut
 * and by the per-row "Tipo" column.
 */
export type CategoryId =
  | 'folders'
  | 'apps'
  | 'system'
  | 'archives'
  | 'models3d'
  | 'images'
  | 'videos'
  | 'audio'
  | 'documents'
  | 'code'
  | 'other';

/** Display order of the categories (matches the legend order). */
export const CATEGORY_IDS: readonly CategoryId[] = [
  'folders',
  'apps',
  'system',
  'archives',
  'models3d',
  'images',
  'videos',
  'audio',
  'documents',
  'code',
  'other',
];

const CATEGORY_EXT: Record<Exclude<CategoryId, 'folders' | 'other'>, readonly string[]> = {
  apps: ['exe', 'msi', 'bat', 'cmd', 'com', 'appx', 'msix', 'apk', 'dmg', 'appimage', 'deb', 'rpm', 'lnk'],
  system: ['dll', 'sys', 'drv', 'ocx', 'cpl', 'mui', 'cat', 'inf', 'pdb', 'so', 'dylib', 'efi', 'vxd', 'nls'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'lz', 'lzma', 'zst', 'br', 'iso', 'cab', 'jar', 'war', 'wim', 'img', 'arj'],
  models3d: ['stl', 'obj', '3mf', 'fbx', 'dae', 'ply', 'step', 'stp', 'iges', 'igs', 'blend', 'gltf', 'glb', '3ds', 'max', 'skp', 'gcode'],
  images: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'ico', 'heic', 'avif', 'psd', 'raw', 'cr2', 'nef', 'ai', 'eps'],
  videos: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'vob', '3gp', 'rmvb', 'mts'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus', 'aiff', 'aif', 'mid', 'midi', 'ape', 'wv'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'md', 'epub', 'mobi', 'log', 'tex', 'one', 'msg', 'eml', 'pages', 'numbers', 'key', 'dwg', 'dxf'],
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'java', 'class', 'py', 'rb', 'go', 'rs', 'php', 'sh', 'bash', 'ps1', 'psm1', 'sql', 'yml', 'yaml', 'ini', 'cfg', 'toml', 'vue', 'svelte', 'kt', 'kts', 'swift', 'lua', 'pl', 'r', 'map', 'lock'],
};

const EXT_TO_CATEGORY = new Map<string, CategoryId>();
for (const cat of CATEGORY_IDS) {
  if (cat === 'folders' || cat === 'other') continue;
  for (const ext of CATEGORY_EXT[cat]) EXT_TO_CATEGORY.set(ext, cat);
}

/** Category of a file extension (lowercased, without the dot). */
export function categoryOf(ext: string): CategoryId {
  return EXT_TO_CATEGORY.get(ext) ?? 'other';
}

/** Aggregated stats for one coarse category (the "tipo de arquivo" donut). */
export interface CategoryStat {
  id: CategoryId;
  bytes: number;
  files: number;
  percent: number;
  color: string;
}

/** One entry of the "maiores arquivos" list. */
export interface LargestFile {
  path: string;
  name: string;
  size: number;
  percent: number;
  ext: string;
  category: CategoryId;
  /** Containing folder (shown in the "largest files of the drive" dialog). */
  dir: string;
}

/** One set of byte-identical files (duplicate finder). */
export interface DupeGroup {
  /** Size of each file in the group (all identical). */
  size: number;
  /** Absolute paths, sorted; the first one is kept by default. */
  paths: string[];
}

/** Progress of the duplicate finder, as reported by the hash worker. */
export interface DupeProgress {
  phase: 'partial' | 'full';
  done: number;
  total: number;
}

/** Result payload of the duplicate finder. */
export interface DupeResult {
  groups: DupeGroup[];
  elapsedMs: number;
  hashed: number;
  cancelled: boolean;
}

/** One row of the "limpeza segura" dialog, measured by the main process. */
export interface CleanTarget {
  id: string;
  needsAdmin: boolean;
  infoOnly: boolean;
  size: number;
  files: number;
  state: 'pending' | 'measuring' | 'ready' | 'denied' | 'cleared' | 'error';
}
