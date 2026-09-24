import { describe, expect, test } from "bun:test";
import { paginateContent } from "./paginateContent";

const HINT = "<error>Content truncated.";

describe("paginateContent", () => {
  test("returns a short page whole with no more to fetch", () => {
    const page = paginateContent("hello world", 0, 5000);

    expect(page).toEqual({
      text: "hello world",
      totalLength: 11,
      startIndex: 0,
      endIndex: 11,
      hasMore: false,
    });
  });

  test("honours startIndex on a page shorter than maxLength", () => {
    const page = paginateContent("hello world", 6, 5000);

    expect(page.text).toBe("world");
    expect(page.endIndex).toBe(11);
    expect(page.hasMore).toBe(false);
  });

  test("cuts the first page of a long page and points to the next one", () => {
    const content = "a".repeat(10) + "b".repeat(10) + "c".repeat(5);
    const page = paginateContent(content, 0, 10);

    expect(page.totalLength).toBe(25);
    expect(page.startIndex).toBe(0);
    expect(page.endIndex).toBe(10);
    expect(page.hasMore).toBe(true);
    expect(page.text.startsWith("a".repeat(10) + "\n\n" + HINT)).toBe(true);
    expect(page.text).toContain("startIndex of 10 ");
  });

  test("returns the last page without a continuation hint", () => {
    const content = "a".repeat(10) + "b".repeat(10) + "c".repeat(5);
    const page = paginateContent(content, 20, 10);

    expect(page).toEqual({
      text: "ccccc",
      totalLength: 25,
      startIndex: 20,
      endIndex: 25,
      hasMore: false,
    });
  });

  test("treats a page ending exactly at the end as the last page", () => {
    const page = paginateContent("a".repeat(20), 10, 10);

    expect(page.text).toBe("a".repeat(10));
    expect(page.endIndex).toBe(20);
    expect(page.hasMore).toBe(false);
  });

  test("returns an empty page with no more when startIndex is past the end", () => {
    const page = paginateContent("a".repeat(25), 100, 10);

    expect(page).toEqual({
      text: "",
      totalLength: 25,
      startIndex: 100,
      endIndex: 100,
      hasMore: false,
    });
  });

  test("never reports an endIndex before the startIndex", () => {
    const page = paginateContent("a".repeat(25), 26, 10);

    expect(page.endIndex).toBe(26);
    expect(page.endIndex).toBeGreaterThanOrEqual(page.startIndex);
    expect(page.hasMore).toBe(false);
  });

  test("returns an empty last page when startIndex is exactly the end", () => {
    const page = paginateContent("a".repeat(25), 25, 10);

    expect(page.text).toBe("");
    expect(page.endIndex).toBe(25);
    expect(page.hasMore).toBe(false);
  });
});
