# 意味検索の自前実装（Smart Connections 依存の撤去）設計

- 日付: 2026-10-03
- ブランチ: `feat/semantic-search`
- 状態: 設計承認済み、実装計画は未作成

## 背景と目的

`search_vault_smart` は現在、プラグインの `POST /search/smart` が Smart Connections の `smart_sources.lookup()` を呼んでいるだけで、検索の中身はすべて Smart Connections 側にある。Smart Connections で任意の埋め込みモデル（API）を使うには Pro（年 299 ドル）が必要で、無料で使えるローカルモデル（現在は `Xenova/multilingual-e5-small`）では日本語の意味検索がまだ弱い。

目的は、`search_vault_smart` を Smart Connections から切り離し、本プラグインが自前で埋め込みの索引を作って検索すること。埋め込みモデルは設定で差し替えられるようにする。当面は Cohere `embed-v5.0-fast` を使い、より良いモデルが出たら乗り換える。

成功の基準: Claude から日本語で問い合わせたとき、意味の近いノートの該当節が返ること。Smart Connections（e5-small）の現在の結果と並べて、本人が良いと判断できること。

## 決定事項

| 論点 | 決定 |
|---|---|
| 範囲 | MCP の `search_vault_smart` の裏側だけを置き換える。Obsidian 内の UI（関連ノートのサイドバー等）は作らない。Smart Connections を呼ぶコードは消す。Smart Connections 本体を vault に残すかは利用者の自由で、互いに干渉しない |
| 接続方式 | Cohere 専用の接続と、OpenAI 互換の `/v1/embeddings`（OpenAI、Ollama、LM Studio、Gemini の互換エンドポイント等）の 2 つ。内部は「文書用」と「検索語用」を区別する共通の口にし、後から接続方式を足せるようにする |
| 結果の単位 | 見出しごと（節ごと）。1 ノートから返す節は既定 2 件まで（`filter.maxPerNote`、1〜50）。上限なしだと 1 つの長いノートの節が上位を埋め、ほかの関連ノートが押し出された（2026-10-03 の評価で追加） |
| 索引を作る場所 | Obsidian プラグインの中（A 案）。MCP サーバ側は窓口のまま |
| `limit` | 1〜50 の整数、既定 20（/learn のサブエージェントが実際に 20 で呼んでいるため）。範囲外は引数検証エラーとして `isError` で理由を返す |

## 非目標

- Obsidian 内の UI（関連ノート表示、検索ビュー）
- Smart Connections との切り替え・併用
- 近似最近傍探索（ANN）、ベクトル DB
- 前のモデルのベクトルを残しておくこと（モデルを変えたら捨てて作り直す）
- ノート全体の埋め込み（節ごとだけにする）
- キーワード検索との併用（ハイブリッド検索）、リランキング

## 構成

```
Claude ─ search_vault_smart ─▶ MCP サーバ ─ POST /search/smart ─▶ プラグイン（Obsidian 内）
                                                                  ├ 検索語を埋め込む（プロバイダ）
                                                                  └ 索引から上位 k 件 → { results, index }
Obsidian のファイル変更 ─▶ プラグイン：索引器 ─▶ 見出しで分割 ─▶ プロバイダ ─▶ 索引（shard ファイル）
```

プラグインに `packages/obsidian-plugin/src/features/semantic-search/` を新設する。

| 部品 | 役割 | Obsidian への依存 |
|---|---|---|
| `providers/types.ts` | 共通の口 `embed(texts: string[], kind: "document" \| "query") → { vectors: Float32Array[], tokens: number }`、1 回に送れる件数、モデルの識別子 | なし |
| `providers/cohere.ts` | Cohere `POST https://api.cohere.com/v2/embed` | なし（HTTP 関数を外から受け取る） |
| `providers/openaiCompatible.ts` | `POST {baseUrl}/embeddings` | なし（同上） |
| `chunker.ts` | 本文と見出し一覧から節のチャンクを作る | なし |
| `indexStore.ts` | shard の読み書き、ノート単位の差し替え・削除、内積による上位 k 件 | なし（読み書きの関数を外から受け取る） |
| `plan.ts` | 索引の記録と vault の状態から「埋め込む / 使い回す / 消す」を決める | なし |
| `indexer.ts` | 起動時の照合、ファイル変更の受け取り、待ち行列、まとめての埋め込み、保存の予約 | あり |
| `index.ts` | `setup()`、`/search/smart` の処理、設定画面の組み込み | あり |
| `components/SemanticSearchSettings.svelte` | 設定画面 | あり |

- HTTP は Obsidian の `requestUrl` で送る（レンダラ内の `fetch` だと CORS で止まりうるため）。`requestUrl` を受け取る形にして、「なし」の部品は Obsidian なしで `bun test` できるようにする。
- ハッシュは、shard の振り分けに FNV-1a 32bit（パス文字列から）、本文と送る文字列に SHA-256（`crypto.subtle`）を使う。

## 索引の作り方

### 対象

- `app.vault.getMarkdownFiles()` のうち、設定の除外フォルダ（パスの先頭一致）に当たらないもの。ドットで始まるフォルダは Obsidian が扱わないので対象外になる。
- 除外したノートは API に一切送らない。除外設定を変えたら、該当ノートを索引から外す・足すだけで全体は作り直さない。

### 分割の規則（`chunker.ts`）

入力は本文と、`metadataCache.getFileCache(file)` の `headings`（見出しの文字列・レベル・開始行）と `frontmatterPosition`。コードブロック内の `#` 行を見出しと誤認しないよう、見出しは自前で解析せず metadataCache のものを使う。

1. frontmatter を除く。
2. 見出しの行から次の見出し（深さを問わない）の直前までを 1 つの節とする。最初の見出しより前の本文は、ノート名だけを breadcrumbs に持つ節とする。見出しの無いノートは全体が 1 つの節になる。
3. 本文（見出しの行を除いた部分）が空白だけの節は埋め込まない。
4. 節の文字数が上限（設定、既定 4000）を超えたら、空行（段落の切れ目）で分けて、各部分が上限以下になるように詰める。1 段落だけで上限を超えるときは上限の位置で切る。2 つ目以降の部分は見出しの行を含まない。どの部分にも同じ breadcrumbs を付ける。
5. breadcrumbs は `ノート名 > H1 > H2 …`（ノート名は拡張子を除いたファイル名）。
6. API に送る文字列は `breadcrumbs + "\n\n" + 節の本文`。ノート名を含むので、名前を変えたノートは埋め込み直しになる。
7. frontmatter だけのノートや空のノートはチャンク 0 個として記録する（失敗扱いにしない）。

分割規則を変えたときは `CHUNKER_VERSION` を上げ、モデルの識別子に含めて全体を作り直させる。

### 差分更新

- ノートごとに `mtime`・`size`・本文の SHA-256 を記録する。
- 起動時は `metadataCache` の初回解析完了（`resolved`）を待ってから vault と照合する（`plan.ts`）。
  - `mtime` と `size` が同じ → 何もしない。
  - 違うが本文のハッシュが同じ → 記録だけ更新する。
  - ハッシュが違う → 分割し直す。送る文字列のハッシュが前回と同じチャンクは前のベクトルを使い回し、変わったチャンクだけ埋め込む。
  - 索引にあって vault に無い → 索引から消す。
- 実行中は次のイベントで変更のあったパスを待ち行列に入れる。最後のイベントから 10 秒たったらまとめて処理する。
  - `metadataCache.on("changed")`（見出しの解析が済んだ後に来る。作成もこれで拾う）
  - `vault.on("delete")`
  - `vault.on("rename")`（古いパスを消し、新しいパスを入れる）
- API 呼び出しは同時に 1 本だけ送る。1 回にまとめる件数は Cohere が 96、OpenAI 互換は設定（既定 64）。
- ノートの索引は、そのノートのチャンクがすべて埋め込めてから差し替える。半端な状態は残さない。
- 索引が一度も作られていないとき（未作成）と停止中は、イベントを受けても何も送らない。停止中に受けた変更は、再開時の照合で拾う。

### 状態

`unconfigured`（未設定）/ `empty`（未作成）/ `building`（作成中）/ `paused`（停止中、理由付き）/ `ready`（完了）。

- 全体の作成（初回・作り直し・中断からの再開）の間は `building`。作成が終わったら `ready`。`ready` の間の差分更新では状態を変えない。
- 中止ボタン、API キー不正、一時的な失敗が続いたときは `paused`。
- 作成中に Obsidian が終了した場合は、次の起動時に自動で再開する。中止ボタンで止めた場合は、利用者が「索引を作成」を押すまで再開しない。

### モデルを変えたときの作り直し

モデルの識別子は次の値を JSON にした文字列（ハッシュにせず読める形で持つ）。

```json
{ "provider": "cohere", "model": "embed-v5.0-fast", "dimension": 1024,
  "queryPrefix": "", "documentPrefix": "", "maxChunkChars": 4000, "chunkerVersion": 1 }
```

Base URL は含めない（同じモデルを別のホストから呼んでもベクトルは同じ）。読み込み時に設定の識別子と索引の識別子が一致しなければ、索引を捨てる。設定画面で確認を取ってから作り直すので、通常は不一致の索引が残ることはない。

### 最初の索引作りは自動では始めない

有効化や設定だけでは vault を送らない。設定画面の「索引を作成」を押したときに始める。以後の差分更新は自動。作り直しも確認を挟む。

### API が失敗したとき（索引作り）

| 応答 | 扱い |
|---|---|
| 401 / 403 | 索引作りを止めて `paused`（理由: API キー不正）。Notice を 1 回だけ出す。設定を保存するか「索引を作成」を押すまで再開しない |
| 429 / 5xx / 通信エラー | `Retry-After` があれば従い、無ければ 2・8・30 秒の間隔で再試行。それでも失敗したら待ち行列を保ったまま `paused`（理由: 一時的な失敗）にし、5 分後に自動で再開する |
| 400 | まとめて送った中のどれが原因か分からないので、そのバッチをノート単位で送り直す。それでも 400 になるノートは「失敗」として理由と一緒に記録し、次に更新されるまで再送しない |

使ったトークン数を積算する（Cohere は `meta.billed_units.input_tokens`、OpenAI 互換は `usage.prompt_tokens` か `usage.total_tokens`）。今回の作成分と、索引を作ってからの累計を持つ。

## 保存形式

`.obsidian/plugins/mcp-tools/semantic-index/` に置く（vault の `.gitignore` で `.obsidian/` ごと除外されている）。

```
semantic-index/
  manifest.json        形式の版、モデルの識別子、shard 数、作成の状態（running / cancelled / completed）、
                       完了日時、使ったトークン数（今回の作成分・累計）
  shard-00.bin … shard-31.bin
```

- shard はパスの FNV-1a 32bit を 32 で割った余りで決める。
- shard ファイルの形式（すべてリトルエンディアン）:

  | バイト | 内容 |
  |---|---|
  | 0–7 | ASCII `MCPIDX01` |
  | 8–11 | JSON 部分のバイト長（u32） |
  | 12– | JSON（UTF-8）: `{ formatVersion, fingerprint, dimension, shard, notes: { [path]: { mtime, size, hash, status: "ok" \| "failed", error?, chunks: [{ breadcrumbs, text, textHash, slot }] } } }` |
  | その後 | 4 バイト境界までのゼロ埋め |
  | その後 | Float32 のベクトル。`slot × dimension` の位置から `dimension` 個 |

- ベクトルは保存前に長さ 1 に正規化する（検索は内積だけで済む）。
- 保存は一時ファイルに書いてから名前を変える。保存するのは変更のあった shard と `manifest.json` だけ。保存のたびに未使用の slot を詰める。
- 保存のタイミング: 変更から 30 秒後、全体の作成が終わったとき、プラグインを止めるとき。落ちて失うのは最大 30 秒分で、次の起動時の照合で埋め込み直される。
- 読み込み時、shard の `fingerprint` が `manifest.json` と食い違う、または壊れている shard があれば、その shard のノートを未索引として扱い、照合で埋め込み直す。`manifest.json` の識別子が設定と食い違えば全体を捨てる。
- 起動時に全 shard をメモリに読み込む。

### 大きさの見込み（2026-10-03 の vault: 約 1,800 ノート、見出し約 18,000）

約 2 万チャンク。既定の 1024 次元でベクトル約 80 MB、JSON 約 15 MB。Bun での計測では、2 万 × 1024 の総当たりが 17 ms、10 倍の 20 万チャンクで 194 ms。ノートが増えたときに先に問題になるのはメモリ（10 倍で約 800 MB）なので、そうなったら次元を 512 に下げるか int8 量子化を入れる。形式の版を持っているので後から移行できる。今回は実装しない。

## 検索（`POST /search/smart`）

### リクエスト

`{ query: string, filter?: { folders?: string[], excludeFolders?: string[], limit?: number, maxPerNote?: number } }`。MCP サーバは本文を JSON 文字列で送るので、プラグインは今の `jsonSearchRequest` と同じく文字列を JSON として解析してから検証する。`limit` は 1〜50 の整数、既定 20。不正なら 400。

### 手順

1. 状態が `unconfigured` なら 503、索引にチャンクが 1 つも無ければ 503。
2. 検索語を `kind: "query"` で埋め込む。失敗したら 502（本文にプロバイダの応答の要約。再試行はしない）。
3. 全チャンクと内積を取る。`folders` があればそのどれかで始まるパスだけ、`excludeFolders` のどれかで始まるパスは除く。
4. 点数の高い順に、1 ノートあたり `maxPerNote` 件（既定 2）までに抑えながら `limit` 件を返す。

所要時間（埋め込みと総当たりのそれぞれ）をログに出す。

### 応答

```json
{
  "results": [
    { "path": "Daily log/2026-09-03.md", "text": "## 個人/家族\n…", "score": 0.61,
      "breadcrumbs": "2026-09-03 > 📝 本日の振り返り（事実） > 個人/家族" }
  ],
  "index": { "state": "ready", "indexedNotes": 1790, "totalNotes": 1803, "failedNotes": 0,
             "model": "cohere/embed-v5.0-fast@1024" }
}
```

- `path` はファイルのパスだけ（Smart Connections のような `#見出し` は付けない）。
- `text` は保存したチャンクの本文（見出しの行を含む。最大で約 `maxChunkChars` 字）。
- `breadcrumbs` は API に送ったときの前置きと同じ文字列。

### 状態ごとの応答

| 状態 | 応答 |
|---|---|
| `unconfigured` | 503「意味検索が未設定です。Obsidian の MCP Tools 設定で埋め込みモデルを設定してください」 |
| `empty`、または作成中でチャンクがまだ 0 | 503「索引にまだ何も入っていません。未作成なら Obsidian の MCP Tools 設定で『索引を作成』を押してください（作成中なら、少し待ってから再度検索してください）」 |
| `building` / `paused` | できている分で検索して返す（検索語の埋め込みが失敗すれば 502） |
| `ready` | そのまま返す |

## 設定

既存の設定タブ（`features/core/components/SettingsTab.svelte`）に「Semantic search」の欄を足す。設定値は `data.json` の `semanticSearch` に保存する。

```ts
semanticSearch: {
  provider: "cohere" | "openai-compatible";
  cohere: { model: string; dimension: 256 | 512 | 768 | 1024 | 1536 | 2048; apiKeySecretId: string };
  openaiCompatible: { baseUrl: string; model: string; dimensions?: number; apiKeySecretId?: string;
                      queryPrefix: string; documentPrefix: string; batchSize: number };
  excludeFolders: string[];
  maxChunkChars: number;
}
```

### API キー

- キーの実体は `app.secretStorage`（Obsidian 1.11.4 以降）に置き、`data.json` には ID だけを書く。入力欄は Obsidian の `SecretComponent`。
- `manifest.json` の `minAppVersion` を `1.11.4` に上げる（このマシンの Obsidian は 1.13.7）。
- MCP サーバ側には埋め込みのキーを渡さない。

### 設定項目

| 項目 | Cohere | OpenAI 互換 | 変えたら作り直し |
|---|---|---|---|
| プロバイダ | ○ | ○ | ○ |
| API キー（SecretStorage） | 必須 | 任意 | — |
| Base URL | 固定 `https://api.cohere.com` | 必須（例 `http://localhost:11434/v1`） | — |
| モデル | 既定 `embed-v5.0-fast` | 必須 | ○ |
| 次元 | 256〜2048 から選ぶ、既定 1024 | 任意（指定したときだけ `dimensions` を送る） | ○ |
| 検索語用 / 文書用の前置き文字列 | —（`input_type` で区別） | 任意（e5 系なら `query: ` / `passage: `） | ○ |
| 1 回に送る件数 | 96 固定 | 既定 64 | — |
| 除外フォルダ | 1 行 1 つ、先頭一致 | 同左 | 差分だけ反映 |
| 節の上限文字数 | 既定 4000 | 同左 | ○ |

### プロバイダごとの送り方

- Cohere: `{ model, texts, input_type: "search_document" | "search_query", embedding_types: ["float"], output_dimension, truncate: "END" }`。応答の `embeddings.float` を使う。
- OpenAI 互換: `{ model, input, encoding_format: "float", dimensions? }`。`input` の各要素に前置き文字列を付ける。応答の `data` を `index` で並べ直して使う。

### 保存と作り直しの流れ

- フォームの変更は下書きとして持ち、「保存」で反映する。
- 「変えたら作り直し」の項目が変わっていれば、保存の前に確認ダイアログを出す（見積もり: 対象ノート数・チャンク数・文字数）。取り消したら下書きを捨てる。確定したら今の索引を捨てて作り直しを始める。
- それ以外の項目はそのまま反映する。

### 状態の表示と操作

- 表示: 状態（未設定 / 未作成 / 作成中 `n / N ノート` / 完了 / 停止中と理由）、モデル、チャンク数、最終更新日時、使ったトークン数（今回の作成分・累計）、失敗したノートの数（開くとパスと理由の一覧）。
- ボタン:
  - 接続テスト: `"test"` を 1 件埋め込み、返った次元と所要時間を表示する。
  - 見積もり: API は呼ばず、手元で分割して数える。
  - 索引を作成（作成済みなら「作り直す」。停止中なら続きから）。
  - 中止（作成中だけ）: 埋め込んだ分は保存する。

## MCP サーバ側の変更

- `features/smart-connections/` を `features/semantic-search/` に、`registerSmartConnectionsTools` を `registerSemanticSearchTools` に改名。`features/core/index.ts` の登録を差し替える。
- ツール名 `search_vault_smart` と引数の形は変えない。`filter.limit` の型を `1 <= number.integer <= 50` にする。
- 説明文（案）: "Semantic search over the vault using the embedding index built by the MCP Tools Obsidian plugin (the embedding provider and model are configured in the plugin settings). Finds sections whose meaning is close to the query even when they share no words with it. Results are per heading section, so one note can appear more than once. Returns { results: [{ path, text, score, breadcrumbs }], index }, where text is the section body and breadcrumbs is 'note > heading > subheading'. limit defaults to 20, max 50. For exact words or phrases use search_vault_simple."
- `index.state` が `ready` でなければ、結果の先頭に 1 行付ける: `Index is still building (1200/1803 notes); results may be incomplete.`（`paused` なら `Index is paused (<理由>); results may be incomplete.`）
- 503 / 502 は既存の `describeHttpError` が本文ごと `isError` の理由にするので、追加の処理は不要。
- `describeApiError.ts` のタイムアウト文言の "Templater/Smart Connections operation" を "Templater or semantic search operation" に直す。

## 撤去するもの

- `packages/shared/src/types/plugin-smart-connections.ts` と `types/index.ts` の `SmartConnections` の export。
- `packages/shared/src/types/smart-search.ts` の `searchParameters`（Smart Connections の filter 形式への変換）。`jsonSearchRequest` と `SearchResponse` は新しい形（`limit` の制限、`index`）に書き換えて残す。
- `packages/shared/src/types/plugin-local-rest-api.ts` の `ApiSmartSearchResponse` に `index` を足す。
- `packages/obsidian-plugin/src/shared/index.ts` の `loadSmartSearchAPI` と `Dependencies["smart-connections"]`。`loadDependencies()` の一覧の `"smart-connections"` と `merge()` 内の `loadSmartSearchAPI(plugin)` も消す。これで設定画面の Dependencies 欄から「Smart Connections is installed」の行が消え、Local REST API と Templater の 2 行になる。意味検索の状態は Dependencies 欄ではなく、新しい「Semantic search」欄に出す。
- `packages/obsidian-plugin/src/features/mcp-server-install/types.ts` の `smart-connections` の型宣言。
- `main.ts` の `handleSearchRequest`（`features/semantic-search/` に移して書き直す）。
- 文書: `README.md`（48 行目、229 行目の脚注）、`packages/mcp-server/README.md`、`packages/obsidian-plugin/README.md`、`docs/features/mcp-server-install.md`、`CLAUDE.md`（構成・ツール一覧・`minAppVersion` の記述）。

## テスト

`packages/obsidian-plugin` に `test` スクリプト（`bun test`）を新設する。Obsidian に依存しない部品だけを対象にする。

| 対象 | 確かめること |
|---|---|
| `chunker` | frontmatter を除く、最初の見出しより前の本文、見出しの無いノート、本文が空の見出しを飛ばす、上限超えを段落で分ける、1 段落が上限超え、breadcrumbs、絵文字・全角括弧・`/` を含む見出し、frontmatter だけのノート |
| `indexStore` | shard の振り分けが安定していること、ノートの追加・差し替え・削除、slot を詰めること、保存→読み込みの往復、識別子の不一致・壊れた shard の検出、フォルダ絞り込み付きの上位 k 件、正規化 |
| `plan` | 「何もしない / 記録だけ更新 / 一部のチャンクだけ埋め込む / 消す」の判定、除外フォルダの変更 |
| `providers` | スタブの HTTP 関数で、送る中身（`input_type`、96 件ずつの分割、`dimensions` は指定時のみ、前置き文字列、`index` での並べ直し）、トークン数の取り出し、401 / 429（`Retry-After`）/ 400 / 5xx の分類 |

MCP サーバ側: `limit` の範囲外が引数検証エラーになること、`index.state` に応じた警告行。既存のテスト（110 件中、上流から引き継いだ 4 件が失敗）を悪化させない。`bun run check` が通ること。

## 実機確認

1. **切り替え前の記録**: 下の「評価用の検索語」10 個を、Smart Connections を外す前の現行 `/search/smart` に `limit: 20` で投げ、結果を JSON で保存する。スクリプトで直接ファイルに書き、会話のコンテキストには読み込まない。保存先はスクラッチ領域で、個人のノート本文を含むためリポジトリには入れない。
2. ビルドして vault に配置し、設定画面で接続テスト → 見積もり → 索引の作成。所要時間・チャンク数・使ったトークン数を記録する。
3. **プーリング方式で判定する**: 同じ 10 個を新しい索引に同じ条件で投げる。検索語ごとに両方式の上位 20 件の和集合（`path` と `breadcrumbs`。方式名と順位は伏せる）を、チェックボックス付きのノートとして vault の `_mcp-tools-eval/` に書き出す。このフォルダは新しい索引の除外フォルダに入れる（入れないと、このノートがすべての検索語に当たる）。利用者が関連するものにチェックを付け、スクリプトがそれを読んで方式ごと・検索語ごとに集計する。
   - 上位 10 件・上位 20 件に入った関連ノートの数
   - 最初の関連ノートの順位
   - 和集合の関連ノートのうち見つけた割合（相対再現率）
   - 応答の大きさ（`text` の合計文字数）。重すぎれば節の上限文字数を下げる
   
   評価が終わったら `_mcp-tools-eval/` を消す。固有名詞（`sutimlimab`、`UBA1`、`IPSS-M` など）の取りこぼしが目立つ場合は、「将来の拡張」のキーワード検索との併用を次の課題にする。
4. `packages/mcp-server/scripts/verify-semantic.ts`（`bun run verify:semantic`）。`verify:paths` と同じく MCP のバイナリを stdio で起動し、次を確かめる。
   - CLAUDE.md の 5 パターン（ルート直下、ASCII、スペース、日本語、3 階層以上）にテスト用ノートを作る。ノートごとに固有の話題の本文にする。
   - 差分更新を待ち（検索して当たるまでポーリング、上限 60 秒）、言い換えた検索語で該当ノートが当たること。
   - `folders` / `excludeFolders` で絞り込めること（スペース・日本語・入れ子を含むパス）。
   - `limit: 0` / `51` / `2.5` が `isError` になること。
   - ノートを更新すると結果の本文が変わり、消すと結果から消えること。
   - 後片付けは `verify:paths` と同じ（作ったノートを消し、空ディレクトリはディスク上で消す）。
5. Obsidian を再起動して、埋め込みをやり直さずに shard から読み込まれること（使ったトークン数の累計が増えないこと）。
6. ログで 1 回の検索の所要時間（埋め込み・総当たり）を確認する。

### 評価用の検索語

Claude Code での実際の運用（/learn）で、vault を横断検索するサブエージェントが投げていたもの。日本語と英語が混ざった、キーワードを並べた形が多い。

1. `inotuzumab ozogamicin CD22 抗体薬物複合体 B-ALL 再発難治`
2. `"脂質異常症の管理（LDL/TG/HDL目標・一次/二次予防・食事・薬物療法）＋血液内科領域の薬剤性脂質異常"`
3. `VEXAS症候群の治療 UBA1 JAK阻害薬 アザシチジン 同種移植`
4. `眼内悪性リンパ腫 硝子体網膜リンパ腫 治療 メトトレキサート硝子体内注射`
5. `中枢神経系原発リンパ腫 PCNSL 大量メトトレキサート 全脳照射 治療`
6. `MDS 骨髄異形成症候群 遺伝子変異 予後予測 IPSS-M IPSS-R`
7. `遺伝子パネル検査 HemeSight 造血器腫瘍 腫瘍正常ペア解析 VUS germline`
8. `寒冷凝集素症 cold agglutinin disease 自己免疫性溶血性貧血`
9. `溶血性貧血 直接クームス試験 補体 C1s sutimlimab rituximab`
10. `濾胞性リンパ腫 DLBCL 形質転換 transformed follicular lymphoma 予後`

## 将来の拡張（今回はやらない）

- 次元を下げる・int8 量子化（ノート数が大きく増えたとき）
- 短い節を親の節に吸収する閾値（実機の検索結果を見て必要なら。分割規則の版を上げれば作り直せる）
- Cohere Rerank などでの並べ直し、キーワード検索との併用
- Voyage、Gemini などの専用接続

## 参考: Smart Connections 4.7.2 の作り（2026-10-03 調査）

vault にインストールされた `main.js` と `.smart-env/` の実データから確認した。

- ノート全体（smart_sources）と見出しブロック（smart_blocks）の 2 種類を埋め込み、検索時に混ぜて並べる。
- ノート全体の埋め込みは `Folder > note:` + 本文を `max_tokens × 3.7` 文字で切り、さらに 512 トークンで切る。日本語では実質的に冒頭数百字しか効かない。
- ブロックは `Folder > note > 親見出し` + 本文。`min_chars`（この vault では 200）未満のブロックは単独では埋め込まず、親か子のどちらを埋め込むかを失う文字数で選ぶ。e5 で埋め込まれたブロックは約 8,300 個で、見出し総数（約 18,000）の半分以下だった。
- モデルごとに検索語・文書の前置き文字列を持つ（e5 は `query: ` / `passage: `）。
- 検索は全件の総当たり（cos 類似度を毎回計算）。ANN は使っていない。
- ベクトルはモデルの識別子（プロバイダ・モデル・次元・最大トークン数）ごとの生の Float32 ファイル、メタ情報は追記型の `.ajson`。モデルを変えても前のベクトルを残す。
