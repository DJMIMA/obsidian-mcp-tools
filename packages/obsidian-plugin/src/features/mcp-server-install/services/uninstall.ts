import { logger } from "$/shared/logger";
import fsp from "fs/promises";
import { Plugin } from "obsidian";
import path from "path";
import { BINARY_NAME } from "../constants";
import { getFileSystemAdapter } from "../utils/getFileSystemAdapter";
import { getPlatform } from "../utils/getPlatform";

/**
 * Removes the MCP server binary. The Claude Desktop entry is removed
 * separately by removeFromClaudeConfig, which knows each platform's path.
 */
export async function uninstallServer(plugin: Plugin): Promise<void> {
  try {
    const adapter = getFileSystemAdapter(plugin);
    if ("error" in adapter) {
      throw new Error(adapter.error);
    }

    // Remove binary
    const platform = getPlatform();
    const binDir = path.join(
      adapter.getBasePath(),
      plugin.app.vault.configDir,
      "plugins",
      plugin.manifest.id,
      "bin",
    );
    const binaryPath = path.join(binDir, BINARY_NAME[platform]);

    try {
      await fsp.unlink(binaryPath);
      logger.info("Removed server binary", { binaryPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // File doesn't exist, continue
    }

    // Remove bin directory if empty
    try {
      await fsp.rmdir(binDir);
      logger.info("Removed empty bin directory", { binDir });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
        throw error;
      }
      // Directory not empty, leave it
    }

    logger.info("Server uninstall complete");
  } catch (error) {
    logger.error("Failed to uninstall server:", { error });
    throw new Error(
      `Failed to uninstall server: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
