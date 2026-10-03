import { describe, expect, test } from "bun:test";
import { IndexStore, SHARD_COUNT, shardOf } from "./indexStore";
import {
  MANIFEST_FILE,
  deleteIndex,
  loadIndex,
  newManifest,
  saveIndex,
  shardFileName,
  type FilePort,
} from "./persistence";

class MemoryFiles implements FilePort {
  files = new Map<string, ArrayBuffer>();
  writes: string[] = [];
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, data: ArrayBuffer) {
    this.writes.push(path);
    this.files.set(path, data.slice(0));
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async rename(from: string, to: string) {
    if (this.files.has(to)) throw new Error(`${to} exists`);
    const data = this.files.get(from);
    if (!data) throw new Error(`${from} missing`);
    this.files.delete(from);
    this.files.set(to, data);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async mkdir() {}
}

const DIR = "idx";
const stat = { mtime: 1, size: 1, hash: "h" };
const chunk = (text: string) => ({ breadcrumbs: text, text, textHash: text, vector: Float32Array.from([1, 0]) });

function filledStore(): IndexStore {
  const store = new IndexStore("fp", 2);
  store.putNote("a.md", stat, [chunk("A")]);
  store.putNote("日記/b.md", stat, [chunk("B")]);
  store.putFailedNote("c.md", stat, "HTTP 400");
  return store;
}

describe("persistence", () => {
  test("save then load gives back the same notes and manifest", async () => {
    const files = new MemoryFiles();
    const manifest = { ...newManifest("fp"), buildState: "completed" as const, completedAt: 5, tokens: { lastBuild: 3, total: 9 } };
    await saveIndex(files, DIR, filledStore(), manifest);
    const loaded = await loadIndex(files, DIR, "fp", 2);
    expect(loaded?.manifest).toEqual(manifest);
    expect(loaded?.brokenShards).toEqual([]);
    expect(loaded?.store.paths().sort()).toEqual(["a.md", "c.md", "日記/b.md"]);
    expect(loaded?.store.get("c.md")).toMatchObject({ status: "failed", error: "HTTP 400" });
    expect(loaded?.store.dirtyShards()).toEqual([]);
  });

  test("only changed shards are written again", async () => {
    const files = new MemoryFiles();
    const store = filledStore();
    await saveIndex(files, DIR, store, newManifest("fp"));
    files.writes = [];
    store.putNote("a.md", { ...stat, mtime: 2 }, [chunk("A2")]);
    await saveIndex(files, DIR, store, newManifest("fp"));
    expect(files.writes).toEqual([`${DIR}/${shardFileName(shardOf("a.md"))}.tmp`, `${DIR}/${MANIFEST_FILE}.tmp`]);
  });

  test("an index built with another fingerprint, or none at all, is not loaded", async () => {
    const files = new MemoryFiles();
    expect(await loadIndex(files, DIR, "fp", 2)).toBeNull();
    await saveIndex(files, DIR, filledStore(), newManifest("fp"));
    expect(await loadIndex(files, DIR, "other", 2)).toBeNull();
  });

  test("a damaged shard is reported and the rest still loads", async () => {
    const files = new MemoryFiles();
    await saveIndex(files, DIR, filledStore(), newManifest("fp"));
    const broken = shardOf("a.md");
    files.files.set(`${DIR}/${shardFileName(broken)}`, new ArrayBuffer(3));
    const loaded = await loadIndex(files, DIR, "fp", 2);
    expect(loaded?.brokenShards).toEqual([broken]);
    expect(loaded?.store.get("a.md")).toBeUndefined();
    expect(loaded?.store.get("c.md")).toBeDefined();
  });

  // Review Focus 4: a crash between removing the old file and renaming the new one.
  test("a shard left only as .tmp after a crash is still loaded", async () => {
    const files = new MemoryFiles();
    await saveIndex(files, DIR, filledStore(), newManifest("fp"));
    const path = `${DIR}/${shardFileName(shardOf("a.md"))}`;
    files.files.set(`${path}.tmp`, files.files.get(path)!);
    files.files.delete(path);
    const loaded = await loadIndex(files, DIR, "fp", 2);
    expect(loaded?.store.get("a.md")).toBeDefined();
    expect(loaded?.brokenShards).toEqual([]);
  });

  test("deleteIndex removes every file it may have written", async () => {
    const files = new MemoryFiles();
    await saveIndex(files, DIR, filledStore(), newManifest("fp"));
    files.files.set(`${DIR}/${shardFileName(0)}.tmp`, new ArrayBuffer(1));
    await deleteIndex(files, DIR);
    expect(files.files.size).toBe(0);
    expect(SHARD_COUNT).toBe(32);
  });
});
