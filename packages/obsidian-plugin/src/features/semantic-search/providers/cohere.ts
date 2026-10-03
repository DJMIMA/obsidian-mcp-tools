import { EmbeddingError, parseJson, send, toVector } from "./common";
import type { EmbedKind, EmbedResult, EmbeddingProvider, HttpFn } from "./types";

export const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";
export const COHERE_BATCH_SIZE = 96;

export interface CohereOptions {
  /** Read on every call, so a key replaced in Obsidian's keychain is used at once. */
  apiKey: () => string;
  model: string;
  dimension: number;
  http: HttpFn;
}

export function createCohereProvider(options: CohereOptions): EmbeddingProvider {
  return {
    batchSize: COHERE_BATCH_SIZE,
    async embed(texts: string[], kind: EmbedKind): Promise<EmbedResult> {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      if (texts.length > COHERE_BATCH_SIZE) {
        throw new Error(`Cohere accepts at most ${COHERE_BATCH_SIZE} texts per call (got ${texts.length})`);
      }
      const response = await send("Cohere", options.http, {
        url: COHERE_EMBED_URL,
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          texts,
          input_type: kind === "query" ? "search_query" : "search_document",
          embedding_types: ["float"],
          output_dimension: options.dimension,
          truncate: "END",
        }),
      });
      const json = parseJson("Cohere", response.text) as {
        embeddings?: { float?: unknown };
        meta?: { billed_units?: { input_tokens?: unknown } };
      };
      const floats = json.embeddings?.float;
      if (!Array.isArray(floats) || floats.length !== texts.length) {
        const got = Array.isArray(floats) ? floats.length : "no";
        throw new EmbeddingError(`Cohere returned ${got} embeddings for ${texts.length} texts`, "bad-response");
      }
      return {
        vectors: floats.map((value) => toVector("Cohere", value, options.dimension)),
        tokens: Number(json.meta?.billed_units?.input_tokens ?? 0) || 0,
      };
    },
  };
}
