import { makeRequest, type ToolRegistry } from "$/shared";
import { type } from "arktype";
import { LocalRestAPI, searchRequest } from "shared";
import { formatSearchResult } from "./formatSearchResult";

export function registerSemanticSearchTools(tools: ToolRegistry) {
  tools.register(
    type({
      name: '"search_vault_smart"',
      arguments: searchRequest,
    }).describe(
      "Semantic search over the vault using the embedding index built by the MCP Tools Obsidian plugin (the embedding provider and model are configured in the plugin settings). Finds sections whose meaning is close to the query even when they share no words with it. Results are per heading section, so one note can appear more than once. Returns { results: [{ path, text, score, breadcrumbs }], index }, where text is the section body and breadcrumbs is 'note > heading > subheading'. limit defaults to 20, max 50. For exact words or phrases use search_vault_simple.",
    ),
    async ({ arguments: args }) => {
      const data = await makeRequest(LocalRestAPI.ApiSmartSearchResponse, `/search/smart`, {
        method: "POST",
        body: JSON.stringify(args),
      });
      return { content: [{ type: "text", text: formatSearchResult(data) }] };
    },
  );
}
