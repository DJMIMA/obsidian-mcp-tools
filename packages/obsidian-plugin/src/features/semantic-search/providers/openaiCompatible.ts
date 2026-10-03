import { EmbeddingError, parseJson, send, toVector } from "./common";
import type { EmbedKind, EmbedResult, EmbeddingProvider, HttpFn } from "./types";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  dimensions: number | null;
  queryPrefix: string;
  documentPrefix: string;
  batchSize: number;
  http: HttpFn;
}

export function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/embeddings`;
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): EmbeddingProvider {
  const name = `Embedding API at ${options.baseUrl}`;
  return {
    batchSize: options.batchSize,
    async embed(texts: string[], kind: EmbedKind): Promise<EmbedResult> {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      if (texts.length > options.batchSize) {
        throw new Error(`${name} accepts at most ${options.batchSize} texts per call (got ${texts.length})`);
      }
      const prefix = kind === "query" ? options.queryPrefix : options.documentPrefix;
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
      if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
      const body: Record<string, unknown> = {
        model: options.model,
        input: texts.map((text) => prefix + text),
        encoding_format: "float",
      };
      if (options.dimensions !== null) body.dimensions = options.dimensions;
      const response = await send(name, options.http, {
        url: embeddingsUrl(options.baseUrl),
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const json = parseJson(name, response.text) as {
        data?: unknown;
        usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
      };
      if (!Array.isArray(json.data) || json.data.length !== texts.length) {
        const got = Array.isArray(json.data) ? json.data.length : "no";
        throw new EmbeddingError(`${name} returned ${got} embeddings for ${texts.length} texts`, "bad-response");
      }
      const rows = (json.data as { index?: unknown; embedding?: unknown }[])
        .slice()
        .sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
      let expected = options.dimensions;
      const vectors = rows.map((row) => {
        const vector = toVector(name, row?.embedding, expected);
        expected = vector.length;
        return vector;
      });
      return {
        vectors,
        tokens: Number(json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0) || 0,
      };
    },
  };
}
