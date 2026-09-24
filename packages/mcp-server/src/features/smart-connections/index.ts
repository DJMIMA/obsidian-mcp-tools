import { makeRequest, type ToolRegistry } from "$/shared";
import { type } from "arktype";
import { LocalRestAPI } from "shared";

export function registerSmartConnectionsTools(tools: ToolRegistry) {
  tools.register(
    type({
      name: '"search_vault_smart"',
      arguments: {
        query: type("string>0").describe("A search phrase for semantic search"),
        "filter?": {
          "folders?": type("string[]").describe(
            'Only return results whose vault path starts with one of these prefixes, e.g. ["Public/", "Work/"]. Matching is by string prefix, so "Work" also matches "Workshop/"',
          ),
          "excludeFolders?": type("string[]").describe(
            'Drop results whose vault path starts with one of these prefixes, e.g. ["Private/", "Archive/"]',
          ),
          "limit?": type("number>0").describe(
            "The maximum number of results to return",
          ),
        },
      },
    }).describe(
      "Semantic search through the Smart Connections plugin: finds notes whose meaning is close to the query even when they share no words with it. Requires Smart Connections to be installed and enabled in Obsidian. Returns { results: [{ path, text, score, breadcrumbs }] }, where text is the matching excerpt and breadcrumbs its heading path. For exact words or phrases use search_vault_simple.",
    ),
    async ({ arguments: args }) => {
      const data = await makeRequest(
        LocalRestAPI.ApiSmartSearchResponse,
        `/search/smart`,
        {
          method: "POST",
          body: JSON.stringify(args),
        },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
