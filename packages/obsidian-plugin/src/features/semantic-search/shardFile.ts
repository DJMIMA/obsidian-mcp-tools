import type { NoteRecord } from "./indexStore";

const MAGIC = "MCPIDX01";
const HEADER_START = 12;
export const SHARD_FORMAT_VERSION = 1;

interface ShardHeader {
  formatVersion: number;
  fingerprint: string;
  dimension: number;
  shard: number;
  notes: Record<
    string,
    {
      mtime: number;
      size: number;
      hash: string;
      status: "ok" | "failed";
      error?: string;
      chunks: { breadcrumbs: string; text: string; textHash: string; slot: number }[];
    }
  >;
}

/**
 * Layout (little-endian): "MCPIDX01", u32 JSON byte length, JSON header,
 * zero padding to a 4-byte boundary, then Float32 vectors where chunk `slot`
 * starts at slot * dimension. Slots are assigned afresh on every write.
 */
export function encodeShard(args: {
  fingerprint: string;
  dimension: number;
  shard: number;
  notes: [string, NoteRecord][];
}): ArrayBuffer {
  const header: ShardHeader = {
    formatVersion: SHARD_FORMAT_VERSION,
    fingerprint: args.fingerprint,
    dimension: args.dimension,
    shard: args.shard,
    notes: {},
  };
  const vectors: Float32Array[] = [];
  for (const [path, record] of args.notes) {
    header.notes[path] = {
      mtime: record.mtime,
      size: record.size,
      hash: record.hash,
      status: record.status,
      ...(record.error !== undefined ? { error: record.error } : {}),
      chunks: record.chunks.map((chunk) => {
        const slot = vectors.length;
        vectors.push(chunk.vector);
        return { breadcrumbs: chunk.breadcrumbs, text: chunk.text, textHash: chunk.textHash, slot };
      }),
    };
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const vectorStart = Math.ceil((HEADER_START + json.length) / 4) * 4;
  const buffer = new ArrayBuffer(vectorStart + vectors.length * args.dimension * 4);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);
  new DataView(buffer).setUint32(8, json.length, true);
  bytes.set(json, HEADER_START);
  const floats = new Float32Array(buffer, vectorStart, vectors.length * args.dimension);
  vectors.forEach((vector, slot) => floats.set(vector, slot * args.dimension));
  return buffer;
}

export type DecodedShard =
  | { ok: true; fingerprint: string; dimension: number; shard: number; notes: [string, NoteRecord][] }
  | { ok: false; reason: string };

export function decodeShard(buffer: ArrayBuffer): DecodedShard {
  try {
    if (buffer.byteLength < HEADER_START) return { ok: false, reason: "file too short" };
    const bytes = new Uint8Array(buffer);
    const magic = Array.from(bytes.subarray(0, 8), (c) => String.fromCharCode(c)).join("");
    if (magic !== MAGIC) return { ok: false, reason: "bad magic" };
    const jsonLength = new DataView(buffer).getUint32(8, true);
    if (HEADER_START + jsonLength > buffer.byteLength) return { ok: false, reason: "header runs past the end" };
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(HEADER_START, HEADER_START + jsonLength)),
    ) as ShardHeader;
    if (header.formatVersion !== SHARD_FORMAT_VERSION) {
      return { ok: false, reason: `format version ${header.formatVersion}` };
    }
    const vectorStart = Math.ceil((HEADER_START + jsonLength) / 4) * 4;
    const floatCount = Math.max(0, Math.floor((buffer.byteLength - vectorStart) / 4));
    const floats = vectorStart <= buffer.byteLength ? new Float32Array(buffer, vectorStart, floatCount) : new Float32Array(0);
    const dimension = header.dimension;
    const notes: [string, NoteRecord][] = Object.entries(header.notes).map(([path, note]) => [
      path,
      {
        mtime: note.mtime,
        size: note.size,
        hash: note.hash,
        status: note.status,
        ...(note.error !== undefined ? { error: note.error } : {}),
        chunks: note.chunks.map((chunk) => {
          const start = chunk.slot * dimension;
          if (start + dimension > floats.length) throw new Error(`slot ${chunk.slot} is past the end`);
          return {
            breadcrumbs: chunk.breadcrumbs,
            text: chunk.text,
            textHash: chunk.textHash,
            vector: floats.slice(start, start + dimension),
          };
        }),
      },
    ]);
    return { ok: true, fingerprint: header.fingerprint, dimension, shard: header.shard, notes };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
