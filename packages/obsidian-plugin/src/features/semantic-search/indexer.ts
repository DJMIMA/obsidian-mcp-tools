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
