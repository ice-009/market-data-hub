import { inflateRawSync } from "node:zlib";

// Read the single file inside a .zip, with Node's own zlib — NSE's F&O
// bhavcopy is one CSV per zip, so a full zip library would be a dependency for
// ~40 lines of work. Sizes and offsets come from the central directory (the
// local header may defer them to a data descriptor). Only "stored" and
// "deflate" entries are supported; zip64, encryption and multi-file archives
// are refused rather than half-read. The download is untrusted, so the
// inflated size is capped. (Ported from Tradex, MIT.)

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Generous for a ~6 MB CSV; protects against a zip bomb. */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export class ZipError extends Error {}

export function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIG;
}

/** The archive's only file: its name and bytes. Throws ZipError for anything else. */
export function unzipSingle(buffer: Buffer, maxBytes = DEFAULT_MAX_BYTES): { name: string; data: Buffer } {
  if (!isZip(buffer)) throw new ZipError("not a zip file");
  // End of central directory: 22 bytes plus an optional comment of up to 64 KB, at the end.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("zip has no central directory");
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entries !== 1) throw new ZipError(`expected one file in the zip, found ${entries}`);
  if (centralOffset === 0xffffffff || centralOffset + 46 > buffer.length || buffer.readUInt32LE(centralOffset) !== CENTRAL_SIG) throw new ZipError("bad central directory");

  const flags = buffer.readUInt16LE(centralOffset + 8);
  const method = buffer.readUInt16LE(centralOffset + 10);
  const compressed = buffer.readUInt32LE(centralOffset + 20);
  const size = buffer.readUInt32LE(centralOffset + 24);
  const nameLength = buffer.readUInt16LE(centralOffset + 28);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  const name = buffer.toString("utf8", centralOffset + 46, centralOffset + 46 + nameLength);
  if (flags & 0x1) throw new ZipError("encrypted zip");
  if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("zip64 is not supported");
  if (size > maxBytes) throw new ZipError(`zip entry too large (${size} bytes)`);
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new ZipError("bad local header");

  const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
  if (start + compressed > buffer.length) throw new ZipError("zip is truncated");
  const raw = buffer.subarray(start, start + compressed);
  let data: Buffer;
  if (method === 0) data = Buffer.from(raw);
  else if (method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (error) {
      throw new ZipError(`zip entry doesn't inflate: ${(error as Error).message}`);
    }
  } else throw new ZipError(`unsupported zip compression method ${method}`);
  if (data.length !== size) throw new ZipError(`zip entry is ${data.length} bytes, expected ${size}`);
  return { name, data };
}
