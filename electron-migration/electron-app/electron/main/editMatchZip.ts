/**
 * A minimal, dependency-free ZIP reader/writer.
 *
 * NOT a port of any one Rust source file — the Rust side reaches for the
 * external `zip` crate wherever it reads or rewrites one entry of an Office
 * `.docx` archive while leaving every other entry alone
 * (`extraction::zip_entry_names`/`read_zip_entry`, `docx::docx_replace_text`).
 * This project has no ZIP dependency in `package.json`, and Office documents
 * are ordinary (non-zip64, non-encrypted) archives, so this implements just
 * enough of the format to serve `editMatchDocx.ts`: list entries, read one
 * entry's decompressed bytes, and rebuild an archive that changes exactly one
 * entry while copying every other entry's COMPRESSED BYTES through unchanged.
 *
 * Supports compression methods 0 (store) and 8 (deflate) for reading, and
 * writes deflate. Does not support zip64 (>4 GiB entries/archives) or
 * encrypted entries — an Office document using either would be pathological,
 * and this throws a clear error rather than misreading one.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipEntry {
  readonly name: string;
  /** 0 = stored, 8 = deflated. */
  readonly method: number;
  readonly crc32: number;
  readonly uncompressedSize: number;
  /** The entry's compressed bytes, exactly as they sit in the archive —
   * never decompressed, never re-encoded. */
  readonly compressedData: Buffer;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Locate and parse the End Of Central Directory record. Scans backward from
 * the end of the buffer (a trailing comment can push it earlier than the
 * final 22 bytes, but never before `length - 22 - 65535`). */
function findEocd(buf: Buffer): { cdOffset: number; cdSize: number; entryCount: number } {
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        return {
          entryCount: buf.readUInt16LE(i + 10),
          cdSize: buf.readUInt32LE(i + 12),
          cdOffset: buf.readUInt32LE(i + 16),
        };
      }
    }
  }
  throw new Error("Not a readable zip archive (no End Of Central Directory record found).");
}

/**
 * Parse every entry's authoritative metadata from the central directory, then
 * slice its compressed bytes out of the local-file-header region — the
 * central directory's sizes are trusted (they are correct even when the local
 * header deferred them to a data descriptor); the local header is consulted
 * only for its own name/extra-field LENGTHS, to find where the data starts.
 */
export function parseZip(bytes: Uint8Array): ZipEntry[] {
  const buf = asBuffer(bytes);
  if (buf.length < 22) {
    throw new Error("Not a readable zip archive (too short).");
  }
  const { cdOffset, cdSize, entryCount } = findEocd(buf);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > cdEnd || p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_DIR_SIG) {
      throw new Error("Malformed zip central directory.");
    }
    const method = buf.readUInt16LE(p + 10);
    const crc32Value = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw new Error("This zip archive uses zip64 extensions, which this reader does not support.");
    }
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`Malformed zip local header for entry "${name}".`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > buf.length) {
      throw new Error(`Truncated zip entry "${name}".`);
    }
    entries.push({ name, method, crc32: crc32Value, uncompressedSize, compressedData: buf.subarray(dataStart, dataStart + compressedSize) });
  }
  return entries;
}

/** Every entry name in the archive, in archive order. Empty for bytes that
 * aren't a readable zip — callers treat "no such part" the same way whether
 * the archive is unreadable or simply lacks the entry (mirrors
 * `extraction::zip_entry_names`'s `.unwrap_or_default()`). */
export function zipEntryNames(bytes: Uint8Array): string[] {
  try {
    return parseZip(bytes).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Hard ceiling on one entry's decompressed size — mirrors
 * `extraction::MAX_ZIP_ENTRY_BYTES`: a tiny archive that inflates past this
 * is a decompression bomb, not a document. */
const MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024;

function decompressEntry(entry: ZipEntry): Buffer {
  switch (entry.method) {
    case 0:
      return Buffer.from(entry.compressedData);
    case 8:
      return inflateRawSync(entry.compressedData);
    default:
      throw new Error(`Unsupported zip compression method ${entry.method}.`);
  }
}

/** One entry's bytes, decompressed. `undefined` when the archive can't be
 * read, the entry doesn't exist, or it decompresses past the size ceiling —
 * mirrors `extraction::read_zip_entry`'s `Option`. */
export function readZipEntryBytes(bytes: Uint8Array, entry: string): Buffer | undefined {
  let entries: ZipEntry[];
  try {
    entries = parseZip(bytes);
  } catch {
    return undefined;
  }
  const found = entries.find((e) => e.name === entry);
  if (found === undefined || found.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    return undefined;
  }
  try {
    const decompressed = decompressEntry(found);
    return decompressed.length > MAX_ZIP_ENTRY_BYTES ? undefined : decompressed;
  } catch {
    return undefined;
  }
}

/** {@link readZipEntryBytes}, decoded as UTF-8 text — the common case for an
 * XML part (`read_zip_entry` returns a `String` in the Rust source too). */
export function readZipEntryText(bytes: Uint8Array, entry: string): string | undefined {
  return readZipEntryBytes(bytes, entry)?.toString("utf8");
}

// ------------------------------------------------------------------- CRC-32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard ZIP/PNG CRC-32 over `data`. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------- writing

/** One entry as {@link buildZip} writes it: either the ORIGINAL entry passed
 * through unchanged (its compressed bytes, method and CRC copied verbatim —
 * mirroring `docx_replace_text`'s `writer.raw_copy_file`) or fresh content to
 * compress now. */
export type ZipWriteEntry =
  | { readonly name: string; readonly raw: ZipEntry }
  | { readonly name: string; readonly data: Buffer; readonly store?: boolean };

/**
 * Rebuild a zip archive from a list of entries, in the given order.
 *
 * "Unchanged" entries (`raw`) keep their exact original COMPRESSED BYTES,
 * method and CRC — what a consumer reads back out is byte-identical to the
 * source archive's. What is NOT preserved is the local file header's
 * incidental fields (mod time/date, extra fields, general-purpose flags,
 * version-needed); those are written fresh with ordinary defaults. Conformant
 * readers (Word, {@link parseZip} itself) read a header's length-prefixed
 * fields off the header itself, so a plainer header for an unmodified entry
 * is exactly as valid. This is the one deliberate departure from Rust's
 * `raw_copy_file`, documented rather than silent.
 */
export function buildZip(entries: readonly ZipWriteEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    let method: number;
    let crc: number;
    let compressedData: Buffer;
    let uncompressedSize: number;

    if ("raw" in entry) {
      method = entry.raw.method;
      crc = entry.raw.crc32;
      compressedData = entry.raw.compressedData;
      uncompressedSize = entry.raw.uncompressedSize;
    } else {
      uncompressedSize = entry.data.length;
      crc = crc32(entry.data);
      method = entry.store === true ? 0 : 8;
      compressedData = entry.store === true ? entry.data : deflateRawSync(entry.data);
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    const localHeaderOffset = offset;
    localChunks.push(localHeader, nameBuf, compressedData);
    offset += localHeader.length + nameBuf.length + compressedData.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_SIG, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x21, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(localHeaderOffset, 42);
    centralChunks.push(centralHeader, nameBuf);
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}
