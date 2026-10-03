import { IndexStore, SHARD_COUNT } from "./indexStore";
import { SHARD_FORMAT_VERSION, decodeShard, encodeShard } from "./shardFile";

/** The file operations the index needs, relative to the vault root. */
export interface FilePort {
  /** null when the file does not exist. */
  read(path: string): Promise<ArrayBuffer | null>;
  write(path: string, data: ArrayBuffer): Promise<void>;
  /** No-op when the file does not exist. */
  remove(path: string): Promise<void>;
  /** The destination must not exist. */
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** No-op when the directory exists. */
  mkdir(path: string): Promise<void>;
}

export type BuildState = "running" | "cancelled" | "completed";

export interface IndexManifest {
  formatVersion: number;
  fingerprint: string;
  shardCount: number;
  buildState: BuildState;
  completedAt: number | null;
  tokens: { lastBuild: number; total: number };
}

export interface LoadedIndex {
  store: IndexStore;
  manifest: IndexManifest;
  /** Shards that could not be read; their notes are missing from the store and get re-embedded. */
  brokenShards: number[];
}

export const MANIFEST_FILE = "manifest.json";

export function shardFileName(i: number): string {
  return `shard-${String(i).padStart(2, "0")}.bin`;
}

export function newManifest(fingerprint: string): IndexManifest {
  return {
    formatVersion: SHARD_FORMAT_VERSION,
    fingerprint,
    shardCount: SHARD_COUNT,
    buildState: "running",
    completedAt: null,
    tokens: { lastBuild: 0, total: 0 },
  };
}

/** Reads `path`, falling back to the `.tmp` a crashed save may have left behind. */
async function readWithFallback(files: FilePort, path: string): Promise<ArrayBuffer | null> {
  return (await files.read(path)) ?? (await files.read(`${path}.tmp`));
}

/** Returns null when there is no index, or it was built with another fingerprint. */
export async function loadIndex(
  files: FilePort,
  dir: string,
  fingerprint: string,
  dimension: number,
): Promise<LoadedIndex | null> {
  const raw = await readWithFallback(files, `${dir}/${MANIFEST_FILE}`);
  if (!raw) return null;
  let manifest: IndexManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw)) as IndexManifest;
  } catch {
    return null;
  }
  if (
    manifest.formatVersion !== SHARD_FORMAT_VERSION ||
    manifest.fingerprint !== fingerprint ||
    manifest.shardCount !== SHARD_COUNT
  ) {
    return null;
  }

  const store = new IndexStore(fingerprint, dimension);
  const brokenShards: number[] = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const buffer = await readWithFallback(files, `${dir}/${shardFileName(i)}`);
    if (!buffer) continue; // never written: no notes landed in this shard yet
    const decoded = decodeShard(buffer);
    const dimensionClash =
      decoded.ok && store.dimension !== 0 && decoded.dimension !== 0 && decoded.dimension !== store.dimension;
    if (!decoded.ok || decoded.fingerprint !== fingerprint || decoded.shard !== i || dimensionClash) {
      brokenShards.push(i);
      continue;
    }
    if (store.dimension === 0) store.dimension = decoded.dimension;
    for (const [path, record] of decoded.notes) store.loadNote(path, record);
  }
  return { store, manifest, brokenShards };
}

function bytesOf(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

/** Writes to `path.tmp`, then swaps it in, so a crash leaves either the old or the new file. */
async function replaceFile(files: FilePort, path: string, data: ArrayBuffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await files.write(tmp, data);
  await files.remove(path);
  await files.rename(tmp, path);
}

/** Writes the changed shards and the manifest. */
export async function saveIndex(
  files: FilePort,
  dir: string,
  store: IndexStore,
  manifest: IndexManifest,
): Promise<void> {
  await files.mkdir(dir);
  for (const i of store.dirtyShards()) {
    // Clean before encoding: a change made while the file is being written marks the shard dirty again.
    store.markClean(i);
    const data = encodeShard({
      fingerprint: store.fingerprint,
      dimension: store.dimension,
      shard: i,
      notes: store.shardEntries(i),
    });
    await replaceFile(files, `${dir}/${shardFileName(i)}`, data);
  }
  await replaceFile(files, `${dir}/${MANIFEST_FILE}`, bytesOf(JSON.stringify(manifest, null, 2)));
}

export async function deleteIndex(files: FilePort, dir: string): Promise<void> {
  const names = [MANIFEST_FILE, ...Array.from({ length: SHARD_COUNT }, (_, i) => shardFileName(i))];
  for (const name of names) {
    await files.remove(`${dir}/${name}`);
    await files.remove(`${dir}/${name}.tmp`);
  }
}
