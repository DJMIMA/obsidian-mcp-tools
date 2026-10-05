import { type } from "arktype";

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
/** Without a cap, one long note's sections can fill every slot and push other relevant notes out (evaluation 2026-10-03). */
export const SEARCH_MAX_PER_NOTE_DEFAULT = 2;
/** The plugin setting's default: a section without headings can be a whole note, 6,000 characters or more per hit. */
export const SEARCH_MAX_TEXT_CHARS_DEFAULT = 300;
export const SEARCH_MAX_TEXT_CHARS_LIMIT = 20000;

export const searchRequest = type({
  query: type("string>0").describe("A search phrase for semantic search"),
  "filter?": {
    "folders?": type("string[]").describe(
      'Only return results whose vault path starts with one of these prefixes, e.g. ["Public/", "Work/"]. Matching is by string prefix, so "Work" also matches "Workshop/"',
    ),
    "excludeFolders?": type("string[]").describe(
      'Drop results whose vault path starts with one of these prefixes, e.g. ["Private/", "Archive/"]',
    ),
    "limit?": type("1 <= number.integer <= 50").describe(
      "an integer from 1 to 50 (default 20), the maximum number of results to return",
    ),
    "maxPerNote?": type("1 <= number.integer <= 50").describe(
      "an integer from 1 to 50 (default 2), the maximum number of sections returned from one note",
    ),
    "maxTextChars?": type("0 <= number.integer <= 20000").describe(
      "an integer from 0 to 20000, the maximum characters of each result's text; longer sections are cut and marked truncated. 0 returns the whole section. Defaults to the plugin setting (300 unless changed)",
    ),
  },
});
export const jsonSearchRequest = type("string.json.parse").to(searchRequest);

export const searchIndexStatus = type({
  state: "'unconfigured' | 'empty' | 'building' | 'paused' | 'ready'",
  "reason?": "string",
  indexedNotes: "number",
  totalNotes: "number",
  failedNotes: "number",
  model: "string",
});
export type SearchIndexStatus = typeof searchIndexStatus.infer;

export const searchResult = type({
  path: "string",
  text: "string",
  score: "number",
  breadcrumbs: "string",
  /** Present (true) only when text was cut to the character limit. */
  "truncated?": "boolean",
  /** Length of the whole section, present only when text was cut. */
  "fullChars?": "number",
});

const searchResponse = type({
  results: searchResult.array(),
  "index?": searchIndexStatus,
});
export type SearchResponse = typeof searchResponse.infer;
