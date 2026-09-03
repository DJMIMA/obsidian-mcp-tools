# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このフォークの位置づけ

- 上流 `jacksteamdev/obsidian-mcp-tools` は archive 済み（README 冒頭に告知あり）。このリポジトリは個人フォークで、メンテは自分ひとり。
- 上流への PR、上流との同期は行わない。CONTRIBUTING.md / SECURITY.md / `.github/` のテンプレート類は上流の遺物で、この fork の運用には関係ない。
- 優先順位は「自分の vault で動くこと」。互換性や汎用性より、実機で通ることを優先する。
- 注意: `git remote origin` は現在も `https://github.com/jacksteamdev/obsidian-mcp-tools.git` を指している。`scripts/version.ts` は `git push` まで自動で行うので、リリース系スクリプトを使う前に remote を自分のリポジトリへ向け直すこと。

## アーキテクチャ

Bun workspace のモノレポ。`packages/test-site` は SvelteKit のサイトで、プラグイン/サーバの動作には無関係。

### 2 つのコンポーネントと通信経路

| コンポーネント | エントリポイント | 成果物 |
|---|---|---|
| Obsidian プラグイン | `packages/obsidian-plugin/src/main.ts` (`McpToolsPlugin`) | `bun.config.ts` がリポジトリ直下に `main.js` を出力（`outdir: "../.."`, cjs, `obsidian` 等は external）。`manifest.json` もリポジトリ直下 |
| MCP サーバ | `packages/mcp-server/src/index.ts` → `features/core/index.ts` (`ObsidianMcpServer`) | `bun build --compile` で単一バイナリ (`dist/mcp-server-{windows,linux,macos-arm64,macos-x64}`)。stdio transport |
| 共有 | `packages/shared/src/` | arktype スキーマ（Local REST API のレスポンス型、prompt 型）、ファイルロガー |

プラグインとサーバは**直接通信しない**。プラグインがサーバを子プロセスとして起動することもない。

1. プラグインの設定画面 (`features/mcp-server-install/components/McpServerInstallSettings.svelte`) の「Install Server」が、`services/install.ts` でバイナリを GitHub Releases からダウンロードして `{vault}/.obsidian/plugins/mcp-tools/bin/mcp-server.exe`（Windows。`constants/index.ts` の `BINARY_NAME`）へ置く。ダウンロード URL は `constants/bundle-time.ts` のマクロで**ビルド時に埋め込まれる** `GITHUB_DOWNLOAD_URL`（= `https://github.com/jacksteamdev/obsidian-mcp-tools/releases/download/<version>`、`bun.config.ts` の `define`）。つまりこの fork をそのままビルドしても「Install Server」は上流の archive 済みリリースを取りに行く。fork では自前ビルドのバイナリを手で置く運用になる（後述）。
2. 同じ流れで `services/config.ts` が Claude Desktop の設定ファイル（Windows: `%APPDATA%\Claude\claude_desktop_config.json`）に `mcpServers["obsidian-mcp-tools"] = { command: <バイナリの絶対パス>, env: { OBSIDIAN_API_KEY } }` を書き込む。API キーは Local REST API プラグインの設定から読む (`main.ts` の `getLocalRestApiKey()` → `app.plugins.plugins["obsidian-local-rest-api"].settings.apiKey`)。
3. 実行時は Claude Desktop 等の MCP クライアントがバイナリを起動し、バイナリが HTTP(S) で Local REST API に接続する。
4. プラグイン側は Local REST API の `getAPI(...).addRoute()` で 2 本のルートを Local REST API 上に追加している (`main.ts`)：`POST /search/smart`（Smart Connections 経由の意味検索）と `POST /templates/execute`（Templater 実行）。この 2 つのエンドポイントは Local REST API 本体ではなく本プラグインが Obsidian 内で処理している。
5. `services/uninstall.ts` は Claude 設定のパスを macOS 固定 (`Library/Application Support/Claude/...`) で組んでおり `CLAUDE_CONFIG_PATH` を使っていない。Windows ではアンインストール時に設定エントリが消えない。

### Local REST API への HTTP クライアント層

クライアントは `packages/mcp-server/src/shared/makeRequest.ts` の `makeRequest(schema, path, init)` 1 本に集約されている。

- ベース URL: `${PROTOCOL}://${HOST}:${PORT}`。既定は `https://127.0.0.1:27124`。`OBSIDIAN_USE_HTTP=true` で `http://...:27123`、`OBSIDIAN_HOST` でホスト変更。
- 自己署名証明書対策で `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` をモジュール読み込み時に設定。
- ヘッダ: `Authorization: Bearer ${OBSIDIAN_API_KEY}`、`Content-Type: text/markdown` を既定で付与し、`init.headers` で上書き可能。
- URL は `` `${BASE_URL}${path}` `` の単純結合。**`makeRequest` 自体はパスのエンコードを一切行わない**。エンコードは呼び出し側（ツールごと）の責任になっている。
- 非 2xx は `McpError(InternalError, "<METHOD> <path> <status>: <body>")`。レスポンスは Content-Type が json なら `json()`、それ以外は `text()` で読み、arktype スキーマで検証。204 は `undefined`。

パス組み立ては共通化されておらず、`features/local-rest-api/index.ts` ほかでツールごとに書かれている。現状の内訳：

| 組み立て方 | 該当箇所 |
|---|---|
| パス全体を `encodeURIComponent` | `get_vault_file`, `create_vault_file`, `append_to_vault_file`, `patch_vault_file`, `delete_vault_file`（`/vault/${encodeURIComponent(args.filename)}`）、`show_file_in_obsidian`（`/open/${encodeURIComponent(args.filename)}`） |
| エンコードなし | `list_vault_files`（`/vault/${args.directory}/`）、`features/templates/index.ts`（`/vault/${args.name}`）、`features/prompts/index.ts`（`/vault/Prompts/${filename}`） |
| クエリ文字列 | `search_vault_simple` は `URLSearchParams` |

### MCP ツール定義

- 登録機構は `packages/mcp-server/src/shared/ToolRegistry.ts`。`tools.register(schema, handler)` の `schema` は arktype の `type({ name: '"tool_name"', arguments: {...} }).describe("説明")`。`name` のリテラルがツール名、`.describe()` が description、`arguments` が `toJsonSchema()` を通って inputSchema になる。つまり**入力スキーマはツール定義と同じ場所に書く**。`dispatch` は `schema.assert` で検証し、MCP クライアントが文字列で送ってくる `"true"/"false"` を boolean に矯正する。
- 登録の呼び出し元は `features/core/index.ts` の `setupHandlers()`：`registerFetchTool`, `registerLocalRestApiTools`, `registerSmartConnectionsTools`, `registerTemplaterTools`, `setupObsidianPrompts`。
- ツールの実体：
  - `features/local-rest-api/index.ts`: `get_server_info`, `get_active_file`, `update_active_file`, `append_to_active_file`, `patch_active_file`, `delete_active_file`, `show_file_in_obsidian`, `search_vault`, `search_vault_simple`, `list_vault_files`, `get_vault_file`, `create_vault_file`, `append_to_vault_file`, `patch_vault_file`, `delete_vault_file`
  - `features/smart-connections/index.ts`: `search_vault_smart`
  - `features/templates/index.ts`: `execute_template`
  - `features/fetch/index.ts`: `fetch`（Web ページ取得。Local REST API とは無関係）
  - `features/prompts/index.ts`: ツールではなく MCP prompts。vault の `Prompts/` 直下でタグ `mcp-tools-prompt` を持つ `.md` を列挙・実行する。
- レスポンス型や共有の引数型（`ApiPatchParameters`, `ApiTemplateExecutionParams` など）は `packages/shared/src/types/plugin-local-rest-api.ts`。
- PATCH 系 2 ツールは引数をそのまま送らず、`packages/mcp-server/src/shared/buildPatchInstruction.ts` で markdown-patch 2.0 の JSON instruction に変換してから送る（詳細は「既知の問題」）。

ツールを 1 つ追加・修正するとき触るファイル（依存関係から）：

1. ツール本体: 既存の `features/<feature>/index.ts`、または新規 `features/<name>/index.ts` を作って `features/core/index.ts` の `setupHandlers()` に登録を追加。
2. 新しいエンドポイントのレスポンス型が要るなら `packages/shared/src/types/plugin-local-rest-api.ts`。
3. そのエンドポイントを本プラグインが提供するもの（`/search/smart`, `/templates/execute` の類）なら `packages/obsidian-plugin/src/main.ts` のルート登録とハンドラも。
4. パスを URL に埋め込むなら後述の規約に従う。

## 既知の問題と修正方針

### サブディレクトリを含むパスで単一ファイル操作が全滅する（修正済み 2026-09-03）

症状: `get_vault_file` / `create_vault_file` / `append_to_vault_file` / `patch_vault_file` / `delete_vault_file` は vault ルート直下のファイルでは成功し、`/` を含むパス（`folder/note.md`）では失敗していた。修正前のバイナリで `GET /vault/Daily%20log%2F... 404` を実機再現済み。

修正: `packages/mcp-server/src/shared/encodeVaultPath.ts`（`/` で分割 → 各セグメントを `encodeURIComponent` → `/` で結合）を追加し、上記 5 ツール、`show_file_in_obsidian`、`list_vault_files`、`features/templates`、`features/prompts` のパス結合をすべてこれに置き換えた。`list_vault_files` は呼び出し側の末尾 `/` を落としてから 1 つ付け直す。単体テストは `encodeVaultPath.test.ts`。実機では後述の `bun run verify:paths` で 5 パターン × get/create/append/list/delete がすべて通ることを確認した（Local REST API 5.1.0）。

原因（コードで確認済み）:

- 本リポジトリ側: 上記 5 ツールは `` `/vault/${encodeURIComponent(args.filename)}` `` でパス全体をエンコードしているため、`/` が `%2F` になる (`features/local-rest-api/index.ts`)。
- Local REST API 側（上流 `coddingtonbear/obsidian-local-rest-api` main ブランチ、manifest 5.1.0、2026-09-03 確認）: `requestHandler.ts` の `extractVaultPath()` は `req.path` を**生の `/` で分割してからセグメントごとに `decodeURIComponent`** する。続く `wholeFilePath()` は「セグメント内に `/` を含む（= `%2F` をデコードした）ものはファイル名になり得ない」として `null` を返し、`folder%2Fnote.md` をファイルパスとして扱わない。ソースコメントに `folder%2Fnote.md` がまさにこのケースとして明記されている。
- 自分の vault にインストールされている Local REST API のバージョンでの挙動は未確認。ただし上流の現行実装で確定的に失敗する構造なので、修正方針は変わらない。
- `/open/*`（`show_file_in_obsidian`）は上流では残り全体を一括デコードするので現状でも通るが、セグメント単位エンコードでも同じ結果になる。統一してよい。

### `patch_vault_file` / `patch_active_file` が Local REST API 5.x で 400 になる（修正済み 2026-09-03、markdown-patch 2.0 へ移行）

`verify:paths` の実行で判明。パスに関係なくルート直下でも失敗していた。Local REST API 5.x は PATCH の既定を markdown-patch 2.0（JSON instruction body）に変え、旧来の `Operation` / `Target-Type` / `Target` ヘッダ形式（1.x）は `Markdown-Patch-Version: 1` を付けたときだけ受け付ける（deprecated、6.0 で削除予定）。本リポジトリは 1.x 形式をヘッダなしで送っていたので `PatchHeaderTargetingRequiresExplicitVersion` で拒否されていた。さらに `Target` ヘッダを生で送っていたため、日本語見出しは HTTP ヘッダに載らず壊れていた。

対応: ヘッダ形式は捨て、**2.0 の JSON instruction body に移行した**（コミット履歴: まず `Markdown-Patch-Version: 1` で応急処置 → 2.0 へ）。

- 変換は `packages/mcp-server/src/shared/buildPatchInstruction.ts`（単体テスト付き）。ツール引数 → `{ targetType, target, operation, scope?, within?, content | value, createTargetIfMissing?, rejectIfContentPreexists? }` を組み立て、`Content-Type: application/json` で `PATCH /vault/<path>` または `PATCH /active/` に送る。応答は 200 で本文がパッチ後の文書（`ApiContentResponse`）。
- **ツール引数は後方互換**（`packages/shared/src/types/plugin-local-rest-api.ts` の `ApiPatchParameters`）。`target: "A::B"` + `targetDelimiter` は内部で配列に分割する。`contentType: application/json` は `JSON.parse` して `value` に載せる。frontmatter への文字列は常に `value`（上流の raw-content mode と同じ扱い）。`trimTargetWhitespace` は文字列 target の各セグメントを trim するだけ。`createTargetIfMissing` は**既定 false**（2026-09-03 に変更。理由は次節）。
- 追加した引数: `target` に配列、`operation: delete`、`scope`（content / marker / markerAndContent）、`within`、`createTargetIfMissing`、`rejectIfContentPreexists`。`content` は `delete` のとき不要になったので optional。見出しの移動（`scope: parent` + `destination`）と `ifMatch` は露出していない。
- 2.0 の挙動差: 見出し配下への `append` / `prepend` は必ず新しいブロックになり、前後の空行はエンジンが管理する（`content` の先頭末尾の空行は無視される）。既存の段落やリストを続けたいときは `within` でブロックを指定する。`scope: marker` での見出しリネームは `#` を付けない（付けると見出し文字列の一部になる）。
- 上流の `Markdown-Patch-Warnings` 応答ヘッダ（h6 超えなどの警告）は `makeRequest` がヘッダを返さないため拾っていない。
- 2.0 の JSON body は Local REST API 5.x 前提。それより古い版との互換は捨てた（この fork の方針どおり）。

### `patch_vault_file` / `patch_active_file` が H2 以下の見出しを解決できず、既定でファイル末尾に見出しを複製していた（修正済み 2026-09-03）

症状: `target: "Plain"`（`## Plain`）や `"📝 本日の振り返り（事実）::AB"` のように**先頭の H1 を省いたパス**を渡すと 404 になり、既定の `createTargetIfMissing: true` によって `# Plain` のような新しい見出しツリーが EOF に追加されて「成功」と返っていた。実 vault のノートを壊した。

原因（実機で確認済み）: markdown-patch 2.0 のエンジンは正しく任意の深さを解決する。`["Title", "Plain"]` や `Title::📝 本日の振り返り（事実）::個人/家族` は絵文字・全角括弧・`/` を含んでも通る。エンジンのバグではなく、**heading target は必ずトップレベルからの完全パス**という仕様で、`["Plain"]` は「`# Plain` という H1」の意味になる。存在しないので create にフォールバックしていた。

対応:

- `packages/mcp-server/src/shared/applyPatch.ts` が両 PATCH ツールの共通実装。heading target のときは先に document map（`GET /vault/<path>` または `GET /active/` に `Accept: application/vnd.olrapi.document-map+json`、レスポンス型は `LocalRestAPI.ApiDocumentMapResponse`）を取り、`resolveHeadingTarget.ts` の `resolveHeadingPath` で解決する。完全一致 → そのまま。部分パス（葉の見出しだけ、または末尾数段）が既存パスの**末尾に一意に一致** → 完全パスに広げて送る。複数一致 → `InvalidParams` で候補を列挙し**書き込まない**。一致なし → `createTargetIfMissing: true` のときだけ送る（与えたパスがトップレベルから作られる）。それ以外は既存見出し一覧を付けたエラーで**書き込まない**。
- document map の `version` を instruction の `ifMatch` に載せるので、map 取得と PATCH の間にファイルが変わっていればエンジンが拒否する。
- `createTargetIfMissing` の既定を false にした（`buildPatchInstruction.ts`）。frontmatter の新規キー作成も明示が必要になった。
- 成功時のレスポンスに `Matched heading: A::B` / `Resolved heading X to A::B::X` / `Heading X does not exist; creating it` の 1 行を含める。呼び出し側はファイルを読み直さずに何に当たったか分かる。
- 見出しテキストの照合は完全一致（大文字小文字・空白・絵文字を区別）。`trimTargetWhitespace` は送信前に各セグメントを trim するだけ。
- 単体テストは `resolveHeadingTarget.test.ts`。実機は `verify:paths` の第 2 フェーズ（葉・部分・完全パス、`/`・絵文字・全角括弧を含む見出し、同名見出しの曖昧性、不在見出しの拒否と作成、`scope: markerAndContent` の H3 兄弟挿入、`patch_active_file` の葉解決）。

### コーディング規約: パスを URL に埋め込むときはセグメント単位でエンコードする

vault 内パスを URL パスに埋め込む処理を書く・直すときは、必ず `/` で分割してから各セグメントを `encodeURIComponent` し、`/` で再結合する。パス全体に `encodeURIComponent` をかけてはならない（`/` が `%2F` になり Local REST API がファイルとして解決しない）。エンコードなしで埋め込むのも不可（スペース・`#`・`?`・`%` で壊れる）。`makeRequest` はエンコードしないので、呼び出し側でヘルパーを通す。

## 開発フロー

### 前提ツール

- ランタイム/バンドラは Bun のみ（`mise.toml`: `bun = "latest"`、README は v1.1.42 以上）。Node は使わない。
- このマシンには bun 1.4.0 が入っており、`bun install` 済み（2026-09-03）。bun 1.4 は `bun install` のたびに `bun.lock` の GitHub 依存 3 件に integrity ハッシュを追記して差分を出すが、解決バージョンは変わらない。
- Windows で `link` スクリプトを使う場合、`symlinkSync(..., "dir")` はシンボリックリンク作成権限が要る。権限がなければ後述のコピー方式にする。

### ルートの scripts（`package.json`）

`check` / `dev` / `release` / `zip` はすべて `bun --filter '*' <script>` で各パッケージへ委譲。ルートに `build` と `test` は**存在しない**（README の `bun run build` はルートでは動かない）。パッケージ単位で実行する。

### ビルド

```bash
bun install
```

Obsidian プラグイン（`packages/obsidian-plugin`）:

```bash
cd packages/obsidian-plugin && GITHUB_DOWNLOAD_URL="https://github.com/jacksteamdev/obsidian-mcp-tools/releases/download/0.2.33" GITHUB_REF_NAME="0.2.33" bun run build
```

`build` = `bun run check && bun bun.config.ts --prod`。型チェック後、リポジトリ直下に `main.js` が出る。`dev` は watch。
**環境変数 2 つは必須**（確認済み）: `constants/bundle-time.ts` のマクロはビルド時に `process.env.GITHUB_DOWNLOAD_URL` / `GITHUB_REF_NAME` を読む。`bun.config.ts` の `define` はバンドル対象のソースにしか効かず、マクロ実行時には見えないので、変数なしで実行すると `Failed to get environment variables` → `cannot coerce Exception ... to Bun's AST` で落ちる。`release.yml` も同じ 2 変数を明示的に渡している。値はルート `package.json` の `version` に合わせる（`GITHUB_REF_NAME` は semver として `clean` される）。`GITHUB_DOWNLOAD_URL` は「Install Server」ボタンの取得先に埋め込まれるだけなので、fork でボタンを使わない限り値の中身は動作に影響しない。PowerShell なら `$env:GITHUB_DOWNLOAD_URL="..."; $env:GITHUB_REF_NAME="0.2.33"; bun run build`。

MCP サーバ（`packages/mcp-server`）:

```bash
cd packages/mcp-server && bun run build:windows
```

`dist/mcp-server-windows.exe` が出る（`--compile --minify --target=bun-windows-x64-baseline`）。`build` はホスト向け `dist/mcp-server`、`dev` はリポジトリ直下 `bin/mcp-server` へ watch ビルド（`bin/` は gitignore 済み）。

### テスト・型チェック

```bash
cd packages/mcp-server && bun test
```

テストは `packages/mcp-server` にしかない（`src/shared/parseTemplateParameters.test.ts`, `src/features/fetch/services/markdown.test.ts`）。単一ファイルは `bun test src/shared/parseTemplateParameters.test.ts`。型チェックはルートで `bun run check`（全パッケージの `tsc --noEmit`）。

現状 13 件中 4 件が失敗する（2026-09-03 確認、上流から引き継いだ不整合）。`parseTemplateParameters.test.ts` は `<% tp.user.promptArg("name") %>` 形式を期待しているが、実装の `CallExpressionSchema` と `main.ts` が Templater に注入する関数は `tp.mcpTools.prompt(...)` で、テスト側が古い。失敗しているのはこの 4 件だけで、環境起因ではない。

### vault へのインストール（Windows、この fork の運用）

プラグイン本体は `<vault>/.obsidian/plugins/mcp-tools/` に `main.js` と `manifest.json` があればよい（`manifest.json` の `id` は `mcp-tools`）。2 通り：

- symlink: `cd packages/obsidian-plugin && bun run link <vault>/.obsidian`（`scripts/link.ts`。リポジトリ直下を `<vault>/.obsidian/plugins/mcp-tools` としてリンクする。以後は `bun run build` するだけで反映）
- コピー: リポジトリ直下の `main.js` と `manifest.json` を `<vault>/.obsidian/plugins/mcp-tools/` に置く。

`styles.css` は `scripts/zip.ts` と `release.yml` から参照されているがリポジトリに存在しない。プラグインの動作には不要。`bun run zip` が失敗するかは未確認。

MCP サーバは「Install Server」ボタンを使わず（上流リリースを取りに行くため）、自前ビルドを手で配置する：

1. `dist/mcp-server-windows.exe` を `<vault>/.obsidian/plugins/mcp-tools/bin/mcp-server.exe` にコピー（`status.ts` の `getInstallPath()` がこの場所を見て、`--version` の出力と `manifest.version` を比較する）。
2. `%APPDATA%\Claude\claude_desktop_config.json` に以下を書く（`services/config.ts` が書くものと同形式）：

```json
{
  "mcpServers": {
    "obsidian-mcp-tools": {
      "command": "<vault>\\.obsidian\\plugins\\mcp-tools\\bin\\mcp-server.exe",
      "env": { "OBSIDIAN_API_KEY": "<Local REST API のキー>" }
    }
  }
}
```

3. Obsidian で再読み込み（プラグインを一度無効化→有効化、または Obsidian 再起動）。プラグインはロード後 5 秒間 200ms 間隔で Local REST API を探す（`shared/index.ts` の `loadLocalRestAPI`）ので、Local REST API が先に有効になっていること。
4. Claude Desktop を再起動して MCP サーバを再起動させる。

### 疎通確認

バイナリを介さず直接サーバを立てて確認する：

```bash
cd packages/mcp-server && OBSIDIAN_API_KEY=<key> bun run inspector
```

（`npx @modelcontextprotocol/inspector bun src/index.ts`。PowerShell なら `$env:OBSIDIAN_API_KEY="<key>"; bun run inspector`）。まず `get_server_info` を叩き、`authenticated: true` と Local REST API の `versions.self` を確認する。

Claude Code のこのプロジェクトに `obsidian-mcp-tools` MCP サーバが接続されている場合は、`mcp__obsidian-mcp-tools__get_vault_file` 等を直接呼んで検証できる。ただしそれは Claude Desktop 設定に書かれた（= 現在配置済みの）バイナリの動作であり、ビルドし直したら再起動するまで反映されない。

ログ（`packages/shared/src/logger.ts` の `getLogFilePath`）: Windows では `%USERPROFILE%\AppData\Local\Logs\Claude\mcp-server-obsidian-mcp-tools.log`。プラグイン側は本番ビルドでは `console` に出し、開発ビルドのときだけ同ディレクトリの `obsidian-plugin-mcp-tools.log` に書く。`constants/index.ts` の `LOG_PATH`（`%APPDATA%\obsidian-mcp-tools\logs`）は UI 表示用の値で、実際の書き込み先と一致していない。

## 検証用の vault パス条件

vault 内パスを扱うツール（`get_vault_file` / `create_vault_file` / `append_to_vault_file` / `patch_vault_file` / `delete_vault_file` / `list_vault_files` / `show_file_in_obsidian` / `execute_template`）を触ったら、必ず次の 5 パターンすべてで読み書きを通す。どれか 1 つでも抜くと今回のバグを再び見逃す。

| # | パターン | 例 |
|---|---|---|
| a | ルート直下 | `note.md` |
| b | ASCII のみのサブディレクトリ | `projects/note.md` |
| c | スペースを含むディレクトリ名 | `My Notes/note.md` |
| d | 日本語ディレクトリ名 | `日記/2026-09-03.md` |
| e | 3 階層以上のネスト | `a/b/c/note.md` |

各パターンで最低限 `get_vault_file` → `create_vault_file`（または `append_to_vault_file`）→ `get_vault_file` で往復し、`list_vault_files` で親ディレクトリを列挙して見えることを確認する。エラーは `makeRequest` が `<METHOD> <path> <status>: <body>` の形で返すので、`<path>` にどうエンコードされたかがそのまま読める。

この 5 パターンを自動で回すスクリプトがある：

```bash
cd packages/mcp-server && bun run build:windows && bun run verify:paths
```

`scripts/verify-paths.ts` は `dist/mcp-server-windows.exe` を Claude Desktop と同じ stdio で起動し（引数で別バイナリを指定可）、API キーと vault の場所を `%APPDATA%\Claude\claude_desktop_config.json` から読む（キーは出力しない）。各パターンで get / create / append / patch（ASCII 見出し・日本語見出し・配列 target・frontmatter・`delete`）/ `show_file_in_obsidian` → `patch_active_file` / list（末尾 `/` あり・なし）/ delete を回す。vault の `_mcp-tools-test/` 以下とルートの `_mcp-tools-test-root.md` に書いて消し、残った空ディレクトリはディスク上で直接削除する。`show_file_in_obsidian` を使うので Obsidian にテストファイルのタブが 6 つ開いたまま残る（ファイル自体は削除済み）。Obsidian と Local REST API が起動していること。結果は Markdown の表で出る。第 1 フェーズのあと、`_mcp-tools-test/日記/_patch_headings.md` で H2 以下の見出し解決を回す第 2 フェーズが続く（前節）。2026-09-03 時点で 145/145 PASS。

## バージョン整合

| ファイル | 役割 |
|---|---|
| `package.json`（ルート） | 唯一の入力。`version` を `bun.config.ts`（`GITHUB_DOWNLOAD_URL` の埋め込み）、`packages/mcp-server/src/features/version/index.ts`（`--version` の出力）、`scripts/zip.ts`（zip 名）が読む |
| `manifest.json`（ルート） | Obsidian が読む。`version` は package.json と同値に保つ。`minAppVersion` は `0.15.0` |
| `versions.json`（ルート） | `{ "<plugin version>": "<minAppVersion>" }` の対応表。Obsidian のプラグイン更新判定用 |

- `bun run version [patch|minor|major]`（`scripts/version.ts`）が package.json → manifest.json → versions.json の順に更新し、`git add` / `commit` / `tag` / `push` / `push origin <tag>` まで一括で行う。作業ツリーが clean で `main` にいないと止まる（`FORCE=true` で回避）。タグ push で `.github/workflows/release.yml` が走り、全プラットフォームのバイナリと plugin zip を GitHub Release に上げる。前述のとおり remote を直してから使うこと。
- プラグインは起動時に `bin/mcp-server.exe --version` の出力と `manifest.version` を semver 比較し、サーバが古ければ `outdated` と表示する（`services/status.ts`）。自前ビルドのバイナリでもルート package.json の版が焼き込まれるので、プラグインとサーバを同じコミットからビルドすれば一致する。
- `features/core/index.ts` の `new Server({ name: "obsidian-mcp-tools", version: "0.1.0" })` は固定文字列で、package.json と同期していない。MCP クライアントに見える版はこれ。
- Local REST API 側: プラグインは npm パッケージ `obsidian-local-rest-api` ^2.5.4（lock: 2.5.4）を `getAPI` と型のためだけに依存している。**実行時に必要な Local REST API の版はコード上どこにも検査・固定されていない**。README の「Obsidian v1.7.7 以上」も manifest の `minAppVersion` には反映されていない（`0.15.0` のまま）。
