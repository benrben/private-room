/**
 * Dependency-free embedded JPEG extraction for camera RAW files.
 *
 * RAW formats are containers, not one image codec. Most cameras include one
 * or more ordinary JPEG previews. We collect the offsets advertised by the
 * common containers (classic TIFF/Exif IFDs, ISO-BMFF/CR3 and RAF), then use a
 * bounded whole-file scan as a compatibility fallback for maker-note layouts
 * that are intentionally undocumented. Every candidate is parsed as a JPEG;
 * byte-looking SOI/EOI pairs are never accepted on magic bytes alone.
 */

export interface RawJpegPreview {
  readonly bytes: Buffer;
  readonly offset: number;
  readonly width: number;
  readonly height: number;
}
interface Span {
  readonly start: number;
  readonly end: number;
}

interface ParsedJpeg {
  readonly end: number;
  readonly width: number;
  readonly height: number;
}

/** A thumbnail is not an acceptable stored RAW preview. The viewer can
 * scale a camera preview down, but scaling a sub-1000px JPEG up is the blurry
 * failure this extraction path exists to avoid. */
export const MIN_RAW_PREVIEW_WIDTH = 1000;

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function readU32BE(buf: Buffer, offset: number): number | undefined {
  return offset >= 0 && offset + 4 <= buf.length ? buf.readUInt32BE(offset) : undefined;
}

function safeSpan(start: number, length: number, total: number): Span | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0) return undefined;
  const end = start + length;
  return Number.isSafeInteger(end) && end <= total ? { start, end } : undefined;
}

/** Parse one JPEG at `start`, never reading at or after `limit`. */
function parseJpeg(buf: Buffer, start: number, limit = buf.length): ParsedJpeg | undefined {
  if (start < 0 || limit > buf.length || start + 4 > limit || buf[start] !== 0xff || buf[start + 1] !== 0xd8) {
    return undefined;
  }

  let p = start + 2;
  let width = 0;
  let height = 0;
  let inScan = false;

  while (p < limit) {
    if (inScan) {
      const markerStart = buf.indexOf(0xff, p);
      if (markerStart < 0 || markerStart >= limit) return undefined;
      let q = markerStart + 1;
      while (q < limit && buf[q] === 0xff) q++;
      if (q >= limit) return undefined;
      const marker = buf[q]!;
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
        p = q + 1;
        continue;
      }
      if (marker === 0xd9) {
        return width > 0 && height > 0 ? { end: q + 1, width, height } : undefined;
      }
      // Progressive JPEGs may have another table or scan after entropy data.
      p = markerStart;
      inScan = false;
      continue;
    }

    if (buf[p] !== 0xff) return undefined;
    while (p < limit && buf[p] === 0xff) p++;
    if (p >= limit) return undefined;
    const marker = buf[p++]!;

    if (marker === 0xd9) {
      return width > 0 && height > 0 ? { end: p, width, height } : undefined;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0x00 || p + 2 > limit) return undefined;

    const segmentLength = buf.readUInt16BE(p);
    if (segmentLength < 2 || p + segmentLength > limit) return undefined;
    if (SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) return undefined;
      height = buf.readUInt16BE(p + 3);
      width = buf.readUInt16BE(p + 5);
      if (width === 0 || height === 0) return undefined;
    }
    p += segmentLength;
    if (marker === 0xda) inScan = true;
  }
  return undefined;
}

function tiffSpans(buf: Buffer): Span[] {
  if (buf.length < 8) return [];
  const little = buf[0] === 0x49 && buf[1] === 0x49;
  const big = buf[0] === 0x4d && buf[1] === 0x4d;
  if (!little && !big) return [];
  const u16 = (o: number): number | undefined =>
    o >= 0 && o + 2 <= buf.length ? (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : undefined;
  const u32 = (o: number): number | undefined =>
    o >= 0 && o + 4 <= buf.length ? (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : undefined;
  if (u16(2) !== 42) return []; // BigTIFF uses 64-bit fields and is not a camera RAW convention.

  const typeSize = (type: number): number => [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] ?? 0;
  const values = (entry: number, type: number, count: number): number[] => {
    const size = typeSize(type);
    const byteLength = size * count;
    if (size === 0 || !Number.isSafeInteger(byteLength) || byteLength < 0) return [];
    const data = byteLength <= 4 ? entry + 8 : u32(entry + 8);
    if (data === undefined || data < 0 || data + byteLength > buf.length) return [];
    const out: number[] = [];
    const cap = Math.min(count, 4096); // malformed arrays cannot turn into unbounded work
    for (let i = 0; i < cap; i++) {
      const at = data + i * size;
      const value = type === 3 ? u16(at) : type === 4 || type === 13 ? u32(at) : undefined;
      if (value === undefined) return [];
      out.push(value);
    }
    return out;
  };

  const spans: Span[] = [];
  const queued: number[] = [];
  const first = u32(4);
  if (first !== undefined) queued.push(first);
  const visited = new Set<number>();

  while (queued.length > 0 && visited.size < 256) {
    const ifd = queued.shift()!;
    if (visited.has(ifd) || ifd < 8 || ifd + 2 > buf.length) continue;
    visited.add(ifd);
    const count = u16(ifd);
    if (count === undefined || count > 4096 || ifd + 2 + count * 12 + 4 > buf.length) continue;

    const tags = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const valueCount = u32(entry + 4);
      if (tag === undefined || type === undefined || valueCount === undefined) continue;
      const parsed = values(entry, type, valueCount);
      tags.set(tag, parsed);
      // SubIFDs, ExifIFD and GPSIFD. Maker notes are found by the safe scan.
      if (tag === 0x014a || tag === 0x8769 || tag === 0x8825) queued.push(...parsed);
    }

    const addPairs = (offsetTag: number, lengthTag: number, offsetAdjustment = 0): void => {
      const offsets = tags.get(offsetTag) ?? [];
      const lengths = tags.get(lengthTag) ?? [];
      for (let i = 0; i < Math.min(offsets.length, lengths.length); i++) {
        const span = safeSpan(offsets[i]! + offsetAdjustment, lengths[i]!, buf.length);
        if (span) spans.push(span);
      }
    };
    addPairs(0x0201, 0x0202); // JPEGInterchangeFormat / Length (TIFF, CR2, NEF, DNG)
    addPairs(0x0111, 0x0117); // JPEG-compressed strips
    addPairs(0x2001, 0x2002); // Sony ARW preview (some bodies include a 32-byte prefix)
    addPairs(0x002e, 0x002f); // Panasonic RW2 JpgFromRaw pair

    const next = u32(ifd + 2 + count * 12);
    if (next !== undefined && next !== 0) queued.push(next);
  }
  return spans;
}

function rafSpans(buf: Buffer): Span[] {
  if (buf.length < 92 || buf.toString("ascii", 0, 16) !== "FUJIFILMCCD-RAW ") return [];
  const offset = readU32BE(buf, 84);
  const length = readU32BE(buf, 88);
  const span = offset === undefined || length === undefined ? undefined : safeSpan(offset, length, buf.length);
  return span ? [span] : [];
}

const BMFF_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "udta", "meta"]);

function bmffSpans(buf: Buffer): Span[] {
  if (buf.length < 16 || buf.toString("ascii", 4, 8) !== "ftyp") return [];
  const spans: Span[] = [];
  const walk = (from: number, to: number, depth: number): void => {
    if (depth > 12) return;
    let p = from;
    while (p + 8 <= to) {
      let size = buf.readUInt32BE(p);
      const type = buf.toString("latin1", p + 4, p + 8);
      let header = 8;
      if (size === 1) {
        if (p + 16 > to) return;
        const wide = buf.readBigUInt64BE(p + 8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return;
        size = Number(wide);
        header = 16;
      } else if (size === 0) {
        size = to - p;
      }
      if (size < header || p + size > to) return;
      const payloadStart = p + header;
      const payloadEnd = p + size;
      if (type === "PRVW" || type === "THMB" || type === "mdat") spans.push({ start: payloadStart, end: payloadEnd });
      if (BMFF_CONTAINERS.has(type)) {
        // FullBox `meta` has version/flags before its child boxes.
        walk(payloadStart + (type === "meta" ? 4 : 0), payloadEnd, depth + 1);
      }
      p += size;
    }
  };
  walk(0, buf.length, 0);
  return spans;
}

function scanRange(buf: Buffer, span: Span, found: Map<number, ParsedJpeg>): void {
  let cursor = span.start;
  while (cursor + 2 <= span.end) {
    const start = buf.indexOf(Buffer.from([0xff, 0xd8]), cursor);
    if (start < 0 || start + 2 > span.end) return;
    const parsed = parseJpeg(buf, start, span.end);
    if (parsed !== undefined) found.set(start, parsed);
    cursor = start + 2;
  }
}

/** Return the highest-resolution structurally-valid embedded JPEG whose
 * width is suitable for the viewer, or `null`. */
export function extractRawPreview(
  bytes: Uint8Array,
  minimumWidth = MIN_RAW_PREVIEW_WIDTH,
): RawJpegPreview | null {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 4) return null;
  const found = new Map<number, ParsedJpeg>();
  const advertised = [...tiffSpans(buf), ...rafSpans(buf), ...bmffSpans(buf)];
  for (const span of advertised) scanRange(buf, span, found);
  // Compatibility path for proprietary maker-note variants (NEF/ORF/ARW and
  // others). It remains safe because the same full JPEG parser is the gate.
  scanRange(buf, { start: 0, end: buf.length }, found);

  let best: { start: number; parsed: ParsedJpeg } | undefined;
  for (const [start, parsed] of found) {
    if (parsed.width < minimumWidth) continue;
    const pixels = parsed.width * parsed.height;
    const bestPixels = best === undefined ? -1 : best.parsed.width * best.parsed.height;
    if (
      best === undefined ||
      pixels > bestPixels ||
      (pixels === bestPixels && parsed.end - start > best.parsed.end - best.start)
    ) {
      best = { start, parsed };
    }
  }
  if (best === undefined) return null;
  return {
    bytes: Buffer.from(buf.subarray(best.start, best.parsed.end)),
    offset: best.start,
    width: best.parsed.width,
    height: best.parsed.height,
  };
}
