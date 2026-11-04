import { folderContaining, PROMPTS_FOLDER, vaultPathProblem } from "shared";

/** Templater's folder settings, as stored in its data.json. */
export interface TemplaterFolders {
  templates?: string;
  userScripts?: string;
}

/** A configured folder without surrounding slashes; "" when unset or the vault root. */
function folderOf(setting: string | undefined): string {
  return (setting ?? "").trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Folders MCP tools must not change, because Templater runs their files as
 * code: the templates folder, the user scripts folder and the prompts folder.
 */
export function protectedFolders(folders: TemplaterFolders): string[] {
  return [folderOf(folders.templates), folderOf(folders.userScripts), PROMPTS_FOLDER].filter(
    (folder) => folder !== "",
  );
}

/** Folders whose files /templates/execute may run: templates and prompts, which MCP tools cannot write. */
export function executableFolders(folders: TemplaterFolders): string[] {
  return [folderOf(folders.templates), PROMPTS_FOLDER].filter((folder) => folder !== "");
}

/** Why the template at `path` may not be run from MCP, or null when it may. */
export function templateRefusal(path: string, folders: TemplaterFolders): string | null {
  const allowed = executableFolders(folders);
  if (folderContaining(path, allowed)) return null;
  return (
    `Only templates inside ${allowed.map((folder) => `"${folder}/"`).join(" or ")} can be run from MCP, ` +
    `and "${path}" is not one of them. Move the template there in Obsidian, or set Templater's template folder.`
  );
}

/** Why the rendered output may not be saved at `targetPath`, or null when it may. */
export function targetRefusal(targetPath: string, folders: TemplaterFolders): string | null {
  const problem = vaultPathProblem(targetPath);
  if (problem) return `Refused targetPath "${targetPath}": ${problem}.`;
  const folder = folderContaining(targetPath, protectedFolders(folders));
  if (folder) {
    return `Refused targetPath "${targetPath}": it is inside "${folder}", whose files Templater runs as code.`;
  }
  return null;
}
