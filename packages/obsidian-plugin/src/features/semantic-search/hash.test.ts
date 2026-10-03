import { describe, expect, test } from "bun:test";
import { fnv1a32, sha256Hex } from "./hash";

describe("fnv1a32", () => {
  test("matches the reference values", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });
  test("is an unsigned 32-bit integer for non-ASCII paths", () => {
    const value = fnv1a32("日記/2026-09-03.md");
    expect(Number.isInteger(value) && value >= 0 && value < 2 ** 32).toBe(true);
  });
});

describe("sha256Hex", () => {
  test("matches the reference digest", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  test("hashes UTF-8 text", async () => {
    const a = await sha256Hex("日本語");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await sha256Hex("日本"));
  });
});
