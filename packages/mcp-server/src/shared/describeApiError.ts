/**
 * Turns a failed request to the Obsidian Local REST API into a message an LLM
 * can act on without making extra calls to work out what went wrong.
 *
 * Every message names the request that failed (method plus URL) and, for vault
 * paths, the decoded path the caller asked for, so "the file is missing" and
 * "the path was mangled" are never confused. The API key is stripped from the
 * result before it is returned.
 */

/** The request a message is being written about. */
export interface ApiRequestInfo {
  /** HTTP method, e.g. "GET". */
  method: string;
  /** URL path as sent, percent-encoded, e.g. "/vault/My%20Notes/a.md". */
  path: string;
  /** Origin the request went to, e.g. "https://127.0.0.1:27124". */
  baseUrl: string;
  /** Abort deadline in milliseconds, when one was applied. */
  timeoutMs?: number;
}

/**
 * A failed Local REST API request. Carries the human-readable description
 * separately from Error.message so callers can surface it verbatim.
 */
export class ObsidianApiError extends Error {
  readonly description: string;
  readonly status?: number;

  constructor(
    description: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(description);
    this.name = "ObsidianApiError";
    this.description = description;
    this.status = options?.status;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const MAX_DETAIL_LENGTH = 2000;

/** Replaces the configured API key with *** wherever it appears. */
export function redactSecrets(text: string): string {
  const key = process.env.OBSIDIAN_API_KEY;
  if (!key || key.length < 4) return text;
  return text.split(key).join("***");
}

const stripQuery = (path: string) => path.split("?")[0] ?? path;

/** Decodes each "/"-separated segment, leaving malformed escapes untouched. */
function decodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

/**
 * The path in the form the caller asked for it: a vault path without the
 * "/vault/" prefix, anything else decoded but otherwise as sent.
 */
function readablePath(path: string): string {
  const decoded = decodePath(stripQuery(path));
  if (decoded.startsWith("/vault/")) {
    return decoded.slice("/vault/".length).replace(/\/+$/, "") || "(vault root)";
  }
  return decoded;
}

const isVaultPath = (path: string) => stripQuery(path).startsWith("/vault/");
const isDirectoryPath = (path: string) => stripQuery(path).endsWith("/");
const isActivePath = (path: string) => stripQuery(path).startsWith("/active");

const truncate = (text: string) =>
  text.length > MAX_DETAIL_LENGTH
    ? text.slice(0, MAX_DETAIL_LENGTH) + "… (truncated)"
    : text;

/**
 * Pulls the API's own explanation out of an error body. Local REST API answers
 * with { errorCode, message }; anything else is passed through as text.
 */
function describeResponseBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const message =
        typeof record.message === "string" ? record.message : undefined;
      const errorCode =
        typeof record.errorCode === "number" ||
        typeof record.errorCode === "string"
          ? String(record.errorCode)
          : undefined;
      if (message) {
        return truncate(errorCode ? `${errorCode}: ${message}` : message);
      }
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }

  return truncate(trimmed);
}

function summariseStatus(
  info: ApiRequestInfo,
  status: number,
  hasDetail: boolean,
): string {
  const { method, path } = info;
  const shown = readablePath(path);

  if (status === 401 || status === 403) {
    return (
      `Authentication failed (HTTP ${status}). Check that OBSIDIAN_API_KEY in the MCP server ` +
      "configuration matches the API key in the Obsidian Local REST API plugin settings."
    );
  }

  if (status === 404) {
    if (isActivePath(path)) {
      return (
        "No active file: Obsidian has no file open, so this request had no target. " +
        "Open a note in Obsidian, or use the vault tools with an explicit filename."
      );
    }
    if (isVaultPath(path)) {
      return isDirectoryPath(path)
        ? `Directory not found: ${shown}`
        : `File not found: ${shown}`;
    }
    return `Not found (HTTP 404): ${method} ${shown}`;
  }

  if (status === 400) {
    return (
      `Bad request (HTTP 400): the Obsidian Local REST API rejected ${method} ${shown}.` +
      (hasDetail ? "" : " No further detail was returned.")
    );
  }

  if (status === 405) {
    return `Method not allowed for this path: ${method} ${shown}`;
  }

  if (status === 409 || status === 412) {
    return (
      `Precondition failed (HTTP ${status}) for ${method} ${shown}. The file changed between ` +
      "reading and writing; nothing was written. Re-read the file and retry."
    );
  }

  if (status === 413) {
    return `Payload too large (HTTP 413) for ${method} ${shown}.`;
  }

  if (status >= 500) {
    return `Obsidian Local REST API returned ${status} (server error) for ${method} ${shown}.`;
  }

  return `Obsidian Local REST API returned HTTP ${status} for ${method} ${shown}.`;
}

/**
 * Describes a non-2xx response from the Local REST API.
 *
 * @param info - The request that produced the response.
 * @param status - HTTP status code.
 * @param body - Raw response body, used for the API's own error detail.
 */
export function describeHttpError(
  info: ApiRequestInfo,
  status: number,
  body: string,
): string {
  const detail = describeResponseBody(body);
  const lines = [
    summariseStatus(info, status, detail !== undefined),
    `Request: ${info.method} ${info.baseUrl}${info.path}`,
  ];
  if (detail) lines.push(`Details: ${detail}`);
  return redactSecrets(lines.join("\n"));
}

/** Flattens an error and its cause chain into codes, names and messages. */
function collectErrorFacts(error: unknown): {
  codes: string[];
  names: string[];
  messages: string[];
} {
  const codes: string[] = [];
  const names: string[] = [];
  const messages: string[] = [];

  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth++) {
    if (typeof current === "string") {
      messages.push(current);
      break;
    }
    if (typeof current !== "object") break;

    const record = current as Record<string, unknown>;
    if (typeof record.code === "string") codes.push(record.code);
    if (typeof record.code === "number") codes.push(String(record.code));
    if (typeof record.errno === "string") codes.push(record.errno);
    if (typeof record.name === "string") names.push(record.name);
    if (typeof record.message === "string") messages.push(record.message);

    current = record.cause;
  }

  return { codes, names, messages };
}

const matchesAny = (values: string[], patterns: RegExp[]) =>
  values.some((value) => patterns.some((pattern) => pattern.test(value)));

/**
 * Describes a request that never produced a response: the connection was
 * refused, TLS failed, DNS failed, or the request timed out.
 *
 * @param info - The request that failed.
 * @param error - The thrown value, whose cause chain is inspected.
 */
export function describeNetworkError(
  info: ApiRequestInfo,
  error: unknown,
): string {
  const { codes, names, messages } = collectErrorFacts(error);
  const url = `${info.baseUrl}${info.path}`;
  const shown = readablePath(info.path);
  const original = messages[0] ?? String(error);

  const isTimeout =
    matchesAny(codes, [
      /^(ETIMEDOUT|ESOCKETTIMEDOUT|ConnectionTimeout|TimeoutError)$/i,
    ]) ||
    matchesAny(names, [/^(AbortError|TimeoutError)$/]) ||
    matchesAny(messages, [/timed? ?out/i, /was aborted/i]);

  const isTls =
    matchesAny(codes, [
      /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_TLS|EPROTO|ERR_SSL)/i,
    ]) || matchesAny(messages, [/certificate/i, /\bTLS\b/i, /\bSSL\b/i]);

  const isDns = matchesAny(codes, [/^(ENOTFOUND|EAI_AGAIN|DNSError)$/i]);

  const isUnreachable =
    matchesAny(codes, [
      /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ConnectionRefused|ConnectionClosed|FailedToOpenSocket)$/i,
    ]) ||
    matchesAny(messages, [
      /connection refused/i,
      /unable to connect/i,
      /fetch failed/i,
      /socket hang ?up/i,
    ]);

  let summary: string;
  if (isTimeout) {
    const limit =
      info.timeoutMs !== undefined ? ` after ${info.timeoutMs}ms` : "";
    summary =
      `Request to ${info.method} ${shown} timed out${limit}. Obsidian may be busy, ` +
      "or a Templater/Smart Connections operation may still be running.";
  } else if (isTls) {
    summary =
      `TLS handshake failed for ${info.baseUrl}. The Local REST API's self-signed certificate ` +
      "may need to be regenerated in the plugin settings, or set OBSIDIAN_USE_HTTP=true to use the plain HTTP port.";
  } else if (isDns) {
    summary =
      `Cannot resolve the host in ${info.baseUrl}. Check the OBSIDIAN_HOST setting ` +
      "in the MCP server configuration.";
  } else if (isUnreachable) {
    summary =
      `Cannot reach Obsidian Local REST API at ${info.baseUrl}. Ensure Obsidian is running, ` +
      "the Local REST API plugin is enabled, and the host and port match its settings.";
  } else {
    summary = `Request to ${info.method} ${url} failed: ${original}`;
  }

  return redactSecrets(
    [summary, `Request: ${info.method} ${url}`, `Cause: ${original}`].join("\n"),
  );
}
