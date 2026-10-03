# 意味検索の自前実装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `search_vault_smart` の裏側を Smart Connections から、本プラグインが作る埋め込みの索引（Cohere / OpenAI 互換）に置き換える。

**Architecture:** Obsidian プラグインの中に `features/semantic-search/` を作る。見出しごとの節を埋め込み、32 個の shard ファイルに Float32 で保存し、`POST /search/smart` で総当たり検索する。Obsidian に依存しない部品（分割・プロバイダ・索引・保存・差分計画・索引器・検索処理）は依存を引数で受け取り、`bun test` で単体テストする。MCP サーバ側はツール名と応答の形を保ったまま、`limit` の制限と索引状態の警告だけを足す。

**Tech Stack:** Bun 1.4（ランタイム・テスト・ビルド）、TypeScript、arktype 2.0.0-rc.30、Svelte 5（legacy 構文）、Obsidian API 1.12 typings（`requestUrl` / `SecretStorage` / `SecretComponent` / `Modal`）、MCP SDK 1.0.4。

**Spec:** `docs/superpowers/specs/2026-10-03-semantic-search-design.md`（この計画と一緒に読むこと）

## Global Constraints

- ブランチは `feat/semantic-search`。コミットは英語の conventional commits で、本文の最後に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける（`git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`）。
- ランタイムとテストは Bun だけ。Node や npm スクリプトを足さない。
- `packages/obsidian-plugin/src/features/semantic-search/` のうち `obsidianPorts.ts`・`index.ts`・`components/*` 以外のファイルは `obsidian`・`svelte`・`express` を import しない（`bun test` が解決できないため）。
- プラグインの tsconfig は `lib` が ES2016 相当で、`bun run check` は `src/*.ts` から辿れるファイルしか検査しない。`Array.prototype.findLast`・`at`・`String.prototype.replaceAll`・`Object.hasOwn` を使わない（`Object.entries` / `padStart` / `Array.from` / `includes` は可）。
- `verbatimModuleSyntax` が有効なので、型だけの import は `import type` か `type` 修飾子を使う。
- LLM に返す文言（エラー、警告）は英語にする（既存の `describeApiError` と揃える。spec 内の日本語文言は意味を保って英訳する）。
- API キーをログ・エラー・コミットに出さない。
- 決まっている値: Cohere モデル `embed-v5.0-fast`、既定次元 1024（選択肢 256 / 512 / 768 / 1024 / 1536 / 2048）、Cohere の 1 回 96 件、OpenAI 互換の既定 64 件、節の上限 4000 字、`limit` は 1〜50 の整数で既定 20、shard 数 32、差分のまとめ待ち 10 秒、保存は 30 秒後、再試行 2・8・30 秒、`Retry-After` の上限 120 秒、一時的な失敗からの再開 5 分、`minAppVersion` 1.11.4。
- 索引の置き場は `<vault>/.obsidian/plugins/mcp-tools/semantic-index/`（`plugin.manifest.dir` + `/semantic-index`）。

## Review Focus

spec が前提にしているが、素直に書くとテストから漏れやすい入力。各行のテストは担当タスクに入れてある。

1. コードブロック内の `# ...` のように見出しに見えるが見出しではない行。分割は metadataCache の見出し一覧だけに従い、本文として残すこと（Task 3）。
2. CRLF 改行のノート。`\r` が本文や breadcrumbs に残らないこと（Task 3）。
3. 全体の作成中に、すでに埋め込んだノートを編集した場合。作成が終わった後の差分処理で新しい内容が反映されること（Task 8）。
4. shard の保存中に落ちて `.tmp` だけが残った場合。読み込み時に `.tmp` から復旧し、索引を捨てないこと（Task 6）。
5. Obsidian の終了や設定変更で索引器を破棄したとき、走っている処理が終わっても状態・保存・通知に触らないこと（Task 8）。

---

## ファイル構成

作成（プラグイン、`packages/obsidian-plugin/src/features/semantic-search/`）:

| ファイル | 責務 |
|---|---|
| `hash.ts` | FNV-1a 32bit と SHA-256 |
| `chunker.ts` | 本文と見出し一覧から節のチャンクを作る |
| `settings.ts` | 設定の型・既定値・モデルの識別子・除外判定・設定済み判定 |
| `providers/types.ts` | プロバイダの共通の口と HTTP の型 |
| `providers/common.ts` | `EmbeddingError`、HTTP 応答の分類、JSON とベクトルの検証 |
| `providers/cohere.ts` | Cohere v2 embed |
| `providers/openaiCompatible.ts` | OpenAI 互換 `/embeddings` |
| `providers/index.ts` | 再 export と `createProvider` |
| `indexStore.ts` | メモリ上の索引（shard ごとの Map）、検索 |
| `shardFile.ts` | shard ファイルの符号化・復号 |
| `persistence.ts` | `FilePort`、manifest、索引の読み込み・保存・削除 |
| `plan.ts` | 照合の計画と、ノート単位の「何を埋め込むか」 |
| `indexer.ts` | 状態、待ち行列、まとめての埋め込み、再試行、見積もり |
| `searchHandler.ts` | `/search/smart` の中身 |
| `obsidianPorts.ts` | Obsidian API を `HttpFn` / `VaultPort` / `FilePort` に合わせる |
| `index.ts` | `SemanticSearchFeature`（組み立て、イベント、保存、設定、ルート） |
| `components/SemanticSearchSettings.svelte` | 設定画面 |
| `components/confirmIndexing.ts` | 送信前の確認ダイアログ |

各 `*.ts`（`obsidianPorts.ts`・`index.ts` を除く）に同名の `*.test.ts` を置く。

作成（MCP サーバ）: `packages/mcp-server/src/features/semantic-search/{index.ts,formatSearchResult.ts,formatSearchResult.test.ts,index.test.ts}`、`packages/mcp-server/scripts/{eval-semantic.ts,verify-semantic.ts}`。

変更: `packages/shared/src/types/{smart-search.ts,plugin-local-rest-api.ts,index.ts}`、`packages/obsidian-plugin/{package.json,src/main.ts,src/types.ts,src/shared/index.ts,src/features/core/components/SettingsTab.svelte,src/features/mcp-server-install/types.ts}`、`packages/mcp-server/{package.json,src/features/core/index.ts,src/shared/describeApiError.ts}`、`manifest.json`、`README.md`、`packages/*/README.md`、`docs/features/mcp-server-install.md`、`CLAUDE.md`。

削除: `packages/mcp-server/src/features/smart-connections/`、`packages/shared/src/types/plugin-smart-connections.ts`。

---

### Task 1: 切り替え前の検索結果を記録する

Smart Connections を外す前に、現行の `/search/smart` の結果を残す。後の評価（Task 15）で比べる基準になる。今 vault で動いているプラグインは Smart Connections 版なので、このタスクは他のどのタスクよりも先に実行する。

**Files:**
- Create: `packages/mcp-server/scripts/eval-semantic.ts`
- Modify: `packages/mcp-server/package.json`（scripts）

**Interfaces:**
- Produces: `bun run eval:semantic capture <label>` が `%LOCALAPPDATA%/obsidian-mcp-tools/semantic-eval/<label>.json` に `Capture` を書く。`Capture = { label, capturedAt, runs: CapturedRun[] }`、`CapturedRun = { query, ok, error?, ms, results: CapturedResult[] }`、`CapturedResult = { rank, path, notePath, breadcrumbs, score, textChars }`。`notePath` は `path` の `#` より前。Task 15 がこの形を読む。

- [ ] **Step 1: スクリプトを書く**

`packages/mcp-server/scripts/eval-semantic.ts`:

```ts
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
```

- [ ] **Step 2: package.json に script を足す**

`packages/mcp-server/package.json` の `"verify:paths"` の行の後に追加:

```json
    "eval:semantic": "bun scripts/eval-semantic.ts",
```

- [ ] **Step 3: 型チェック**

Run: `cd packages/mcp-server && bun run check`
Expected: エラーなし（scripts は tsconfig の対象外でも、実行時に Bun が型を剥がすので動く。エラーが出たらその行を直す）。

- [ ] **Step 4: 実行して記録する（Obsidian と現行プラグインが起動していること）**

Run: `cd packages/mcp-server && bun run eval:semantic capture smart-connections`
Expected: 10 行すべて `OK`、各 20 件前後。最後に `saved C:\Users\...\semantic-eval\smart-connections.json`。`ERR` があれば理由を記録して利用者に伝える（Smart Connections の索引が未完成など）。結果ファイルの中身は会話に貼らない。

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/scripts/eval-semantic.ts packages/mcp-server/package.json
git commit -m "chore: add a script that records semantic search results for evaluation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 検索の型と MCP ツールを新しい仕様にする

`limit` を 1〜50 の整数（既定 20）にし、応答に `index`（索引の状態）を足す。MCP ツールは名前と引数の形を変えずに、`features/semantic-search/` へ移して説明を書き換え、索引が完成していないときは警告を先頭に付ける。プラグイン側はまだ Smart Connections 版のままでよい（`index` は省略可にしてあるので、旧プラグインの応答も通る）。

**Files:**
- Modify: `packages/shared/src/types/smart-search.ts`
- Modify: `packages/shared/src/types/plugin-local-rest-api.ts:113-132`（`ApiSmartSearchResult` / `ApiSmartSearchResponse`）
- Create: `packages/mcp-server/src/features/semantic-search/index.ts`
- Create: `packages/mcp-server/src/features/semantic-search/formatSearchResult.ts`
- Test: `packages/mcp-server/src/features/semantic-search/formatSearchResult.test.ts`, `packages/mcp-server/src/features/semantic-search/index.test.ts`
- Modify: `packages/mcp-server/src/features/core/index.ts:7,52`
- Delete: `packages/mcp-server/src/features/smart-connections/index.ts`

**Interfaces:**
- Produces (shared): `searchRequest`（arktype、`{ query: string>0, filter?: { folders?: string[], excludeFolders?: string[], limit?: 1<=integer<=50 } }`）、`jsonSearchRequest`（文字列を JSON として解析してから `searchRequest`）、`searchIndexStatus` / `type SearchIndexStatus = { state: "unconfigured" | "empty" | "building" | "paused" | "ready"; reason?: string; indexedNotes: number; totalNotes: number; failedNotes: number; model: string }`、`searchResult`、`type SearchResponse = { results: { path, text, score, breadcrumbs }[]; index?: SearchIndexStatus }`、`SEARCH_LIMIT_DEFAULT = 20`、`SEARCH_LIMIT_MAX = 50`。`LocalRestAPI.ApiSmartSearchResponse` は `{ results, index? }`。
- Produces (mcp-server): `registerSemanticSearchTools(tools: ToolRegistry): void`、`formatSearchResult(data: LocalRestAPI.ApiSmartSearchResponseType): string`、`indexWarning(index: SearchIndexStatus | undefined): string | null`。

- [ ] **Step 1: shared の型を書き換える**

`packages/shared/src/types/smart-search.ts` を丸ごと置き換える:

```ts
import { type } from "arktype";
import { SmartSearchFilter } from "./plugin-smart-connections";

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;

export const searchRequest = type({
  query: type("string>0").describe("A search phrase for semantic search"),
  "filter?": {
    "folders?": type("string[]").describe(
      'Only return results whose vault path starts with one of these prefixes, e.g. ["Public/", "Work/"]. Matching is by string prefix, so "Work" also matches "Workshop/"',
    ),
    "excludeFolders?": type("string[]").describe(
      'Drop results whose vault path starts with one of these prefixes, e.g. ["Private/", "Archive/"]',
    ),
    "limit?": type("1 <= number.integer <= 50").describe(
      "The maximum number of results to return: an integer from 1 to 50, default 20",
    ),
  },
});
export const jsonSearchRequest = type("string.json.parse").to(searchRequest);

export const searchIndexStatus = type({
  state: "'unconfigured' | 'empty' | 'building' | 'paused' | 'ready'",
  "reason?": "string",
  indexedNotes: "number",
  totalNotes: "number",
  failedNotes: "number",
  model: "string",
});
export type SearchIndexStatus = typeof searchIndexStatus.infer;

export const searchResult = type({
  path: "string",
  text: "string",
  score: "number",
  breadcrumbs: "string",
});

const searchResponse = type({
  results: searchResult.array(),
  "index?": searchIndexStatus,
});
export type SearchResponse = typeof searchResponse.infer;

/** Smart Connections' filter format. Removed with the rest of the Smart Connections code in Task 12. */
export const searchParameters = type({
  query: "string",
  filter: SmartSearchFilter,
});
```

- [ ] **Step 2: Local REST API 側の応答型を合わせる**

`packages/shared/src/types/plugin-local-rest-api.ts` の先頭の import の下に追加:

```ts
import { searchIndexStatus, searchResult } from "./smart-search";
```

`ApiSmartSearchResult` と `ApiSmartSearchResponse` の定義（コメントは残す）を次に置き換える:

```ts
export const ApiSmartSearchResult = searchResult;

export const ApiSmartSearchResponse = type({
  results: ApiSmartSearchResult.array(),
  "index?": searchIndexStatus,
});
```

- [ ] **Step 3: 失敗するテストを書く**

`packages/mcp-server/src/features/semantic-search/formatSearchResult.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatSearchResult } from "./formatSearchResult";

const results = [{ path: "a.md", text: "## A\nalpha", score: 0.5, breadcrumbs: "a > A" }];
const index = {
  indexedNotes: 1200,
  totalNotes: 1803,
  failedNotes: 0,
  model: "cohere/embed-v5.0-fast@1024",
};

describe("formatSearchResult", () => {
  test("returns plain JSON when the index state is unknown or ready", () => {
    const bare = { results };
    expect(formatSearchResult(bare)).toBe(JSON.stringify(bare, null, 2));
    const ready = { results, index: { ...index, state: "ready" as const } };
    expect(formatSearchResult(ready)).toBe(JSON.stringify(ready, null, 2));
  });

  test("puts a warning first while the index is building", () => {
    const data = { results, index: { ...index, state: "building" as const } };
    expect(formatSearchResult(data)).toBe(
      "Index is still building (1200/1803 notes); results may be incomplete.\n\n" +
        JSON.stringify(data, null, 2),
    );
  });

  test("names the reason when the index is paused", () => {
    const data = {
      results,
      index: { ...index, state: "paused" as const, reason: "API key rejected" },
    };
    expect(formatSearchResult(data).split("\n")[0]).toBe(
      "Index is paused (API key rejected); results may be incomplete.",
    );
  });
});
```

`packages/mcp-server/src/features/semantic-search/index.test.ts`:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistryClass, type ToolRegistry } from "../../shared/ToolRegistry";
import { registerSemanticSearchTools } from ".";

const context = {
  server: new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } }),
};

let tools: ToolRegistry;
beforeEach(() => {
  tools = new ToolRegistryClass() as unknown as ToolRegistry;
  registerSemanticSearchTools(tools);
});

describe("search_vault_smart arguments", () => {
  const cases: [number, string][] = [
    [0, "at least 1"],
    [51, "at most 50"],
    [2.5, "integer"],
  ];
  for (const [limit, reason] of cases) {
    test(`limit ${limit} comes back as an error result that says why`, async () => {
      const result = await tools.dispatch(
        { name: "search_vault_smart", arguments: { query: "x", filter: { limit } } },
        context,
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(reason);
    });
  }

  test("the tool advertises the 1-50 range and the default of 20", () => {
    const tool = tools.list().tools.find((t) => t.name === "search_vault_smart");
    expect(JSON.stringify(tool?.inputSchema)).toContain('"maximum":50');
    expect(tool?.description).toContain("limit defaults to 20");
  });
});
```

- [ ] **Step 4: テストが失敗することを確かめる**

Run: `cd packages/mcp-server && bun test src/features/semantic-search`
Expected: FAIL（`Cannot find module './formatSearchResult'` / `'.'`）

- [ ] **Step 5: 実装する**

`packages/mcp-server/src/features/semantic-search/formatSearchResult.ts`:

```ts
import type { LocalRestAPI, SearchIndexStatus } from "shared";

/** A line telling the caller the index is incomplete, or null when it is complete or unknown. */
export function indexWarning(index: SearchIndexStatus | undefined): string | null {
  if (!index) return null;
  if (index.state === "building") {
    return `Index is still building (${index.indexedNotes}/${index.totalNotes} notes); results may be incomplete.`;
  }
  if (index.state === "paused") {
    return `Index is paused (${index.reason ?? "no reason given"}); results may be incomplete.`;
  }
  return null;
}

export function formatSearchResult(data: LocalRestAPI.ApiSmartSearchResponseType): string {
  const json = JSON.stringify(data, null, 2);
  const warning = indexWarning(data.index);
  return warning ? `${warning}\n\n${json}` : json;
}
```

`packages/mcp-server/src/features/semantic-search/index.ts`:

```ts
import { makeRequest, type ToolRegistry } from "$/shared";
import { type } from "arktype";
import { LocalRestAPI, searchRequest } from "shared";
import { formatSearchResult } from "./formatSearchResult";

export function registerSemanticSearchTools(tools: ToolRegistry) {
  tools.register(
    type({
      name: '"search_vault_smart"',
      arguments: searchRequest,
    }).describe(
      "Semantic search over the vault using the embedding index built by the MCP Tools Obsidian plugin (the embedding provider and model are configured in the plugin settings). Finds sections whose meaning is close to the query even when they share no words with it. Results are per heading section, so one note can appear more than once. Returns { results: [{ path, text, score, breadcrumbs }], index }, where text is the section body and breadcrumbs is 'note > heading > subheading'. limit defaults to 20, max 50. For exact words or phrases use search_vault_simple.",
    ),
    async ({ arguments: args }) => {
      const data = await makeRequest(LocalRestAPI.ApiSmartSearchResponse, `/search/smart`, {
        method: "POST",
        body: JSON.stringify(args),
      });
      return { content: [{ type: "text", text: formatSearchResult(data) }] };
    },
  );
}
```

`packages/mcp-server/src/features/core/index.ts` の import と呼び出しを置き換える:

```ts
import { registerSemanticSearchTools } from "../semantic-search";
```

```ts
    registerSemanticSearchTools(this.tools);
```

旧ファイルを消す:

```bash
git rm packages/mcp-server/src/features/smart-connections/index.ts
```

- [ ] **Step 6: テストと型チェック**

Run: `cd packages/mcp-server && bun test src/features/semantic-search && bun test && cd ../.. && bun run check`
Expected: 新しいテストはすべて PASS。全体の失敗は `parseTemplateParameters.test.ts` の既知の 4 件だけ。`bun run check` はエラーなし。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types packages/mcp-server/src/features
git commit -m "feat: limit semantic search to 1-50 results and report the index state" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: プラグインのテスト基盤、ハッシュ、節への分割

**Files:**
- Modify: `packages/obsidian-plugin/package.json`（scripts に `test`）
- Create: `packages/obsidian-plugin/src/features/semantic-search/hash.ts`
- Create: `packages/obsidian-plugin/src/features/semantic-search/chunker.ts`
- Test: `.../semantic-search/hash.test.ts`, `.../semantic-search/chunker.test.ts`

**Interfaces:**
- Produces: `fnv1a32(text: string): number`、`sha256Hex(text: string): Promise<string>`、`CHUNKER_VERSION = 1`、`interface HeadingInfo { heading: string; level: number; line: number; endLine: number }`（行は 0 始まり）、`interface ChunkInput { path; content; headings: HeadingInfo[]; frontmatterEndLine: number | null; maxChunkChars: number }`、`interface Chunk { breadcrumbs: string; text: string; embedText: string }`、`noteName(path): string`、`chunkNote(input: ChunkInput): Chunk[]`、`splitText(text: string, max: number): string[]`。

- [ ] **Step 1: test スクリプトを足す**

`packages/obsidian-plugin/package.json` の `"check": "tsc --noEmit",` の後に追加:

```json
		"test": "bun test src",
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/obsidian-plugin/src/features/semantic-search/hash.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { fnv1a32, sha256Hex } from "./hash";

describe("fnv1a32", () => {
  test("matches the reference values", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });
  test("is an unsigned 32-bit integer for non-ASCII paths", () => {
    const value = fnv1a32("日記/2026-09-03.md");
    expect(Number.isInteger(value) && value >= 0 && value < 2 ** 32).toBe(true);
  });
});

describe("sha256Hex", () => {
  test("matches the reference digest", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  test("hashes UTF-8 text", async () => {
    const a = await sha256Hex("日本語");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await sha256Hex("日本"));
  });
});
```

`packages/obsidian-plugin/src/features/semantic-search/chunker.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { chunkNote, splitText, type HeadingInfo } from "./chunker";

const h = (heading: string, level: number, line: number): HeadingInfo => ({
  heading,
  level,
  line,
  endLine: line,
});

const base = { frontmatterEndLine: null, maxChunkChars: 4000 };

describe("chunkNote", () => {
  test("a note without headings is one chunk named after the file", () => {
    const chunks = chunkNote({ ...base, path: "a/b/Note.md", content: "hello\n\nworld", headings: [] });
    expect(chunks).toEqual([
      { breadcrumbs: "Note", text: "hello\n\nworld", embedText: "Note\n\nhello\n\nworld" },
    ]);
  });

  test("frontmatter is left out", () => {
    const chunks = chunkNote({
      ...base,
      path: "Note.md",
      content: "---\ntags: [x]\n---\nbody",
      headings: [],
      frontmatterEndLine: 2,
    });
    expect(chunks.map((c) => c.text)).toEqual(["body"]);
  });

  test("text before the first heading, then one chunk per heading with its path", () => {
    const content = ["intro", "# Title", "t body", "## A", "a body", "### A1", "a1 body", "## B", "b body"].join("\n");
    const headings = [h("Title", 1, 1), h("A", 2, 3), h("A1", 3, 5), h("B", 2, 7)];
    const chunks = chunkNote({ ...base, path: "Note.md", content, headings });
    expect(chunks.map((c) => [c.breadcrumbs, c.text])).toEqual([
      ["Note", "intro"],
      ["Note > Title", "# Title\nt body"],
      ["Note > Title > A", "## A\na body"],
      ["Note > Title > A > A1", "### A1\na1 body"],
      ["Note > Title > B", "## B\nb body"],
    ]);
  });

  test("headings with no body of their own are not embedded", () => {
    const content = "# Title\n## Empty\n\n## Full\nx";
    const headings = [h("Title", 1, 0), h("Empty", 2, 1), h("Full", 2, 3)];
    const chunks = chunkNote({ ...base, path: "Note.md", content, headings });
    expect(chunks.map((c) => c.breadcrumbs)).toEqual(["Note > Title > Full"]);
  });

  test("emoji, full-width brackets and slashes in headings are kept as written", () => {
    const content = "# 📝 本日の振り返り（事実）\n## 個人/家族\n子供が発熱";
    const headings = [h("📝 本日の振り返り（事実）", 1, 0), h("個人/家族", 2, 1)];
    const chunks = chunkNote({ ...base, path: "Daily log/2026-09-03.md", content, headings });
    expect(chunks[0].breadcrumbs).toBe("2026-09-03 > 📝 本日の振り返り（事実） > 個人/家族");
    expect(chunks[0].embedText).toBe(
      "2026-09-03 > 📝 本日の振り返り（事実） > 個人/家族\n\n## 個人/家族\n子供が発熱",
    );
  });

  test("a long section is split at blank lines and every part keeps the breadcrumbs", () => {
    const content = "## H\naaaaaaaaaa\n\nbbbbbbbbbb\n\ncccccccccc";
    const chunks = chunkNote({ ...base, maxChunkChars: 20, path: "Note.md", content, headings: [h("H", 2, 0)] });
    expect(chunks.map((c) => c.text)).toEqual(["## H\naaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
    expect(new Set(chunks.map((c) => c.breadcrumbs))).toEqual(new Set(["Note > H"]));
  });

  test("a note with only frontmatter has no chunks", () => {
    const chunks = chunkNote({ ...base, path: "Note.md", content: "---\na: 1\n---\n", headings: [], frontmatterEndLine: 2 });
    expect(chunks).toEqual([]);
  });

  // Review Focus 1: Obsidian does not list "# ..." inside code blocks as a heading.
  test("lines that look like headings but are not in the heading list stay in the body", () => {
    const content = "# Setup\n```bash\n# not a heading\necho hi\n```";
    const chunks = chunkNote({ ...base, path: "Note.md", content, headings: [h("Setup", 1, 0)] });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("# not a heading");
  });

  // Review Focus 2
  test("CRLF line endings leave no carriage returns behind", () => {
    const chunks = chunkNote({ ...base, path: "Note.md", content: "# T\r\nbody\r\n", headings: [h("T", 1, 0)] });
    expect(chunks.map((c) => c.text)).toEqual(["# T\nbody"]);
    expect(chunks[0].embedText.includes("\r")).toBe(false);
  });
});

describe("splitText", () => {
  test("text within the limit is returned as is", () => {
    expect(splitText("short", 10)).toEqual(["short"]);
  });
  test("a single paragraph over the limit is cut at the limit", () => {
    const text = "# H\n" + "x".repeat(25);
    const parts = splitText(text, 10);
    expect(parts.every((p) => p.length <= 10)).toBe(true);
    expect(parts.join("")).toBe(text);
  });
});
```

- [ ] **Step 3: テストが失敗することを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search`
Expected: FAIL（`Cannot find module './hash'` / `'./chunker'`）

- [ ] **Step 4: 実装する**

`packages/obsidian-plugin/src/features/semantic-search/hash.ts`:

```ts
/** 32-bit FNV-1a over the UTF-16 code units of `text`. Stable across runs; picks a path's shard. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Lower-case hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
```

`packages/obsidian-plugin/src/features/semantic-search/chunker.ts`:

```ts
/** Bump when the chunking rules change. It is part of the index fingerprint, so the index is rebuilt. */
export const CHUNKER_VERSION = 1;

export interface HeadingInfo {
  heading: string;
  /** 1-6 */
  level: number;
  /** 0-based line where the heading starts. */
  line: number;
  /** 0-based last line of the heading; differs from `line` only for setext headings. */
  endLine: number;
}

export interface ChunkInput {
  path: string;
  content: string;
  /**
   * Headings as parsed by Obsidian's metadata cache. Lines that only look like
   * headings (inside code blocks, for example) are not in this list and stay body text.
   */
  headings: HeadingInfo[];
  /** 0-based line of the closing `---` of the frontmatter, or null when there is none. */
  frontmatterEndLine: number | null;
  maxChunkChars: number;
}

export interface Chunk {
  /** "note > H1 > H2" */
  breadcrumbs: string;
  /** The section as written; the first part of a section starts with its heading line. */
  text: string;
  /** What is sent to the embedding API: the breadcrumbs, a blank line, then the text. */
  embedText: string;
}

export function noteName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/**
 * Splits a note into one chunk per heading section (any depth), plus one for
 * the text before the first heading. Sections whose body is empty are skipped,
 * and sections over `maxChunkChars` are split at paragraph boundaries.
 */
export function chunkNote(input: ChunkInput): Chunk[] {
  const lines = input.content.split(/\r?\n/);
  const bodyStart = input.frontmatterEndLine === null ? 0 : input.frontmatterEndLine + 1;
  const headings = input.headings
    .filter((h) => h.line >= bodyStart && h.line < lines.length)
    .sort((a, b) => a.line - b.line);
  const sections: { trail: string[]; text: string }[] = [];

  const preambleEnd = headings.length > 0 ? headings[0].line : lines.length;
  const preamble = lines.slice(bodyStart, preambleEnd).join("\n").trim();
  if (preamble) sections.push({ trail: [], text: preamble });

  const stack: HeadingInfo[] = [];
  headings.forEach((heading, i) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
    stack.push(heading);
    const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
    const body = lines.slice(heading.endLine + 1, end).join("\n").trim();
    if (!body) return;
    sections.push({
      trail: stack.map((h) => h.heading),
      text: lines.slice(heading.line, end).join("\n").trim(),
    });
  });

  const name = noteName(input.path);
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const breadcrumbs = [name, ...section.trail].join(" > ");
    for (const part of splitText(section.text, input.maxChunkChars)) {
      chunks.push({ breadcrumbs, text: part, embedText: `${breadcrumbs}\n\n${part}` });
    }
  }
  return chunks;
}

/** Splits text into parts of at most `max` characters, preferring blank-line paragraph boundaries. */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    if (paragraph.length > max) {
      flush();
      for (let i = 0; i < paragraph.length; i += max) {
        const piece = paragraph.slice(i, i + max);
        if (piece.trim()) parts.push(piece);
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > max) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  flush();
  return parts;
}
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search`
Expected: すべて PASS

- [ ] **Step 6: Commit**

```bash
git add packages/obsidian-plugin/package.json packages/obsidian-plugin/src/features/semantic-search
git commit -m "feat: split notes into heading sections for embedding" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 設定とプロバイダ

**Files:**
- Create: `.../semantic-search/settings.ts`
- Create: `.../semantic-search/providers/{types.ts,common.ts,cohere.ts,openaiCompatible.ts,index.ts}`
- Test: `.../semantic-search/settings.test.ts`, `.../semantic-search/providers/{common.test.ts,cohere.test.ts,openaiCompatible.test.ts}`

**Interfaces:**
- Consumes: `CHUNKER_VERSION`（Task 3）
- Produces (settings): `COHERE_DIMENSIONS`、`type CohereDimension`、`type ProviderKind = "cohere" | "openai-compatible"`、`interface SemanticSearchSettings`（下のコードの形）、`DEFAULT_SEMANTIC_SEARCH_SETTINGS`、`withDefaults(stored?: Partial<SemanticSearchSettings>): SemanticSearchSettings`、`interface IndexFingerprint { provider; model; dimension: number | null; queryPrefix; documentPrefix; maxChunkChars; chunkerVersion }`、`fingerprintOf(s): IndexFingerprint`、`fingerprintKey(fp): string`、`modelLabel(fp): string`、`isExcluded(path, excludeFolders): boolean`、`type SecretLookup = (id: string) => string | null`、`isConfigured(s, getSecret): boolean`、`requiresRebuild(a, b): boolean`、`parseExcludeFolders(text): string[]`。
- Produces (providers): `type EmbedKind = "document" | "query"`、`interface EmbedResult { vectors: Float32Array[]; tokens: number }`、`interface EmbeddingProvider { readonly batchSize: number; embed(texts: string[], kind: EmbedKind): Promise<EmbedResult> }`（1 回の `embed` は 1 リクエスト、`texts.length <= batchSize`）、`HttpRequest` / `HttpResponse` / `type HttpFn`、`type EmbeddingErrorKind = "auth" | "rate-limit" | "server" | "network" | "bad-request" | "bad-response"`、`class EmbeddingError { kind; retryAfterMs?; get retryable(): boolean }`、`createCohereProvider`、`createOpenAiCompatibleProvider`、`embeddingsUrl`、`createProvider(settings, getSecret, http): EmbeddingProvider`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/obsidian-plugin/src/features/semantic-search/settings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SEMANTIC_SEARCH_SETTINGS,
  fingerprintKey,
  fingerprintOf,
  isConfigured,
  isExcluded,
  modelLabel,
  parseExcludeFolders,
  requiresRebuild,
  withDefaults,
  type SemanticSearchSettings,
} from "./settings";

const clone = (s: SemanticSearchSettings): SemanticSearchSettings => JSON.parse(JSON.stringify(s));

describe("withDefaults", () => {
  test("fills fields missing from older data.json, including nested ones", () => {
    const s = withDefaults({ cohere: { apiKeySecretId: "cohere-key" } } as never);
    expect(s.cohere).toEqual({ model: "embed-v5.0-fast", dimension: 1024, apiKeySecretId: "cohere-key" });
    expect(s.openaiCompatible.batchSize).toBe(64);
    expect(s.maxChunkChars).toBe(4000);
    expect(withDefaults(undefined)).toEqual(DEFAULT_SEMANTIC_SEARCH_SETTINGS);
  });
});

describe("fingerprint", () => {
  const a = clone(DEFAULT_SEMANTIC_SEARCH_SETTINGS);

  test("changes with the things that change the vectors", () => {
    const b = clone(a);
    b.cohere.dimension = 512;
    expect(requiresRebuild(a, b)).toBe(true);
    const c = clone(a);
    c.maxChunkChars = 2000;
    expect(requiresRebuild(a, c)).toBe(true);
    const d = clone(a);
    d.provider = "openai-compatible";
    expect(requiresRebuild(a, d)).toBe(true);
  });

  test("does not change with the API key, base URL, batch size or exclusions", () => {
    const b = clone(a);
    b.cohere.apiKeySecretId = "other";
    b.openaiCompatible.baseUrl = "http://elsewhere/v1";
    b.openaiCompatible.batchSize = 8;
    b.excludeFolders = ["Private/"];
    expect(requiresRebuild(a, b)).toBe(false);
  });

  test("labels the model for humans", () => {
    expect(modelLabel(fingerprintOf(a))).toBe("cohere/embed-v5.0-fast@1024");
    const o = clone(a);
    o.provider = "openai-compatible";
    o.openaiCompatible.model = "nomic-embed-text";
    expect(modelLabel(fingerprintOf(o))).toBe("openai-compatible/nomic-embed-text");
    expect(fingerprintKey(fingerprintOf(o))).toContain('"chunkerVersion":1');
  });
});

describe("isExcluded", () => {
  test("matches by path prefix", () => {
    expect(isExcluded("Private/a.md", ["Private/"])).toBe(true);
    expect(isExcluded("Templates2/a.md", ["Templates"])).toBe(true);
    expect(isExcluded("Templates2/a.md", ["Templates/"])).toBe(false);
    expect(isExcluded("a.md", [""])).toBe(false);
  });
});

describe("isConfigured", () => {
  const secrets: Record<string, string> = { "cohere-key": "k" };
  const lookup = (id: string) => secrets[id] ?? null;

  test("Cohere needs a stored key and a model", () => {
    const s = clone(DEFAULT_SEMANTIC_SEARCH_SETTINGS);
    expect(isConfigured(s, lookup)).toBe(false);
    s.cohere.apiKeySecretId = "cohere-key";
    expect(isConfigured(s, lookup)).toBe(true);
    s.cohere.apiKeySecretId = "missing";
    expect(isConfigured(s, lookup)).toBe(false);
  });

  test("OpenAI-compatible needs a base URL and a model; the key is optional but must exist if named", () => {
    const s = clone(DEFAULT_SEMANTIC_SEARCH_SETTINGS);
    s.provider = "openai-compatible";
    expect(isConfigured(s, lookup)).toBe(false);
    s.openaiCompatible.baseUrl = "http://localhost:11434/v1";
    s.openaiCompatible.model = "nomic-embed-text";
    expect(isConfigured(s, lookup)).toBe(true);
    s.openaiCompatible.apiKeySecretId = "missing";
    expect(isConfigured(s, lookup)).toBe(false);
  });
});

describe("parseExcludeFolders", () => {
  test("one prefix per line, blanks dropped", () => {
    expect(parseExcludeFolders(" Private/ \n\nArchive/\r\n")).toEqual(["Private/", "Archive/"]);
  });
});
```

`packages/obsidian-plugin/src/features/semantic-search/providers/common.test.ts`:

```ts
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
```

`packages/obsidian-plugin/src/features/semantic-search/providers/cohere.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createCohereProvider } from "./cohere";
import type { HttpFn, HttpRequest, HttpResponse } from "./types";

function stub(responses: HttpResponse[]) {
  const requests: HttpRequest[] = [];
  const http: HttpFn = async (request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("no stubbed response");
    return next;
  };
  return { http, requests };
}
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, text: JSON.stringify(body) });

describe("Cohere provider", () => {
  test("sends documents as search_document with the chosen dimension", async () => {
    const { http, requests } = stub([
      ok({ embeddings: { float: [[1, 2], [3, 4]] }, meta: { billed_units: { input_tokens: 12 } } }),
    ]);
    const provider = createCohereProvider({ apiKey: "k", model: "embed-v5.0-fast", dimension: 2, http });
    const result = await provider.embed(["a", "b"], "document");
    expect(requests[0].url).toBe("https://api.cohere.com/v2/embed");
    expect(requests[0].headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(requests[0].body)).toEqual({
      model: "embed-v5.0-fast",
      texts: ["a", "b"],
      input_type: "search_document",
      embedding_types: ["float"],
      output_dimension: 2,
      truncate: "END",
    });
    expect(result.vectors.map((v) => Array.from(v))).toEqual([[1, 2], [3, 4]]);
    expect(result.tokens).toBe(12);
  });

  test("sends queries as search_query", async () => {
    const { http, requests } = stub([ok({ embeddings: { float: [[1, 2]] } })]);
    await createCohereProvider({ apiKey: "k", model: "m", dimension: 2, http }).embed(["q"], "query");
    expect(JSON.parse(requests[0].body).input_type).toBe("search_query");
  });

  test("refuses more than 96 texts and sends nothing for none", async () => {
    const { http, requests } = stub([]);
    const provider = createCohereProvider({ apiKey: "k", model: "m", dimension: 2, http });
    expect(provider.batchSize).toBe(96);
    await expect(provider.embed(new Array(97).fill("x"), "document")).rejects.toThrow("at most 96");
    expect(await provider.embed([], "document")).toEqual({ vectors: [], tokens: 0 });
    expect(requests).toHaveLength(0);
  });

  test("a response with the wrong count or dimension is a bad response", async () => {
    const short = stub([ok({ embeddings: { float: [[1, 2]] } })]);
    await expect(
      createCohereProvider({ apiKey: "k", model: "m", dimension: 2, http: short.http }).embed(["a", "b"], "document"),
    ).rejects.toMatchObject({ kind: "bad-response" });
    const wide = stub([ok({ embeddings: { float: [[1, 2, 3]] } })]);
    await expect(
      createCohereProvider({ apiKey: "k", model: "m", dimension: 2, http: wide.http }).embed(["a"], "document"),
    ).rejects.toMatchObject({ kind: "bad-response" });
  });

  test("HTTP errors are classified", async () => {
    const { http } = stub([{ status: 401, headers: {}, text: "invalid api token" }]);
    await expect(
      createCohereProvider({ apiKey: "bad", model: "m", dimension: 2, http }).embed(["a"], "document"),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});
```

`packages/obsidian-plugin/src/features/semantic-search/providers/openaiCompatible.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createOpenAiCompatibleProvider, embeddingsUrl } from "./openaiCompatible";
import type { HttpFn, HttpRequest, HttpResponse } from "./types";

function stub(responses: HttpResponse[]) {
  const requests: HttpRequest[] = [];
  const http: HttpFn = async (request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("no stubbed response");
    return next;
  };
  return { http, requests };
}
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, text: JSON.stringify(body) });
const options = {
  baseUrl: "http://localhost:11434/v1/",
  apiKey: null,
  model: "e5",
  dimensions: null,
  queryPrefix: "query: ",
  documentPrefix: "passage: ",
  batchSize: 2,
};

describe("OpenAI-compatible provider", () => {
  test("joins the base URL without doubling slashes", () => {
    expect(embeddingsUrl("http://h/v1/")).toBe("http://h/v1/embeddings");
    expect(embeddingsUrl("http://h/v1")).toBe("http://h/v1/embeddings");
  });

  test("adds the prefix for the kind, omits dimensions and auth when unset, and reorders by index", async () => {
    const { http, requests } = stub([
      ok({
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
        usage: { prompt_tokens: 7 },
      }),
    ]);
    const result = await createOpenAiCompatibleProvider({ ...options, http }).embed(["a", "b"], "document");
    expect(requests[0].url).toBe("http://localhost:11434/v1/embeddings");
    expect(requests[0].headers.Authorization).toBeUndefined();
    expect(JSON.parse(requests[0].body)).toEqual({
      model: "e5",
      input: ["passage: a", "passage: b"],
      encoding_format: "float",
    });
    expect(result.vectors.map((v) => Array.from(v))).toEqual([[1, 2], [3, 4]]);
    expect(result.tokens).toBe(7);
  });

  test("sends dimensions and the key when set, and the query prefix for queries", async () => {
    const { http, requests } = stub([ok({ data: [{ index: 0, embedding: [1, 2] }], usage: { total_tokens: 3 } })]);
    const result = await createOpenAiCompatibleProvider({ ...options, apiKey: "k", dimensions: 2, http }).embed(["q"], "query");
    expect(requests[0].headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(requests[0].body)).toMatchObject({ input: ["query: q"], dimensions: 2 });
    expect(result.tokens).toBe(3);
  });

  test("vectors of different lengths in one response are a bad response", async () => {
    const { http } = stub([ok({ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1] }] })]);
    await expect(createOpenAiCompatibleProvider({ ...options, http }).embed(["a", "b"], "document")).rejects.toMatchObject({
      kind: "bad-response",
    });
  });

  test("refuses more texts than its batch size", async () => {
    const { http } = stub([]);
    await expect(createOpenAiCompatibleProvider({ ...options, http }).embed(["a", "b", "c"], "document")).rejects.toThrow(
      "at most 2",
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search`
Expected: FAIL（`./settings`、`./common`、`./cohere`、`./openaiCompatible` が無い）

- [ ] **Step 3: settings を実装する**

`packages/obsidian-plugin/src/features/semantic-search/settings.ts`:

```ts
import { CHUNKER_VERSION } from "./chunker";

export const COHERE_DIMENSIONS = [256, 512, 768, 1024, 1536, 2048] as const;
export type CohereDimension = (typeof COHERE_DIMENSIONS)[number];
export type ProviderKind = "cohere" | "openai-compatible";

export interface SemanticSearchSettings {
  provider: ProviderKind;
  cohere: { model: string; dimension: CohereDimension; apiKeySecretId: string };
  openaiCompatible: {
    baseUrl: string;
    model: string;
    /** Sent as `dimensions` only when set. */
    dimensions: number | null;
    /** Empty for servers that need no key (Ollama, LM Studio). */
    apiKeySecretId: string;
    queryPrefix: string;
    documentPrefix: string;
    batchSize: number;
  };
  /** Path prefixes never sent to the embedding API. */
  excludeFolders: string[];
  maxChunkChars: number;
}

export const DEFAULT_SEMANTIC_SEARCH_SETTINGS: SemanticSearchSettings = {
  provider: "cohere",
  cohere: { model: "embed-v5.0-fast", dimension: 1024, apiKeySecretId: "" },
  openaiCompatible: {
    baseUrl: "",
    model: "",
    dimensions: null,
    apiKeySecretId: "",
    queryPrefix: "",
    documentPrefix: "",
    batchSize: 64,
  },
  excludeFolders: [],
  maxChunkChars: 4000,
};

/** Fills fields missing from stored settings (an older data.json) with the defaults. */
export function withDefaults(stored: Partial<SemanticSearchSettings> | undefined): SemanticSearchSettings {
  const d = DEFAULT_SEMANTIC_SEARCH_SETTINGS;
  return {
    ...d,
    ...stored,
    cohere: { ...d.cohere, ...stored?.cohere },
    openaiCompatible: { ...d.openaiCompatible, ...stored?.openaiCompatible },
    excludeFolders: [...(stored?.excludeFolders ?? d.excludeFolders)],
  };
}

/** Everything that changes the vectors. A different fingerprint means the index must be rebuilt. */
export interface IndexFingerprint {
  provider: ProviderKind;
  model: string;
  /** null for OpenAI-compatible models whose dimension is not fixed in the settings. */
  dimension: number | null;
  queryPrefix: string;
  documentPrefix: string;
  maxChunkChars: number;
  chunkerVersion: number;
}

export function fingerprintOf(s: SemanticSearchSettings): IndexFingerprint {
  if (s.provider === "cohere") {
    return {
      provider: "cohere",
      model: s.cohere.model,
      dimension: s.cohere.dimension,
      queryPrefix: "",
      documentPrefix: "",
      maxChunkChars: s.maxChunkChars,
      chunkerVersion: CHUNKER_VERSION,
    };
  }
  const o = s.openaiCompatible;
  return {
    provider: "openai-compatible",
    model: o.model,
    dimension: o.dimensions,
    queryPrefix: o.queryPrefix,
    documentPrefix: o.documentPrefix,
    maxChunkChars: s.maxChunkChars,
    chunkerVersion: CHUNKER_VERSION,
  };
}

/** Readable, order-stable JSON, so equal fingerprints are equal strings. */
export function fingerprintKey(fp: IndexFingerprint): string {
  return JSON.stringify({
    provider: fp.provider,
    model: fp.model,
    dimension: fp.dimension,
    queryPrefix: fp.queryPrefix,
    documentPrefix: fp.documentPrefix,
    maxChunkChars: fp.maxChunkChars,
    chunkerVersion: fp.chunkerVersion,
  });
}

export function modelLabel(fp: IndexFingerprint): string {
  return `${fp.provider}/${fp.model}${fp.dimension ? `@${fp.dimension}` : ""}`;
}

export function isExcluded(path: string, excludeFolders: string[]): boolean {
  return excludeFolders.some((prefix) => prefix.length > 0 && path.startsWith(prefix));
}

export type SecretLookup = (id: string) => string | null;

export function isConfigured(s: SemanticSearchSettings, getSecret: SecretLookup): boolean {
  if (s.provider === "cohere") {
    return s.cohere.model.trim() !== "" && s.cohere.apiKeySecretId !== "" && !!getSecret(s.cohere.apiKeySecretId);
  }
  const o = s.openaiCompatible;
  if (o.baseUrl.trim() === "" || o.model.trim() === "") return false;
  return o.apiKeySecretId === "" || !!getSecret(o.apiKeySecretId);
}

export function requiresRebuild(a: SemanticSearchSettings, b: SemanticSearchSettings): boolean {
  return fingerprintKey(fingerprintOf(a)) !== fingerprintKey(fingerprintOf(b));
}

export function parseExcludeFolders(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
```

- [ ] **Step 4: providers を実装する**

`packages/obsidian-plugin/src/features/semantic-search/providers/types.ts`:

```ts
export type EmbedKind = "document" | "query";

export interface EmbedResult {
  vectors: Float32Array[];
  /** Tokens billed for the call, 0 when the API does not say. */
  tokens: number;
}

export interface EmbeddingProvider {
  /** Largest number of texts a single embed() call may carry. One call is one HTTP request. */
  readonly batchSize: number;
  embed(texts: string[], kind: EmbedKind): Promise<EmbedResult>;
}

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** Sends one request. Resolves for every status code; rejects only when no response arrived. */
export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;
```

`packages/obsidian-plugin/src/features/semantic-search/providers/common.ts`:

```ts
import type { HttpFn, HttpRequest, HttpResponse } from "./types";

export type EmbeddingErrorKind = "auth" | "rate-limit" | "server" | "network" | "bad-request" | "bad-response";

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
    return this.kind === "rate-limit" || this.kind === "server" || this.kind === "network";
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
  if (response.status >= 500) return new EmbeddingError(message, "server", parseRetryAfter(response.headers));
  return new EmbeddingError(message, "bad-request");
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
```

`packages/obsidian-plugin/src/features/semantic-search/providers/cohere.ts`:

```ts
import { EmbeddingError, parseJson, send, toVector } from "./common";
import type { EmbedKind, EmbedResult, EmbeddingProvider, HttpFn } from "./types";

export const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";
export const COHERE_BATCH_SIZE = 96;

export interface CohereOptions {
  apiKey: string;
  model: string;
  dimension: number;
  http: HttpFn;
}

export function createCohereProvider(options: CohereOptions): EmbeddingProvider {
  return {
    batchSize: COHERE_BATCH_SIZE,
    async embed(texts: string[], kind: EmbedKind): Promise<EmbedResult> {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      if (texts.length > COHERE_BATCH_SIZE) {
        throw new Error(`Cohere accepts at most ${COHERE_BATCH_SIZE} texts per call (got ${texts.length})`);
      }
      const response = await send("Cohere", options.http, {
        url: COHERE_EMBED_URL,
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          texts,
          input_type: kind === "query" ? "search_query" : "search_document",
          embedding_types: ["float"],
          output_dimension: options.dimension,
          truncate: "END",
        }),
      });
      const json = parseJson("Cohere", response.text) as {
        embeddings?: { float?: unknown };
        meta?: { billed_units?: { input_tokens?: unknown } };
      };
      const floats = json.embeddings?.float;
      if (!Array.isArray(floats) || floats.length !== texts.length) {
        const got = Array.isArray(floats) ? floats.length : "no";
        throw new EmbeddingError(`Cohere returned ${got} embeddings for ${texts.length} texts`, "bad-response");
      }
      return {
        vectors: floats.map((value) => toVector("Cohere", value, options.dimension)),
        tokens: Number(json.meta?.billed_units?.input_tokens ?? 0) || 0,
      };
    },
  };
}
```

`packages/obsidian-plugin/src/features/semantic-search/providers/openaiCompatible.ts`:

```ts
import { EmbeddingError, parseJson, send, toVector } from "./common";
import type { EmbedKind, EmbedResult, EmbeddingProvider, HttpFn } from "./types";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  dimensions: number | null;
  queryPrefix: string;
  documentPrefix: string;
  batchSize: number;
  http: HttpFn;
}

export function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/embeddings`;
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): EmbeddingProvider {
  const name = `Embedding API at ${options.baseUrl}`;
  return {
    batchSize: options.batchSize,
    async embed(texts: string[], kind: EmbedKind): Promise<EmbedResult> {
      if (texts.length === 0) return { vectors: [], tokens: 0 };
      if (texts.length > options.batchSize) {
        throw new Error(`${name} accepts at most ${options.batchSize} texts per call (got ${texts.length})`);
      }
      const prefix = kind === "query" ? options.queryPrefix : options.documentPrefix;
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
      if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
      const body: Record<string, unknown> = {
        model: options.model,
        input: texts.map((text) => prefix + text),
        encoding_format: "float",
      };
      if (options.dimensions !== null) body.dimensions = options.dimensions;
      const response = await send(name, options.http, {
        url: embeddingsUrl(options.baseUrl),
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const json = parseJson(name, response.text) as {
        data?: unknown;
        usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
      };
      if (!Array.isArray(json.data) || json.data.length !== texts.length) {
        const got = Array.isArray(json.data) ? json.data.length : "no";
        throw new EmbeddingError(`${name} returned ${got} embeddings for ${texts.length} texts`, "bad-response");
      }
      const rows = (json.data as { index?: unknown; embedding?: unknown }[])
        .slice()
        .sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
      let expected = options.dimensions;
      const vectors = rows.map((row) => {
        const vector = toVector(name, row?.embedding, expected);
        expected = vector.length;
        return vector;
      });
      return {
        vectors,
        tokens: Number(json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0) || 0,
      };
    },
  };
}
```

`packages/obsidian-plugin/src/features/semantic-search/providers/index.ts`:

```ts
import type { SecretLookup, SemanticSearchSettings } from "../settings";
import { createCohereProvider } from "./cohere";
import { createOpenAiCompatibleProvider } from "./openaiCompatible";
import type { EmbeddingProvider, HttpFn } from "./types";

export * from "./common";
export * from "./cohere";
export * from "./openaiCompatible";
export * from "./types";

export function createProvider(
  settings: SemanticSearchSettings,
  getSecret: SecretLookup,
  http: HttpFn,
): EmbeddingProvider {
  if (settings.provider === "cohere") {
    return createCohereProvider({
      apiKey: getSecret(settings.cohere.apiKeySecretId) ?? "",
      model: settings.cohere.model,
      dimension: settings.cohere.dimension,
      http,
    });
  }
  const o = settings.openaiCompatible;
  return createOpenAiCompatibleProvider({
    baseUrl: o.baseUrl,
    apiKey: o.apiKeySecretId ? getSecret(o.apiKeySecretId) : null,
    model: o.model,
    dimensions: o.dimensions,
    queryPrefix: o.queryPrefix,
    documentPrefix: o.documentPrefix,
    batchSize: o.batchSize,
    http,
  });
}
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search`
Expected: すべて PASS

- [ ] **Step 6: Commit**

```bash
git add packages/obsidian-plugin/src/features/semantic-search
git commit -m "feat: add embedding settings and Cohere / OpenAI-compatible providers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: メモリ上の索引と shard ファイル形式

**Files:**
- Create: `.../semantic-search/indexStore.ts`, `.../semantic-search/shardFile.ts`
- Test: `.../semantic-search/indexStore.test.ts`, `.../semantic-search/shardFile.test.ts`

**Interfaces:**
- Consumes: `fnv1a32`（Task 3）、`isExcluded`（Task 4）
- Produces (indexStore): `SHARD_COUNT = 32`、`shardOf(path): number`、`interface StoredChunk { breadcrumbs; text; textHash; vector: Float32Array }`、`interface NoteRecord { mtime; size; hash; status: "ok" | "failed"; error?: string; chunks: StoredChunk[] }`、`interface NoteStat { mtime; size; hash }`、`interface SearchHit { path; breadcrumbs; text; score }`、`interface SearchOptions { limit: number; folders?: string[]; excludeFolders?: string[] }`、`normalize(v): Float32Array`、`class IndexStore` — `constructor(fingerprint: string, dimension: number)`、`fingerprint`、`dimension`（0 は未確定）、`get(path)`、`paths()`、`putNote(path, stat, chunks: StoredChunk[])`、`putFailedNote(path, stat, error)`、`touchNote(path, mtime, size)`、`removeNote(path): boolean`、`loadNote(path, record)`、`stats(): { notes; failedNotes; chunks }`、`failures(): { path; error }[]`、`search(query, options): SearchHit[]`、`shardEntries(i): [string, NoteRecord][]`、`dirtyShards(): number[]`、`markClean(i)`。
- Produces (shardFile): `SHARD_FORMAT_VERSION = 1`、`encodeShard({ fingerprint, dimension, shard, notes: [string, NoteRecord][] }): ArrayBuffer`、`type DecodedShard = { ok: true; fingerprint; dimension; shard; notes: [string, NoteRecord][] } | { ok: false; reason: string }`、`decodeShard(buffer: ArrayBuffer): DecodedShard`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/obsidian-plugin/src/features/semantic-search/indexStore.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { IndexStore, SHARD_COUNT, normalize, shardOf, type StoredChunk } from "./indexStore";

const stat = { mtime: 1, size: 10, hash: "h" };
const chunk = (text: string, vector: number[]): StoredChunk => ({
  breadcrumbs: `n > ${text}`,
  text,
  textHash: `t-${text}`,
  vector: Float32Array.from(vector),
});

describe("shardOf", () => {
  test("is stable and within range", () => {
    for (const path of ["a.md", "日記/2026-09-03.md", "My Notes/x.md"]) {
      expect(shardOf(path)).toBe(shardOf(path));
      expect(shardOf(path)).toBeGreaterThanOrEqual(0);
      expect(shardOf(path)).toBeLessThan(SHARD_COUNT);
    }
  });
});

describe("IndexStore", () => {
  test("stores normalized vectors and counts notes, failures and chunks", () => {
    const store = new IndexStore("fp", 2);
    store.putNote("a.md", stat, [chunk("A", [3, 4])]);
    store.putFailedNote("b.md", stat, "HTTP 400: too long");
    expect(Array.from(store.get("a.md")!.chunks[0].vector)).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(store.stats()).toEqual({ notes: 2, failedNotes: 1, chunks: 1 });
    expect(store.failures()).toEqual([{ path: "b.md", error: "HTTP 400: too long" }]);
  });

  test("ranks by cosine similarity and honours limit and folder filters", () => {
    const store = new IndexStore("fp", 2);
    store.putNote("x/a.md", stat, [chunk("east", [1, 0])]);
    store.putNote("y/b.md", stat, [chunk("north", [0, 1])]);
    store.putNote("x/c.md", stat, [chunk("northeast", [1, 1])]);
    const query = Float32Array.from([1, 0.1]);
    expect(store.search(query, { limit: 3 }).map((h) => h.text)).toEqual(["east", "northeast", "north"]);
    expect(store.search(query, { limit: 1 }).map((h) => h.text)).toEqual(["east"]);
    expect(store.search(query, { limit: 3, folders: ["y/"] }).map((h) => h.path)).toEqual(["y/b.md"]);
    expect(store.search(query, { limit: 3, excludeFolders: ["x/"] }).map((h) => h.path)).toEqual(["y/b.md"]);
    const top = store.search(query, { limit: 1 })[0];
    expect(top).toMatchObject({ path: "x/a.md", breadcrumbs: "n > east" });
    expect(top.score).toBeCloseTo(1 / Math.sqrt(1.01), 5);
  });

  test("takes its dimension from the first vector when it starts at 0, then rejects other sizes", () => {
    const store = new IndexStore("fp", 0);
    store.putNote("a.md", stat, [chunk("A", [1, 0, 0])]);
    expect(store.dimension).toBe(3);
    expect(() => store.putNote("b.md", stat, [chunk("B", [1, 0])])).toThrow("3");
    expect(() => store.search(Float32Array.from([1, 0]), { limit: 1 })).toThrow("3");
  });

  test("tracks which shards changed", () => {
    const store = new IndexStore("fp", 2);
    store.putNote("a.md", stat, [chunk("A", [1, 0])]);
    expect(store.dirtyShards()).toEqual([shardOf("a.md")]);
    store.markClean(shardOf("a.md"));
    store.touchNote("a.md", 2, 11);
    expect(store.get("a.md")).toMatchObject({ mtime: 2, size: 11 });
    expect(store.dirtyShards()).toEqual([shardOf("a.md")]);
    store.markClean(shardOf("a.md"));
    expect(store.removeNote("a.md")).toBe(true);
    expect(store.removeNote("a.md")).toBe(false);
    expect(store.paths()).toEqual([]);
    expect(store.dirtyShards()).toEqual([shardOf("a.md")]);
  });

  test("loadNote puts a record without marking the shard dirty", () => {
    const store = new IndexStore("fp", 2);
    store.loadNote("a.md", { ...stat, status: "ok", chunks: [chunk("A", [1, 0])] });
    expect(store.paths()).toEqual(["a.md"]);
    expect(store.dirtyShards()).toEqual([]);
  });
});

describe("normalize", () => {
  test("leaves a zero vector as zeros", () => {
    expect(Array.from(normalize(Float32Array.from([0, 0])))).toEqual([0, 0]);
  });
});
```

`packages/obsidian-plugin/src/features/semantic-search/shardFile.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { NoteRecord } from "./indexStore";
import { decodeShard, encodeShard } from "./shardFile";

const notes: [string, NoteRecord][] = [
  [
    "日記/2026-09-03.md",
    {
      mtime: 1,
      size: 20,
      hash: "h1",
      status: "ok",
      chunks: [
        { breadcrumbs: "2026-09-03 > 個人", text: "## 個人\n発熱", textHash: "t1", vector: Float32Array.from([0.6, 0.8, 0]) },
        { breadcrumbs: "2026-09-03 > 仕事", text: "## 仕事\n外来", textHash: "t2", vector: Float32Array.from([0, 0, 1]) },
      ],
    },
  ],
  ["b.md", { mtime: 2, size: 5, hash: "h2", status: "failed", error: "HTTP 400", chunks: [] }],
  ["empty.md", { mtime: 3, size: 0, hash: "h3", status: "ok", chunks: [] }],
];

describe("shard file", () => {
  test("round-trips records and vectors exactly", () => {
    const decoded = decodeShard(encodeShard({ fingerprint: "fp", dimension: 3, shard: 7, notes }));
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.fingerprint).toBe("fp");
    expect(decoded.dimension).toBe(3);
    expect(decoded.shard).toBe(7);
    expect(decoded.notes).toEqual(notes);
  });

  test("rejects a file with the wrong magic", () => {
    const buffer = encodeShard({ fingerprint: "fp", dimension: 3, shard: 0, notes });
    new Uint8Array(buffer)[0] = 0;
    expect(decodeShard(buffer)).toEqual({ ok: false, reason: "bad magic" });
  });

  test("rejects a truncated file instead of throwing", () => {
    const buffer = encodeShard({ fingerprint: "fp", dimension: 3, shard: 0, notes });
    expect(decodeShard(buffer.slice(0, buffer.byteLength - 8)).ok).toBe(false);
    expect(decodeShard(buffer.slice(0, 20)).ok).toBe(false);
    expect(decodeShard(new ArrayBuffer(4)).ok).toBe(false);
  });

  test("rejects another format version", () => {
    const buffer = encodeShard({ fingerprint: "fp", dimension: 3, shard: 0, notes: [] });
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder().decode(bytes.subarray(12, 12 + new DataView(buffer).getUint32(8, true)));
    const patched = new TextEncoder().encode(text.replace('"formatVersion":1', '"formatVersion":9'));
    bytes.set(patched, 12);
    expect(decodeShard(buffer)).toEqual({ ok: false, reason: "format version 9" });
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search/indexStore.test.ts src/features/semantic-search/shardFile.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装する**

`packages/obsidian-plugin/src/features/semantic-search/indexStore.ts`:

```ts
import { fnv1a32 } from "./hash";
import { isExcluded } from "./settings";

export const SHARD_COUNT = 32;

export function shardOf(path: string): number {
  return fnv1a32(path) % SHARD_COUNT;
}

export interface StoredChunk {
  breadcrumbs: string;
  text: string;
  textHash: string;
  vector: Float32Array;
}

export interface NoteRecord {
  mtime: number;
  size: number;
  /** SHA-256 of the note content. */
  hash: string;
  status: "ok" | "failed";
  error?: string;
  chunks: StoredChunk[];
}

export interface NoteStat {
  mtime: number;
  size: number;
  hash: string;
}

export interface SearchHit {
  path: string;
  breadcrumbs: string;
  text: string;
  score: number;
}

export interface SearchOptions {
  limit: number;
  folders?: string[];
  excludeFolders?: string[];
}

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const out = new Float32Array(vector.length);
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/** The whole index in memory, split into shards so only changed shards are written back. */
export class IndexStore {
  private readonly shards: Map<string, NoteRecord>[] = Array.from(
    { length: SHARD_COUNT },
    () => new Map<string, NoteRecord>(),
  );
  private readonly dirty = new Set<number>();

  /** @param dimension vector length; 0 until the first vector fixes it. */
  constructor(
    readonly fingerprint: string,
    public dimension: number,
  ) {}

  get(path: string): NoteRecord | undefined {
    return this.shards[shardOf(path)].get(path);
  }

  paths(): string[] {
    const out: string[] = [];
    for (const shard of this.shards) for (const path of shard.keys()) out.push(path);
    return out;
  }

  putNote(path: string, stat: NoteStat, chunks: StoredChunk[]): void {
    const stored = chunks.map((chunk) => {
      this.checkDimension(chunk.vector.length);
      return { ...chunk, vector: normalize(chunk.vector) };
    });
    this.set(path, { ...stat, status: "ok", chunks: stored });
  }

  putFailedNote(path: string, stat: NoteStat, error: string): void {
    this.set(path, { ...stat, status: "failed", error, chunks: [] });
  }

  touchNote(path: string, mtime: number, size: number): void {
    const record = this.get(path);
    if (!record) return;
    record.mtime = mtime;
    record.size = size;
    this.dirty.add(shardOf(path));
  }

  removeNote(path: string): boolean {
    const i = shardOf(path);
    const removed = this.shards[i].delete(path);
    if (removed) this.dirty.add(i);
    return removed;
  }

  /** Puts a record read from disk as is: no normalizing, shard not marked dirty. */
  loadNote(path: string, record: NoteRecord): void {
    this.shards[shardOf(path)].set(path, record);
  }

  stats(): { notes: number; failedNotes: number; chunks: number } {
    let notes = 0;
    let failedNotes = 0;
    let chunks = 0;
    for (const shard of this.shards) {
      for (const record of shard.values()) {
        notes++;
        if (record.status === "failed") failedNotes++;
        chunks += record.chunks.length;
      }
    }
    return { notes, failedNotes, chunks };
  }

  failures(): { path: string; error: string }[] {
    const out: { path: string; error: string }[] = [];
    for (const shard of this.shards) {
      for (const [path, record] of shard) {
        if (record.status === "failed") out.push({ path, error: record.error ?? "" });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  search(query: Float32Array, options: SearchOptions): SearchHit[] {
    if (this.dimension !== 0 && query.length !== this.dimension) {
      throw new Error(`Query vector has ${query.length} dimensions, the index has ${this.dimension}`);
    }
    const q = normalize(query);
    const folders = options.folders ?? [];
    const excluded = options.excludeFolders ?? [];
    const hits: SearchHit[] = [];
    for (const shard of this.shards) {
      for (const [path, record] of shard) {
        if (folders.length > 0 && !folders.some((prefix) => path.startsWith(prefix))) continue;
        if (isExcluded(path, excluded)) continue;
        for (const chunk of record.chunks) {
          const v = chunk.vector;
          let score = 0;
          for (let i = 0; i < v.length; i++) score += v[i] * q[i];
          hits.push({ path, breadcrumbs: chunk.breadcrumbs, text: chunk.text, score });
        }
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, options.limit);
  }

  shardEntries(i: number): [string, NoteRecord][] {
    return Array.from(this.shards[i]);
  }

  dirtyShards(): number[] {
    return Array.from(this.dirty).sort((a, b) => a - b);
  }

  markClean(i: number): void {
    this.dirty.delete(i);
  }

  private set(path: string, record: NoteRecord): void {
    const i = shardOf(path);
    this.shards[i].set(path, record);
    this.dirty.add(i);
  }

  private checkDimension(length: number): void {
    if (this.dimension === 0) this.dimension = length;
    else if (length !== this.dimension) {
      throw new Error(`Vector has ${length} dimensions, the index has ${this.dimension}`);
    }
  }
}
```

`packages/obsidian-plugin/src/features/semantic-search/shardFile.ts`:

```ts
import type { NoteRecord } from "./indexStore";

const MAGIC = "MCPIDX01";
const HEADER_START = 12;
export const SHARD_FORMAT_VERSION = 1;

interface ShardHeader {
  formatVersion: number;
  fingerprint: string;
  dimension: number;
  shard: number;
  notes: Record<
    string,
    {
      mtime: number;
      size: number;
      hash: string;
      status: "ok" | "failed";
      error?: string;
      chunks: { breadcrumbs: string; text: string; textHash: string; slot: number }[];
    }
  >;
}

/**
 * Layout (little-endian): "MCPIDX01", u32 JSON byte length, JSON header,
 * zero padding to a 4-byte boundary, then Float32 vectors where chunk `slot`
 * starts at slot * dimension. Slots are assigned afresh on every write.
 */
export function encodeShard(args: {
  fingerprint: string;
  dimension: number;
  shard: number;
  notes: [string, NoteRecord][];
}): ArrayBuffer {
  const header: ShardHeader = {
    formatVersion: SHARD_FORMAT_VERSION,
    fingerprint: args.fingerprint,
    dimension: args.dimension,
    shard: args.shard,
    notes: {},
  };
  const vectors: Float32Array[] = [];
  for (const [path, record] of args.notes) {
    header.notes[path] = {
      mtime: record.mtime,
      size: record.size,
      hash: record.hash,
      status: record.status,
      ...(record.error !== undefined ? { error: record.error } : {}),
      chunks: record.chunks.map((chunk) => {
        const slot = vectors.length;
        vectors.push(chunk.vector);
        return { breadcrumbs: chunk.breadcrumbs, text: chunk.text, textHash: chunk.textHash, slot };
      }),
    };
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const vectorStart = Math.ceil((HEADER_START + json.length) / 4) * 4;
  const buffer = new ArrayBuffer(vectorStart + vectors.length * args.dimension * 4);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);
  new DataView(buffer).setUint32(8, json.length, true);
  bytes.set(json, HEADER_START);
  const floats = new Float32Array(buffer, vectorStart, vectors.length * args.dimension);
  vectors.forEach((vector, slot) => floats.set(vector, slot * args.dimension));
  return buffer;
}

export type DecodedShard =
  | { ok: true; fingerprint: string; dimension: number; shard: number; notes: [string, NoteRecord][] }
  | { ok: false; reason: string };

export function decodeShard(buffer: ArrayBuffer): DecodedShard {
  try {
    if (buffer.byteLength < HEADER_START) return { ok: false, reason: "file too short" };
    const bytes = new Uint8Array(buffer);
    const magic = Array.from(bytes.subarray(0, 8), (c) => String.fromCharCode(c)).join("");
    if (magic !== MAGIC) return { ok: false, reason: "bad magic" };
    const jsonLength = new DataView(buffer).getUint32(8, true);
    if (HEADER_START + jsonLength > buffer.byteLength) return { ok: false, reason: "header runs past the end" };
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(HEADER_START, HEADER_START + jsonLength)),
    ) as ShardHeader;
    if (header.formatVersion !== SHARD_FORMAT_VERSION) {
      return { ok: false, reason: `format version ${header.formatVersion}` };
    }
    const vectorStart = Math.ceil((HEADER_START + jsonLength) / 4) * 4;
    const floatCount = Math.max(0, Math.floor((buffer.byteLength - vectorStart) / 4));
    const floats = vectorStart <= buffer.byteLength ? new Float32Array(buffer, vectorStart, floatCount) : new Float32Array(0);
    const dimension = header.dimension;
    const notes: [string, NoteRecord][] = Object.entries(header.notes).map(([path, note]) => [
      path,
      {
        mtime: note.mtime,
        size: note.size,
        hash: note.hash,
        status: note.status,
        ...(note.error !== undefined ? { error: note.error } : {}),
        chunks: note.chunks.map((chunk) => {
          const start = chunk.slot * dimension;
          if (start + dimension > floats.length) throw new Error(`slot ${chunk.slot} is past the end`);
          return {
            breadcrumbs: chunk.breadcrumbs,
            text: chunk.text,
            textHash: chunk.textHash,
            vector: floats.slice(start, start + dimension),
          };
        }),
      },
    ]);
    return { ok: true, fingerprint: header.fingerprint, dimension, shard: header.shard, notes };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search`
Expected: すべて PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian-plugin/src/features/semantic-search
git commit -m "feat: add the in-memory semantic index and its shard file format" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 索引の保存と読み込み

**Files:**
- Create: `.../semantic-search/persistence.ts`
- Test: `.../semantic-search/persistence.test.ts`

**Interfaces:**
- Consumes: `IndexStore`, `SHARD_COUNT`, `shardOf`（Task 5）、`encodeShard`, `decodeShard`, `SHARD_FORMAT_VERSION`（Task 5）
- Produces: `interface FilePort { read(path): Promise<ArrayBuffer | null>; write(path, data: ArrayBuffer): Promise<void>; remove(path): Promise<void>; rename(from, to): Promise<void>; exists(path): Promise<boolean>; mkdir(path): Promise<void> }`（`read` は無ければ null、`remove` と `mkdir` は冪等、`rename` の行き先は存在しない前提）、`type BuildState = "running" | "cancelled" | "completed"`、`interface IndexManifest { formatVersion; fingerprint; shardCount; buildState: BuildState; completedAt: number | null; tokens: { lastBuild: number; total: number } }`、`MANIFEST_FILE`、`shardFileName(i)`、`newManifest(fingerprint): IndexManifest`（`buildState: "running"`）、`interface LoadedIndex { store; manifest; brokenShards: number[] }`、`loadIndex(files, dir, fingerprint, dimension): Promise<LoadedIndex | null>`、`saveIndex(files, dir, store, manifest): Promise<void>`、`deleteIndex(files, dir): Promise<void>`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/obsidian-plugin/src/features/semantic-search/persistence.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { IndexStore, SHARD_COUNT, shardOf } from "./indexStore";
import {
  MANIFEST_FILE,
  deleteIndex,
  loadIndex,
  newManifest,
  saveIndex,
  shardFileName,
  type FilePort,
} from "./persistence";

class MemoryFiles implements FilePort {
  files = new Map<string, ArrayBuffer>();
  writes: string[] = [];
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, data: ArrayBuffer) {
    this.writes.push(path);
    this.files.set(path, data.slice(0));
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async rename(from: string, to: string) {
    if (this.files.has(to)) throw new Error(`${to} exists`);
    const data = this.files.get(from);
    if (!data) throw new Error(`${from} missing`);
    this.files.delete(from);
    this.files.set(to, data);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async mkdir() {}
}

const DIR = "idx";
const stat = { mtime: 1, size: 1, hash: "h" };
const chunk = (text: string) => ({ breadcrumbs: text, text, textHash: text, vector: Float32Array.from([1, 0]) });

function filledStore(): IndexStore {
  const store = new IndexStore("fp", 2);
  store.putNote("a.md", stat, [chunk("A")]);
  store.putNote("日記/b.md", stat, [chunk("B")]);
  store.putFailedNote("c.md", stat, "HTTP 400");
  return store;
}

describe("persistence", () => {
  test("save then load gives back the same notes and manifest", async () => {
    const files = new MemoryFiles();
    const manifest = { ...newManifest("fp"), buildState: "completed" as const, completedAt: 5, tokens: { lastBuild: 3, total: 9 } };
    await saveIndex(files, DIR, filledStore(), manifest);
    const loaded = await loadIndex(files, DIR, "fp", 2);
    expect(loaded?.manifest).toEqual(manifest);
    expect(loaded?.brokenShards).toEqual([]);
    expect(loaded?.store.paths().sort()).toEqual(["a.md", "c.md", "日記/b.md"]);
    expect(loaded?.store.get("c.md")).toMatchObject({ status: "failed", error: "HTTP 400" });
    expect(loaded?.store.dirtyShards()).toEqual([]);
  });

  test("only changed shards are written again", async () => {
    const files = new MemoryFiles();
    const store = filledStore();
    await saveIndex(files, DIR, store, newManifest("fp"));
    files.writes = [];
    store.putNote("a.md", { ...stat, mtime: 2 }, [chunk("A2")]);
    await saveIndex(files, DIR, store, newManifest("fp"));
    expect(files.writes).toEqual([`${DIR}/${shardFileName(shardOf("a.md"))}.tmp`, `${DIR}/${MANIFEST_FILE}.tmp`]);
  });

  test("an index built with another fingerprint, or none at all, is not loaded", async () => {
    const files = new MemoryFiles();
    expect(await loadIndex(files, DIR, "fp", 2)).toBeNull();
    await saveIndex(files, DIR, filledStore(), newManifest("fp"));
    expect(await loadIndex(files, DIR, "other", 2)).toBeNull();
  });

  test("a damaged shard is reported and the rest still loads", async () => {
    const files = new MemoryFiles();
    await saveIndex(files, DIR, filledStore(), newManifest("fp"));
    const broken = shardOf("a.md");
    files.files.set(`${DIR}/${shardFileName(broken)}`, new ArrayBuffer(3));
    const loaded = await loadIndex(files, DIR, "fp", 2);
    expect(loaded?.brokenShards).toEqual([broken]);
    expect(loaded?.store.get("a.md")).toBeUndefined();
    expect(loaded?.store.get("c.md")).toBeDefined();
  });

  // Review Focus 4: a crash between removing the old file and renaming the new one.
  test("a shard left only as .tmp after a crash is still loaded", async () => {
    const files = new MemoryFiles();
    await saveIndex(files, DIR, filledStore(), newManifest("fp"));
    const path = `${DIR}/${shardFileName(shardOf("a.md"))}`;
    files.files.set(`${path}.tmp`, files.files.get(path)!);
    files.files.delete(path);
    const loaded = await loadIndex(files, DIR, "fp", 2);
    expect(loaded?.store.get("a.md")).toBeDefined();
    expect(loaded?.brokenShards).toEqual([]);
  });

  test("deleteIndex removes every file it may have written", async () => {
    const files = new MemoryFiles();
    await saveIndex(files, DIR, filledStore(), newManifest("fp"));
    files.files.set(`${DIR}/${shardFileName(0)}.tmp`, new ArrayBuffer(1));
    await deleteIndex(files, DIR);
    expect(files.files.size).toBe(0);
    expect(SHARD_COUNT).toBe(32);
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search/persistence.test.ts`
Expected: FAIL（`./persistence` が無い）

- [ ] **Step 3: 実装する**

`packages/obsidian-plugin/src/features/semantic-search/persistence.ts`:

```ts
import { IndexStore, SHARD_COUNT } from "./indexStore";
import { SHARD_FORMAT_VERSION, decodeShard, encodeShard } from "./shardFile";

/** The file operations the index needs, relative to the vault root. */
export interface FilePort {
  /** null when the file does not exist. */
  read(path: string): Promise<ArrayBuffer | null>;
  write(path: string, data: ArrayBuffer): Promise<void>;
  /** No-op when the file does not exist. */
  remove(path: string): Promise<void>;
  /** The destination must not exist. */
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** No-op when the directory exists. */
  mkdir(path: string): Promise<void>;
}

export type BuildState = "running" | "cancelled" | "completed";

export interface IndexManifest {
  formatVersion: number;
  fingerprint: string;
  shardCount: number;
  buildState: BuildState;
  completedAt: number | null;
  tokens: { lastBuild: number; total: number };
}

export interface LoadedIndex {
  store: IndexStore;
  manifest: IndexManifest;
  /** Shards that could not be read; their notes are missing from the store and get re-embedded. */
  brokenShards: number[];
}

export const MANIFEST_FILE = "manifest.json";

export function shardFileName(i: number): string {
  return `shard-${String(i).padStart(2, "0")}.bin`;
}

export function newManifest(fingerprint: string): IndexManifest {
  return {
    formatVersion: SHARD_FORMAT_VERSION,
    fingerprint,
    shardCount: SHARD_COUNT,
    buildState: "running",
    completedAt: null,
    tokens: { lastBuild: 0, total: 0 },
  };
}

/** Reads `path`, falling back to the `.tmp` a crashed save may have left behind. */
async function readWithFallback(files: FilePort, path: string): Promise<ArrayBuffer | null> {
  return (await files.read(path)) ?? (await files.read(`${path}.tmp`));
}

/** Returns null when there is no index, or it was built with another fingerprint. */
export async function loadIndex(
  files: FilePort,
  dir: string,
  fingerprint: string,
  dimension: number,
): Promise<LoadedIndex | null> {
  const raw = await readWithFallback(files, `${dir}/${MANIFEST_FILE}`);
  if (!raw) return null;
  let manifest: IndexManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw)) as IndexManifest;
  } catch {
    return null;
  }
  if (
    manifest.formatVersion !== SHARD_FORMAT_VERSION ||
    manifest.fingerprint !== fingerprint ||
    manifest.shardCount !== SHARD_COUNT
  ) {
    return null;
  }

  const store = new IndexStore(fingerprint, dimension);
  const brokenShards: number[] = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const buffer = await readWithFallback(files, `${dir}/${shardFileName(i)}`);
    if (!buffer) continue; // never written: no notes landed in this shard yet
    const decoded = decodeShard(buffer);
    const dimensionClash =
      decoded.ok && store.dimension !== 0 && decoded.dimension !== 0 && decoded.dimension !== store.dimension;
    if (!decoded.ok || decoded.fingerprint !== fingerprint || decoded.shard !== i || dimensionClash) {
      brokenShards.push(i);
      continue;
    }
    if (store.dimension === 0) store.dimension = decoded.dimension;
    for (const [path, record] of decoded.notes) store.loadNote(path, record);
  }
  return { store, manifest, brokenShards };
}

function bytesOf(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

/** Writes to `path.tmp`, then swaps it in, so a crash leaves either the old or the new file. */
async function replaceFile(files: FilePort, path: string, data: ArrayBuffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await files.write(tmp, data);
  await files.remove(path);
  await files.rename(tmp, path);
}

/** Writes the changed shards and the manifest. */
export async function saveIndex(
  files: FilePort,
  dir: string,
  store: IndexStore,
  manifest: IndexManifest,
): Promise<void> {
  await files.mkdir(dir);
  for (const i of store.dirtyShards()) {
    // Clean before encoding: a change made while the file is being written marks the shard dirty again.
    store.markClean(i);
    const data = encodeShard({
      fingerprint: store.fingerprint,
      dimension: store.dimension,
      shard: i,
      notes: store.shardEntries(i),
    });
    await replaceFile(files, `${dir}/${shardFileName(i)}`, data);
  }
  await replaceFile(files, `${dir}/${MANIFEST_FILE}`, bytesOf(JSON.stringify(manifest, null, 2)));
}

export async function deleteIndex(files: FilePort, dir: string): Promise<void> {
  const names = [MANIFEST_FILE, ...Array.from({ length: SHARD_COUNT }, (_, i) => shardFileName(i))];
  for (const name of names) {
    await files.remove(`${dir}/${name}`);
    await files.remove(`${dir}/${name}.tmp`);
  }
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search`
Expected: すべて PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian-plugin/src/features/semantic-search
git commit -m "feat: save and load the semantic index as shard files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 差分の計画

**Files:**
- Create: `.../semantic-search/plan.ts`
- Test: `.../semantic-search/plan.test.ts`

**Interfaces:**
- Consumes: `NoteRecord`, `IndexStore`（Task 5）、`isExcluded`（Task 4）
- Produces: `interface FileStat { path: string; mtime: number; size: number }`、`interface ReconcilePlan { check: FileStat[]; remove: string[]; total: number }`、`planReconcile(files: FileStat[], indexed: Pick<IndexStore, "paths" | "get">, excludeFolders: string[]): ReconcilePlan`、`type NoteUpdatePlan = { kind: "touch" } | { kind: "embed"; reuse: (Float32Array | null)[]; missing: number[] }`、`planNoteUpdate(existing: NoteRecord | undefined, contentHash: string, chunkTextHashes: string[], recycled?: Map<string, Float32Array>): NoteUpdatePlan`、`recycleChunks(records: (NoteRecord | undefined)[]): Map<string, Float32Array>`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/obsidian-plugin/src/features/semantic-search/plan.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { IndexStore } from "./indexStore";
import { planNoteUpdate, planReconcile, recycleChunks } from "./plan";

const vec = (x: number) => Float32Array.from([x, 1]);
const record = (hash: string, textHashes: string[], status: "ok" | "failed" = "ok") => ({
  mtime: 1,
  size: 1,
  hash,
  status,
  chunks: textHashes.map((t, i) => ({ breadcrumbs: "b", text: t, textHash: t, vector: vec(i + 1) })),
});

describe("planReconcile", () => {
  const store = new IndexStore("fp", 2);
  store.loadNote("same.md", record("h", ["x"]));
  store.loadNote("changed.md", record("h", ["x"]));
  store.loadNote("gone.md", record("h", ["x"]));
  store.loadNote("Private/p.md", record("h", ["x"]));

  test("checks new and changed files, removes deleted and excluded ones", () => {
    const plan = planReconcile(
      [
        { path: "same.md", mtime: 1, size: 1 },
        { path: "changed.md", mtime: 2, size: 1 },
        { path: "new.md", mtime: 1, size: 1 },
        { path: "Private/p.md", mtime: 1, size: 1 },
      ],
      store,
      ["Private/"],
    );
    expect(plan.check.map((f) => f.path)).toEqual(["changed.md", "new.md"]);
    expect(plan.remove.sort()).toEqual(["Private/p.md", "gone.md"]);
    expect(plan.total).toBe(3);
  });
});

describe("planNoteUpdate", () => {
  test("a new note embeds every chunk", () => {
    expect(planNoteUpdate(undefined, "h", ["a", "b"])).toEqual({ kind: "embed", reuse: [null, null], missing: [0, 1] });
  });

  test("unchanged content only needs its stat updated, even for a failed note", () => {
    expect(planNoteUpdate(record("h", ["a"]), "h", ["a"])).toEqual({ kind: "touch" });
    expect(planNoteUpdate(record("h", [], "failed"), "h", ["a"])).toEqual({ kind: "touch" });
  });

  test("changed content reuses the vectors of chunks whose text did not change", () => {
    const plan = planNoteUpdate(record("old", ["a", "b"]), "new", ["a", "c"]);
    expect(plan.kind).toBe("embed");
    if (plan.kind !== "embed") return;
    expect(Array.from(plan.reuse[0]!)).toEqual([1, 1]);
    expect(plan.reuse[1]).toBeNull();
    expect(plan.missing).toEqual([1]);
  });

  test("vectors from removed or renamed notes are reused when the text matches", () => {
    const recycled = recycleChunks([record("h", ["moved"]), undefined]);
    const plan = planNoteUpdate(undefined, "h", ["moved", "fresh"], recycled);
    expect(plan).toMatchObject({ kind: "embed", missing: [1] });
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search/plan.test.ts`
Expected: FAIL（`./plan` が無い）

- [ ] **Step 3: 実装する**

`packages/obsidian-plugin/src/features/semantic-search/plan.ts`:

```ts
import type { IndexStore, NoteRecord } from "./indexStore";
import { isExcluded } from "./settings";

export interface FileStat {
  path: string;
  mtime: number;
  size: number;
}

export interface ReconcilePlan {
  /** Files that are new or whose mtime or size changed; their content decides what to embed. */
  check: FileStat[];
  /** Indexed paths that are gone from the vault or now excluded. */
  remove: string[];
  /** Number of notes that should be in the index. */
  total: number;
}

export function planReconcile(
  files: FileStat[],
  indexed: Pick<IndexStore, "paths" | "get">,
  excludeFolders: string[],
): ReconcilePlan {
  const targets = files.filter((file) => !isExcluded(file.path, excludeFolders));
  const targetPaths = new Set(targets.map((file) => file.path));
  const check = targets.filter((file) => {
    const record = indexed.get(file.path);
    return !record || record.mtime !== file.mtime || record.size !== file.size;
  });
  const remove = indexed.paths().filter((path) => !targetPaths.has(path));
  return { check, remove, total: targets.length };
}

export type NoteUpdatePlan =
  | { kind: "touch" }
  | { kind: "embed"; reuse: (Float32Array | null)[]; missing: number[] };

/**
 * Decides what a note needs. Same content hash: only the stat changes (a failed
 * note stays failed until it is edited). Otherwise each chunk reuses a vector
 * whose text hash it shares with the old record or with `recycled` (vectors of
 * removed or renamed notes), and the rest are listed in `missing`.
 */
export function planNoteUpdate(
  existing: NoteRecord | undefined,
  contentHash: string,
  chunkTextHashes: string[],
  recycled: Map<string, Float32Array> = new Map(),
): NoteUpdatePlan {
  if (existing && existing.hash === contentHash) return { kind: "touch" };
  const known = new Map(recycled);
  if (existing?.status === "ok") for (const chunk of existing.chunks) known.set(chunk.textHash, chunk.vector);
  const reuse = chunkTextHashes.map((hash) => known.get(hash) ?? null);
  const missing: number[] = [];
  reuse.forEach((vector, i) => {
    if (!vector) missing.push(i);
  });
  return { kind: "embed", reuse, missing };
}

export function recycleChunks(records: (NoteRecord | undefined)[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (const record of records) {
    if (record?.status === "ok") for (const chunk of record.chunks) out.set(chunk.textHash, chunk.vector);
  }
  return out;
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search`
Expected: すべて PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian-plugin/src/features/semantic-search
git commit -m "feat: plan which notes and sections need embedding" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 索引器

状態（`empty` / `building` / `paused` / `ready`）、変更の待ち行列、まとめての埋め込み、再試行、400 のノート単位の切り分け、中止、破棄を受け持つ。Obsidian には依存しない（`VaultPort` とタイマーを受け取る）。

**Files:**
- Create: `.../semantic-search/indexer.ts`
- Test: `.../semantic-search/indexer.test.ts`

**Interfaces:**
- Consumes: `chunkNote`, `HeadingInfo`, `Chunk`（Task 3）、`sha256Hex`（Task 3）、`IndexStore`, `NoteStat`（Task 5）、`BuildState`（Task 6）、`planNoteUpdate`, `planReconcile`, `recycleChunks`, `FileStat`（Task 7）、`EmbeddingError`, `EmbeddingProvider`, `EmbedResult`（Task 4）、`isExcluded`（Task 4）
- Produces: `interface NoteSource { content; headings: HeadingInfo[]; frontmatterEndLine: number | null }`、`type ReadResult = NoteSource | "missing" | "not-ready"`、`interface VaultPort { listMarkdownFiles(): FileStat[]; readNote(path): Promise<ReadResult> }`、`type IndexState = "empty" | "building" | "paused" | "ready"`、`interface TokenCounts { lastBuild; total }`、`interface IndexerStatus { state; reason?; progress: { done; total } | null; tokens: TokenCounts }`、`interface IndexEstimate { notes; chunks; chars }`、`interface IndexerOptions`（下のコード）、定数 `DEBOUNCE_MS` / `RETRY_DELAYS_MS` / `MAX_RETRY_AFTER_MS` / `RESUME_AFTER_MS`、`class Indexer` — `status()`、`build()`、`startupSync()`、`flush()`、`idle()`、`noteChanged(path)`、`noteDeleted(path)`、`noteRenamed(oldPath, newPath)`、`cancel()`、`dispose()`、`estimateIndex(vault, excludeFolders, maxChunkChars): Promise<IndexEstimate>`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/obsidian-plugin/src/features/semantic-search/indexer.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { HeadingInfo } from "./chunker";
import {
  Indexer,
  RESUME_AFTER_MS,
  estimateIndex,
  type IndexState,
  type ReadResult,
  type VaultPort,
} from "./indexer";
import { IndexStore } from "./indexStore";
import type { BuildState } from "./persistence";
import { EmbeddingError, type EmbedResult, type EmbeddingProvider } from "./providers";

function parseHeadings(content: string): HeadingInfo[] {
  const out: HeadingInfo[] = [];
  content.split("\n").forEach((line, i) => {
    const match = /^(#{1,6}) (.+)$/.exec(line);
    if (match) out.push({ heading: match[2], level: match[1].length, line: i, endLine: i });
  });
  return out;
}

class FakeVault implements VaultPort {
  notes = new Map<string, { content: string; mtime: number; notReady?: boolean }>();
  set(path: string, content: string, notReady = false) {
    const mtime = (this.notes.get(path)?.mtime ?? 0) + 1;
    this.notes.set(path, { content, mtime, notReady });
  }
  delete(path: string) {
    this.notes.delete(path);
  }
  listMarkdownFiles() {
    return Array.from(this.notes, ([path, n]) => ({ path, mtime: n.mtime, size: n.content.length }));
  }
  async readNote(path: string): Promise<ReadResult> {
    const note = this.notes.get(path);
    if (!note) return "missing";
    if (note.notReady) return "not-ready";
    return { content: note.content, headings: parseHeadings(note.content), frontmatterEndLine: null };
  }
}

class FakeProvider implements EmbeddingProvider {
  calls: string[][] = [];
  failures: EmbeddingError[] = [];
  onCall: (call: number) => void = () => {};
  constructor(
    readonly batchSize = 96,
    private readonly reject: (text: string) => EmbeddingError | null = () => null,
  ) {}
  async embed(texts: string[]): Promise<EmbedResult> {
    this.calls.push(texts);
    this.onCall(this.calls.length);
    const scripted = this.failures.shift();
    if (scripted) throw scripted;
    for (const text of texts) {
      const error = this.reject(text);
      if (error) throw error;
    }
    return {
      vectors: texts.map((t) => Float32Array.from([(t.length % 7) + 1, (t.charCodeAt(t.length - 1) % 5) + 1])),
      tokens: texts.length * 10,
    };
  }
}

class FakeScheduler {
  tasks: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  schedule = (fn: () => void, ms: number) => {
    const task = { fn, ms, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };
  pending(ms?: number) {
    return this.tasks.filter((t) => !t.cancelled && (ms === undefined || t.ms === ms));
  }
  runAll(ms?: number) {
    const due = this.pending(ms);
    due.forEach((t) => (t.cancelled = true));
    due.forEach((t) => t.fn());
  }
}

function setup(
  options: {
    batchSize?: number;
    reject?: (text: string) => EmbeddingError | null;
    excludeFolders?: string[];
    initial?: { state: IndexState; reason?: string };
  } = {},
) {
  const vault = new FakeVault();
  const provider = new FakeProvider(options.batchSize, options.reject);
  const store = new IndexStore("fp", 2);
  const scheduler = new FakeScheduler();
  const sleeps: number[] = [];
  const buildStates: BuildState[] = [];
  const notices: string[] = [];
  let changes = 0;
  const indexer = new Indexer({
    vault,
    provider,
    store,
    excludeFolders: options.excludeFolders ?? [],
    maxChunkChars: 4000,
    initial: options.initial ?? { state: "empty" },
    tokens: { lastBuild: 0, total: 0 },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    schedule: scheduler.schedule,
    onBuildState: (state) => buildStates.push(state),
    onChange: () => {
      changes++;
    },
    notify: (message) => notices.push(message),
    log: () => {},
  });
  return { vault, provider, store, scheduler, sleeps, buildStates, notices, indexer, changes: () => changes };
}

describe("Indexer.build", () => {
  test("embeds every section once and ends ready", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\nalpha");
    t.vault.set("b.md", "# B\nbeta\n## B2\nbeta two");
    await t.indexer.build();
    expect(t.provider.calls).toEqual([["a > A\n\n# A\nalpha", "b > B\n\n# B\nbeta", "b > B > B2\n\n## B2\nbeta two"]]);
    expect(t.indexer.status()).toMatchObject({ state: "ready", progress: null, tokens: { lastBuild: 30, total: 30 } });
    expect(t.buildStates).toEqual(["running", "completed"]);
    expect(t.store.stats()).toEqual({ notes: 2, failedNotes: 0, chunks: 3 });
    expect(t.changes()).toBeGreaterThan(0);
  });

  test("a second build sends nothing", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\nalpha");
    await t.indexer.build();
    await t.indexer.build();
    expect(t.provider.calls).toHaveLength(1);
  });

  test("sections from several notes share a request, and requests respect the batch size", async () => {
    const t = setup({ batchSize: 2 });
    t.vault.set("a.md", "# A\na");
    t.vault.set("b.md", "# B\nb\n# B2\nb2");
    t.vault.set("c.md", "# C\nc\n# C2\nc2");
    await t.indexer.build();
    expect(t.provider.calls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(t.store.stats().chunks).toBe(5);
  });

  test("excluded folders are never sent", async () => {
    const t = setup({ excludeFolders: ["Private/"] });
    t.vault.set("a.md", "# A\na");
    t.vault.set("Private/p.md", "# P\nsecret");
    await t.indexer.build();
    expect(t.provider.calls.flat().some((text) => text.includes("secret"))).toBe(false);
    expect(t.store.get("Private/p.md")).toBeUndefined();
  });

  test("a note Obsidian has not parsed yet is skipped and left alone", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na", true);
    await t.indexer.build();
    expect(t.provider.calls).toHaveLength(0);
    expect(t.store.get("a.md")).toBeUndefined();
    expect(t.indexer.status().state).toBe("ready");
  });
});

describe("Indexer changes", () => {
  test("editing one section re-embeds only that section", async () => {
    const t = setup();
    t.vault.set("b.md", "# B\nbeta\n## B2\nbeta two");
    await t.indexer.build();
    t.vault.set("b.md", "# B\nbeta\n## B2\nbeta CHANGED");
    t.indexer.noteChanged("b.md");
    await t.indexer.flush();
    expect(t.provider.calls[1]).toEqual(["b > B > B2\n\n## B2\nbeta CHANGED"]);
  });

  test("changes wait for the debounce timer", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na");
    await t.indexer.build();
    t.indexer.noteChanged("a.md");
    t.indexer.noteChanged("a.md");
    expect(t.scheduler.pending(10_000)).toHaveLength(1);
  });

  test("a deleted note leaves the index", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na");
    await t.indexer.build();
    t.vault.delete("a.md");
    t.indexer.noteDeleted("a.md");
    await t.indexer.flush();
    expect(t.store.get("a.md")).toBeUndefined();
  });

  test("moving a note to another folder reuses its vectors; renaming the note does not", async () => {
    const t = setup();
    t.vault.set("x/n.md", "# H\nbody");
    await t.indexer.build();
    t.vault.delete("x/n.md");
    t.vault.set("y/n.md", "# H\nbody");
    t.indexer.noteRenamed("x/n.md", "y/n.md");
    await t.indexer.flush();
    expect(t.provider.calls).toHaveLength(1);
    expect(t.store.get("x/n.md")).toBeUndefined();
    expect(t.store.get("y/n.md")?.chunks).toHaveLength(1);

    t.vault.delete("y/n.md");
    t.vault.set("y/m.md", "# H\nbody");
    t.indexer.noteRenamed("y/n.md", "y/m.md");
    await t.indexer.flush();
    expect(t.provider.calls[1]).toEqual(["m > H\n\n# H\nbody"]);
  });

  // Review Focus 3
  test("an edit made during a build is picked up after the build", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\nold");
    t.provider.onCall = (call) => {
      if (call === 1) {
        t.vault.set("a.md", "# A\nnew");
        t.indexer.noteChanged("a.md");
      }
    };
    await t.indexer.build();
    await t.indexer.flush();
    expect(t.provider.calls.flat()).toEqual(["a > A\n\n# A\nold", "a > A\n\n# A\nnew"]);
    expect(t.store.get("a.md")?.chunks[0].text).toBe("# A\nnew");
  });

  test("changes while paused are left for the next build", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na");
    t.provider.failures = [new EmbeddingError("HTTP 401", "auth")];
    await t.indexer.build();
    t.vault.set("b.md", "# B\nb");
    t.indexer.noteChanged("b.md");
    await t.indexer.flush();
    expect(t.provider.calls).toHaveLength(1);
    await t.indexer.build();
    expect(t.store.stats().notes).toBe(2);
  });
});

describe("Indexer failures", () => {
  test("a rejected note is isolated and marked failed, and not resent until edited", async () => {
    const t = setup({ reject: (text) => (text.includes("BAD") ? new EmbeddingError("HTTP 400: too long", "bad-request") : null) });
    t.vault.set("a.md", "# A\nok");
    t.vault.set("b.md", "# B\nBAD");
    t.vault.set("c.md", "# C\nok");
    await t.indexer.build();
    expect(t.indexer.status().state).toBe("ready");
    expect(t.store.get("b.md")).toMatchObject({ status: "failed", error: "HTTP 400: too long" });
    expect(t.store.get("a.md")?.status).toBe("ok");
    expect(t.store.get("c.md")?.status).toBe("ok");
    expect(t.provider.calls).toHaveLength(4);

    await t.indexer.build();
    expect(t.provider.calls).toHaveLength(4);

    t.vault.set("b.md", "# B\nfixed");
    t.indexer.noteChanged("b.md");
    await t.indexer.flush();
    expect(t.store.get("b.md")?.status).toBe("ok");
  });

  test("an auth failure pauses, notifies once, and does not retry on its own", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na");
    t.provider.failures = [new EmbeddingError("HTTP 401", "auth")];
    await t.indexer.build();
    expect(t.indexer.status().state).toBe("paused");
    expect(t.indexer.status().reason).toContain("API key rejected");
    expect(t.notices).toHaveLength(1);
    expect(t.provider.calls).toHaveLength(1);
    expect(t.store.stats().notes).toBe(0);
    expect(t.buildStates).toEqual(["running"]);
    expect(t.scheduler.pending(RESUME_AFTER_MS)).toHaveLength(0);
  });

  test("rate limiting waits for Retry-After and then succeeds", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na");
    t.provider.failures = [new EmbeddingError("HTTP 429", "rate-limit", 3000)];
    await t.indexer.build();
    expect(t.sleeps).toEqual([3000]);
    expect(t.indexer.status().state).toBe("ready");
  });

  test("repeated transient failures pause, then resume after five minutes", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na");
    t.provider.failures = Array.from({ length: 4 }, () => new EmbeddingError("HTTP 503", "server"));
    await t.indexer.build();
    expect(t.sleeps).toEqual([2000, 8000, 30000]);
    expect(t.indexer.status().state).toBe("paused");
    expect(t.indexer.status().reason).toContain("Temporary failure");
    expect(t.scheduler.pending(RESUME_AFTER_MS)).toHaveLength(1);
    t.scheduler.runAll(RESUME_AFTER_MS);
    await t.indexer.idle();
    expect(t.indexer.status().state).toBe("ready");
    expect(t.store.stats().notes).toBe(1);
  });
});

describe("Indexer control", () => {
  test("cancel stops after the current request and keeps what was finished", async () => {
    const t = setup({ batchSize: 1 });
    t.vault.set("a.md", "# A\na");
    t.vault.set("b.md", "# B\nb");
    t.provider.onCall = (call) => {
      if (call === 1) t.indexer.cancel();
    };
    await t.indexer.build();
    expect(t.indexer.status()).toMatchObject({ state: "paused", reason: "Cancelled" });
    expect(t.buildStates).toEqual(["running", "cancelled"]);
    expect(t.store.paths()).toEqual(["a.md"]);

    t.provider.onCall = () => {};
    await t.indexer.build();
    expect(t.store.stats().notes).toBe(2);
    expect(t.indexer.status().tokens.lastBuild).toBe(20);
  });

  // Review Focus 5
  test("after dispose an in-flight run touches no state, callbacks or timers", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na");
    t.provider.onCall = () => t.indexer.dispose();
    await t.indexer.build();
    expect(t.buildStates).toEqual(["running"]);
    expect(t.indexer.status().state).toBe("building");
    t.indexer.noteChanged("a.md");
    expect(t.scheduler.pending()).toHaveLength(0);
  });

  test("a new build resets the per-build token count; incremental work adds to the total only", async () => {
    const t = setup();
    t.vault.set("a.md", "# A\na");
    await t.indexer.build();
    t.vault.set("a.md", "# A\nb");
    t.indexer.noteChanged("a.md");
    await t.indexer.flush();
    expect(t.indexer.status().tokens).toEqual({ lastBuild: 10, total: 20 });
    t.vault.set("c.md", "# C\nc");
    await t.indexer.build();
    expect(t.indexer.status().tokens).toEqual({ lastBuild: 10, total: 30 });
  });

  test("startupSync catches up with offline changes without entering the building state", async () => {
    const t = setup({ initial: { state: "ready" } });
    t.vault.set("a.md", "# A\na");
    await t.indexer.startupSync();
    expect(t.store.stats().notes).toBe(1);
    expect(t.buildStates).toEqual([]);
    expect(t.indexer.status().state).toBe("ready");
  });
});

describe("estimateIndex", () => {
  test("counts notes, chunks and characters that would be sent", async () => {
    const vault = new FakeVault();
    vault.set("a.md", "# A\nalpha");
    vault.set("Private/p.md", "# P\nsecret");
    const estimate = await estimateIndex(vault, ["Private/"], 4000);
    expect(estimate).toEqual({ notes: 1, chunks: 1, chars: "a > A\n\n# A\nalpha".length });
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search/indexer.test.ts`
Expected: FAIL（`./indexer` が無い）

- [ ] **Step 3: 実装する**

`packages/obsidian-plugin/src/features/semantic-search/indexer.ts`:

```ts
import { chunkNote, type Chunk, type HeadingInfo } from "./chunker";
import { sha256Hex } from "./hash";
import type { IndexStore, NoteStat } from "./indexStore";
import type { BuildState } from "./persistence";
import { planNoteUpdate, planReconcile, recycleChunks, type FileStat } from "./plan";
import { EmbeddingError, type EmbedResult, type EmbeddingProvider } from "./providers";
import { isExcluded } from "./settings";

export interface NoteSource {
  content: string;
  headings: HeadingInfo[];
  frontmatterEndLine: number | null;
}

/** "missing": the file is gone. "not-ready": Obsidian has not parsed it yet; a metadata "changed" event follows. */
export type ReadResult = NoteSource | "missing" | "not-ready";

export interface VaultPort {
  listMarkdownFiles(): FileStat[];
  readNote(path: string): Promise<ReadResult>;
}

export type IndexState = "empty" | "building" | "paused" | "ready";

export interface TokenCounts {
  lastBuild: number;
  total: number;
}

export interface IndexerStatus {
  state: IndexState;
  reason?: string;
  progress: { done: number; total: number } | null;
  tokens: TokenCounts;
}

export interface IndexEstimate {
  notes: number;
  chunks: number;
  chars: number;
}

export interface IndexerOptions {
  vault: VaultPort;
  provider: EmbeddingProvider;
  store: IndexStore;
  excludeFolders: string[];
  maxChunkChars: number;
  initial: { state: IndexState; reason?: string };
  tokens: TokenCounts;
  sleep(ms: number): Promise<void>;
  /** Runs `fn` after `ms` and returns a function that cancels it. */
  schedule(fn: () => void, ms: number): () => void;
  onBuildState(state: BuildState): void;
  /** The status changed or the store was modified. */
  onChange(): void;
  /** A message for the user (an Obsidian Notice in the plugin). */
  notify(message: string): void;
  log(message: string, data?: Record<string, unknown>): void;
}

export const DEBOUNCE_MS = 10_000;
export const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
export const MAX_RETRY_AFTER_MS = 120_000;
export const RESUME_AFTER_MS = 5 * 60_000;

type PauseCause = "auth" | "transient" | "fatal" | "cancelled";
type RunResult = { kind: "completed" } | { kind: "paused"; reason: string; cause: PauseCause };

interface Job {
  path: string;
  stat: NoteStat;
  chunks: Chunk[];
  textHashes: string[];
  vectors: (Float32Array | null)[];
  remaining: number;
  failed: boolean;
}

interface PendingText {
  job: Job;
  index: number;
  text: string;
}

export class Indexer {
  private state: IndexState;
  private reason: string | undefined;
  private progress: { done: number; total: number } | null = null;
  private readonly tokens: TokenCounts;
  private readonly changed = new Set<string>();
  private renames: [string, string][] = [];
  private chain: Promise<void> = Promise.resolve();
  private cancelRequested = false;
  private disposed = false;
  private authNotified = false;
  private cancelDebounce: (() => void) | null = null;
  private cancelResume: (() => void) | null = null;

  constructor(private readonly o: IndexerOptions) {
    this.state = o.initial.state;
    this.reason = o.initial.reason;
    this.tokens = { ...o.tokens };
  }

  status(): IndexerStatus {
    return {
      state: this.state,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      progress: this.progress ? { ...this.progress } : null,
      tokens: { ...this.tokens },
    };
  }

  /** Resolves when every queued run has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Starts a full build, or resumes a paused one: every note missing from the index is embedded. */
  build(): Promise<void> {
    return this.enqueue(async () => {
      this.clearResume();
      if (this.state !== "paused") this.tokens.lastBuild = 0;
      this.state = "building";
      this.reason = undefined;
      this.cancelRequested = false;
      this.authNotified = false;
      this.o.onBuildState("running");
      this.o.onChange();
      this.finish(await this.guard(() => this.syncAll(true)), true);
    });
  }

  /** Reconciles the whole vault while staying ready (after startup, to catch offline edits). */
  startupSync(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state !== "ready") return;
      this.finish(await this.guard(() => this.syncAll(false)), false);
    });
  }

  noteChanged(path: string): void {
    this.changed.add(path);
    this.debounce();
  }

  noteDeleted(path: string): void {
    this.changed.add(path);
    this.debounce();
  }

  noteRenamed(oldPath: string, newPath: string): void {
    this.renames.push([oldPath, newPath]);
    this.debounce();
  }

  /** Processes queued changes now. The debounce timer calls this; tests call it directly. */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      const paths = Array.from(this.changed);
      const renames = this.renames;
      this.changed.clear();
      this.renames = [];
      // Not ready: the next build or resume reconciles the whole vault anyway.
      if (this.state !== "ready" || (paths.length === 0 && renames.length === 0)) return;
      this.finish(await this.guard(() => this.syncPaths(paths, renames)), false);
    });
  }

  cancel(): void {
    if (this.state === "building") this.cancelRequested = true;
  }

  /** Stops timers; an in-flight run ends without touching state or calling back. */
  dispose(): void {
    this.disposed = true;
    this.cancelRequested = true;
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.clearResume();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain
      .then(async () => {
        if (!this.disposed) await task();
      })
      .catch((error) =>
        this.o.log("Semantic index task failed", { error: error instanceof Error ? error.message : String(error) }),
      );
    this.chain = next;
    return next;
  }

  private debounce(): void {
    if (this.disposed) return;
    this.cancelDebounce?.();
    this.cancelDebounce = this.o.schedule(() => {
      this.cancelDebounce = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  private clearResume(): void {
    this.cancelResume?.();
    this.cancelResume = null;
  }

  private resume(wasBuild: boolean): void {
    if (wasBuild) {
      void this.build();
      return;
    }
    void this.enqueue(async () => {
      if (this.state !== "paused") return;
      this.state = "ready";
      this.reason = undefined;
      this.o.onChange();
      this.finish(await this.guard(() => this.syncAll(false)), false);
    });
  }

  private async guard(run: () => Promise<RunResult>): Promise<RunResult> {
    try {
      return await run();
    } catch (error) {
      return this.pauseFor(error);
    }
  }

  private finish(result: RunResult, wasBuild: boolean): void {
    if (this.disposed) return;
    this.progress = null;
    if (result.kind === "completed") {
      this.state = "ready";
      this.reason = undefined;
      if (wasBuild) this.o.onBuildState("completed");
      this.o.onChange();
      return;
    }
    this.state = "paused";
    this.reason = result.reason;
    if (result.cause === "cancelled") this.o.onBuildState("cancelled");
    if (result.cause === "auth" && !this.authNotified) {
      this.authNotified = true;
      this.o.notify(`Semantic search paused: ${result.reason}`);
    }
    if (result.cause === "transient") {
      this.cancelResume = this.o.schedule(() => {
        this.cancelResume = null;
        this.resume(wasBuild);
      }, RESUME_AFTER_MS);
    }
    this.o.onChange();
  }

  private changedStore(): void {
    if (!this.disposed) this.o.onChange();
  }

  private advance(): void {
    if (this.progress) this.progress.done++;
  }

  private async syncAll(isBuild: boolean): Promise<RunResult> {
    const plan = planReconcile(this.o.vault.listMarkdownFiles(), this.o.store, this.o.excludeFolders);
    const recycled = recycleChunks(plan.remove.map((path) => this.o.store.get(path)));
    for (const path of plan.remove) this.o.store.removeNote(path);
    if (plan.remove.length > 0) this.changedStore();
    if (isBuild) this.progress = { done: plan.total - plan.check.length, total: plan.total };
    return this.embedNotes(plan.check, recycled);
  }

  private async syncPaths(paths: string[], renames: [string, string][]): Promise<RunResult> {
    const files = new Map(this.o.vault.listMarkdownFiles().map((file) => [file.path, file] as [string, FileStat]));
    const recycled = recycleChunks(renames.map(([oldPath]) => this.o.store.get(oldPath)));
    const todo = new Set(paths);
    for (const [oldPath, newPath] of renames) {
      this.o.store.removeNote(oldPath);
      todo.add(newPath);
    }
    const check: FileStat[] = [];
    todo.forEach((path) => {
      const file = files.get(path);
      if (!file || isExcluded(path, this.o.excludeFolders)) this.o.store.removeNote(path);
      else check.push(file);
    });
    this.changedStore();
    return this.embedNotes(check, recycled);
  }

  private async embedNotes(files: FileStat[], recycled: Map<string, Float32Array>): Promise<RunResult> {
    const batchSize = this.o.provider.batchSize;
    let pending: PendingText[] = [];
    let cursor = 0;
    while (cursor < files.length || pending.length > 0) {
      if (this.cancelRequested) {
        this.cancelRequested = false;
        return { kind: "paused", reason: "Cancelled", cause: "cancelled" };
      }
      while (pending.length < batchSize && cursor < files.length) {
        const job = await this.prepare(files[cursor++], recycled);
        if (job) {
          job.vectors.forEach((vector, index) => {
            if (!vector) pending.push({ job, index, text: job.chunks[index].embedText });
          });
        }
      }
      if (pending.length === 0) continue;
      const batch = pending.slice(0, batchSize);
      pending = pending.slice(batchSize);
      const stop = await this.embedBatch(batch);
      if (stop) return stop;
      pending = pending.filter((item) => !item.job.failed);
    }
    return { kind: "completed" };
  }

  /** Reads and chunks a note. Returns a job when some sections need embedding; otherwise records the note. */
  private async prepare(file: FileStat, recycled: Map<string, Float32Array>): Promise<Job | null> {
    const source = await this.o.vault.readNote(file.path);
    if (source === "missing") {
      this.o.store.removeNote(file.path);
      this.advance();
      this.changedStore();
      return null;
    }
    if (source === "not-ready") {
      this.advance();
      return null;
    }
    const hash = await sha256Hex(source.content);
    const chunks = chunkNote({
      path: file.path,
      content: source.content,
      headings: source.headings,
      frontmatterEndLine: source.frontmatterEndLine,
      maxChunkChars: this.o.maxChunkChars,
    });
    const textHashes = await Promise.all(chunks.map((chunk) => sha256Hex(chunk.embedText)));
    const plan = planNoteUpdate(this.o.store.get(file.path), hash, textHashes, recycled);
    if (plan.kind === "touch") {
      this.o.store.touchNote(file.path, file.mtime, file.size);
      this.advance();
      this.changedStore();
      return null;
    }
    const job: Job = {
      path: file.path,
      stat: { mtime: file.mtime, size: file.size, hash },
      chunks,
      textHashes,
      vectors: plan.reuse,
      remaining: plan.missing.length,
      failed: false,
    };
    if (job.remaining === 0) {
      this.commit(job);
      return null;
    }
    return job;
  }

  private commit(job: Job): void {
    this.o.store.putNote(
      job.path,
      job.stat,
      job.chunks.map((chunk, i) => ({
        breadcrumbs: chunk.breadcrumbs,
        text: chunk.text,
        textHash: job.textHashes[i],
        vector: job.vectors[i] as Float32Array,
      })),
    );
    this.advance();
    this.changedStore();
  }

  private assign(items: PendingText[], vectors: Float32Array[]): void {
    items.forEach((item, i) => {
      if (item.job.failed) return;
      item.job.vectors[item.index] = vectors[i];
      item.job.remaining--;
      if (item.job.remaining === 0) this.commit(item.job);
    });
  }

  private fail(job: Job, message: string): void {
    job.failed = true;
    this.o.store.putFailedNote(job.path, job.stat, message);
    this.advance();
    this.changedStore();
  }

  /** Embeds one request's worth of text. Returns a paused result to stop the run, or null to go on. */
  private async embedBatch(batch: PendingText[]): Promise<RunResult | null> {
    try {
      const result = await this.embedWithRetry(batch.map((item) => item.text));
      this.assign(batch, result.vectors);
      return null;
    } catch (error) {
      if (error instanceof EmbeddingError && error.kind === "bad-request") return this.isolate(batch);
      return this.pauseFor(error);
    }
  }

  /** The API rejected a mixed request; resend it note by note so only the offending notes fail. */
  private async isolate(batch: PendingText[]): Promise<RunResult | null> {
    const byJob = new Map<Job, PendingText[]>();
    for (const item of batch) byJob.set(item.job, [...(byJob.get(item.job) ?? []), item]);
    for (const [job, items] of Array.from(byJob)) {
      try {
        const result = await this.embedWithRetry(items.map((item) => item.text));
        this.assign(items, result.vectors);
      } catch (error) {
        if (error instanceof EmbeddingError && error.kind === "bad-request") {
          this.fail(job, error.message);
          continue;
        }
        return this.pauseFor(error);
      }
    }
    return null;
  }

  private async embedWithRetry(texts: string[]): Promise<EmbedResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.o.provider.embed(texts, "document");
        if (this.state === "building") this.tokens.lastBuild += result.tokens;
        this.tokens.total += result.tokens;
        return result;
      } catch (error) {
        if (!(error instanceof EmbeddingError) || !error.retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
        const wait = Math.min(error.retryAfterMs ?? RETRY_DELAYS_MS[attempt], MAX_RETRY_AFTER_MS);
        this.o.log("Embedding failed; retrying", { attempt: attempt + 1, waitMs: wait, error: error.message });
        await this.o.sleep(wait);
      }
    }
  }

  private pauseFor(error: unknown): RunResult {
    if (error instanceof EmbeddingError) {
      if (error.kind === "auth") {
        return { kind: "paused", reason: `API key rejected (${error.message})`, cause: "auth" };
      }
      if (error.retryable) {
        return { kind: "paused", reason: `Temporary failure, retrying in 5 minutes (${error.message})`, cause: "transient" };
      }
      return { kind: "paused", reason: error.message, cause: "fatal" };
    }
    return { kind: "paused", reason: error instanceof Error ? error.message : String(error), cause: "fatal" };
  }
}

/** Chunks every target note locally, without calling the API, and counts what would be sent. */
export async function estimateIndex(
  vault: VaultPort,
  excludeFolders: string[],
  maxChunkChars: number,
): Promise<IndexEstimate> {
  const estimate: IndexEstimate = { notes: 0, chunks: 0, chars: 0 };
  for (const file of vault.listMarkdownFiles()) {
    if (isExcluded(file.path, excludeFolders)) continue;
    const source = await vault.readNote(file.path);
    if (source === "missing" || source === "not-ready") continue;
    estimate.notes++;
    const chunks = chunkNote({
      path: file.path,
      content: source.content,
      headings: source.headings,
      frontmatterEndLine: source.frontmatterEndLine,
      maxChunkChars,
    });
    for (const chunk of chunks) {
      estimate.chunks++;
      estimate.chars += chunk.embedText.length;
    }
  }
  return estimate;
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search`
Expected: すべて PASS。失敗したら実装をテストに合わせる（テストの期待値は spec の挙動そのものなので、テストを緩めない）。

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian-plugin/src/features/semantic-search
git commit -m "feat: add the semantic indexer with batching, retries and incremental updates" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 検索の処理

**Files:**
- Create: `.../semantic-search/searchHandler.ts`
- Test: `.../semantic-search/searchHandler.test.ts`

**Interfaces:**
- Consumes: `jsonSearchRequest`, `searchRequest`, `SEARCH_LIMIT_DEFAULT`, `SearchIndexStatus`, `SearchResponse`（Task 2）、`SearchHit`, `SearchOptions`（Task 5）
- Produces: `interface SearchDeps { status(): SearchIndexStatus; chunkCount(): number; embedQuery(query): Promise<Float32Array>; search(vector, options): SearchHit[]; log(message, data?): void; now(): number }`、`interface HandlerResponse { status: number; body: unknown }`、`UNCONFIGURED_MESSAGE`、`EMPTY_MESSAGE`、`handleSearch(body: unknown, deps: SearchDeps): Promise<HandlerResponse>`。エラーの本文は `{ message }`（MCP 側の `describeHttpError` が `Details:` に載せる形）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/obsidian-plugin/src/features/semantic-search/searchHandler.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SearchIndexStatus } from "shared";
import type { SearchOptions } from "./indexStore";
import { EMPTY_MESSAGE, UNCONFIGURED_MESSAGE, handleSearch, type SearchDeps } from "./searchHandler";

const ready: SearchIndexStatus = {
  state: "ready",
  indexedNotes: 2,
  totalNotes: 2,
  failedNotes: 0,
  model: "cohere/embed-v5.0-fast@1024",
};

function deps(overrides: Partial<SearchDeps> = {}) {
  const searches: SearchOptions[] = [];
  const base: SearchDeps = {
    status: () => ready,
    chunkCount: () => 3,
    embedQuery: async () => Float32Array.from([1, 0]),
    search: (_vector, options) => {
      searches.push(options);
      return [{ path: "a.md", breadcrumbs: "a > A", text: "# A\nalpha", score: 0.9 }];
    },
    log: () => {},
    now: () => 0,
  };
  return { deps: { ...base, ...overrides }, searches };
}

describe("handleSearch", () => {
  test("returns results and the index status, with limit 20 by default", async () => {
    const { deps: d, searches } = deps();
    const response = await handleSearch(JSON.stringify({ query: "alpha" }), d);
    expect(response).toEqual({
      status: 200,
      body: {
        results: [{ path: "a.md", text: "# A\nalpha", score: 0.9, breadcrumbs: "a > A" }],
        index: ready,
      },
    });
    expect(searches[0]).toEqual({ limit: 20, folders: undefined, excludeFolders: undefined });
  });

  test("passes the filters through and accepts an already-parsed body", async () => {
    const { deps: d, searches } = deps();
    await handleSearch({ query: "x", filter: { limit: 5, folders: ["日記/"], excludeFolders: ["My Notes/"] } }, d);
    expect(searches[0]).toEqual({ limit: 5, folders: ["日記/"], excludeFolders: ["My Notes/"] });
  });

  test("rejects a bad request with 400 and the reason", async () => {
    const { deps: d } = deps();
    const badJson = await handleSearch("{", d);
    expect(badJson.status).toBe(400);
    const badLimit = await handleSearch(JSON.stringify({ query: "x", filter: { limit: 51 } }), d);
    expect(badLimit.status).toBe(400);
    expect(JSON.stringify(badLimit.body)).toContain("at most 50");
  });

  test("503 when not configured or nothing is indexed yet", async () => {
    const unconfigured = await handleSearch(JSON.stringify({ query: "x" }), deps({ status: () => ({ ...ready, state: "unconfigured" }) }).deps);
    expect(unconfigured).toEqual({ status: 503, body: { message: UNCONFIGURED_MESSAGE } });
    const empty = await handleSearch(JSON.stringify({ query: "x" }), deps({ chunkCount: () => 0 }).deps);
    expect(empty).toEqual({ status: 503, body: { message: EMPTY_MESSAGE } });
  });

  test("502 with the provider's reason when the query cannot be embedded", async () => {
    const failing = deps({
      embedQuery: async () => {
        throw new Error("Cohere returned HTTP 401: invalid api token");
      },
    }).deps;
    const response = await handleSearch(JSON.stringify({ query: "x" }), failing);
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).toContain("HTTP 401");
  });

  test("still searches while building and reports that state", async () => {
    const building = { ...ready, state: "building" as const, indexedNotes: 1 };
    const response = await handleSearch(JSON.stringify({ query: "x" }), deps({ status: () => building }).deps);
    expect(response.status).toBe(200);
    expect((response.body as { index: SearchIndexStatus }).index.state).toBe("building");
  });
});
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `cd packages/obsidian-plugin && bun test src/features/semantic-search/searchHandler.test.ts`
Expected: FAIL（`./searchHandler` が無い）

- [ ] **Step 3: 実装する**

`packages/obsidian-plugin/src/features/semantic-search/searchHandler.ts`:

```ts
import { type } from "arktype";
import {
  SEARCH_LIMIT_DEFAULT,
  jsonSearchRequest,
  searchRequest,
  type SearchIndexStatus,
  type SearchResponse,
} from "shared";
import type { SearchHit, SearchOptions } from "./indexStore";

export interface SearchDeps {
  status(): SearchIndexStatus;
  chunkCount(): number;
  embedQuery(query: string): Promise<Float32Array>;
  search(vector: Float32Array, options: SearchOptions): SearchHit[];
  log(message: string, data?: Record<string, unknown>): void;
  now(): number;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

export const UNCONFIGURED_MESSAGE =
  "Semantic search is not configured. Set the embedding provider, model and API key in Obsidian's MCP Tools settings.";
export const EMPTY_MESSAGE =
  'The semantic index has no entries yet. If it has not been built, press "Build index" in Obsidian\'s MCP Tools settings; if it is building, wait a moment and search again.';

/** The body of POST /search/smart. Error bodies are { message } so the MCP server can show the reason. */
export async function handleSearch(body: unknown, deps: SearchDeps): Promise<HandlerResponse> {
  const request = typeof body === "string" ? jsonSearchRequest(body) : searchRequest(body);
  if (request instanceof type.errors) {
    return { status: 400, body: { message: `Invalid search request: ${request.summary}` } };
  }
  const index = deps.status();
  if (index.state === "unconfigured") return { status: 503, body: { message: UNCONFIGURED_MESSAGE } };
  if (deps.chunkCount() === 0) return { status: 503, body: { message: EMPTY_MESSAGE } };

  const started = deps.now();
  let vector: Float32Array;
  try {
    vector = await deps.embedQuery(request.query);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 502, body: { message: `Embedding the query failed: ${reason}` } };
  }
  const embedded = deps.now();
  const hits = deps.search(vector, {
    limit: request.filter?.limit ?? SEARCH_LIMIT_DEFAULT,
    folders: request.filter?.folders,
    excludeFolders: request.filter?.excludeFolders,
  });
  deps.log("Semantic search", {
    embedMs: Math.round(embedded - started),
    searchMs: Math.round(deps.now() - embedded),
    results: hits.length,
  });
  const response: SearchResponse = {
    results: hits.map((hit) => ({ path: hit.path, text: hit.text, score: hit.score, breadcrumbs: hit.breadcrumbs })),
    index,
  };
  return { status: 200, body: response };
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd packages/obsidian-plugin && bun test src`
Expected: すべて PASS

- [ ] **Step 5: Commit**

```bash
git add packages/obsidian-plugin/src/features/semantic-search
git commit -m "feat: answer /search/smart from the semantic index" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Obsidian への組み込み

ここから先は Obsidian API に触るので単体テストは書かない。検証は型チェックとビルド、そして Task 14 の実機確認で行う。

**Files:**
- Create: `.../semantic-search/obsidianPorts.ts`
- Create: `.../semantic-search/index.ts`
- Modify: `packages/obsidian-plugin/src/main.ts`
- Modify: `packages/obsidian-plugin/src/types.ts`

**Interfaces:**
- Consumes: Task 3〜9 のすべて。
- Produces: `obsidianHttp: HttpFn`、`createVaultPort(app): VaultPort`、`createFilePort(app): FilePort`、`class SemanticSearchFeature` — `load()`、`getSettings()`、`saveSettings(next, { rebuild })`、`status(): FeatureStatus`、`subscribe(listener): () => void`、`startBuild()`、`rebuild()`、`cancelBuild()`、`testConnection(draft): Promise<{ dimension; ms }>`、`estimate(draft): Promise<IndexEstimate>`、`handleSearchRoute(req, res)`、`dispose()`。`interface FeatureStatus { state: "unconfigured" | IndexState; reason?; model: string | null; progress; indexedNotes; failedNotes; chunks; totalNotes; tokens: TokenCounts; completedAt: number | null; failures: { path; error }[]; hasIndex: boolean }`。`McpToolsPlugin.semanticSearch: SemanticSearchFeature`。

- [ ] **Step 1: Obsidian との接続部を書く**

`packages/obsidian-plugin/src/features/semantic-search/obsidianPorts.ts`:

```ts
import { TFile, requestUrl, type App } from "obsidian";
import type { ReadResult, VaultPort } from "./indexer";
import type { FilePort } from "./persistence";
import type { HttpFn } from "./providers";

/** requestUrl goes through Electron's main process, so the embedding APIs are not blocked by CORS. */
export const obsidianHttp: HttpFn = async (request) => {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    throw: false,
  });
  return { status: response.status, headers: response.headers, text: response.text };
};

export function createVaultPort(app: App): VaultPort {
  return {
    listMarkdownFiles: () =>
      app.vault.getMarkdownFiles().map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size })),
    async readNote(path: string): Promise<ReadResult> {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return "missing";
      const cache = app.metadataCache.getFileCache(file);
      if (!cache) return "not-ready";
      const content = await app.vault.cachedRead(file);
      return {
        content,
        headings: (cache.headings ?? []).map((h) => ({
          heading: h.heading,
          level: h.level,
          line: h.position.start.line,
          endLine: h.position.end.line,
        })),
        frontmatterEndLine: cache.frontmatterPosition ? cache.frontmatterPosition.end.line : null,
      };
    },
  };
}

export function createFilePort(app: App): FilePort {
  const adapter = app.vault.adapter;
  return {
    async read(path) {
      return (await adapter.exists(path)) ? adapter.readBinary(path) : null;
    },
    write: (path, data) => adapter.writeBinary(path, data),
    async remove(path) {
      if (await adapter.exists(path)) await adapter.remove(path);
    },
    rename: (from, to) => adapter.rename(from, to),
    exists: (path) => adapter.exists(path),
    async mkdir(path) {
      if (!(await adapter.exists(path))) await adapter.mkdir(path);
    },
  };
}
```

- [ ] **Step 2: 機能の本体を書く**

`packages/obsidian-plugin/src/features/semantic-search/index.ts`:

```ts
import type { Request, Response } from "express";
import { Notice, TFile, TFolder, type TAbstractFile } from "obsidian";
import type { SearchIndexStatus } from "shared";
import type McpToolsPlugin from "../../main";
import { logger } from "../../shared/logger";
import {
  Indexer,
  estimateIndex,
  type IndexEstimate,
  type IndexState,
  type TokenCounts,
  type VaultPort,
} from "./indexer";
import { IndexStore } from "./indexStore";
import { createFilePort, createVaultPort, obsidianHttp } from "./obsidianPorts";
import {
  deleteIndex,
  loadIndex,
  newManifest,
  saveIndex,
  type BuildState,
  type FilePort,
  type IndexManifest,
} from "./persistence";
import { createProvider, type EmbeddingProvider } from "./providers";
import { handleSearch } from "./searchHandler";
import {
  fingerprintKey,
  fingerprintOf,
  isConfigured,
  isExcluded,
  modelLabel,
  withDefaults,
  type IndexFingerprint,
  type SemanticSearchSettings,
} from "./settings";

const SAVE_DELAY_MS = 30_000;
const RESOLVE_TIMEOUT_MS = 10_000;

export interface FeatureStatus {
  state: "unconfigured" | IndexState;
  reason?: string;
  model: string | null;
  progress: { done: number; total: number } | null;
  indexedNotes: number;
  failedNotes: number;
  chunks: number;
  totalNotes: number;
  tokens: TokenCounts;
  completedAt: number | null;
  failures: { path: string; error: string }[];
  hasIndex: boolean;
}

function initialState(manifest: IndexManifest | null): { state: IndexState; reason?: string } {
  if (!manifest) return { state: "empty" };
  if (manifest.buildState === "completed") return { state: "ready" };
  if (manifest.buildState === "cancelled") return { state: "paused", reason: "Cancelled" };
  return { state: "paused", reason: "Interrupted; resuming" };
}

export class SemanticSearchFeature {
  private settings: SemanticSearchSettings = withDefaults(undefined);
  private store: IndexStore | null = null;
  private indexer: Indexer | null = null;
  private manifest: IndexManifest | null = null;
  private provider: EmbeddingProvider | null = null;
  private fingerprint: IndexFingerprint | null = null;
  private generation = 0;
  private saveTimer: number | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly vault: VaultPort;
  private readonly files: FilePort;

  constructor(private readonly plugin: McpToolsPlugin) {
    this.vault = createVaultPort(plugin.app);
    this.files = createFilePort(plugin.app);
  }

  private get dir(): string {
    return `${this.plugin.manifest.dir ?? ".obsidian/plugins/mcp-tools"}/semantic-index`;
  }

  private readonly getSecret = (id: string): string | null =>
    id ? this.plugin.app.secretStorage.getSecret(id) : null;

  async load(): Promise<void> {
    const data = (await this.plugin.loadData()) ?? {};
    this.settings = withDefaults(data.semanticSearch);
    const { metadataCache, vault, workspace } = this.plugin.app;
    this.plugin.registerEvent(
      metadataCache.on("changed", (file) => {
        if (file.extension === "md") this.indexer?.noteChanged(file.path);
      }),
    );
    this.plugin.registerEvent(vault.on("delete", (file) => this.onDelete(file)));
    this.plugin.registerEvent(vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
    workspace.onLayoutReady(() => this.whenMetadataResolved(() => void this.activate()));
  }

  getSettings(): SemanticSearchSettings {
    return JSON.parse(JSON.stringify(this.settings)) as SemanticSearchSettings;
  }

  /** Persists settings and restarts the indexer with them. `rebuild` discards the index and builds a new one. */
  async saveSettings(next: SemanticSearchSettings, options: { rebuild: boolean }): Promise<void> {
    this.clearSaveTimer();
    await this.saveNow();
    this.settings = withDefaults(next);
    const data = (await this.plugin.loadData()) ?? {};
    await this.plugin.saveData({ ...data, semanticSearch: this.settings });
    if (options.rebuild) {
      this.indexer?.dispose();
      this.indexer = null;
      await deleteIndex(this.files, this.dir);
    }
    await this.activate();
    if (options.rebuild) void this.indexer?.build();
  }

  /** Builds, or resumes a paused build. The returned promise settles when the run ends; callers need not wait. */
  startBuild(): Promise<void> {
    return this.indexer?.build() ?? Promise.resolve();
  }

  /** Discards the index and builds it again from scratch. */
  async rebuild(): Promise<void> {
    this.clearSaveTimer();
    this.indexer?.dispose();
    this.indexer = null;
    await this.saving;
    await deleteIndex(this.files, this.dir);
    await this.activate();
    void this.indexer?.build();
  }

  cancelBuild(): void {
    this.indexer?.cancel();
  }

  async testConnection(draft: SemanticSearchSettings): Promise<{ dimension: number; ms: number }> {
    const provider = createProvider(withDefaults(draft), this.getSecret, obsidianHttp);
    const started = performance.now();
    const result = await provider.embed(["test"], "query");
    return { dimension: result.vectors[0].length, ms: Math.round(performance.now() - started) };
  }

  estimate(draft: SemanticSearchSettings): Promise<IndexEstimate> {
    return estimateIndex(this.vault, draft.excludeFolders, draft.maxChunkChars);
  }

  status(): FeatureStatus {
    const stats = this.store?.stats() ?? { notes: 0, failedNotes: 0, chunks: 0 };
    const indexer = this.indexer?.status();
    return {
      state: indexer ? indexer.state : "unconfigured",
      ...(indexer?.reason !== undefined ? { reason: indexer.reason } : {}),
      model: this.fingerprint ? modelLabel(this.fingerprint) : null,
      progress: indexer?.progress ?? null,
      indexedNotes: stats.notes - stats.failedNotes,
      failedNotes: stats.failedNotes,
      chunks: stats.chunks,
      totalNotes: this.vault.listMarkdownFiles().filter((f) => !isExcluded(f.path, this.settings.excludeFolders)).length,
      tokens: indexer?.tokens ?? { lastBuild: 0, total: 0 },
      completedAt: this.manifest?.completedAt ?? null,
      failures: this.store?.failures() ?? [],
      hasIndex: this.manifest !== null,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async handleSearchRoute(req: Request, res: Response): Promise<void> {
    try {
      const response = await handleSearch(req.body, {
        status: () => this.searchStatus(),
        chunkCount: () => this.store?.stats().chunks ?? 0,
        embedQuery: async (query) => {
          if (!this.provider) throw new Error("Semantic search is not configured");
          return (await this.provider.embed([query], "query")).vectors[0];
        },
        search: (vector, options) => (this.store ? this.store.search(vector, options) : []),
        log: (message, data) => logger.info(message, data),
        now: () => performance.now(),
      });
      res.status(response.status).json(response.body);
    } catch (error) {
      logger.error("Semantic search failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ message: `Semantic search failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  dispose(): void {
    this.clearSaveTimer();
    this.indexer?.dispose();
    void this.saveNow();
    this.generation++;
  }

  private searchStatus(): SearchIndexStatus {
    const s = this.status();
    return {
      state: s.state,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
      indexedNotes: s.indexedNotes,
      totalNotes: s.totalNotes,
      failedNotes: s.failedNotes,
      model: s.model ?? "",
    };
  }

  private whenMetadataResolved(callback: () => void): void {
    const { metadataCache } = this.plugin.app;
    let done = false;
    let timer = 0;
    const ref = metadataCache.on("resolved", () => fire());
    const stop = () => {
      done = true;
      metadataCache.offref(ref);
      window.clearTimeout(timer);
    };
    const fire = () => {
      if (done) return;
      stop();
      callback();
    };
    // "resolved" may already have fired before we listened; notes not parsed yet are skipped and their "changed" event catches up.
    timer = window.setTimeout(fire, RESOLVE_TIMEOUT_MS);
    this.plugin.register(stop);
  }

  /** (Re)creates provider, store and indexer from the settings and loads the index from disk. */
  private async activate(): Promise<void> {
    const generation = ++this.generation;
    this.indexer?.dispose();
    this.indexer = null;
    this.store = null;
    this.manifest = null;
    this.provider = null;
    this.fingerprint = null;
    if (!isConfigured(this.settings, this.getSecret)) {
      this.emit();
      return;
    }
    const fingerprint = fingerprintOf(this.settings);
    const key = fingerprintKey(fingerprint);
    const loaded = await loadIndex(this.files, this.dir, key, fingerprint.dimension ?? 0);
    if (generation !== this.generation) return;
    if (!loaded) await deleteIndex(this.files, this.dir);
    if (loaded && loaded.brokenShards.length > 0) {
      logger.warn("Semantic index: unreadable shards will be re-embedded", { shards: loaded.brokenShards });
    }
    const store = loaded?.store ?? new IndexStore(key, fingerprint.dimension ?? 0);
    const manifest = loaded?.manifest ?? null;
    this.store = store;
    this.manifest = manifest;
    this.fingerprint = fingerprint;
    this.provider = createProvider(this.settings, this.getSecret, obsidianHttp);
    this.indexer = new Indexer({
      vault: this.vault,
      provider: this.provider,
      store,
      excludeFolders: this.settings.excludeFolders,
      maxChunkChars: this.settings.maxChunkChars,
      initial: initialState(manifest),
      tokens: manifest?.tokens ?? { lastBuild: 0, total: 0 },
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      schedule: (fn, ms) => {
        const id = window.setTimeout(fn, ms);
        return () => window.clearTimeout(id);
      },
      onBuildState: (state) => {
        if (generation === this.generation) this.setBuildState(state);
      },
      onChange: () => {
        if (generation !== this.generation) return;
        this.scheduleSave();
        this.emit();
      },
      notify: (message) => new Notice(message),
      log: (message, data) => logger.info(message, data),
    });
    if (manifest?.buildState === "running") void this.indexer.build();
    else if (manifest?.buildState === "completed") void this.indexer.startupSync();
    this.emit();
  }

  private setBuildState(state: BuildState): void {
    if (!this.fingerprint) return;
    if (!this.manifest) this.manifest = newManifest(fingerprintKey(this.fingerprint));
    this.manifest.buildState = state;
    if (state === "completed") this.manifest.completedAt = Date.now();
    this.scheduleSave(state === "running" ? SAVE_DELAY_MS : 0);
  }

  private scheduleSave(delay: number = SAVE_DELAY_MS): void {
    if (this.saveTimer !== null) {
      if (delay > 0) return;
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, delay);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  /** Writes changed shards and the manifest; saves never interleave. */
  private saveNow(): Promise<void> {
    const store = this.store;
    const manifest = this.manifest;
    const indexer = this.indexer;
    if (!store || !manifest || !indexer) return this.saving;
    manifest.tokens = indexer.status().tokens;
    this.saving = this.saving
      .then(() => saveIndex(this.files, this.dir, store, manifest))
      .catch((error) => logger.error("Semantic index save failed", { error: String(error) }));
    return this.saving;
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private onDelete(file: TAbstractFile): void {
    if (file instanceof TFile) {
      this.indexer?.noteDeleted(file.path);
      return;
    }
    if (file instanceof TFolder) {
      for (const path of this.store?.paths() ?? []) {
        if (path.startsWith(`${file.path}/`)) this.indexer?.noteDeleted(path);
      }
    }
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFile) {
      this.indexer?.noteRenamed(oldPath, file.path);
      return;
    }
    if (file instanceof TFolder) {
      for (const path of this.store?.paths() ?? []) {
        if (path.startsWith(`${oldPath}/`)) this.indexer?.noteRenamed(path, `${file.path}${path.slice(oldPath.length)}`);
      }
    }
  }
}
```

- [ ] **Step 3: 設定の型を足す**

`packages/obsidian-plugin/src/types.ts` を次に置き換える:

```ts
import type { SemanticSearchSettings } from "./features/semantic-search/settings";

declare module "obsidian" {
  interface McpToolsPluginSettings {
    version?: string;
    semanticSearch?: Partial<SemanticSearchSettings>;
  }

  interface Plugin {
    loadData(): Promise<McpToolsPluginSettings>;
    saveData(data: McpToolsPluginSettings): Promise<void>;
  }
}

export {};
```

- [ ] **Step 4: main.ts を新しい機能に切り替える**

`packages/obsidian-plugin/src/main.ts` を次のように変える。

import から `jsonSearchRequest`、`searchParameters`、`type SearchResponse`、`loadSmartSearchAPI`、`import { shake } from "radash";` を消し、次を足す:

```ts
import { SemanticSearchFeature } from "./features/semantic-search";
```

クラスの先頭（`private localRestApi` の前）に足す:

```ts
  semanticSearch!: SemanticSearchFeature;
```

`onload()` の先頭（`await setupCore(this);` の前）に足す。設定タブがこの機能を参照するので、先に作る:

```ts
    this.semanticSearch = new SemanticSearchFeature(this);
    await this.semanticSearch.load();
```

`/search/smart` のルート登録を置き換える:

```ts
      this.localRestApi.api
        .addRoute("/search/smart")
        .post((req, res) => this.semanticSearch.handleSearchRoute(req, res));
```

`handleSearchRequest` メソッドを丸ごと消す。`onunload()` を次にする:

```ts
  onunload() {
    this.semanticSearch?.dispose();
    this.localRestApi.api?.unregister();
  }
```

- [ ] **Step 5: 型チェック・テスト・ビルド**

Run: `cd packages/obsidian-plugin && bun run check && bun test src && GITHUB_DOWNLOAD_URL="https://github.com/jacksteamdev/obsidian-mcp-tools/releases/download/0.2.33" GITHUB_REF_NAME="0.2.33" bun run build`
Expected: `tsc --noEmit` の出力にエラー行が無い、テストはすべて PASS、`Build successful`。リポジトリ直下の `main.js` が更新される（`.gitignore` 済みなのでコミットには入らない）。

- [ ] **Step 6: Commit**

```bash
git add packages/obsidian-plugin/src
git commit -m "feat: serve semantic search from the plugin's own embedding index" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 設定画面

**Files:**
- Create: `.../semantic-search/components/SemanticSearchSettings.svelte`
- Create: `.../semantic-search/components/confirmIndexing.ts`
- Modify: `.../semantic-search/index.ts`（コンポーネントの export を 1 行足す）
- Modify: `packages/obsidian-plugin/src/features/core/components/SettingsTab.svelte`
- Modify: `manifest.json`（`minAppVersion`）

**Interfaces:**
- Consumes: `SemanticSearchFeature` と `FeatureStatus`（Task 10）、`COHERE_DIMENSIONS`, `parseExcludeFolders`, `requiresRebuild`, `SemanticSearchSettings`（Task 4）、`IndexEstimate`（Task 8）
- Produces: `confirmIndexing(app, title, estimate): Promise<boolean>`、`SemanticSearchSettingsView`（Svelte コンポーネント、prop `plugin`）。

- [ ] **Step 1: 確認ダイアログを書く**

`packages/obsidian-plugin/src/features/semantic-search/components/confirmIndexing.ts`:

```ts
import { Modal, Setting, type App } from "obsidian";
import type { IndexEstimate } from "../indexer";

/** Asks before sending the vault to the embedding API. Resolves true only when "Start" is pressed. */
export function confirmIndexing(app: App, title: string, estimate: IndexEstimate): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value: boolean, modal: Modal) => {
      answered = true;
      resolve(value);
      modal.close();
    };
    const modal = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(title);
        this.contentEl.createEl("p", {
          text:
            `${estimate.notes.toLocaleString()} notes, ${estimate.chunks.toLocaleString()} sections and ` +
            `${estimate.chars.toLocaleString()} characters will be sent to the embedding API. ` +
            "Excluded folders are not sent.",
        });
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText("Cancel").onClick(() => answer(false, this)))
          .addButton((button) => button.setButtonText("Start").setCta().onClick(() => answer(true, this)));
      }
      onClose() {
        if (!answered) resolve(false);
        this.contentEl.empty();
      }
    })(app);
    modal.open();
  });
}
```

- [ ] **Step 2: 設定画面のコンポーネントを書く**

`packages/obsidian-plugin/src/features/semantic-search/components/SemanticSearchSettings.svelte`:

```svelte
<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice, SecretComponent } from "obsidian";
  import { onDestroy, onMount } from "svelte";
  import type { FeatureStatus } from "..";
  import {
    COHERE_DIMENSIONS,
    parseExcludeFolders,
    requiresRebuild,
    type SemanticSearchSettings,
  } from "../settings";
  import { confirmIndexing } from "./confirmIndexing";

  export let plugin: McpToolsPlugin;
  const feature = plugin.semanticSearch;

  let draft: SemanticSearchSettings = feature.getSettings();
  let excludeText = draft.excludeFolders.join("\n");
  let saved = JSON.stringify(feature.getSettings());
  let status: FeatureStatus = feature.status();
  let busy = false;
  let testResult = "";
  let estimateText = "";
  let cohereKeyEl: HTMLDivElement;
  let openaiKeyEl: HTMLDivElement;
  let cohereSecret: SecretComponent | undefined;
  let openaiSecret: SecretComponent | undefined;

  $: dirty = JSON.stringify({ ...draft, excludeFolders: parseExcludeFolders(excludeText) }) !== saved;

  const unsubscribe = feature.subscribe(() => {
    status = feature.status();
  });
  onDestroy(unsubscribe);

  onMount(() => {
    cohereSecret = new SecretComponent(plugin.app, cohereKeyEl)
      .setValue(draft.cohere.apiKeySecretId)
      .onChange((value) => {
        draft.cohere.apiKeySecretId = value;
      });
    openaiSecret = new SecretComponent(plugin.app, openaiKeyEl)
      .setValue(draft.openaiCompatible.apiKeySecretId)
      .onChange((value) => {
        draft.openaiCompatible.apiKeySecretId = value;
      });
  });

  const fmt = (n: number) => n.toLocaleString();
  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

  function currentDraft(): SemanticSearchSettings {
    return { ...draft, excludeFolders: parseExcludeFolders(excludeText) };
  }

  function reset() {
    draft = feature.getSettings();
    excludeText = draft.excludeFolders.join("\n");
    saved = JSON.stringify(feature.getSettings());
    cohereSecret?.setValue(draft.cohere.apiKeySecretId);
    openaiSecret?.setValue(draft.openaiCompatible.apiKeySecretId);
  }

  async function save() {
    busy = true;
    try {
      const next = currentDraft();
      const rebuild = status.hasIndex && requiresRebuild(feature.getSettings(), next);
      if (rebuild) {
        const estimate = await feature.estimate(next);
        if (!(await confirmIndexing(plugin.app, "Rebuild the semantic index with the new settings?", estimate))) {
          reset();
          return;
        }
      }
      await feature.saveSettings(next, { rebuild });
      reset();
      new Notice("Semantic search settings saved");
    } catch (error) {
      new Notice(`Saving failed: ${errorMessage(error)}`);
    } finally {
      busy = false;
    }
  }

  async function testConnection() {
    busy = true;
    testResult = "Testing...";
    try {
      const result = await feature.testConnection(currentDraft());
      testResult = `OK: ${result.dimension} dimensions in ${result.ms} ms`;
    } catch (error) {
      testResult = `Failed: ${errorMessage(error)}`;
    } finally {
      busy = false;
    }
  }

  async function showEstimate() {
    busy = true;
    try {
      const e = await feature.estimate(currentDraft());
      estimateText = `${fmt(e.notes)} notes, ${fmt(e.chunks)} sections, ${fmt(e.chars)} characters would be sent`;
    } finally {
      busy = false;
    }
  }

  async function build() {
    if (status.state === "paused") {
      void feature.startBuild();
      return;
    }
    const estimate = await feature.estimate(feature.getSettings());
    const fresh = status.state === "ready";
    const title = fresh ? "Rebuild the semantic index from scratch?" : "Build the semantic index?";
    if (!(await confirmIndexing(plugin.app, title, estimate))) return;
    if (fresh) void feature.rebuild();
    else void feature.startBuild();
  }

  function stateLabel(s: FeatureStatus): string {
    switch (s.state) {
      case "unconfigured":
        return "Not configured: choose a provider, model and API key, then save";
      case "empty":
        return "Not built yet";
      case "building":
        return s.progress ? `Building: ${fmt(s.progress.done)} / ${fmt(s.progress.total)} notes` : "Building";
      case "paused":
        return `Paused: ${s.reason ?? ""}`;
      case "ready":
        return "Ready";
    }
  }
</script>

<div class="semantic-search">
  <h3>Semantic search</h3>

  <div class="row">
    <label for="ss-provider">Provider</label>
    <select id="ss-provider" bind:value={draft.provider}>
      <option value="cohere">Cohere</option>
      <option value="openai-compatible">OpenAI-compatible</option>
    </select>
  </div>

  <div class:hidden={draft.provider !== "cohere"}>
    <div class="row"><span>API key</span><div bind:this={cohereKeyEl}></div></div>
    <div class="row">
      <label for="ss-cohere-model">Model</label>
      <input id="ss-cohere-model" type="text" bind:value={draft.cohere.model} />
    </div>
    <div class="row">
      <label for="ss-cohere-dim">Dimension</label>
      <select id="ss-cohere-dim" bind:value={draft.cohere.dimension}>
        {#each COHERE_DIMENSIONS as dimension}<option value={dimension}>{dimension}</option>{/each}
      </select>
    </div>
  </div>

  <div class:hidden={draft.provider !== "openai-compatible"}>
    <div class="row">
      <label for="ss-oa-url">Base URL</label>
      <input id="ss-oa-url" type="text" placeholder="http://localhost:11434/v1" bind:value={draft.openaiCompatible.baseUrl} />
    </div>
    <div class="row"><span>API key (optional)</span><div bind:this={openaiKeyEl}></div></div>
    <div class="row">
      <label for="ss-oa-model">Model</label>
      <input id="ss-oa-model" type="text" bind:value={draft.openaiCompatible.model} />
    </div>
    <div class="row">
      <label for="ss-oa-dims">Dimensions (optional)</label>
      <input
        id="ss-oa-dims"
        type="number"
        min="1"
        value={draft.openaiCompatible.dimensions ?? ""}
        on:input={(event) => {
          const value = event.currentTarget.value;
          draft.openaiCompatible.dimensions = value ? Number(value) : null;
        }}
      />
    </div>
    <div class="row">
      <label for="ss-oa-qp">Query prefix</label>
      <input id="ss-oa-qp" type="text" placeholder="query: " bind:value={draft.openaiCompatible.queryPrefix} />
    </div>
    <div class="row">
      <label for="ss-oa-dp">Document prefix</label>
      <input id="ss-oa-dp" type="text" placeholder="passage: " bind:value={draft.openaiCompatible.documentPrefix} />
    </div>
    <div class="row">
      <label for="ss-oa-batch">Texts per request</label>
      <input id="ss-oa-batch" type="number" min="1" bind:value={draft.openaiCompatible.batchSize} />
    </div>
  </div>

  <div class="row column">
    <label for="ss-exclude">Excluded folders: one path prefix per line, never sent to the API (end with / to match only that folder)</label>
    <textarea id="ss-exclude" rows="4" bind:value={excludeText}></textarea>
  </div>
  <div class="row">
    <label for="ss-max">Max characters per section</label>
    <input id="ss-max" type="number" min="200" bind:value={draft.maxChunkChars} />
  </div>

  <div class="buttons">
    <button on:click={save} disabled={busy || !dirty}>Save</button>
    <button on:click={testConnection} disabled={busy}>Test connection</button>
    <button on:click={showEstimate} disabled={busy}>Estimate</button>
  </div>
  {#if testResult}<div class="note">{testResult}</div>{/if}
  {#if estimateText}<div class="note">{estimateText}</div>{/if}

  <h4>Index</h4>
  <div class="status">
    <div>State: {stateLabel(status)}</div>
    {#if status.model}<div>Model: {status.model}</div>{/if}
    <div>Notes: {fmt(status.indexedNotes)} / {fmt(status.totalNotes)} · Sections: {fmt(status.chunks)}</div>
    <div>Tokens: {fmt(status.tokens.lastBuild)} in the last build · {fmt(status.tokens.total)} in total</div>
    {#if status.completedAt}<div>Last completed: {new Date(status.completedAt).toLocaleString()}</div>{/if}
    {#if status.failedNotes > 0}
      <details>
        <summary>{status.failedNotes} notes failed</summary>
        <ul>
          {#each status.failures as failure (failure.path)}
            <li><code>{failure.path}</code>: {failure.error}</li>
          {/each}
        </ul>
      </details>
    {/if}
  </div>
  <div class="buttons">
    {#if status.state === "building"}
      <button on:click={() => feature.cancelBuild()}>Cancel</button>
    {:else if status.state !== "unconfigured"}
      <button on:click={build} disabled={busy || dirty}>
        {status.state === "ready" ? "Rebuild" : status.state === "paused" ? "Resume" : "Build index"}
      </button>
    {/if}
    {#if dirty}<span class="note">Save the settings first.</span>{/if}
  </div>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.75em;
    margin-bottom: 0.5em;
  }
  .row.column {
    flex-direction: column;
    align-items: stretch;
  }
  .row > :first-child {
    min-width: 12em;
  }
  .hidden {
    display: none;
  }
  .buttons {
    display: flex;
    gap: 0.5em;
    align-items: center;
    margin: 0.75em 0;
  }
  .note {
    color: var(--text-muted);
  }
  .status > div {
    margin-bottom: 0.25em;
  }
</style>
```

- [ ] **Step 3: export と設定タブへの組み込み**

`packages/obsidian-plugin/src/features/semantic-search/index.ts` の import 群の後に追加:

```ts
export { default as SemanticSearchSettingsView } from "./components/SemanticSearchSettings.svelte";
```

`packages/obsidian-plugin/src/features/core/components/SettingsTab.svelte` を次にする:

```svelte
<script lang="ts">
  import { FeatureSettings as McpServerInstallSettings } from "src/features/mcp-server-install";
  import { SemanticSearchSettingsView } from "src/features/semantic-search";
  import type McpServerPlugin from "src/main";

  export let plugin: McpServerPlugin;
</script>

<div class="settings-container">
  <McpServerInstallSettings {plugin} />
  <SemanticSearchSettingsView {plugin} />
</div>
```

- [ ] **Step 4: minAppVersion を上げる**

ルートの `manifest.json` の `"minAppVersion": "0.15.0"` を `"minAppVersion": "1.11.4"` にする（`SecretStorage` / `SecretComponent` が 1.11.4 以降のため）。`versions.json` は `bun run version` が次の版で更新するので触らない。

- [ ] **Step 5: 型チェックとビルド**

Run: `cd packages/obsidian-plugin && bun run check && bun test src && GITHUB_DOWNLOAD_URL="https://github.com/jacksteamdev/obsidian-mcp-tools/releases/download/0.2.33" GITHUB_REF_NAME="0.2.33" bun run build`
Expected: 型エラーなし、テスト PASS、`Build successful`。Svelte のコンパイルエラーが出たら（`event.currentTarget` の型など）、Svelte 5 の legacy 構文の範囲で直す。

- [ ] **Step 6: Commit**

```bash
git add packages/obsidian-plugin/src manifest.json
git commit -m "feat: add semantic search settings with secret-stored API keys" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Smart Connections のコードと記述を撤去する

**Files:**
- Delete: `packages/shared/src/types/plugin-smart-connections.ts`
- Modify: `packages/shared/src/types/index.ts`、`packages/shared/src/types/smart-search.ts`
- Modify: `packages/obsidian-plugin/src/shared/index.ts`、`packages/obsidian-plugin/src/features/mcp-server-install/types.ts`
- Modify: `packages/mcp-server/src/shared/describeApiError.ts:280`
- Modify: `README.md`、`packages/mcp-server/README.md`、`packages/obsidian-plugin/README.md`、`docs/features/mcp-server-install.md`、`CLAUDE.md`

**Interfaces:**
- Consumes: なし（参照を消すだけ）
- Produces: `SmartConnections` 名前空間・`searchParameters`・`loadSmartSearchAPI`・`Dependencies["smart-connections"]` が無くなる。

- [ ] **Step 1: shared から消す**

```bash
git rm packages/shared/src/types/plugin-smart-connections.ts
```

`packages/shared/src/types/index.ts` から `export * as SmartConnections from "./plugin-smart-connections";` の行を消す。

`packages/shared/src/types/smart-search.ts` から `import { SmartSearchFilter } from "./plugin-smart-connections";` と、末尾の `searchParameters`（コメントごと）を消す。

- [ ] **Step 2: プラグインから消す**

`packages/obsidian-plugin/src/shared/index.ts`:
- import の `type SmartConnections` を消し、`import type { Templater } from "shared";` にする。
- `Dependencies` から `"smart-connections"` のエントリを消す。
- `declare const window: { SmartSearch?: ... } & Window;` とその直前のコメント、`export const loadSmartSearchAPI = ...` の定義全体を消す。
- `loadDependencies()` の `dependencies` から `"smart-connections"` のエントリを消し、`merge(...)` の引数から `loadSmartSearchAPI(plugin),` を消す。結果は次の形になる:

```ts
export const loadDependencies = (plugin: McpToolsPlugin) => {
  const dependencies: Dependencies = {
    "obsidian-local-rest-api": {
      id: "obsidian-local-rest-api",
      name: "Local REST API",
      required: true,
      installed: false,
      url: "https://github.com/coddingtonbear/obsidian-local-rest-api",
    },
    "templater-obsidian": {
      id: "templater-obsidian",
      name: "Templater",
      required: false,
      installed: false,
      url: "https://silentvoid13.github.io/Templater/",
    },
  };
  return merge(loadLocalRestAPI(plugin), loadTemplaterAPI(plugin)).pipe(
    scan((acc, dependency) => {
      // @ts-expect-error Dynamic key assignment
      acc[dependency.id] = {
        ...dependencies[dependency.id],
        ...dependency,
      };
      return acc;
    }, dependencies),
    startWith(dependencies),
  );
};
```

rxjs の import はそのまま残す（`loadLocalRestAPI` / `loadTemplaterAPI` / `loadDependencies` が使っており、tsconfig は未使用の import をエラーにしない）。`bun run check` が `scan` の中の `// @ts-expect-error Dynamic key assignment` について「Unused '@ts-expect-error' directive」と言った場合だけ、そのコメント行を消す。

`packages/obsidian-plugin/src/features/mcp-server-install/types.ts`:
- 1 行目を `import type { Templater } from "shared";` にする。
- `declare module "obsidian"` の中の `["smart-connections"]?: { env?: SmartConnections.SmartSearch; } & Plugin;` を消す。

- [ ] **Step 3: MCP サーバのタイムアウト文言を直す**

`packages/mcp-server/src/shared/describeApiError.ts` の

```ts
      "or a Templater/Smart Connections operation may still be running.";
```

を

```ts
      "or a Templater or semantic search operation may still be running.";
```

にする。

- [ ] **Step 4: 残りの参照が無いことを確かめる**

Run: `git grep -n -i -E "smart ?connections|SmartSearch|smart-connections|searchParameters" -- packages ':!packages/test-site'`
Expected: 出力なし。出たら消す。

- [ ] **Step 5: README 類を書き換える**

`README.md`:
- 32 行目の `[^5]` 付きの行を `- **Semantic Search**: AI assistants can search your vault based on meaning and context, not just keywords, using an embedding model you choose (Cohere or any OpenAI-compatible API) [^5]` にする。
- 「Recommended」の `- [Smart Connections](https://smartconnections.app/) plugin for semantic search capabilities` の行を消す。
- 脚注 `[^5]: Requires Obsidian plugin Smart Connections` を `[^5]: Requires an embedding API key (or a local OpenAI-compatible server) set in the MCP Tools plugin settings` にする。

`packages/mcp-server/README.md`: `- Semantic search through Smart Connections` を `- Semantic search over the plugin's embedding index` にする。

`packages/obsidian-plugin/README.md`: `- **Semantic Search**: Seamless integration with Smart Connections for context-aware search` を `- **Semantic Search**: Builds its own embedding index (Cohere or any OpenAI-compatible API) for context-aware search` にし、Recommended の `- [Smart Connections](https://smartconnections.app/) for semantic search` を消す。

`docs/features/mcp-server-install.md`: `   - (Optional) Smart Connections plugin for enhanced search` と `- Smart Connections: For enhanced search capabilities` の 2 行を消す。

- [ ] **Step 6: CLAUDE.md を書き換える**

次の行を置き換える。

29 行目の `` `POST /search/smart`（Smart Connections 経由の意味検索） `` を `` `POST /search/smart`（本プラグインの埋め込み索引による意味検索。後述） `` に。

55 行目の `` `registerSmartConnectionsTools` `` を `` `registerSemanticSearchTools` `` に。

58 行目を `` - `features/semantic-search/index.ts`: `search_vault_smart` `` に。

184 行目の `` テストは `packages/mcp-server` にしかない（`src/shared/*.test.ts` と `src/features/**/*.test.ts`）。 `` を `` テストは `packages/mcp-server`（`src/shared/*.test.ts` と `src/features/**/*.test.ts`）と `packages/obsidian-plugin`（`src/features/semantic-search/**/*.test.ts`、`cd packages/obsidian-plugin && bun test src`）にある。 `` に。

257 行目の `` `minAppVersion` は `0.15.0` `` を `` `minAppVersion` は `1.11.4`（意味検索の API キーを `SecretStorage` に置くため） `` に。

263 行目の `` README の「Obsidian v1.7.7 以上」も manifest の `minAppVersion` には反映されていない（`0.15.0` のまま）。 `` を `` manifest の `minAppVersion` は `1.11.4`。 `` に。

「### コーディング規約: パスを URL に埋め込むときはセグメント単位でエンコードする」の直前に、次の節を足す:

```markdown
### 意味検索は自前の埋め込み索引で行う（Smart Connections は使わない）

背景: Smart Connections で任意の埋め込みモデル（API）を使うには Pro（年 299 ドル）が要り、無料のローカルモデル（multilingual-e5-small、512 トークン、ノート全体の埋め込みは実質冒頭数百字）では日本語の検索が弱かった。2026-10 に置き換えた。設計は `docs/superpowers/specs/2026-10-03-semantic-search-design.md`、実装計画は `docs/superpowers/plans/2026-10-03-semantic-search.md`。

- 実体は `packages/obsidian-plugin/src/features/semantic-search/`。見出しごとの節（最大 `maxChunkChars` 字、既定 4000）を `ノート名 > H1 > H2` の前置き付きで埋め込み、`.obsidian/plugins/mcp-tools/semantic-index/` の 32 個の shard（`MCPIDX01` 形式、Float32、正規化済み）と `manifest.json` に保存する。検索は全件の内積の総当たり（2 万節 × 1024 次元で十数 ms）。
- プロバイダは Cohere（`embed-v5.0-fast` 既定、`input_type` で検索語と文書を区別）と OpenAI 互換 `/embeddings`（前置き文字列で区別）。API キーは Obsidian の `SecretStorage` に置き、`data.json` には ID だけを書く。MCP サーバにはキーを渡さない。
- モデルの識別子（プロバイダ・モデル・次元・前置き・節の上限・`CHUNKER_VERSION`）が変わったら索引を捨てて作り直す。分割規則を変えたら `chunker.ts` の `CHUNKER_VERSION` を上げる。
- 最初の索引作りは設定画面のボタンを押したときだけ始まる（vault 全体をクラウドに送るので）。以後は `metadataCache` の `changed` と vault の `delete` / `rename` を 10 秒まとめて差分更新し、送る文字列のハッシュが同じ節は前のベクトルを使い回す。
- 失敗: 401/403 は停止して Notice、429/5xx/通信エラーは 2・8・30 秒で再試行してから停止し 5 分後に再開、400 はノート単位に送り直して原因のノートだけ「失敗」として記録する（更新されるまで再送しない）。
- `/search/smart` は未設定・空なら 503、検索語の埋め込み失敗は 502（本文 `{ message }`）。応答に `index`（状態）が付き、MCP ツールは `ready` 以外なら先頭に警告を 1 行付ける。`limit` は 1〜50 の整数、既定 20。
- 単体テストは `packages/obsidian-plugin/src/features/semantic-search/**/*.test.ts`。実機は `bun run verify:semantic`（後述）。
```

「## 検証用の vault パス条件」の節の最後（`2026-09-24 時点で 179/179 PASS。` の後）に段落を足す:

```markdown
意味検索は `cd packages/mcp-server && bun run build:windows && bun run verify:semantic` で確かめる。索引が作成済み（設定画面で `ready`）であること。上の 5 パターンに固有の話題のノートを作り、差分更新を待ってから言い換えた検索語で当たるか、`folders` / `excludeFolders` の絞り込み、`limit` の範囲外が `isError` になるか、更新・削除が結果に反映されるかを回す。`_mcp-tools-test/` を除外フォルダに入れていると全部失敗する。
```

- [ ] **Step 7: 全体の型チェックとテスト**

Run: `bun run check && cd packages/mcp-server && bun test && cd ../obsidian-plugin && bun test src`
Expected: 型エラーなし。mcp-server は既知の 4 件だけ失敗、obsidian-plugin はすべて PASS。

- [ ] **Step 8: Commit**

```bash
git add -A packages README.md docs/features CLAUDE.md
git commit -m "refactor: remove the Smart Connections integration" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: verify:semantic スクリプト

**Files:**
- Create: `packages/mcp-server/scripts/verify-semantic.ts`
- Modify: `packages/mcp-server/package.json`（scripts）

**Interfaces:**
- Consumes: MCP ツール `create_vault_file` / `delete_vault_file` / `search_vault_smart`（Task 2 の応答形式）
- Produces: `bun run verify:semantic [binary]`。Markdown の表を出し、失敗があれば終了コード 1。

- [ ] **Step 1: スクリプトを書く**

`packages/mcp-server/scripts/verify-semantic.ts`:

```ts
/**
 * End-to-end check of search_vault_smart against the live plugin index.
 *
 * Launches the MCP server over stdio like Claude Desktop does, writes one note
 * per path pattern from CLAUDE.md (each on its own topic), waits for the
 * plugin's incremental update, then checks that a paraphrased query finds it,
 * that folder filters work with spaces, Japanese and nesting, that limit is
 * validated, and that edits and deletions reach the index. The index must
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
```

- [ ] **Step 2: package.json に script を足す**

`packages/mcp-server/package.json` の `"verify:paths"` の行の後に追加:

```json
    "verify:semantic": "bun scripts/verify-semantic.ts",
```

- [ ] **Step 3: 型チェック**

Run: `cd packages/mcp-server && bun run check`
Expected: エラーなし（実行は Task 14 で行う。索引がまだ無いので）

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/scripts/verify-semantic.ts packages/mcp-server/package.json
git commit -m "test: add an end-to-end check for semantic search" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 実機に配置して確かめる

利用者の操作が要る手順がある（API キーの入力、Obsidian と Claude Desktop の再起動）。その手順では作業を止めて利用者に頼み、結果を待つ。**API キーを代わりに入力しない。**

**Files:** なし（配置と確認だけ。記録は Task 15 の報告にまとめる）

- [ ] **Step 1: ビルド**

Run:
```bash
cd packages/obsidian-plugin && GITHUB_DOWNLOAD_URL="https://github.com/jacksteamdev/obsidian-mcp-tools/releases/download/0.2.33" GITHUB_REF_NAME="0.2.33" bun run build
cd ../mcp-server && bun run build:windows
```
Expected: どちらも成功。リポジトリ直下に `main.js`、`packages/mcp-server/dist/mcp-server-windows.exe`。

- [ ] **Step 2: vault に配置する**

vault のプラグインフォルダは `C:\GitHub\MyObsidianVault\.obsidian\plugins\mcp-tools\`（symlink ではなく実ファイル）。サーバの exe は Claude Desktop やこのセッションの MCP 接続が掴んでいてコピーで上書きできないので、先に名前を変える（Windows は実行中の exe の改名を許す）。

```bash
P=/c/GitHub/MyObsidianVault/.obsidian/plugins/mcp-tools
cp main.js manifest.json "$P/"
rm -f "$P/bin/mcp-server.old.exe"
mv "$P/bin/mcp-server.exe" "$P/bin/mcp-server.old.exe"
cp packages/mcp-server/dist/mcp-server-windows.exe "$P/bin/mcp-server.exe"
```

（リポジトリ直下で実行する。前回の `mcp-server.old.exe` がまだ実行中で `rm` に失敗したら、それを掴んでいる Claude Desktop / Claude Code を閉じてからやり直す）

- [ ] **Step 3: 利用者に頼む（ここで止まる）**

利用者に次を依頼し、終わったと言われるまで待つ:
1. Obsidian で MCP Tools プラグインを無効化 → 有効化する（または Obsidian を再起動）。
2. 設定 → MCP Tools → Semantic search で、Provider を Cohere にし、API key 欄で新しいシークレットを作って Cohere のキーを入れる。Model は `embed-v5.0-fast`、Dimension は 1024 のまま Save。
3. 「Test connection」で `OK: 1024 dimensions` が出ることを確かめる。
4. 「Estimate」の数字を控える。
5. 「Build index」を押し、ダイアログで Start。完了（State: Ready）までの所要時間と、Tokens の値を控える。
6. Claude Desktop を再起動する（新しい MCP サーバを読ませるため）。

- [ ] **Step 4: 既存の実機検証が壊れていないことを確かめる**

Run: `cd packages/mcp-server && bun run verify:paths`
Expected: 179/179 PASS（`show_file_in_obsidian` を使うので Obsidian にテストファイルのタブが残る）。

- [ ] **Step 5: 意味検索の実機検証**

Run: `cd packages/mcp-server && bun run verify:semantic`
Expected: すべて PASS。各パターンの `paraphrase finds it (… ms)` に 1 回の検索の所要時間が出る。FAIL があれば、その行の detail と Obsidian のコンソール（Ctrl+Shift+I）のログ（`Semantic search` の `embedMs` / `searchMs`）を見て原因を切り分ける。superpowers:systematic-debugging を使う。

- [ ] **Step 6: 再起動しても埋め込み直さないことを確かめる**

利用者に Obsidian の再起動を頼む。再起動後、設定画面で State が Ready、Tokens の total が再起動前と同じ（増えていない）ことを確かめてもらう。増えていたら、`startupSync` が全ノートを埋め込み直している（`mtime` / `size` の照合か shard の読み込みの不具合）ので、Task 6・8 に戻って調べる。

- [ ] **Step 7: 記録**

所要時間、チャンク数、トークン数、`verify:semantic` の結果、検索 1 回の所要時間を、Task 15 の報告のためにメモしておく（コミットはしない）。

---

### Task 15: 評価と報告

**Files:**
- Modify: `packages/mcp-server/scripts/eval-semantic.ts`（`pool` と `score` を足す）

**Interfaces:**
- Consumes: Task 1 の `Capture` 形式、`QUERIES`、`vaultRoot`
- Produces: `bun run eval:semantic pool <labelA> <labelB>` が `<vault>/_mcp-tools-eval/judgments.md` を書く。`bun run eval:semantic score <labelA> <labelB>` が表を出す。

- [ ] **Step 1: pool と score を足す**

`packages/mcp-server/scripts/eval-semantic.ts` の import を次にする:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
```

先頭のドキュメントコメントの usage に 2 行足す:

```ts
 *   bun scripts/eval-semantic.ts pool <labelA> <labelB>    write a judging note into the vault
 *   bun scripts/eval-semantic.ts score <labelA> <labelB>   read the ticks and print metrics
```

`capture` 関数の後に追加:

```ts
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
```

末尾のコマンド分岐を次に置き換える:

```ts
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
```

- [ ] **Step 2: 新しい索引で記録する**

Run: `cd packages/mcp-server && bun run eval:semantic capture cohere-embed-v5-fast`
Expected: 10 行すべて `OK`。

- [ ] **Step 3: 判定用ノートを作る前に除外フォルダを足してもらう（ここで止まる）**

利用者に、設定 → Semantic search の Excluded folders に `_mcp-tools-eval/` を足して Save してもらう（判定用ノートが全部の検索語に当たってしまうのを防ぐ）。済んだら:

Run: `cd packages/mcp-server && bun run eval:semantic pool smart-connections cohere-embed-v5-fast`
Expected: `wrote C:\GitHub\MyObsidianVault\_mcp-tools-eval\judgments.md`

- [ ] **Step 4: 利用者に判定を頼む（ここで止まる）**

利用者に Obsidian で `_mcp-tools-eval/judgments.md` を開き、検索語ごとに関連するノートにチェックを付けてもらう。リンクから中身を開いて確かめられる。終わったと言われるまで待つ。

- [ ] **Step 5: 集計する**

Run: `cd packages/mcp-server && bun run eval:semantic score smart-connections cohere-embed-v5-fast`
Expected: 検索語ごとの表と平均の行。

- [ ] **Step 6: 報告する**

利用者に次をまとめて伝える（会話の中で。結果ファイルの中身やノート本文は貼らない）:
- 集計の表（上位 10 / 20 の関連ノート数、最初の関連ノートの順位、相対再現率、応答の文字数）と、どちらが良いかの読み取り。
- 固有名詞（`sutimlimab`、`UBA1`、`IPSS-M`、`HemeSight`）を含む検索語で取りこぼしが目立つか。目立つなら spec の「将来の拡張」にあるキーワード検索との併用を次の課題として提案する。
- 応答の文字数が大きすぎる検索語があるか。あれば節の上限文字数を下げる案。
- Task 14 で控えた所要時間・チャンク数・トークン数・検索 1 回の所要時間。

- [ ] **Step 7: 後片付けと Commit**

利用者に確認を取ってから、`C:\GitHub\MyObsidianVault\_mcp-tools-eval\` を消し、除外フォルダから `_mcp-tools-eval/` を外してもらう。

```bash
git add packages/mcp-server/scripts/eval-semantic.ts
git commit -m "chore: add pooled judging and scoring to the semantic search evaluation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

その後、superpowers:finishing-a-development-branch に従って `feat/semantic-search` の統合方法を利用者と決める。
