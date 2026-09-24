export interface ContentPage {
  /** The requested slice, followed by a continuation hint when more remains. */
  text: string;
  totalLength: number;
  startIndex: number;
  /** End of the slice within the original content; excludes the hint. */
  endIndex: number;
  hasMore: boolean;
}

/**
 * Cuts one page out of fetched content for the `fetch` tool.
 *
 * The continuation hint is added only when content remains past this page, so
 * a caller that follows it never lands on an empty page that still claims to
 * have more.
 */
export function paginateContent(
  content: string,
  startIndex: number,
  maxLength: number,
): ContentPage {
  const totalLength = content.length;
  // Never report an end before the start: a startIndex past the end yields an
  // empty page with endIndex === startIndex.
  const endIndex = Math.max(
    startIndex,
    Math.min(startIndex + maxLength, totalLength),
  );
  const hasMore = endIndex < totalLength;

  let text = content.substring(startIndex, startIndex + maxLength);
  if (hasMore) {
    text += `\n\n<error>Content truncated. Call the fetch tool with a startIndex of ${endIndex} to get more content.</error>`;
  }

  return { text, totalLength, startIndex, endIndex, hasMore };
}
