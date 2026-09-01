/**
 * Tests for `shotsplitTools.ts` — a direct, side-by-side port of
 * `src-tauri/src/commands/shotsplit.rs`'s own `#[cfg(test)] mod tests`
 * (eleven tests) and `mod episode_tests` (one test, against the same fixture
 * file: `src-tauri/tests/fixtures/episode-chunks.md`, read directly rather
 * than copied, the same "both trees still exist side by side" posture
 * `browser/pageScript.test.ts` already takes for `page.js` — guarded with
 * `it.skipIf` so a checkout without the Rust tree still runs everything else
 * green.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_PARTS,
  partsFor,
  scriptChunks,
  sentences,
  splitScript,
  splitWords,
} from "./shotsplitTools.js";

/** `text.split_whitespace().map(str::to_string).collect()` — the invariant
 * the whole module exists for. */
function words(text: string): string[] {
  return text.split(/\s+/u).filter((w) => w !== "");
}

/** `haystack.matches(needle).count()` — non-overlapping substring count. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

describe("splitScript", () => {
  it("every word of the script survives the split", () => {
    // A model asked to do this drops a sentence it judged redundant and
    // rewrites another. This cannot: put the parts back together and the
    // words are the words.
    const script =
      "The harbour is empty. Mira walks the quay, counting. " +
      "A light comes on in the chandlery! Doran is already there. " +
      "He does not turn around… She asks him where the boat went. " +
      "He says nothing at all. The tide turns.";
    for (const parts of [2, 3, 5, 8]) {
      const shots = splitScript(script, parts);
      expect(shots.length, `asked for ${parts}`).toBe(parts);
      expect(
        words(shots.join(" ")),
        `text lost or invented at ${parts} parts`,
      ).toEqual(words(script));
    }
  });

  it("a five-minute script becomes twenty shots", () => {
    // The case this was built for: 300 seconds at 15 a shot.
    expect(partsFor(300, 15)).toBe(20);
    let script = "";
    for (let n = 1; n <= 40; n += 1) {
      script += `Beat number ${n} happens here. `;
    }
    const shots = splitScript(script, 20);
    expect(shots.length).toBe(20);
    expect(
      shots.every((s) => s !== ""),
      "no empty shot",
    ).toBe(true);
    expect(words(shots.join(" "))).toEqual(words(script));
    // Evenly spread — not nineteen crumbs and one monster. Every shot is the
    // same 15 seconds on screen, so they should carry the same load.
    const beats = shots.map((s) => countOccurrences(s, "Beat number"));
    expect(
      beats.reduce((a, b) => a + b, 0),
      "every beat placed once",
    ).toBe(40);
    expect(
      beats.every((n) => n >= 1 && n <= 3),
      `one shot got far more than its share: ${JSON.stringify(beats)}`,
    ).toBe(true);
  });

  it("one long paragraph still makes the count", () => {
    // A real way people write: no full stops at all. Splitting on word
    // boundaries is the fallback, and it must not cut mid-word.
    const script =
      "she walks the length of the quay counting the moorings " +
      "one by one until she reaches the empty berth where the " +
      "boat used to be tied up every winter";
    const shots = splitScript(script, 6);
    expect(shots.length).toBe(6);
    expect(words(shots.join(" "))).toEqual(words(script));
    expect(shots.every((s) => s !== "")).toBe(true);
  });

  it("asking for more shots than there are words pads rather than loses", () => {
    // A blank shot is visible and editable. A dropped line is neither.
    const shots = splitScript("Two words", 5);
    expect(shots.length).toBe(5);
    expect(words(shots.join(" "))).toEqual(words("Two words"));
  });

  it("the share is by length not by sentence count", () => {
    // One long paragraph and several short lines must not put the paragraph
    // alone against a row of near-empty shots.
    const long = "x ".repeat(200);
    const script = `${long}. Short one. Short two. Short three.`;
    const shots = splitScript(script, 4);
    expect(shots.length).toBe(4);
    const lengths = shots.map((s) => Array.from(s).length);
    // The long paragraph is broken ACROSS shots rather than left whole
    // against three near-empty ones — same seconds, same share of text.
    expect(
      lengths[0]!,
      `the long paragraph was left as one shot: ${JSON.stringify(lengths)}`,
    ).toBeLessThan(long.length / 2);
    const biggest = Math.max(...lengths);
    const smallest = Math.min(...lengths);
    expect(
      biggest,
      `wildly uneven shots: ${JSON.stringify(lengths)}`,
    ).toBeLessThanOrEqual(smallest * 4);
    expect(words(shots.join(" "))).toEqual(words(script));
  });

  it("a runaway count is clamped rather than queued", () => {
    // Each shot is a paid generation. A mistyped runtime must not become a
    // thousand of them.
    expect(partsFor(4294967295, 1)).toBe(MAX_PARTS);
    expect(splitScript("A. B. C.", 10_000).length).toBe(MAX_PARTS);
    // And rounding UP, so nothing at the end is quietly dropped.
    expect(partsFor(305, 15)).toBe(21);
    expect(partsFor(1, 15)).toBe(1);
  });

  it("sentence ends keep their own punctuation", () => {
    const pieces = sentences("One! Two? Three… Four.");
    expect(pieces.length).toBe(4);
    expect(pieces[0]!.startsWith("One!")).toBe(true);
    expect(pieces[1]!.trim().startsWith("Two?")).toBe(true);
    expect(pieces[2]!.trim().startsWith("Three…")).toBe(true);
    expect(pieces.join("")).toBe("One! Two? Three… Four.");
  });

  it("keeps direct one-piece word splits and sentence spacing exact", () => {
    expect(splitWords("one \u{1F680} word", 0)).toEqual(["one \u{1F680} word"]);
    expect(splitWords("one \u{1F680} word", 1)).toEqual(["one \u{1F680} word"]);
  });
});

/** A slice of the real episode the feature was reported against — the
 * markers, the em/en dashes, the scene headings between beats, and the one
 * beat that is 10 seconds rather than 15. Ported verbatim from the Rust
 * `const EPISODE: &str`. */
const EPISODE = `# Episode 1: The First Echo — 15-Second Chunk Breakdown

*Condensed ~5-minute pacing pass.*

---

## COLD OPEN — EXT. LUMINA — MARKET DISTRICT — DAY

**00:00–00:15** — Establishing Lumina: transit rings, terraced garden-blocks. Noa (12) weaves through the market stalls.

**00:15–00:30** — A fruit-seller's hand closes on empty air. NOA: "Okay. That's new." SMASH CUT TO TITLE.

---

## ACT ONE

### EXT. LUMINA — MARKET DISTRICT — CONTINUOUS

**00:30–00:45** — Noa charges the shape — nothing works.

### INT. NOA & LIOR'S APARTMENT — NIGHT

**01:00–01:15** — Home, unsettled. Lior deflects Noa's questions.

**03:00–03:10** — As the memory frays, Sena's head tilts. The tunnel dissolves into golden static.
`;

describe("scriptChunks", () => {
  it("a script that already declares its chunks is taken at its word", () => {
    // The reported failure. This script was ALREADY broken into shots by its
    // author, with the lengths they chose — re-cutting it by character count
    // would put boundaries in the middle of their beats, which is exactly
    // what makes a storyboard useless.
    const chunks = scriptChunks(EPISODE);
    expect(chunks, "the markers are found").toBeDefined();
    expect(chunks!.length, "one shot per timestamp, not per paragraph").toBe(5);

    // Lengths come from the author's own timestamps — including the
    // 10-second beat, which a single "seconds each" number would have
    // silently made 15.
    const seconds = chunks!.map((c) => c.seconds);
    expect(seconds).toEqual([15, 15, 15, 15, 10]);

    // The timestamp itself never reaches the prompt.
    expect(chunks!.every((c) => !c.action.includes("00:"))).toBe(true);
    expect(chunks!.every((c) => !c.action.includes("**"))).toBe(true);
  });

  it("the scene heading travels down onto the beat it introduces", () => {
    // A screenplay puts the scene line ABOVE the action. It is also the
    // single most useful line for drawing the shot — the setting, stated
    // exactly — so it is carried onto the beat rather than discarded as
    // markup, and never left on the beat before it.
    const chunks = scriptChunks(EPISODE);
    expect(chunks).toBeDefined();
    expect(
      chunks![0]!.action.startsWith(
        "COLD OPEN — EXT. LUMINA — MARKET DISTRICT — DAY",
      ),
      `first beat lost its scene: ${JSON.stringify(chunks![0]!.action)}`,
    ).toBe(true);
    expect(
      chunks![2]!.action.includes("EXT. LUMINA — MARKET DISTRICT — CONTINUOUS"),
      `a heading between beats went to the wrong one: ${JSON.stringify(chunks![2]!.action)}`,
    ).toBe(true);
    expect(
      chunks![3]!.action.includes("INT. NOA & LIOR'S APARTMENT — NIGHT"),
    ).toBe(true);
    // And the beat BEFORE a heading must not have swallowed it.
    expect(chunks![1]!.action.includes("ACT ONE")).toBe(false);
  });

  it("ordinary prose is not mistaken for a shot list", () => {
    // One stray clock in a sentence is not an author's shot list, and must
    // not switch off the length-based split.
    expect(
      scriptChunks("We start at 9:00 and finish when we finish."),
    ).toBeUndefined();
    expect(scriptChunks("No numbers here at all.")).toBeUndefined();
    // A duration written as a range in prose, once, is still not a list.
    expect(scriptChunks("It runs 00:00-05:00 in total.")).toBeUndefined();
  });

  it("a dash is whichever dash the writer typed", () => {
    for (const dash of ["-", "–", "—"]) {
      const script = `**00:00${dash}00:15** — One.\n\n**00:15${dash}00:30** — Two.`;
      const chunks = scriptChunks(script);
      expect(chunks, `dash ${dash}`).toBeDefined();
      expect(chunks!.length).toBe(2);
      expect(chunks![0]!.seconds).toBe(15);
    }
  });

  it("skips a malformed range, accepts spaces around a marker dash, and joins action lines", () => {
    const script =
      "**00:00 00:15** — prose, not a range.\n\n" +
      "**00:00 – 00:15** — First action line.\nSecond action line.\n\n" +
      "**00:15 – 00:30** — Final action.";
    const chunks = scriptChunks(script);
    expect(chunks).toHaveLength(2);
    expect(chunks![0]).toMatchObject({
      seconds: 15,
      action: "First action line. Second action line",
    });
    expect(chunks![0]!.action).not.toContain("not a range");
  });
});

describe("episode fixture (commands/shotsplit.rs's mod episode_tests)", () => {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../src-tauri/tests/fixtures/episode-chunks.md",
  );
  const haveRust = existsSync(fixturePath);

  it.skipIf(!haveRust)(
    "the reported episode yields its own twenty-one chunks",
    () => {
      // The real file, read from disk, cut the way the app cuts it. A unit
      // test on a hand-trimmed excerpt proves the parser; this proves the
      // SCRIPT — headings, rules, a preamble, an end-matter line carrying its
      // own "5:00", and beats that are not all the same length.
      const script = readFileSync(fixturePath, "utf8");
      const chunks = scriptChunks(script);
      expect(chunks, "the markers are found").toBeDefined();

      // TWENTY-ONE, not twenty. The script's own heading says "20 chunks" and
      // its body contains 21 timestamped beats — they total exactly 5:00, so
      // the beats are right and the heading is off by one. What is WRITTEN
      // wins: silently dropping a beat to match a heading would lose fifteen
      // seconds of someone's episode.
      expect(chunks!.length, "one shot per beat actually written").toBe(21);

      const total = chunks!.reduce((sum, c) => sum + c.seconds, 0);
      expect(total, "five minutes exactly").toBe(300);

      // The three short beats keep their own length rather than being
      // flattened to fifteen.
      expect(chunks!.filter((c) => c.seconds === 10).length).toBe(3);

      // The closing "END OF EPISODE 1 — condensed to 5:00…" is a note to a
      // reader, not something to draw, and must not ride on the last shot.
      const last = chunks![chunks!.length - 1]!.action;
      expect(
        last.includes("Reassign our star cadet"),
        JSON.stringify(last),
      ).toBe(true);
      expect(
        last.includes("END OF"),
        `end matter reached a prompt: ${JSON.stringify(last)}`,
      ).toBe(false);
      expect(last.includes("300 seconds"), JSON.stringify(last)).toBe(false);

      // Every beat carries its scene, and none carries a timestamp.
      expect(chunks![0]!.action.includes("MARKET DISTRICT")).toBe(true);
      expect(
        chunks!.every(
          (c) => !c.action.includes("–") || !c.action.includes(":00–"),
        ),
      ).toBe(true);
      expect(chunks!.every((c) => c.action !== "")).toBe(true);
    },
  );
});

// ============================================================================
// ADVERSARIAL — inputs Rust's type system made impossible and JS's does not
// ============================================================================

describe("splitScript / partsFor, non-integer part counts", () => {
  it("REGRESSION: a NaN part count does not crash — Rust's `parts: usize` could never be NaN", () => {
    // `splitScript("", NaN)` reached `new Array(NaN)` and threw
    // `RangeError: Invalid array length`. Reachable for real: `storyPlanSplit`
    // forwards its own `minutes`/`secondsEach` into `partsFor`, and Electron
    // IPC (structuredClone) carries a NaN from the renderer where Tauri's
    // JSON argument decoding never could.
    expect(() => splitScript("", Number.NaN)).not.toThrow();
    expect(splitScript("", Number.NaN)).toEqual([""]);
    expect(splitScript("One. Two. Three.", Number.NaN)).toHaveLength(1);
    expect(partsFor(Number.NaN, 15)).toBe(1);
    expect(partsFor(300, Number.NaN)).toBe(80);
  });

  it("REGRESSION: a FRACTIONAL part count truncates like a usize cast, never yielding a half shot", () => {
    // Was 3 shots for `parts = 2.7`.
    expect(splitScript("A. B. C.", 2.7)).toHaveLength(2);
    expect(splitScript("A. B. C.", 3.999)).toHaveLength(3);
    expect(splitScript("A. B. C.", 0.9)).toHaveLength(1);
  });

  it("a negative or infinite part count clamps into 1..MAX_PARTS rather than misbehaving", () => {
    expect(splitScript("A. B. C.", -5)).toHaveLength(1);
    expect(splitScript("A. B. C.", Number.NEGATIVE_INFINITY)).toHaveLength(1);
    expect(splitScript("A. B. C.", Number.POSITIVE_INFINITY)).toHaveLength(
      MAX_PARTS,
    );
    expect(partsFor(-1, 15)).toBe(1);
    expect(partsFor(Number.POSITIVE_INFINITY, 15)).toBe(MAX_PARTS);
    expect(partsFor(300, -15)).toBe(80);
    expect(partsFor(300, 0)).toBe(80);
  });

  it("EVERY part count in 1..=MAX_PARTS returns exactly that many shots, and loses no word", () => {
    // The module's two contracts, asserted across the whole legal range
    // rather than the four values the Rust suite samples.
    const script =
      "The harbour is empty. Mira walks the quay, counting. A light comes on! " +
      "Doran is already there. He does not turn around… She asks where the boat went.";
    for (let parts = 1; parts <= MAX_PARTS; parts += 1) {
      const shots = splitScript(script, parts);
      expect(shots, `parts=${parts}`).toHaveLength(parts);
      expect(words(shots.join(" ")), `parts=${parts}`).toEqual(words(script));
    }
  });
});

describe("Unicode fidelity, adversarial", () => {
  it("never splits an astral-plane character in half — the whole reason this port counts scalars, not UTF-16 units", () => {
    // Every one of these is a SURROGATE PAIR in JS: `.length` says 2, Rust's
    // `chars().count()` says 1. A port that measured with `.length` and
    // indexed with `[]` would cut between the halves and emit a lone
    // surrogate — an unpaired code unit that is not valid text at all.
    const emoji = "👩‍🚀🌌🛰️🚀🪐✨🔭🌠";
    const script = `${emoji} sails past. ${emoji} waves back! ${emoji} vanishes… ${emoji} returns.`;
    for (const parts of [2, 3, 5, 9, 20]) {
      const shots = splitScript(script, parts);
      expect(shots, `parts=${parts}`).toHaveLength(parts);
      expect(words(shots.join(" ")), `parts=${parts}`).toEqual(words(script));
      for (const shot of shots) {
        // No lone surrogate survived anywhere: re-encoding round-trips.
        expect(shot.includes("�"), JSON.stringify(shot)).toBe(false);
        for (let i = 0; i < shot.length; i += 1) {
          const code = shot.charCodeAt(i);
          const isHigh = code >= 0xd800 && code <= 0xdbff;
          const isLow = code >= 0xdc00 && code <= 0xdfff;
          if (isHigh) {
            const next = shot.charCodeAt(i + 1);
            expect(
              next >= 0xdc00 && next <= 0xdfff,
              `lone high surrogate in ${JSON.stringify(shot)}`,
            ).toBe(true);
            i += 1;
          } else {
            expect(isLow, `lone low surrogate in ${JSON.stringify(shot)}`).toBe(
              false,
            );
          }
        }
      }
    }
  });

  it("an RTL/Hebrew script splits and round-trips like any other", () => {
    const script =
      "הנמל ריק. מירה הולכת על הרציף. אור נדלק בחנות! דורן כבר שם.";
    const shots = splitScript(script, 4);
    expect(shots).toHaveLength(4);
    expect(words(shots.join(" "))).toEqual(words(script));
  });

  it("a whitespace-only or empty script still produces exactly the count asked for", () => {
    for (const script of ["", "   ", "\n\n\n", "\t"]) {
      const shots = splitScript(script, 5);
      expect(shots, JSON.stringify(script)).toHaveLength(5);
      expect(shots.join("").trim(), JSON.stringify(script)).toBe("");
    }
  });

  it("a script that is one enormous unbroken word cannot be cut mid-word, and pads instead", () => {
    const script = "x".repeat(5000);
    const shots = splitScript(script, 10);
    expect(shots).toHaveLength(10);
    expect(shots.join("")).toBe(script);
    // Word boundaries win over evenness: one piece keeps the whole word.
    expect(shots.filter((s) => s !== "")).toHaveLength(1);
  });
});

describe("scriptChunks, adversarial timestamps", () => {
  it("an out-of-range or malformed clock is not a marker", () => {
    // `99:99` — seconds >= 60 is refused by read_clock.
    expect(
      scriptChunks("**00:00–99:99** — One.\n\n**99:99–00:30** — Two."),
    ).toBeUndefined();
    // A clock reached from mid-number is not a timestamp.
    expect(
      scriptChunks("1234:56–1234:57 one\n\n1234:58–1234:59 two"),
    ).toBeUndefined();
    // One digit of seconds is not a clock.
    expect(
      scriptChunks("**0:0–0:1** — One.\n\n**0:1–0:2** — Two."),
    ).toBeUndefined();
    // A single marker is not a shot list, however well-formed.
    expect(scriptChunks("**00:00–00:15** — Only one beat.")).toBeUndefined();
  });

  it("an inverted or zero-length range clamps to a usable length rather than refusing the script", () => {
    const chunks = scriptChunks(
      "**00:30–00:00** — Backwards.\n\n**01:00–01:00** — Zero.",
    );
    expect(chunks).toBeDefined();
    expect(chunks!.map((c) => c.seconds)).toEqual([1, 1]);
  });

  it("a beat longer than a minute clamps to 60 — the catalogue's own ceiling", () => {
    const chunks = scriptChunks(
      "**00:00–05:00** — Long.\n\n**05:00–10:00** — Longer.",
    );
    expect(chunks!.map((c) => c.seconds)).toEqual([60, 60]);
  });

  it("a marker buried mid-sentence is prose about the episode, not a beat in it", () => {
    // The reported bug: a preamble reading "exactly 20 chunks of 15 seconds
    // each (00:00–05:00)" counted as an extra shot and shifted every scene
    // heading onto the wrong beat.
    const script =
      "This runs 00:00–05:00 in total and has 00:00–00:15 chunks.\n\n" +
      "**00:00–00:15** — One.\n\n**00:15–00:30** — Two.";
    const chunks = scriptChunks(script);
    expect(chunks).toHaveLength(2);
    expect(chunks![0]!.action.includes("in total")).toBe(false);
  });

  it("no chunk's action ever carries a timestamp, a bold marker, or end matter", () => {
    const script =
      "**00:00–00:15** — **Bold** action here.\n\n" +
      "**00:15–00:30** — More action.\n\n" +
      "**END OF EPISODE 1 — condensed to 5:00 (300 seconds)**";
    const chunks = scriptChunks(script)!;
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      expect(c.action.includes("**"), c.action).toBe(false);
      expect(c.action.includes("00:"), c.action).toBe(false);
      expect(c.action.includes("END OF"), c.action).toBe(false);
      expect(c.action.includes("300 seconds"), c.action).toBe(false);
    }
  });
});
