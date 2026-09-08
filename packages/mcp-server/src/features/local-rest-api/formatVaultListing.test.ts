import { describe, expect, test } from "bun:test";
import { formatVaultListing } from "./formatVaultListing";

describe("formatVaultListing", () => {
  test("reports how many entries the listing contains", () => {
    const text = formatVaultListing({ files: ["a.md", "b.md", "sub/"] });
    const parsed = JSON.parse(text);

    expect(parsed.count).toBe(3);
    expect(parsed.files).toEqual(["a.md", "b.md", "sub/"]);
  });

  test("reports zero for an empty directory", () => {
    expect(JSON.parse(formatVaultListing({ files: [] })).count).toBe(0);
  });

  test("leaves a single-file response untouched", () => {
    const file = {
      frontmatter: { tags: [] },
      content: "# Note",
      path: "a.md",
      stat: { ctime: 1, mtime: 2, size: 6 },
      tags: [],
    };

    expect(JSON.parse(formatVaultListing(file))).toEqual(file);
  });
});
