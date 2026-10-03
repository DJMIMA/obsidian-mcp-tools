import type { SemanticSearchSettings } from "./features/semantic-search/settings";

declare module "obsidian" {
  interface McpToolsPluginSettings {
    version?: string;
    semanticSearch?: Partial<SemanticSearchSettings>;
  }

  interface Plugin {
    loadData(): Promise<McpToolsPluginSettings>;
    saveData(data: McpToolsPluginSettings): Promise<void>;
  }
}

export {};
