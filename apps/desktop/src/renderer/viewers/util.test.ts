import { describe, expect, it } from "vitest";
import { base64ToBytes, OCR_PREFIX, ocrBody, STT_FAILED_PREFIX, sttFailure } from "./util";

describe("viewer text markers", () => {
  it("returns only meaningful OCR text after removing its private instruction prefix", () => {
    expect(ocrBody(undefined)).toBeNull();
    expect(ocrBody(null)).toBeNull();
    expect(ocrBody("")).toBeNull();
    expect(ocrBody(`${OCR_PREFIX}   `)).toBeNull();
    expect(ocrBody(`${OCR_PREFIX}  Street sign  `)).toBe("Street sign");
    expect(ocrBody("  handwritten note  ")).toBe("handwritten note");
  });

  it("keeps decoding failures distinct from absent or empty transcription stages", () => {
    expect(sttFailure(undefined)).toBeNull();
    expect(sttFailure("processing")).toBeNull();
    expect(sttFailure(`${STT_FAILED_PREFIX}  `)).toBeNull();
    expect(sttFailure(`${STT_FAILED_PREFIX}unsupported codec  `)).toBe("unsupported codec");
  });

  it("decodes base64 bytes without changing their values", () => {
    expect([...base64ToBytes("AP+A")]).toEqual([0, 255, 128]);
  });
});
