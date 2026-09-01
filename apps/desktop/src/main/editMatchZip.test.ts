/**
 * Tests for `editMatchZip.ts` — NOT a Rust port (that file stands in for the
 * Rust source's `zip` crate dependency, which this project does not have).
 * Covers round-tripping, multi-entry archives, "raw copy" of untouched
 * entries, and the guards that keep a malformed/zip64 archive from being
 * silently misread.
 */

import { describe, expect, it } from "vitest";
import { buildZip, crc32, parseZip, readZipEntryBytes, readZipEntryText, zipEntryNames } from "./editMatchZip.js";

function centralDirectoryOffset(zip: Buffer): number {
  return zip.readUInt32LE(zip.length - 6);
}

function localHeaderOffset(zip: Buffer): number {
  return zip.readUInt32LE(centralDirectoryOffset(zip) + 42);
}

describe("editMatchZip", () => {
  it("round-trips a single stored entry", () => {
    const zip = buildZip([{ name: "hello.txt", data: Buffer.from("hello world"), store: true }]);
    expect(zipEntryNames(zip)).toEqual(["hello.txt"]);
    expect(readZipEntryText(zip, "hello.txt")).toBe("hello world");
  });

  it("round-trips a single deflated entry", () => {
    const content = "the quick brown fox jumps over the lazy dog ".repeat(50);
    const zip = buildZip([{ name: "doc.txt", data: Buffer.from(content, "utf8") }]);
    expect(readZipEntryText(zip, "doc.txt")).toBe(content);
  });

  it("round-trips multiple entries in order", () => {
    const zip = buildZip([
      { name: "a.txt", data: Buffer.from("A") },
      { name: "b.txt", data: Buffer.from("B") },
      { name: "c.txt", data: Buffer.from("C") },
    ]);
    expect(zipEntryNames(zip)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(readZipEntryText(zip, "a.txt")).toBe("A");
    expect(readZipEntryText(zip, "b.txt")).toBe("B");
    expect(readZipEntryText(zip, "c.txt")).toBe("C");
  });

  it("an unrelated entry's raw copy keeps its exact original content byte-for-byte", () => {
    const original = buildZip([
      { name: "word/document.xml", data: Buffer.from("<doc>original</doc>") },
      { name: "word/footnotes.xml", data: Buffer.from("<notes>keep me exactly</notes>") },
    ]);
    const footnotes = parseZip(original).find((e) => e.name === "word/footnotes.xml")!;
    const rebuilt = buildZip([
      { name: "word/document.xml", data: Buffer.from("<doc>patched</doc>") },
      { name: "word/footnotes.xml", raw: footnotes },
    ]);
    expect(readZipEntryText(rebuilt, "word/document.xml")).toBe("<doc>patched</doc>");
    expect(readZipEntryText(rebuilt, "word/footnotes.xml")).toBe("<notes>keep me exactly</notes>");
  });

  it("readZipEntryBytes returns undefined for a missing entry, not a throw", () => {
    const zip = buildZip([{ name: "a.txt", data: Buffer.from("A") }]);
    expect(readZipEntryBytes(zip, "b.txt")).toBeUndefined();
  });

  it("zipEntryNames returns an empty list for bytes that aren't a zip", () => {
    expect(zipEntryNames(Buffer.from("not a zip file at all"))).toEqual([]);
    expect(zipEntryNames(Buffer.alloc(0))).toEqual([]);
  });

  it("readZipEntryBytes returns undefined for bytes that aren't a zip", () => {
    expect(readZipEntryBytes(Buffer.from("not a zip file at all"), "anything")).toBeUndefined();
  });

  it("parseZip throws on a truncated/malformed archive rather than misreading it", () => {
    const zip = buildZip([{ name: "a.txt", data: Buffer.from("A") }]);
    expect(() => parseZip(zip.subarray(0, zip.length - 5))).toThrow();
    expect(() => parseZip(Buffer.from("short"))).toThrow();
  });

  it("REGRESSION: central metadata guards retain their exact error categories", () => {
    const source = buildZip([{ name: "guarded.txt", data: Buffer.from("content"), store: true }]);
    const central = centralDirectoryOffset(source);

    const badCentral = Buffer.from(source);
    badCentral.writeUInt32LE(0, central);
    expect(() => parseZip(badCentral)).toThrow("Malformed zip central directory.");

    const zip64 = Buffer.from(source);
    zip64.writeUInt32LE(0xffffffff, central + 20);
    expect(() => parseZip(zip64)).toThrow("This zip archive uses zip64 extensions, which this reader does not support.");

    const badLocal = Buffer.from(source);
    badLocal.writeUInt32LE(0, localHeaderOffset(badLocal));
    expect(() => parseZip(badLocal)).toThrow('Malformed zip local header for entry "guarded.txt".');

    const truncated = Buffer.from(source);
    truncated.writeUInt32LE(0xfffffffe, central + 20);
    expect(() => parseZip(truncated)).toThrow('Truncated zip entry "guarded.txt".');
  });

  it("REGRESSION: an unsupported compression method stays an absent readable entry", () => {
    const source = buildZip([{ name: "method.txt", data: Buffer.from("content"), store: true }]);
    const unsupported = Buffer.from(source);
    unsupported.writeUInt16LE(99, centralDirectoryOffset(unsupported) + 10);
    expect(readZipEntryBytes(unsupported, "method.txt")).toBeUndefined();
  });

  it("round-trips binary (non-UTF-8-text) bytes exactly", () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x01, 0x02, 0x03]);
    const zip = buildZip([{ name: "blob.bin", data: binary }]);
    const back = readZipEntryBytes(zip, "blob.bin");
    expect(back).toBeDefined();
    expect(back!.equals(binary)).toBe(true);
  });

  it("crc32 is deterministic and distinguishes different content", () => {
    expect(crc32(Buffer.from("hello"))).toBe(crc32(Buffer.from("hello")));
    expect(crc32(Buffer.from("hello"))).not.toBe(crc32(Buffer.from("hellp")));
    // The standard check value for "123456789".
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});
