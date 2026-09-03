/**
 * End-to-end check of vault path handling against a live Local REST API.
 *
 * Launches the MCP server (default: the freshly built Windows binary) over
 * stdio exactly like Claude Desktop does, then runs the five path patterns from
 * CLAUDE.md through get / create / append / patch / list / delete, then a
 * second phase that exercises heading targets below H1 (leaf, partial and
 * full paths, ambiguous and absent headings, sibling insertion). Test files
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
    // markdown-patch 2.0 features: array target, frontmatter value, delete
    ["patch(array target)", () => call("patch_vault_file", { filename: p.path, operation: "append", targetType: "heading", target: ["Title"], content: `array-patched ${p.id}\n` }), (o) => o.ok],
    ["get(after array patch)", () => call("get_vault_file", { filename: p.path }), (o) => o.ok && o.text.includes(`array-patched ${p.id}`)],
    // The fixture has no frontmatter, so the key must be created explicitly (default is no longer to create).
    ["patch(frontmatter, create key)", () => call("patch_vault_file", { filename: p.path, operation: "replace", targetType: "frontmatter", target: "status", content: `done-${p.id}`, createTargetIfMissing: true }), (o) => o.ok],
    ["get(json, frontmatter)", () => call("get_vault_file", { filename: p.path, format: "json" }), (o) => o.ok && o.text.includes(`"status": "done-${p.id}"`)],
    ["patch(delete ja section)", () => call("patch_vault_file", { filename: p.path, operation: "delete", targetType: "heading", target: "見出し" }), (o) => o.ok],
    ["get(after delete)", () => call("get_vault_file", { filename: p.path }), (o) => o.ok && o.text.includes("見出し") && !o.text.includes("日本語本文")],
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
// --- Phase 2: heading targets below H1 (bug report 2026-09-03) ---
// markdown-patch 2.0 needs the full heading path; the server now widens a
// partial path via the document map, refuses ambiguous/absent targets without
// writing, and only creates a heading when createTargetIfMissing is true.
const H = `${BASE}/日記/_patch_headings.md`;
const FIXTURE = [
  "# Title", "## Plain", "- a",
  "## 📝 本日の振り返り（事実）", "### 臨床", "- x", "### 個人/家族", "- y", "### AB", "- z",
  "## 💡 Next", "-",
  "## Log", "### Notes", "- n1",
  "## Archive", "### Log", "#### Notes", "- n2", "",
].join("\n");
const hp = (args: Record<string, unknown>) => call("patch_vault_file", { filename: H, ...args });
const hget = () => call("get_vault_file", { filename: H });
/** marker occurs exactly once, after `after` and before `before` (or EOF). */
const placed = (text: string, marker: string, after: string, before?: string) => {
  const i = text.indexOf(marker);
  if (i < 0 || text.indexOf(marker, i + 1) >= 0) return false;
  const a = text.indexOf(after);
  if (a < 0 || i < a) return false;
  if (before === undefined) return true;
  const b = text.indexOf(before, a);
  return b >= 0 && i < b;
};
const heading = "📝 本日の振り返り（事実）";
const headingSteps: [string, () => Promise<Outcome>, (o: Outcome) => boolean][] = [
  ["create fixture", () => call("create_vault_file", { filename: H, content: FIXTURE }), (o) => o.ok],
  ["H1 by leaf", () => hp({ operation: "append", targetType: "heading", target: "Title", content: "h1-leaf" }), (o) => o.ok && o.text.includes("Matched heading: Title")],
  ["H2 by leaf", () => hp({ operation: "append", targetType: "heading", target: "Plain", content: "h2-leaf" }), (o) => o.ok && o.text.includes("Resolved heading Plain to Title::Plain")],
  ["get(H2 placed)", hget, (o) => o.ok && placed(o.text, "h2-leaf", "## Plain", "## 📝")],
  ["H3 by leaf", () => hp({ operation: "append", targetType: "heading", target: "AB", content: "h3-leaf" }), (o) => o.ok],
  ["get(H3 placed)", hget, (o) => o.ok && placed(o.text, "h3-leaf", "### AB", "## 💡 Next")],
  ["H2::H3 string", () => hp({ operation: "append", targetType: "heading", target: `${heading}::AB`, content: "h23-string" }), (o) => o.ok],
  ["get(H2::H3 placed)", hget, (o) => o.ok && placed(o.text, "h23-string", "### AB", "## 💡 Next")],
  ["[H2, H3] array", () => hp({ operation: "append", targetType: "heading", target: [heading, "AB"], content: "h23-array" }), (o) => o.ok],
  ["get(array placed)", hget, (o) => o.ok && placed(o.text, "h23-array", "### AB", "## 💡 Next")],
  ["heading with /", () => hp({ operation: "append", targetType: "heading", target: "個人/家族", content: "slash-leaf" }), (o) => o.ok],
  ["get(/ placed)", hget, (o) => o.ok && placed(o.text, "slash-leaf", "### 個人/家族", "### AB")],
  ["emoji + full-width parens", () => hp({ operation: "append", targetType: "heading", target: heading, content: "emoji-leaf" }), (o) => o.ok],
  ["get(emoji placed at section end)", hget, (o) => o.ok && placed(o.text, "emoji-leaf", "### AB", "## 💡 Next")],
  ["full path array", () => hp({ operation: "append", targetType: "heading", target: ["Title", "💡 Next"], content: "full-path" }), (o) => o.ok && o.text.includes("Matched heading")],
  ["get(full path placed)", hget, (o) => o.ok && placed(o.text, "full-path", "## 💡 Next", "## Log")],
  // Same leaf text at two depths: refuse, name both candidates, write nothing.
  ["ambiguous leaf", () => hp({ operation: "append", targetType: "heading", target: "Notes", content: "ambig" }), (o) => !o.ok && /ambiguous/.test(o.error) && o.error.includes("Title::Log::Notes") && o.error.includes("Title::Archive::Log::Notes")],
  ["get(ambiguous wrote nothing)", hget, (o) => o.ok && !o.text.includes("ambig")],
  ["disambiguated partial path", () => hp({ operation: "append", targetType: "heading", target: "Archive::Log::Notes", content: "deep-notes" }), (o) => o.ok],
  ["get(deep placed)", hget, (o) => o.ok && placed(o.text, "deep-notes", "#### Notes")],
  // Absent heading: error listing existing paths, no write (default createTargetIfMissing is now false).
  ["absent, default", () => hp({ operation: "append", targetType: "heading", target: "Nope", content: "absent" }), (o) => !o.ok && /not found/.test(o.error) && o.error.includes("Title::Plain")],
  ["get(absent wrote nothing)", hget, (o) => o.ok && !o.text.includes("absent") && !o.text.includes("Nope")],
  ["absent, createTargetIfMissing", () => hp({ operation: "append", targetType: "heading", target: "Nope", content: "created", createTargetIfMissing: true }), (o) => o.ok && /creating/.test(o.text)],
  ["get(created)", hget, (o) => o.ok && /^# Nope$/m.test(o.text) && o.text.includes("created")],
  // Sibling insertion at H3 via markerAndContent: lands after the AB section, at ### level.
  ["markerAndContent sibling at H3", () => hp({ operation: "append", targetType: "heading", target: "AB", scope: "markerAndContent", content: "# Sibling\n- s" }), (o) => o.ok],
  ["get(sibling level + place)", hget, (o) => o.ok && placed(o.text, "### Sibling", "h23-array", "## 💡 Next") && !o.text.includes("#### Sibling")],
  // Leaf resolution through /active/ as well.
  ["open", () => call("show_file_in_obsidian", { filename: H }), (o) => o.ok],
  ["patch_active by H2 leaf", async () => { await Bun.sleep(700); return call("patch_active_file", { operation: "append", targetType: "heading", target: "Plain", content: "active-leaf" }); }, (o) => o.ok && o.text.includes("Title::Plain")],
  ["get(active placed)", hget, (o) => o.ok && placed(o.text, "active-leaf", "## Plain", "## 📝")],
  ["delete fixture", () => call("delete_vault_file", { filename: H }), (o) => o.ok],
];
for (const [step, run, expect] of headingSteps) {
  const outcome = await run();
  const pass = expect(outcome);
  if (!pass) failures++;
  const detail = outcome.ok
    ? outcome.text.replace(/\s+/g, " ").slice(0, 60)
    : outcome.error.replace(/\s+/g, " ").slice(0, 100);
  rows.push(["h", "見出し解決", step, pass ? "PASS" : "FAIL", detail]);
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
