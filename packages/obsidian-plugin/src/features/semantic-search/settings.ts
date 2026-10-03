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

/** A whole number at least `min`, or null when `value` is not one (a cleared field arrives as null). */
function atLeast(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.floor(value) : null;
}

/**
 * Fills fields missing from stored settings (an older data.json) with the defaults,
 * and replaces numbers that would make chunking or batching loop forever.
 */
export function withDefaults(stored: Partial<SemanticSearchSettings> | undefined): SemanticSearchSettings {
  const d = DEFAULT_SEMANTIC_SEARCH_SETTINGS;
  const openai = { ...d.openaiCompatible, ...stored?.openaiCompatible };
  return {
    ...d,
    ...stored,
    cohere: { ...d.cohere, ...stored?.cohere },
    openaiCompatible: {
      ...openai,
      batchSize: atLeast(openai.batchSize, 1) ?? d.openaiCompatible.batchSize,
      dimensions: atLeast(openai.dimensions, 1),
    },
    excludeFolders: [...(stored?.excludeFolders ?? d.excludeFolders)],
    maxChunkChars: atLeast(stored?.maxChunkChars, 200) ?? d.maxChunkChars,
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
