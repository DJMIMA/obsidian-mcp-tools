// 型情報を使うルールのうち、tsc では見つからない Promise の扱い漏れに絞った最小構成。
// recommendedTypeChecked を丸ごと有効にすると any や空の型などの指摘が大半を占めるので入れていない
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", ".claude/**", "main.js"],
  },
  {
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // 各パッケージの tsconfig.json の型情報を使う
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // await も .catch もしていない Promise
      "@typescript-eslint/no-floating-promises": "error",
      // if (promise) のような条件式や、void を期待する引数への async 関数
      "@typescript-eslint/no-misused-promises": "error",
      // Promise でない値への await
      "@typescript-eslint/await-thenable": "error",
      // オブジェクトを文字列にして "[object Object]" になる箇所
      "@typescript-eslint/no-base-to-string": "error",
    },
  },
  {
    // bun:test の型定義は expect(...).rejects / resolves の matcher を void で返すと書いているが、
    // 書き方としては await を付けるのが正しい（Bun のドキュメントもそう書く）ので、テストでは外す
    files: ["packages/*/src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
    },
  },
);
