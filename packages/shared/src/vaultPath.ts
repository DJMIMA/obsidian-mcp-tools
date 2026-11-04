/**
 * Rules for vault-relative paths that come from an MCP client (in practice,
 * from an LLM) before they reach Obsidian. Shared by the MCP server, which
 * checks every path it puts in a Local REST API URL, and the plugin, which
 * checks the paths /templates/execute reads and writes.
 */

/** The folder under the vault root whose notes are listed as MCP prompts. */
export const PROMPTS_FOLDER = "Prompts";

/** Looks like a Windows 8.3 short name ("TEMPLA~1"), which can alias a longer folder name on disk. */
const SHORT_NAME = /^[^.~\s]{1,6}~\d+(\.[^.\s]{1,3})?$/i;

/**
 * Why `path` is refused, or null for an ordinary vault path.
 *
 * - `.` and `..` segments: `fetch` resolves them before the request leaves, so
 *   `../commands/x` would reach another Local REST API endpoint instead of a file.
 * - Segments starting with `.`: hidden folders such as `.obsidian` (plugin code
 *   and API keys), `.git` (hooks) and `.claude` (agent settings) hold things that
 *   run as code. Obsidian does not show them, so no note lives there.
 * - Backslashes, `:` and control characters: Obsidian forbids them in names,
 *   and on Windows `\` would be another separator that bypasses these checks.
 */
export function vaultPathProblem(path: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(path)) return "it contains a control character";
  if (path.includes("\\")) return "it contains a backslash; separate folders with /";
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") return "it contains a '.' or '..' segment";
    if (segment.startsWith(".")) {
      return `"${segment}" is a hidden file or folder (such as .obsidian or .git), which MCP tools cannot access`;
    }
    if (SHORT_NAME.test(segment)) return `"${segment}" looks like a Windows short (8.3) name`;
  }
  if (path.includes(":")) return "it contains ':'";
  return null;
}

/** A segment as Windows and macOS resolve it on disk: NFC, case-folded, trailing dots and spaces dropped. */
function canonicalSegment(segment: string): string {
  return segment.normalize("NFC").replace(/[. ]+$/, "").toLowerCase();
}

function canonicalSegments(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map(canonicalSegment);
}

/**
 * The first of `folders` that is `path` or contains it, compared the way a
 * case-insensitive file system would see them ("templates./x.md" is inside
 * "Templates"). A folder that is empty or the vault root never matches.
 */
export function folderContaining(path: string, folders: string[]): string | null {
  const target = canonicalSegments(path);
  for (const folder of folders) {
    const prefix = canonicalSegments(folder);
    if (prefix.length === 0 || prefix.length > target.length) continue;
    if (prefix.every((segment, i) => segment === target[i])) return folder;
  }
  return null;
}
