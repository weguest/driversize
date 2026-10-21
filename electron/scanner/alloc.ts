import type { Stats } from 'node:fs';

/**
 * Bytes actually reserved on disk for a file.
 *
 * libuv fills `st.blocks` from the Windows AllocationSize, so compression, sparse
 * files and MFT-resident files are all reported correctly (resident files use no
 * clusters: 0 bytes). If a filesystem does not report it, fall back to the
 * cluster-aligned logical size.
 */
export function allocBytes(st: Stats, size: number, cluster: number): number {
  const blocks = (st as Stats & { blocks?: number }).blocks;
  if (typeof blocks === 'number' && blocks >= 0) return blocks * 512;
  return size > 0 ? Math.ceil(size / cluster) * cluster : 0;
}
