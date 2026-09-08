import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { type } from "arktype";
import { beforeEach, describe, expect, test } from "bun:test";
import { ObsidianApiError } from "./describeApiError";
import { ToolRegistryClass, type ToolRegistry } from "./ToolRegistry";

const context = {
  server: new Server(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  ),
};

let tools: ToolRegistry;

beforeEach(() => {
  tools = new ToolRegistryClass() as unknown as ToolRegistry;
});

const echoSchema = type({
  name: '"echo"',
  arguments: { text: "string" },
}).describe("Echoes its argument");

describe("ToolRegistry.dispatch", () => {
  test("returns a successful handler result unchanged", async () => {
    tools.register(echoSchema, async ({ arguments: args }) => ({
      content: [{ type: "text" as const, text: args.text }],
    }));

    const result = await tools.dispatch(
      { name: "echo", arguments: { text: "hi" } },
      context,
    );

    expect(result).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  test("reports a failing handler as an error result instead of throwing", async () => {
    tools.register(echoSchema, async () => {
      throw new ObsidianApiError("File not found: notes/a.md", { status: 404 });
    });

    const result = await tools.dispatch(
      { name: "echo", arguments: { text: "hi" } },
      context,
    );

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "File not found: notes/a.md" }],
    });
  });

  test("reports invalid arguments as an error result naming the argument", async () => {
    tools.register(echoSchema, async () => ({
      content: [{ type: "text" as const, text: "never reached" }],
    }));

    const result = (await tools.dispatch(
      { name: "echo", arguments: { text: 42 } },
      context,
    )) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("text");
  });

  test("still rejects an unknown tool as a protocol error", async () => {
    tools.register(echoSchema, async () => ({
      content: [{ type: "text" as const, text: "hi" }],
    }));

    expect(
      tools.dispatch({ name: "nope", arguments: {} }, context),
    ).rejects.toBeInstanceOf(McpError);
  });
});
