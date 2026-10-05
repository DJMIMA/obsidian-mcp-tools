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

describe("withDefaults guards numbers", () => {
  // A cleared number field arrives as null; 0 or a negative step would make chunking or batching loop forever.
  test("replaces unusable numbers with the defaults", () => {
    const s = withDefaults({ maxChunkChars: 0, openaiCompatible: { batchSize: null, dimensions: 0 } } as never);
    expect(s.maxChunkChars).toBe(4000);
    expect(s.openaiCompatible.batchSize).toBe(64);
    expect(s.openaiCompatible.dimensions).toBeNull();
    expect(withDefaults({ maxChunkChars: 150 } as never).maxChunkChars).toBe(4000);
    expect(withDefaults({ maxChunkChars: 2500.7 } as never).maxChunkChars).toBe(2500);
    expect(withDefaults({ openaiCompatible: { batchSize: -3 } } as never).openaiCompatible.batchSize).toBe(64);
  });

  test("resultMaxChars defaults to 300, keeps 0 (whole sections) and rejects negatives and null", () => {
    expect(withDefaults(undefined).resultMaxChars).toBe(300);
    expect(withDefaults({ resultMaxChars: 0 } as never).resultMaxChars).toBe(0);
    expect(withDefaults({ resultMaxChars: 800.9 } as never).resultMaxChars).toBe(800);
    expect(withDefaults({ resultMaxChars: -1 } as never).resultMaxChars).toBe(300);
    expect(withDefaults({ resultMaxChars: null } as never).resultMaxChars).toBe(300);
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
    b.resultMaxChars = 0;
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
