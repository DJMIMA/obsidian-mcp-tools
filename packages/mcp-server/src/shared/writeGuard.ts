import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { folderContaining, LocalRestAPI } from "shared";
import { ObsidianApiError } from "./describeApiError";
import { makeRequest } from "./makeRequest";

/** How long the plugin's answer is reused; a changed Templater setting takes effect within this time. */
const CACHE_MS = 30_000;

let cache: { folders: string[]; at: number } | null = null;

/** For tests: forget the cached folder list. */
export function resetProtectedFoldersCache(): void {
  cache = null;
}

/**
 * The folders whose files Templater runs as code (templates, user scripts,
 * prompts), as the MCP Tools plugin reports them. Fails closed: if the plugin
 * cannot say, nothing is written.
 */
export async function protectedFolders(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.folders;
  try {
    const { folders } = await makeRequest(
      LocalRestAPI.ApiProtectedFoldersResponse,
      "/mcp-tools/protected-folders",
    );
    cache = { folders, at: Date.now() };
    return folders;
  } catch (error) {
    if (error instanceof ObsidianApiError && error.status === 404) {
      throw new McpError(
        ErrorCode.InternalError,
        "Could not check which folders are protected: the MCP Tools plugin's /mcp-tools/protected-folders route is missing. " +
          "Enable the MCP Tools plugin in Obsidian (and update it if it is older than this server). Nothing was written.",
      );
    }
    throw error;
  }
}

/**
 * Refuses a write to `path` when it is inside a protected folder. A
 * prompt-injected model could otherwise plant code in a template that
 * Templater later runs, through execute_template or when the user applies it.
 */
export async function assertWritable(path: string): Promise<void> {
  const folder = folderContaining(path, await protectedFolders());
  if (folder) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Refused to change "${path}": it is inside "${folder}", which holds Templater templates, prompts or user scripts. ` +
        "Templater runs those files as code, so MCP tools cannot create, change or delete them; edit them in Obsidian instead. Nothing was written.",
    );
  }
}

/** The vault path of the file open in Obsidian, so writes to it can be checked and sent to that exact file. */
export async function activeFilePath(): Promise<string> {
  const note = await makeRequest(LocalRestAPI.ApiNoteJson, "/active/", {
    headers: { Accept: LocalRestAPI.MIME_TYPE_OLRAPI_NOTE_JSON },
  });
  return note.path;
}
