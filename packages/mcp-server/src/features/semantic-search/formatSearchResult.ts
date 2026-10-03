import type { LocalRestAPI, SearchIndexStatus } from "shared";

/** A line telling the caller the index is incomplete, or null when it is complete or unknown. */
export function indexWarning(index: SearchIndexStatus | undefined): string | null {
  if (!index) return null;
  if (index.state === "building") {
    return `Index is still building (${index.indexedNotes}/${index.totalNotes} notes); results may be incomplete.`;
  }
  if (index.state === "paused") {
    return `Index is paused (${index.reason ?? "no reason given"}); results may be incomplete.`;
  }
  return null;
}

export function formatSearchResult(data: LocalRestAPI.ApiSmartSearchResponseType): string {
  const json = JSON.stringify(data, null, 2);
  const warning = indexWarning(data.index);
  return warning ? `${warning}\n\n${json}` : json;
}
