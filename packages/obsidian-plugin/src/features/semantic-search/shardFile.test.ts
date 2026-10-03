import { describe, expect, test } from "bun:test";
import type { NoteRecord } from "./indexStore";
import { decodeShard, encodeShard } from "./shardFile";

const notes: [string, NoteRecord][] = [
  [
    "日記/2026-09-03.md",
    {
      mtime: 1,
      size: 20,
      hash: "h1",
      status: "ok",
      chunks: [
        { breadcrumbs: "2026-09-03 > 個人", text: "## 個人\n発熱", textHash: "t1", vector: Float32Array.from([0.6, 0.8, 0]) },
        { breadcrumbs: "2026-09-03 > 仕事", text: "## 仕事\n外来", textHash: "t2", vector: Float32Array.from([0, 0, 1]) },
      ],
    },
  ],
  ["b.md", { mtime: 2, size: 5, hash: "h2", status: "failed", error: "HTTP 400", chunks: [] }],
  ["empty.md", { mtime: 3, size: 0, hash: "h3", status: "ok", chunks: [] }],
];

describe("shard file", () => {
  test("round-trips records and vectors exactly", () => {
    const decoded = decodeShard(encodeShard({ fingerprint: "fp", dimension: 3, shard: 7, notes }));
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.fingerprint).toBe("fp");
    expect(decoded.dimension).toBe(3);
    expect(decoded.shard).toBe(7);
    expect(decoded.notes).toEqual(notes);
  });

  test("rejects a file with the wrong magic", () => {
    const buffer = encodeShard({ fingerprint: "fp", dimension: 3, shard: 0, notes });
    new Uint8Array(buffer)[0] = 0;
    expect(decodeShard(buffer)).toEqual({ ok: false, reason: "bad magic" });
  });

  test("rejects a truncated file instead of throwing", () => {
    const buffer = encodeShard({ fingerprint: "fp", dimension: 3, shard: 0, notes });
    expect(decodeShard(buffer.slice(0, buffer.byteLength - 8)).ok).toBe(false);
    expect(decodeShard(buffer.slice(0, 20)).ok).toBe(false);
    expect(decodeShard(new ArrayBuffer(4)).ok).toBe(false);
  });

  test("rejects another format version", () => {
    const buffer = encodeShard({ fingerprint: "fp", dimension: 3, shard: 0, notes: [] });
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder().decode(bytes.subarray(12, 12 + new DataView(buffer).getUint32(8, true)));
    const patched = new TextEncoder().encode(text.replace('"formatVersion":1', '"formatVersion":9'));
    bytes.set(patched, 12);
    expect(decodeShard(buffer)).toEqual({ ok: false, reason: "format version 9" });
  });
});
