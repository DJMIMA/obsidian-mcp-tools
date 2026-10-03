import { describe, expect, test } from "bun:test";
import { createOpenAiCompatibleProvider, embeddingsUrl } from "./openaiCompatible";
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
const options = {
  baseUrl: "http://localhost:11434/v1/",
  apiKey: () => null,
  model: "e5",
  dimensions: null,
  queryPrefix: "query: ",
  documentPrefix: "passage: ",
  batchSize: 2,
};

describe("OpenAI-compatible provider", () => {
  test("joins the base URL without doubling slashes", () => {
    expect(embeddingsUrl("http://h/v1/")).toBe("http://h/v1/embeddings");
    expect(embeddingsUrl("http://h/v1")).toBe("http://h/v1/embeddings");
  });

  test("adds the prefix for the kind, omits dimensions and auth when unset, and reorders by index", async () => {
    const { http, requests } = stub([
      ok({
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
        usage: { prompt_tokens: 7 },
      }),
    ]);
    const result = await createOpenAiCompatibleProvider({ ...options, http }).embed(["a", "b"], "document");
    expect(requests[0].url).toBe("http://localhost:11434/v1/embeddings");
    expect(requests[0].headers.Authorization).toBeUndefined();
    expect(JSON.parse(requests[0].body)).toEqual({
      model: "e5",
      input: ["passage: a", "passage: b"],
      encoding_format: "float",
    });
    expect(result.vectors.map((v) => Array.from(v))).toEqual([[1, 2], [3, 4]]);
    expect(result.tokens).toBe(7);
  });

  test("sends dimensions and the key when set, and the query prefix for queries", async () => {
    const { http, requests } = stub([ok({ data: [{ index: 0, embedding: [1, 2] }], usage: { total_tokens: 3 } })]);
    const result = await createOpenAiCompatibleProvider({ ...options, apiKey: () => "k", dimensions: 2, http }).embed(["q"], "query");
    expect(requests[0].headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(requests[0].body)).toMatchObject({ input: ["query: q"], dimensions: 2 });
    expect(result.tokens).toBe(3);
  });

  test("reads the API key on every call", async () => {
    const reply = ok({ data: [{ index: 0, embedding: [1, 2] }] });
    const { http, requests } = stub([reply, reply]);
    let key: string | null = null;
    const provider = createOpenAiCompatibleProvider({ ...options, apiKey: () => key, http });
    await provider.embed(["a"], "document");
    key = "k2";
    await provider.embed(["a"], "document");
    expect(requests.map((r) => r.headers.Authorization)).toEqual([undefined, "Bearer k2"]);
  });

  test("vectors of different lengths in one response are a bad response", async () => {
    const { http } = stub([ok({ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1] }] })]);
    await expect(createOpenAiCompatibleProvider({ ...options, http }).embed(["a", "b"], "document")).rejects.toMatchObject({
      kind: "bad-response",
    });
  });

  test("refuses more texts than its batch size", async () => {
    const { http } = stub([]);
    await expect(createOpenAiCompatibleProvider({ ...options, http }).embed(["a", "b", "c"], "document")).rejects.toThrow(
      "at most 2",
    );
  });
});
