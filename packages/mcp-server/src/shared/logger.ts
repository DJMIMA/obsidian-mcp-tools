import { createLogger, logLevelSchema, type LogLevel } from "shared";

/**
 * INFO unless OBSIDIAN_MCP_LOG_LEVEL names another level. The compiled
 * binary has no NODE_ENV, so keying DEBUG off it meant every release build
 * logged at DEBUG.
 */
function configuredLevel(): LogLevel {
  const requested = process.env.OBSIDIAN_MCP_LOG_LEVEL?.toUpperCase();
  return logLevelSchema.allows(requested) ? requested : "INFO";
}

/**
 * The logger instance for the MCP server application, writing to
 * mcp-server-obsidian-mcp-tools.log in the "Claude" log folder. Messages
 * carry tool names, paths and timings, never note content or API keys.
 */
export const logger = createLogger({
  appName: "Claude",
  filename: "mcp-server-obsidian-mcp-tools.log",
  level: configuredLevel(),
});
