/**
 * Removes a leading YAML frontmatter block (`---` … `---`) from a note.
 *
 * Only a block at the very start counts, so a `---` horizontal rule in the
 * body is kept along with everything around it.
 */
export function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return (match ? content.slice(match[0].length) : content).trim();
}
