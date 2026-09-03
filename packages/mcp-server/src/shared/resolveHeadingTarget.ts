/**
 * Client-side resolution of heading targets against a document map.
 *
 * markdown-patch 2.0 (Local REST API 5.x) addresses a heading by its *full*
 * path from the top level down. A partial path such as `["Plain"]` is taken
 * literally as "an H1 named Plain", so with `createTargetIfMissing` it silently
 * appends a brand-new heading tree at the end of the file instead of touching
 * the existing `## Plain`. To make the tool safe for callers that only know
 * the leaf heading, we fetch the document map first and widen a partial path
 * to the unique full path it is a suffix of.
 */

export type HeadingPath = string[];

export type HeadingResolution =
  | { kind: "exact"; path: HeadingPath }
  | { kind: "suffix"; path: HeadingPath }
  | { kind: "ambiguous"; candidates: HeadingPath[] }
  | { kind: "absent" };

/**
 * Flattens the `headings` tree of a document map (`{ "H1": { "H2": {} } }`)
 * into full paths in document order, parents before children.
 */
export function listHeadingPaths(
  tree: unknown,
  prefix: HeadingPath = [],
): HeadingPath[] {
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    return [];
  }
  const paths: HeadingPath[] = [];
  for (const [text, children] of Object.entries(tree)) {
    const path = [...prefix, text];
    paths.push(path);
    paths.push(...listHeadingPaths(children, path));
  }
  return paths;
}

const endsWith = (path: HeadingPath, suffix: HeadingPath): boolean =>
  suffix.length <= path.length &&
  suffix.every((s, i) => path[path.length - suffix.length + i] === s);

/**
 * Matches a requested heading path against the paths that exist in the
 * document. An exact full-path match wins; otherwise the request is treated
 * as the tail of a longer path and must match exactly one heading.
 */
export function resolveHeadingPath(
  paths: HeadingPath[],
  requested: HeadingPath,
): HeadingResolution {
  if (requested.length === 0) return { kind: "exact", path: [] };
  const exact = paths.find(
    (p) => p.length === requested.length && endsWith(p, requested),
  );
  if (exact) return { kind: "exact", path: exact };
  const candidates = paths.filter(
    (p) => p.length > requested.length && endsWith(p, requested),
  );
  if (candidates.length === 1) return { kind: "suffix", path: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "absent" };
}

/** Renders a path the way the tool accepts it back (`A::B::C`). */
export function formatHeadingPath(path: HeadingPath): string {
  if (path.length === 0) return "(document root)";
  return path.some((s) => s.includes("::"))
    ? JSON.stringify(path)
    : path.join("::");
}
