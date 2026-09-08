import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { type } from "arktype";
import { ObsidianApiError, redactSecrets } from "./describeApiError";

/** The SDK prefixes McpError messages with the JSON-RPC code; drop it again. */
const MCP_ERROR_PREFIX = /^MCP error -?\d+:\s*/;

/**
 * Reduces anything thrown by a tool handler to the single text an MCP client
 * should show. Never includes the API key.
 */
export function describeToolError(error: unknown): string {
  if (error instanceof ObsidianApiError) {
    return redactSecrets(error.description);
  }

  if (error instanceof McpError) {
    return redactSecrets(error.message.replace(MCP_ERROR_PREFIX, ""));
  }

  if (error instanceof type.errors) {
    return redactSecrets(`Invalid arguments: ${error.summary}`);
  }

  if (error instanceof Error) {
    return redactSecrets(error.message || String(error));
  }

  if (typeof error === "string") {
    return redactSecrets(error);
  }

  return redactSecrets(
    `An unexpected error occurred: ${
      (() => {
        try {
          return JSON.stringify(error);
        } catch {
          return String(error);
        }
      })()
    }`,
  );
}

/**
 * Wraps a failure as a normal MCP tool result with `isError: true`, so the
 * reason reaches the model instead of being flattened into a JSON-RPC error.
 */
export function toolErrorResult(error: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: describeToolError(error) }],
  };
}
