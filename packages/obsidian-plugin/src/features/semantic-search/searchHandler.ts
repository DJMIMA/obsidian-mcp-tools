import { type } from "arktype";
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_MAX_PER_NOTE_DEFAULT,
  jsonSearchRequest,
  searchRequest,
  type SearchIndexStatus,
  type SearchResponse,
} from "shared";
import type { SearchHit, SearchOptions } from "./indexStore";

export interface SearchDeps {
  status(): SearchIndexStatus;
  chunkCount(): number;
  embedQuery(query: string): Promise<Float32Array>;
  search(vector: Float32Array, options: SearchOptions): SearchHit[];
  /** The plugin setting used when the request gives no maxTextChars; 0 means whole sections. */
  maxTextChars(): number;
  log(message: string, data?: Record<string, unknown>): void;
  now(): number;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

export const UNCONFIGURED_MESSAGE =
  "Semantic search is not configured. Set the embedding provider, model and API key in Obsidian's MCP Tools settings.";
export const EMPTY_MESSAGE =
  'The semantic index has no entries yet. If it has not been built, press "Build index" in Obsidian\'s MCP Tools settings; if it is building, wait a moment and search again.';

/** The body of POST /search/smart. Error bodies are { message } so the MCP server can show the reason. */
export async function handleSearch(body: unknown, deps: SearchDeps): Promise<HandlerResponse> {
  const request = typeof body === "string" ? jsonSearchRequest(body) : searchRequest(body);
  if (request instanceof type.errors) {
    return { status: 400, body: { message: `Invalid search request: ${request.summary}` } };
  }
  const index = deps.status();
  if (index.state === "unconfigured") return { status: 503, body: { message: UNCONFIGURED_MESSAGE } };
  if (deps.chunkCount() === 0) return { status: 503, body: { message: EMPTY_MESSAGE } };

  const started = deps.now();
  let vector: Float32Array;
  try {
    vector = await deps.embedQuery(request.query);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 502, body: { message: `Embedding the query failed: ${reason}` } };
  }
  const embedded = deps.now();
  const hits = deps.search(vector, {
    limit: request.filter?.limit ?? SEARCH_LIMIT_DEFAULT,
    maxPerNote: request.filter?.maxPerNote ?? SEARCH_MAX_PER_NOTE_DEFAULT,
    folders: request.filter?.folders,
    excludeFolders: request.filter?.excludeFolders,
  });
  deps.log("Semantic search", {
    embedMs: Math.round(embedded - started),
    searchMs: Math.round(deps.now() - embedded),
    results: hits.length,
  });
  const maxTextChars = request.filter?.maxTextChars ?? deps.maxTextChars();
  const response: SearchResponse = {
    results: hits.map((hit) => {
      const cut = truncateText(hit.text, maxTextChars);
      return {
        path: hit.path,
        text: cut.text,
        score: hit.score,
        breadcrumbs: hit.breadcrumbs,
        ...(cut.truncated ? { truncated: true, fullChars: hit.text.length } : {}),
      };
    }),
    index,
  };
  return { status: 200, body: response };
}

const ELLIPSIS = "…";

/** Cuts `text` to at most `max` characters before the ellipsis; `max` of 0 (or less) keeps it whole. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (!(max > 0) || text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  // Do not split a surrogate pair (an emoji would turn into a lone half).
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end).trimEnd() + ELLIPSIS, truncated: true };
}
