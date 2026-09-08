import { type } from "arktype";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObsidianApiError } from "./describeApiError";
import { makeRequest } from "./makeRequest";

const OkResponse = type({ ok: "boolean" });

/** What the stub Local REST API answers with for the next request. */
let reply: (req: Request) => Response;

const server = Bun.serve({
  port: 0,
  fetch: (req) => reply(req),
});

const envBackup = { ...process.env };

beforeAll(() => {
  process.env.OBSIDIAN_USE_HTTP = "true";
  process.env.OBSIDIAN_HOST = "127.0.0.1";
  process.env.OBSIDIAN_PORT = String(server.port);
  process.env.OBSIDIAN_API_KEY = "test-api-key";
});

afterAll(() => {
  server.stop(true);
  for (const key of [
    "OBSIDIAN_USE_HTTP",
    "OBSIDIAN_HOST",
    "OBSIDIAN_PORT",
    "OBSIDIAN_API_KEY",
  ]) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
    throw new Error("expected the request to fail");
  } catch (error) {
    return error;
  }
};

describe("makeRequest", () => {
  test("returns the validated body of a successful response", async () => {
    reply = () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });

    expect(await makeRequest(OkResponse, "/vault/note.md")).toEqual({
      ok: true,
    });
  });

  test("sends the API key as a bearer token", async () => {
    const seen: (string | null)[] = [];
    reply = (req) => {
      seen.push(req.headers.get("Authorization"));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    };

    await makeRequest(OkResponse, "/vault/note.md");
    expect(seen).toEqual(["Bearer test-api-key"]);
  });

  test("describes a 404 on a vault file as a missing file with the requested path", async () => {
    reply = () => new Response("", { status: 404 });

    const error = await rejection(
      makeRequest(OkResponse, "/vault/My%20Notes/a.md"),
    );

    expect(error).toBeInstanceOf(ObsidianApiError);
    expect((error as ObsidianApiError).status).toBe(404);
    expect((error as ObsidianApiError).description).toContain(
      "File not found: My Notes/a.md",
    );
  });

  test("describes a 401 as an authentication failure", async () => {
    reply = () =>
      new Response(JSON.stringify({ errorCode: 40100, message: "Bad token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });

    const error = await rejection(makeRequest(OkResponse, "/vault/note.md"));

    expect((error as ObsidianApiError).description).toContain(
      "Authentication failed",
    );
    expect((error as ObsidianApiError).description).toContain("Bad token");
  });

  test("describes a 5xx with the status and the response body", async () => {
    reply = () => new Response("kaboom", { status: 502 });

    const error = await rejection(makeRequest(OkResponse, "/vault/note.md"));

    expect((error as ObsidianApiError).description).toContain("502");
    expect((error as ObsidianApiError).description).toContain("kaboom");
  });

  test("describes an unreachable server as Obsidian not being available", async () => {
    const previousPort = process.env.OBSIDIAN_PORT;
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const closedPort = closed.port;
    closed.stop(true);
    process.env.OBSIDIAN_PORT = String(closedPort);

    try {
      const error = await rejection(makeRequest(OkResponse, "/vault/note.md"));
      expect((error as ObsidianApiError).description).toContain(
        "Cannot reach Obsidian Local REST API",
      );
      expect((error as ObsidianApiError).description).toContain(
        `127.0.0.1:${closedPort}`,
      );
    } finally {
      process.env.OBSIDIAN_PORT = previousPort;
    }
  });

  test("names the missing setting when no API key is configured", async () => {
    const previous = process.env.OBSIDIAN_API_KEY;
    delete process.env.OBSIDIAN_API_KEY;

    try {
      const error = await rejection(makeRequest(OkResponse, "/vault/note.md"));
      expect((error as Error).message).toContain("OBSIDIAN_API_KEY");
    } finally {
      process.env.OBSIDIAN_API_KEY = previous;
    }
  });

  test("describes an unexpected response shape with the endpoint that returned it", async () => {
    reply = () =>
      new Response(JSON.stringify({ nope: 1 }), {
        headers: { "Content-Type": "application/json" },
      });

    const error = await rejection(makeRequest(OkResponse, "/vault/note.md"));

    expect((error as ObsidianApiError).description).toContain(
      "unexpected response",
    );
    expect((error as ObsidianApiError).description).toContain("/vault/note.md");
  });

  test("never leaks the API key in a failure message", async () => {
    reply = () =>
      new Response("rejected token test-api-key", { status: 400 });

    const error = await rejection(makeRequest(OkResponse, "/vault/note.md"));

    expect((error as ObsidianApiError).description).not.toContain(
      "test-api-key",
    );
  });
});
