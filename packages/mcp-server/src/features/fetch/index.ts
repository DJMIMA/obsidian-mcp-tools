import { logger, type ToolRegistry } from "$/shared";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { type } from "arktype";
import { DEFAULT_USER_AGENT } from "./constants";
import { paginateContent } from "./paginateContent";
import { convertHtmlToMarkdown } from "./services/markdown";

export function registerFetchTool(tools: ToolRegistry, server: Server) {
  tools.register(
    type({
      name: '"fetch"',
      arguments: {
        url: "string",
        "maxLength?": type("number").describe("Limit response length."),
        "startIndex?": type("number").describe(
          "Supports paginated retrieval of content.",
        ),
        "raw?": type("boolean").describe(
          "Returns raw HTML content if raw=true.",
        ),
      },
    }).describe(
      "Reads and returns the content of any web page. Returns the content in Markdown format by default, or can return raw HTML if raw=true parameter is set. Supports pagination through maxLength and startIndex parameters.",
    ),
    async ({ arguments: args }) => {
      logger.info("Fetching URL", { url: args.url });

      try {
        const response = await fetch(args.url, {
          headers: {
            "User-Agent": DEFAULT_USER_AGENT,
          },
        });

        if (!response.ok) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to fetch ${args.url} - status code ${response.status}`,
          );
        }

        const contentType = response.headers.get("content-type") || "";
        const text = await response.text();

        const isHtml =
          text.toLowerCase().includes("<html") ||
          contentType.includes("text/html") ||
          !contentType;

        let content: string;
        let prefix = "";

        if (isHtml && !args.raw) {
          content = convertHtmlToMarkdown(text, args.url);
        } else {
          content = text;
          prefix = `Content type ${contentType} cannot be simplified to markdown, but here is the raw content:\n`;
        }

        const page = paginateContent(
          content,
          args.startIndex || 0,
          args.maxLength || 5000,
        );

        logger.debug("URL fetched successfully", {
          url: args.url,
          contentLength: page.text.length,
        });

        return {
          content: [
            {
              type: "text",
              text: `${prefix}Contents of ${args.url}:\n${page.text}`,
            },
            {
              type: "text",
              text: `Pagination: ${JSON.stringify({
                totalLength: page.totalLength,
                startIndex: page.startIndex,
                endIndex: page.endIndex,
                hasMore: page.hasMore,
              })}`,
            },
          ],
        };
      } catch (error) {
        logger.error("Failed to fetch URL", { url: args.url, error });
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to fetch ${args.url}: ${error}`,
        );
      }
    },
  );
}
