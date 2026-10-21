import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Duplicate finder: candidates (files whose size repeats) are hashed in two
 * passes — a cheap partial hash (first + last 64 KiB) to discard files that only
 * share the size, then the full content hash of the survivors.
 *
 * The renderer already discards unique sizes; this worker re-groups by size so it
 * remains correct when called with a flat list.
 */
interface FileRef {
  path: string;
  size: number;
}
interface Payload {
  files: FileRef[];
  control: SharedArrayBuffer;
}
type Out =
  | { type: 'progress'; phase: 'partial' | 'full'; done: number; total: number }
  | { type: 'done'; groups: { size: number; paths: string[] }[]; elapsedMs: number; hashed: number; cancelled: boolean };

const ctx = workerData as Payload;
const port = parentPort!;
const flag = new Int32Array(ctx.control);
const cancelled = (): boolean => Atomics.load(flag, 0) === 1;

const PARTIAL_BYTES = 64 * 1024;
const PARTIAL_CONCURRENCY = 4;
const FULL_CONCURRENCY = 2;

/** Runs `fn` over `items` with a bounded number of parallel async operations. */
async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        if (cancelled()) return;
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    }),
  );
}

async function partialHash(f: FileRef): Promise<string | null> {
  let fh;
  try {
    fh = await open(f.path, 'r');
    const len = Math.min(PARTIAL_BYTES, f.size);
    const head = Buffer.allocUnsafe(len);
    await fh.read(head, 0, len, 0);
    const hash = createHash('sha1');
    hash.update(head);
    if (f.size > len) {
      const tail = Buffer.allocUnsafe(len);
      await fh.read(tail, 0, len, Math.max(0, f.size - len));
      hash.update(tail);
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

async function fullHash(p: string): Promise<string | null> {
  try {
    const hash = createHash('sha1');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(p, { highWaterMark: 1024 * 1024 });
      stream.on('data', (chunk) => hash.update(chunk as Buffer));
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });
    return hash.digest('hex');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let last = 0;
  const progress = (phase: 'partial' | 'full', done: number, total: number): void => {
    const now = Date.now();
    if (now - last < 150 && done < total) return;
    last = now;
    const msg: Out = { type: 'progress', phase, done, total };
    port.postMessage(msg);
  };

  // ---- group by size: a size seen once can never be a duplicate -------------
  const bySize = new Map<number, FileRef[]>();
  for (const f of ctx.files) {
    if (!f.size) continue;
    const list = bySize.get(f.size);
    if (list) list.push(f);
    else bySize.set(f.size, [f]);
  }
  const candidates: FileRef[] = [];
  for (const list of bySize.values()) if (list.length > 1) candidates.push(...list);

  // ---- pass 1: partial hash -------------------------------------------------
  const partial = new Map<string, FileRef[]>();
  let done1 = 0;
  await pool(candidates, PARTIAL_CONCURRENCY, async (f) => {
    const h = await partialHash(f);
    done1++;
    progress('partial', done1, candidates.length);
    if (!h) return;
    const key = `${f.size}:${h}`;
    const list = partial.get(key);
    if (list) list.push(f);
    else partial.set(key, [f]);
  });

  // ---- pass 2: full hash of the partial matches -----------------------------
  const full: FileRef[] = [];
  for (const list of partial.values()) if (list.length > 1) full.push(...list);

  const final = new Map<string, FileRef[]>();
  let done2 = 0;
  await pool(full, FULL_CONCURRENCY, async (f) => {
    const h = await fullHash(f.path);
    done2++;
    progress('full', done2, full.length);
    if (!h) return;
    const key = `${f.size}:${h}`;
    const list = final.get(key);
    if (list) list.push(f);
    else final.set(key, [f]);
  });

  const groups = [...final.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({ size: list[0].size, paths: list.map((f) => f.path).sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => b.size * (b.paths.length - 1) - a.size * (a.paths.length - 1));

  const out: Out = {
    type: 'done',
    groups,
    elapsedMs: Date.now() - startedAt,
    hashed: full.length,
    cancelled: cancelled(),
  };
  port.postMessage(out);
}

void main();
