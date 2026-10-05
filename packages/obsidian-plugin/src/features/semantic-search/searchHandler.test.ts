import { describe, expect, test } from "bun:test";
import type { SearchIndexStatus } from "shared";
import type { SearchOptions } from "./indexStore";
import { EMPTY_MESSAGE, UNCONFIGURED_MESSAGE, handleSearch, truncateText, type SearchDeps } from "./searchHandler";

const ready: SearchIndexStatus = {
  state: "ready",
  indexedNotes: 2,
  totalNotes: 2,
  failedNotes: 0,
  model: "cohere/embed-v5.0-fast@1024",
};

function deps(overrides: Partial<SearchDeps> = {}) {
  const searches: SearchOptions[] = [];
  const base: SearchDeps = {
    status: () => ready,
    chunkCount: () => 3,
    embedQuery: async () => Float32Array.from([1, 0]),
    search: (_vector, options) => {
      searches.push(options);
      return [{ path: "a.md", breadcrumbs: "a > A", text: "# A\nalpha", score: 0.9 }];
    },
    maxTextChars: () => 300,
    log: () => {},
    now: () => 0,
  };
  return { deps: { ...base, ...overrides }, searches };
}

describe("handleSearch", () => {
  test("returns results and the index status, with limit 20 and 2 sections per note by default", async () => {
    const { deps: d, searches } = deps();
    const response = await handleSearch(JSON.stringify({ query: "alpha" }), d);
    expect(response).toEqual({
      status: 200,
      body: {
        results: [{ path: "a.md", text: "# A\nalpha", score: 0.9, breadcrumbs: "a > A" }],
        index: ready,
      },
    });
    expect(searches[0]).toEqual({ limit: 20, maxPerNote: 2, folders: undefined, excludeFolders: undefined });
  });

  test("passes the filters through and accepts an already-parsed body", async () => {
    const { deps: d, searches } = deps();
    await handleSearch({ query: "x", filter: { limit: 5, maxPerNote: 1, folders: ["日記/"], excludeFolders: ["My Notes/"] } }, d);
    expect(searches[0]).toEqual({ limit: 5, maxPerNote: 1, folders: ["日記/"], excludeFolders: ["My Notes/"] });
  });

  describe("text length", () => {
    const long = `# A\n${"あ".repeat(1000)}`;
    const longHit = deps({
      search: () => [{ path: "a.md", breadcrumbs: "a > A", text: long, score: 0.9 }],
    });
    const run = async (filter: object | undefined, d = longHit.deps) => {
      const response = await handleSearch(JSON.stringify({ query: "x", ...(filter ? { filter } : {}) }), d);
      return (response.body as { results: { text: string; truncated?: boolean; fullChars?: number }[] }).results[0];
    };

    test("cuts to the plugin setting and says how long the section was", async () => {
      const hit = await run(undefined);
      expect(hit.text).toBe(long.slice(0, 300) + "…");
      expect(hit.truncated).toBe(true);
      expect(hit.fullChars).toBe(long.length);
    });

    test("leaves short text untouched, without the flags", async () => {
      const { deps: d } = deps();
      const hit = await run(undefined, d);
      expect(hit).toEqual({ path: "a.md", text: "# A\nalpha", score: 0.9, breadcrumbs: "a > A" });
    });

    test("filter.maxTextChars overrides the setting; 0 returns the whole section", async () => {
      expect((await run({ maxTextChars: 100 })).text).toBe(long.slice(0, 100) + "…");
      const whole = await run({ maxTextChars: 0 });
      expect(whole.text).toBe(long);
      expect(whole.truncated).toBeUndefined();
    });

    test("a setting of 0 returns whole sections", async () => {
      const d = deps({ search: longHit.deps.search, maxTextChars: () => 0 }).deps;
      expect((await run(undefined, d)).text).toBe(long);
    });

    test("does not split a surrogate pair", () => {
      expect(truncateText("ab😀cd", 3)).toEqual({ text: "ab…", truncated: true });
      expect(truncateText("ab😀cd", 4)).toEqual({ text: "ab😀…", truncated: true });
      expect(truncateText("abc", 3)).toEqual({ text: "abc", truncated: false });
    });
  });

  test("rejects a bad request with 400 and the reason", async () => {
    const { deps: d } = deps();
    const badJson = await handleSearch("{", d);
    expect(badJson.status).toBe(400);
    const badLimit = await handleSearch(JSON.stringify({ query: "x", filter: { limit: 51 } }), d);
    expect(badLimit.status).toBe(400);
    expect(JSON.stringify(badLimit.body)).toContain("an integer from 1 to 50");
    expect(JSON.stringify(badLimit.body)).toContain("(was 51)");
    const badCap = await handleSearch(JSON.stringify({ query: "x", filter: { maxPerNote: 0 } }), d);
    expect(badCap.status).toBe(400);
    expect(JSON.stringify(badCap.body)).toContain("maxPerNote");
  });

  test("503 when not configured or nothing is indexed yet", async () => {
    const unconfigured = await handleSearch(JSON.stringify({ query: "x" }), deps({ status: () => ({ ...ready, state: "unconfigured" }) }).deps);
    expect(unconfigured).toEqual({ status: 503, body: { message: UNCONFIGURED_MESSAGE } });
    const empty = await handleSearch(JSON.stringify({ query: "x" }), deps({ chunkCount: () => 0 }).deps);
    expect(empty).toEqual({ status: 503, body: { message: EMPTY_MESSAGE } });
  });

  test("502 with the provider's reason when the query cannot be embedded", async () => {
    const failing = deps({
      embedQuery: async () => {
        throw new Error("Cohere returned HTTP 401: invalid api token");
      },
    }).deps;
    const response = await handleSearch(JSON.stringify({ query: "x" }), failing);
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).toContain("HTTP 401");
  });

  test("still searches while building and reports that state", async () => {
    const building = { ...ready, state: "building" as const, indexedNotes: 1 };
    const response = await handleSearch(JSON.stringify({ query: "x" }), deps({ status: () => building }).deps);
    expect(response.status).toBe(200);
    expect((response.body as { index: SearchIndexStatus }).index.state).toBe("building");
  });
});
