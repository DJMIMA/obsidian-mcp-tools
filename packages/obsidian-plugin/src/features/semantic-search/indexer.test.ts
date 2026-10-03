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
