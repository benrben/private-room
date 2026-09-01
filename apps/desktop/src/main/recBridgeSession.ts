/** Cohesive extraction from recBridge.ts; its public API remains on that module. */
import { randomUUID, createDecipheriv } from "node:crypto";
import { open as openFile, unlink } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { Readable } from "node:stream";

import { authToken, authedHeaders, busy, ensureUp } from "./sidecar.js";
import {
  deleteFile,
  getFileBytes,
  getFileFull,
  getFileMeta,
  getFileName,
  inTransaction,
  insertFile,
  setDerivedFrom,
  setFileExtractedText,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import {
  appendRecChunk,
  finalizeRecAudio,
  finalizeRecAudioHybrid,
  getRecMeta,
  recoverRecChunks,
  recoverRecChunksHybrid,
  setRecMeta,
} from "./db-host/recordings.js";
import {
  enrollVoice,
  forgetVoice,
  identityPrint,
  knownVoices,
  rejectVoice,
  savedVoices,
  type KnownVoice,
  type SavedVoice,
} from "./db-host/voices.js";
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
  segmentVisibleText,
  spliceOut,
  transcriptText,
  type RecCut,
  type RecMeta,
  type RecSegment,
  type RecWord,
  type VoicePrint,
} from "./recFormat.js";
import { stripThinkSpans } from "./engineRouting.js";
import * as obs from "./obs.js";
import type { OpenRoom } from "./turnEngine.js";

export type { FileMeta, KnownVoice, SavedVoice };
import { coerceRecMeta, parseRecMeta, postControl } from "./recBridgeControl.js";
import { RecBridgeCtx, RecFile } from "./recBridgeState.js";
// =============================================================================
// ---- recGet / voicesList / voiceForget --------------------------------------
// =============================================================================

/** A recording file's editor payload: name + full meta (segments, words,
 * speakers, cuts). */
export function recGet(db: Database.Database, id: string): RecFile {
  return { name: getFileName(db, id), meta: parseRecMeta(getRecMeta(db, id)) };
}

/** The voices this room can recognise, for Settings. */
export function voicesList(db: Database.Database): SavedVoice[] {
  return savedVoices(db);
}

/** Forget a saved voice. Transcripts already written keep the names they show —
 * this is the room forgetting how to recognise someone, not a retraction of
 * what was said. */
export function voiceForget(db: Database.Database, name: string): SavedVoice[] {
  forgetVoice(db, name.trim());
  return savedVoices(db);
}

// =============================================================================
// ---- edit ops: notes / chapters / highlights / item delete / speaker name ---
// =============================================================================

/** Rust's `clean`: trim, then cap the CHARACTERS — a paste accident must not
 * blow out the transcript prefix. Spread-then-slice counts Unicode code points,
 * which is what Rust's `.chars()` counts; `String.slice` would count UTF-16
 * code units and cut an emoji in half at the boundary. */
export function clean(text: string, cap: number): string {
  return [...text.trim()].slice(0, cap).join("");
}

/** Rust's `at_time`: where in the recording an item may sit. A time past the
 * end is a bug in the caller, not something to store — an item nobody can ever
 * reach is worse than a refusal.
 *
 * This is the OFFLINE copy. The live path's own `at_time` (`session_ws.py`)
 * additionally measures against the engine's in-memory head, because the meta's
 * `durationCs` is only stamped on a flush and would refuse a mark plainly
 * inside the recording; nothing here is live, so there is no head to consult. */
export function atTime(meta: RecMeta, t0: number): number {
  if (t0 < 0 || (meta.durationCs > 0 && t0 > meta.durationCs)) {
    throw new Error("That moment is outside this recording.");
  }
  return t0;
}

/** The explicit op set `session_ws.py::_build_apply` accepts — one per live-safe
 * Rust command. Nothing crosses that boundary as executable code. */
export type RecEditOp =
  | { op: "rename_speaker"; label: string; name: string }
  | {
      op: "add_note";
      t0: number;
      kind: string;
      text: string;
      who: string | null;
    }
  | { op: "set_note"; noteId: string; text: string }
  | { op: "add_chapter"; t0: number; title: string }
  | { op: "set_chapter"; chapterId: string; title: string }
  | { op: "add_highlight"; t0: number; t1: number }
  | {
      op: "delete_item";
      itemKind: "note" | "chapter" | "highlight";
      itemId: string;
    };

/**
 * THE one way to change a recording's metadata (`edit_rec_meta`), split for the
 * Electron/sidecar boundary.
 *
 * The bug this exists for: `Engine::flush` writes the engine's OWN copy of the
 * meta over the room's row every few phrases, so a command that wrote to that
 * row while a recording was running was erased seconds later, in silence —
 * which is exactly the moment you know who is talking. So a LIVE recording's
 * meta is edited where the authoritative copy lives; anything else is edited in
 * the room directly. Both paths refresh the searchable transcript, so what
 * search and the AI read can never drift from what the screen shows.
 *
 * Annotating is NOT a new file version (Rust's own comment: "the audio is
 * untouched… versioning every note would bury the real edits"), so this writes
 * `setFileExtractedText` + `setRecMeta` and never snapshots.
 */
export async function routeEdit(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  op: RecEditOp,
  applyLocally: (meta: RecMeta) => void,
): Promise<RecMeta> {
  if (ctx.state.liveFileId === id) {
    const resp = await postControl(ctx, "/rec/edit_meta", {
      fileId: id,
      ...op,
    });
    const meta = coerceRecMeta(resp.meta);
    if (ctx.state.liveFileId === id) {
      ctx.state.lastMeta = meta;
    }
    return meta;
  }
  const meta = parseRecMeta(getRecMeta(db, id));
  applyLocally(meta);
  setFileExtractedText(db, id, transcriptText(meta));
  setRecMeta(db, id, JSON.stringify(meta));
  return meta;
}

/** Write your own note at a moment. `kind` is decision | action | question |
 * point; anything else is a plain point. Works while a recording is running. */
export async function recNoteAdd(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  kind: string,
  text: string,
  who?: string | null,
): Promise<RecMeta> {
  const cleaned = clean(text, 400);
  if (cleaned === "") {
    throw new Error("A note needs some words.");
  }
  const noteKind = noteKindOf(kind);
  const author = who != null && clean(who, 60) !== "" ? clean(who, 60) : null;
  return routeEdit(
    db,
    ctx,
    id,
    { op: "add_note", t0, kind: noteKind, text: cleaned, who: author },
    (meta) => {
      const at = atTime(meta, t0);
      meta.notes.push({
        id: randomUUID(),
        t0: at,
        kind: noteKind,
        text: cleaned,
        who: author,
        by: "you",
      });
      meta.notes.sort((a, b) => a.t0 - b.t0);
    },
  );
}

/** Retype a note. Correcting one the ROOM wrote makes it yours, so the next
 * reading leaves it alone — the same rule as confirming a recognised speaker. */
export async function recNoteSet(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  noteId: string,
  text: string,
): Promise<RecMeta> {
  const cleaned = clean(text, 400);
  if (cleaned === "") {
    throw new Error("A note needs some words.");
  }
  return routeEdit(
    db,
    ctx,
    id,
    { op: "set_note", noteId, text: cleaned },
    (meta) => {
      const note = meta.notes.find((n) => n.id === noteId);
      if (note === undefined) {
        throw new Error("That note is no longer in this recording.");
      }
      note.text = cleaned;
      note.by = "you";
    },
  );
}

/** Name a section, starting at `t0`. */
export async function recChapterAdd(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  title: string,
): Promise<RecMeta> {
  const cleaned = clean(title, 80);
  if (cleaned === "") {
    throw new Error("A chapter needs a name.");
  }
  return routeEdit(
    db,
    ctx,
    id,
    { op: "add_chapter", t0, title: cleaned },
    (meta) => {
      const at = atTime(meta, t0);
      meta.chapters.push({
        id: randomUUID(),
        t0: at,
        title: cleaned,
        by: "you",
      });
      meta.chapters.sort((a, b) => a.t0 - b.t0);
    },
  );
}

/** Rename a chapter — and make it yours. */
export async function recChapterSet(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  chapterId: string,
  title: string,
): Promise<RecMeta> {
  const cleaned = clean(title, 80);
  if (cleaned === "") {
    throw new Error("A chapter needs a name.");
  }
  return routeEdit(
    db,
    ctx,
    id,
    { op: "set_chapter", chapterId, title: cleaned },
    (meta) => {
      const chapter = meta.chapters.find((c) => c.id === chapterId);
      if (chapter === undefined) {
        throw new Error("That chapter is no longer in this recording.");
      }
      chapter.title = cleaned;
      chapter.by = "you";
    },
  );
}

/** Mark a span worth coming back to. `t1` before `t0` marks the instant. */
export async function recHighlightAdd(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  t1: number,
): Promise<RecMeta> {
  return routeEdit(db, ctx, id, { op: "add_highlight", t0, t1 }, (meta) => {
    const at = atTime(meta, t0);
    meta.highlights.push({
      id: randomUUID(),
      t0: at,
      t1: Math.max(t1, at),
      by: "you",
    });
    meta.highlights.sort((a, b) => a.t0 - b.t0);
  });
}

/** Remove one item ("note" | "chapter" | "highlight").
 *
 * Deleting one the ROOM wrote is a real removal, not a correction, so the next
 * reading may find it again — which is right: you removed this reading's claim,
 * not the fact that the words are there. */
export async function recItemDelete(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  kind: "note" | "chapter" | "highlight",
  itemId: string,
): Promise<RecMeta> {
  return routeEdit(
    db,
    ctx,
    id,
    { op: "delete_item", itemKind: kind, itemId },
    (meta) => {
      const before =
        meta.notes.length + meta.chapters.length + meta.highlights.length;
      if (kind === "note") {
        meta.notes = meta.notes.filter((n) => n.id !== itemId);
      } else if (kind === "chapter") {
        meta.chapters = meta.chapters.filter((c) => c.id !== itemId);
      } else if (kind === "highlight") {
        meta.highlights = meta.highlights.filter((h) => h.id !== itemId);
      } else {
        // Unreachable through the typed API, reachable through IPC, where the
        // argument is whatever the renderer sent. Rust names the kind back.
        throw new Error(`Unknown item kind "${String(kind)}".`);
      }
      if (
        before ===
        meta.notes.length + meta.chapters.length + meta.highlights.length
      ) {
        throw new Error("That item is no longer in this recording.");
      }
    },
  );
}

/**
 * Teach the room this voice, so the NEXT recording knows who it is.
 *
 * `label` is the machine label just named, `name` what the user called them
 * (empty clears the name), and `wrong` the name the app had GUESSED here and
 * has just been corrected on, if any.
 *
 * Best-effort by design: this is an enhancement to a rename, and a rename that
 * refused to save because a voice could not be learned would be strictly worse
 * than one that quietly learns nothing. Nothing is learned when the voice has
 * too little speech behind it, or came from the DSP fallback — see
 * `identityPrint`, which is the one place that rule lives.
 */
export function learnVoice(
  db: Database.Database,
  meta: RecMeta,
  label: string,
  name: string,
  wrong: string | null,
): void {
  const print = identityPrint(speakerVoicePrints(meta, label));
  if (print === null) return;
  correctLearnedVoice(db, wrong, name, print);
}

export function speakerVoicePrints(meta: RecMeta, label: string): VoicePrint[] {
  const prints: VoicePrint[] = [];
  for (const seg of meta.segments) {
    if (seg.speaker === label && seg.voice != null) {
      prints.push(seg.voice);
    }
  }
  return prints;
}

export function correctLearnedVoice(
  db: Database.Database,
  wrong: string | null,
  name: string,
  print: VoicePrint,
): void {
  // The correction first: whatever the user renamed this to, the name they
  // renamed it FROM is now known to be somebody else.
  if (wrong !== null && wrong !== name) {
    rejectVoice(db, wrong, print);
  }
  if (name !== "") {
    enrollVoice(db, name, print);
  }
}

export function speakerLabel(speaker: string): string {
  const label = speaker.trim();
  if (label === "") throw new Error("No speaker selected.");
  return label;
}

export function guessedSpeakerName(meta: RecMeta, label: string): string | null {
  const name = meta.speakerNames[label] ?? null;
  return name !== null && meta.recognized.includes(name) ? name : null;
}

export function requireNamedSpeaker(meta: RecMeta, label: string): void {
  if (meta.segments.length === 0) {
    throw new Error("That recording has no transcript yet.");
  }
  if (!meta.segments.some((segment) => segment.speaker === label)) {
    throw new Error(`Nobody in this recording is labelled "${label}".`);
  }
}

export function applySpeakerName(meta: RecMeta, label: string, called: string): string | null {
  requireNamedSpeaker(meta, label);
  const previous = meta.speakerNames[label] ?? null;
  const wrong = guessedSpeakerName(meta, label);
  if (called === "" || called === label) {
    delete meta.speakerNames[label];
  } else {
    meta.speakerNames[label] = called;
  }
  meta.recognized = withoutSpeakerGuesses(meta.recognized, previous, called);
  return wrong;
}

export function withoutSpeakerGuesses(names: string[], previous: string | null, called: string): string[] {
  return names.filter((name) => name !== previous).filter((name) => name !== called);
}

/**
 * GH #5: name a speaker after the fact ("Speaker 2" -> "Dana").
 *
 * Stores an OVERLAY keyed by the machine label rather than rewriting the
 * segments, so re-clustering — which renames labels as a meeting grows — cannot
 * destroy the name, and one write renames every line that speaker said. An
 * empty (or whitespace-only) name clears it back to the machine label.
 *
 * This is also where the room LEARNS a voice. Correcting a name the app guessed
 * teaches both halves of the correction: the right person gains this voice, the
 * wrong one is told it is not theirs. See §4 for where the "what was this label
 * called before" fact comes from on each path.
 */
export async function recSetSpeakerName(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  speaker: string,
  name: string,
): Promise<RecMeta> {
  const label = speakerLabel(speaker);
  // A name long enough to blow out the transcript prefix is a paste accident.
  const called = clean(name, 60);

  // What the app had GUESSED here and has just been corrected on. Offline this
  // is read out of the edit itself; live, out of the last meta this process saw
  // (the rename POST answers with the already-mutated one). Live is best-effort
  // by construction — a stale snapshot costs a missed correction, never a wrong
  // rename.
  const priorMeta = ctx.state.liveFileId === id ? ctx.state.lastMeta : null;
  let wrong = priorMeta === null ? null : guessedSpeakerName(priorMeta, label);

  const meta = await routeEdit(
    db,
    ctx,
    id,
    { op: "rename_speaker", label, name: called },
    (m) => {
      wrong = applySpeakerName(m, label, called);
    },
  );

  try {
    learnVoice(db, meta, label, called, wrong);
  } catch {
    // Best-effort by design — see learnVoice's own doc. A malformed voiceprint
    // blob in an old room must not fail the rename it was attached to.
  }
  return meta;
}
