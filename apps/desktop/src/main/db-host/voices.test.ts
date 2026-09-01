/**
 * Vitest port of `src-tauri/src/db/voices.rs`'s own `mod tests`, plus the
 * `diarize.rs` helpers this module carries (`identityPrint`, `rawSimilarity`,
 * `isStrong`). Real fixture rooms via `createRoom`, matching this directory's
 * convention — no bare mocks.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import type { VoicePrint } from "../recFormat.js";
import { createRoom } from "./open.js";
import {
  EMB_DIM,
  enrollVoice,
  forgetVoice,
  identityPrint,
  isStrong,
  knownVoices,
  rawSimilarity,
  rejectVoice,
  savedVoices,
} from "./voices.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-voices-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** Rust's `print` test helper: L2-normalize, then carry the frame count. */
function print(vec: number[], frames: number): VoicePrint {
  const norm = Math.max(Math.sqrt(vec.reduce((s, x) => s + x * x, 0)), 1e-6);
  return { v: vec.map((x) => x / norm), f: frames };
}

/** A NEURAL-width print — the only width `rawSimilarity` compares, and so the
 * only one the stale-reject sweep can reason about. */
function neural(dir: number, tilt: number, frames: number): VoicePrint {
  const v = new Array<number>(EMB_DIM).fill(0);
  v[dir] = 1;
  v[EMB_DIM - 1] = tilt;
  return print(v, frames);
}

describe("enrollVoice / knownVoices / savedVoices", () => {
  it("a saved voice survives the blob round-trip", () => {
    const db = freshRoom();
    const p = print([0.3, -0.4, 0.5, 0.7], 200);
    enrollVoice(db, "Dana", p);
    const known = knownVoices(db);
    expect(known).toHaveLength(1);
    expect(known[0]?.name).toBe("Dana");
    (known[0]?.vec ?? []).forEach((a, i) => {
      expect(Math.abs(a - (p.v[i] as number))).toBeLessThan(1e-6);
    });
  });

  it("re-enrolling REFINES the centroid instead of restarting it", () => {
    const db = freshRoom();
    enrollVoice(db, "Dana", print([1, 0, 0, 0], 200));
    enrollVoice(db, "Dana", print([0, 1, 0, 0], 200));
    const v = knownVoices(db)[0]?.vec as number[];
    expect(v[0]).toBeGreaterThan(0.5);
    expect(v[1]).toBeGreaterThan(0.5);
    const saved = savedVoices(db)[0];
    expect(saved?.takes).toBe(2);
    expect(Math.abs((saved?.seconds ?? 0) - 400 * 0.016)).toBeLessThan(1e-6);
  });

  it("a print of another embedding generation replaces rather than averages", () => {
    const db = freshRoom();
    enrollVoice(db, "Dana", print([1, 0], 200));
    enrollVoice(db, "Dana", print([0, 0, 1, 0], 200));
    // The two spaces share no geometry, so the new print is the only
    // comparable thing to have.
    expect(knownVoices(db)[0]?.vec).toHaveLength(4);
    expect(savedVoices(db)[0]?.takes).toBe(1);
  });

  it("refuses an empty name and a silent print outright", () => {
    const db = freshRoom();
    enrollVoice(db, "   ", print([1, 0, 0, 0], 200));
    enrollVoice(db, "Nobody", { v: [0, 0, 0, 0], f: 200 });
    enrollVoice(db, "Nobody", { v: [1, 0, 0, 0], f: 0 });
    expect(savedVoices(db)).toHaveLength(0);
  });
});

describe("rejectVoice / forgetVoice", () => {
  it("keeps a correction against the name it denies, and it dies with the voice", () => {
    const db = freshRoom();
    const dana = print([1, 0, 0, 0], 200);
    const other = print([0.9, 0.4, 0, 0], 200);
    enrollVoice(db, "Dana", dana);
    rejectVoice(db, "Dana", other);
    expect(knownVoices(db)[0]?.rejects).toHaveLength(1);
    expect(savedVoices(db)[0]?.corrections).toBe(1);

    // Naming that same voice Dana after all overrules the older denial — and it
    // has to work for the voice as heard in ANOTHER recording, not only for a
    // byte-identical repeat of the print that was denied.
    const db2 = freshRoom();
    enrollVoice(db2, "Dana", neural(0, 0, 400));
    rejectVoice(db2, "Dana", neural(5, 0, 400));
    enrollVoice(db2, "Dana", neural(5, 0.2, 400));
    expect(knownVoices(db2)[0]?.rejects).toHaveLength(0);
    // A denial about somebody ELSE still stands.
    rejectVoice(db2, "Dana", neural(9, 0, 400));
    enrollVoice(db2, "Dana", neural(5, 0.1, 400));
    expect(knownVoices(db2)[0]?.rejects).toHaveLength(1);

    rejectVoice(db, "Dana", other);
    forgetVoice(db, "Dana");
    expect(knownVoices(db)).toHaveLength(0);
    // The corrections must not outlive the voice they were about.
    expect(db.prepare("SELECT COUNT(*) FROM voice_rejects").pluck().get() as number).toBe(0);
  });

  it("does not persist an empty name or silent rejected print", () => {
    const db = freshRoom();
    rejectVoice(db, "   ", print([1, 0, 0, 0], 200));
    rejectVoice(db, "Dana", { v: [0, 0, 0, 0], f: 200 });

    expect(db.prepare("SELECT COUNT(*) FROM voice_rejects").pluck().get()).toBe(0);
  });
});

describe("corrupt data", () => {
  it("a truncated blob is dropped, not truncated into a short vector", () => {
    const db = freshRoom();
    db.prepare("INSERT INTO voice_ids(name, emb, frames, takes) VALUES ('Broken', ?, 200, 1)").run(
      Buffer.from([1, 2, 3])
    );
    expect(knownVoices(db)).toHaveLength(0);
  });

  it("a reject blob for a name with no saved voice is simply not carried", () => {
    const db = freshRoom();
    enrollVoice(db, "Dana", print([1, 0, 0, 0], 200));
    rejectVoice(db, "Someone Else", print([0, 1, 0, 0], 200));
    expect(knownVoices(db)[0]?.rejects).toHaveLength(0);
  });

  it("a truncated reject blob for a saved voice is dropped", () => {
    const db = freshRoom();
    enrollVoice(db, "Dana", print([1, 0, 0, 0], 200));
    db.prepare("INSERT INTO voice_rejects(name, emb) VALUES (?, ?)").run(
      "Dana",
      Buffer.from([1, 2, 3]),
    );

    expect(knownVoices(db)[0]?.rejects).toEqual([]);
  });
});

describe("identityPrint", () => {
  it("is null with too little evidence, and defined once enough accumulates", () => {
    // Below MIN_NEW_VOICE_FRAMES (62) — not even a strong print.
    expect(isStrong(neural(0, 0, 60))).toBe(false);
    expect(identityPrint([neural(0, 0, 60)])).toBeNull();
    // Strong, but the total is under MIN_IDENTITY_FRAMES (156).
    expect(identityPrint([neural(0, 0, 100)])).toBeNull();

    const combined = identityPrint([neural(0, 0, 100), neural(0, 0, 100)]);
    expect(combined).not.toBeNull();
    expect(combined?.f).toBe(200);
    expect(combined?.v).toHaveLength(EMB_DIM);
  });

  it("ignores non-neural prints entirely — a DSP centroid must never be saved", () => {
    // A room recorded without the model saves nobody, rather than saving
    // something that could only ever be compared against what it may not be.
    expect(identityPrint([print([1, 0, 0], 400), print([1, 0, 0], 400)])).toBeNull();
  });

  it("returns null when the strong prints cancel out", () => {
    const a = neural(0, 0, 100);
    expect(identityPrint([a, { v: a.v.map((x) => -x), f: 100 }])).toBeNull();
  });
});

describe("rawSimilarity", () => {
  it("is null across a neural/legacy-width mismatch and defined for two neural prints", () => {
    expect(rawSimilarity(neural(0, 0, 200).v, [1, 0, 0])).toBeNull();
    expect(rawSimilarity(neural(0, 0, 200).v, neural(0, 0.1, 200).v)).not.toBeNull();
    // Two identical neural prints are a plain dot product of 1.
    expect(rawSimilarity(neural(0, 0, 200).v, neural(0, 0, 200).v)).toBeCloseTo(1, 6);
  });
});
