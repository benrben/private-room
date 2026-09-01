import { beforeEach, describe, expect, it, vi } from "vitest";

const recFormat = vi.hoisted(() => ({
  decodeWav: vi.fn(),
  SAMPLE_RATE: 16_000,
}));

vi.mock("./recFormat.js", () => recFormat);

import { decodeAudioBytesWith } from "./peaksTools";

const SAMPLE_RATE = recFormat.SAMPLE_RATE;

function wavWithRate(rate: number): Buffer {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(2, 40);
  bytes.writeInt16LE(8_192, 44);
  return bytes;
}

function withOddJunkBeforeFmt(wav: Buffer): Buffer {
  const junk = Buffer.alloc(10);
  junk.write("JUNK", 0, "ascii");
  junk.writeUInt32LE(1, 4);
  junk[8] = 0x7f;
  const result = Buffer.concat([wav.subarray(0, 12), junk, wav.subarray(12)]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function dataBeforeFormat(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("data", 12, "ascii");
  bytes.writeUInt32LE(2, 16);
  bytes.writeInt16LE(8_192, 20);
  bytes.write("JUNK", 22, "ascii");
  bytes.writeUInt32LE(14, 26);
  return bytes;
}

function boundedMalformedWav(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("JUNK", 12, "ascii");
  bytes.writeUInt32LE(0xffff_ffff, 16);
  return bytes;
}

beforeEach(() => {
  recFormat.decodeWav.mockReset().mockReturnValue(new Float32Array([0.1, -0.1]));
});

describe("wavSampleRate through the decode seam", () => {
  it("reads the declared rate from a fabricated ordinary RIFF/WAVE fmt chunk", async () => {
    const decoded = await decodeAudioBytesWith(
      wavWithRate(44_100),
      "wav",
      "audio",
      vi.fn(),
    );

    expect(decoded.sampleRate).toBe(44_100);
    expect(decoded.samples).toHaveLength(2);
    expect(recFormat.decodeWav).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it("walks an odd-sized fabricated RIFF chunk before finding fmt", async () => {
    const decoded = await decodeAudioBytesWith(
      withOddJunkBeforeFmt(wavWithRate(48_000)),
      "wav",
      "audio",
      vi.fn(),
    );

    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.samples).toHaveLength(2);
  });

  it("falls back to the recording rate when a fabricated data chunk arrives before fmt", async () => {
    const decoded = await decodeAudioBytesWith(
      dataBeforeFormat(),
      "wav",
      "audio",
      vi.fn(),
    );

    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.samples).toHaveLength(2);
  });

  it("falls back to the recording rate for a too-short fabricated header after the injected byte decoder succeeds", async () => {
    const transcode = vi.fn();
    const decoded = await decodeAudioBytesWith(
      Buffer.alloc(43),
      "wav",
      "audio",
      transcode,
    );

    expect(transcode).not.toHaveBeenCalled();
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
  });

  it("returns the parser's bounded malformed-WAV response without reaching a converter", async () => {
    const transcode = vi.fn();
    recFormat.decodeWav.mockImplementationOnce(() => {
      throw new Error("WAV has no data chunk");
    });

    await expect(decodeAudioBytesWith(boundedMalformedWav(), "wav", "audio", transcode))
      .rejects.toThrow("WAV has no data chunk");
    expect(transcode).not.toHaveBeenCalled();
  });
});
