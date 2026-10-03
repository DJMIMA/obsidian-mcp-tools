import type { IndexStore, NoteRecord } from "./indexStore";
import { isExcluded } from "./settings";

export interface FileStat {
  path: string;
  mtime: number;
  size: number;
}

export interface ReconcilePlan {
  /** Files that are new or whose mtime or size changed; their content decides what to embed. */
  check: FileStat[];
  /** Indexed paths that are gone from the vault or now excluded. */
  remove: string[];
  /** Number of notes that should be in the index. */
  total: number;
}

export function planReconcile(
  files: FileStat[],
  indexed: Pick<IndexStore, "paths" | "get">,
  excludeFolders: string[],
): ReconcilePlan {
  const targets = files.filter((file) => !isExcluded(file.path, excludeFolders));
  const targetPaths = new Set(targets.map((file) => file.path));
  const check = targets.filter((file) => {
    const record = indexed.get(file.path);
    return !record || record.mtime !== file.mtime || record.size !== file.size;
  });
  const remove = indexed.paths().filter((path) => !targetPaths.has(path));
  return { check, remove, total: targets.length };
}

export type NoteUpdatePlan =
  | { kind: "touch" }
  | { kind: "embed"; reuse: (Float32Array | null)[]; missing: number[] };

/**
 * Decides what a note needs. Same content hash: only the stat changes (a failed
 * note stays failed until it is edited). Otherwise each chunk reuses a vector
 * whose text hash it shares with the old record or with `recycled` (vectors of
 * removed or renamed notes), and the rest are listed in `missing`.
 */
export function planNoteUpdate(
  existing: NoteRecord | undefined,
  contentHash: string,
  chunkTextHashes: string[],
  recycled: Map<string, Float32Array> = new Map(),
): NoteUpdatePlan {
  if (existing && existing.hash === contentHash) return { kind: "touch" };
  const known = new Map(recycled);
  if (existing?.status === "ok") for (const chunk of existing.chunks) known.set(chunk.textHash, chunk.vector);
  const reuse = chunkTextHashes.map((hash) => known.get(hash) ?? null);
  const missing: number[] = [];
  reuse.forEach((vector, i) => {
    if (!vector) missing.push(i);
  });
  return { kind: "embed", reuse, missing };
}

export function recycleChunks(records: (NoteRecord | undefined)[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (const record of records) {
    if (record?.status === "ok") for (const chunk of record.chunks) out.set(chunk.textHash, chunk.vector);
  }
  return out;
}
