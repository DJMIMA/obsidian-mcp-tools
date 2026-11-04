import { describe, expect, test } from "bun:test";
import { folderContaining, vaultPathProblem } from "shared";

describe("vaultPathProblem", () => {
  test("accepts ordinary paths", () => {
    for (const path of ["note.md", "My Notes/note.md", "日記/2026-09-03.md", "a/b/c/note.md", "folder/", ""]) {
      expect(vaultPathProblem(path)).toBeNull();
    }
  });

  test("rejects '...' too, since it starts with a dot", () => {
    expect(vaultPathProblem("a/.../b.md")).toContain("hidden");
  });
});

describe("folderContaining", () => {
  const folders = ["Templates", "Scripts/templater", "Prompts"];

  test("matches the folder itself and anything below it", () => {
    expect(folderContaining("Templates/Daily.md", folders)).toBe("Templates");
    expect(folderContaining("Templates", folders)).toBe("Templates");
    expect(folderContaining("Scripts/templater/x.js", folders)).toBe("Scripts/templater");
  });

  test("does not match siblings that share a prefix", () => {
    expect(folderContaining("Templates2/x.md", folders)).toBeNull();
    expect(folderContaining("Scripts/other.js", folders)).toBeNull();
    expect(folderContaining("Daily log/Templates.md", folders)).toBeNull();
  });

  // Windows and macOS resolve these names to the protected folder on disk.
  test("compares case-insensitively and ignores trailing dots and spaces", () => {
    expect(folderContaining("templates/x.md", folders)).toBe("Templates");
    expect(folderContaining("TEMPLATES./x.md", folders)).toBe("Templates");
    expect(folderContaining("Templates /x.md", folders)).toBe("Templates");
    expect(folderContaining("/Templates//x.md", folders)).toBe("Templates");
  });

  test("compares Unicode in NFC", () => {
    const nfd = "テンプレート".normalize("NFD");
    expect(folderContaining(`${nfd}/x.md`, ["テンプレート"])).toBe("テンプレート");
  });

  test("a folder that is empty or the vault root protects nothing", () => {
    expect(folderContaining("note.md", ["", "/"])).toBeNull();
  });
});
