/**
 * Tests for `recFormat.ts` — the data model and the pure text/audio helpers.
 * Cases ported from `src-tauri/src/recording.rs`'s own behaviour plus the two
 * candidate suites this file merges, with the wire-shape and ordering
 * invariants that the merge itself turned up.
 */

import { describe, expect, it } from "vitest";
import {
  addCut,
  csOfSamples,
  cutShiftBefore,
  decodeWav,
  defaultRecMeta,
  displaySpeaker,
  encodeWav,
  formatStamp,
  insideCut,
  noteKindOf,
  readStampOf,
  samplesOfCs,
  segmentVisibleText,
  spliceOut,
  transcriptText,
  type RecMeta,
  type RecSegment,
  type RecWord,
} from "./recFormat.js";

function word(w: string, t0: number, t1: number, del = false): RecWord {
  return { w, t0, t1, del };
}

function phrase(words: RecWord[], over: Partial<RecSegment> = {}): RecSegment {
  return {
    id: "s1",
    source: "mic",
    speaker: "You",
    t0: words[0]?.t0 ?? 0,
    t1: words[words.length - 1]?.t1 ?? 0,
    text: words.map((w) => w.w).join(" "),
    words,
    lang: null,
    voice: null,
    ...over,
  };
}

describe("encodeWav / decodeWav", () => {
  it("round-trips samples through a 16 kHz mono 16-bit WAV", () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.125]);
    const wav = encodeWav(samples);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.length).toBe(44 + samples.length * 2);
    const back = decodeWav(wav);
    expect(back.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) {
      expect(Math.abs((back[i] as number) - (samples[i] as number))).toBeLessThan(1e-3);
    }
  });

  it("TRUNCATES toward zero like Rust's `as i16`, never rounds", () => {
    // 0.99999 * 32767 = 32766.67…; `as i16` gives 32766, `Math.round` 32767.
    expect(encodeWav(Float32Array.from([0.99999])).readInt16LE(44)).toBe(32766);
    expect(encodeWav(Float32Array.from([-0.99999])).readInt16LE(44)).toBe(-32766);
  });

  it("clamps out-of-range samples rather than wrapping the 16-bit field", () => {
    const wav = encodeWav(Float32Array.from([4, -4]));
    expect(wav.readInt16LE(44)).toBe(32767);
    expect(wav.readInt16LE(46)).toBe(-32767);
  });

  it("rejects bytes that are not a WAV, and a WAV with no data chunk", () => {
    expect(() => decodeWav(Buffer.from("this is not a wav file"))).toThrowError(/not a WAV/);
    expect(() => decodeWav(Buffer.alloc(0))).toThrowError(/not a WAV/);
    const headerOnly = encodeWav(new Float32Array(0)).subarray(0, 44);
    const noData = Buffer.from(headerOnly);
    noData.write("junk", 36, "ascii");
    expect(() => decodeWav(noData)).toThrowError(/no data chunk/);
  });

  it("accepts a plain Uint8Array as well as a Buffer (what a spool read hands over)", () => {
    const wav = encodeWav(Float32Array.from([0.25]));
    expect(decodeWav(new Uint8Array(wav)).length).toBe(1);
  });
});

describe("cut-list math", () => {
  it("addCut merges overlapping spans and keeps the list sorted", () => {
    expect(addCut([{ t0: 100, t1: 200 }], { t0: 150, t1: 300 })).toEqual([{ t0: 100, t1: 300 }]);
    expect(addCut([{ t0: 500, t1: 600 }], { t0: 100, t1: 200 })).toEqual([
      { t0: 100, t1: 200 },
      { t0: 500, t1: 600 },
    ]);
  });

  it("addCut never mutates the list it was given", () => {
    const cuts = [{ t0: 100, t1: 200 }];
    addCut(cuts, { t0: 150, t1: 300 });
    expect(cuts).toEqual([{ t0: 100, t1: 200 }]);
  });

  it("cutShiftBefore accumulates only the cut time strictly before t", () => {
    const cuts = [
      { t0: 100, t1: 200 },
      { t0: 400, t1: 500 },
    ];
    expect(cutShiftBefore(cuts, 50)).toBe(0);
    expect(cutShiftBefore(cuts, 150)).toBe(50);
    expect(cutShiftBefore(cuts, 300)).toBe(100);
    expect(cutShiftBefore(cuts, 1000)).toBe(200);
  });

  it("insideCut is true only within [t0, t1)", () => {
    const cuts = [{ t0: 100, t1: 200 }];
    expect(insideCut(cuts, 99)).toBe(false);
    expect(insideCut(cuts, 100)).toBe(true);
    expect(insideCut(cuts, 199)).toBe(true);
    expect(insideCut(cuts, 200)).toBe(false);
  });

  it("spliceOut removes the cut spans from the sample timeline", () => {
    const samples = new Float32Array(16_000); // 1.00 s
    for (let i = 0; i < samples.length; i++) {
      samples[i] = i / 16_000;
    }
    const out = spliceOut(samples, [{ t0: 25, t1: 50 }]); // drop 0.25s..0.50s
    expect(out.length).toBe(12_000);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[4000]).toBeCloseTo(0.5, 3); // the first sample after the cut
  });

  it("spliceOut clamps a cut that runs past the end, and tolerates unsorted cuts", () => {
    const samples = Float32Array.from({ length: 1600 }, (_, i) => i); // 0.10 s
    expect(spliceOut(samples, [{ t0: 5, t1: 999 }]).length).toBe(800);
    const unsorted = spliceOut(samples, [
      { t0: 8, t1: 10 },
      { t0: 0, t1: 2 },
    ]);
    expect(unsorted.length).toBe(960);
    expect(unsorted[0]).toBe(320);
  });

  it("csOfSamples / samplesOfCs agree with the 16 kHz rate and clamp negatives", () => {
    expect(csOfSamples(16_000)).toBe(100);
    expect(samplesOfCs(100)).toBe(16_000);
    expect(samplesOfCs(-50)).toBe(0);
  });
});

describe("formatStamp", () => {
  it("omits the hour field under an hour and includes it past one", () => {
    expect(formatStamp(0)).toBe("[0:00]");
    expect(formatStamp(-500)).toBe("[0:00]");
    expect(formatStamp(905)).toBe("[0:09]");
    expect(formatStamp(6_500)).toBe("[1:05]");
    expect(formatStamp(360_000)).toBe("[1:00:00]");
    expect(formatStamp(366_500)).toBe("[1:01:05]");
  });
});

describe("segmentVisibleText", () => {
  it("falls back to the raw text when a segment carries no word list", () => {
    expect(segmentVisibleText(phrase([], { text: "  legacy row  " }))).toBe("legacy row");
  });

  it("drops deleted words and joins what remains", () => {
    const seg = phrase([word("keep", 0, 10), word("drop", 10, 20, true), word("this", 20, 30)]);
    expect(segmentVisibleText(seg)).toBe("keep this");
  });

  it("drops words that are only whitespace", () => {
    expect(segmentVisibleText(phrase([word("a", 0, 10), word("   ", 10, 20), word("b", 20, 30)]))).toBe("a b");
  });
});

describe("noteKindOf", () => {
  it("passes the four real kinds through and normalizes anything else to a point", () => {
    expect(noteKindOf("decision")).toBe("decision");
    expect(noteKindOf(" action ")).toBe("action");
    expect(noteKindOf("question")).toBe("question");
    expect(noteKindOf("point")).toBe("point");
    // The refusal Rust's own `_ => NoteKind::Point` arm makes: a kind nobody
    // knows must be STORED as a point, not stored verbatim and rendered as a
    // label the reader has never seen.
    expect(noteKindOf("Decision")).toBe("point");
    expect(noteKindOf("urgent!!")).toBe("point");
    expect(noteKindOf("")).toBe("point");
  });
});

describe("transcriptText", () => {
  function meta(over: Partial<RecMeta>): RecMeta {
    return { ...defaultRecMeta(), ...over };
  }

  it("interleaves chapters and notes by time, names speakers, and MARKS highlights", () => {
    const out = transcriptText(
      meta({
        segments: [
          phrase([word("hello", 0, 50)], { id: "a", speaker: "Speaker 1", t0: 0, t1: 50 }),
          phrase([word("goodbye", 500, 550)], { id: "b", speaker: "Speaker 2", t0: 500, t1: 550 }),
        ],
        speakerNames: { "Speaker 1": "Dana" },
        chapters: [{ id: "c1", t0: 400, title: "Wrap up", by: "room" }],
        notes: [{ id: "n1", t0: 400, kind: "action", text: "send the deck", who: "Dana", by: "room" }],
        highlights: [{ id: "h1", t0: 500, t1: 550, by: "you" }],
      })
    );
    expect(out).toBe(
      "(live recording)\n" +
        "[0:00] Dana: hello\n" +
        "\n## [0:04] Wrap up\n" +
        "[0:04] Action (Dana): send the deck\n" +
        "* [0:05] Speaker 2: goodbye\n"
    );
    // A highlight marks the line; it never copies the words onto a line of
    // their own, or every marked sentence lands in the search index twice.
    expect(out.match(/goodbye/g)).toHaveLength(1);
  });

  it("still emits chapters and notes anchored past the last phrase", () => {
    const out = transcriptText(
      meta({
        segments: [phrase([word("hi", 0, 50)])],
        chapters: [{ id: "c", t0: 9_000, title: "After", by: "you" }],
        notes: [{ id: "n", t0: 9_000, kind: "point", text: "later", by: "you" }],
      })
    );
    expect(out).toContain("\n## [1:30] After\n");
    expect(out).toContain("[1:30] Point: later\n");
  });

  it("skips a segment whose words are all deleted", () => {
    const out = transcriptText(
      meta({ segments: [phrase([word("gone", 0, 50, true)]), phrase([word("kept", 60, 90)])] })
    );
    expect(out).not.toContain("gone");
    expect(out).toContain("kept");
  });

  it("labels an action with `who` only for an action note", () => {
    const out = transcriptText(
      meta({
        segments: [phrase([word("hi", 100, 150)])],
        notes: [
          { id: "n1", t0: 0, kind: "action", text: "do it", who: "Dana", by: "room" },
          { id: "n2", t0: 0, kind: "question", text: "when?", who: "Dana", by: "room" },
        ],
      })
    );
    expect(out).toContain("[0:00] Action (Dana): do it\n");
    expect(out).toContain("[0:00] Open question: when?\n");
  });
});

describe("displaySpeaker", () => {
  it("prefers the user's name and falls back to the machine label", () => {
    const meta = { ...defaultRecMeta(), speakerNames: { "Speaker 1": "Dana" } };
    expect(displaySpeaker(meta, "Speaker 1")).toBe("Dana");
    expect(displaySpeaker(meta, "Speaker 2")).toBe("Speaker 2");
  });
});

describe("readStampOf", () => {
  it("counts turns, and UTF-8 BYTES of text like Rust's String::len", () => {
    // Rust's `s.text.len()` is byte length. "שלום" is 4 chars but 8 bytes —
    // measuring code points here would let a Hebrew transcript edited on one
    // side read as unchanged on the other.
    expect(readStampOf([phrase([], { text: "abc" })])).toEqual({ turns: 1, chars: 3 });
    expect(readStampOf([phrase([], { text: "שלום" })])).toEqual({ turns: 1, chars: 8 });
    expect(readStampOf([])).toEqual({ turns: 0, chars: 0 });
  });
});
