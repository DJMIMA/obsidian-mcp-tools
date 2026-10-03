import { describe, expect, test } from "bun:test";
import { IndexStore } from "./indexStore";
import { planNoteUpdate, planReconcile, recycleChunks } from "./plan";

const vec = (x: number) => Float32Array.from([x, 1]);
const record = (hash: string, textHashes: string[], status: "ok" | "failed" = "ok") => ({
  mtime: 1,
  size: 1,
  hash,
  status,
  chunks: textHashes.map((t, i) => ({ breadcrumbs: "b", text: t, textHash: t, vector: vec(i + 1) })),
});

describe("planReconcile", () => {
  const store = new IndexStore("fp", 2);
  store.loadNote("same.md", record("h", ["x"]));
  store.loadNote("changed.md", record("h", ["x"]));
  store.loadNote("gone.md", record("h", ["x"]));
  store.loadNote("Private/p.md", record("h", ["x"]));

  test("checks new and changed files, removes deleted and excluded ones", () => {
    const plan = planReconcile(
      [
        { path: "same.md", mtime: 1, size: 1 },
        { path: "changed.md", mtime: 2, size: 1 },
        { path: "new.md", mtime: 1, size: 1 },
        { path: "Private/p.md", mtime: 1, size: 1 },
      ],
      store,
      ["Private/"],
    );
    expect(plan.check.map((f) => f.path)).toEqual(["changed.md", "new.md"]);
    expect(plan.remove.sort()).toEqual(["Private/p.md", "gone.md"]);
    expect(plan.total).toBe(3);
  });
});

describe("planNoteUpdate", () => {
  test("a new note embeds every chunk", () => {
    expect(planNoteUpdate(undefined, "h", ["a", "b"])).toEqual({ kind: "embed", reuse: [null, null], missing: [0, 1] });
  });

  test("unchanged content only needs its stat updated, even for a failed note", () => {
    expect(planNoteUpdate(record("h", ["a"]), "h", ["a"])).toEqual({ kind: "touch" });
    expect(planNoteUpdate(record("h", [], "failed"), "h", ["a"])).toEqual({ kind: "touch" });
  });

  test("changed content reuses the vectors of chunks whose text did not change", () => {
    const plan = planNoteUpdate(record("old", ["a", "b"]), "new", ["a", "c"]);
    expect(plan.kind).toBe("embed");
    if (plan.kind !== "embed") return;
    expect(Array.from(plan.reuse[0]!)).toEqual([1, 1]);
    expect(plan.reuse[1]).toBeNull();
    expect(plan.missing).toEqual([1]);
  });

  test("vectors from removed or renamed notes are reused when the text matches", () => {
    const recycled = recycleChunks([record("h", ["moved"]), undefined]);
    const plan = planNoteUpdate(undefined, "h", ["moved", "fresh"], recycled);
    expect(plan).toMatchObject({ kind: "embed", missing: [1] });
  });
});
