/**
 * Compares search_vault_smart before and after replacing Smart Connections
 * (docs/superpowers/specs/2026-10-03-semantic-search-design.md, 実機確認).
 *
 *   bun scripts/eval-semantic.ts capture <label>   run the queries (limit 20) and save the results
 *   bun scripts/eval-semantic.ts pool <labelA> <labelB>    write a judging note into the vault
 *   bun scripts/eval-semantic.ts score <labelA> <labelB>   read the ticks and print metrics
 *
 * Results go to %LOCALAPPDATA%/obsidian-mcp-tools/semantic-eval, outside the
 * repo and the vault, because they name personal notes. Only paths,
 * breadcrumbs, scores and text lengths are stored, never note text. The Local
 * REST API key and the vault location come from the Claude Desktop config;
 * the key is never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export const QUERIES = [
  "inotuzumab ozogamicin CD22 抗体薬物複合体 B-ALL 再発難治",
  '"脂質異常症の管理（LDL/TG/HDL目標・一次/二次予防・食事・薬物療法）＋血液内科領域の薬剤性脂質異常"',
  "VEXAS症候群の治療 UBA1 JAK阻害薬 アザシチジン 同種移植",
  "眼内悪性リンパ腫 硝子体網膜リンパ腫 治療 メトトレキサート硝子体内注射",
  "中枢神経系原発リンパ腫 PCNSL 大量メトトレキサート 全脳照射 治療",
  "MDS 骨髄異形成症候群 遺伝子変異 予後予測 IPSS-M IPSS-R",
  "遺伝子パネル検査 HemeSight 造血器腫瘍 腫瘍正常ペア解析 VUS germline",
  "寒冷凝集素症 cold agglutinin disease 自己免疫性溶血性貧血",
  "溶血性貧血 直接クームス試験 補体 C1s sutimlimab rituximab",
  "濾胞性リンパ腫 DLBCL 形質転換 transformed follicular lymphoma 予後",
];

export interface CapturedResult {
  rank: number;
  path: string;
  notePath: string;
  breadcrumbs: string;
  score: number;
  textChars: number;
}
export interface CapturedRun {
  query: string;
  ok: boolean;
  error?: string;
  ms: number;
  results: CapturedResult[];
}
export interface Capture {
  label: string;
  capturedAt: string;
  runs: CapturedRun[];
}

const outDir = resolve(process.env.LOCALAPPDATA!, "obsidian-mcp-tools/semantic-eval");
const configPath = resolve(process.env.APPDATA!, "Claude/claude_desktop_config.json");
const entry = JSON.parse(readFileSync(configPath, "utf8"))?.mcpServers?.["obsidian-mcp-tools"];
const apiKey: string | undefined = entry?.env?.OBSIDIAN_API_KEY;
// <vault>/.obsidian/plugins/mcp-tools/bin/mcp-server.exe -> <vault>
export const vaultRoot: string | undefined =
  typeof entry?.command === "string" ? resolve(dirname(entry.command), "../../../..") : undefined;
const baseUrl = `https://127.0.0.1:${process.env.OBSIDIAN_PORT ?? 27124}`;

async function capture(label: string): Promise<void> {
  if (!apiKey) throw new Error(`OBSIDIAN_API_KEY not found in ${configPath}`);
  const runs: CapturedRun[] = [];
  for (const query of QUERIES) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}/search/smart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "text/markdown" },
      body: JSON.stringify({ query, filter: { limit: 20 } }),
    });
    const ms = Math.round(performance.now() - started);
    const text = await response.text();
    if (!response.ok) {
      runs.push({ query, ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}`, ms, results: [] });
      continue;
    }
    const body = JSON.parse(text) as {
      results: { path: string; text: string; score: number; breadcrumbs: string }[];
    };
    runs.push({
      query,
      ok: true,
      ms,
      results: body.results.map((r, i) => ({
        rank: i + 1,
        path: r.path,
        notePath: r.path.split("#")[0],
        breadcrumbs: r.breadcrumbs,
        score: r.score,
        textChars: r.text.length,
      })),
    });
  }
  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, `${label}.json`);
  const result: Capture = { label, capturedAt: new Date().toISOString(), runs };
  writeFileSync(file, JSON.stringify(result, null, 2));
  for (const run of runs) {
    const head = `${run.ok ? "OK " : "ERR"} ${String(run.ms).padStart(6)} ms ${String(run.results.length).padStart(3)} results`;
    console.log(`${head}  ${run.query}${run.error ? `\n    ${run.error}` : ""}`);
  }
  console.log(`saved ${file}`);
}

const EVAL_DIR = "_mcp-tools-eval";
const JUDGMENT_FILE = "judgments.md";

function load(label: string): Capture {
  const capture = JSON.parse(readFileSync(resolve(outDir, `${label}.json`), "utf8")) as Capture;
  capture.runs.forEach((run, i) => {
    if (run.query !== QUERIES[i]) throw new Error(`${label}.json query ${i + 1} does not match QUERIES`);
  });
  return capture;
}

/** Note paths in rank order, each note once (judging is per note). */
function rankedNotes(run: CapturedRun): string[] {
  const out: string[] = [];
  for (const result of run.results) if (!out.includes(result.notePath)) out.push(result.notePath);
  return out;
}

function judgmentPath(): string {
  if (!vaultRoot) throw new Error(`vault location not found in ${configPath}`);
  return resolve(vaultRoot, EVAL_DIR, JUDGMENT_FILE);
}

function pool(labelA: string, labelB: string): void {
  const a = load(labelA);
  const b = load(labelB);
  const lines = [
    "# Semantic search judgments",
    "",
    "検索語ごとに、関連するノートの `[ ]` を `[x]` にしてください。並びは名前順で、どちらの方式の結果か、何位だったかは伏せています。",
    "",
  ];
  QUERIES.forEach((query, i) => {
    const notes = Array.from(new Set([...rankedNotes(a.runs[i]), ...rankedNotes(b.runs[i])])).sort((x, y) =>
      x.localeCompare(y),
    );
    lines.push(`## Q${i + 1}. ${query}`, "");
    for (const note of notes) lines.push(`- [ ] [[${note.replace(/\.md$/, "")}]]`);
    lines.push("");
  });
  const file = judgmentPath();
  if (existsSync(file)) throw new Error(`${file} already exists; delete it first so no ticks are lost by accident`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  console.log(`wrote ${file}`);
}

function readJudgments(): Map<number, Set<string>> {
  const relevant = new Map<number, Set<string>>();
  let current = -1;
  for (const line of readFileSync(judgmentPath(), "utf8").split(/\r?\n/)) {
    const heading = /^## Q(\d+)\./.exec(line);
    if (heading) {
      current = Number(heading[1]) - 1;
      relevant.set(current, new Set());
      continue;
    }
    const item = /^- \[([ xX])\] \[\[(.+)\]\]\s*$/.exec(line);
    if (item && current >= 0 && item[1] !== " ") relevant.get(current)!.add(`${item[2]}.md`);
  }
  return relevant;
}

function score(labelA: string, labelB: string): void {
  const captures = [load(labelA), load(labelB)];
  const judged = readJudgments();
  const totals = captures.map(() => ({ top10: 0, top20: 0, reciprocal: 0, recall: 0, recallCount: 0, chars: 0 }));
  const header = captures.map((c) => `${c.label} 上位10 | 上位20 | 初出 | 再現率 | ノート数 | 文字数`).join(" | ");
  console.log(`| Q | 関連 | ${header} |`);
  console.log(`|---|---|${captures.map(() => "---|---|---|---|---|---").join("|")}|`);
  QUERIES.forEach((_, i) => {
    const relevant = judged.get(i) ?? new Set<string>();
    const cells = captures.map((capture, c) => {
      const run = capture.runs[i];
      const ranked = rankedNotes(run);
      const top10 = ranked.slice(0, 10).filter((n) => relevant.has(n)).length;
      const top20 = ranked.slice(0, 20).filter((n) => relevant.has(n)).length;
      const first = ranked.findIndex((n) => relevant.has(n)) + 1;
      const recall = relevant.size > 0 ? ranked.filter((n) => relevant.has(n)).length / relevant.size : null;
      const chars = run.results.reduce((sum, r) => sum + r.textChars, 0);
      const t = totals[c];
      t.top10 += top10;
      t.top20 += top20;
      t.reciprocal += first > 0 ? 1 / first : 0;
      if (recall !== null) {
        t.recall += recall;
        t.recallCount++;
      }
      t.chars += chars;
      return `${top10} | ${top20} | ${first || "-"} | ${recall === null ? "-" : recall.toFixed(2)} | ${ranked.length} | ${chars}`;
    });
    console.log(`| ${i + 1} | ${relevant.size} | ${cells.join(" | ")} |`);
  });
  const n = QUERIES.length;
  const summary = totals
    .map((t) => `${(t.top10 / n).toFixed(1)} | ${(t.top20 / n).toFixed(1)} | MRR ${(t.reciprocal / n).toFixed(2)} | ${t.recallCount ? (t.recall / t.recallCount).toFixed(2) : "-"} | | ${Math.round(t.chars / n)}`)
    .join(" | ");
  console.log(`| 平均 | | ${summary} |`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "capture" && args[0]) {
  await capture(args[0]);
} else if (command === "pool" && args[0] && args[1]) {
  pool(args[0], args[1]);
} else if (command === "score" && args[0] && args[1]) {
  score(args[0], args[1]);
} else {
  console.error("usage: bun scripts/eval-semantic.ts capture <label> | pool <labelA> <labelB> | score <labelA> <labelB>");
  process.exit(1);
}
