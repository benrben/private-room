import { describe, expect, it } from "vitest";
import {
  formatStamp,
  parseCues,
  parseStamp,
  shortStamp,
  toSrt,
  toVtt,
} from "./subtitles";

describe("subtitle timestamps", () => {
  it("parses both dialects, rejects malformed values, and formats display values", () => {
    expect(parseStamp("01:02:03,4")).toBe(3_723_400);
    expect(parseStamp("02:03.45")).toBe(123_450);
    expect(parseStamp("bad stamp")).toBeNull();
    expect(formatStamp(-1.4)).toBe("00:00:00,000");
    expect(formatStamp(3_723_004, ".")).toBe("01:02:03.004");
    expect(shortStamp(62_499)).toBe("1:02");
    expect(shortStamp(3_661_000)).toBe("1:01:01");
  });
});

describe("parseCues", () => {
  it("keeps SRT cue ids, text, empty cues, and skips malformed blocks", () => {
    const cues = parseCues([
      "1",
      "00:00:01,000 --> 00:00:02,250",
      "First line",
      "Second line",
      "",
      "not-a-timing-line",
      "",
      "2",
      "00:00:03,000 --> 00:00:04,000",
      "",
      "invalid",
      "00:xx:03,000 --> 00:00:04,000",
    ].join("\n"));

    expect(cues).toEqual([
      {
        index: 1,
        id: "1",
        startMs: 1_000,
        endMs: 2_250,
        text: "First line\nSecond line",
      },
      { index: 2, id: "2", startMs: 3_000, endMs: 4_000, text: "" },
    ]);
  });

  it("normalizes CRLF and carries WebVTT metadata before, between, and after cues", () => {
    const raw = [
      "WEBVTT - captions",
      "Language: en",
      "",
      "NOTE source note",
      "Keep this note",
      "",
      "intro",
      "00:00.500 --> 00:02.000 line:90% align:start",
      "Hello",
      "",
      "STYLE",
      "::cue { color: lime; }",
      "",
      "REGION",
      "id:bottom",
      "",
      "00:02.000 --> 00:03.000",
      "World",
      "",
      "NOTE trailing",
      "Keep this too",
    ].join("\r\n");

    expect(parseCues(raw)).toEqual([
      {
        index: 1,
        id: "intro",
        startMs: 500,
        endMs: 2_000,
        settings: "line:90% align:start",
        text: "Hello",
        before: [
          "WEBVTT - captions\nLanguage: en",
          "NOTE source note\nKeep this note",
        ],
      },
      {
        index: 2,
        startMs: 2_000,
        endMs: 3_000,
        text: "World",
        before: ["STYLE\n::cue { color: lime; }", "REGION\nid:bottom"],
        after: ["NOTE trailing\nKeep this too"],
      },
    ]);
  });

  it("returns no cues for an empty or metadata-only input", () => {
    expect(parseCues("\n\n")).toEqual([]);
    expect(parseCues("WEBVTT\n\nNOTE alone")).toEqual([]);
  });
});

describe("subtitle serialization", () => {
  it("writes numbered SRT with a final newline", () => {
    const cues = parseCues([
      "source-id",
      "00:00.500 --> 00:01.250 line:10%",
      "Text",
      "",
      "00:02.000 --> 00:03.000",
      "",
    ].join("\n"));

    expect(toSrt(cues)).toBe([
      "1",
      "00:00:00,500 --> 00:00:01,250",
      "Text",
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      "",
      "",
    ].join("\n"));
  });

  it("writes WebVTT headers, metadata, ids, settings, trailing blocks, and the empty document", () => {
    const cues = parseCues([
      "WEBVTT",
      "",
      "NOTE before",
      "",
      "caption-id",
      "00:00.000 --> 00:01.000 line:20%",
      "Caption",
      "",
      "STYLE",
      "::cue { color: red; }",
      "",
      "00:01.000 --> 00:02.000",
      "Second",
      "",
      "REGION",
      "id:tail",
    ].join("\n"));

    expect(toVtt(cues)).toBe([
      "WEBVTT",
      "",
      "NOTE before",
      "",
      "caption-id",
      "00:00:00.000 --> 00:00:01.000 line:20%",
      "Caption",
      "",
      "STYLE",
      "::cue { color: red; }",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Second",
      "",
      "REGION",
      "id:tail",
      "",
    ].join("\n"));
    expect(toVtt([])).toBe("WEBVTT\n");
  });
});
