/**
 * Tests for `recRead.ts`.
 *
 * The first blocks port `src-tauri/src/commands/jobs/rec_read.rs`'s own
 * `#[cfg(test)] mod tests` VERBATIM — all seven fixtures, same names, same
 * numbers. Those cover the two properties the Rust module header calls
 * load-bearing:
 *
 *   1. `partitionTurns` never splits a speaker turn, never leaves a gap, and
 *      never drops one (the `#minutes` bug: a clamp meant a recording was read
 *      for its first five minutes and reported as read).
 *   2. A turn NUMBER the model answered with is resolved against the REAL turn
 *      list and DROPPED when it is out of range — so a hallucinated timestamp
 *      is structurally impossible, not merely unlikely.
 *
 * The rest covers what the port adds around them: the UTF-8 byte-length
 * subtlety, the strict untrusted-JSON coercion that is part of property (2),
 * the model-facing note-kind synonyms, the cancellable sidecar POST against a
 * real `http.Server`, and the job-runner glue driven against a real `.roomai`
 * room via `createRoom`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import { CancelFlag, createCancelState, type CancelState } from "./cancel.js";
import { insertFile } from "./db-host/files.js";
import {
  checkpointJob,
  createJob,
  getJob,
  getJobArtifact,
  putJobArtifact,
  setJobStatus,
} from "./db-host/jobs.js";
import { createRoom } from "./db-host/open.js";
import { getRecMeta, setRecMeta } from "./db-host/recordings.js";
import { resetBaseUrlOverrideForTests, resolvedBaseUrl, setBaseUrlOverride } from "./engineRouting.js";
import { createJobQueueState, type JobQueueDeps, type JobQueueState } from "./jobQueue.js";
import type { JobProgressPayload, ProgressSink, RoomHandle, RoomSource, Step } from "./jobs.js";
import * as obs from "./obs.js";
import {
  defaultRecMeta,
  encodeWav,
  readStampOf,
  type RecMeta,
  type RecNote,
  type RecSegment,
} from "./recFormat.js";
import { inflightCount } from "./sidecar.js";
import {
  buildReadSteps,
  coerceReadArtifact,
  defaultReadArtifact,
  executeReadStep,
  installFindings,
  isFatal,
  mergeFindings,
  parseReadPlan,
  partitionTurns,
  READ_WINDOW_CHARS,
  readingNow,
  readProgressLabel,
  recReadRowStarter,
  RESOLVE_READ_ENGINE_NOT_IMPLEMENTED,
  sidecarErrorSentinel,
  sidecarJsonCancellable,
  sidecarJsonCancellableAt,
  spawnRecRead,
  startRecRead,
  turnsMoved,
  turnsOf,
  visibleChars,
  windowText,
  type FoundChapter,
  type FoundHighlight,
  type FoundNote,
  type ReadArtifact,
  type ReadPlan,
  type RecReadExtraDeps,
  type RecReadLog,
  type RecReadRunnerDeps,
  type RecReadSidecarCall,
  type ResolveReadEngine,
  type Turn,
} from "./recRead.js";

// ============================================================================
// fixtures
// ============================================================================

let tmpDir = "";
let server: http.Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (tmpDir !== "") {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
  resetBaseUrlOverrideForTests();
  vi.restoreAllMocks();
});

function freshRoom(): { db: Database.Database; path: string } {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "recRead-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return { db: createRoom(roomPath, "correct horse battery staple", "Test Room"), path: roomPath };
}

function addRecording(db: Database.Database, name: string, meta: RecMeta): string {
  const file = insertFile(
    db,
    name,
    "audio/wav",
    encodeWav(new Float32Array(0)),
    "(live recording)\n",
    "recording"
  );
  setRecMeta(db, file.id, JSON.stringify(meta));
  return file.id;
}

function seg(t0: number, t1: number, speaker: string, text: string): RecSegment {
  return { id: randomUUID(), source: "mic", speaker, t0, t1, text, words: [] };
}

function metaOf(segments: RecSegment[]): RecMeta {
  return { ...defaultRecMeta(), durationCs: segments.at(-1)?.t1 ?? 0, segments };
}

/** `rec_read.rs`'s own `fn turn(..)`. */
function turn(t0: number, who: string, text: string): Turn {
  return { t0, t1: t0 + 100, who, text };
}

/** `rec_read.rs`'s own `fn turns(n)`. */
function turns(n: number): Turn[] {
  return Array.from({ length: n }, (_, i) => turn(i * 100, "Dana", "a sentence of some length here"));
}

function segmentsFor(list: readonly Turn[]): RecSegment[] {
  return list.map((t) => seg(t.t0, t.t1, t.who, t.text));
}

function chapter(over: Partial<FoundChapter> & { turn: number }): FoundChapter {
  return { title: "", ...over };
}
function highlight(over: Partial<FoundHighlight> & { turn: number }): FoundHighlight {
  return { until: 0, ...over };
}
function note(over: Partial<FoundNote> & { turn: number; kind: string; text: string }): FoundNote {
  return { who: null, ...over };
}
function artifact(over: Partial<ReadArtifact> = {}): ReadArtifact {
  return { ...defaultReadArtifact(), ...over };
}

// ============================================================================
// turnsOf
// ============================================================================

describe("turnsOf", () => {
  it("drops an all-deleted (empty) turn and applies the speaker's display name", () => {
    const meta = metaOf([
      seg(0, 100, "Speaker 1", "hello there"),
      { ...seg(100, 200, "Speaker 1", "gone"), words: [{ w: "gone", t0: 100, t1: 200, del: true }] },
    ]);
    meta.speakerNames["Speaker 1"] = "Dana";
    const out = turnsOf(meta);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ t0: 0, t1: 100, who: "Dana", text: "hello there" });
  });
});

// ============================================================================
// partitionTurns — the window-boundary guarantees, ported from rec_read.rs
// ============================================================================

describe("partitionTurns", () => {
  /** THE property. `#minutes` once read the first five minutes of a recording
   * and reported the whole thing as read, because of a clamp. Every turn must
   * land in exactly one window, and the windows must cover the meeting end to
   * end with no gap. */
  it("every_turn_is_read_exactly_once (ported from rec_read.rs)", () => {
    for (const n of [1, 2, 7, 50, 501]) {
      const all = turns(n);
      const windows = partitionTurns(all, 400);
      expect(windows[0]?.[0], `n=${n}`).toBe(0);
      expect(windows.at(-1)?.[1], `n=${n}`).toBe(n);
      for (let i = 0; i + 1 < windows.length; i++) {
        expect(windows[i]?.[1], `a gap or an overlap at n=${n}`).toBe(windows[i + 1]?.[0]);
      }
      const covered = windows.reduce((sum, [a, b]) => sum + (b - a), 0);
      expect(covered, `n=${n}`).toBe(n);
      expect(
        windows.every(([a, b]) => a < b),
        `an empty window at n=${n}`
      ).toBe(true);
    }
  });

  /** A single turn longer than the whole budget still gets read. Coverage beats
   * tidiness — the alternative is silently skipping it, or splitting a
   * sentence across two windows so it is read twice and understood neither
   * time. */
  it("one_enormous_turn_gets_its_own_window (ported from rec_read.rs)", () => {
    const all = [turn(0, "Dana", "x".repeat(50_000)), turn(100, "Yossi", "ok")];
    expect(partitionTurns(all, 12_000)).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("a turn is never split: the boundary always falls BETWEEN two turns", () => {
    // Six turns whose frames do not divide the budget evenly, so at least one
    // boundary is forced mid-budget rather than at a tidy multiple.
    const all = [
      turn(0, "Dana", "a".repeat(90)),
      turn(100, "Yossi", "b".repeat(30)),
      turn(200, "Dana", "c".repeat(140)),
      turn(300, "Yossi", "d".repeat(20)),
      turn(400, "Dana", "e".repeat(70)),
      turn(500, "Yossi", "f".repeat(200)),
    ];
    const windows = partitionTurns(all, 200);
    // Every boundary is an integer turn index, in order, gapless, covering all.
    expect(windows.every(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a < b)).toBe(true);
    expect(windows[0]?.[0]).toBe(0);
    expect(windows.at(-1)?.[1]).toBe(all.length);
    // Concatenating the windows' text reproduces every turn exactly once, in
    // order — the strongest statement of "no turn was cut in half".
    const rebuilt = windows.map((w) => windowText(all, w)).join("");
    expect(rebuilt).toBe(windowText(all, [0, all.length]));
  });

  it("measures UTF-8 BYTES, not JS string length — a Hebrew turn moves the budget by what Rust's String::len() would", () => {
    // "שלום" is 4 code points, 8 UTF-8 bytes, 4 UTF-16 code units — a
    // `.length`-based port would under-count this by half and pack twice as
    // much Hebrew into a window as the Rust original does.
    const hebrew = "שלום עולם זה יום טוב מאוד היום ונפגש";
    const all = [turn(0, "Dana", hebrew), turn(100, "Dana", hebrew)];
    const byteLen = Buffer.byteLength(hebrew, "utf8") + Buffer.byteLength("Dana", "utf8") + 16;
    expect(partitionTurns(all, byteLen)).toEqual([
      [0, 1],
      [1, 2],
    ]);
    // …and the same two turns measured by UTF-16 length would have fitted in
    // one window, which is the bug this guards.
    expect(hebrew.length * 2 + "Dana".length * 2 + 32).toBeLessThan(byteLen * 2);
  });

  it("an empty turn list produces no windows at all", () => {
    expect(partitionTurns([], 400)).toEqual([]);
  });
});

describe("visibleChars", () => {
  it("sums UTF-8 byte length across turns, matching Rust's String::len()", () => {
    expect(visibleChars([turn(0, "a", "abc")])).toBe(3);
    // "café" = 4 code points, 5 UTF-8 bytes (é is 2 bytes).
    expect(visibleChars([turn(0, "a", "café")])).toBe(5);
    expect(visibleChars([])).toBe(0);
  });
});

describe("windowText", () => {
  it("numbers turns GLOBALLY and carries the stamp/who/text", () => {
    const all = [turn(0, "Dana", "hi"), turn(6100, "Yossi", "yo")];
    expect(windowText(all, [0, 2])).toBe("#0 [0:00] Dana: hi\n#1 [1:01] Yossi: yo\n");
  });

  it("a sub-range still uses GLOBAL indices, so window 3's answers resolve like window 0's", () => {
    const all = [turn(0, "Dana", "a"), turn(100, "Dana", "b"), turn(200, "Dana", "c")];
    expect(windowText(all, [1, 3])).toBe("#1 [0:01] Dana: b\n#2 [0:02] Dana: c\n");
  });

  it("a stored plan's out-of-range window renders fewer lines rather than throwing", () => {
    const all = turns(2);
    expect(() => windowText(all, [-5, 99])).not.toThrow();
    expect(windowText(all, [-5, 99])).toBe(windowText(all, [0, 2]));
    expect(windowText(all, [5, 9])).toBe("");
  });
});

// ============================================================================
// mergeFindings — the turn-number-to-timestamp guarantee
// ============================================================================

describe("mergeFindings — the timestamp guarantee", () => {
  /** The model answers with numbers, never times. A number that is not a turn
   * in this recording is DROPPED — which is what makes a made-up moment
   * impossible rather than merely unlikely. */
  it("a_turn_number_that_does_not_exist_is_thrown_away (ported from rec_read.rs)", () => {
    const all = turns(3);
    const found = [
      artifact({
        chapters: [chapter({ turn: 1, title: "Real" }), chapter({ turn: 99, title: "Invented" })],
        notes: [
          note({ turn: 2, kind: "decision", text: "real" }),
          note({ turn: 900, kind: "decision", text: "invented" }),
        ],
        highlights: [highlight({ turn: 42, until: 43 })],
      }),
    ];
    const { chapters, highlights, notes } = mergeFindings(found, all, new Set());
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.t0).toBe(100);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.t0).toBe(200);
    expect(highlights, "a highlight was placed at a moment that does not exist").toHaveLength(0);
  });

  it("an out-of-range number is DROPPED, never clamped to the last turn or wrapped to a real one", () => {
    const all = turns(4); // t0 = 0, 100, 200, 300
    const realTimes = new Set(all.map((t) => t.t0));
    const { chapters, notes, highlights } = mergeFindings(
      [
        artifact({
          chapters: [chapter({ turn: 4, title: "one past the end" }), chapter({ turn: 4000, title: "far past" })],
          notes: [note({ turn: 4, kind: "point", text: "one past the end" })],
          highlights: [highlight({ turn: 7, until: 9 })],
        }),
      ],
      all,
      new Set()
    );
    expect(chapters, "a number past the end became a real chapter").toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(highlights).toHaveLength(0);
    // And nothing that DID survive can carry a time no turn has.
    for (const t of [...chapters, ...notes, ...highlights].map((x) => x.t0)) {
      expect(realTimes.has(t)).toBe(true);
    }
  });

  it("turn 0 resolves to time 0 — a falsy timestamp must not read as 'no timestamp'", () => {
    const all = turns(2); // turn 0's t0 IS 0
    const { chapters, notes } = mergeFindings(
      [
        artifact({
          chapters: [chapter({ turn: 0, title: "Opening" })],
          notes: [note({ turn: 0, kind: "decision", text: "start" })],
        }),
      ],
      all,
      new Set()
    );
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.t0).toBe(0);
    expect(notes).toHaveLength(1);
  });

  /** An action item may only name somebody who actually spoke here. A model
   * that invents a colleague must lose the name, not the note. */
  it("an_action_cannot_be_pinned_on_someone_who_was_never_there (ported from rec_read.rs)", () => {
    const all = turns(2);
    const here = new Set(["Dana"]);
    const found = [
      artifact({
        notes: [
          note({ turn: 0, kind: "action", text: "send the notes", who: "Dana" }),
          note({ turn: 1, kind: "action", text: "book the room", who: "Someone Invented" }),
        ],
      }),
    ];
    const { notes } = mergeFindings(found, all, here);
    expect(notes, "the invented name cost us the note").toHaveLength(2);
    expect(notes[0]?.who).toBe("Dana");
    expect(notes[1]?.who, "an action was attributed to a stranger").toBeNull();
  });

  /** Windows repeat themselves, and a chapter per turn is not a table of
   * contents. Both are collapsed by ordinary code. */
  it("repeats_and_crowding_are_collapsed (ported from rec_read.rs)", () => {
    const all = turns(200);
    const found = [
      artifact({
        chapters: [
          chapter({ turn: 0, title: "Opening" }),
          chapter({ turn: 1, title: "Still opening" }), // 1 s later
          chapter({ turn: 100, title: "Budget" }),
          chapter({ turn: 150, title: "  budget  " }), // same words
        ],
        notes: [
          note({ turn: 5, kind: "decision", text: "Ship Thursday" }),
          note({ turn: 9, kind: "decision", text: "ship   thursday" }),
        ],
        highlights: [
          highlight({ turn: 10, until: 12 }),
          highlight({ turn: 11, until: 14 }), // overlaps
          highlight({ turn: 60, until: 60 }),
        ],
      }),
    ];
    const { chapters, highlights, notes } = mergeFindings(found, all, new Set());
    expect(chapters.map((c) => c.title)).toEqual(["Opening", "Budget"]);
    expect(notes, "the same decision was written twice").toHaveLength(1);
    expect(highlights, "overlapping marks did not merge").toHaveLength(2);
    expect([highlights[0]?.t0, highlights[0]?.t1]).toEqual([1000, 1500]);
  });

  it("a highlight whose `until` precedes its `turn` becomes the turn itself, not a backwards span", () => {
    const all = turns(10);
    const { highlights } = mergeFindings([artifact({ highlights: [{ turn: 5, until: 2 }] })], all, new Set());
    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.t0).toBe(500);
    expect(highlights[0]?.t1).toBe(600); // turn 5's own t1
  });

  /** Rust's `turns.get(until.max(turn)).map_or(t0, |t| t.t1).max(t0)`: when the
   * END of a span is a number the transcript does not have, the fallback is the
   * span's own START — a zero-length mark — never a guessed end. The mark
   * degrades to a point rather than stretching over minutes nobody spoke in.
   * Ported as written. */
  it("a highlight whose `until` is past the transcript collapses to a point, never a guessed end", () => {
    const all = turns(3);
    const { highlights } = mergeFindings([artifact({ highlights: [{ turn: 1, until: 400 }] })], all, new Set());
    expect(highlights).toHaveLength(1);
    expect([highlights[0]?.t0, highlights[0]?.t1]).toEqual([100, 100]);
  });

  it("the model-facing kinds accept wider synonyms than the user-facing noteKindOf, and an unrecognized kind DROPS the finding", () => {
    const all = turns(6);
    const { notes } = mergeFindings(
      [
        artifact({
          notes: [
            note({ turn: 0, kind: "action_item", text: "a1" }),
            note({ turn: 1, kind: "task", text: "a2" }),
            note({ turn: 2, kind: "open_question", text: "q1" }),
            note({ turn: 3, kind: "key_point", text: "p1" }),
            note({ turn: 4, kind: "summary", text: "p2" }),
            note({ turn: 5, kind: "vibe check", text: "dropped" }),
          ],
        }),
      ],
      all,
      new Set()
    );
    expect(notes.map((n) => n.kind)).toEqual(["action", "action", "question", "point", "point"]);
    expect(
      notes.some((n) => n.text === "dropped"),
      "an unrecognized kind must be dropped, not defaulted to Point"
    ).toBe(false);
  });

  it("the per-window budget is keyed by the RAW kind string — a faithful, not 'fixed', port", () => {
    // "action" and "action_item" both normalize to NoteKind::Action, but Rust
    // keys the per-window cap by `n.kind.to_lowercase()`, so both fill their
    // own quota. Preserved deliberately.
    const all = turns(30);
    const list: FoundNote[] = [];
    for (let i = 0; i < 13; i++) {
      list.push(note({ turn: i, kind: "action", text: `a-${i}` }));
    }
    for (let i = 0; i < 13; i++) {
      list.push(note({ turn: 13 + i, kind: "action_item", text: `b-${i}` }));
    }
    const { notes } = mergeFindings([artifact({ notes: list })], all, new Set());
    expect(notes.every((n) => n.kind === "action")).toBe(true);
    expect(notes).toHaveLength(24); // 12 + 12
  });

  it("caps chapters and highlights at MAX_PER_WINDOW per window", () => {
    // 1000 turns so every one of the 20 findings names a REAL turn — otherwise
    // the out-of-range drop, not the cap, would be what shortened the list.
    const all = turns(1000);
    const many = Array.from({ length: 20 }, (_, i) => chapter({ turn: i * 40, title: `c${i}` }));
    const spans = Array.from({ length: 20 }, (_, i) => highlight({ turn: i * 20, until: i * 20 }));
    const { chapters, highlights } = mergeFindings(
      [artifact({ chapters: many, highlights: spans })],
      all,
      new Set()
    );
    expect(chapters).toHaveLength(12);
    expect(highlights).toHaveLength(12);
  });

  it("an empty title or text is dropped — a blank chapter is worse than none", () => {
    const all = turns(4);
    const { chapters, notes } = mergeFindings(
      [
        artifact({
          chapters: [chapter({ turn: 0, title: "   " }), chapter({ turn: 2, title: "Real" })],
          notes: [note({ turn: 1, kind: "point", text: "  " }), note({ turn: 3, kind: "point", text: "Real" })],
        }),
      ],
      all,
      new Set()
    );
    expect(chapters.map((c) => c.title)).toEqual(["Real"]);
    expect(notes.map((n) => n.text)).toEqual(["Real"]);
  });

  it("truncates by CODE POINT, so an emoji at the 80/400 boundary is never split in half", () => {
    const all = turns(1);
    const emoji = "😀";
    const { chapters, notes } = mergeFindings(
      [
        artifact({
          chapters: [chapter({ turn: 0, title: emoji.repeat(100) })],
          notes: [note({ turn: 0, kind: "point", text: emoji.repeat(500) })],
        }),
      ],
      all,
      new Set()
    );
    expect([...(chapters[0]?.title ?? "")]).toHaveLength(80);
    expect([...(notes[0]?.text ?? "")]).toHaveLength(400);
    // No lone surrogate anywhere.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chapters[0]?.title ?? "")).toBe(false);
  });
});

// ============================================================================
// coerceReadArtifact — the coercion half of the timestamp guarantee
// ============================================================================

describe("coerceReadArtifact", () => {
  it("defaults a wholly malformed value rather than throwing", () => {
    expect(coerceReadArtifact(null)).toEqual(defaultReadArtifact());
    expect(coerceReadArtifact("nope")).toEqual(defaultReadArtifact());
    expect(coerceReadArtifact([])).toEqual(defaultReadArtifact());
  });

  it("drops one malformed item without losing its siblings, the thread or the skipped flag", () => {
    const a = coerceReadArtifact({
      chapters: [{ turn: 1, title: "ok" }, "not an object", { turn: 2 }],
      thread: "carry me",
      skipped: true,
    });
    expect(a.chapters).toEqual([
      { turn: 1, title: "ok" },
      { turn: 2, title: "" },
    ]);
    expect(a.thread).toBe("carry me");
    expect(a.skipped).toBe(true);
  });

  it("a non-string thread / non-boolean skipped default, they do not poison the artifact", () => {
    const a = coerceReadArtifact({ thread: 5, skipped: "yes" });
    expect(a.thread).toBe("");
    expect(a.skipped).toBe(false);
  });

  /**
   * THE regression this coercion exists for. Rust's `turn: usize` carries no
   * `#[serde(default)]`, so a finding without a usable number never survives
   * the deserialize at all. Defaulting it to 0 instead would pin a chapter,
   * note or highlight the model never located onto the recording's opening
   * seconds — a fabricated moment, produced by the parser rather than the
   * model, and invisible to `mergeFindings` because 0 IS a real turn.
   */
  it("a finding whose `turn` is missing or not a whole number is DROPPED, never defaulted to turn 0", () => {
    const bad = [
      {},
      { turn: null },
      { turn: "3" },
      { turn: -1 },
      { turn: 1.5 },
      { turn: Number.NaN },
      { turn: true },
    ];
    const a = coerceReadArtifact({
      chapters: bad.map((b) => ({ ...b, title: "invented" })),
      notes: bad.map((b) => ({ ...b, kind: "decision", text: "invented" })),
      highlights: bad.map((b) => ({ ...b, until: 2 })),
    });
    expect(a.chapters, "a chapter with no number was given one").toEqual([]);
    expect(a.notes).toEqual([]);
    expect(a.highlights).toEqual([]);

    // …and end to end: none of them can reach the recording's opening moment.
    const { chapters, notes, highlights } = mergeFindings([a], turns(5), new Set());
    expect([chapters, notes, highlights].every((l) => l.length === 0)).toBe(true);
  });

  it("a highlight's missing `until` is 0 (Rust's serde default) and `mergeFindings` reads that as 'the turn itself'", () => {
    const a = coerceReadArtifact({ highlights: [{ turn: 5 }] });
    expect(a.highlights).toEqual([{ turn: 5, until: 0 }]);
    const { highlights } = mergeFindings([a], turns(10), new Set());
    expect([highlights[0]?.t0, highlights[0]?.t1]).toEqual([500, 600]);
  });
});

describe("parseReadPlan", () => {
  it("accepts a well-formed plan and defaults a pre-visibleChars one to null", () => {
    const plan = parseReadPlan({
      fileId: "f",
      fileName: "standup.wav",
      stamp: { turns: 2, chars: 20 },
      windows: [[0, 2]],
    });
    expect(plan.visibleChars).toBeNull();
    expect(plan.windows).toEqual([[0, 2]]);
  });

  it("refuses anything structurally wrong with the shared UNREADABLE_PLAN sentence", () => {
    for (const bad of [
      null,
      "plan",
      {},
      { fileId: "f", fileName: "n", stamp: { turns: 1 }, windows: [] },
      { fileId: "f", fileName: "n", stamp: { turns: 1, chars: 1 }, windows: "no" },
      { fileId: "f", fileName: "n", stamp: { turns: 1, chars: 1 }, windows: [[0]] },
      { fileId: "f", fileName: "n", stamp: { turns: 1, chars: 1 }, windows: [["a", "b"]] },
    ]) {
      expect(() => parseReadPlan(bad)).toThrow("plan is unreadable");
    }
  });
});

// ============================================================================
// installFindings — the "Read again" rule
// ============================================================================

describe("installFindings", () => {
  it("reading_again_replaces_the_rooms_findings_and_keeps_yours (ported from rec_read.rs)", () => {
    const mine: RecNote = { id: "mine", t0: 50, kind: "point", text: "my own note", who: null, by: "you" };
    const meta: RecMeta = {
      ...defaultRecMeta(),
      notes: [mine, { ...mine, id: "theirs", by: "room" }],
      chapters: [
        { id: "c1", t0: 0, title: "mine", by: "you" },
        { id: "c2", t0: 10, title: "theirs", by: "room" },
      ],
    };
    installFindings(meta, [{ id: "new", t0: 500, title: "fresh", by: "room" }], [], [], {
      turns: 3,
      chars: 40,
    });
    expect(
      meta.notes.map((n) => n.id),
      "a re-read either kept a stale finding or ate the user's note"
    ).toEqual(["mine"]);
    expect(meta.chapters.map((c) => c.id)).toEqual(["c1", "new"]);
    expect(meta.readOf).toEqual({ turns: 3, chars: 40 });
  });

  it("keeps a user's highlight and re-sorts everything by time", () => {
    const meta: RecMeta = {
      ...defaultRecMeta(),
      highlights: [
        { id: "h-yours", t0: 900, t1: 950, by: "you" },
        { id: "h-theirs", t0: 10, t1: 20, by: "room" },
      ],
    };
    installFindings(meta, [], [{ id: "h-new", t0: 100, t1: 200, by: "room" }], [], { turns: 1, chars: 1 });
    expect(meta.highlights.map((h) => h.id)).toEqual(["h-new", "h-yours"]);
  });
});

// ============================================================================
// turnsMoved — the deleted-phrase guard
// ============================================================================

describe("turnsMoved", () => {
  /** The publish guard has to fire when a phrase is DELETED while the read
   * runs, and `ReadStamp` cannot see that: deleting marks the words `del` and
   * leaves the segment row and its raw text exactly as they were. The turn list
   * was one turn shorter, the stamp still matched, and every finding after the
   * deleted phrase was written onto the previous speaker's sentence. */
  it("a_deleted_phrase_is_caught_even_though_the_stamp_matches (ported from rec_read.rs)", () => {
    const all = turns(6);
    const plan: ReadPlan = {
      fileId: "f",
      fileName: "standup.wav",
      stamp: readStampOf([]),
      windows: partitionTurns(all, 400),
      visibleChars: visibleChars(all),
    };
    expect(turnsMoved(plan, all), "an untouched transcript read as changed").toBe(false);

    // The delete: `turnsOf` drops the emptied phrase.
    const shorter = all.slice();
    shorter.splice(1, 1);
    expect(turnsMoved(plan, shorter)).toBe(true);

    // Words changed without changing the count.
    const retyped = all.map((t, i) => (i === 2 ? { ...t, text: `${t.text} and then some more` } : t));
    expect(turnsMoved(plan, retyped)).toBe(true);

    // A plan written before `visibleChars` existed keeps the count check, which
    // is what catches the delete; it cannot see the retype.
    const old: ReadPlan = { ...plan, visibleChars: null };
    expect(turnsMoved(old, shorter)).toBe(true);
    expect(turnsMoved(old, retyped)).toBe(false);

    // Edges: a one-turn recording, and one turn added rather than removed.
    const one = turns(1);
    const solo: ReadPlan = { ...plan, windows: partitionTurns(one, 400), visibleChars: visibleChars(one) };
    expect(turnsMoved(solo, one)).toBe(false);
    expect(turnsMoved(solo, turns(2))).toBe(true);
  });
});

// ============================================================================
// buildReadSteps / isFatal / readProgressLabel
// ============================================================================

describe("buildReadSteps", () => {
  /** The step DAG: windows in order, then one publish that waits for all of
   * them — and no model-driven fold anywhere, which is the mistake `file_pass`
   * records having made. */
  it("the_plan_is_windows_then_one_publish (ported from rec_read.rs)", () => {
    const steps = buildReadSteps(3, "local_llm");
    expect(steps).toHaveLength(4);
    expect(steps[2]?.dependsOn).toEqual([1]);
    expect(steps[3]?.kind).toBe("publish");
    expect(steps[3]?.lane).toBe("cpu");
    expect(steps[3]?.dependsOn).toEqual([0, 1, 2]);
    expect(steps.every((s) => s.kind === "map" || s.kind === "publish")).toBe(true);
  });

  it("is pure and deterministic, so start and resume derive an identical plan", () => {
    expect(buildReadSteps(4, "cloud")).toEqual(buildReadSteps(4, "cloud"));
  });
});

describe("isFatal", () => {
  it("only OLLAMA_DOWN and MODEL_MISSING park the job", () => {
    expect(isFatal("OLLAMA_DOWN")).toBe(true);
    expect(isFatal("MODEL_MISSING:qwen3.5:4b")).toBe(true);
    expect(isFatal("MODEL_MISSING")).toBe(true);
    expect(isFatal("Local AI error (500): boom")).toBe(false);
    expect(isFatal("SIDECAR_DOWN")).toBe(false);
    expect(isFatal("Arcelle's AI helper could not start, so nothing could run: boom")).toBe(false);
  });
});

describe("readProgressLabel", () => {
  const plan: ReadPlan = {
    fileId: "f",
    fileName: "standup.wav",
    stamp: { turns: 0, chars: 0 },
    windows: [
      [0, 5],
      [5, 9],
    ],
    visibleChars: null,
  };
  it("names the part while mapping", () => {
    expect(readProgressLabel(plan, 0)).toBe('Reading part 1 of 2 of "standup.wav"');
    expect(readProgressLabel(plan, 1)).toBe('Reading part 2 of 2 of "standup.wav"');
  });
  it("switches to the publish label once every window is done", () => {
    expect(readProgressLabel(plan, 2)).toBe('Writing what it found in "standup.wav"');
  });
});

describe("sidecarErrorSentinel", () => {
  it("reproduces SidecarError::sentinel's four branches, humanize_empty_generation included", () => {
    expect(sidecarErrorSentinel({ code: "OLLAMA_DOWN", error: "x", status: 0 }, "m")).toBe("OLLAMA_DOWN");
    expect(sidecarErrorSentinel({ code: "MODEL_MISSING", error: "x", status: 0 }, "qwen3.5:4b")).toBe(
      "MODEL_MISSING:qwen3.5:4b"
    );
    expect(sidecarErrorSentinel({ code: "MODEL_MISSING", error: "x", status: 0 }, null)).toBe("MODEL_MISSING");
    expect(sidecarErrorSentinel({ code: "SIDECAR_DOWN", error: "boom", status: 503 }, null)).toContain(
      "AI helper could not start"
    );
    // SIDECAR_DOWN deliberately does NOT collapse into OLLAMA_DOWN — that token
    // is the frontend's "Open Ollama" trigger.
    expect(isFatal(sidecarErrorSentinel({ code: "SIDECAR_DOWN", error: "boom", status: 503 }, null))).toBe(false);
    expect(sidecarErrorSentinel({ code: "ENGINE_ERROR", error: "usage limit reached", status: 402 }, null)).toContain(
      "returned nothing"
    );
    expect(sidecarErrorSentinel({ code: "ENGINE_ERROR", error: "boom", status: 500 }, null)).toBe(
      "Local AI error (500): boom"
    );
  });
});

// ============================================================================
// sidecarJsonCancellableAt — against a real local HTTP server
// ============================================================================

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("sidecarJsonCancellableAt", () => {
  it("returns the parsed body on a 2xx, and posts what it was given", async () => {
    const base = await listenOn((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoed: JSON.parse(body), auth: req.headers.authorization ?? null }));
      });
    });
    const out = await sidecarJsonCancellableAt(base, "/rec_read_map", { part: 2 }, new CancelFlag());
    expect(out.kind).toBe("value");
    const value = (out as { value: { echoed: unknown; auth: string | null } }).value;
    expect(value.echoed).toEqual({ part: 2 });
    expect(value.auth, "the sidecar's shared secret was not stamped on").toMatch(/^Bearer /);
  });

  it("classifies a non-2xx {code,error} envelope", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "MODEL_MISSING", error: "no such model" }));
    });
    const out = await sidecarJsonCancellableAt(base, "/rec_read_map", {}, new CancelFlag());
    expect(out).toEqual({
      kind: "error",
      error: { code: "MODEL_MISSING", error: "no such model", status: 400 },
    });
  });

  it("a non-2xx with no readable body still classifies, rather than throwing", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("not json at all");
    });
    const out = await sidecarJsonCancellableAt(base, "/rec_read_map", {}, new CancelFlag());
    expect(out).toEqual({
      kind: "error",
      error: { code: "ENGINE_ERROR", error: "unknown error", status: 500 },
    });
  });

  it("never even sends the request when the flag is already set", async () => {
    let hit = false;
    const base = await listenOn((_req, res) => {
      hit = true;
      res.writeHead(200).end("{}");
    });
    const cancel = new CancelFlag();
    cancel.store(true);
    expect(await sidecarJsonCancellableAt(base, "/rec_read_map", {}, cancel)).toEqual({ kind: "cancelled" });
    expect(hit).toBe(false);
  });

  it("aborts an in-flight request the moment cancel flips — the connection is really closed, not just ignored", async () => {
    let serverSawClose = false;
    const base = await listenOn((req, res) => {
      req.on("close", () => {
        if (!res.writableEnded) {
          serverSawClose = true;
        }
      });
      // Never responds — a wedged sidecar.
    });
    const cancel = new CancelFlag();
    const started = Date.now();
    const promise = sidecarJsonCancellableAt(base, "/rec_read_map", {}, cancel);
    setTimeout(() => cancel.store(true), 50);
    expect(await promise).toEqual({ kind: "cancelled" });
    expect(Date.now() - started).toBeLessThan(1_000);
    await new Promise((r) => setTimeout(r, 60));
    expect(serverSawClose, "the connection was not actually closed").toBe(true);
  });

  it("a refused connection is OLLAMA_DOWN (fatal), a mid-body failure is a plain engine error (survivable)", async () => {
    // A port we bound and then released: connecting to it is refused for real,
    // rather than relying on some low port happening to be free.
    const dead = http.createServer(() => {});
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const refused = await sidecarJsonCancellableAt(
      `http://127.0.0.1:${deadPort}`,
      "/rec_read_map",
      {},
      new CancelFlag()
    );
    expect(refused.kind).toBe("error");
    const refusedError = (refused as { error: { code: string; error: string; status: number } }).error;
    expect(refusedError.code).toBe("OLLAMA_DOWN");
    expect(isFatal(sidecarErrorSentinel(refusedError, "m")), "a dead engine must park the job").toBe(true);

    // A socket that accepts then dies mid-body is NOT a connect failure — the
    // read must survive it as one skipped window, exactly as Rust's
    // `e.is_connect()` split decides.
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "999" });
      res.write("{");
      res.socket?.destroy();
    });
    const torn = await sidecarJsonCancellableAt(base, "/rec_read_map", {}, new CancelFlag());
    expect(torn.kind).toBe("error");
    const tornError = (torn as { error: { code: string; error: string; status: number } }).error;
    expect(tornError.code).toBe("ENGINE_ERROR");
    expect(isFatal(sidecarErrorSentinel(tornError, "m"))).toBe(false);
  });

  /** The cancel poll must not become a latency tax: a response that arrives in
   * 3 ms has to return in 3 ms, and no timer may be left holding the loop open
   * after the call resolves. Ten round-trips to a local server cost
   * milliseconds; a poll that is awaited to completion would cost 100 ms each. */
  it("does not pay the 100 ms cancel-poll interval on a fast response", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const started = Date.now();
    for (let i = 0; i < 10; i++) {
      const out = await sidecarJsonCancellableAt(base, "/rec_read_map", { i }, new CancelFlag());
      expect(out.kind).toBe("value");
    }
    expect(Date.now() - started, "each call waited out a full poll tick").toBeLessThan(600);
  });
});

describe("sidecarJsonCancellable", () => {
  it("reports a sidecar that will not start as SIDECAR_DOWN and still releases the busy guard", async () => {
    const before = inflightCount();
    vi.doMock("./sidecar.js", async () => {
      const actual = await vi.importActual<typeof import("./sidecar.js")>("./sidecar.js");
      return {
        ...actual,
        ensureUp: async () => {
          throw new Error("no bundled binary");
        },
      };
    });
    try {
      const mod = await import("./recRead.js");
      const out = await mod.sidecarJsonCancellable("/rec_read_map", {}, new CancelFlag());
      expect(out.kind).toBe("error");
      if (out.kind === "error") {
        expect(out.error.code).toBe("SIDECAR_DOWN");
        expect(out.error.error).toContain("no bundled binary");
      }
      // …and never fatal: a dead helper is its own problem, not Ollama's.
      expect(out.kind === "error" && isFatal(sidecarErrorSentinel(out.error, "m"))).toBe(false);
    } finally {
      vi.doUnmock("./sidecar.js");
      vi.resetModules();
    }
    expect(inflightCount(), "the busy guard leaked").toBe(before);
  });

  it("short-circuits an already-cancelled call without touching the sidecar lifecycle", async () => {
    const cancel = new CancelFlag();
    cancel.store(true);
    expect(await sidecarJsonCancellable("/rec_read_map", {}, cancel)).toEqual({ kind: "cancelled" });
  });
});

// ============================================================================
// executeReadStep — map / publish, against a real room DB
// ============================================================================

function fakeRooms(handle: RoomHandle | null): { rooms: RoomSource; set: (h: RoomHandle | null) => void } {
  let current = handle;
  return { rooms: { current: () => current }, set: (h) => (current = h) };
}

function fakeSink(): { sink: ProgressSink; events: JobProgressPayload[] } {
  const events: JobProgressPayload[] = [];
  return { sink: { emit: (p) => events.push(p) }, events };
}

function runnerDeps(rooms: RoomSource, sink: ProgressSink, extra: Partial<RecReadRunnerDeps> = {}) {
  const removed: string[] = [];
  const settled: string[] = [];
  const deps: RecReadRunnerDeps & { removed: string[]; settled: string[] } = {
    rooms,
    sink,
    removeCancelFlag: (id) => removed.push(id),
    onSettled: (id) => {
      settled.push(id);
    },
    removed,
    settled,
    ...extra,
  };
  return deps;
}

/** An injectable log, mirroring `db-host/jobs.test.ts`'s own `captureLog`. */
function captureLog(): { log: RecReadLog; lines: string[] } {
  const lines: string[] = [];
  const record = (event: string, fields: ReadonlyArray<readonly [string, obs.Val]>): void => {
    lines.push(`${event} ${fields.map(([k, v]) => `${k}=${v.toString()}`).join(" ")}`.trim());
  };
  return { log: { warn: record as unknown as typeof obs.warn }, lines };
}

const NEVER_CANCELLED = new CancelFlag();

function mapStep(i: number): Step {
  return { id: i, lane: "local_llm", kind: "map", params: { window: i }, dependsOn: i === 0 ? [] : [i - 1] };
}
function publishStep(id: number): Step {
  return { id, lane: "cpu", kind: "publish", params: { inputs: [] }, dependsOn: [] };
}

function planFor(fileId: string, list: readonly Turn[], windows: Array<[number, number]>): ReadPlan {
  return {
    fileId,
    fileName: "standup.wav",
    stamp: readStampOf(segmentsFor(list)),
    windows,
    visibleChars: visibleChars(list),
  };
}

describe("executeReadStep — map", () => {
  it("a window index the plan doesn't have is refused, not silently read as window 0", async () => {
    const { rooms } = fakeRooms(null);
    const plan = planFor("f1", turns(2), [
      [0, 1],
      [1, 2],
    ]);
    const step: Step = { id: 5, lane: "local_llm", kind: "map", params: { window: 5 }, dependsOn: [] };
    expect(
      await executeReadStep({ rooms }, "job1", "room-a", plan, "m", turns(2), step, NEVER_CANCELLED)
    ).toEqual({ ok: false, error: "window 5 is not in the plan" });
  });

  /** Rust reads the window with `step.params["window"].as_u64().unwrap_or(0)`:
   * a missing, negative or fractional value is 0, never `undefined`. */
  it("a step whose params carry no usable window falls back to 0, matching as_u64().unwrap_or(0)", async () => {
    const room = freshRoom();
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const plan = planFor("f1", turns(2), [[0, 2]]);
    const seen: Array<Record<string, unknown>> = [];
    const sidecarCall: RecReadSidecarCall = async (_p, body) => {
      seen.push(body);
      return { kind: "value", value: {} };
    };
    for (const params of [{}, { window: -3 }, { window: 1.5 }, { window: "0" }]) {
      const step: Step = { id: 0, lane: "local_llm", kind: "map", params, dependsOn: [] };
      expect(
        await executeReadStep({ rooms, sidecarCall }, jobId, "room-a", plan, "m", turns(2), step, NEVER_CANCELLED)
      ).toEqual({ ok: true });
    }
    expect(seen.map((b) => b.part)).toEqual([0, 0, 0, 0]);
    room.db.close();
  });

  it("carries the previous window's thread forward, and stores what the sidecar returned", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const jobId = createJob(room.db, "rec_read", "Reading standup.wav", {}, 3);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const plan = planFor(fileId, list, [
      [0, 1],
      [1, 2],
    ]);

    const first: RecReadSidecarCall = async () => ({
      kind: "value",
      value: { thread: "so far: intros done", chapters: [], highlights: [], notes: [] },
    });
    expect(
      await executeReadStep({ rooms, sidecarCall: first }, jobId, "room-a", plan, "m", list, mapStep(0), NEVER_CANCELLED)
    ).toEqual({ ok: true });

    const bodies: Array<Record<string, unknown>> = [];
    const second: RecReadSidecarCall = async (p, body) => {
      expect(p).toBe("/rec_read_map");
      bodies.push(body);
      return { kind: "value", value: { thread: "next", chapters: [{ turn: 1, title: "Wrap-up" }] } };
    };
    expect(
      await executeReadStep(
        { rooms, sidecarCall: second },
        jobId,
        "room-a",
        plan,
        "qwen3.5:4b",
        list,
        mapStep(1),
        NEVER_CANCELLED
      )
    ).toEqual({ ok: true });

    const body = bodies[0] as Record<string, unknown>;
    expect(body.thread).toBe("so far: intros done");
    expect(body.model).toBe("qwen3.5:4b");
    expect(body.keep_alive).toBe("30m");
    expect(body.part).toBe(1);
    expect(body.total).toBe(2);
    expect(body.turns).toBe(windowText(list, [1, 2]));

    const stored = JSON.parse(getJobArtifact(room.db, jobId, 1) as string) as ReadArtifact;
    expect(stored.chapters).toEqual([{ turn: 1, title: "Wrap-up" }]);
    room.db.close();
  });

  /** `base_url` must be the room's really-configured Ollama URL
   * (`ollama::resolved_base_url()`, ported as `engineRouting.resolvedBaseUrl`),
   * not a constant — a room pointed at another host would otherwise have every
   * reading pass silently sent to 127.0.0.1. */
  it("sends the room's configured Ollama base URL, not a hardcoded default", async () => {
    const room = freshRoom();
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const plan = planFor("f1", turns(1), [[0, 1]]);
    setBaseUrlOverride("http://10.0.0.7:11434");
    const bodies: Array<Record<string, unknown>> = [];
    const sidecarCall: RecReadSidecarCall = async (_p, body) => {
      bodies.push(body);
      return { kind: "value", value: {} };
    };
    await executeReadStep({ rooms, sidecarCall }, jobId, "room-a", plan, "m", turns(1), mapStep(0), NEVER_CANCELLED);
    expect(bodies[0]?.base_url).toBe("http://10.0.0.7:11434");
    expect(bodies[0]?.base_url).toBe(resolvedBaseUrl());
    room.db.close();
  });

  it("a fatal engine error parks the step; a non-fatal one marks the window skipped and still succeeds", async () => {
    const room = freshRoom();
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const plan = planFor("f1", turns(1), [[0, 1]]);

    const fatal: RecReadSidecarCall = async () => ({
      kind: "error",
      error: { code: "OLLAMA_DOWN", error: "connection refused", status: 0 },
    });
    expect(
      await executeReadStep({ rooms, sidecarCall: fatal }, jobId, "room-a", plan, "m", turns(1), mapStep(0), NEVER_CANCELLED)
    ).toEqual({ ok: false, error: "OLLAMA_DOWN" });

    const soft: RecReadSidecarCall = async () => ({
      kind: "error",
      error: { code: "ENGINE_ERROR", error: "the model returned nothing usable", status: 500 },
    });
    expect(
      await executeReadStep({ rooms, sidecarCall: soft }, jobId, "room-a", plan, "m", turns(1), mapStep(0), NEVER_CANCELLED)
    ).toEqual({ ok: true });
    const stored = JSON.parse(getJobArtifact(room.db, jobId, 0) as string) as ReadArtifact;
    expect(stored.skipped).toBe(true);
    room.db.close();
  });

  it("a skipped window still carries the thread forward, so the next window is not left blind", async () => {
    const room = freshRoom();
    const list = turns(2);
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 3);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const plan = planFor("f1", list, [
      [0, 1],
      [1, 2],
    ]);
    await executeReadStep(
      { rooms, sidecarCall: async () => ({ kind: "value", value: { thread: "intros done" } }) },
      jobId,
      "room-a",
      plan,
      "m",
      list,
      mapStep(0),
      NEVER_CANCELLED
    );
    await executeReadStep(
      {
        rooms,
        sidecarCall: async () => ({ kind: "error", error: { code: "ENGINE_ERROR", error: "e", status: 500 } }),
      },
      jobId,
      "room-a",
      plan,
      "m",
      list,
      mapStep(1),
      NEVER_CANCELLED
    );
    const stored = JSON.parse(getJobArtifact(room.db, jobId, 1) as string) as ReadArtifact;
    expect(stored).toMatchObject({ skipped: true, thread: "intros done" });
    room.db.close();
  });

  it("a cancel mid-call is reported as STOPPED, not silently dropped", async () => {
    const room = freshRoom();
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const plan = planFor("f1", turns(1), [[0, 1]]);
    expect(
      await executeReadStep(
        { rooms, sidecarCall: async () => ({ kind: "cancelled" }) },
        jobId,
        "room-a",
        plan,
        "m",
        turns(1),
        mapStep(0),
        NEVER_CANCELLED
      )
    ).toEqual({ ok: false, error: "STOPPED" });
    room.db.close();
  });

  it("a room that closed before the artifact could be stored refuses cleanly", async () => {
    const room = freshRoom();
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const { rooms, set } = fakeRooms({ db: room.db, path: "room-a" });
    const plan = planFor("f1", turns(1), [[0, 1]]);
    const sidecarCall: RecReadSidecarCall = async () => {
      set(null); // the room closes mid-call
      return { kind: "value", value: {} };
    };
    expect(
      await executeReadStep({ rooms, sidecarCall }, jobId, "room-a", plan, "m", turns(1), mapStep(0), NEVER_CANCELLED)
    ).toEqual({ ok: false, error: "The room this job belongs to is no longer open." });
    room.db.close();
  });

  it("a room swapped before the THREAD could be read refuses rather than reading another room's artifact", async () => {
    const { rooms } = fakeRooms(null);
    const plan = planFor("f1", turns(2), [
      [0, 1],
      [1, 2],
    ]);
    expect(
      await executeReadStep({ rooms }, "job-1", "room-a", plan, "m", turns(2), mapStep(1), NEVER_CANCELLED)
    ).toEqual({ ok: false, error: "The room this job belongs to is no longer open." });
  });

  it("an unknown step kind is named, not ignored", async () => {
    const { rooms } = fakeRooms(null);
    const plan = planFor("f1", turns(1), [[0, 1]]);
    const step: Step = { id: 0, lane: "cpu", kind: "compose", params: {}, dependsOn: [] };
    expect(await executeReadStep({ rooms }, "j", "room-a", plan, "m", turns(1), step, NEVER_CANCELLED)).toEqual({
      ok: false,
      error: 'unknown read step "compose"',
    });
  });
});

describe("executeReadStep — publish", () => {
  it("installs merged findings into the recording, refreshes the extracted text, and stamps readOf", async () => {
    const room = freshRoom();
    const list = turns(2);
    const segments = segmentsFor(list);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segments));
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const plan = planFor(fileId, list, [[0, 2]]);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });

    await executeReadStep(
      {
        rooms,
        sidecarCall: async () => ({
          kind: "value",
          value: {
            chapters: [{ turn: 1, title: "Wrap-up" }],
            notes: [{ turn: 0, kind: "decision", text: "Ship it" }],
          },
        }),
      },
      jobId,
      "room-a",
      plan,
      "m",
      list,
      mapStep(0),
      NEVER_CANCELLED
    );

    const { log, lines } = captureLog();
    expect(
      await executeReadStep({ rooms, log }, jobId, "room-a", plan, "m", list, publishStep(1), NEVER_CANCELLED)
    ).toEqual({ ok: true });
    expect(lines, "nothing was skipped, so nothing should have been warned about").toEqual([]);

    const written = JSON.parse(getRecMeta(room.db, fileId) as string) as RecMeta;
    expect(written.chapters.map((c) => c.title)).toEqual(["Wrap-up"]);
    expect(written.notes.map((n) => n.text)).toEqual(["Ship it"]);
    expect(written.readOf).toEqual(readStampOf(segments));
    room.db.close();
  });

  it("is idempotent across a replay — a re-run replaces the room's findings rather than doubling them", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const plan = planFor(fileId, list, [[0, 2]]);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    await executeReadStep(
      { rooms, sidecarCall: async () => ({ kind: "value", value: { chapters: [{ turn: 0, title: "Opening" }] } }) },
      jobId,
      "room-a",
      plan,
      "m",
      list,
      mapStep(0),
      NEVER_CANCELLED
    );
    await executeReadStep({ rooms }, jobId, "room-a", plan, "m", list, publishStep(1), NEVER_CANCELLED);
    await executeReadStep({ rooms }, jobId, "room-a", plan, "m", list, publishStep(1), NEVER_CANCELLED);
    const written = JSON.parse(getRecMeta(room.db, fileId) as string) as RecMeta;
    expect(written.chapters, "a replay doubled the room's chapters").toHaveLength(1);
    room.db.close();
  });

  it("refuses when the transcript changed while the read was running", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 1);
    const plan: ReadPlan = { ...planFor(fileId, list, [[0, 2]]), stamp: { turns: 999, chars: 999 } };
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    expect(
      await executeReadStep({ rooms }, jobId, "room-a", plan, "m", list, publishStep(1), NEVER_CANCELLED)
    ).toEqual({
      ok: false,
      error: "That recording's transcript changed while it was being read — read it again.",
    });
    room.db.close();
  });

  it("refuses when a phrase was DELETED mid-read, which the stamp alone cannot see", async () => {
    const room = freshRoom();
    const list = turns(3);
    const segments = segmentsFor(list);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segments));
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const plan = planFor(fileId, list, [[0, 3]]);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });

    // The delete: every word of segment 1 marked `del`. The segment row and its
    // raw `text` are untouched, so `readStampOf` still matches exactly — only
    // `turnsOf` gets shorter.
    const deleted = metaOf(
      segments.map((s, i) =>
        i === 1
          ? { ...s, words: [{ w: s.text, t0: s.t0, t1: s.t1, del: true }] }
          : s
      )
    );
    expect(readStampOf(deleted.segments)).toEqual(plan.stamp);
    setRecMeta(room.db, fileId, JSON.stringify(deleted));

    const result = await executeReadStep({ rooms }, jobId, "room-a", plan, "m", list, publishStep(1), NEVER_CANCELLED);
    expect(result.ok, "findings would have landed on the previous speaker's sentence").toBe(false);
    room.db.close();
  });

  it("refuses when every window came back skipped — the room read NONE of it, and must not stamp readOf", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const plan = planFor(fileId, list, [[0, 2]]);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    await executeReadStep(
      { rooms, sidecarCall: async () => ({ kind: "error", error: { code: "ENGINE_ERROR", error: "e", status: 500 } }) },
      jobId,
      "room-a",
      plan,
      "m",
      list,
      mapStep(0),
      NEVER_CANCELLED
    );
    const result = await executeReadStep({ rooms }, jobId, "room-a", plan, "m", list, publishStep(1), NEVER_CANCELLED);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("No part of");
    const written = JSON.parse(getRecMeta(room.db, fileId) as string) as RecMeta;
    expect(written.readOf ?? null, "a wholly unread recording was retired from the sweep").toBeNull();
    room.db.close();
  });

  it("logs (once) when SOME windows were skipped, naming counts not content", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 3);
    const plan = planFor(fileId, list, [
      [0, 1],
      [1, 2],
    ]);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    await executeReadStep(
      { rooms, sidecarCall: async () => ({ kind: "value", value: { chapters: [{ turn: 1, title: "hi" }] } }) },
      jobId,
      "room-a",
      plan,
      "m",
      list,
      mapStep(0),
      NEVER_CANCELLED
    );
    putJobArtifact(room.db, jobId, 1, JSON.stringify(artifact({ skipped: true })));

    const { log, lines } = captureLog();
    expect(
      await executeReadStep({ rooms, log }, jobId, "room-a", plan, "m", list, publishStep(2), NEVER_CANCELLED)
    ).toEqual({ ok: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("rec_read_incomplete");
    expect(lines[0]).toContain("skipped=1");
    expect(lines[0]).toContain("parts=2");
    room.db.close();
  });

  it("refuses when the recording itself is gone from the room", async () => {
    const room = freshRoom();
    const jobId = createJob(room.db, "rec_read", "Reading", {}, 2);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const plan = planFor("no-such-file", turns(1), [[0, 1]]);
    expect(
      await executeReadStep({ rooms }, jobId, "room-a", plan, "m", turns(1), publishStep(1), NEVER_CANCELLED)
    ).toEqual({ ok: false, error: "That recording is no longer in the room." });
    room.db.close();
  });
});

// ============================================================================
// spawnRecRead — the runner's outcomes
// ============================================================================

describe("spawnRecRead", () => {
  function livePlan(db: Database.Database): { plan: ReadPlan; list: Turn[]; fileId: string } {
    const list = turns(2);
    const fileId = addRecording(db, "standup.wav", metaOf(segmentsFor(list)));
    return {
      fileId,
      list,
      plan: planFor(fileId, list, [
        [0, 1],
        [1, 2],
      ]),
    };
  }

  it("drives every window then the publish, checkpoints, and emits the terminal events", async () => {
    const room = freshRoom();
    const { plan, list, fileId } = livePlan(room.db);
    const steps = buildReadSteps(2, "local_llm");
    const jobId = createJob(room.db, "rec_read", "Reading standup.wav", plan, steps.length);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const { sink, events } = fakeSink();
    const done: unknown[] = [];
    const deps = runnerDeps(rooms, sink, {
      sidecarCall: async () => ({ kind: "value", value: { thread: "" } }),
      onReadDone: (e) => done.push(e),
    });

    await spawnRecRead(deps, jobId, "room-a", plan, "m", steps, 0, new CancelFlag(), list);

    expect(getJob(room.db, jobId).status).toBe("done");
    expect(getJob(room.db, jobId).cursor).toBe(3);
    expect(done).toEqual([{ fileId, ok: true }]);
    expect(events.at(-1)).toEqual({
      jobId,
      label: 'Finished reading "standup.wav"',
      done: 3,
      total: 3,
      finished: true,
    });
    expect(deps.removed).toEqual([jobId]);
    expect(deps.settled).toEqual([jobId]);
    room.db.close();
  });

  it("a Stop mid-map-call lands as Paused, not Error, and keeps the bar it had honestly reached", async () => {
    const room = freshRoom();
    const { plan, list, fileId } = livePlan(room.db);
    const steps = buildReadSteps(2, "local_llm");
    const jobId = createJob(room.db, "rec_read", "Reading standup.wav", plan, steps.length);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const { sink, events } = fakeSink();
    const cancel = new CancelFlag();
    let call = 0;
    const done: unknown[] = [];
    const deps = runnerDeps(rooms, sink, {
      onReadDone: (e) => done.push(e),
      sidecarCall: async () => {
        call += 1;
        if (call === 1) {
          return { kind: "value", value: { thread: "" } };
        }
        cancel.store(true);
        return { kind: "cancelled" };
      },
    });

    await spawnRecRead(deps, jobId, "room-a", plan, "m", steps, 0, cancel, list);

    expect(getJob(room.db, jobId).status).toBe("paused");
    expect(events.at(-1)).toMatchObject({ jobId, label: "Paused", paused: true, done: 1 });
    expect(done, "a paused read must still tell the viewer it stopped").toEqual([{ fileId, ok: false }]);
    room.db.close();
  });

  it("a genuine step error parks the job naming the failure, and tells the viewer why", async () => {
    const room = freshRoom();
    const { plan, list, fileId } = livePlan(room.db);
    const steps = buildReadSteps(2, "local_llm");
    const jobId = createJob(room.db, "rec_read", "Reading standup.wav", plan, steps.length);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const { sink, events } = fakeSink();
    const done: unknown[] = [];
    const deps = runnerDeps(rooms, sink, {
      onReadDone: (e) => done.push(e),
      sidecarCall: async () => ({ kind: "error", error: { code: "OLLAMA_DOWN", error: "down", status: 0 } }),
    });

    await spawnRecRead(deps, jobId, "room-a", plan, "m", steps, 0, new CancelFlag(), list);

    const row = getJob(room.db, jobId);
    expect(row.status).toBe("error");
    expect(row.error).toBe("OLLAMA_DOWN");
    expect(events.at(-1)).toMatchObject({ jobId, label: "Stopped — OLLAMA_DOWN", failed: true });
    expect(done).toEqual([{ fileId, ok: false, error: "OLLAMA_DOWN" }]);
    room.db.close();
  });

  it("a throwing onReadDone listener never costs the job its terminal state", async () => {
    const room = freshRoom();
    const { plan, list } = livePlan(room.db);
    const steps = buildReadSteps(2, "local_llm");
    const jobId = createJob(room.db, "rec_read", "Reading standup.wav", plan, steps.length);
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const { sink } = fakeSink();
    const deps = runnerDeps(rooms, sink, {
      sidecarCall: async () => ({ kind: "value", value: {} }),
      onReadDone: () => {
        throw new Error("the renderer channel is closed");
      },
    });
    await spawnRecRead(deps, jobId, "room-a", plan, "m", steps, 0, new CancelFlag(), list);
    expect(getJob(room.db, jobId).status).toBe("done");
    expect(deps.settled).toEqual([jobId]);
    room.db.close();
  });

  it("resumes from a cursor without re-running the windows already done", async () => {
    const room = freshRoom();
    const { plan, list } = livePlan(room.db);
    const steps = buildReadSteps(2, "local_llm");
    const jobId = createJob(room.db, "rec_read", "Reading standup.wav", plan, steps.length);
    // Window 0's artifact already on disk, as a real checkpointed resume finds.
    putJobArtifact(room.db, jobId, 0, JSON.stringify(artifact({ thread: "already read" })));
    const { rooms } = fakeRooms({ db: room.db, path: "room-a" });
    const { sink } = fakeSink();
    const parts: unknown[] = [];
    const deps = runnerDeps(rooms, sink, {
      sidecarCall: async (_p, body) => {
        parts.push(body.part);
        return { kind: "value", value: {} };
      },
    });
    await spawnRecRead(deps, jobId, "room-a", plan, "m", steps, 1, new CancelFlag(), list);
    expect(parts, "a resumed read re-ran a window it had already paid for").toEqual([1]);
    expect(getJob(room.db, jobId).status).toBe("done");
    room.db.close();
  });
});

// ============================================================================
// readingNow / startRecRead / recReadRowStarter — the lifecycle
// ============================================================================

function queueDepsFor(
  db: Database.Database,
  roomPath: string
): { deps: JobQueueDeps; events: JobProgressPayload[]; state: JobQueueState; cancelState: CancelState } {
  const events: JobProgressPayload[] = [];
  const state = createJobQueueState();
  const cancelState = createCancelState();
  return {
    deps: {
      state,
      rooms: { current: () => ({ db, path: roomPath }) },
      sink: { emit: (p) => events.push(p) },
      cancelState,
      starters: new Map(),
    },
    events,
    state,
    cancelState,
  };
}

const okEngine: ResolveReadEngine = async () => ({ chatModel: "qwen3.5:4b", lane: "local_llm" });

const FINDS_NOTHING: RecReadSidecarCall = async () => ({
  kind: "value",
  value: { chapters: [], highlights: [], notes: [], thread: "" },
});

function extraDeps(over: Partial<RecReadExtraDeps> = {}): RecReadExtraDeps {
  return { resolvePassEngine: okEngine, sidecarCall: FINDS_NOTHING, ...over };
}

describe("readingNow", () => {
  it("is true only for a queued/running rec_read job naming this file", () => {
    const room = freshRoom();
    expect(readingNow(room.db, "f1")).toBe(false);
    const id = createJob(room.db, "rec_read", "Reading", { fileId: "f1" }, 2);
    expect(readingNow(room.db, "f1")).toBe(true);
    expect(readingNow(room.db, "f2")).toBe(false);
    setJobStatus(room.db, id, "done", null);
    expect(readingNow(room.db, "f1")).toBe(false);
    // A job of another kind naming the same file is not a read of it.
    createJob(room.db, "file_pass", "Passing", { fileId: "f1" }, 2);
    expect(readingNow(room.db, "f1")).toBe(false);
    room.db.close();
  });
});

describe("startRecRead", () => {
  it("refuses a recording with no transcript yet", async () => {
    const room = freshRoom();
    const fileId = addRecording(room.db, "empty.wav", metaOf([]));
    const { deps } = queueDepsFor(room.db, room.path);
    await expect(startRecRead(deps, extraDeps(), fileId)).rejects.toThrow("no transcript");
    room.db.close();
  });

  it("refuses a file that is not a recording at all", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "notes.txt", "text/plain", Buffer.from("hi"), "hi", "document");
    const { deps } = queueDepsFor(room.db, room.path);
    await expect(startRecRead(deps, extraDeps(), file.id)).rejects.toThrow("not a recording");
    room.db.close();
  });

  it("refuses a second read while one is already queued/running", async () => {
    const room = freshRoom();
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(turns(2))));
    const { deps } = queueDepsFor(room.db, room.path);
    // Occupy the single running slot so this job stays queued rather than
    // racing its own runner inside this test.
    deps.state.runningJob = "someone-else";
    const jobId = await startRecRead(deps, extraDeps(), fileId);
    expect(jobId).toBeTruthy();
    await expect(startRecRead(deps, extraDeps(), fileId)).rejects.toThrow("already being read");
    room.db.close();
  });

  it("without a real engine resolver it fails down a LABELED path, never a fabricated model choice", async () => {
    const room = freshRoom();
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(turns(2))));
    const { deps } = queueDepsFor(room.db, room.path);
    await expect(startRecRead(deps, {}, fileId)).rejects.toThrow(RESOLVE_READ_ENGINE_NOT_IMPLEMENTED);
    room.db.close();
  });

  it("runs a fresh read end to end: creates the job, drives every window, installs findings, reports done", async () => {
    const room = freshRoom();
    const list = turns(3);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const { deps, events, cancelState } = queueDepsFor(room.db, room.path);
    let doneEvent: unknown;
    const extra = extraDeps({
      sidecarCall: async (_p, body) => ({
        kind: "value",
        value: { thread: "", chapters: body.part === 0 ? [{ turn: 0, title: "Kickoff" }] : [] },
      }),
      onReadDone: (e) => (doneEvent = e),
    });

    const jobId = await startRecRead(deps, extra, fileId);
    // Registered synchronously, before the fire-and-forget runner can remove it
    // (Rust inserts into `job_cancels` before `spawn_rec_read`, in that order).
    expect(cancelState.jobCancels.has(jobId)).toBe(true);

    await vi.waitFor(() => {
      expect(getJob(room.db, jobId).status).toBe("done");
    });
    const meta = JSON.parse(getRecMeta(room.db, fileId) as string) as RecMeta;
    expect(meta.chapters.map((c) => c.title)).toEqual(["Kickoff"]);
    expect(meta.readOf).toEqual(readStampOf(segmentsFor(list)));
    expect(doneEvent).toEqual({ fileId, ok: true });
    expect(cancelState.jobCancels.has(jobId), "the cancel flag outlived the runner").toBe(false);
    const terminal = events.at(-1) as JobProgressPayload;
    expect(terminal.finished).toBe(true);
    expect(terminal.label).toContain("Finished reading");
    room.db.close();
  });

  it("a fatal engine failure parks the job, resumable, and never claims success", async () => {
    const room = freshRoom();
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(turns(2))));
    const { deps } = queueDepsFor(room.db, room.path);
    const extra = extraDeps({
      sidecarCall: async () => ({ kind: "error", error: { code: "OLLAMA_DOWN", error: "refused", status: 0 } }),
    });
    const jobId = await startRecRead(deps, extra, fileId);
    await vi.waitFor(() => {
      expect(getJob(room.db, jobId).status).toBe("error");
    });
    expect(getJob(room.db, jobId).error).toBe("OLLAMA_DOWN");
    const meta = JSON.parse(getRecMeta(room.db, fileId) as string) as RecMeta;
    expect(meta.readOf ?? null, "a failed read stamped the recording as read").toBeNull();
    room.db.close();
  });

  it("refuses when no room is open", async () => {
    const { deps } = queueDepsFor(freshRoom().db, "room-a");
    const empty: JobQueueDeps = { ...deps, rooms: { current: () => null } };
    await expect(startRecRead(empty, extraDeps(), "f1")).rejects.toThrow("No room is open.");
  });

  /** Resolving an engine takes seconds. If the room is swapped in that window,
   * the job row must not be created in a room the runner will never write to. */
  it("refuses if the room was swapped while the engine was being resolved", async () => {
    const room = freshRoom();
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(turns(2))));
    let handle: RoomHandle | null = { db: room.db, path: room.path };
    const { deps } = queueDepsFor(room.db, room.path);
    const swapping: JobQueueDeps = { ...deps, rooms: { current: () => handle } };
    const extra = extraDeps({
      resolvePassEngine: async () => {
        handle = { db: room.db, path: "/some/other/room.roomai" };
        return { chatModel: "m", lane: "local_llm" };
      },
    });
    await expect(startRecRead(swapping, extra, fileId)).rejects.toThrow("no longer open");
    room.db.close();
  });
});

describe("recReadRowStarter (resume)", () => {
  it("resumes a paused row through the normal pump and finishes it", async () => {
    const room = freshRoom();
    const list = turns(3);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const plan = planFor(fileId, list, partitionTurns(list, READ_WINDOW_CHARS));
    const jobId = createJob(room.db, "rec_read", "Reading standup.wav", plan, plan.windows.length + 1);
    setJobStatus(room.db, jobId, "paused", null);

    const { deps } = queueDepsFor(room.db, room.path);
    const starter = recReadRowStarter(extraDeps());
    expect(await starter(deps, getJob(room.db, jobId), room.path, new CancelFlag())).toEqual({ kind: "runner" });
    await vi.waitFor(() => {
      expect(getJob(room.db, jobId).status).toBe("done");
    });
    room.db.close();
  });

  it("an unreadable stored plan is refused with the shared UNREADABLE_PLAN sentence", async () => {
    const room = freshRoom();
    const jobId = createJob(room.db, "rec_read", "Reading", { not: "a plan" }, 2);
    const { deps } = queueDepsFor(room.db, room.path);
    const result = await recReadRowStarter(extraDeps())(deps, getJob(room.db, jobId), room.path, new CancelFlag());
    expect(result).toEqual({ kind: "error", message: "This job's plan is unreadable." });
    room.db.close();
  });

  it("a transcript changed since the plan was built is refused, not silently re-read against new words", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const plan: ReadPlan = { ...planFor(fileId, list, [[0, 2]]), stamp: { turns: 999, chars: 999 } };
    const jobId = createJob(room.db, "rec_read", "Reading", plan, 2);
    const { deps } = queueDepsFor(room.db, room.path);
    const result = await recReadRowStarter(extraDeps())(deps, getJob(room.db, jobId), room.path, new CancelFlag());
    expect(result).toEqual({ kind: "error", message: "That recording's transcript changed — read it again." });
    room.db.close();
  });

  it("a recording that has since left the room is refused by name", async () => {
    const room = freshRoom();
    const plan = planFor("gone", turns(1), [[0, 1]]);
    const jobId = createJob(room.db, "rec_read", "Reading", plan, 2);
    const { deps } = queueDepsFor(room.db, room.path);
    const result = await recReadRowStarter(extraDeps())(deps, getJob(room.db, jobId), room.path, new CancelFlag());
    expect(result).toEqual({
      kind: "error",
      message: "The recording this read belongs to is no longer in the room.",
    });
    room.db.close();
  });

  it("a row for a room that is no longer open is refused rather than started against another room", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const plan = planFor(fileId, list, [[0, 2]]);
    const jobId = createJob(room.db, "rec_read", "Reading", plan, 2);
    const { deps } = queueDepsFor(room.db, room.path);
    const result = await recReadRowStarter(extraDeps())(
      deps,
      getJob(room.db, jobId),
      "/a/different/room.roomai",
      new CancelFlag()
    );
    expect(result).toEqual({ kind: "error", message: "The room this job belongs to is no longer open." });
    room.db.close();
  });

  it("an engine that cannot be resolved poisons its own row instead of rejecting out of the pump", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const plan = planFor(fileId, list, [[0, 2]]);
    const jobId = createJob(room.db, "rec_read", "Reading", plan, 2);
    const { deps } = queueDepsFor(room.db, room.path);
    const result = await recReadRowStarter({})(deps, getJob(room.db, jobId), room.path, new CancelFlag());
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toContain("NOT_IMPLEMENTED");
    room.db.close();
  });

  it("resumes from the row's own cursor rather than starting over", async () => {
    const room = freshRoom();
    const list = turns(2);
    const fileId = addRecording(room.db, "standup.wav", metaOf(segmentsFor(list)));
    const plan = planFor(fileId, list, [
      [0, 1],
      [1, 2],
    ]);
    const jobId = createJob(room.db, "rec_read", "Reading", plan, 3);
    putJobArtifact(room.db, jobId, 0, JSON.stringify(artifact({ thread: "already read" })));
    const { deps } = queueDepsFor(room.db, room.path);
    // Checkpoint the row at one finished window, as a real pause leaves it.
    checkpointJob(room.db, jobId, 1, {});

    const parts: unknown[] = [];
    const starter = recReadRowStarter(
      extraDeps({
        sidecarCall: async (_p, body) => {
          parts.push(body.part);
          return { kind: "value", value: {} };
        },
      })
    );
    expect(await starter(deps, getJob(room.db, jobId), room.path, new CancelFlag())).toEqual({ kind: "runner" });
    await vi.waitFor(() => {
      expect(getJob(room.db, jobId).status).toBe("done");
    });
    expect(parts).toEqual([1]);
    room.db.close();
  });
});
