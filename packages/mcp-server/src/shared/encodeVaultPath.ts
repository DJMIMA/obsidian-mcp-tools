import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { vaultPathProblem } from "shared";

/**
 * Throws an InvalidParams error, which reaches the model as the tool's
 * failure reason, when `path` is not one MCP tools may use (see
 * `vaultPathProblem`: `..`, hidden folders such as `.obsidian` and `.git`,
 * backslashes).
 */
export function assertVaultPath(path: string): void {
  const problem = vaultPathProblem(path);
  if (problem) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Refused vault path "${path}": ${problem}. Pass a path relative to the vault root, e.g. "Projects/Plan.md". Nothing was read or written.`,
    );
  }
}

/**
 * Encodes a vault-relative path for use inside a Local REST API URL path,
 * after checking it with `assertVaultPath`.
 *
 * Local REST API splits `req.path` on literal `/` *before* decoding each
 * segment, so `/` must stay a real separator while everything else inside a
 * segment (spaces, `#`, `?`, `%`, non-ASCII) is percent-encoded. Encoding the
 * whole path with `encodeURIComponent` turns `/` into `%2F`, which the server
 * deliberately refuses to resolve as a file path (see CLAUDE.md, 既知の問題).
 *
 * Empty segments are preserved, so a trailing `/` (directory listing) and a
 * leading `/` survive unchanged.
 */
export function encodeVaultPath(path: string): string {
  assertVaultPath(path);
  return path.split("/").map(encodeURIComponent).join("/");
}
