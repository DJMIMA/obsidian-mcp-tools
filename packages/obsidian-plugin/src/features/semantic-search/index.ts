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

export { default as SemanticSearchSettingsView } from "./components/SemanticSearchSettings.svelte";

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
    if (options.rebuild) void this.startBuild();
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
    void this.startBuild();
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
