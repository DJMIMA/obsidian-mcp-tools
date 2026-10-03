import { describe, expect, test } from "bun:test";
import { IndexStore, SHARD_COUNT, normalize, shardOf, type StoredChunk } from "./indexStore";

const stat = { mtime: 1, size: 10, hash: "h" };
const chunk = (text: string, vector: number[]): StoredChunk => ({
  breadcrumbs: `n > ${text}`,
  text,
  textHash: `t-${text}`,
  vector: Float32Array.from(vector),
});

describe("shardOf", () => {
  test("is stable and within range", () => {
    for (const path of ["a.md", "日記/2026-09-03.md", "My Notes/x.md"]) {
      expect(shardOf(path)).toBe(shardOf(path));
      expect(shardOf(path)).toBeGreaterThanOrEqual(0);
      expect(shardOf(path)).toBeLessThan(SHARD_COUNT);
    }
  });
});

describe("IndexStore", () => {
  test("stores normalized vectors and counts notes, failures and chunks", () => {
    const store = new IndexStore("fp", 2);
    store.putNote("a.md", stat, [chunk("A", [3, 4])]);
    store.putFailedNote("b.md", stat, "HTTP 400: too long");
    expect(Array.from(store.get("a.md")!.chunks[0].vector)).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(store.stats()).toEqual({ notes: 2, failedNotes: 1, chunks: 1 });
    expect(store.failures()).toEqual([{ path: "b.md", error: "HTTP 400: too long" }]);
  });

  test("ranks by cosine similarity and honours limit and folder filters", () => {
    const store = new IndexStore("fp", 2);
    store.putNote("x/a.md", stat, [chunk("east", [1, 0])]);
    store.putNote("y/b.md", stat, [chunk("north", [0, 1])]);
    store.putNote("x/c.md", stat, [chunk("northeast", [1, 1])]);
    const query = Float32Array.from([1, 0.1]);
    expect(store.search(query, { limit: 3 }).map((h) => h.text)).toEqual(["east", "northeast", "north"]);
    expect(store.search(query, { limit: 1 }).map((h) => h.text)).toEqual(["east"]);
    expect(store.search(query, { limit: 3, folders: ["y/"] }).map((h) => h.path)).toEqual(["y/b.md"]);
    expect(store.search(query, { limit: 3, excludeFolders: ["x/"] }).map((h) => h.path)).toEqual(["y/b.md"]);
    const top = store.search(query, { limit: 1 })[0];
    expect(top).toMatchObject({ path: "x/a.md", breadcrumbs: "n > east" });
    expect(top.score).toBeCloseTo(1 / Math.sqrt(1.01), 5);
  });

  test("takes its dimension from the first vector when it starts at 0, then rejects other sizes", () => {
    const store = new IndexStore("fp", 0);
    store.putNote("a.md", stat, [chunk("A", [1, 0, 0])]);
    expect(store.dimension).toBe(3);
    expect(() => store.putNote("b.md", stat, [chunk("B", [1, 0])])).toThrow("3");
    expect(() => store.search(Float32Array.from([1, 0]), { limit: 1 })).toThrow("3");
  });

  test("tracks which shards changed", () => {
    const store = new IndexStore("fp", 2);
    store.putNote("a.md", stat, [chunk("A", [1, 0])]);
    expect(store.dirtyShards()).toEqual([shardOf("a.md")]);
    store.markClean(shardOf("a.md"));
    store.touchNote("a.md", 2, 11);
    expect(store.get("a.md")).toMatchObject({ mtime: 2, size: 11 });
    expect(store.dirtyShards()).toEqual([shardOf("a.md")]);
    store.markClean(shardOf("a.md"));
    expect(store.removeNote("a.md")).toBe(true);
    expect(store.removeNote("a.md")).toBe(false);
    expect(store.paths()).toEqual([]);
    expect(store.dirtyShards()).toEqual([shardOf("a.md")]);
  });

  test("loadNote puts a record without marking the shard dirty", () => {
    const store = new IndexStore("fp", 2);
    store.loadNote("a.md", { ...stat, status: "ok", chunks: [chunk("A", [1, 0])] });
    expect(store.paths()).toEqual(["a.md"]);
    expect(store.dirtyShards()).toEqual([]);
  });
});

describe("normalize", () => {
  test("leaves a zero vector as zeros", () => {
    expect(Array.from(normalize(Float32Array.from([0, 0])))).toEqual([0, 0]);
  });
});
