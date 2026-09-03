import { describe, expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { buildPatchInstruction } from "./buildPatchInstruction";

describe("buildPatchInstruction", () => {
  test("splits a '::'-joined heading path into an array and does not create missing targets by default", () => {
    expect(
      buildPatchInstruction({
        operation: "append",
        targetType: "heading",
        target: "Heading 1::Subheading 1:1",
        content: "Hello",
      }),
    ).toEqual({
      targetType: "heading",
      target: ["Heading 1", "Subheading 1:1"],
      operation: "append",
      content: "Hello",
    });
  });

  test("passes an array heading target through unchanged", () => {
    const result = buildPatchInstruction({
      operation: "replace",
      targetType: "heading",
      target: ["A::B", "C"],
      content: "x",
    });
    expect(result.target).toEqual(["A::B", "C"]);
  });

  test("honours a custom delimiter and trimTargetWhitespace", () => {
    const result = buildPatchInstruction({
      operation: "append",
      targetType: "heading",
      target: " A / B ",
      targetDelimiter: "/",
      trimTargetWhitespace: true,
      content: "x",
    });
    expect(result.target).toEqual(["A", "B"]);
  });

  test("keeps segment whitespace when trimTargetWhitespace is not set", () => {
    const result = buildPatchInstruction({
      operation: "append",
      targetType: "heading",
      target: " A :: B",
      content: "x",
    });
    expect(result.target).toEqual([" A ", " B"]);
  });

  test("an empty heading target addresses the document root", () => {
    const result = buildPatchInstruction({
      operation: "append",
      targetType: "heading",
      target: "",
      content: "x",
    });
    expect(result.target).toEqual([]);
  });

  test("strips a leading ^ from a block id", () => {
    const result = buildPatchInstruction({
      operation: "append",
      targetType: "block",
      target: "^abc123",
      content: "x",
    });
    expect(result.target).toBe("abc123");
  });

  test("rejects an array target for non-heading types", () => {
    expect(() =>
      buildPatchInstruction({
        operation: "append",
        targetType: "block",
        target: ["a"],
        content: "x",
      }),
    ).toThrow(McpError);
  });

  test("frontmatter text content is sent as a string value", () => {
    const result = buildPatchInstruction({
      operation: "replace",
      targetType: "frontmatter",
      target: "status",
      content: "done",
    });
    expect(result).toMatchObject({ value: "done" });
    expect(result.content).toBeUndefined();
  });

  test("application/json content is parsed into value", () => {
    const result = buildPatchInstruction({
      operation: "replace",
      targetType: "frontmatter",
      target: "tags",
      content: '["a","b"]',
      contentType: "application/json",
    });
    expect(result.value).toEqual(["a", "b"]);
  });

  test("invalid JSON content with application/json is rejected", () => {
    expect(() =>
      buildPatchInstruction({
        operation: "replace",
        targetType: "frontmatter",
        target: "tags",
        content: "not json",
        contentType: "application/json",
      }),
    ).toThrow(McpError);
  });

  test("delete needs no content and does not create targets", () => {
    const result = buildPatchInstruction({
      operation: "delete",
      targetType: "heading",
      target: "Old",
    });
    expect(result).toEqual({
      targetType: "heading",
      target: ["Old"],
      operation: "delete",
    });
  });

  test("content is required for non-delete operations", () => {
    expect(() =>
      buildPatchInstruction({
        operation: "append",
        targetType: "heading",
        target: "A",
      }),
    ).toThrow(McpError);
  });

  test("scope and rejectIfContentPreexists pass through", () => {
    const result = buildPatchInstruction({
      operation: "replace",
      targetType: "heading",
      target: "A",
      scope: "marker",
      content: "New name",
      rejectIfContentPreexists: true,
    });
    expect(result).toMatchObject({
      scope: "marker",
      rejectIfContentPreexists: true,
    });
  });

  test("within does not enable createTargetIfMissing", () => {
    const result = buildPatchInstruction({
      operation: "append",
      targetType: "heading",
      target: "Log",
      within: -1,
      content: "\n- item",
    });
    expect(result.within).toBe(-1);
    expect(result.createTargetIfMissing).toBeUndefined();
  });

  test("within combined with createTargetIfMissing is rejected", () => {
    expect(() =>
      buildPatchInstruction({
        operation: "append",
        targetType: "heading",
        target: "Log",
        within: 0,
        createTargetIfMissing: true,
        content: "x",
      }),
    ).toThrow(McpError);
  });

  test("createTargetIfMissing must be opted into explicitly", () => {
    const off = buildPatchInstruction({
      operation: "append",
      targetType: "heading",
      target: "A",
      content: "x",
      createTargetIfMissing: false,
    });
    expect(off.createTargetIfMissing).toBeUndefined();
    const on = buildPatchInstruction({
      operation: "append",
      targetType: "heading",
      target: "A",
      content: "x",
      createTargetIfMissing: true,
    });
    expect(on.createTargetIfMissing).toBe(true);
  });
});
