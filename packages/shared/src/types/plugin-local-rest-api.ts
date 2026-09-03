import { type } from "arktype";

/**
 * Error response from the API
 * Content-Type: application/json
 * Used in various error responses across endpoints
 * @property errorCode - A 5-digit error code uniquely identifying this particular type of error
 * @property message - Message describing the error
 */
export const ApiError = type({
  errorCode: "number",
  message: "string",
});

/**
 * JSON representation of a note including parsed tag and frontmatter data as well as filesystem metadata
 * Content-Type: application/vnd.olrapi.note+json
 * GET /vault/{filename} or GET /active/ with Accept: application/vnd.olrapi.note+json
 */
export const ApiNoteJson = type({
  content: "string",
  frontmatter: "Record<string, string>",
  path: "string",
  stat: {
    ctime: "number",
    mtime: "number",
    size: "number",
  },
  tags: "string[]",
});

/**
 * Defines the structure of a plugin manifest, which contains metadata about a plugin.
 * This type is used to represent the response from the API's root endpoint, providing
 * basic server details and authentication status.
 */
const ApiPluginManifest = type({
  id: "string",
  name: "string",
  version: "string",
  minAppVersion: "string",
  description: "string",
  author: "string",
  authorUrl: "string",
  isDesktopOnly: "boolean",
  dir: "string",
});

/**
 * Response from the root endpoint providing basic server details and authentication status
 * Content-Type: application/json
 * GET / - This is the only API request that does not require authentication
 */
export const ApiStatusResponse = type({
  status: "string",
  manifest: ApiPluginManifest,
  versions: {
    obsidian: "string",
    self: "string",
  },
  service: "string",
  authenticated: "boolean",
  certificateInfo: {
    validityDays: "number",
    regenerateRecommended: "boolean",
  },
  apiExtensions: ApiPluginManifest.array(),
});

/**
 * Response from searching vault files using advanced search
 * Content-Type: application/json
 * POST /search/
 * Returns array of matching files and their results
 * Results are only returned for non-falsy matches
 */
export const ApiSearchResponse = type({
  filename: "string",
  result: "string|number|string[]|object|boolean",
}).array();

/**
 * Match details for simple text search results
 * Content-Type: application/json
 * Used in ApiSimpleSearchResult
 */
export const ApiSimpleSearchMatch = type({
  match: {
    start: "number",
    end: "number",
  },
  context: "string",
});

/**
 * Result from searching vault files with simple text search
 * Content-Type: application/json
 * POST /search/simple/
 * Returns matches with surrounding context
 */
export const ApiSimpleSearchResponse = type({
  filename: "string",
  matches: ApiSimpleSearchMatch.array(),
  score: "number",
}).array();

/**
 * Result entry from semantic search
 * Content-Type: application/json
 * Used in ApiSearchResponse
 */
export const ApiSmartSearchResult = type({
  path: "string",
  text: "string",
  score: "number",
  breadcrumbs: "string",
});

/**
 * Response from semantic search containing list of matching results
 * Content-Type: application/json
 * POST /search/smart/
 */
export const ApiSmartSearchResponse = type({
  results: ApiSmartSearchResult.array(),
});

/**
 * Parameters for semantic search request
 * Content-Type: application/json
 * POST /search/smart/
 * @property query - A search phrase for semantic search
 * @property filter.folders - An array of folder names to include. For example, ["Public", "Work"]
 * @property filter.excludeFolders - An array of folder names to exclude. For example, ["Private", "Archive"]
 * @property filter.limit - The maximum number of results to return
 */
export const ApiSearchParameters = type({
  query: "string",
  filter: {
    folders: "string[]?",
    excludeFolders: "string[]?",
    limit: "number?",
  },
});

/**
 * Command information from Obsidian's command palette
 * Content-Type: application/json
 * Used in ApiCommandsResponse
 */
export const ApiCommand = type({
  id: "string",
  name: "string",
});

/**
 * Response containing list of available Obsidian commands
 * Content-Type: application/json
 * GET /commands/
 */
export const ApiCommandsResponse = type({
  commands: ApiCommand.array(),
});

/**
 * Response containing list of files in a vault directory
 * Content-Type: application/json
 * GET /vault/ or GET /vault/{pathToDirectory}/
 * Note that empty directories will not be returned
 */
export const ApiVaultDirectoryResponse = type({
  files: "string[]",
});

/**
 * Response containing vault file information
 * Content-Type: application/json
 * POST /vault/{pathToFile}
 * Returns array of matching files and their results
 * Results are only returned for non-falsy matches
 */
export const ApiVaultFileResponse = type({
  frontmatter: {
    tags: "string[]",
    description: "string?",
  },
  content: "string",
  path: "string",
  stat: {
    ctime: "number",
    mtime: "number",
    size: "number",
  },
  tags: "string[]",
});

/**
 * Parameters for patching a file or document in the Obsidian plugin's REST API.
 * This type defines the expected request body for the patch operation.
 *
 * @property operation - Specifies how to modify the content: append (add after), prepend (add before), or replace existing content
 * @property targetType - Identifies what to modify: a section under a heading, a referenced block, or a frontmatter field
 * @property target - The identifier - either heading path (e.g. 'Heading 1::Subheading 1:1'), block reference ID, or frontmatter field name
 * @property targetDelimiter - The separator used in heading paths to indicate nesting (default '::')
 * @property trimTargetWhitespace - Whether to remove whitespace from target identifier before matching (default: false)
 * @property content - The actual content to insert, append, or use as replacement
 * @property contentType - Format of the content - use application/json for structured data like table rows or frontmatter values
 */
export const ApiPatchParameters = type({
  operation: type("'append' | 'prepend' | 'replace' | 'delete'").describe(
    "How to modify the targeted span: append (insert after), prepend (insert before), replace it, or delete it",
  ),
  targetType: type("'heading' | 'block' | 'frontmatter'").describe(
    "Identifies what to modify: a section under a heading, a referenced block, or a frontmatter field",
  ),
  target: type("string | string[]").describe(
    "The node to edit. Heading: an array of heading texts from the top level down (e.g. ['Heading 1', 'Subheading 1:1']), or the same path as one string joined with targetDelimiter ('Heading 1::Subheading 1:1'). A partial path (just the leaf heading, or the last few levels) is accepted when it identifies exactly one heading; if it is ambiguous the call fails and lists the candidates. Heading text must match exactly (case, spaces, emoji). An empty string or [] addresses the document root. Block: the block id without '^'. Frontmatter: the field name",
  ),
  "targetDelimiter?": type("string").describe(
    "Separator used when a heading target is given as a single string (default '::'). Ignored when target is an array",
  ),
  "scope?": type("'content' | 'marker' | 'markerAndContent'").describe(
    "Which part of the target to act on (default 'content'). content: the body below a heading, the block body, or the field value. marker: the label only, i.e. the heading text, block id, or frontmatter key (replace renames it; do not include '#'). markerAndContent: the heading line together with its whole section (prepend/append insert a sibling section)",
  ),
  "within?": type("number").describe(
    "Heading targets only: pick one of the section's top-level body blocks by 0-based index (negative counts from the end, -1 = last) and edit that block in place, e.g. append '\\n- item' to continue a list. Cannot be combined with createTargetIfMissing",
  ),
  "trimTargetWhitespace?": type("boolean").describe(
    "Trim whitespace around each heading segment when target is given as a string (default: false)",
  ),
  "content?": type("string").describe(
    "The payload to insert, append, or use as replacement. Required unless operation is delete. Heading levels inside it are relative to the target",
  ),
  "contentType?": type("'text/markdown' | 'application/json'").describe(
    "Format of content. Use application/json to send structured data: table rows (a 2-D array of strings) for a block, or a typed value (list, object, number, ...) for a frontmatter field",
  ),
  "createTargetIfMissing?": type("boolean").describe(
    "Create the heading path, block, or frontmatter key if it does not exist (default: false). A heading path is created from the top level exactly as given, so pass the full path. Only set this when you have confirmed the target is absent; a missing heading otherwise fails without writing and lists the headings that do exist",
  ),
  "rejectIfContentPreexists?": type("boolean").describe(
    "Fail an append/prepend when the content already appears in the target, which makes retries idempotent (default: false)",
  ),
});
export type ApiPatchParametersType = typeof ApiPatchParameters.infer;

/**
 * Represents a response containing markdown content
 */
export const ApiContentResponse = type("string").describe("Content");

/**
 * Empty response for successful operations that don't return content
 * Content-Type: none (204 No Content)
 * Used by:
 * - PUT /vault/{filename}
 * - PUT /active/
 * - PUT /periodic/{period}/
 * - POST /commands/{commandId}/
 * - DELETE endpoints
 * Returns 204 No Content
 */
export const ApiNoContentResponse = type("unknown").describe("No Content");

/**
 * Parameters for executing a template
 * Content-Type: application/json
 * POST /templates/execute/
 * @property name - The name of the template to execute
 * @property arguments - A key-value object of arguments to pass to the template
 * @property createFile - Whether to create a new file from the template
 * @property targetPath - The path to save the file; required if createFile is true
 */
export const ApiTemplateExecutionParams = type({
  name: type("string").describe("The full vault path to the template file"),
  arguments: "Record<string, string>",
  "createFile?": type("boolean").describe(
    "Whether to create a new file from the template",
  ),
  "targetPath?": type("string").describe(
    "Path to save the file; required if createFile is true",
  ),
});

/**
 * Response from executing a template
 * Content-Type: application/json
 * POST /templates/execute/
 * @property message - A message describing the result of the template execution
 */
export const ApiTemplateExecutionResponse = type({
  message: "string",
  content: "string",
});

// Export types for TypeScript usage
export type ApiErrorType = typeof ApiError.infer;
export type ApiNoteJsonType = typeof ApiNoteJson.infer;
export type ApiStatusResponseType = typeof ApiStatusResponse.infer;
export type ApiSearchResponseType = typeof ApiSearchResponse.infer;
export type ApiSimpleSearchResponseType = typeof ApiSimpleSearchResponse.infer;
export type ApiSmartSearchResultType = typeof ApiSmartSearchResult.infer;
export type ApiSmartSearchResponseType = typeof ApiSmartSearchResponse.infer;
export type ApiCommandType = typeof ApiCommand.infer;
export type ApiCommandsResponseType = typeof ApiCommandsResponse.infer;
export type ApiVaultDirectoryResponseType =
  typeof ApiVaultDirectoryResponse.infer;
export type ApiVaultFileResponseType = typeof ApiVaultFileResponse.infer;
export type ApiSearchParametersType = typeof ApiSearchParameters.infer;
export type ApiNoContentResponseType = typeof ApiNoContentResponse.infer;
export type ApiTemplateExecutionParamsType =
  typeof ApiTemplateExecutionParams.infer;
export type ApiTemplateExecutionResponseType =
  typeof ApiTemplateExecutionResponse.infer;

// Additional API response types can be added here
export const MIME_TYPE_OLRAPI_NOTE_JSON = "application/vnd.olrapi.note+json";

export const MIME_TYPE_OLRAPI_DOCUMENT_MAP_JSON =
  "application/vnd.olrapi.document-map+json";

/**
 * Document map of a note: the outline the markdown-patch 2.0 engine matches
 * heading targets against.
 * Content-Type: application/vnd.olrapi.document-map+json
 * GET /vault/{filename} or GET /active/ with Accept: application/vnd.olrapi.document-map+json
 * @property version - Content-hash token; send it back as a PATCH `ifMatch` for a conditional edit
 * @property headings - Nested `{ "H1 text": { "H2 text": {} } }` tree of heading texts
 * @property blocks - Block reference ids without the leading `^`
 */
export const ApiDocumentMapResponse = type({
  version: "string",
  frontmatterFields: "string[]",
  headings: "Record<string, unknown>",
  blocks: "string[]",
});
export type ApiDocumentMapResponseType = typeof ApiDocumentMapResponse.infer;
