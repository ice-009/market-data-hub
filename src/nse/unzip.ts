import { inflateRawSync } from "node:zlib";

// Read files out of a .zip with Node's own zlib — NSE's bhavcopies are one CSV
// per zip and the daily PR zip is a dozen small files, so a full zip library
// would be a dependency for ~60 lines of work. Sizes and offsets come from the
// central directory (the local header may defer them to a data descriptor).
// Only "stored" and "deflate" entries are supported; zip64 and encryption are
// refused rather than half-read. The download is untrusted, so the inflated
// size is capped. (Ported from Tradex, MIT.)

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Generous for a ~6 MB CSV; protects against a zip bomb. */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export class ZipError extends Error {}

export function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIG;
}

interface Entry {
  name: string;
  flags: number;
  method: number;
  compressed: number;
  size: number;
  localOffset: number;
}

/** The central directory: where it starts and how many entries it says it has. */
function directory(buffer: Buffer): { entries: number; offset: number } {
  if (!isZip(buffer)) throw new ZipError("not a zip file");
  // End of central directory: 22 bytes plus an optional comment of up to 64 KB, at the end.
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return { entries: buffer.readUInt16LE(i + 10), offset: buffer.readUInt32LE(i + 16) };
  }
  throw new ZipError("zip has no central directory");
}

/** `count` central-directory records from `offset`. */
function readEntries(buffer: Buffer, offset: number, count: number): Entry[] {
  const entries: Entry[] = [];
  let at = offset;
  for (let n = 0; n < count; n += 1) {
    if (at === 0xffffffff || at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIG) throw new ZipError("bad central directory");
    const nameLength = buffer.readUInt16LE(at + 28);
    entries.push({
      name: buffer.toString("utf8", at + 46, at + 46 + nameLength),
      flags: buffer.readUInt16LE(at + 8),
      method: buffer.readUInt16LE(at + 10),
      compressed: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      localOffset: buffer.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return entries;
}

function inflate(buffer: Buffer, entry: Entry, maxBytes: number): Buffer {
  const { flags, method, compressed, size, localOffset } = entry;
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
  return data;
}

/** The archive's only file: its name and bytes. Throws ZipError for anything else. */
export function unzipSingle(buffer: Buffer, maxBytes = DEFAULT_MAX_BYTES): { name: string; data: Buffer } {
  const { entries, offset } = directory(buffer);
  if (entries !== 1) throw new ZipError(`expected one file in the zip, found ${entries}`);
  const [entry] = readEntries(buffer, offset, 1);
  return { name: entry.name, data: inflate(buffer, entry, maxBytes) };
}

/**
 * The first file whose name (without any folder) `matches`, or null when there
 * is none. Only that file is inflated. Throws ZipError when the zip is broken.
 */
export function unzipFile(buffer: Buffer, matches: (name: string) => boolean, maxBytes = DEFAULT_MAX_BYTES): { name: string; data: Buffer } | null {
  const { entries, offset } = directory(buffer);
  const entry = readEntries(buffer, offset, entries).find((candidate) => matches(candidate.name.split("/").pop()!));
  return entry ? { name: entry.name, data: inflate(buffer, entry, maxBytes) } : null;
}
