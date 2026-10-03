import { describe, expect, test } from "bun:test";
import type { SearchIndexStatus } from "shared";
import type { SearchOptions } from "./indexStore";
import { EMPTY_MESSAGE, UNCONFIGURED_MESSAGE, handleSearch, type SearchDeps } from "./searchHandler";

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
    log: () => {},
    now: () => 0,
  };
  return { deps: { ...base, ...overrides }, searches };
}

describe("handleSearch", () => {
  test("returns results and the index status, with limit 20 by default", async () => {
    const { deps: d, searches } = deps();
    const response = await handleSearch(JSON.stringify({ query: "alpha" }), d);
    expect(response).toEqual({
      status: 200,
      body: {
        results: [{ path: "a.md", text: "# A\nalpha", score: 0.9, breadcrumbs: "a > A" }],
        index: ready,
      },
    });
    expect(searches[0]).toEqual({ limit: 20, folders: undefined, excludeFolders: undefined });
  });

  test("passes the filters through and accepts an already-parsed body", async () => {
    const { deps: d, searches } = deps();
    await handleSearch({ query: "x", filter: { limit: 5, folders: ["日記/"], excludeFolders: ["My Notes/"] } }, d);
    expect(searches[0]).toEqual({ limit: 5, folders: ["日記/"], excludeFolders: ["My Notes/"] });
  });

  test("rejects a bad request with 400 and the reason", async () => {
    const { deps: d } = deps();
    const badJson = await handleSearch("{", d);
    expect(badJson.status).toBe(400);
    const badLimit = await handleSearch(JSON.stringify({ query: "x", filter: { limit: 51 } }), d);
    expect(badLimit.status).toBe(400);
    expect(JSON.stringify(badLimit.body)).toContain("an integer from 1 to 50");
    expect(JSON.stringify(badLimit.body)).toContain("(was 51)");
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
