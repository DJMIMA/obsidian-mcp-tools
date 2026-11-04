import { logger, type ToolRegistry } from "$/shared";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { type } from "arktype";
import { DEFAULT_USER_AGENT } from "./constants";
import { paginateContent } from "./paginateContent";
import { anyAddress, fetchPage, MAX_BODY_BYTES, publicOnly } from "./safeFetch";
import { convertHtmlToMarkdown } from "./services/markdown";

export function registerFetchTool(tools: ToolRegistry, server: Server) {
  tools.register(
    type({
      name: '"fetch"',
      arguments: {
        url: type("string").describe("Absolute http(s) URL of the page"),
        "maxLength?": type("number").describe(
          "Maximum characters of content to return (default 5000)",
        ),
        "startIndex?": type("number").describe(
          "Character offset to start from when reading the next part of a long page (default 0)",
        ),
        "raw?": type("boolean").describe(
          "Returns raw HTML content if raw=true.",
        ),
      },
    }).describe(
      "Reads and returns the content of a public web page (http or https only; local files, localhost and private network addresses are refused). Returns the content in Markdown format by default, or can return raw HTML if raw=true parameter is set. Supports pagination through maxLength and startIndex parameters.",
    ),
    async ({ arguments: args }) => {
      logger.info("Fetching URL", { url: args.url });

      try {
        const page = await fetchPage(args.url, {
          userAgent: DEFAULT_USER_AGENT,
          allowed:
            process.env.OBSIDIAN_MCP_FETCH_ALLOW_PRIVATE === "true"
              ? anyAddress
              : publicOnly,
        });

        if (page.status < 200 || page.status >= 300) {
          throw new Error(`status code ${page.status} from ${page.url}`);
        }

        const { contentType, text } = page;

        const isHtml =
          text.toLowerCase().includes("<html") ||
          contentType.includes("text/html") ||
          !contentType;

        let content: string;
        let prefix = "";

        if (isHtml && !args.raw) {
          content = convertHtmlToMarkdown(text, page.url);
        } else {
          content = text;
          prefix = `Content type ${contentType} cannot be simplified to markdown, but here is the raw content:\n`;
        }
        if (page.truncated) {
          prefix += `The page is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB; only its beginning was read.\n`;
        }

        const slice = paginateContent(
          content,
          args.startIndex || 0,
          args.maxLength || 5000,
        );

        logger.debug("URL fetched successfully", {
          url: args.url,
          contentLength: slice.text.length,
        });

        return {
          content: [
            {
              type: "text",
              text: `${prefix}Contents of ${page.url}:\n${slice.text}`,
            },
            {
              type: "text",
              text: `Pagination: ${JSON.stringify({
                totalLength: slice.totalLength,
                startIndex: slice.startIndex,
                endIndex: slice.endIndex,
                hasMore: slice.hasMore,
              })}`,
            },
          ],
        };
      } catch (error) {
        logger.error("Failed to fetch URL", { url: args.url, error: String(error) });
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to fetch ${args.url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
