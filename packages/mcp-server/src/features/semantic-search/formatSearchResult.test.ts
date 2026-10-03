import { describe, expect, test } from "bun:test";
import { formatSearchResult } from "./formatSearchResult";

const results = [{ path: "a.md", text: "## A\nalpha", score: 0.5, breadcrumbs: "a > A" }];
const index = {
  indexedNotes: 1200,
  totalNotes: 1803,
  failedNotes: 0,
  model: "cohere/embed-v5.0-fast@1024",
};

describe("formatSearchResult", () => {
  test("returns plain JSON when the index state is unknown or ready", () => {
    const bare = { results };
    expect(formatSearchResult(bare)).toBe(JSON.stringify(bare, null, 2));
    const ready = { results, index: { ...index, state: "ready" as const } };
    expect(formatSearchResult(ready)).toBe(JSON.stringify(ready, null, 2));
  });

  test("puts a warning first while the index is building", () => {
    const data = { results, index: { ...index, state: "building" as const } };
    expect(formatSearchResult(data)).toBe(
      "Index is still building (1200/1803 notes); results may be incomplete.\n\n" +
        JSON.stringify(data, null, 2),
    );
  });

  test("names the reason when the index is paused", () => {
    const data = {
      results,
      index: { ...index, state: "paused" as const, reason: "API key rejected" },
    };
    expect(formatSearchResult(data).split("\n")[0]).toBe(
      "Index is paused (API key rejected); results may be incomplete.",
    );
  });
});
