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

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function spanEnd(start: number, length: number, total: number): number | undefined {
  const end = start + length;
  if (!Number.isSafeInteger(end)) return undefined;
  if (end > total) return undefined;
  return end;
}

function safeSpan(start: number, length: number, total: number): Span | undefined {
  if (!nonnegativeSafeInteger(start)) return undefined;
  if (!positiveSafeInteger(length)) return undefined;
  const end = spanEnd(start, length, total);
  return end === undefined ? undefined : { start, end };
}

interface JpegMarker {
  readonly marker: number;
  readonly start: number;
  readonly after: number;
}

interface JpegSegment {
  readonly length: number;
  readonly end: number;
}

type JpegStep =
  | { readonly kind: "next"; readonly position: number; readonly width: number; readonly height: number; readonly inScan: boolean }
  | { readonly kind: "done"; readonly parsed: ParsedJpeg | undefined };

function jpegStartIsValid(buf: Buffer, start: number, limit: number): boolean {
  return start >= 0 && limit <= buf.length && start + 4 <= limit && buf[start] === 0xff && buf[start + 1] === 0xd8;
}

function completedJpeg(width: number, height: number, end: number): ParsedJpeg | undefined {
  return width > 0 && height > 0 ? { end, width, height } : undefined;
}

function nextJpegMarker(buf: Buffer, position: number, limit: number): JpegMarker | undefined {
  if (buf[position] !== 0xff) return undefined;
  let marker = position;
  while (marker < limit && buf[marker] === 0xff) marker++;
  if (marker >= limit) return undefined;
  return { marker: buf[marker]!, start: position, after: marker + 1 };
}

function nextEntropyMarker(buf: Buffer, position: number, limit: number): JpegMarker | undefined {
  const start = buf.indexOf(0xff, position);
  if (start < 0 || start >= limit) return undefined;
  return nextJpegMarker(buf, start, limit);
}

function entropyMarkerContinues(marker: number): boolean {
  return marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7);
}

function entropyStep(
  buf: Buffer,
  position: number,
  limit: number,
  width: number,
  height: number,
): JpegStep {
  const marker = nextEntropyMarker(buf, position, limit);
  if (!marker) return { kind: "done", parsed: undefined };
  if (entropyMarkerContinues(marker.marker)) {
    return { kind: "next", position: marker.after, width, height, inScan: true };
  }
  if (marker.marker === 0xd9) return { kind: "done", parsed: completedJpeg(width, height, marker.after) };
  return { kind: "next", position: marker.start, width, height, inScan: false };
}

function standaloneJpegMarker(marker: number): boolean {
  return marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function jpegSegment(buf: Buffer, position: number, limit: number): JpegSegment | undefined {
  if (position + 2 > limit) return undefined;
  const length = buf.readUInt16BE(position);
  if (length < 2 || position + length > limit) return undefined;
  return { length, end: position + length };
}

function jpegDimensions(
  buf: Buffer,
  marker: number,
  position: number,
  segment: JpegSegment,
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  if (!SOF_MARKERS.has(marker)) return { width, height };
  if (segment.length < 8) return undefined;
  const nextHeight = buf.readUInt16BE(position + 3);
  const nextWidth = buf.readUInt16BE(position + 5);
  return nextWidth > 0 && nextHeight > 0 ? { width: nextWidth, height: nextHeight } : undefined;
}

function terminalMarkerStep(marker: JpegMarker, width: number, height: number): JpegStep | undefined {
  if (marker.marker === 0xd9) return { kind: "done", parsed: completedJpeg(width, height, marker.after) };
  if (standaloneJpegMarker(marker.marker)) {
    return { kind: "next", position: marker.after, width, height, inScan: false };
  }
  if (marker.marker === 0x00) return { kind: "done", parsed: undefined };
  return undefined;
}

function markerStep(
  buf: Buffer,
  position: number,
  limit: number,
  width: number,
  height: number,
): JpegStep {
  const marker = nextJpegMarker(buf, position, limit);
  if (!marker) return { kind: "done", parsed: undefined };
  const terminal = terminalMarkerStep(marker, width, height);
  if (terminal) return terminal;
  const segment = jpegSegment(buf, marker.after, limit);
  if (!segment) return { kind: "done", parsed: undefined };
  const dimensions = jpegDimensions(buf, marker.marker, marker.after, segment, width, height);
  if (!dimensions) return { kind: "done", parsed: undefined };
  return {
    kind: "next",
    position: segment.end,
    width: dimensions.width,
    height: dimensions.height,
    inScan: marker.marker === 0xda,
  };
}

/** Parse one JPEG at `start`, never reading at or after `limit`. */
function parseJpeg(buf: Buffer, start: number, limit = buf.length): ParsedJpeg | undefined {
  if (!jpegStartIsValid(buf, start, limit)) return undefined;
  let position = start + 2;
  let width = 0;
  let height = 0;
  let inScan = false;
  while (position < limit) {
    const step: JpegStep = inScan
      ? entropyStep(buf, position, limit, width, height)
      : markerStep(buf, position, limit, width, height);
    if (step.kind === "done") return step.parsed;
    position = step.position;
    width = step.width;
    height = step.height;
    inScan = step.inScan;
  }
  return undefined;
}

const TIFF_TYPE_SIZES = new Map<number, number>([
  [1, 1], [2, 1], [3, 2], [4, 4], [5, 8], [6, 1], [7, 1],
  [8, 2], [9, 4], [10, 8], [11, 4], [12, 8],
]);
const TIFF_IFD_POINTER_TAGS = new Set([0x014a, 0x8769, 0x8825]);
const TIFF_PREVIEW_TAG_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0x0201, 0x0202], // JPEGInterchangeFormat / Length (TIFF, CR2, NEF, DNG)
  [0x0111, 0x0117], // JPEG-compressed strips
  [0x2001, 0x2002], // Sony ARW preview (some bodies include a 32-byte prefix)
  [0x002e, 0x002f], // Panasonic RW2 JpgFromRaw pair
];

interface TiffIfd {
  readonly tags: Map<number, number[]>;
  readonly pointers: number[];
  readonly next: number | undefined;
}

function hasByteOrder(buf: Buffer, first: number, second: number): boolean {
  return buf[0] === first && buf[1] === second;
}

function tiffByteOrder(buf: Buffer): boolean | undefined {
  if (buf.length < 8) return undefined;
  if (hasByteOrder(buf, 0x49, 0x49)) return true;
  if (hasByteOrder(buf, 0x4d, 0x4d)) return false;
  return undefined;
}

function readTiffU16(buf: Buffer, little: boolean, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > buf.length) return undefined;
  return little ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

function readTiffU32(buf: Buffer, little: boolean, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > buf.length) return undefined;
  return little ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function tiffValueByteLength(type: number, count: number): number | undefined {
  const size = TIFF_TYPE_SIZES.get(type) ?? 0;
  if (size === 0) return undefined;
  const byteLength = size * count;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return undefined;
  return byteLength;
}

function tiffValueDataOffset(
  buf: Buffer,
  little: boolean,
  entry: number,
  byteLength: number,
): number | undefined {
  return byteLength <= 4 ? entry + 8 : readTiffU32(buf, little, entry + 8);
}

function isTiffValueRange(buf: Buffer, offset: number | undefined, byteLength: number): offset is number {
  return offset !== undefined && offset >= 0 && offset + byteLength <= buf.length;
}

function readTiffValue(buf: Buffer, little: boolean, type: number, offset: number): number | undefined {
  if (type === 3) return readTiffU16(buf, little, offset);
  if (type === 4 || type === 13) return readTiffU32(buf, little, offset);
  return undefined;
}

function readTiffValues(buf: Buffer, little: boolean, entry: number, type: number, count: number): number[] {
  const byteLength = tiffValueByteLength(type, count);
  if (byteLength === undefined) return [];
  const data = tiffValueDataOffset(buf, little, entry, byteLength);
  if (!isTiffValueRange(buf, data, byteLength)) return [];
  const size = TIFF_TYPE_SIZES.get(type)!;
  const values: number[] = [];
  const cap = Math.min(count, 4096); // malformed arrays cannot turn into unbounded work
  for (let index = 0; index < cap; index++) {
    const value = readTiffValue(buf, little, type, data + index * size);
    if (value === undefined) return [];
    values.push(value);
  }
  return values;
}

function readTiffIfdEntry(buf: Buffer, little: boolean, offset: number): readonly [number, number[]] | undefined {
  const tag = readTiffU16(buf, little, offset);
  const type = readTiffU16(buf, little, offset + 2);
  const count = readTiffU32(buf, little, offset + 4);
  if (tag === undefined || type === undefined || count === undefined) return undefined;
  return [tag, readTiffValues(buf, little, offset, type, count)];
}

function tiffIfdFits(buf: Buffer, offset: number, count: number): boolean {
  return count <= 4096 && offset + 2 + count * 12 + 4 <= buf.length;
}

function tiffIfdCount(buf: Buffer, little: boolean, offset: number): number | undefined {
  const count = readTiffU16(buf, little, offset);
  if (count === undefined || !tiffIfdFits(buf, offset, count)) return undefined;
  return count;
}

function readTiffIfd(buf: Buffer, little: boolean, offset: number): TiffIfd | undefined {
  const count = tiffIfdCount(buf, little, offset);
  if (count === undefined) return undefined;
  const tags = new Map<number, number[]>();
  const pointers: number[] = [];
  for (let index = 0; index < count; index++) {
    const entry = readTiffIfdEntry(buf, little, offset + 2 + index * 12);
    if (entry === undefined) continue;
    const [tag, values] = entry;
    tags.set(tag, values);
    // SubIFDs, ExifIFD and GPSIFD. Maker notes are found by the safe scan.
    if (TIFF_IFD_POINTER_TAGS.has(tag)) pointers.push(...values);
  }
  return { tags, pointers, next: readTiffU32(buf, little, offset + 2 + count * 12) };
}

function validUnvisitedTiffIfd(buf: Buffer, visited: Set<number>, offset: number): boolean {
  return !visited.has(offset) && offset >= 8 && offset + 2 <= buf.length;
}

function tiffTagValues(tags: Map<number, number[]>, tag: number): number[] {
  return tags.get(tag) ?? [];
}

function addTiffPreviewSpans(buf: Buffer, tags: Map<number, number[]>, spans: Span[]): void {
  for (const [offsetTag, lengthTag] of TIFF_PREVIEW_TAG_PAIRS) {
    const offsets = tiffTagValues(tags, offsetTag);
    const lengths = tiffTagValues(tags, lengthTag);
    for (let index = 0; index < Math.min(offsets.length, lengths.length); index++) {
      const span = safeSpan(offsets[index]!, lengths[index]!, buf.length);
      if (span) spans.push(span);
    }
  }
}

function initialTiffQueue(first: number | undefined): number[] {
  return first === undefined ? [] : [first];
}

function queueNextTiffIfd(queue: number[], next: number | undefined): void {
  if (next === undefined || next === 0) return;
  queue.push(next);
}

function tiffIfdSpans(buf: Buffer, little: boolean, first: number | undefined): Span[] {
  const spans: Span[] = [];
  const queued = initialTiffQueue(first);
  const visited = new Set<number>();
  while (queued.length > 0 && visited.size < 256) {
    const offset = queued.shift()!;
    if (!validUnvisitedTiffIfd(buf, visited, offset)) continue;
    visited.add(offset);
    const ifd = readTiffIfd(buf, little, offset);
    if (ifd === undefined) continue;
    addTiffPreviewSpans(buf, ifd.tags, spans);
    queued.push(...ifd.pointers);
    queueNextTiffIfd(queued, ifd.next);
  }
  return spans;
}

function tiffSpans(buf: Buffer): Span[] {
  const little = tiffByteOrder(buf);
  if (little === undefined || readTiffU16(buf, little, 2) !== 42) return [];
  // BigTIFF uses 64-bit fields and is not a camera RAW convention.
  return tiffIfdSpans(buf, little, readTiffU32(buf, little, 4));
}

function isRafContainer(buf: Buffer): boolean {
  return buf.length >= 92 && buf.toString("ascii", 0, 16) === "FUJIFILMCCD-RAW ";
}

function rafPreviewSpan(buf: Buffer): Span | undefined {
  return safeSpan(buf.readUInt32BE(84), buf.readUInt32BE(88), buf.length);
}

function rafSpans(buf: Buffer): Span[] {
  if (!isRafContainer(buf)) return [];
  const span = rafPreviewSpan(buf);
  return span === undefined ? [] : [span];
}

const BMFF_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "udta", "meta"]);

interface BmffBox {
  readonly type: string;
  readonly payloadStart: number;
  readonly payloadEnd: number;
  readonly end: number;
}

function validBmffBoxSize(size: number, header: number, position: number, limit: number): boolean {
  return size >= header && position + size <= limit;
}

function bmffBoxSize(buf: Buffer, position: number, limit: number): { size: number; header: number } | undefined {
  let size = buf.readUInt32BE(position);
  let header = 8;
  if (size === 1) {
    if (position + 16 > limit) return undefined;
    const wide = buf.readBigUInt64BE(position + 8);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    size = Number(wide);
    header = 16;
  } else if (size === 0) {
    size = limit - position;
  }
  if (!validBmffBoxSize(size, header, position, limit)) return undefined;
  return { size, header };
}

function readBmffBox(buf: Buffer, position: number, limit: number): BmffBox | undefined {
  const layout = bmffBoxSize(buf, position, limit);
  if (!layout) return undefined;
  const payloadStart = position + layout.header;
  const end = position + layout.size;
  return {
    type: buf.toString("latin1", position + 4, position + 8),
    payloadStart,
    payloadEnd: end,
    end,
  };
}

function bmffPreviewType(type: string): boolean {
  return type === "PRVW" || type === "THMB" || type === "mdat";
}

function bmffChildStart(box: BmffBox): number {
  return box.payloadStart + (box.type === "meta" ? 4 : 0);
}

function walkBmffBoxes(buf: Buffer, from: number, to: number, depth: number, spans: Span[]): void {
  if (depth > 12) return;
  let position = from;
  while (position + 8 <= to) {
    const box = readBmffBox(buf, position, to);
    if (!box) return;
    if (bmffPreviewType(box.type)) spans.push({ start: box.payloadStart, end: box.payloadEnd });
    if (BMFF_CONTAINERS.has(box.type)) walkBmffBoxes(buf, bmffChildStart(box), box.payloadEnd, depth + 1, spans);
    position = box.end;
  }
}

function bmffSpans(buf: Buffer): Span[] {
  if (buf.length < 16 || buf.toString("ascii", 4, 8) !== "ftyp") return [];
  const spans: Span[] = [];
  walkBmffBoxes(buf, 0, buf.length, 0, spans);
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
function rawPreviewBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function advertisedRawPreviewSpans(buf: Buffer): Span[] {
  return [...tiffSpans(buf), ...rafSpans(buf), ...bmffSpans(buf)];
}

function scanRawPreviewSpans(buf: Buffer, spans: Span[], found: Map<number, ParsedJpeg>) {
  for (const span of spans) scanRange(buf, span, found);
  scanRange(buf, { start: 0, end: buf.length }, found);
}

function previewBeats(
  candidate: { start: number; parsed: ParsedJpeg },
  best: { start: number; parsed: ParsedJpeg } | undefined,
): boolean {
  if (!best) return true;
  const pixels = candidate.parsed.width * candidate.parsed.height;
  const bestPixels = best.parsed.width * best.parsed.height;
  if (pixels !== bestPixels) return pixels > bestPixels;
  return candidate.parsed.end - candidate.start > best.parsed.end - best.start;
}

function highestResolutionPreview(
  found: Map<number, ParsedJpeg>,
  minimumWidth: number,
): { start: number; parsed: ParsedJpeg } | undefined {
  let best: { start: number; parsed: ParsedJpeg } | undefined;
  for (const [start, parsed] of found) {
    if (parsed.width < minimumWidth) continue;
    const candidate = { start, parsed };
    if (previewBeats(candidate, best)) best = candidate;
  }
  return best;
}

function rawPreviewResult(buf: Buffer, best: { start: number; parsed: ParsedJpeg }): RawJpegPreview {
  return {
    bytes: Buffer.from(buf.subarray(best.start, best.parsed.end)),
    offset: best.start,
    width: best.parsed.width,
    height: best.parsed.height,
  };
}

export function extractRawPreview(
  bytes: Uint8Array,
  minimumWidth = MIN_RAW_PREVIEW_WIDTH,
): RawJpegPreview | null {
  const buf = rawPreviewBuffer(bytes);
  if (buf.length < 4) return null;
  const found = new Map<number, ParsedJpeg>();
  scanRawPreviewSpans(buf, advertisedRawPreviewSpans(buf), found);
  const best = highestResolutionPreview(found, minimumWidth);
  if (best === undefined) return null;
  return rawPreviewResult(buf, best);
}
