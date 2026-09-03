/**
 * End-to-end check of vault path handling against a live Local REST API.
 *
 * Launches the MCP server (default: the freshly built Windows binary) over
 * stdio exactly like Claude Desktop does, then runs the five path patterns from
 * CLAUDE.md through get / create / append / patch / list / delete. Test files
 * live under `_mcp-tools-test/` in the vault and are deleted afterwards; the
 * empty directories left behind are removed directly on disk.
 *
 * The API key and vault location come from the Claude Desktop config. The key
 * is never printed.
 *
 * Usage: bun scripts/verify-paths.ts [path-to-server-binary]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { dirname, resolve } from "path";

const serverPath =
  process.argv[2] ?? resolve(import.meta.dir, "../dist/mcp-server-windows.exe");

// --- API key and vault root from Claude Desktop config (key not echoed) ---
const configPath = resolve(process.env.APPDATA!, "Claude/claude_desktop_config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const entry = config?.mcpServers?.["obsidian-mcp-tools"];
const apiKey: string | undefined = entry?.env?.OBSIDIAN_API_KEY;
if (!apiKey) {
  console.error(`OBSIDIAN_API_KEY not found in ${configPath}`);
  process.exit(1);
}
// <vault>/.obsidian/plugins/mcp-tools/bin/mcp-server.exe -> <vault>
const vaultRoot: string | undefined =
  typeof entry?.command === "string"
    ? resolve(dirname(entry.command), "../../../..")
    : undefined;

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
env.OBSIDIAN_API_KEY = apiKey;

const transport = new StdioClientTransport({ command: serverPath, env });
const client = new Client({ name: "verify-paths", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

// --- helpers ---
type Outcome = { ok: true; text: string } | { ok: false; error: string };

async function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    if (result.isError) return { ok: false, error: text };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const BASE = "_mcp-tools-test";
const patterns: { id: string; label: string; path: string }[] = [
  { id: "a", label: "ルート直下", path: `${BASE}-root.md` },
  { id: "b", label: "ASCII サブディレクトリ", path: `${BASE}/projects/note.md` },
  { id: "c", label: "スペースを含むディレクトリ", path: `${BASE}/My Notes/note.md` },
  { id: "d", label: "日本語ディレクトリ", path: `${BASE}/日記/2026-09-03.md` },
  { id: "e", label: "3 階層以上", path: `${BASE}/a/b/c/note.md` },
];

const rows: string[][] = [];
let failures = 0;

for (const p of patterns) {
  const steps: [string, () => Promise<Outcome>, (o: Outcome) => boolean][] = [
    ["get(absent)", () => call("get_vault_file", { filename: p.path }), (o) => !o.ok && /404/.test(o.error)],
    ["create", () => call("create_vault_file", { filename: p.path, content: `# Title\n\nbody of ${p.id}\n\n# 見出し\n\n日本語本文\n` }), (o) => o.ok],
    ["get", () => call("get_vault_file", { filename: p.path }), (o) => o.ok && o.text.includes(`body of ${p.id}`)],
    ["append", () => call("append_to_vault_file", { filename: p.path, content: `\nappended ${p.id}\n` }), (o) => o.ok],
    ["get(after append)", () => call("get_vault_file", { filename: p.path }), (o) => o.ok && o.text.includes(`appended ${p.id}`)],
    ["patch", () => call("patch_vault_file", { filename: p.path, operation: "append", targetType: "heading", target: "Title", content: `patched ${p.id}\n` }), (o) => o.ok],
    ["get(after patch)", () => call("get_vault_file", { filename: p.path }), (o) => o.ok && o.text.includes(`patched ${p.id}`)],
    // Non-ASCII heading target: the Target header must be URL-encoded to survive HTTP.
    ["patch(ja heading)", () => call("patch_vault_file", { filename: p.path, operation: "append", targetType: "heading", target: "見出し", content: `ja-patched ${p.id}\n` }), (o) => o.ok],
    ["get(after ja patch)", () => call("get_vault_file", { filename: p.path }), (o) => o.ok && /見出し[\s\S]*ja-patched/.test(o.text)],
    // Open the file in the Obsidian UI so it becomes the active file, then patch it via /active/.
    ["open", () => call("show_file_in_obsidian", { filename: p.path }), (o) => o.ok],
    ["patch_active", async () => { await Bun.sleep(700); return call("patch_active_file", { operation: "append", targetType: "heading", target: "Title", content: `active-patched ${p.id}\n` }); }, (o) => o.ok],
    ["get(after active patch)", () => call("get_vault_file", { filename: p.path }), (o) => o.ok && o.text.includes(`active-patched ${p.id}`)],
    ["get(json)", () => call("get_vault_file", { filename: p.path, format: "json" }), (o) => o.ok && o.text.includes(`"path"`)],
    ["list(parent)", () => call("list_vault_files", dirname(p.path) === "." ? {} : { directory: dirname(p.path) }), (o) => o.ok && o.text.includes(p.path.split("/").pop()!)],
    // Callers sometimes pass the directory with a trailing slash; it must not become "dir//".
    ["list(parent, trailing /)", () => call("list_vault_files", dirname(p.path) === "." ? {} : { directory: `${dirname(p.path)}/` }), (o) => o.ok && o.text.includes(p.path.split("/").pop()!)],
    ["delete", () => call("delete_vault_file", { filename: p.path }), (o) => o.ok],
    ["get(deleted)", () => call("get_vault_file", { filename: p.path }), (o) => !o.ok && /404/.test(o.error)],
  ];

  for (const [step, run, expect] of steps) {
    const outcome = await run();
    const pass = expect(outcome);
    if (!pass) failures++;
    const detail = outcome.ok
      ? outcome.text.replace(/\s+/g, " ").slice(0, 60)
      : outcome.error.replace(/\s+/g, " ").slice(0, 100);
    rows.push([p.id, p.label, step, pass ? "PASS" : "FAIL", detail]);
  }
}

await client.close();

// --- remove the empty test directory tree left in the vault ---
let cleanup = "vault root unknown; leave _mcp-tools-test/ for manual removal";
if (vaultRoot) {
  const testDir = resolve(vaultRoot, BASE);
  if (!existsSync(testDir)) {
    cleanup = "nothing to clean";
  } else {
    const leftoverFiles = readdirSync(testDir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    if (leftoverFiles.length) {
      cleanup = `NOT removed: files remain in ${testDir}: ${leftoverFiles.join(", ")}`;
    } else {
      rmSync(testDir, { recursive: true });
      cleanup = `removed empty ${testDir}`;
    }
  }
}

console.log("| # | pattern | step | result | detail |");
console.log("|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.join(" | ")} |`);
console.log(`\n${rows.length - failures}/${rows.length} passed, ${failures} failed`);
console.log(`cleanup: ${cleanup}`);
process.exit(failures ? 1 : 0);
