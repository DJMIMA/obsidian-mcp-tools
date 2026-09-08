import { type, type Type } from "arktype";
import {
  describeHttpError,
  describeNetworkError,
  ObsidianApiError,
  type ApiRequestInfo,
} from "./describeApiError";
import { logger } from "./logger";

// Disable TLS certificate validation for local self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/**
 * Origin of the Obsidian Local REST API.
 *
 * Read from the environment on every call so a test (or a differently
 * configured vault) can point requests somewhere else without reloading the
 * module. Defaults match the plugin: HTTPS on 27124, HTTP on 27123.
 */
export function getBaseUrl(): string {
  const useHttp = process.env.OBSIDIAN_USE_HTTP === "true";
  const protocol = useHttp ? "http" : "https";
  const host = process.env.OBSIDIAN_HOST || "127.0.0.1";
  const port = process.env.OBSIDIAN_PORT || (useHttp ? "27123" : "27124");
  return `${protocol}://${host}:${port}`;
}

/**
 * Abort deadline for a single request, from OBSIDIAN_REQUEST_TIMEOUT_MS.
 * Unset means no deadline, which is the default: template execution and
 * semantic search can legitimately run for a long time.
 */
function getTimeoutMs(): number | undefined {
  const raw = process.env.OBSIDIAN_REQUEST_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Makes a request to the Obsidian Local REST API with the provided path and
 * optional request options. Automatically adds the required API key to the
 * request headers.
 *
 * Throws an {@link ObsidianApiError} whose `description` says what actually
 * went wrong — file missing, path rejected, API key refused, Obsidian not
 * running, TLS failed, response in an unexpected shape — including the
 * requested path. The description is what tool handlers surface to the model.
 *
 * @param schema - Arktype schema the response body is validated against.
 * @param path - The path to the Obsidian API endpoint, already URL-encoded.
 * @param init - Optional request options to pass to the `fetch` function.
 * @returns The validated response from the Obsidian API.
 */
export async function makeRequest<
  T extends
    | Type<{}, {}>
    | Type<null | undefined, {}>
    | Type<{} | null | undefined, {}>,
>(schema: T, path: string, init?: RequestInit): Promise<T["infer"]> {
  const API_KEY = process.env.OBSIDIAN_API_KEY;
  if (!API_KEY) {
    logger.error("OBSIDIAN_API_KEY environment variable is required");
    throw new ObsidianApiError(
      "OBSIDIAN_API_KEY is not set for the MCP server. Add it to the server's env in the MCP client configuration; the value is the API key shown in the Obsidian Local REST API plugin settings.",
    );
  }

  const timeoutMs = getTimeoutMs();
  const request: ApiRequestInfo = {
    method: init?.method ?? "GET",
    path,
    baseUrl: getBaseUrl(),
    timeoutMs,
  };
  const url = `${request.baseUrl}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "text/markdown",
        ...init?.headers,
      },
    });
  } catch (error) {
    const description = describeNetworkError(request, error);
    logger.error("Could not reach the Obsidian Local REST API", {
      description,
      method: request.method,
      path,
    });
    throw new ObsidianApiError(description, { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const description = describeHttpError(request, response.status, body);
    logger.error("Obsidian Local REST API returned an error", {
      description,
      status: response.status,
      method: request.method,
      path,
    });
    throw new ObsidianApiError(description, { status: response.status });
  }

  const isJSON = !!response.headers.get("Content-Type")?.includes("json");
  const data = isJSON ? await response.json() : await response.text();
  // 204 No Content responses should be validated as undefined
  const validated = response.status === 204 ? undefined : schema(data);
  if (validated instanceof type.errors) {
    const stackError = new Error();
    Error.captureStackTrace(stackError, makeRequest);
    logger.error("Invalid response from Obsidian API", {
      status: response.status,
      error: validated.summary,
      stack: stackError.stack,
      data,
    });
    throw new ObsidianApiError(
      `The Obsidian Local REST API returned an unexpected response for ${request.method} ${path} (HTTP ${response.status}). ` +
        `This usually means the plugin version does not match what this MCP server expects.\n` +
        `Details: ${validated.summary}`,
      { status: response.status },
    );
  }

  return validated;
}
