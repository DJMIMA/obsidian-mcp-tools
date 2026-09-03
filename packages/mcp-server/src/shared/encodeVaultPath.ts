/**
 * Encodes a vault-relative path for use inside a Local REST API URL path.
 *
 * Local REST API splits `req.path` on literal `/` *before* decoding each
 * segment, so `/` must stay a real separator while everything else inside a
 * segment (spaces, `#`, `?`, `%`, non-ASCII) is percent-encoded. Encoding the
 * whole path with `encodeURIComponent` turns `/` into `%2F`, which the server
 * deliberately refuses to resolve as a file path (see CLAUDE.md, 既知の問題).
 *
 * Empty segments are preserved, so a trailing `/` (directory listing) and a
 * leading `/` survive unchanged.
 */
export function encodeVaultPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
