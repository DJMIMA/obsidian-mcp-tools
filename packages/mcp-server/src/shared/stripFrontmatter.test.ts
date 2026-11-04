import { describe, expect, test } from "bun:test";
import { stripFrontmatter } from "./stripFrontmatter";

describe("stripFrontmatter", () => {
  test("removes a leading frontmatter block", () => {
    expect(stripFrontmatter("---\ntags: [x]\n---\nBody\n")).toBe("Body");
  });

  test("keeps a horizontal rule in the body", () => {
    expect(stripFrontmatter("---\ntags: [x]\n---\nIntro\n\n---\n\nMore")).toBe(
      "Intro\n\n---\n\nMore",
    );
  });

  test("leaves a note without frontmatter as it is", () => {
    expect(stripFrontmatter("Intro\n\n---\n\nMore")).toBe("Intro\n\n---\n\nMore");
  });

  test("handles CRLF line endings", () => {
    expect(stripFrontmatter("---\r\na: 1\r\n---\r\nBody")).toBe("Body");
  });
});
