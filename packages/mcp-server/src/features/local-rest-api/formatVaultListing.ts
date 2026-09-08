import type { LocalRestAPI } from "shared";

type VaultListing =
  | LocalRestAPI.ApiVaultDirectoryResponseType
  | LocalRestAPI.ApiVaultFileResponseType;

/**
 * Renders the response of `list_vault_files`.
 *
 * A directory listing carries `count` alongside `files` so a caller can tell a
 * complete listing from a truncated one without guessing from where the list
 * happens to end. The Local REST API applies no limit, so there is nothing to
 * page through. A single-file response is passed through unchanged.
 */
export function formatVaultListing(data: VaultListing): string {
  if ("files" in data && Array.isArray(data.files)) {
    return JSON.stringify(
      { count: data.files.length, files: data.files },
      null,
      2,
    );
  }
  return JSON.stringify(data, null, 2);
}
