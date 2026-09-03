import { describe, expect, test } from "bun:test";
import { encodeVaultPath } from "./encodeVaultPath";

describe("encodeVaultPath", () => {
  test("root-level file is unchanged", () => {
    expect(encodeVaultPath("note.md")).toBe("note.md");
  });

  test("keeps / as a real separator", () => {
    expect(encodeVaultPath("projects/note.md")).toBe("projects/note.md");
  });

  test("encodes spaces inside a segment", () => {
    expect(encodeVaultPath("My Notes/note.md")).toBe("My%20Notes/note.md");
  });

  test("encodes non-ASCII segments", () => {
    expect(encodeVaultPath("日記/2026-09-03.md")).toBe(
      "%E6%97%A5%E8%A8%98/2026-09-03.md",
    );
  });

  test("handles deep nesting", () => {
    expect(encodeVaultPath("a/b/c/note.md")).toBe("a/b/c/note.md");
  });

  test("preserves a trailing slash for directory listings", () => {
    expect(encodeVaultPath("folder/")).toBe("folder/");
  });

  test("encodes characters that would otherwise break the URL", () => {
    expect(encodeVaultPath("q&a/#1 50%.md")).toBe("q%26a/%231%2050%25.md");
  });

  test("never emits %2F", () => {
    expect(encodeVaultPath("a/b/c.md")).not.toContain("%2F");
  });
});
