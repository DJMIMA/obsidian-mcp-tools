import {
  encodeVaultPath,
  formatMcpError,
  logger,
  makeRequest,
  parseTemplateParameters,
  stripFrontmatter,
} from "$/shared";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { type } from "arktype";
import {
  buildTemplateArgumentsSchema,
  LocalRestAPI,
  PROMPTS_FOLDER,
  PromptFrontmatterSchema,
  type PromptMetadata,
} from "shared";

export function setupObsidianPrompts(server: Server) {
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    try {
      const { files } = await makeRequest(
        LocalRestAPI.ApiVaultDirectoryResponse,
        `/vault/${PROMPTS_FOLDER}/`,
      );
      const prompts: PromptMetadata[] = (
        await Promise.all(
          files.map(async (filename) => {
            // Skip non-Markdown files
            if (!filename.endsWith(".md")) return [];

            // Retrieve frontmatter and content from vault file
            const file = await makeRequest(
              LocalRestAPI.ApiVaultFileResponse,
              `/vault/${encodeVaultPath(`${PROMPTS_FOLDER}/${filename}`)}`,
              {
                headers: { Accept: LocalRestAPI.MIME_TYPE_OLRAPI_NOTE_JSON },
              },
            );

            // Skip files without the prompt template tag
            if (!file.tags.includes("mcp-tools-prompt")) {
              return [];
            }

            const { description } = file.frontmatter;
            return {
              name: filename,
              description:
                typeof description === "string" ? description : undefined,
              arguments: parseTemplateParameters(file.content),
            };
          }),
        )
      ).flat();
      return { prompts };
    } catch (err) {
      const error = formatMcpError(err);
      logger.error("Error in ListPromptsRequestSchema handler", {
        error,
        message: error.message,
      });
      throw error;
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
    try {
      const promptFilePath = `${PROMPTS_FOLDER}/${params.name}`;

      // Get prompt content
      const { content: template, frontmatter } = await makeRequest(
        LocalRestAPI.ApiVaultFileResponse,
        `/vault/${encodeVaultPath(promptFilePath)}`,
        {
          headers: { Accept: LocalRestAPI.MIME_TYPE_OLRAPI_NOTE_JSON },
        },
      );

      const { description } = PromptFrontmatterSchema.assert(frontmatter);
      const templateParams = parseTemplateParameters(template);
      const templateParamsSchema = buildTemplateArgumentsSchema(templateParams);
      const templateArgs = templateParamsSchema(params.arguments);
      if (templateArgs instanceof type.errors) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments: ${templateArgs.summary}`,
        );
      }

      const templateExecutionArgs: LocalRestAPI.ApiTemplateExecutionParamsType =
        {
          name: promptFilePath,
          arguments: templateArgs,
        };

      // Process template through Templater plugin
      const { content } = await makeRequest(
        LocalRestAPI.ApiTemplateExecutionResponse,
        "/templates/execute",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(templateExecutionArgs),
        },
      );

      const withoutFrontmatter = stripFrontmatter(content);

      return {
        messages: [
          {
            description,
            role: "user",
            content: {
              type: "text",
              text: withoutFrontmatter,
            },
          },
        ],
      };
    } catch (err) {
      const error = formatMcpError(err);
      logger.error("Error in GetPromptRequestSchema handler", {
        error,
        message: error.message,
      });
      throw error;
    }
  });
}
