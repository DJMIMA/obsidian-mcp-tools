import type { HttpFn, HttpRequest, HttpResponse } from "./types";

/**
 * "bad-request": this request's content was rejected (400, 413, 422), so it is resent note by note.
 * "fatal": the request itself is wrong (404 model or URL, 405, other 4xx), so the run stops.
 */
export type EmbeddingErrorKind =
  | "auth"
  | "rate-limit"
  | "timeout"
  | "server"
  | "network"
  | "bad-request"
  | "fatal"
  | "bad-response";

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly kind: EmbeddingErrorKind,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }

  get retryable(): boolean {
    return this.kind === "rate-limit" || this.kind === "timeout" || this.kind === "server" || this.kind === "network";
  }
}

export function parseRetryAfter(headers: Record<string, string>, now: number = Date.now()): number | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after");
  if (!entry) return undefined;
  const seconds = Number(entry[1]);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(entry[1]);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function errorFromResponse(provider: string, response: HttpResponse): EmbeddingError {
  const detail = response.text.trim().slice(0, 300);
  const message = `${provider} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
  if (response.status === 401 || response.status === 403) return new EmbeddingError(message, "auth");
  if (response.status === 429) return new EmbeddingError(message, "rate-limit", parseRetryAfter(response.headers));
  if (response.status === 408) return new EmbeddingError(message, "timeout", parseRetryAfter(response.headers));
  if (response.status >= 500) return new EmbeddingError(message, "server", parseRetryAfter(response.headers));
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    return new EmbeddingError(message, "bad-request");
  }
  return new EmbeddingError(message, "fatal");
}

/** Sends the request and turns a missing response or a non-2xx status into an EmbeddingError. */
export async function send(provider: string, http: HttpFn, request: HttpRequest): Promise<HttpResponse> {
  let response: HttpResponse;
  try {
    response = await http(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EmbeddingError(`${provider} request failed: ${reason}`, "network");
  }
  if (response.status < 200 || response.status >= 300) throw errorFromResponse(provider, response);
  return response;
}

export function parseJson(provider: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EmbeddingError(`${provider} returned a body that is not JSON`, "bad-response");
  }
}

export function toVector(provider: string, value: unknown, expectedDimension: number | null): Float32Array {
  if (!Array.isArray(value) || value.some((n) => typeof n !== "number")) {
    throw new EmbeddingError(`${provider} returned an embedding that is not a list of numbers`, "bad-response");
  }
  if (expectedDimension !== null && value.length !== expectedDimension) {
    throw new EmbeddingError(
      `${provider} returned ${value.length} dimensions, expected ${expectedDimension}`,
      "bad-response",
    );
  }
  return Float32Array.from(value as number[]);
}
