import { type } from "arktype";
import type { Request, Response } from "express";
import { normalizePath, Notice, Plugin, TFile } from "obsidian";
import { lastValueFrom } from "rxjs";
import {
  LocalRestAPI,
  Templater,
  vaultPathProblem,
  type PromptArgAccessor,
} from "shared";
import { setup as setupCore } from "./features/core";
import { setup as setupMcpServerInstall } from "./features/mcp-server-install";
import { SemanticSearchFeature } from "./features/semantic-search";
import {
  protectedFolders,
  targetRefusal,
  templateRefusal,
  type TemplaterFolders,
} from "./features/templates/policy";
import {
  loadLocalRestAPI,
  loadTemplaterAPI,
  type Dependencies,
} from "./shared";
import { logger } from "./shared/logger";

export default class McpToolsPlugin extends Plugin {
  semanticSearch!: SemanticSearchFeature;

  private localRestApi: Dependencies["obsidian-local-rest-api"] = {
    id: "obsidian-local-rest-api",
    name: "Local REST API",
    required: true,
    installed: false,
  };

  /** The template run in progress; the next one waits for it (see handleTemplateExecution). */
  private templateRun: Promise<unknown> = Promise.resolve();

  async getLocalRestApiKey(): Promise<string | undefined> {
    // The API key is stored in the plugin's settings
    return this.localRestApi.plugin?.settings?.apiKey;
  }

  async onload() {
    this.semanticSearch = new SemanticSearchFeature(this);
    await this.semanticSearch.load();

    // Initialize features in order
    await setupCore(this);
    await setupMcpServerInstall(this);

    // Check for required dependencies
    lastValueFrom(loadLocalRestAPI(this)).then((localRestApi) => {
      this.localRestApi = localRestApi;

      if (!this.localRestApi.api) {
        new Notice(
          `${this.manifest.name}: Local REST API plugin is required but not found. Please install it from the community plugins and restart Obsidian.`,
          0,
        );
        return;
      }

      // Register endpoints. addRoute requires the API key, like Local REST API's own routes.
      this.localRestApi.api
        .addRoute("/search/smart")
        .post((req, res) => void this.semanticSearch.handleSearchRoute(req, res));

      // どちらのハンドラも内部で例外を捕まえて応答を返すので、Promise は待たない
      this.localRestApi.api
        .addRoute("/templates/execute")
        .post((req, res) => void this.handleTemplateExecution(req, res));

      // The MCP server refuses writes into these folders; see protectedFolders.
      this.localRestApi.api
        .addRoute("/mcp-tools/protected-folders")
        .get((_req, res) => {
          res.json({ folders: protectedFolders(this.templaterFolders()) });
        });

      logger.info("MCP Tools Plugin loaded");
    }).catch((error) => {
      logger.error("Failed to load Local REST API", { error });
    });
  }

  private templaterFolders(): TemplaterFolders {
    const settings = this.app.plugins.plugins["templater-obsidian"]?.settings;
    return {
      templates: settings?.templates_folder,
      userScripts: settings?.user_scripts_folder,
    };
  }

  /**
   * Renders a template for the MCP server. Templater runs a template's
   * contents as JavaScript with Obsidian's full access, so only templates in
   * the Templater templates folder or Prompts/ are run (the MCP server cannot
   * write to either), and the output is never saved into those folders.
   */
  private async handleTemplateExecution(req: Request, res: Response) {
    try {
      const { api: templater } = await lastValueFrom(loadTemplaterAPI(this));
      if (!templater) {
        new Notice(
          `${this.manifest.name}: Templater plugin is not available. Please install it from the community plugins.`,
          0,
        );
        logger.error("Templater plugin is not available");
        res.status(503).json({
          message: "Templater plugin is not available",
        });
        return;
      }

      // Validate request body
      const params = LocalRestAPI.ApiTemplateExecutionParams(req.body);

      if (params instanceof type.errors) {
        logger.debug("Invalid request body", { summary: params.summary });
        res.status(400).json({
          message: `Invalid request body: ${params.summary}`,
        });
        return;
      }

      const nameProblem = vaultPathProblem(params.name);
      if (nameProblem) {
        res.status(400).json({
          message: `Refused template path "${params.name}": ${nameProblem}.`,
        });
        return;
      }

      // Get prompt content from vault
      const templateFile = this.app.vault.getAbstractFileByPath(params.name);
      if (!(templateFile instanceof TFile)) {
        logger.debug("Template file not found", { name: params.name });
        res.status(404).json({
          message: `File not found: ${params.name}`,
        });
        return;
      }

      const saveTo =
        params.createFile && params.targetPath ? params.targetPath : null;
      const folders = this.templaterFolders();
      const refusal =
        templateRefusal(templateFile.path, folders) ??
        (saveTo === null ? null : targetRefusal(saveTo, folders));
      if (refusal) {
        logger.info("Refused template execution", { refusal });
        res.status(403).json({ message: refusal });
        return;
      }

      // Templater has one functions generator, patched for the length of a
      // run; overlapping runs would see each other's arguments and restore the
      // wrong generator, so they go one at a time.
      const run = this.templateRun.then(() =>
        this.renderTemplate(templater, templateFile, params.arguments),
      );
      this.templateRun = run.catch(() => undefined);
      const processedContent = await run;

      // Create new file if requested
      if (saveTo !== null) {
        await this.app.vault.create(normalizePath(saveTo), processedContent);
        res.json({
          message: "Prompt executed and file created successfully",
          content: processedContent,
        });
        return;
      }

      res.json({
        message: "Prompt executed without creating a file",
        content: processedContent,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Prompt execution error:", { error: message });
      res.status(500).json({
        message: `An error occurred while processing the prompt: ${message}`,
      });
    }
  }

  /** Renders `templateFile` with `tp.mcpTools.prompt(name)` returning `args[name]`. */
  private async renderTemplate(
    templater: Templater.ITemplater,
    templateFile: TFile,
    args: Record<string, string>,
  ): Promise<string> {
    const config = templater.create_running_config(
      templateFile,
      templateFile,
      Templater.RunMode.CreateNewFromTemplate,
    );

    const prompt: PromptArgAccessor = (argName: string) => {
      return args[argName] ?? "";
    };

    const generator = templater.functions_generator;
    const original = generator.generate_object;

    // Override generate_object to inject arg into user functions
    generator.generate_object = async function (config, functions_mode) {
      const functions = await original.call(generator, config, functions_mode);
      Object.assign(functions, { mcpTools: { prompt } });
      return functions;
    };

    try {
      return await templater.read_and_parse_template(config);
    } finally {
      // Restore it even when the template throws, so user-run templates never see mcpTools
      generator.generate_object = original;
    }
  }

  onunload() {
    this.semanticSearch?.dispose();
    this.localRestApi.api?.unregister();
  }
}
