import { fnv1a32 } from "./hash";
import { isExcluded } from "./settings";

export const SHARD_COUNT = 32;

export function shardOf(path: string): number {
  return fnv1a32(path) % SHARD_COUNT;
}

export interface StoredChunk {
  breadcrumbs: string;
  text: string;
  textHash: string;
  vector: Float32Array;
}

export interface NoteRecord {
  mtime: number;
  size: number;
  /** SHA-256 of the note content. */
  hash: string;
  status: "ok" | "failed";
  error?: string;
  chunks: StoredChunk[];
}

export interface NoteStat {
  mtime: number;
  size: number;
  hash: string;
}

export interface SearchHit {
  path: string;
  breadcrumbs: string;
  text: string;
  score: number;
}

export interface SearchOptions {
  limit: number;
  /** At most this many sections from one note; the remaining slots go to other notes. No cap when omitted. */
  maxPerNote?: number;
  folders?: string[];
  excludeFolders?: string[];
}

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const out = new Float32Array(vector.length);
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/** The whole index in memory, split into shards so only changed shards are written back. */
export class IndexStore {
  private readonly shards: Map<string, NoteRecord>[] = Array.from(
    { length: SHARD_COUNT },
    () => new Map<string, NoteRecord>(),
  );
  private readonly dirty = new Set<number>();

  /** @param dimension vector length; 0 until the first vector fixes it. */
  constructor(
    readonly fingerprint: string,
    public dimension: number,
  ) {}

  get(path: string): NoteRecord | undefined {
    return this.shards[shardOf(path)].get(path);
  }

  paths(): string[] {
    const out: string[] = [];
    for (const shard of this.shards) for (const path of shard.keys()) out.push(path);
    return out;
  }

  putNote(path: string, stat: NoteStat, chunks: StoredChunk[]): void {
    const stored = chunks.map((chunk) => {
      this.checkDimension(chunk.vector.length);
      return { ...chunk, vector: normalize(chunk.vector) };
    });
    this.set(path, { ...stat, status: "ok", chunks: stored });
  }

  putFailedNote(path: string, stat: NoteStat, error: string): void {
    this.set(path, { ...stat, status: "failed", error, chunks: [] });
  }

  touchNote(path: string, mtime: number, size: number): void {
    const record = this.get(path);
    if (!record) return;
    record.mtime = mtime;
    record.size = size;
    this.dirty.add(shardOf(path));
  }

  removeNote(path: string): boolean {
    const i = shardOf(path);
    const removed = this.shards[i].delete(path);
    if (removed) this.dirty.add(i);
    return removed;
  }

  /** Puts a record read from disk as is: no normalizing, shard not marked dirty. */
  loadNote(path: string, record: NoteRecord): void {
    this.shards[shardOf(path)].set(path, record);
  }

  stats(): { notes: number; failedNotes: number; chunks: number } {
    let notes = 0;
    let failedNotes = 0;
    let chunks = 0;
    for (const shard of this.shards) {
      for (const record of shard.values()) {
        notes++;
        if (record.status === "failed") failedNotes++;
        chunks += record.chunks.length;
      }
    }
    return { notes, failedNotes, chunks };
  }

  failures(): { path: string; error: string }[] {
    const out: { path: string; error: string }[] = [];
    for (const shard of this.shards) {
      for (const [path, record] of shard) {
        if (record.status === "failed") out.push({ path, error: record.error ?? "" });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  search(query: Float32Array, options: SearchOptions): SearchHit[] {
    if (this.dimension !== 0 && query.length !== this.dimension) {
      throw new Error(`Query vector has ${query.length} dimensions, the index has ${this.dimension}`);
    }
    const q = normalize(query);
    const folders = options.folders ?? [];
    const excluded = options.excludeFolders ?? [];
    const hits: SearchHit[] = [];
    for (const shard of this.shards) {
      for (const [path, record] of shard) {
        if (folders.length > 0 && !folders.some((prefix) => path.startsWith(prefix))) continue;
        if (isExcluded(path, excluded)) continue;
        for (const chunk of record.chunks) {
          const v = chunk.vector;
          let score = 0;
          for (let i = 0; i < v.length; i++) score += v[i] * q[i];
          hits.push({ path, breadcrumbs: chunk.breadcrumbs, text: chunk.text, score });
        }
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const maxPerNote = options.maxPerNote ?? Infinity;
    const perNote = new Map<string, number>();
    const out: SearchHit[] = [];
    for (const hit of hits) {
      if (out.length >= options.limit) break;
      const count = perNote.get(hit.path) ?? 0;
      if (count >= maxPerNote) continue;
      perNote.set(hit.path, count + 1);
      out.push(hit);
    }
    return out;
  }

  shardEntries(i: number): [string, NoteRecord][] {
    return Array.from(this.shards[i]);
  }

  dirtyShards(): number[] {
    return Array.from(this.dirty).sort((a, b) => a - b);
  }

  markClean(i: number): void {
    this.dirty.delete(i);
  }

  private set(path: string, record: NoteRecord): void {
    const i = shardOf(path);
    this.shards[i].set(path, record);
    this.dirty.add(i);
  }

  private checkDimension(length: number): void {
    if (this.dimension === 0) this.dimension = length;
    else if (length !== this.dimension) {
      throw new Error(`Vector has ${length} dimensions, the index has ${this.dimension}`);
    }
  }
}
