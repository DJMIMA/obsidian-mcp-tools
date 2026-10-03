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
