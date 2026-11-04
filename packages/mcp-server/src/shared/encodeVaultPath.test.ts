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

  // fetch resolves dot segments before sending, so "../commands/x" would
  // reach POST /commands/x instead of a file.
  test.each([
    "../commands/app:reload",
    "../active/",
    "Prompts/../secret.md",
    "a/./b.md",
    "..",
  ])("refuses dot segments: %s", (path) => {
    expect(() => encodeVaultPath(path)).toThrow("Refused vault path");
  });

  test.each([
    ".obsidian/plugins/obsidian-local-rest-api/data.json",
    ".git/hooks/post-commit",
    "notes/.claude/settings.json",
    ".hidden.md",
  ])("refuses hidden files and folders: %s", (path) => {
    expect(() => encodeVaultPath(path)).toThrow("hidden file or folder");
  });

  test.each([
    ["..\\..\\outside.md", "backslash"],
    ["C:/Windows/win.ini", "':'"],
    ["a\u0000b.md", "control character"],
    ["TEMPLA~1/x.md", "short (8.3) name"],
  ])("refuses %s", (path, reason) => {
    expect(() => encodeVaultPath(path)).toThrow(reason);
  });

  test("allows dots inside names", () => {
    expect(encodeVaultPath("v1.2/notes.v2.md")).toBe("v1.2/notes.v2.md");
  });
});
