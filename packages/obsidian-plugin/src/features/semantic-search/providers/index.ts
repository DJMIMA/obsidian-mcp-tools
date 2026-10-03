import type { SecretLookup, SemanticSearchSettings } from "../settings";
import { createCohereProvider } from "./cohere";
import { createOpenAiCompatibleProvider } from "./openaiCompatible";
import type { EmbeddingProvider, HttpFn } from "./types";

export * from "./common";
export * from "./cohere";
export * from "./openaiCompatible";
export * from "./types";

export function createProvider(
  settings: SemanticSearchSettings,
  getSecret: SecretLookup,
  http: HttpFn,
): EmbeddingProvider {
  if (settings.provider === "cohere") {
    return createCohereProvider({
      apiKey: getSecret(settings.cohere.apiKeySecretId) ?? "",
      model: settings.cohere.model,
      dimension: settings.cohere.dimension,
      http,
    });
  }
  const o = settings.openaiCompatible;
  return createOpenAiCompatibleProvider({
    baseUrl: o.baseUrl,
    apiKey: o.apiKeySecretId ? getSecret(o.apiKeySecretId) : null,
    model: o.model,
    dimensions: o.dimensions,
    queryPrefix: o.queryPrefix,
    documentPrefix: o.documentPrefix,
    batchSize: o.batchSize,
    http,
  });
}
