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
import { parseRecMeta } from "./recBridgeControl.js";
import { RecBridgeCtx, refuseWhileRetranscribing } from "./recBridgeState.js";
// =============================================================================
// ---- post-stop transcript editing (recording_cmds.rs:1218-1449) ------------
// =============================================================================

/** `commands/files.rs::store_file_bytes`: snapshot the file's CURRENT state
 * into History, then overwrite it — one transaction, so a snapshot can never
 * survive a write that did not land (or the other way round). What makes a
 * studio-style transcript edit undoable. */
export function storeFileBytes(
  db: Database.Database,
  id: string,
  bytes: Uint8Array,
  text: string,
  cause: string,
): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

export function matchingTranscriptWorkspace(
  open: OpenRoom | null,
  db: Database.Database,
): NonNullable<OpenRoom["workspace"]> | undefined {
  if (open === null) return undefined;
  if (open.db !== db) return undefined;
  return open.workspace;
}

export function storeTranscriptEdit(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  text: string,
  cause: string,
  workspaceSnapshotAlready = false,
): void {
  const workspace = matchingTranscriptWorkspace(ctx.deps.currentRoom(), db);
  if (workspace !== undefined) {
    // snapshotVersion captures the outgoing transcript before its first await.
    // Audio bytes remain in the normal file; a failed history snapshot must
    // never move a copy back into original_bytes.
    if (!workspaceSnapshotAlready) {
      void workspace.snapshotVersion(id, cause).catch(() => undefined);
    }
    setFileExtractedText(db, id, text);
    return;
  }
  const bytes = getFileBytes(db, id) ?? Buffer.alloc(0);
  storeFileBytes(db, id, bytes, text, cause);
}

/** Rust's `str::trim_end_matches` for one repeated suffix. */
export function trimEndMatches(s: string, suffix: string): string {
  let out = s;
  while (out.endsWith(suffix)) {
    out = out.slice(0, out.length - suffix.length);
  }
  return out;
}

export function requireEditableRange(t0: number, t1: number): void {
  if (t1 <= t0) throw new Error("Nothing selected.");
}

export function refuseWhileLive(ctx: RecBridgeCtx, id: string): void {
  if (ctx.state.liveFileId === id) {
    throw new Error("Pause the recording before editing the transcript.");
  }
}

export function markDeletedSegments(segments: RecSegment[], t0: number, t1: number): void {
  for (const segment of segments) {
    markDeletedWords(segment.words, t0, t1);
    clearLegacySegmentInsideCut(segment, t0, t1);
  }
}

export function markDeletedWords(words: RecWord[], t0: number, t1: number): void {
  for (const word of words) {
    if (word.t0 < t1 && word.t1 > t0) word.del = true;
  }
}

export function clearLegacySegmentInsideCut(segment: RecSegment, t0: number, t1: number): void {
  if (segment.words.length === 0 && segment.t0 >= t0 && segment.t1 <= t1) {
    segment.text = "";
  }
}

/**
 * Studio-style transcript editing: delete a time span. The words inside it
 * disappear from the transcript, playback skips it, and "export edited copy"
 * cuts it from the audio for real. Non-destructive (a cut list + word marks);
 * the file version snapshot makes it undoable.
 *
 * Never routed to the live engine — unlike the annotation commands, this
 * refuses while the file is live, exactly as Rust's own `rec_delete_range` does.
 */
export function recDeleteRange(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  t1: number,
  workspaceSnapshotAlready = false,
): RecMeta {
  requireEditableRange(t0, t1);
  refuseWhileLive(ctx, id);
  refuseWhileRetranscribing(id);
  const meta = parseRecMeta(getRecMeta(db, id));
  markDeletedSegments(meta.segments, t0, t1);
  meta.cuts = addCut(meta.cuts, { t0, t1 });
  storeTranscriptEdit(
    db,
    ctx,
    id,
    transcriptText(meta),
    "Edited transcript",
    workspaceSnapshotAlready,
  );
  setRecMeta(db, id, JSON.stringify(meta));
  return meta;
}

export async function recDeleteRangeHybrid(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  t1: number,
): Promise<RecMeta> {
  // BEFORE the snapshot, not only inside {@link recDeleteRange}: this wrapper
  // writes a History entry first, so a refusal reached after it would spend one
  // of the ten kept versions on an edit that never happened.
  refuseWhileRetranscribing(id);
  const open = ctx.deps.currentRoom();
  if (open?.db !== db || open.workspace === undefined)
    return recDeleteRange(db, ctx, id, t0, t1);
  await open.workspace.snapshotVersion(id, "Edited transcript");
  return recDeleteRange(db, ctx, id, t0, t1, true);
}

/**
 * Retype the words a selection covers, keeping their place in time.
 *
 * The transcript could be EDITED only by deleting — so a misheard name was a
 * choice between leaving it wrong and losing the sentence, and the recording's
 * text is what search, the AI and every export read. Correcting is not
 * deleting: the audio is untouched, no cut is added, and `del` is never set.
 *
 * Timings are spread evenly across the span the old words occupied. It is an
 * approximation and it is stated as one; what it must NOT do is invent a time
 * outside the words that were really said, because playback, the subtitle
 * export and the audio cut all read these numbers.
 */
export function correctWords(
  seg: RecSegment,
  t0: number,
  t1: number,
  text: string,
): number {
  const hit: number[] = [];
  seg.words.forEach((w, i) => {
    if (w.del !== true && w.t0 < t1 && w.t1 > t0) {
      hit.push(i);
    }
  });
  if (hit.length === 0) {
    return 0;
  }
  const first = hit[0] as number;
  const last = hit[hit.length - 1] as number;
  const spanT0 = (seg.words[first] as RecWord).t0;
  const spanT1 = (seg.words[last] as RecWord).t1;
  const tokens = text.split(/\s+/).filter((t) => t !== "");
  const span = Math.max(spanT1 - spanT0, 1);
  const n = Math.max(tokens.length, 1);
  const replacement: RecWord[] = tokens.map((w, i) => ({
    w,
    t0: spanT0 + Math.trunc((span * i) / n),
    t1: spanT0 + Math.trunc((span * (i + 1)) / n),
    del: false,
  }));
  // Splice in place: the words BEFORE and AFTER the selection keep their own
  // timings, including any already marked deleted inside the range's gaps.
  const tail = seg.words.slice(last + 1);
  seg.words.length = first;
  seg.words.push(...replacement, ...tail);
  return hit.length;
}

/**
 * Studio-style transcript editing: retype what a selection says.
 *
 * Deliberately confined to ONE phrase. A correction spread across a speaker
 * change has no honest place to put the new words — whose line are they? — and
 * guessing there would put words in somebody's mouth.
 */
export function recCorrectRange(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  t1: number,
  rawText: string,
  workspaceSnapshotAlready = false,
): RecMeta {
  const text = correctedText(rawText, t0, t1);
  refuseWhileLive(ctx, id);
  refuseWhileRetranscribing(id);
  const meta = parseRecMeta(getRecMeta(db, id));
  const segment = singleCorrectableSegment(meta.segments, t0, t1);
  requireWordsCorrected(correctWords(segment, t0, t1, text));
  storeTranscriptEdit(
    db,
    ctx,
    id,
    transcriptText(meta),
    "Corrected transcript",
    workspaceSnapshotAlready,
  );
  setRecMeta(db, id, JSON.stringify(meta));
  return meta;
}

export function correctedText(rawText: string, t0: number, t1: number): string {
  requireEditableRange(t0, t1);
  const text = rawText.trim();
  if (text === "") {
    throw new Error('Type the corrected words, or use "Delete from recording" to remove them.');
  }
  return text;
}

export function singleCorrectableSegment(segments: RecSegment[], t0: number, t1: number): RecSegment {
  const touched = segments.filter((segment) => containsCorrectableWord(segment, t0, t1));
  if (touched.length === 0) {
    throw new Error(
      "Nothing to correct there — that selection has no word timings. Re-transcribe the recording to get them.",
    );
  }
  if (touched.length > 1) {
    throw new Error(
      "That selection crosses more than one phrase. Correct one phrase at a time — otherwise there is no honest way to say who said the new words.",
    );
  }
  return touched[0] as RecSegment;
}

export function containsCorrectableWord(segment: RecSegment, t0: number, t1: number): boolean {
  return segment.words.some((word) => word.del !== true && word.t0 < t1 && word.t1 > t0);
}

export function requireWordsCorrected(count: number): void {
  if (count === 0) throw new Error("Nothing to correct there.");
}

export async function recCorrectRangeHybrid(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  t0: number,
  t1: number,
  text: string,
): Promise<RecMeta> {
  // See {@link recDeleteRangeHybrid}: refused before the snapshot, so a
  // rebuild in flight cannot cost the file a History slot.
  refuseWhileRetranscribing(id);
  const open = ctx.deps.currentRoom();
  if (open?.db !== db || open.workspace === undefined)
    return recCorrectRange(db, ctx, id, t0, t1, text);
  await open.workspace.snapshotVersion(id, "Corrected transcript");
  return recCorrectRange(db, ctx, id, t0, t1, text, true);
}

/**
 * The surviving transcript, re-flowed onto the timeline the cuts leave behind:
 * deleted words gone, every remaining timestamp pulled back by the length of
 * the cuts before it, empty segments dropped.
 *
 * Annotations move onto the shortened timeline with the words they point at,
 * and anything that pointed INTO a cut is dropped — the copy no longer contains
 * what it was about. The original keeps everything: cuts are undoable, so
 * un-deleting a span has to bring its notes back with it.
 */
export function reflowAfterCuts(meta: RecMeta, splicedLen: number): RecMeta {
  const reflowed = reflowedMetaShell(meta, splicedLen);
  for (const segment of meta.segments) {
    const next = reflowedSegment(meta.cuts, segment);
    if (next !== null) reflowed.segments.push(next);
  }
  return reflowed;
}

export function reflowedMetaShell(meta: RecMeta, splicedLen: number): RecMeta {
  const shift = (time: number): number => time - cutShiftBefore(meta.cuts, time);
  const kept = (time: number): boolean => !insideCut(meta.cuts, time);
  return {
    ...defaultRecMeta(),
    maxSpeakers: meta.maxSpeakers,
    durationCs: csOfSamples(splicedLen),
    // The edited copy keeps the same speaker labels, so it keeps their names
    // too (GH #5) — otherwise "Dana" silently reverts to "Speaker 2".
    speakerNames: { ...meta.speakerNames },
    recognized: [...meta.recognized],
    readOf: meta.readOf ?? null,
    chapters: meta.chapters
      .filter((c) => kept(c.t0))
      .map((c) => ({ ...c, t0: shift(c.t0) })),
    highlights: meta.highlights
      .filter((h) => kept(h.t0))
      .map((h) => ({ ...h, t0: shift(h.t0), t1: shift(h.t1) })),
    notes: meta.notes
      .filter((n) => kept(n.t0))
      .map((n) => ({ ...n, t0: shift(n.t0) })),
  };
}

export function reflowedSegment(cuts: RecCut[], segment: RecSegment): RecSegment | null {
  const text = segmentVisibleText(segment);
  if (text === "") return null;
  const words = reflowedWords(cuts, segment.words);
  return {
    id: randomUUID(),
    source: segment.source,
    speaker: segment.speaker,
    t0: reflowedStart(cuts, words, segment.t0),
    t1: reflowedEnd(cuts, words, segment.t1),
    text,
    words,
    lang: segment.lang ?? null,
    voice: segment.voice ?? null,
  };
}

export function reflowedWords(cuts: RecCut[], words: RecWord[]): RecWord[] {
  return words
    .filter((word) => word.del !== true)
    .map((word) => ({
      w: word.w,
      t0: word.t0 - cutShiftBefore(cuts, word.t0),
      t1: word.t1 - cutShiftBefore(cuts, word.t1),
      del: false,
    }));
}

export function reflowedStart(cuts: RecCut[], words: RecWord[], segmentStart: number): number {
  return words[0]?.t0 ?? segmentStart - cutShiftBefore(cuts, segmentStart);
}

export function reflowedEnd(cuts: RecCut[], words: RecWord[], segmentEnd: number): number {
  return words.at(-1)?.t1 ?? segmentEnd - cutShiftBefore(cuts, segmentEnd);
}

export function hasAppliedEdits(meta: RecMeta): boolean {
  return meta.cuts.length > 0 || meta.segments.some((segment) => segment.words.some((word) => word.del === true));
}

export function requireAppliedEdits(meta: RecMeta): void {
  if (!hasAppliedEdits(meta)) {
    throw new Error("No edits to apply — delete something from the transcript first.");
  }
}

export function editedCopyStem(name: string): string {
  return `${trimEndMatches(name, ".wav")} (edited).wav`;
}

/**
 * Render the edits into a new file: cut spans removed from the audio,
 * timestamps re-flowed, deleted words gone. The original stays untouched.
 *
 * Rust holds the room lock only to READ and again to WRITE, doing the
 * decode/splice/re-encode off the thread that paints the window. Node's main
 * thread has no window to paint and better-sqlite3 is synchronous either way,
 * so there is no equivalent split to make — the work is the same work.
 */
export function recExportClean(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
): FileMeta {
  const [name, , bytes] = getFileFull(db, id);
  const meta = parseRecMeta(getRecMeta(db, id));
  requireAppliedEdits(meta);
  const spliced = spliceOut(decodeWav(bytes ?? Buffer.alloc(0)), meta.cuts);
  const newMeta = reflowAfterCuts(meta, spliced.length);
  const file = insertFile(
    db,
    editedCopyStem(name),
    "audio/wav",
    encodeWav(spliced),
    transcriptText(newMeta),
    "recording",
  );
  setRecMeta(db, file.id, JSON.stringify(newMeta));
  ctx.deps.notifyFilesChanged?.();
  return file;
}

export function workspaceEditedCopyDestination(db: Database.Database, id: string, name: string): string {
  const source = db
    .prepare("SELECT relative_path FROM files WHERE id = ?")
    .get(id) as { relative_path: string | null };
  const editedName = editedCopyStem(name);
  if (source.relative_path === null) return editedName;
  const parent = path.posix.dirname(source.relative_path);
  return parent === "." ? editedName : path.posix.join(parent, editedName);
}

export function finalizeWorkspaceEditedCopy(
  db: Database.Database,
  fileId: string,
  meta: RecMeta,
): FileMeta {
  setFileExtractedText(db, fileId, transcriptText(meta));
  db.prepare("UPDATE files SET mime_type = 'audio/wav' WHERE id = ?").run(fileId);
  setRecMeta(db, fileId, JSON.stringify(meta));
  return getFileMeta(db, fileId);
}

/** Workspace-aware edited-copy export used by the live IPC surface. */
export async function recExportCleanHybrid(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
): Promise<FileMeta> {
  const open = ctx.deps.currentRoom();
  if (open?.db !== db || open.workspace === undefined)
    return recExportClean(db, ctx, id);
  const [name] = getFileFull(db, id);
  const bytes = await open.workspace.readBuffer(id);
  const meta = parseRecMeta(getRecMeta(db, id));
  requireAppliedEdits(meta);
  const spliced = spliceOut(decodeWav(bytes), meta.cuts);
  const newMeta = reflowAfterCuts(meta, spliced.length);
  const entry = await open.workspace.createFile(
    workspaceEditedCopyDestination(db, id, name),
    Readable.from([encodeWav(spliced)]),
    "recording",
  );
  const file = finalizeWorkspaceEditedCopy(db, entry.fileId, newMeta);
  ctx.deps.notifyFilesChanged?.();
  return file;
}
