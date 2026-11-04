import { logger } from "$/shared/logger";
import { Notice } from "obsidian";

/** Electron's shell, which Obsidian's renderer can require. Only openPath is used. */
const { shell } = require("electron") as {
  shell: { openPath(path: string): Promise<string> };
};

/**
 * Opens a folder in the system's file explorer. Electron passes the path to
 * the OS directly, so unlike a shell command, characters in it (%, $, quotes)
 * are never interpreted.
 */
export function openFolder(folderPath: string): void {
  void shell.openPath(folderPath).then((error) => {
    if (error) {
      const message = `Failed to open folder: ${error}`;
      logger.error(message, { folderPath });
      new Notice(message);
    }
  });
}
