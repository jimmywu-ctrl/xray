import { decompress as decodeZstdFrame } from "fzstd";

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

/** Decode raw WeChat payloads; only content type 4 is treated as a Zstandard frame. */
export function decompressContent(content: unknown, contentType: number | null): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (!(content instanceof Uint8Array)) return String(content);

  if (contentType !== 4) return utf8(content);
  try {
    return utf8(decodeZstdFrame(content));
  } catch {
    return null;
  }
}
