import { describe, expect, test } from "bun:test";
import { createCohereProvider } from "./cohere";
import type { HttpFn, HttpRequest, HttpResponse } from "./types";

function stub(responses: HttpResponse[]) {
  const requests: HttpRequest[] = [];
  const http: HttpFn = async (request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("no stubbed response");
    return next;
  };
  return { http, requests };
}
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, text: JSON.stringify(body) });

describe("Cohere provider", () => {
  test("sends documents as search_document with the chosen dimension", async () => {
    const { http, requests } = stub([
      ok({ embeddings: { float: [[1, 2], [3, 4]] }, meta: { billed_units: { input_tokens: 12 } } }),
    ]);
    const provider = createCohereProvider({ apiKey: "k", model: "embed-v5.0-fast", dimension: 2, http });
    const result = await provider.embed(["a", "b"], "document");
    expect(requests[0].url).toBe("https://api.cohere.com/v2/embed");
    expect(requests[0].headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(requests[0].body)).toEqual({
      model: "embed-v5.0-fast",
      texts: ["a", "b"],
      input_type: "search_document",
      embedding_types: ["float"],
      output_dimension: 2,
      truncate: "END",
    });
    expect(result.vectors.map((v) => Array.from(v))).toEqual([[1, 2], [3, 4]]);
    expect(result.tokens).toBe(12);
  });

  test("sends queries as search_query", async () => {
    const { http, requests } = stub([ok({ embeddings: { float: [[1, 2]] } })]);
    await createCohereProvider({ apiKey: "k", model: "m", dimension: 2, http }).embed(["q"], "query");
    expect(JSON.parse(requests[0].body).input_type).toBe("search_query");
  });

  test("refuses more than 96 texts and sends nothing for none", async () => {
    const { http, requests } = stub([]);
    const provider = createCohereProvider({ apiKey: "k", model: "m", dimension: 2, http });
    expect(provider.batchSize).toBe(96);
    await expect(provider.embed(new Array(97).fill("x"), "document")).rejects.toThrow("at most 96");
    expect(await provider.embed([], "document")).toEqual({ vectors: [], tokens: 0 });
    expect(requests).toHaveLength(0);
  });

  test("a response with the wrong count or dimension is a bad response", async () => {
    const short = stub([ok({ embeddings: { float: [[1, 2]] } })]);
    await expect(
      createCohereProvider({ apiKey: "k", model: "m", dimension: 2, http: short.http }).embed(["a", "b"], "document"),
    ).rejects.toMatchObject({ kind: "bad-response" });
    const wide = stub([ok({ embeddings: { float: [[1, 2, 3]] } })]);
    await expect(
      createCohereProvider({ apiKey: "k", model: "m", dimension: 2, http: wide.http }).embed(["a"], "document"),
    ).rejects.toMatchObject({ kind: "bad-response" });
  });

  test("HTTP errors are classified", async () => {
    const { http } = stub([{ status: 401, headers: {}, text: "invalid api token" }]);
    await expect(
      createCohereProvider({ apiKey: "bad", model: "m", dimension: 2, http }).embed(["a"], "document"),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});
