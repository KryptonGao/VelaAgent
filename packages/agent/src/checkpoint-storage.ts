import { link, lstat, readFile, readdir, rm, rmdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { checkpointRetention, type CheckpointCleanResult, type CheckpointStorageUsage } from "@vela/shared";
import { exclusiveAccess, pointHashes, sharedDirectory, type TurnCheckpoint } from "./turn-checkpoints";

export interface CheckpointPolicy {
  /** Newest points kept per conversation; older turns can no longer be rewound to. */
  maxPointsPerConversation: number;
  /** Total size of the distinct file versions kept; the oldest points go first when it is exceeded. */
  maxBytes: number;
}
export const defaultCheckpointPolicy: CheckpointPolicy = { ...checkpointRetention };

const hashPattern = /^[a-f0-9]{64}$/;
const staleTemp = 60 * 60 * 1000;
/** A point without `after` may belong to a running turn; only old ones are leftovers of a crash. */
const abandonedAfter = 24 * 60 * 60 * 1000;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const names = (directory: string) => readdir(directory).catch(error => { if (missing(error)) return [] as string[]; throw error; });

const conversations = async (root: string) => {
  const found: string[] = [];
  for (const name of await names(root)) {
    if (name.startsWith(".")) continue;
    if ((await lstat(join(root, name)).catch(() => null))?.isDirectory()) found.push(name);
  }
  return found;
};

/** Disk used by checkpoints. A blob shared by several conversations through hard links is counted once. */
export async function checkpointUsage(root: string): Promise<CheckpointStorageUsage> {
  const seen = new Set<string>();
  let bytes = 0, points = 0;
  const add = async (path: string) => {
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile()) return;
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return;
    seen.add(key);
    bytes += stat.size;
  };
  const ids = await conversations(root);
  for (const id of ids) {
    const directory = join(root, id);
    for (const name of await names(directory)) {
      if (name === "blobs") for (const blob of await names(join(directory, name))) await add(join(directory, name, blob));
      else {
        await add(join(directory, name));
        if (name.endsWith(".json")) points += 1;
      }
    }
  }
  const shared = sharedDirectory(root);
  for (const folder of ["blobs", "stat"]) for (const name of await names(join(shared, folder))) await add(join(shared, folder, name));
  return { bytes, conversations: ids.length, points };
}

interface StoredPoint {
  conversation: string;
  file: string;
  time: number;
  finished: boolean;
  hashes: Set<string>;
}

/**
 * Merge duplicate blobs into the shared pool, drop the oldest points beyond the policy, and delete every blob no
 * remaining point references. Safe to run while the app is idle or busy: it waits for in-flight captures first.
 */
export async function cleanCheckpoints(root: string, policy: CheckpointPolicy = defaultCheckpointPolicy): Promise<CheckpointCleanResult> {
  const before = await checkpointUsage(root);
  const removedPoints = await exclusiveAccess(async () => {
    const pool = join(sharedDirectory(root), "blobs");
    const ids = await conversations(root);
    const sizes = new Map<string, number>();

    // Conversations written before the shared pool each hold private copies; point them at one file.
    for (const id of ids) {
      const folder = join(root, id, "blobs");
      for (const name of await names(folder)) {
        if (!hashPattern.test(name)) continue;
        const own = await lstat(join(folder, name)).catch(() => null);
        if (!own?.isFile()) continue;
        sizes.set(name, own.size);
        const pooled = await lstat(join(pool, name)).catch(() => null);
        if (!pooled) {
          await mkdir(pool, { recursive: true, mode: 0o700 });
          await link(join(folder, name), join(pool, name)).catch(error => { if (error.code !== "EEXIST" && error.code !== "EXDEV") throw error; });
        } else if (pooled.isFile() && (pooled.ino !== own.ino || pooled.dev !== own.dev) && pooled.size === own.size) {
          await rm(join(folder, name), { force: true });
          await link(join(pool, name), join(folder, name)).catch(error => { if (error.code !== "EXDEV") throw error; });
        }
      }
    }

    const stored = new Map<string, StoredPoint[]>();
    const read = async (id: string) => {
      const list: StoredPoint[] = [];
      for (const file of (await names(join(root, id))).filter(name => name.endsWith(".json"))) {
        try {
          const path = join(root, id, file);
          const point = JSON.parse(await readFile(path, "utf8")) as Pick<TurnCheckpoint<unknown>, "before" | "after">;
          list.push({ conversation: id, file: path, time: (await lstat(path)).mtimeMs, finished: !!point.after, hashes: pointHashes(point) });
        } catch { /* A damaged or vanished point is left alone. */ }
      }
      return list.sort((a, b) => a.time - b.time);
    };
    for (const id of ids) stored.set(id, await read(id));

    let removed = 0;
    const drop = async (point: StoredPoint) => {
      await rm(point.file, { force: true });
      stored.set(point.conversation, stored.get(point.conversation)!.filter(item => item !== point));
      removed += 1;
    };
    const now = Date.now();
    const removable = (point: StoredPoint, list: StoredPoint[]) =>
      list.at(-1) !== point && (point.finished || now - point.time > abandonedAfter);

    for (const list of stored.values()) {
      const keep = Math.max(1, policy.maxPointsPerConversation);
      for (const point of list.slice(0, Math.max(0, list.length - keep))) if (removable(point, list)) await drop(point);
    }

    // Over the size cap: evict the oldest points of any conversation, but never a conversation's newest one.
    const references = new Map<string, number>();
    for (const list of stored.values()) for (const point of list) for (const hash of point.hashes) references.set(hash, (references.get(hash) ?? 0) + 1);
    let total = 0;
    for (const [hash, count] of references) if (count > 0) total += sizes.get(hash) ?? 0;
    if (total > policy.maxBytes) {
      const queue = [...stored.values()].flatMap(list => list.filter(point => removable(point, list))).sort((a, b) => a.time - b.time);
      for (const point of queue) {
        if (total <= policy.maxBytes) break;
        for (const hash of point.hashes) {
          const left = (references.get(hash) ?? 0) - 1;
          references.set(hash, left);
          if (left === 0) total -= sizes.get(hash) ?? 0;
        }
        await drop(point);
      }
    }

    // Sweep: a conversation keeps links only to what its remaining points need, and the pool keeps only linked files.
    for (const id of ids) {
      const needed = new Set<string>();
      for (const point of stored.get(id) ?? []) for (const hash of point.hashes) needed.add(hash);
      const folder = join(root, id, "blobs");
      for (const name of await names(folder)) {
        const path = join(folder, name);
        if (hashPattern.test(name) ? !needed.has(name) : name.endsWith(".tmp") && now - ((await lstat(path).catch(() => null))?.mtimeMs ?? now) > staleTemp) {
          await rm(path, { force: true });
        }
      }
    }
    for (const name of await names(pool)) {
      const path = join(pool, name);
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile()) continue;
      if (hashPattern.test(name) ? stat.nlink <= 1 : now - stat.mtimeMs > staleTemp) await rm(path, { force: true });
    }
    // Drop conversations left with nothing.
    for (const id of ids) {
      const folder = join(root, id);
      await rmdir(join(folder, "blobs")).catch(() => undefined);
      await rmdir(folder).catch(() => undefined);
    }
    return removed;
  });
  const usage = await checkpointUsage(root);
  return { freedBytes: Math.max(0, before.bytes - usage.bytes), removedPoints, usage };
}
