import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { activeFilePath, assertWritable, resetProtectedFoldersCache } from "./writeGuard";

/** What the stub Local REST API answers with for the next request. */
let reply: (req: Request) => Response;
let requests: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    requests.push(new URL(req.url).pathname);
    return reply(req);
  },
});

const envBackup = { ...process.env };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

beforeAll(() => {
  process.env.OBSIDIAN_USE_HTTP = "true";
  process.env.OBSIDIAN_HOST = "127.0.0.1";
  process.env.OBSIDIAN_PORT = String(server.port);
  process.env.OBSIDIAN_API_KEY = "test-api-key";
});

afterAll(async () => {
  await server.stop(true);
  for (const key of ["OBSIDIAN_USE_HTTP", "OBSIDIAN_HOST", "OBSIDIAN_PORT", "OBSIDIAN_API_KEY"]) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
});

beforeEach(() => {
  resetProtectedFoldersCache();
  requests = [];
});

describe("assertWritable", () => {
  test("allows a path outside the protected folders", async () => {
    reply = () => json({ folders: ["Templates", "Prompts"] });
    await assertWritable("Daily log/2026-11-04.md");
    expect(requests).toEqual(["/mcp-tools/protected-folders"]);
  });

  test("refuses a path inside a protected folder, in any letter case", async () => {
    reply = () => json({ folders: ["Templates", "Prompts"] });
    await expect(assertWritable("templates/Daily.md")).rejects.toThrow(
      'it is inside "Templates"',
    );
    await expect(assertWritable("Prompts/x.md")).rejects.toThrow("Nothing was written");
  });

  test("asks the plugin once and reuses the answer", async () => {
    reply = () => json({ folders: ["Templates"] });
    await assertWritable("a.md");
    await assertWritable("b.md");
    expect(requests).toEqual(["/mcp-tools/protected-folders"]);
  });

  test("refuses to write when the plugin route is missing", async () => {
    reply = () => new Response("Not Found", { status: 404 });
    await expect(assertWritable("a.md")).rejects.toThrow(
      "Enable the MCP Tools plugin in Obsidian",
    );
  });
});

describe("activeFilePath", () => {
  test("reads the path of the open note", async () => {
    reply = () =>
      json({
        content: "",
        frontmatter: {},
        path: "Templates/Daily.md",
        stat: { ctime: 0, mtime: 0, size: 0 },
        tags: [],
      });
    expect(await activeFilePath()).toBe("Templates/Daily.md");
    expect(requests).toEqual(["/active/"]);
  });
});
