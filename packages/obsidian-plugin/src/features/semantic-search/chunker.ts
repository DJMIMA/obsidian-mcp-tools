/** Bump when the chunking rules change. It is part of the index fingerprint, so the index is rebuilt. */
export const CHUNKER_VERSION = 1;

export interface HeadingInfo {
  heading: string;
  /** 1-6 */
  level: number;
  /** 0-based line where the heading starts. */
  line: number;
  /** 0-based last line of the heading; differs from `line` only for setext headings. */
  endLine: number;
}

export interface ChunkInput {
  path: string;
  content: string;
  /**
   * Headings as parsed by Obsidian's metadata cache. Lines that only look like
   * headings (inside code blocks, for example) are not in this list and stay body text.
   */
  headings: HeadingInfo[];
  /** 0-based line of the closing `---` of the frontmatter, or null when there is none. */
  frontmatterEndLine: number | null;
  maxChunkChars: number;
}

export interface Chunk {
  /** "note > H1 > H2" */
  breadcrumbs: string;
  /** The section as written; the first part of a section starts with its heading line. */
  text: string;
  /** What is sent to the embedding API: the breadcrumbs, a blank line, then the text. */
  embedText: string;
}

export function noteName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/**
 * Splits a note into one chunk per heading section (any depth), plus one for
 * the text before the first heading. Sections whose body is empty are skipped,
 * and sections over `maxChunkChars` are split at paragraph boundaries.
 */
export function chunkNote(input: ChunkInput): Chunk[] {
  const lines = input.content.split(/\r?\n/);
  const bodyStart = input.frontmatterEndLine === null ? 0 : input.frontmatterEndLine + 1;
  const headings = input.headings
    .filter((h) => h.line >= bodyStart && h.line < lines.length)
    .sort((a, b) => a.line - b.line);
  const sections: { trail: string[]; text: string }[] = [];

  const preambleEnd = headings.length > 0 ? headings[0].line : lines.length;
  const preamble = lines.slice(bodyStart, preambleEnd).join("\n").trim();
  if (preamble) sections.push({ trail: [], text: preamble });

  const stack: HeadingInfo[] = [];
  headings.forEach((heading, i) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
    stack.push(heading);
    const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
    const body = lines.slice(heading.endLine + 1, end).join("\n").trim();
    if (!body) return;
    sections.push({
      trail: stack.map((h) => h.heading),
      text: lines.slice(heading.line, end).join("\n").trim(),
    });
  });

  const name = noteName(input.path);
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const breadcrumbs = [name, ...section.trail].join(" > ");
    for (const part of splitText(section.text, input.maxChunkChars)) {
      chunks.push({ breadcrumbs, text: part, embedText: `${breadcrumbs}\n\n${part}` });
    }
  }
  return chunks;
}

/** Splits text into parts of at most `max` characters, preferring blank-line paragraph boundaries. */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    if (paragraph.length > max) {
      flush();
      for (let i = 0; i < paragraph.length; i += max) {
        const piece = paragraph.slice(i, i + max);
        if (piece.trim()) parts.push(piece);
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > max) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  flush();
  return parts;
}
