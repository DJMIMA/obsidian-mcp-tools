import {
  assertVaultPath,
  assertWritable,
  encodeVaultPath,
  formatMcpError,
  makeRequest,
  parseTemplateParameters,
  type ToolRegistry,
} from "$/shared";
import { type } from "arktype";
import { buildTemplateArgumentsSchema, LocalRestAPI } from "shared";

export function registerTemplaterTools(tools: ToolRegistry) {
  tools.register(
    type({
      name: '"execute_template"',
      arguments: LocalRestAPI.ApiTemplateExecutionParams.omit("createFile").and(
        {
          // should be boolean but the MCP client returns a string
          "createFile?": type("'true'|'false'").describe(
            "'true' to also save the output to targetPath as a new file (fails if that file exists)",
          ),
        },
      ),
    }).describe(
      'Render a Templater template stored in the vault and return { message, content } with the rendered text. name is the template\'s vault path; only templates inside the Templater templates folder or Prompts/ can be run. arguments supplies the values read by tp.mcpTools.prompt("<argument name>") calls in the template; an argument that is not supplied renders as an empty string. With createFile \'true\' and a targetPath, the output is also saved as a new file (not inside the templates, user scripts or Prompts folders); without targetPath nothing is saved.',
    ),
    async ({ arguments: args }) => {
      if (args.createFile === "true" && args.targetPath) {
        assertVaultPath(args.targetPath);
        await assertWritable(args.targetPath);
      }

      // Get prompt content
      const data = await makeRequest(
        LocalRestAPI.ApiVaultFileResponse,
        `/vault/${encodeVaultPath(args.name)}`,
        {
          headers: { Accept: LocalRestAPI.MIME_TYPE_OLRAPI_NOTE_JSON },
        },
      );

      // Validate prompt arguments
      const templateParameters = parseTemplateParameters(data.content);
      const validArgs = buildTemplateArgumentsSchema(templateParameters)(
        args.arguments,
      );
      if (validArgs instanceof type.errors) {
        throw formatMcpError(validArgs);
      }

      const templateExecutionArgs: {
        name: string;
        arguments: Record<string, string>;
        createFile: boolean;
        targetPath?: string;
      } = {
        name: args.name,
        arguments: validArgs,
        createFile: args.createFile === "true",
        targetPath: args.targetPath,
      };

      // Process template through Templater plugin
      const response = await makeRequest(
        LocalRestAPI.ApiTemplateExecutionResponse,
        "/templates/execute",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(templateExecutionArgs),
        },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
