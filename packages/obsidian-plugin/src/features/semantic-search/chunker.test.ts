import { describe, expect, test } from "bun:test";
import { chunkNote, splitText, type HeadingInfo } from "./chunker";

const h = (heading: string, level: number, line: number): HeadingInfo => ({
  heading,
  level,
  line,
  endLine: line,
});

const base = { frontmatterEndLine: null, maxChunkChars: 4000 };

describe("chunkNote", () => {
  test("a note without headings is one chunk named after the file", () => {
    const chunks = chunkNote({ ...base, path: "a/b/Note.md", content: "hello\n\nworld", headings: [] });
    expect(chunks).toEqual([
      { breadcrumbs: "Note", text: "hello\n\nworld", embedText: "Note\n\nhello\n\nworld" },
    ]);
  });

  test("frontmatter is left out", () => {
    const chunks = chunkNote({
      ...base,
      path: "Note.md",
      content: "---\ntags: [x]\n---\nbody",
      headings: [],
      frontmatterEndLine: 2,
    });
    expect(chunks.map((c) => c.text)).toEqual(["body"]);
  });

  test("text before the first heading, then one chunk per heading with its path", () => {
    const content = ["intro", "# Title", "t body", "## A", "a body", "### A1", "a1 body", "## B", "b body"].join("\n");
    const headings = [h("Title", 1, 1), h("A", 2, 3), h("A1", 3, 5), h("B", 2, 7)];
    const chunks = chunkNote({ ...base, path: "Note.md", content, headings });
    expect(chunks.map((c) => [c.breadcrumbs, c.text])).toEqual([
      ["Note", "intro"],
      ["Note > Title", "# Title\nt body"],
      ["Note > Title > A", "## A\na body"],
      ["Note > Title > A > A1", "### A1\na1 body"],
      ["Note > Title > B", "## B\nb body"],
    ]);
  });

  test("headings with no body of their own are not embedded", () => {
    const content = "# Title\n## Empty\n\n## Full\nx";
    const headings = [h("Title", 1, 0), h("Empty", 2, 1), h("Full", 2, 3)];
    const chunks = chunkNote({ ...base, path: "Note.md", content, headings });
    expect(chunks.map((c) => c.breadcrumbs)).toEqual(["Note > Title > Full"]);
  });

  test("emoji, full-width brackets and slashes in headings are kept as written", () => {
    const content = "# 📝 本日の振り返り（事実）\n## 個人/家族\n子供が発熱";
    const headings = [h("📝 本日の振り返り（事実）", 1, 0), h("個人/家族", 2, 1)];
    const chunks = chunkNote({ ...base, path: "Daily log/2026-09-03.md", content, headings });
    expect(chunks[0].breadcrumbs).toBe("2026-09-03 > 📝 本日の振り返り（事実） > 個人/家族");
    expect(chunks[0].embedText).toBe(
      "2026-09-03 > 📝 本日の振り返り（事実） > 個人/家族\n\n## 個人/家族\n子供が発熱",
    );
  });

  test("a long section is split at blank lines and every part keeps the breadcrumbs", () => {
    const content = "## H\naaaaaaaaaa\n\nbbbbbbbbbb\n\ncccccccccc";
    const chunks = chunkNote({ ...base, maxChunkChars: 20, path: "Note.md", content, headings: [h("H", 2, 0)] });
    expect(chunks.map((c) => c.text)).toEqual(["## H\naaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
    expect(new Set(chunks.map((c) => c.breadcrumbs))).toEqual(new Set(["Note > H"]));
  });

  test("a note with only frontmatter has no chunks", () => {
    const chunks = chunkNote({ ...base, path: "Note.md", content: "---\na: 1\n---\n", headings: [], frontmatterEndLine: 2 });
    expect(chunks).toEqual([]);
  });

  // Review Focus 1: Obsidian does not list "# ..." inside code blocks as a heading.
  test("lines that look like headings but are not in the heading list stay in the body", () => {
    const content = "# Setup\n```bash\n# not a heading\necho hi\n```";
    const chunks = chunkNote({ ...base, path: "Note.md", content, headings: [h("Setup", 1, 0)] });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("# not a heading");
  });

  // Review Focus 2
  test("CRLF line endings leave no carriage returns behind", () => {
    const chunks = chunkNote({ ...base, path: "Note.md", content: "# T\r\nbody\r\n", headings: [h("T", 1, 0)] });
    expect(chunks.map((c) => c.text)).toEqual(["# T\nbody"]);
    expect(chunks[0].embedText.includes("\r")).toBe(false);
  });
});

describe("splitText", () => {
  test("text within the limit is returned as is", () => {
    expect(splitText("short", 10)).toEqual(["short"]);
  });
  test("a single paragraph over the limit is cut at the limit", () => {
    const text = "# H\n" + "x".repeat(25);
    const parts = splitText(text, 10);
    expect(parts.every((p) => p.length <= 10)).toBe(true);
    expect(parts.join("")).toBe(text);
  });
});
