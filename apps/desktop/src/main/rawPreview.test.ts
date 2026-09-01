import { describe, expect, it } from "vitest";
import { extractRawPreview } from "./rawPreview.js";

function jpeg(width: number, height: number, entropyBytes = 4): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    ...Array.from({ length: entropyBytes }, (_, i) => (i % 0xfd) + 1),
    0xff, 0xd9,
  ]);
}

function tiffWithPreview(preview: Buffer, little: boolean): Buffer {
  const offset = 64;
  const out = Buffer.alloc(offset + preview.length);
  out.write(little ? "II" : "MM", 0, "ascii");
  const u16 = little ? out.writeUInt16LE.bind(out) : out.writeUInt16BE.bind(out);
  const u32 = little ? out.writeUInt32LE.bind(out) : out.writeUInt32BE.bind(out);
  u16(42, 2);
  u32(8, 4);
  u16(4, 8);
  // JPEGInterchangeFormat, LONG, count 1, offset
  u16(0x0201, 10); u16(4, 12); u32(1, 14); u32(offset, 18);
  // JPEGInterchangeFormatLength
  u16(0x0202, 22); u16(4, 24); u32(1, 26); u32(preview.length, 30);
  // Ordinary non-preview values must not disturb preview extraction. These
  // exercise both a supported SHORT read and an unsupported BYTE value.
  u16(0x0100, 34); u16(3, 36); u32(1, 38); u16(1600, 42);
  u16(0x0101, 46); u16(1, 48); u32(1, 50); out[54] = 1;
  u32(0, 58);
  preview.copy(out, offset);
  return out;
}

function tiffWithChainedPreview(preview: Buffer): Buffer {
  const offset = 128;
  const out = Buffer.alloc(offset + preview.length);
  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(0, 8);
  out.writeUInt32LE(64, 10);
  out.writeUInt16LE(2, 64);
  out.writeUInt16LE(0x0201, 66); out.writeUInt16LE(4, 68); out.writeUInt32LE(1, 70); out.writeUInt32LE(offset, 74);
  out.writeUInt16LE(0x0202, 78); out.writeUInt16LE(4, 80); out.writeUInt32LE(1, 82); out.writeUInt32LE(preview.length, 86);
  out.writeUInt32LE(0, 90);
  preview.copy(out, offset);
  return out;
}

function box(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, "ascii");
  payload.copy(out, 8);
  return out;
}

function extendedBox(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(16 + payload.length);
  out.writeUInt32BE(1, 0);
  out.write(type, 4, 4, "ascii");
  out.writeBigUInt64BE(BigInt(out.length), 8);
  payload.copy(out, 16);
  return out;
}

function finalBox(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(0, 0);
  out.write(type, 4, 4, "ascii");
  payload.copy(out, 8);
  return out;
}

function cr3(...boxes: Buffer[]): Buffer {
  return Buffer.concat([box("ftyp", Buffer.from("crx crx ", "ascii")), ...boxes]);
}

describe("extractRawPreview", () => {
  it.each([true, false])("walks a %s-endian TIFF IFD JPEG pair", (little) => {
    const source = jpeg(1600, 1200, 20);
    const result = extractRawPreview(tiffWithPreview(source, little));
    expect(result).toMatchObject({ offset: 64, width: 1600, height: 1200 });
    expect(result?.bytes).toEqual(source);
  });

  it("follows a chained TIFF IFD before extracting its JPEG pair", () => {
    const source = jpeg(1800, 1200, 20);
    const result = extractRawPreview(tiffWithChainedPreview(source));
    expect(result).toMatchObject({ offset: 128, width: 1800, height: 1200 });
    expect(result?.bytes).toEqual(source);
  });

  it("finds a JPEG in a CR3 PRVW box", () => {
    const source = jpeg(2048, 1365, 11);
    const bytes = cr3(box("moov", box("PRVW", Buffer.concat([Buffer.from([0, 0, 0, 1]), source]))));
    const result = extractRawPreview(bytes);
    expect(result?.bytes).toEqual(source);
    expect(result).toMatchObject({ width: 2048, height: 1365 });
  });

  it("walks extended, final, and meta BMFF boxes to find their preview JPEGs", () => {
    const extended = jpeg(2000, 1333);
    const final = jpeg(2100, 1400);
    const meta = jpeg(2200, 1467);
    const extendedResult = extractRawPreview(cr3(extendedBox("moov", box("PRVW", extended))));
    const finalResult = extractRawPreview(cr3(finalBox("mdat", final)));
    const metaResult = extractRawPreview(cr3(box("meta", Buffer.concat([Buffer.alloc(4), box("THMB", meta)]))));
    expect(extendedResult?.bytes).toEqual(extended);
    expect(finalResult?.bytes).toEqual(final);
    expect(metaResult?.bytes).toEqual(meta);
  });

  it("bounds-checks extended BMFF boxes and stops recursion safely", () => {
    const shortExtended = Buffer.alloc(8);
    shortExtended.writeUInt32BE(1, 0);
    shortExtended.write("mdat", 4, "ascii");
    const tooWide = Buffer.alloc(16);
    tooWide.writeUInt32BE(1, 0);
    tooWide.write("mdat", 4, "ascii");
    tooWide.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
    let deep = Buffer.alloc(0);
    for (let index = 0; index < 14; index += 1) deep = box("moov", deep);
    expect(extractRawPreview(cr3(shortExtended))).toBeNull();
    expect(extractRawPreview(cr3(tooWide))).toBeNull();
    expect(extractRawPreview(cr3(deep))).toBeNull();
  });

  it("uses the bounds-checked RAF fixed offset pair", () => {
    const source = jpeg(1200, 800);
    const out = Buffer.alloc(128 + source.length);
    out.write("FUJIFILMCCD-RAW ", 0, "ascii");
    out.writeUInt32BE(128, 84);
    out.writeUInt32BE(source.length, 88);
    source.copy(out, 128);
    expect(extractRawPreview(out)?.bytes).toEqual(source);
  });

  it("chooses the highest-resolution valid JPEG and ignores a larger false SOI/EOI blob", () => {
    const small = jpeg(1200, 900, 300);
    const large = jpeg(3000, 2000, 100);
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(500, 1), Buffer.from([0xff, 0xd9])]);
    const result = extractRawPreview(Buffer.concat([fake, small, Buffer.alloc(9), large]));
    expect(result?.bytes).toEqual(large);
    expect(result).toMatchObject({ width: 3000, height: 2000 });
  });

  it("uses the longer JPEG when equal-resolution previews tie", () => {
    const short = jpeg(1600, 1200, 2);
    const long = jpeg(1600, 1200, 20);
    expect(extractRawPreview(Buffer.concat([short, Buffer.alloc(3), long]))?.bytes).toEqual(long);
  });

  it("respects a Uint8Array view's byte offset while returning the source preview", () => {
    const source = jpeg(1800, 1200);
    const padded = Buffer.concat([Buffer.alloc(5), source, Buffer.alloc(7)]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 5, source.length);
    expect(extractRawPreview(view)).toMatchObject({ bytes: source, offset: 0, width: 1800, height: 1200 });
  });

  it("rejects embedded thumbnails narrower than the 1000px viewer minimum", () => {
    expect(extractRawPreview(jpeg(999, 1600, 200))).toBeNull();
    expect(extractRawPreview(jpeg(1000, 700, 2))).toMatchObject({ width: 1000, height: 700 });
  });

  it("accepts JPEG byte stuffing and restart markers in entropy data", () => {
    const source = jpeg(1200, 900);
    const eoi = source.length - 2;
    const withMarkers = Buffer.concat([
      source.subarray(0, eoi),
      Buffer.from([0xff, 0x00, 0xff, 0xd1, 0x22]),
      source.subarray(eoi),
    ]);
    expect(extractRawPreview(withMarkers)?.bytes).toEqual(withMarkers);
  });

  it("continues after progressive entropy data reaches another marker segment", () => {
    const source = jpeg(1200, 900);
    const eoi = source.length - 2;
    const progressive = Buffer.concat([
      source.subarray(0, eoi),
      Buffer.from([0xff, 0xdb, 0x00, 0x02, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x42]),
      source.subarray(eoi),
    ]);
    expect(extractRawPreview(progressive)?.bytes).toEqual(progressive);
  });

  it("accepts standalone markers and safely rejects a marker stream with no end", () => {
    const source = jpeg(1200, 900);
    const standalone = Buffer.concat([source.subarray(0, 2), Buffer.from([0xff, 0x01]), source.subarray(2)]);
    expect(extractRawPreview(standalone)?.bytes).toEqual(standalone);
    expect(extractRawPreview(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02]))).toBeNull();
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from("not a raw image"),
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0xff]),
    tiffWithPreview(jpeg(300, 200), true).subarray(0, 60),
    box("ftyp", Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
  ])("returns null without throwing for malformed or truncated bytes", (bytes) => {
    expect(() => extractRawPreview(bytes)).not.toThrow();
    expect(extractRawPreview(bytes)).toBeNull();
  });
});
