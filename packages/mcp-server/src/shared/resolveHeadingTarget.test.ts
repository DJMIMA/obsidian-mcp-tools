import { describe, expect, test } from "bun:test";
import {
  formatHeadingPath,
  listHeadingPaths,
  resolveHeadingPath,
} from "./resolveHeadingTarget";

// Mirrors the document map Local REST API 5.1.0 returns for the bug-report
// fixture (Daily log/2026/_patch_test.md).
const tree = {
  Title: {
    Plain: {},
    "📝 本日の振り返り（事実）": {
      臨床: {},
      "個人/家族": {},
      AB: {},
    },
    "💡 Next": {},
  },
};
const paths = listHeadingPaths(tree);

describe("listHeadingPaths", () => {
  test("flattens the tree into full paths in document order", () => {
    expect(paths).toEqual([
      ["Title"],
      ["Title", "Plain"],
      ["Title", "📝 本日の振り返り（事実）"],
      ["Title", "📝 本日の振り返り（事実）", "臨床"],
      ["Title", "📝 本日の振り返り（事実）", "個人/家族"],
      ["Title", "📝 本日の振り返り（事実）", "AB"],
      ["Title", "💡 Next"],
    ]);
  });

  test("tolerates a missing or malformed tree", () => {
    expect(listHeadingPaths(undefined)).toEqual([]);
    expect(listHeadingPaths(null)).toEqual([]);
    expect(listHeadingPaths([])).toEqual([]);
    expect(listHeadingPaths({})).toEqual([]);
  });
});

describe("resolveHeadingPath", () => {
  test("H1 by leaf text is an exact match", () => {
    expect(resolveHeadingPath(paths, ["Title"])).toEqual({
      kind: "exact",
      path: ["Title"],
    });
  });

  test("H2 by leaf text widens to the full path", () => {
    expect(resolveHeadingPath(paths, ["Plain"])).toEqual({
      kind: "suffix",
      path: ["Title", "Plain"],
    });
  });

  test("H3 by leaf text widens to the full path", () => {
    expect(resolveHeadingPath(paths, ["AB"])).toEqual({
      kind: "suffix",
      path: ["Title", "📝 本日の振り返り（事実）", "AB"],
    });
  });

  test("a partial H2::H3 path widens to the full path", () => {
    expect(
      resolveHeadingPath(paths, ["📝 本日の振り返り（事実）", "AB"]),
    ).toEqual({
      kind: "suffix",
      path: ["Title", "📝 本日の振り返り（事実）", "AB"],
    });
  });

  test("a full path is an exact match", () => {
    expect(
      resolveHeadingPath(paths, ["Title", "📝 本日の振り返り（事実）", "AB"]),
    ).toEqual({
      kind: "exact",
      path: ["Title", "📝 本日の振り返り（事実）", "AB"],
    });
  });

  test("headings containing '/' resolve", () => {
    expect(resolveHeadingPath(paths, ["個人/家族"])).toEqual({
      kind: "suffix",
      path: ["Title", "📝 本日の振り返り（事実）", "個人/家族"],
    });
  });

  test("headings with emoji and full-width parentheses resolve", () => {
    expect(resolveHeadingPath(paths, ["📝 本日の振り返り（事実）"])).toEqual({
      kind: "suffix",
      path: ["Title", "📝 本日の振り返り（事実）"],
    });
  });

  test("the empty path is the document root", () => {
    expect(resolveHeadingPath(paths, [])).toEqual({ kind: "exact", path: [] });
  });

  test("a heading that is not in the document is absent", () => {
    expect(resolveHeadingPath(paths, ["Nope"])).toEqual({ kind: "absent" });
    expect(resolveHeadingPath(paths, ["Title", "Nope"])).toEqual({
      kind: "absent",
    });
  });

  test("a partial path must match the tail, not the middle", () => {
    // "Title::📝…" is a prefix, not a suffix, of the H3 paths.
    expect(
      resolveHeadingPath(paths, ["Title", "AB"]),
    ).toEqual({ kind: "absent" });
  });

  test("duplicate heading text at different levels is ambiguous", () => {
    const dup = listHeadingPaths({
      Log: { Notes: {} },
      Archive: { Log: { Notes: {} } },
    });
    expect(resolveHeadingPath(dup, ["Notes"])).toEqual({
      kind: "ambiguous",
      candidates: [
        ["Log", "Notes"],
        ["Archive", "Log", "Notes"],
      ],
    });
    // Same text at different depths, requested as its own full path: exact.
    expect(resolveHeadingPath(dup, ["Log"])).toEqual({
      kind: "exact",
      path: ["Log"],
    });
    // Disambiguated by one more ancestor.
    expect(resolveHeadingPath(dup, ["Archive", "Log", "Notes"])).toEqual({
      kind: "exact",
      path: ["Archive", "Log", "Notes"],
    });
    expect(resolveHeadingPath(dup, ["Log", "Notes"])).toEqual({
      kind: "exact",
      path: ["Log", "Notes"],
    });
  });

  test("matching is exact on text (no trimming or case folding)", () => {
    expect(resolveHeadingPath(paths, ["plain"])).toEqual({ kind: "absent" });
    expect(resolveHeadingPath(paths, [" Plain"])).toEqual({ kind: "absent" });
  });
});

describe("formatHeadingPath", () => {
  test("joins with :: so the output can be sent back as a target", () => {
    expect(formatHeadingPath(["Title", "Plain"])).toBe("Title::Plain");
    expect(formatHeadingPath([])).toBe("(document root)");
  });

  test("falls back to JSON when a segment contains ::", () => {
    expect(formatHeadingPath(["A::B", "C"])).toBe('["A::B","C"]');
  });
});
