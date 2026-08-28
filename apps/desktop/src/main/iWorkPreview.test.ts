import { describe, expect, it } from "vitest";
import { buildZip } from "./editMatchZip.js";
import { extractIWorkPreview, iWorkPreviewEntry } from "./iWorkPreview.js";

function jpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x20, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x11, 0x22,
    0xff, 0xd9,
  ]);
}

describe("iWorkPreviewEntry", () => {
  it("matches flat and package-bundle PDF spellings case-insensitively", () => {
    expect(iWorkPreviewEntry(["Index/Document.iwa", "QuickLook/Preview.pdf"])).toBe("QuickLook/Preview.pdf");
    expect(iWorkPreviewEntry(["Deck.key/QUICKLOOK/PREVIEW.PDF"])).toBe("Deck.key/QUICKLOOK/PREVIEW.PDF");
  });

  it("matches modern root and package-root preview.jpg", () => {
    expect(iWorkPreviewEntry(["preview.jpg"])).toBe("preview.jpg");
    expect(iWorkPreviewEntry(["Deck.key/Preview.JPG"])).toBe("Deck.key/Preview.JPG");
  });

  it("prefers the full PDF even if a JPEG is listed first", () => {
    expect(iWorkPreviewEntry(["preview.jpg", "QuickLook/Preview.pdf"])).toBe("QuickLook/Preview.pdf");
  });

  it("rejects unrelated nested and unsafe lookalikes", () => {
    expect(iWorkPreviewEntry(["Assets/Thumbnails/preview.jpg", "../preview.jpg", "/preview.jpg"])).toBeNull();
  });
});

describe("extractIWorkPreview", () => {
  it("returns a validated PDF preview from a synthesized flat zip", () => {
    const pdf = Buffer.from("%PDF-1.7\nsynthetic public test preview\n%%EOF", "ascii");
    const zip = buildZip([
      { name: "Index/Document.iwa", data: Buffer.from([1, 2, 3]) },
      { name: "QuickLook/Preview.pdf", data: pdf },
    ]);
    expect(extractIWorkPreview(zip)).toEqual({
      bytes: pdf,
      entryName: "QuickLook/Preview.pdf",
      extension: ".pdf",
      mimeType: "application/pdf",
    });
  });

  it("returns a validated JPEG preview from a synthesized modern bundle", () => {
    const preview = jpeg();
    const zip = buildZip([{ name: "Deck.key/preview.jpg", data: preview }]);
    expect(extractIWorkPreview(zip)).toEqual({
      bytes: preview,
      entryName: "Deck.key/preview.jpg",
      extension: ".jpg",
      mimeType: "image/jpeg",
    });
  });

  it.each([
    Buffer.from("not a zip"),
    buildZip([{ name: "Index/Document.iwa", data: Buffer.from([1]) }]),
    buildZip([{ name: "QuickLook/Preview.pdf", data: Buffer.from("not pdf") }]),
    buildZip([{ name: "QuickLook/Preview.pdf", data: Buffer.from("%PDF-1.7\ntruncated") }]),
    buildZip([{ name: "preview.jpg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }]),
  ])("returns null for missing or malformed previews", (bytes) => {
    expect(() => extractIWorkPreview(bytes)).not.toThrow();
    expect(extractIWorkPreview(bytes)).toBeNull();
  });
});
