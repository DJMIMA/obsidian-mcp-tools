export type EmbedKind = "document" | "query";

export interface EmbedResult {
  vectors: Float32Array[];
  /** Tokens billed for the call, 0 when the API does not say. */
  tokens: number;
}

export interface EmbeddingProvider {
  /** Largest number of texts a single embed() call may carry. One call is one HTTP request. */
  readonly batchSize: number;
  embed(texts: string[], kind: EmbedKind): Promise<EmbedResult>;
}

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** Sends one request. Resolves for every status code; rejects only when no response arrived. */
export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;
