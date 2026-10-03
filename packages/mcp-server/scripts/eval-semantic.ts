/**
 * Compares search_vault_smart before and after replacing Smart Connections
 * (docs/superpowers/specs/2026-10-03-semantic-search-design.md, 実機確認).
 *
 *   bun scripts/eval-semantic.ts capture <label>   run the queries (limit 20) and save the results
 *
 * Results go to %LOCALAPPDATA%/obsidian-mcp-tools/semantic-eval, outside the
 * repo and the vault, because they name personal notes. Only paths,
 * breadcrumbs, scores and text lengths are stored, never note text. The Local
 * REST API key and the vault location come from the Claude Desktop config;
 * the key is never printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
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

const [command, ...args] = process.argv.slice(2);
if (command === "capture" && args[0]) {
  await capture(args[0]);
} else {
  console.error("usage: bun scripts/eval-semantic.ts capture <label>");
  process.exit(1);
}
