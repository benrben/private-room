import { describe, expect, it } from "vitest";
import type { MediaMeta } from "../apiTypes";
import { describeSpan, formatDuration, videoFacts } from "./mediaMeta";

function mediaMeta(overrides: Partial<MediaMeta> = {}): MediaMeta {
  return {
    durationSecs: null,
    width: null,
    height: null,
    videoCodec: null,
    frameRate: null,
    bitrateKbps: null,
    hasAudio: null,
    audioCodec: null,
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("rounds seconds and adds an hour only when needed", () => {
    expect(formatDuration(59.6)).toBe("1:00");
    expect(formatDuration(3661)).toBe("1:01:01");
  });
});

describe("videoFacts", () => {
  it("shows every measured video fact, including a confirmed silent track", () => {
    expect(
      videoFacts(
        mediaMeta({
          durationSecs: 65.4,
          width: 1920,
          height: 1080,
          videoCodec: "h264",
          frameRate: 29.97,
          bitrateKbps: 4200,
          hasAudio: false,
        }),
        20,
      ),
    ).toEqual([
      { label: "Length", value: "1:05", known: true },
      { label: "Size", value: "1920 × 1080", known: true },
      { label: "Video", value: "h264", known: true },
      { label: "Frame rate", value: "29.97 fps", known: true },
      { label: "Audio", value: "none", known: true },
      { label: "Bitrate", value: "4200 kbps", known: true },
    ]);
  });

  it("keeps absent probe data unknown while using the player's measured duration", () => {
    expect(videoFacts(null, 12)).toEqual([
      { label: "Length", value: "0:12", known: true },
      { label: "Size", value: "unknown", known: false },
      { label: "Video", value: "unknown", known: false },
      { label: "Frame rate", value: "unknown", known: false },
      { label: "Audio", value: "unknown", known: false },
    ]);
  });

  it("does not turn a partial size into a fact and labels a codec-less audio track as present", () => {
    expect(
      videoFacts(
        mediaMeta({ width: 1280, frameRate: 24, hasAudio: true }),
        null,
      ),
    ).toEqual([
      { label: "Length", value: "unknown", known: false },
      { label: "Size", value: "unknown", known: false },
      { label: "Video", value: "unknown", known: false },
      { label: "Frame rate", value: "24 fps", known: true },
      { label: "Audio", value: "yes", known: true },
    ]);
  });

  it("shows a known audio codec when the probe supplied one", () => {
    expect(videoFacts(mediaMeta({ hasAudio: true, audioCodec: "aac" }), null)[4]).toEqual({
      label: "Audio",
      value: "aac",
      known: true,
    });
  });
});

describe("describeSpan", () => {
  it("rejects missing, non-finite, and too-short spans", () => {
    expect(describeSpan(null, 12)).toBeNull();
    expect(describeSpan(1, Number.NaN)).toBeNull();
    expect(describeSpan(1, 1.09)).toBeNull();
  });

  it("uses exact integer or one-decimal span lengths beside rounded timestamps", () => {
    expect(describeSpan(7, 19)).toBe("0:07 → 0:19 (12s)");
    expect(describeSpan(7, 18.7)).toBe("0:07 → 0:19 (11.7s)");
  });
});
