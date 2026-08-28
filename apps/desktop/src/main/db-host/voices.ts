/**
 * The room's saved voices — port of `src-tauri/src/db/voices.rs`, PLUS the
 * closed set of pure `recording::diarize` vector-math helpers that table needs
 * to do its one job (average and compare already-computed voiceprints).
 *
 * Naming a speaker in one recording saves that person's voiceprint here, and
 * every later recording is matched against this table, so a returning speaker
 * gets their name back instead of a fresh "Speaker 2".
 *
 * Per ROOM, not per app, deliberately (voices.rs's own module doc): a
 * voiceprint is biometric data about a real person, so it stays inside the
 * SQLCipher-encrypted room file, on this device, and is never sent to a model —
 * local or cloud. Deleting the room deletes the voices with it, because they
 * were only ever part of it.
 *
 * SCOPE NOTE — `recording/diarize.rs` (2000+ lines: live clustering, the
 * TitaNet Metal model, the whole speaker-recognition pipeline) is NOT ported
 * here or anywhere in this migration: it is the live recording engine's own
 * territory and already shipped as the Python `rec/engine.py`. What follows is
 * exactly the model-free subset this table and `recBridge.ts`'s `learnVoice`
 * call, lifted from `diarize.rs` rather than re-derived:
 *   - `neural()` (diarize.rs:246-248) — is a print from the current, 192-dim
 *     TitaNet generation (`titanet::EMB_DIM`),
 *   - `cosine()`/`raw_similarity()` (678-689 / 370-373),
 *   - `KNOWN_SAME` (283) — the same-voice threshold,
 *   - `is_silent`/`defines_voice`/`is_strong` (533-549) with
 *     `MIN_NEW_VOICE_FRAMES` (144) and `MIN_IDENTITY_FRAMES` (151/297),
 *   - `identity_print()` (328-348) — the one print that stands for a voice
 *     across recordings.
 *
 * ESTABLISHED CONVENTIONS reused from `util.ts`: `queryOpt`/`queryRows`/
 * `executeOne`, positional `?` placeholders, `.raw()` row access by index
 * matching Rust's `r.get(i)`.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { executeOne, queryOpt, queryRows, type Row } from "./util.js";
import { inTransaction } from "./files.js";
import type { VoicePrint } from "../recFormat.js";

// =====================================================================
// diarize.rs's pure vector math — the exact closed subset this file needs
// =====================================================================

/** `titanet::EMB_DIM` (diarize/titanet.rs:20) — the current neural embedding's
 * width. Anything else is a DSP-fallback/legacy print from a room recorded
 * without the model, and the two spaces share no geometry. */
export const EMB_DIM = 192;

/** How similar two NEURAL prints must be to count as the same voice across
 * recordings (diarize.rs:283). DERIVED from the in-recording threshold rather
 * than measured — its false-accept rate is unknown, which is why nothing here
 * ever uses it to ASSERT an identity, only to withdraw a stale denial. */
export const KNOWN_SAME = 0.72;

/** Voiced frames (16 ms each) one phrase needs before it defines a voice
 * rather than merely being labelled with one — `is_strong`'s bar. */
const MIN_NEW_VOICE_FRAMES = 62;

/** Total voiced evidence an identity needs across every strong print before it
 * may be saved or recognised across recordings (`MIN_OPEN_FRAMES`, ~2.5 s).
 * Inside a recording a thin voice is corrected by the next pass; across
 * recordings nothing corrects it. */
const MIN_IDENTITY_FRAMES = 156;

/** A room's known voice, as `db::known_voices` hands it to the recording
 * engine: the saved centroid plus every counter-example it has been corrected
 * against. Mirrors `diarize::KnownVoice` — plain field names, no serde rename,
 * which is also the shape `/rec/start`'s `KnownVoiceIn` reads. */
export interface KnownVoice {
  name: string;
  vec: number[];
  rejects: number[][];
}

/** A print with no voiced audio at all — never a candidate for anything. */
export function isSilent(p: VoicePrint): boolean {
  return p.f === 0 || p.v.every((x) => x === 0);
}

/** Enough speech to define a voice at the whole-phrase evidence scale — the
 * bar `identityPrint` filters incoming prints by. */
export function isStrong(p: VoicePrint): boolean {
  return p.f >= MIN_NEW_VOICE_FRAMES && !isSilent(p);
}

/** Is this print from the current (TitaNet, 192-dim) embedding generation? */
export function isNeural(vec: readonly number[]): boolean {
  return vec.length === EMB_DIM;
}

function dot(a: readonly number[], b: readonly number[], n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
}

/** `cosine` (diarize.rs:678-689): a plain dot product for two equal-length,
 * already-L2-normalized prints, with the shared-prefix fallback for a length
 * mismatch. Zero across the neural/DSP divide — those two spaces share no
 * geometry at all. */
function cosine(a: readonly number[], b: readonly number[]): number {
  if (isNeural(a) !== isNeural(b)) {
    return 0;
  }
  if (a.length === b.length) {
    return dot(a, b, a.length);
  }
  const n = Math.min(a.length, b.length);
  return dot(a, b, n) / Math.max(Math.sqrt(dot(a, a, n)) * Math.sqrt(dot(b, b, n)), 1e-6);
}

/** What cross-recording recognition compares two saved voices on
 * (diarize.rs:370-373). `null` when the prints are not comparable at all —
 * either is not a current-generation print, or their widths differ. */
export function rawSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (!isNeural(a) || !isNeural(b) || a.length !== b.length) {
    return null;
  }
  return cosine(a, b);
}

/**
 * The one print that stands for a voice across recordings: the renormalized
 * mean of every strong, current-generation print in `prints`
 * (diarize.rs:328-348).
 *
 * Neural prints ONLY, deliberately: this is the single print that outlives its
 * recording, and a saved DSP centroid could only ever be compared against
 * something it may not be compared against. A room recorded without the model
 * saves nobody rather than saving something meaningless.
 *
 * `null` when the voice has not been heard for {@link MIN_IDENTITY_FRAMES} of
 * real speech across those prints — a name typed on half a sentence is a fine
 * label for that recording and far too little to recognise anyone by later.
 */
export function identityPrint(prints: readonly VoicePrint[]): VoicePrint | null {
  const strong = prints.filter((p) => isNeural(p.v) && isStrong(p));
  const first = strong[0];
  if (first === undefined) {
    return null;
  }
  const dim = first.v.length;
  let frames = 0;
  for (const p of strong) {
    frames += p.f;
  }
  if (frames < MIN_IDENTITY_FRAMES) {
    return null;
  }
  const mean = new Array<number>(dim).fill(0);
  for (const p of strong) {
    for (let i = 0; i < dim; i++) {
      mean[i] = (mean[i] as number) + (p.v[i] as number);
    }
  }
  const norm = Math.sqrt(mean.reduce((sum, x) => sum + x * x, 0));
  if (norm < 1e-6) {
    return null; // prints that cancel out define nothing
  }
  return { v: mean.map((x) => x / norm), f: frames };
}

// =====================================================================
// db/voices.rs — the table itself
// =====================================================================

/** How many enrollments may still move a saved centroid (voices.rs:31). Past
 * this the voice is settled and one odd recording — a cold, a bad headset, a
 * noisy café — cannot drag it away from everything it was built from. */
const MAX_MERGE_WEIGHT = 20;

/** One saved voice, for the Settings list. The embedding is deliberately NOT
 * here: nothing outside this module and the diarizer has any business with it,
 * and it must not be one refactor away from crossing an IPC boundary. */
export interface SavedVoice {
  name: string;
  /** Seconds of speech behind the saved centroid — what the room is judging
   * this person by, in a unit a human can weigh. */
  seconds: number;
  /** How many separate namings have been folded into it. */
  takes: number;
  /** How many voices the user has said are NOT this person. */
  corrections: number;
  updatedAt: string;
}

function toBlob(v: readonly number[]): Buffer {
  const b = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) {
    b.writeFloatLE(v[i] as number, i * 4);
  }
  return b;
}

/** A stored embedding back into floats. A blob whose length is not a whole
 * number of f32s is corrupt, not a short vector — it is dropped (`null`)
 * rather than silently truncated into a print that would then be compared
 * against real ones. */
function fromBlob(b: Buffer): number[] | null {
  if (b.length === 0 || b.length % 4 !== 0) {
    return null;
  }
  const out = new Array<number>(b.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = b.readFloatLE(i * 4);
  }
  return out;
}

/** Every voice this room can recognise, with the corrections the user has made
 * to each. Read once at the start of a recording (and again for a rebuild) —
 * the whole table is a handful of 192-float rows. */
export function knownVoices(db: Database.Database): KnownVoice[] {
  const out: KnownVoice[] = [];
  const byName = new Map<string, KnownVoice>();
  for (const [name, emb] of queryRows(
    db,
    "SELECT name, emb FROM voice_ids ORDER BY name",
    [],
    (r: Row) => [r[0] as string, r[1] as Buffer] as const
  )) {
    const vec = fromBlob(emb);
    if (vec === null) {
      continue;
    }
    const voice: KnownVoice = { name, vec, rejects: [] };
    out.push(voice);
    byName.set(name, voice);
  }
  for (const [name, emb] of queryRows(
    db,
    "SELECT name, emb FROM voice_rejects",
    [],
    (r: Row) => [r[0] as string, r[1] as Buffer] as const
  )) {
    const vec = fromBlob(emb);
    if (vec === null) {
      continue;
    }
    byName.get(name)?.rejects.push(vec);
  }
  return out;
}

/** The list behind Settings -> saved voices. */
export function savedVoices(db: Database.Database): SavedVoice[] {
  return queryRows(
    db,
    `SELECT v.name, v.frames, v.takes, v.updated_at,
            (SELECT COUNT(*) FROM voice_rejects r WHERE r.name = v.name)
     FROM voice_ids v ORDER BY v.name`,
    [],
    (r: Row) => ({
      name: r[0] as string,
      // Voiced frames are the diarizer's 16 ms hop.
      seconds: (r[1] as number) * 0.016,
      takes: r[2] as number,
      updatedAt: r[3] as string,
      corrections: r[4] as number,
    })
  );
}

/**
 * Remember `name`'s voice, or refine what is already remembered.
 *
 * Refining is a weighted running mean frozen at {@link MAX_MERGE_WEIGHT}, the
 * same shape the live `SpeakerBook` uses: hearing someone in a tenth meeting
 * should sharpen the centroid, not restart it, and should never be able to
 * redefine a person on its own.
 *
 * A stored centroid of a DIFFERENT width is from another embedding generation
 * (a room recorded before the neural model, or with it missing). The two spaces
 * share no geometry, so they cannot be averaged — the new print replaces the
 * old one outright, which is the only comparable thing to have.
 */
export function enrollVoice(db: Database.Database, name: string, print: VoicePrint): void {
  const trimmed = name.trim();
  if (trimmed === "" || isSilent(print)) {
    return;
  }
  const prior = queryOpt(
    db,
    "SELECT emb, frames, takes FROM voice_ids WHERE name = ?",
    [trimmed],
    (r: Row) => ({ emb: r[0] as Buffer, frames: r[1] as number, takes: r[2] as number })
  );
  const old = prior === null ? null : fromBlob(prior.emb);
  let vec: number[];
  let frames: number;
  let takes: number;
  if (prior !== null && old !== null && old.length === print.v.length) {
    const w = Math.min(prior.takes, MAX_MERGE_WEIGHT);
    const merged = old.map((a, i) => (a * w + (print.v[i] as number)) / (w + 1));
    const norm = Math.sqrt(merged.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-6) {
      return; // the two prints cancel: keep what we had
    }
    vec = merged.map((x) => x / norm);
    frames = prior.frames + print.f;
    takes = prior.takes + 1;
  } else {
    // No prior row at all, or one from another embedding generation — either
    // way this print becomes the whole centroid.
    vec = [...print.v];
    frames = print.f;
    takes = 1;
  }
  executeOne(
    db,
    `INSERT INTO voice_ids(name, emb, frames, takes, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(name) DO UPDATE SET
       emb = excluded.emb, frames = excluded.frames,
       takes = excluded.takes, updated_at = excluded.updated_at`,
    [trimmed, toBlob(vec), frames, takes]
  );
  // A voice can stop being a counter-example: the user has just said this print
  // IS this person, which overrules an older "not them". Matched by SIMILARITY,
  // not by an identical blob — the centroid behind a correction and the
  // centroid behind the naming that overrules it come from different recordings
  // and are never byte-identical, so an exact match would leave the denial
  // standing and the user's newest word losing to their oldest.
  const stale = queryRows(
    db,
    "SELECT emb FROM voice_rejects WHERE name = ?",
    [trimmed],
    (r: Row) => r[0] as Buffer
  ).filter((emb) => {
    const other = fromBlob(emb);
    if (other === null) {
      return false;
    }
    const sim = rawSimilarity(print.v, other);
    return sim !== null && sim >= KNOWN_SAME;
  });
  for (const emb of stale) {
    executeOne(db, "DELETE FROM voice_rejects WHERE name = ? AND emb = ?", [trimmed, emb]);
  }
}

/** Record that `print` is NOT `name` — the user corrected a guess. Without this
 * a wrong match is wrong again in every future recording, because the
 * correction only ever taught the OTHER name. Stored against the name that was
 * wrong, which is the claim being denied. */
export function rejectVoice(db: Database.Database, name: string, print: VoicePrint): void {
  const trimmed = name.trim();
  if (trimmed === "" || isSilent(print)) {
    return;
  }
  executeOne(db, "INSERT OR IGNORE INTO voice_rejects(name, emb) VALUES (?, ?)", [
    trimmed,
    toBlob(print.v),
  ]);
}

/** Forget a voice completely — the centroid and every correction attached to
 * it. Transcripts already written keep the name they show: this is the room
 * forgetting how to recognise someone, not a retraction of what was said. */
export function forgetVoice(db: Database.Database, name: string): void {
  inTransaction(db, () => {
    executeOne(db, "DELETE FROM voice_rejects WHERE name = ?", [name]);
    executeOne(db, "DELETE FROM voice_ids WHERE name = ?", [name]);
  });
}
