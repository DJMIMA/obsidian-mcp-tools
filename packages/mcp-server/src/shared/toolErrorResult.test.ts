import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { type } from "arktype";
import { describe, expect, test } from "bun:test";
import { ObsidianApiError } from "./describeApiError";
import { describeToolError, toolErrorResult } from "./toolErrorResult";

describe("describeToolError", () => {
  test("uses the description of a Local REST API failure verbatim", () => {
    const error = new ObsidianApiError("File not found: notes/a.md", {
      status: 404,
    });
    expect(describeToolError(error)).toBe("File not found: notes/a.md");
  });

  test("strips the JSON-RPC prefix the SDK adds to an McpError", () => {
    const error = new McpError(
      ErrorCode.InvalidParams,
      "Heading target A is ambiguous",
    );
    expect(describeToolError(error)).toBe("Heading target A is ambiguous");
  });

  test("summarises an arktype validation failure", () => {
    const result = type({ filename: "string" })({ filename: 42 });
    expect(result).toBeInstanceOf(type.errors);
    const text = describeToolError(result);
    expect(text).toContain("filename");
  });

  test("uses the message of a plain error", () => {
    expect(describeToolError(new Error("boom"))).toBe("boom");
  });

  test("falls back to a readable string for a non-error value", () => {
    expect(describeToolError("just a string")).toContain("just a string");
  });

  test("never leaks the API key that is set in the environment", () => {
    const previous = process.env.OBSIDIAN_API_KEY;
    process.env.OBSIDIAN_API_KEY = "super-secret-key-value";
    try {
      const text = describeToolError(
        new Error("Bearer super-secret-key-value rejected"),
      );
      expect(text).not.toContain("super-secret-key-value");
    } finally {
      if (previous === undefined) delete process.env.OBSIDIAN_API_KEY;
      else process.env.OBSIDIAN_API_KEY = previous;
    }
  });
});

describe("toolErrorResult", () => {
  test("returns an MCP tool result flagged as an error", () => {
    const result = toolErrorResult(new Error("boom"));
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
  });
});
