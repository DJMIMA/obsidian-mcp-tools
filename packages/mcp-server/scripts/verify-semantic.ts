/**
 * End-to-end check of search_vault_smart against the live plugin index.
 *
 * Launches the MCP server over stdio like Claude Desktop does, writes one note
 * per path pattern from CLAUDE.md (each on its own topic), waits for the
 * plugin's incremental update, then checks that a paraphrased query finds it,
 * that folder filters work with spaces, Japanese and nesting, that limit is
 * validated, that edits and deletions reach the index, and that a long section
 * is cut to the plugin's "Max characters per search result" (expects the
 * default, 300) unless filter.maxTextChars says otherwise. The index must
 * already be built (state "ready" in the plugin settings), and
 * `_mcp-tools-test/` must not be an excluded folder. Test notes are deleted
 * afterwards and empty directories are removed on disk.
 *
 * Usage: bun scripts/verify-semantic.ts [path-to-server-binary]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { dirname, resolve } from "path";

const serverPath = process.argv[2] ?? resolve(import.meta.dir, "../dist/mcp-server-windows.exe");

const configPath = resolve(process.env.APPDATA!, "Claude/claude_desktop_config.json");
const entry = JSON.parse(readFileSync(configPath, "utf8"))?.mcpServers?.["obsidian-mcp-tools"];
const apiKey: string | undefined = entry?.env?.OBSIDIAN_API_KEY;
if (!apiKey) {
  console.error(`OBSIDIAN_API_KEY not found in ${configPath}`);
  process.exit(1);
}
const vaultRoot: string | undefined =
  typeof entry?.command === "string" ? resolve(dirname(entry.command), "../../../..") : undefined;

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
env.OBSIDIAN_API_KEY = apiKey;

const client = new Client({ name: "verify-semantic", version: "0.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: serverPath, env }));

type Outcome = { ok: true; text: string } | { ok: false; error: string };
type Hit = { path: string; text: string; score: number; breadcrumbs: string };

async function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    return result.isError ? { ok: false, error: text } : { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parses the tool's JSON, skipping a leading warning line when the index is not ready. */
function hits(outcome: Outcome): Hit[] {
  if (!outcome.ok) return [];
  const start = outcome.text.indexOf("{");
  return (JSON.parse(outcome.text.slice(start)) as { results: Hit[] }).results;
}

async function search(query: string, filter: Record<string, unknown>) {
  const started = performance.now();
  const outcome = await call("search_vault_smart", { query, filter });
  return { outcome, ms: Math.round(performance.now() - started) };
}

/** Repeats a search until `accept` holds or 60 s pass (debounce 10 s + embedding). */
async function waitFor(query: string, filter: Record<string, unknown>, accept: (h: Hit[]) => boolean) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { outcome, ms } = await search(query, filter);
    if (accept(hits(outcome)) || Date.now() > deadline) return { outcome, ms, pass: accept(hits(outcome)) };
    await Bun.sleep(3_000);
  }
}

const BASE = "_mcp-tools-test";
const patterns = [
  {
    id: "a", label: "ルート直下", path: `${BASE}-root.md`, folder: `${BASE}-root`,
    body: "蜂蜜は低温で保存するとブドウ糖が結晶になり、白く固まる。湯煎で四十度ほどに温めると元に戻る。",
    query: "はちみつが白く固まるのはなぜ", edited: "メープルシロップは樹液を煮詰めて作る。",
  },
  {
    id: "b", label: "ASCII サブディレクトリ", path: `${BASE}/projects/note.md`, folder: `${BASE}/projects/`,
    body: "The lighthouse keeper trims the lamp wick at dusk, winds the clockwork that turns the lens, and logs passing ships until dawn.",
    query: "what does a lighthouse keeper do every night", edited: "A cooper bends oak staves into barrels with iron hoops.",
  },
  {
    id: "c", label: "スペースを含むディレクトリ", path: `${BASE}/My Notes/note.md`, folder: `${BASE}/My Notes/`,
    body: "盆栽の松は春から秋にかけて土の表面が乾いたらたっぷり水をやり、冬は控えめにする。",
    query: "小さな鉢植えの木に水をあげる頻度", edited: "苔玉は霧吹きで湿らせておく。",
  },
  {
    id: "d", label: "日本語ディレクトリ", path: `${BASE}/日記/2026-09-03.md`, folder: `${BASE}/日記/`,
    body: "将棋では美濃囲いや矢倉囲いのように、金銀を玉の周りに寄せて守りを固める。",
    query: "将棋で玉を守る陣形", edited: "囲碁の定石は隅から打ち始める。",
  },
  {
    id: "e", label: "3 階層以上", path: `${BASE}/a/b/c/note.md`, folder: `${BASE}/a/b/`,
    body: "火山灰が積もったら、雨どいが詰まる前に乾いた状態で掃き集め、指定の袋に入れて出す。",
    query: "降灰のあとの片付け方", edited: "黄砂の日は洗濯物を部屋干しにする。",
  },
];

const rows: string[][] = [];
let failures = 0;
const record = (id: string, step: string, pass: boolean, detail: string) => {
  if (!pass) failures++;
  rows.push([id, step, pass ? "PASS" : "FAIL", detail.replace(/\s+/g, " ").slice(0, 90)]);
};

// Preflight: the index must answer at all.
const preflight = await search("test", { limit: 1 });
if (!preflight.outcome.ok) {
  console.error(`search_vault_smart is not usable yet:\n${preflight.outcome.error}`);
  process.exit(1);
}

for (const p of patterns) {
  const note = (body: string) => `# テストノート\n\n## 話題\n\n${body}\n`;
  const created = await call("create_vault_file", { filename: p.path, content: note(p.body) });
  record(p.id, "create", created.ok, created.ok ? created.text : created.error);

  const found = await waitFor(p.query, { folders: [p.folder], limit: 5 }, (h) => h[0]?.path === p.path);
  record(p.id, `paraphrase finds it (${found.ms} ms)`, found.pass, JSON.stringify(hits(found.outcome)[0] ?? found.outcome));

  const top = hits(found.outcome)[0];
  const name = p.path.split("/").pop()!.replace(/\.md$/, "");
  record(p.id, "breadcrumbs", top?.breadcrumbs === `${name} > テストノート > 話題`, top?.breadcrumbs ?? "none");

  const excluded = await search(p.query, { folders: [p.folder], excludeFolders: [p.folder] });
  record(p.id, "excludeFolders drops it", excluded.outcome.ok && !hits(excluded.outcome).some((h) => h.path === p.path), JSON.stringify(hits(excluded.outcome).map((h) => h.path)));

  await call("create_vault_file", { filename: p.path, content: note(p.edited) });
  const edited = await waitFor(p.query, { folders: [p.folder], limit: 5 }, (h) => h.some((x) => x.path === p.path && x.text.includes(p.edited)));
  record(p.id, "edit reaches the index", edited.pass, JSON.stringify(hits(edited.outcome).map((h) => h.text.slice(0, 30))));

  const deleted = await call("delete_vault_file", { filename: p.path });
  record(p.id, "delete", deleted.ok, deleted.ok ? deleted.text : deleted.error);
  const gone = await waitFor(p.query, { folders: [p.folder], limit: 5 }, (h) => !h.some((x) => x.path === p.path));
  record(p.id, "delete reaches the index", gone.pass, JSON.stringify(hits(gone.outcome).map((h) => h.path)));
}

// Text length: a note with one long section is cut to the plugin setting (default 300) unless the request says otherwise.
{
  const path = `${BASE}-long.md`;
  const query = "干潟で渡り鳥が潮の引いたあとに食べるもの";
  const body = Array.from({ length: 60 }, (_, i) => `第${i + 1}節、干潟の渡り鳥は潮が引くと泥の中の小さな貝やゴカイをついばむ。`).join("");
  const content = `# 長いテストノート\n\n${body}\n`;
  const created = await call("create_vault_file", { filename: path, content });
  record("t", "create long note", created.ok, created.ok ? `${content.length} chars` : created.error);
  const found = await waitFor(query, { folders: [path], limit: 3 }, (h) => h[0]?.path === path);
  record("t", "long note is indexed", found.pass, JSON.stringify(hits(found.outcome)[0]?.breadcrumbs ?? found.outcome));

  type Cut = Hit & { truncated?: boolean; fullChars?: number };
  const top = async (filter: Record<string, unknown>) => hits((await search(query, { folders: [path], limit: 3, ...filter })).outcome)[0] as Cut | undefined;

  const byDefault = await top({});
  record("t", "default cut to 300 chars + ellipsis", !!byDefault && byDefault.text.length === 301 && byDefault.text.endsWith("…"), `length ${byDefault?.text.length}`);
  record("t", "truncated and fullChars are set", byDefault?.truncated === true && byDefault.fullChars === content.trim().length, `truncated=${byDefault?.truncated} fullChars=${byDefault?.fullChars} (note ${content.trim().length})`);
  record("t", "text starts with the heading line", !!byDefault?.text.startsWith("# 長いテストノート"), byDefault?.text.slice(0, 20) ?? "none");

  const small = await top({ maxTextChars: 100 });
  record("t", "maxTextChars 100 overrides the setting", small?.text.length === 101 && small.truncated === true, `length ${small?.text.length}`);
  const whole = await top({ maxTextChars: 0 });
  record("t", "maxTextChars 0 returns the whole section", whole?.text.length === content.trim().length && whole.truncated === undefined, `length ${whole?.text.length} truncated=${whole?.truncated}`);
  const wide = await top({ maxTextChars: 5000 });
  record("t", "limit above the section length is not truncated", wide?.truncated === undefined && wide?.text.length === content.trim().length, `length ${wide?.text.length}`);
  const bad = await call("search_vault_smart", { query: "test", filter: { maxTextChars: 20001 } });
  record("t", "maxTextChars 20001 is rejected", !bad.ok && bad.error.includes("maxTextChars"), bad.ok ? bad.text : bad.error);

  const deleted = await call("delete_vault_file", { filename: path });
  record("t", "delete long note", deleted.ok, deleted.ok ? deleted.text : deleted.error);
}

for (const limit of [0, 51, 2.5]) {
  const outcome = await call("search_vault_smart", { query: "test", filter: { limit } });
  record("-", `limit ${limit} is rejected`, !outcome.ok && outcome.error.includes("limit"), outcome.ok ? outcome.text : outcome.error);
}

await client.close();

// Remove the empty directories the notes lived in.
if (vaultRoot) {
  const dir = resolve(vaultRoot, BASE);
  const prune = (path: string): boolean => {
    if (!existsSync(path)) return true;
    const empty = readdirSync(path, { withFileTypes: true }).every((d) => d.isDirectory() && prune(resolve(path, d.name)));
    if (empty) rmSync(path, { recursive: true });
    return empty;
  };
  prune(dir);
}

console.log("| # | step | result | detail |\n|---|---|---|---|");
for (const row of rows) console.log(`| ${row.join(" | ")} |`);
console.log(`\n${rows.length - failures}/${rows.length} PASS`);
process.exit(failures === 0 ? 0 : 1);
