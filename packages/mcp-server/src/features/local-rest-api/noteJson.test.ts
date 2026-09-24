import { type } from "arktype";
import { describe, expect, test } from "bun:test";
import { LocalRestAPI } from "shared";

/**
 * Local REST API returns `frontmatter` as Obsidian parsed it, so values keep
 * their YAML types. These payloads are shaped like real responses for
 * GET /vault/<path> and GET /active/ with Accept: application/vnd.olrapi.note+json.
 */
const note = (frontmatter: Record<string, unknown>, tags: string[] = []) => ({
  content: "---\n...\n---\n# Note\n",
  frontmatter,
  path: "文献/note.md",
  stat: { ctime: 1750000000000, mtime: 1750000001000, size: 42 },
  tags,
});

const schemas = {
  ApiNoteJson: LocalRestAPI.ApiNoteJson,
  ApiVaultFileResponse: LocalRestAPI.ApiVaultFileResponse,
};

for (const [name, schema] of Object.entries(schemas)) {
  describe(name, () => {
    test("accepts list, number, and boolean frontmatter values", () => {
      const data = note(
        {
          tags: ["#文献キュー"],
          aliases: ["A", "B"],
          rating: 4,
          weight: 0.5,
          draft: false,
          published: true,
        },
        ["文献キュー"],
      );

      const result = schema(data);

      expect(result).not.toBeInstanceOf(type.errors);
      expect(result).toEqual(data);
    });

    test("accepts dates, nested objects, and null values", () => {
      const data = note({
        created: "2026-06-16",
        source: { title: "Paper", year: 2024 },
        reviewed: null,
      });

      expect(schema(data)).not.toBeInstanceOf(type.errors);
    });

    test("accepts a note without frontmatter or tags", () => {
      expect(schema(note({}))).not.toBeInstanceOf(type.errors);
    });

    test("still rejects a payload missing the fields that are always present", () => {
      const { tags: _tags, ...withoutTags } = note({});
      const { stat: _stat, ...withoutStat } = note({});

      expect(schema(withoutTags)).toBeInstanceOf(type.errors);
      expect(schema(withoutStat)).toBeInstanceOf(type.errors);
      expect(schema({ ...note({}), frontmatter: "tags: x" })).toBeInstanceOf(
        type.errors,
      );
    });
  });
}
