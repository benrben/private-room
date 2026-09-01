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
import { recCorrectRange, recDeleteRange, trimEndMatches } from "./recBridgeEdits.js";
import { recStart } from "./recBridgePersistence.js";
import { RecBridgeCtx, beginRetranscribe, endRetranscribe, isRetranscribing, retranscribing } from "./recBridgeState.js";
// =============================================================================
// ---- translate (recording_cmds.rs:1541-1661) --------------------------------
// =============================================================================

/** Rust's own `const BATCH: usize = 12`. */
export const TRANSLATE_BATCH_SIZE = 12;

/** One line per spoken (non-empty) segment, in the shape the translation prompt
 * and the exported document both use — the user's own name for a speaker when
 * they set one (GH #5). */
export function translatableLines(meta: RecMeta): string[] {
  const lines: string[] = [];
  for (const seg of meta.segments) {
    const text = segmentVisibleText(seg);
    if (text === "") {
      continue;
    }
    lines.push(
      `${formatStamp(seg.t0)} ${displaySpeaker(meta, seg.speaker)}: ${text}`,
    );
  }
  return lines;
}

export function buildTranslatePrompt(
  language: string,
  batch: readonly string[],
): string {
  return (
    `Translate the following transcript lines into ${language}. Each line starts with a ` +
    `[m:ss] timestamp and a speaker name — copy that prefix EXACTLY as it is, and ` +
    `translate only the words after the colon. Output exactly ${batch.length} lines, one per input ` +
    `line, with no numbering, preamble, or explanations.\n\n${batch.join("\n")}`
  );
}

export interface ReconciledBatch {
  translated: string[];
  untranslated: number;
}

/** Reconcile a batch's raw model output against what was asked for. The model
 * broke the one-line-per-line contract by coming up short: whatever it did not
 * translate keeps its ORIGINAL line, because a turn that silently disappears
 * from the translated document is worse than one that appears untranslated —
 * and nothing warned about it before. */
export function reconcileTranslatedBatch(
  batch: readonly string[],
  rawOutput: string,
): ReconciledBatch {
  const got = rawOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const translated = [...got];
  let untranslated = 0;
  if (got.length < batch.length) {
    untranslated = batch.length - got.length;
    translated.push(...batch.slice(got.length));
  }
  return { translated, untranslated };
}

export function buildTranslatedDocument(
  stem: string,
  language: string,
  translated: readonly string[],
  untranslated: number,
): string {
  const note =
    untranslated > 0
      ? ` ${untranslated} line(s) came back untranslated and are kept in the original ` +
        `language — translate the file again to retry them._`
      : "_";
  return (
    `# ${stem} — ${language}\n\n_Translated on this Mac from the recording's transcript.${note}\n\n` +
    `${translated.join("\n\n")}\n`
  );
}

export function translationLanguage(language: string): string {
  const trimmed = language.trim();
  if (trimmed === "") throw new Error("Pick a language first.");
  return trimmed;
}

export function translationGenerator(ctx: RecBridgeCtx): (prompt: string) => Promise<string> {
  const generate = ctx.deps.generate;
  if (generate === undefined) {
    throw new Error("The local AI (Ollama) isn't running — start it and try again.");
  }
  return generate;
}

export function transcriptLinesForTranslation(db: Database.Database, id: string): string[] {
  const lines = translatableLines(parseRecMeta(getRecMeta(db, id)));
  if (lines.length === 0) {
    throw new Error("No transcript to translate yet — record something first.");
  }
  return lines;
}

export function throwIfTranslationStopped(ctx: RecBridgeCtx, id: string): void {
  if (ctx.deps.isStopped?.(id) === true) {
    throw new Error("Stopped — no translated file was saved.");
  }
}

export type TranslatedBatches = { translated: string[]; untranslated: number };

export async function translatedBatches(
  ctx: RecBridgeCtx,
  id: string,
  language: string,
  lines: string[],
  generate: (prompt: string) => Promise<string>,
): Promise<TranslatedBatches> {
  const total = Math.ceil(lines.length / TRANSLATE_BATCH_SIZE);
  const translated: string[] = [];
  let untranslated = 0;
  for (let index = 0; index < total; index++) {
    throwIfTranslationStopped(ctx, id);
    ctx.deps.onTranslateProgress?.(id, index, total);
    const batch = lines.slice(index * TRANSLATE_BATCH_SIZE, (index + 1) * TRANSLATE_BATCH_SIZE);
    const result = reconcileTranslatedBatch(batch, stripThinkSpans(await generate(buildTranslatePrompt(language, batch))));
    translated.push(...result.translated);
    untranslated += result.untranslated;
  }
  ctx.deps.onTranslateProgress?.(id, total, total);
  return { translated, untranslated };
}

export function currentTranslationRoom(ctx: RecBridgeCtx, db: Database.Database): OpenRoom {
  const open = ctx.deps.currentRoom();
  if (open?.db !== db) {
    throw new Error("The room was closed or changed before the translated file could be saved.");
  }
  return open;
}

export async function saveTranslatedFile(
  db: Database.Database,
  room: OpenRoom,
  name: string,
  language: string,
  content: string,
): Promise<FileMeta> {
  const filename = `${trimEndMatches(name, ".wav")} — ${language}.md`;
  if (room.workspace === undefined) {
    return insertFile(db, filename, "text/markdown", Buffer.from(content, "utf8"), content, "generated");
  }
  const entry = await room.workspace.createFile(
    filename,
    Readable.from([Buffer.from(content, "utf8")]),
    "generated",
  );
  setFileExtractedText(db, entry.fileId, content);
  db.prepare("UPDATE files SET mime_type = 'text/markdown' WHERE id = ?").run(entry.fileId);
  return getFileMeta(db, entry.fileId);
}

export function notifyTranslatedFile(ctx: RecBridgeCtx, fileId: string): void {
  try {
    ctx.deps.onOpenFile?.(fileId);
  } catch {
    // A viewer that could not be told must not fail the completed translation.
  }
}

/**
 * Translate the whole transcript into any language on the LOCAL model, saved as
 * a sibling Markdown file with the timestamps and speakers kept (Whisper
 * *-turbo cannot translate, so the LLM does, batch by batch).
 *
 * Stoppable between batches, like Rust's: the Stop flag is keyed by the
 * recording's own file id, so `cancel_ask(fileId)` — and closing the room —
 * ends a translation that would otherwise hold the local model for many
 * minutes. The document is written only at the end, so stopping leaves no half
 * file behind.
 */
export async function recTranslate(
  db: Database.Database,
  ctx: RecBridgeCtx,
  id: string,
  language: string,
): Promise<FileMeta> {
  const lang = translationLanguage(language);
  const generate = translationGenerator(ctx);
  const name = getFileName(db, id);
  const lines = transcriptLinesForTranslation(db, id);
  const batches = await translatedBatches(ctx, id, lang, lines, generate);
  const stem = trimEndMatches(name, ".wav");
  const content = buildTranslatedDocument(stem, lang, batches.translated, batches.untranslated);
  const file = await saveTranslatedFile(db, currentTranslationRoom(ctx, db), name, lang, content);
  // Room map: this translation was made from THIS recording. The name says so
  // too, but a name is not evidence — renaming either file would leave the map
  // asserting a link it can no longer check.
  setDerivedFrom(db, file.id, id);
  ctx.deps.notifyFilesChanged?.();
  // …and OPEN it. A translation runs for minutes on the local model, so by the
  // time it lands the user is looking at something else; Rust ends this command
  // with `agent-open-file` for exactly that reason, and dropping it would turn
  // a finished job into a file nobody is told about.
  notifyTranslatedFile(ctx, file.id);
  return file;
}

// =============================================================================
// ---- lives elsewhere / not ported — see §7 ---------------------------------
// =============================================================================

/**
 * `rec_retranscribe` (recording_cmds.rs:383-517) — THE SEAM DEFAULT ONLY.
 *
 * The command itself is implemented, and not here:
 * `mediaTranscribeJob.ts::transcribeMediaWithSpeakers` stages the audio, drives
 * `POST /rec/retranscribe`, folds in any speaker name typed while the rebuild
 * ran, and writes `recordings.meta` and `files.extracted_text` together. That
 * is deliberately one lane shared with the import, download and clip paths
 * rather than a second copy living behind this signature — those four used to
 * be four different answers to "transcribe this file", and three of them
 * produced speakerless text.
 *
 * `recIpc.ts` dispatches `rec_retranscribe` as `live.retranscribe ?? this`, and
 * the live registry always supplies `live.retranscribe` (it is the one call
 * site that can hand the job a `RoomManagerState`). So reaching this body means
 * a context was built with no live wiring at all — a partial harness — and the
 * only honest answer is to say where the real one is rather than half-run a
 * pipeline with no room to write into.
 *
 * The guard set that goes with the command is real and lives above:
 * {@link beginRetranscribe} / {@link endRetranscribe} / {@link isRetranscribing},
 * claimed by the job and refused against by {@link recStart},
 * {@link recDeleteRange} and {@link recCorrectRange}.
 */
export async function recRetranscribe(
  _db: Database.Database,
  _ctx: RecBridgeCtx,
  _id: string,
): Promise<RecMeta> {
  throw new Error(
    "Re-transcribing is wired through mediaTranscribeJob.ts::transcribeMediaWithSpeakers, which needs the " +
      "room manager state this rec-bridge context does not carry. This build registered rec_retranscribe " +
      "without that wiring (recIpc.ts dispatches `live.retranscribe ?? recRetranscribe`), so nothing ran and " +
      "nothing was changed. The retranscribing guard set is still enforced by rec_start, rec_delete_range " +
      "and rec_correct_range.",
  );
}

/** `rec_read_start` (recording_cmds.rs:908-916), and the same job `rec_stop`
 * kicks off best-effort once a recording is durable. */
export async function recReadStart(
  _db: Database.Database,
  _ctx: RecBridgeCtx,
  _id: string,
): Promise<string> {
  throw new Error(
    '"Read this recording" is not available yet in this migration: it queues a background AI job ' +
      "(chapters/highlights/notes), and the `jobs` table's runner is a separate, unported subsystem.",
  );
}
