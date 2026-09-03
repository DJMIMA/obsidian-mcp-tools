import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { LocalRestAPI } from "shared";

/**
 * A markdown-patch 2.0 instruction: the JSON body Local REST API 5.x expects
 * on `PATCH /vault/{path}` and `PATCH /active/`. Field meanings are documented
 * in the upstream OpenAPI `PatchInstruction` schema. Heading moves (`scope:
 * "parent"` + `destination`) are not exposed by this tool set; `ifMatch` is filled in
 * by the caller from the document map, not from tool arguments.
 */
export interface PatchInstruction {
  targetType: "heading" | "block" | "frontmatter";
  target: string | string[];
  operation: "replace" | "prepend" | "append" | "delete";
  scope?: "content" | "marker" | "markerAndContent";
  within?: number;
  content?: string;
  value?: unknown;
  createTargetIfMissing?: boolean;
  rejectIfContentPreexists?: boolean;
  /** Document-map `version` token; the engine rejects the edit if the file changed. */
  ifMatch?: string;
}

const DEFAULT_HEADING_DELIMITER = "::";

const invalid = (message: string) =>
  new McpError(ErrorCode.InvalidParams, message);

/**
 * Translates the MCP tool arguments (which keep the original 1.x-flavoured
 * shape: a `::`-joined heading path, `contentType`, `trimTargetWhitespace`)
 * into a 2.0 instruction. Throws `McpError(InvalidParams)` for combinations
 * the engine would reject anyway, so the caller gets a clear message instead
 * of a 400 body.
 */
export function buildPatchInstruction(
  args: LocalRestAPI.ApiPatchParametersType,
): PatchInstruction {
  // --- target ---
  let target: string | string[];
  if (args.targetType === "heading") {
    if (Array.isArray(args.target)) {
      target = args.target;
    } else if (args.target === "") {
      target = []; // document root
    } else {
      const delimiter = args.targetDelimiter || DEFAULT_HEADING_DELIMITER;
      const segments = args.target.split(delimiter);
      target = args.trimTargetWhitespace
        ? segments.map((s) => s.trim())
        : segments;
    }
  } else {
    if (Array.isArray(args.target)) {
      throw invalid(
        `target must be a single string for targetType "${args.targetType}"`,
      );
    }
    // 2.0 addresses a block by its bare id; tolerate a leading "^".
    target =
      args.targetType === "block" ? args.target.replace(/^\^/, "") : args.target;
  }

  const instruction: PatchInstruction = {
    targetType: args.targetType,
    target,
    operation: args.operation,
  };
  if (args.scope) instruction.scope = args.scope;
  if (args.within !== undefined) {
    if (args.targetType !== "heading") {
      throw invalid('within is only valid for targetType "heading"');
    }
    if (!Number.isInteger(args.within)) {
      throw invalid("within must be an integer index");
    }
    instruction.within = args.within;
  }

  // --- payload: exactly one of content / value, or none for delete ---
  if (args.operation !== "delete") {
    if (args.content === undefined) {
      throw invalid(`content is required for operation "${args.operation}"`);
    }
    if (args.contentType === "application/json") {
      try {
        instruction.value = JSON.parse(args.content);
      } catch {
        throw invalid(
          "content is not valid JSON (contentType is application/json)",
        );
      }
    } else if (args.targetType === "frontmatter") {
      // A frontmatter payload is always a value; plain text is stored as a string.
      instruction.value = args.content;
    } else {
      instruction.content = args.content;
    }
  }

  // --- flags ---
  // Creating a missing target is opt-in. With the old default (true) a heading
  // path that merely failed to resolve was silently materialised as a new
  // heading tree at the end of the file, which corrupted real notes.
  if (args.within !== undefined && args.createTargetIfMissing === true) {
    throw invalid("createTargetIfMissing cannot be combined with within");
  }
  if (args.createTargetIfMissing === true) {
    instruction.createTargetIfMissing = true;
  }
  if (args.rejectIfContentPreexists) instruction.rejectIfContentPreexists = true;

  return instruction;
}
