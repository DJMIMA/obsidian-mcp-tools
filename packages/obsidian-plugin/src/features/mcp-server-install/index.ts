import { Plugin } from "obsidian";
import type { SetupResult } from "./types";

export async function setup(plugin: Plugin): Promise<SetupResult> {
  try {
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Re-export types and utilities that should be available to other features
export { default as FeatureSettings } from "./components/McpServerInstallSettings.svelte";
export * from "./constants";
export { removeFromClaudeConfig, updateClaudeConfig } from "./services/config";
export { uninstallServer } from "./services/uninstall";
export * from "./types";
