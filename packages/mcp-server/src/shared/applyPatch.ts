import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { LocalRestAPI } from "shared";
import { buildPatchInstruction } from "./buildPatchInstruction";
import { makeRequest } from "./makeRequest";
import {
  formatHeadingPath,
  listHeadingPaths,
  resolveHeadingPath,
  type HeadingPath,
} from "./resolveHeadingTarget";

const MAX_LISTED_HEADINGS = 60;

const listPaths = (paths: HeadingPath[]): string => {
  const shown = paths.slice(0, MAX_LISTED_HEADINGS).map(
    (p) => `  ${formatHeadingPath(p)}`,
  );
  if (paths.length > MAX_LISTED_HEADINGS) {
    shown.push(`  … and ${paths.length - MAX_LISTED_HEADINGS} more`);
  }
  return shown.join("\n");
};

/**
 * Runs one PATCH against `endpoint` (`/vault/<encoded path>` or `/active/`).
 *
 * For heading targets the document map is fetched first so that a partial
 * heading path can be widened to the full path the engine needs, and so that a
 * heading that does not exist is reported as an error instead of being
 * recreated at the end of the file. The map's `version` is sent as `ifMatch`,
 * so the edit is refused if the note changed between the two requests.
 *
 * Returns the MCP tool result: a status line, notes about what was matched,
 * and the patched document.
 */
export async function applyPatch(
  endpoint: string,
  label: string,
  args: LocalRestAPI.ApiPatchParametersType,
) {
  const instruction = buildPatchInstruction(args);
  const notes: string[] = [];

  if (
    instruction.targetType === "heading" &&
    Array.isArray(instruction.target) &&
    instruction.target.length > 0
  ) {
    const requested = instruction.target;
    const map = await makeRequest(LocalRestAPI.ApiDocumentMapResponse, endpoint, {
      headers: { Accept: LocalRestAPI.MIME_TYPE_OLRAPI_DOCUMENT_MAP_JSON },
    });
    const paths = listHeadingPaths(map.headings);
    const resolution = resolveHeadingPath(paths, requested);
    const shown = formatHeadingPath(requested);

    switch (resolution.kind) {
      case "exact":
        notes.push(`Matched heading: ${shown}`);
        break;
      case "suffix":
        instruction.target = resolution.path;
        notes.push(
          `Resolved heading ${shown} to ${formatHeadingPath(resolution.path)}`,
        );
        break;
      case "ambiguous":
        throw new McpError(
          ErrorCode.InvalidParams,
          `Heading target ${shown} is ambiguous in ${label}; nothing was written. ` +
            `Pass one of these full paths as target:\n${listPaths(resolution.candidates)}`,
        );
      case "absent":
        if (instruction.createTargetIfMissing) {
          notes.push(
            `Heading ${shown} does not exist; creating it from the top level (createTargetIfMissing)`,
          );
          break;
        }
        throw new McpError(
          ErrorCode.InvalidParams,
          `Heading target ${shown} was not found in ${label}; nothing was written. ` +
            (paths.length
              ? `Existing headings:\n${listPaths(paths)}\n`
              : "The document has no headings. ") +
            "Pass the full path of an existing heading, or set createTargetIfMissing: true to create this one.",
        );
    }
    instruction.ifMatch = map.version;
  }

  const response = await makeRequest(LocalRestAPI.ApiContentResponse, endpoint, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(instruction),
  });

  return {
    content: [
      { type: "text" as const, text: "File patched successfully" },
      ...notes.map((text) => ({ type: "text" as const, text })),
      { type: "text" as const, text: response },
    ],
  };
}
