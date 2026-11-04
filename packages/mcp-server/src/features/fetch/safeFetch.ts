import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_REDIRECTS = 5;
/** A page larger than this is cut; the fetch tool returns at most a few thousand characters at a time anyway. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;

/** A URL the fetch tool will not read. The message is shown to the model. */
export class FetchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefusedError";
  }
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

// Loopback, private, link-local, CGNAT, benchmarking, multicast and reserved ranges.
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedV4(value: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((ipv4ToInt(base)! & mask) >>> 0);
  });
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function expandIpv6(address: string): number[] | null {
  let text = address.split("%")[0].toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const value = ipv4ToInt(v4[1]);
    if (value === null) return null;
    text = `${text.slice(0, -v4[1].length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * True for addresses that are not on the public internet: loopback (the
 * Local REST API itself), private networks (routers, NAS), link-local and
 * cloud metadata (169.254.169.254), multicast and reserved ranges, including
 * IPv4 addresses embedded in IPv6 (::ffff:127.0.0.1, NAT64, 6to4).
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = ipv4ToInt(address);
  if (v4 !== null) return isBlockedV4(v4);
  const groups = expandIpv6(address);
  if (!groups) return true; // not an address we understand: do not connect
  const embeddedV4 = (high: number, low: number) => isBlockedV4(((high << 16) | low) >>> 0);
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const zeroUpTo = (n: number) => groups.slice(0, n).every((group) => group === 0);
  if (zeroUpTo(8)) return true; // ::
  if (zeroUpTo(7) && g7 === 1) return true; // ::1
  if (zeroUpTo(5) && g5 === 0xffff) return embeddedV4(g6, g7); // ::ffff:a.b.c.d
  if (zeroUpTo(6)) return embeddedV4(g6, g7); // ::a.b.c.d (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embeddedV4(g6, g7); // NAT64
  if (g0 === 0x2002) return embeddedV4(g1, g2); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Decides whether a host may be contacted; tests replace it to allow a local server. */
export type AddressPolicy = (url: URL, address: string) => boolean;

export const publicOnly: AddressPolicy = (_url, address) => !isPrivateAddress(address);
export const anyAddress: AddressPolicy = () => true;

async function assertAllowed(url: URL, allowed: AddressPolicy): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchRefusedError(
      `Only http and https URLs can be fetched; ${url.protocol} is not allowed.`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  const refused = addresses.find((address) => !allowed(url, address));
  if (refused !== undefined) {
    throw new FetchRefusedError(
      `${url.hostname} resolves to ${refused}, a loopback, private or link-local address; the fetch tool only reads public web pages. ` +
        "Set OBSIDIAN_MCP_FETCH_ALLOW_PRIVATE=true in the MCP server's env to allow it.",
    );
  }
}

async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

export interface FetchedPage {
  /** The URL the content came from, after redirects. */
  url: string;
  status: number;
  contentType: string;
  text: string;
  /** True when the body was longer than maxBytes and was cut. */
  truncated: boolean;
}

/**
 * GETs a web page for the fetch tool. Only http(s) URLs whose host resolves
 * to public addresses are read, redirects are followed one hop at a time and
 * checked the same way, and the body is cut at `maxBytes`.
 *
 * The check and the connection resolve the host separately, so a DNS answer
 * that changes in between (rebinding) is not caught.
 */
export async function fetchPage(
  input: string,
  options: {
    userAgent: string;
    allowed?: AddressPolicy;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<FetchedPage> {
  const allowed = options.allowed ?? publicOnly;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchRefusedError(`Not an absolute URL: ${input}`);
  }
  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);

  for (let hop = 0; ; hop++) {
    await assertAllowed(url, allowed);
    const response = await fetch(url, {
      headers: { "User-Agent": options.userAgent },
      redirect: "manual",
      signal,
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) {
        throw new FetchRefusedError(`Too many redirects (more than ${MAX_REDIRECTS}).`);
      }
      url = new URL(location, url);
      continue;
    }
    const { text, truncated } = await readLimited(
      response,
      options.maxBytes ?? MAX_BODY_BYTES,
    );
    return {
      url: url.href,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
      truncated,
    };
  }
}
