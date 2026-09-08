import { describe, expect, test } from "bun:test";
import {
  describeHttpError,
  describeNetworkError,
  type ApiRequestInfo,
} from "./describeApiError";

const req = (
  overrides: Partial<ApiRequestInfo> = {},
): ApiRequestInfo => ({
  method: "GET",
  path: "/vault/Daily%20log/2026/2026-08-19.md",
  baseUrl: "https://127.0.0.1:27124",
  ...overrides,
});

describe("describeHttpError", () => {
  test("reports a missing vault file with the requested path", () => {
    const message = describeHttpError(req(), 404, "");
    expect(message).toContain("File not found");
    expect(message).toContain("Daily log/2026/2026-08-19.md");
  });

  test("distinguishes a missing directory listing from a missing file", () => {
    const message = describeHttpError(
      req({ path: "/vault/My%20Notes/" }),
      404,
      "",
    );
    expect(message).toContain("Directory not found");
    expect(message).toContain("My Notes");
  });

  test("explains a 404 on the active file as no file being open", () => {
    const message = describeHttpError(req({ path: "/active/" }), 404, "");
    expect(message).toContain("No active file");
  });

  test("reports 401 as an authentication failure naming the API key setting", () => {
    const message = describeHttpError(req(), 401, "");
    expect(message).toContain("Authentication failed");
    expect(message).toContain("OBSIDIAN_API_KEY");
  });

  test("reports 403 as an authentication failure", () => {
    const message = describeHttpError(req(), 403, "");
    expect(message).toContain("Authentication failed");
  });

  test("passes through the errorCode and message the API returned on 400", () => {
    const message = describeHttpError(
      req({ method: "PATCH" }),
      400,
      JSON.stringify({
        errorCode: 40149,
        message: "Target type 'heading' requires a target.",
      }),
    );
    expect(message).toContain("Bad request");
    expect(message).toContain("40149");
    expect(message).toContain("Target type 'heading' requires a target.");
    expect(message).toContain("Daily log/2026/2026-08-19.md");
  });

  test("reports 405 as a method not allowed for the path", () => {
    const message = describeHttpError(req({ method: "DELETE" }), 405, "");
    expect(message).toContain("Method not allowed");
    expect(message).toContain("DELETE");
    expect(message).toContain("Daily log/2026/2026-08-19.md");
  });

  test("reports a 5xx with the status and the response body", () => {
    const message = describeHttpError(req(), 500, "boom");
    expect(message).toContain("500");
    expect(message).toContain("boom");
  });

  test("includes the request method and URL for any status", () => {
    const message = describeHttpError(req(), 418, "");
    expect(message).toContain("GET");
    expect(message).toContain(
      "https://127.0.0.1:27124/vault/Daily%20log/2026/2026-08-19.md",
    );
  });

  test("never leaks the API key that is set in the environment", () => {
    const previous = process.env.OBSIDIAN_API_KEY;
    process.env.OBSIDIAN_API_KEY = "super-secret-key-value";
    try {
      const message = describeHttpError(
        req({ path: "/vault/note.md?key=super-secret-key-value" }),
        400,
        "rejected token super-secret-key-value",
      );
      expect(message).not.toContain("super-secret-key-value");
    } finally {
      if (previous === undefined) delete process.env.OBSIDIAN_API_KEY;
      else process.env.OBSIDIAN_API_KEY = previous;
    }
  });
});

describe("describeNetworkError", () => {
  test("reports a refused connection as Obsidian being unreachable", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const message = describeNetworkError(req(), error);
    expect(message).toContain("Cannot reach Obsidian Local REST API");
    expect(message).toContain("https://127.0.0.1:27124");
  });

  test("looks through the cause chain of a wrapped fetch failure", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const error = new TypeError("fetch failed", { cause });
    const message = describeNetworkError(req(), error);
    expect(message).toContain("Cannot reach Obsidian Local REST API");
  });

  test("recognises Bun's ConnectionRefused code", () => {
    const error = Object.assign(new Error("Unable to connect."), {
      code: "ConnectionRefused",
    });
    const message = describeNetworkError(req(), error);
    expect(message).toContain("Cannot reach Obsidian Local REST API");
  });

  test("reports a certificate failure as a TLS problem", () => {
    const error = Object.assign(
      new Error("self signed certificate in certificate chain"),
      { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    );
    const message = describeNetworkError(req(), error);
    expect(message).toContain("TLS");
    expect(message).toContain("https://127.0.0.1:27124");
  });

  test("reports an aborted request as a timeout including the limit", () => {
    const error = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    const message = describeNetworkError(req({ timeoutMs: 5000 }), error);
    expect(message).toContain("timed out");
    expect(message).toContain("5000");
  });

  test("falls back to the original message for an unrecognised failure", () => {
    const message = describeNetworkError(req(), new Error("something odd"));
    expect(message).toContain("something odd");
    expect(message).toContain(
      "https://127.0.0.1:27124/vault/Daily%20log/2026/2026-08-19.md",
    );
  });

  test("never leaks the API key that is set in the environment", () => {
    const previous = process.env.OBSIDIAN_API_KEY;
    process.env.OBSIDIAN_API_KEY = "super-secret-key-value";
    try {
      const message = describeNetworkError(
        req(),
        new Error("bad header Bearer super-secret-key-value"),
      );
      expect(message).not.toContain("super-secret-key-value");
    } finally {
      if (previous === undefined) delete process.env.OBSIDIAN_API_KEY;
      else process.env.OBSIDIAN_API_KEY = previous;
    }
  });
});
