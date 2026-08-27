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
  u16(2, 8);
  // JPEGInterchangeFormat, LONG, count 1, offset
  u16(0x0201, 10); u16(4, 12); u32(1, 14); u32(offset, 18);
  // JPEGInterchangeFormatLength
  u16(0x0202, 22); u16(4, 24); u32(1, 26); u32(preview.length, 30);
  u32(0, 34);
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

describe("extractRawPreview", () => {
  it.each([true, false])("walks a %s-endian TIFF IFD JPEG pair", (little) => {
    const source = jpeg(1600, 1200, 20);
    const result = extractRawPreview(tiffWithPreview(source, little));
    expect(result).toMatchObject({ offset: 64, width: 1600, height: 1200 });
    expect(result?.bytes).toEqual(source);
  });

  it("finds a JPEG in a CR3 PRVW box", () => {
    const source = jpeg(2048, 1365, 11);
    const cr3 = Buffer.concat([
      box("ftyp", Buffer.from("crx crx ", "ascii")),
      box("moov", box("PRVW", Buffer.concat([Buffer.from([0, 0, 0, 1]), source]))),
    ]);
    const result = extractRawPreview(cr3);
    expect(result?.bytes).toEqual(source);
    expect(result).toMatchObject({ width: 2048, height: 1365 });
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

  it("chooses the largest valid JPEG and ignores a larger false SOI/EOI blob", () => {
    const small = jpeg(640, 480, 2);
    const large = jpeg(3000, 2000, 100);
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(500, 1), Buffer.from([0xff, 0xd9])]);
    const result = extractRawPreview(Buffer.concat([fake, small, Buffer.alloc(9), large]));
    expect(result?.bytes).toEqual(large);
    expect(result).toMatchObject({ width: 3000, height: 2000 });
  });

  it("accepts JPEG byte stuffing and restart markers in entropy data", () => {
    const source = jpeg(800, 600);
    const eoi = source.length - 2;
    const withMarkers = Buffer.concat([
      source.subarray(0, eoi),
      Buffer.from([0xff, 0x00, 0xff, 0xd1, 0x22]),
      source.subarray(eoi),
    ]);
    expect(extractRawPreview(withMarkers)?.bytes).toEqual(withMarkers);
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
