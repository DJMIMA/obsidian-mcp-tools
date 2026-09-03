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

ツールを 1 つ追加・修正するとき触るファイル（依存関係から）：

1. ツール本体: 既存の `features/<feature>/index.ts`、または新規 `features/<name>/index.ts` を作って `features/core/index.ts` の `setupHandlers()` に登録を追加。
2. 新しいエンドポイントのレスポンス型が要るなら `packages/shared/src/types/plugin-local-rest-api.ts`。
3. そのエンドポイントを本プラグインが提供するもの（`/search/smart`, `/templates/execute` の類）なら `packages/obsidian-plugin/src/main.ts` のルート登録とハンドラも。
4. パスを URL に埋め込むなら後述の規約に従う。

## 既知の問題と修正方針

### サブディレクトリを含むパスで単一ファイル操作が全滅する

症状: `get_vault_file` / `create_vault_file` / `append_to_vault_file` / `patch_vault_file` / `delete_vault_file` は vault ルート直下のファイルでは成功し、`/` を含むパス（`folder/note.md`）では失敗する。

原因（コードで確認済み）:

- 本リポジトリ側: 上記 5 ツールは `` `/vault/${encodeURIComponent(args.filename)}` `` でパス全体をエンコードしているため、`/` が `%2F` になる (`features/local-rest-api/index.ts`)。
- Local REST API 側（上流 `coddingtonbear/obsidian-local-rest-api` main ブランチ、manifest 5.1.0、2026-09-03 確認）: `requestHandler.ts` の `extractVaultPath()` は `req.path` を**生の `/` で分割してからセグメントごとに `decodeURIComponent`** する。続く `wholeFilePath()` は「セグメント内に `/` を含む（= `%2F` をデコードした）ものはファイル名になり得ない」として `null` を返し、`folder%2Fnote.md` をファイルパスとして扱わない。ソースコメントに `folder%2Fnote.md` がまさにこのケースとして明記されている。
- 自分の vault にインストールされている Local REST API のバージョンでの挙動は未確認。ただし上流の現行実装で確定的に失敗する構造なので、修正方針は変わらない。
- `/open/*`（`show_file_in_obsidian`）は上流では残り全体を一括デコードするので現状でも通るが、セグメント単位エンコードでも同じ結果になる。統一してよい。

修正方針: セグメント単位エンコード。

```ts
// 例: packages/mcp-server/src/shared/ に置き、makeRequest と同じ index.ts から export する
export const encodeVaultPath = (p: string) =>
  p.split("/").map(encodeURIComponent).join("/");
```

適用対象は上記 5 ツールと `show_file_in_obsidian`、および現在まったくエンコードしていない `list_vault_files` / `templates` / `prompts` のパス結合。`list_vault_files` は末尾の `/`（ディレクトリ指定）を保持すること。

### コーディング規約: パスを URL に埋め込むときはセグメント単位でエンコードする

vault 内パスを URL パスに埋め込む処理を書く・直すときは、必ず `/` で分割してから各セグメントを `encodeURIComponent` し、`/` で再結合する。パス全体に `encodeURIComponent` をかけてはならない（`/` が `%2F` になり Local REST API がファイルとして解決しない）。エンコードなしで埋め込むのも不可（スペース・`#`・`?`・`%` で壊れる）。`makeRequest` はエンコードしないので、呼び出し側でヘルパーを通す。

## 開発フロー

### 前提ツール

- ランタイム/バンドラは Bun のみ（`mise.toml`: `bun = "latest"`、README は v1.1.42 以上）。Node は使わない。
- 2026-09-03 時点でこのマシンに `bun` は入っていない（PATH になし、`~/.bun` なし）。`node_modules` も未生成。作業開始時にまず Bun を入れて `bun install` する。
- Windows で `link` スクリプトを使う場合、`symlinkSync(..., "dir")` はシンボリックリンク作成権限が要る。権限がなければ後述のコピー方式にする。

### ルートの scripts（`package.json`）

`check` / `dev` / `release` / `zip` はすべて `bun --filter '*' <script>` で各パッケージへ委譲。ルートに `build` と `test` は**存在しない**（README の `bun run build` はルートでは動かない）。パッケージ単位で実行する。

### ビルド

```bash
bun install
```

Obsidian プラグイン（`packages/obsidian-plugin`）:

```bash
cd packages/obsidian-plugin && bun run build
```

`build` = `bun run check && bun bun.config.ts --prod`。型チェック後、リポジトリ直下に `main.js` が出る。`dev` は watch。
未確認: `constants/bundle-time.ts` のマクロが `GITHUB_DOWNLOAD_URL` / `GITHUB_REF_NAME` を要求する。`bun.config.ts` の `define` で値を注入しているが、マクロ実行時にそれで足りるかローカルでは未検証。`release.yml` は両方を環境変数として明示的に渡している。ローカルビルドが `Failed to get environment variables` で落ちたら、同じ 2 変数を export してから再実行する。

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
