import { describe, expect, test } from "bun:test";
import { EmbeddingError, errorFromResponse, parseRetryAfter, send } from "./common";

const response = (status: number, headers: Record<string, string> = {}) => ({ status, headers, text: "detail" });

describe("errorFromResponse", () => {
  test("classifies status codes", () => {
    expect(errorFromResponse("X", response(401)).kind).toBe("auth");
    expect(errorFromResponse("X", response(403)).kind).toBe("auth");
    expect(errorFromResponse("X", response(429)).kind).toBe("rate-limit");
    expect(errorFromResponse("X", response(503)).kind).toBe("server");
    expect(errorFromResponse("X", response(400)).kind).toBe("bad-request");
  });
  test("only rate limits, server errors and network failures are retryable", () => {
    expect(errorFromResponse("X", response(429)).retryable).toBe(true);
    expect(errorFromResponse("X", response(500)).retryable).toBe(true);
    expect(errorFromResponse("X", response(400)).retryable).toBe(false);
    expect(errorFromResponse("X", response(401)).retryable).toBe(false);
  });
  test("the message names the provider, status and body", () => {
    expect(errorFromResponse("Cohere", response(400)).message).toBe("Cohere returned HTTP 400: detail");
  });
});

describe("parseRetryAfter", () => {
  test("reads seconds and HTTP dates, case-insensitively", () => {
    expect(parseRetryAfter({ "Retry-After": "3" })).toBe(3000);
    expect(parseRetryAfter({ "retry-after": "Wed, 21 Oct 2015 07:28:10 GMT" }, Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(10_000);
    expect(parseRetryAfter({})).toBeUndefined();
  });
});

describe("send", () => {
  test("a request that never got a response is a network error", async () => {
    const error = await send("X", async () => {
      throw new Error("ECONNREFUSED");
    }, { url: "u", method: "POST", headers: {}, body: "" }).catch((e) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error.kind).toBe("network");
    expect(error.message).toContain("ECONNREFUSED");
  });
});
