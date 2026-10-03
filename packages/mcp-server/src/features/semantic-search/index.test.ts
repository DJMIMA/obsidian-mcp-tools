import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistryClass, type ToolRegistry } from "../../shared/ToolRegistry";
import { registerSemanticSearchTools } from ".";

const context = {
  server: new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } }),
};

let tools: ToolRegistry;
beforeEach(() => {
  tools = new ToolRegistryClass() as unknown as ToolRegistry;
  registerSemanticSearchTools(tools);
});

describe("search_vault_smart arguments", () => {
  // arktype words the error as "must be <description> (was <value>)", so the range and the value both reach the caller.
  for (const limit of [0, 51, 2.5]) {
    test(`limit ${limit} comes back as an error result that says why`, async () => {
      const result = await tools.dispatch(
        { name: "search_vault_smart", arguments: { query: "x", filter: { limit } } },
        context,
      );
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("limit must be an integer from 1 to 50");
      expect(text).toContain(`(was ${limit})`);
    });
  }

  test("the tool advertises the 1-50 range and the default of 20", () => {
    const tool = tools.list().tools.find((t) => t.name === "search_vault_smart");
    expect(JSON.stringify(tool?.inputSchema)).toContain('"maximum":50');
    expect(tool?.description).toContain("limit defaults to 20");
    expect(tool?.description).toContain("at most 2 sections from one note");
    expect(JSON.stringify(tool?.inputSchema)).toContain("maxPerNote");
  });
});
