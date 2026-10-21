import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FsEntry, WorkerData, WorkerInbound, WorkerOutbound } from '../types';
import { makeExcluder } from './filter';
import { allocBytes } from './alloc';

const ctx = workerData as WorkerData;
const port = parentPort!;
const flag = new Int32Array(ctx.control);
const isExcluded = makeExcluder(ctx.exclude ?? []);

let batch: FsEntry[] = [];
let files = 0;
let folders = 0;
let bytes = 0;
let lastProgress = 0;
/** Folder this worker is walking right now (reported with the progress ticks). */
let currentDir = '';

const cancelled = (): boolean => Atomics.load(flag, 0) === 1;

function flush(): void {
  if (batch.length) {
    const msg: WorkerOutbound = { type: 'batch', entries: batch };
    port.postMessage(msg);
    batch = [];
  }
}

// Recursive walk of a directory: enumerate with readdir, skip symlinks/junctions
// (reparse points) to avoid cycles, sum file sizes.
function walk(dir: string): void {
  if (cancelled()) return;
  currentDir = dir;
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // access denied / not found -> skip; a folder that fails never aborts the scan
  }
  const subdirs: string[] = [];
  for (const de of ents) {
    if (cancelled()) return;
    const full = path.join(dir, de.name);
    if (isExcluded(full, de.name)) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // skip reparse points
    const isDir = st.isDirectory();
    const size = isDir ? 0 : st.size;
    // Real allocation: libuv fills st.blocks from AllocationSize, which accounts for
    // NTFS compression, sparse files and MFT-resident files (0 bytes on disk).
    const allocated = isDir ? 0 : allocBytes(st, size, ctx.cluster);
    if (isDir) {
      folders++;
    } else {
      files++;
      bytes += size;
    }
    const attrs = (isDir ? 0x10 : 0) | ((st.mode & 0o222) === 0 ? 0x01 : 0);
    batch.push({ path: full, parent: dir, name: de.name, isDir, size, allocated, mtime: st.mtimeMs, atime: st.atimeMs, ctime: st.birthtimeMs, attrs });
    if (batch.length >= ctx.batchSize) flush();

    const now = Date.now();
    if (now - lastProgress > 200) {
      lastProgress = now;
      flush();
      const p: WorkerOutbound = { type: 'progress', files, folders, bytes, dir: currentDir };
      port.postMessage(p);
    }

    if (isDir) subdirs.push(full);
  }
  for (const sd of subdirs) walk(sd);
}

port.on('message', (msg: WorkerInbound) => {
  if (msg.cmd === 'scan') {
    files = 0;
    folders = 0;
    bytes = 0;
    walk(msg.dir);
    flush();
    const done: WorkerOutbound = { type: 'ready', files, folders, bytes };
    port.postMessage(done);
  } else if (msg.cmd === 'exit') {
    flush();
    process.exit(0);
  }
});

const boot: WorkerOutbound = { type: 'boot' };
port.postMessage(boot);
