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
import { RecBridgeCtx } from "./recBridgeState.js";
// =============================================================================
// ---- control-POST helper ----------------------------------------------------
// =============================================================================

/** A non-2xx control response, carrying the sidecar's own `code` so a caller
 * can branch on it without parsing English. */
export class RecControlError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RecControlError";
    this.code = code;
  }
}

export async function postControl(
  ctx: RecBridgeCtx,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const { status, json } = await ctx.deps.sidecarPost(path, body);
  const obj = controlResponseObject(json);
  if (successfulStatus(status)) return obj ?? {};
  throw new RecControlError(
    controlErrorMessage(obj, status),
    controlErrorCode(obj),
  );
}

export function controlResponseObject(json: unknown): Record<string, unknown> | null {
  return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
}

export function successfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function controlErrorMessage(obj: Record<string, unknown> | null, status: number): string {
  if (obj !== null && typeof obj.error === "string") return obj.error;
  return `The room's engine could not complete this request (HTTP ${status}).`;
}

export function controlErrorCode(obj: Record<string, unknown> | null): string {
  if (obj !== null && typeof obj.code === "string") return obj.code;
  return "REC_CONTROL_FAILED";
}

export function requireLive(ctx: RecBridgeCtx): string {
  if (ctx.state.liveFileId === null) {
    throw new Error("No live recording.");
  }
  return ctx.state.liveFileId;
}

// =============================================================================
// ---- meta parsing (recording_cmds.rs:125-136) -------------------------------
// =============================================================================

export function unreadableMeta(detail: string): Error {
  return new Error(
    `This recording's transcript data can't be read (${detail}). ` +
      "Its audio is intact — use History to restore an earlier version, " +
      "or rebuild the transcript from the audio.",
  );
}

/**
 * A file's recording metadata. No row at all is a plain audio file (or a
 * brand-new recording) — an empty meta is the honest answer. A row that cannot
 * be READ is something else entirely, and used to look identical: callers saw
 * an empty transcript, and Resume then wrote that emptiness over the stored one
 * with no version snapshot to undo it. So it is an error.
 */
export function parseRecMeta(json: string | null): RecMeta {
  if (json === null) {
    return defaultRecMeta();
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw unreadableMeta(err instanceof Error ? err.message : String(err));
  }
  try {
    return coerceRecMeta(value);
  } catch (err) {
    throw unreadableMeta(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Shape-check a parsed JSON value into a `RecMeta`.
 *
 * `durationCs`/`segments`/`cuts` are REQUIRED and type-checked because Rust's
 * struct carries no `#[serde(default)]` on those three — `serde_json::from_str`
 * fails outright without them, which is exactly the failure `parse_meta` exists
 * to surface. Every other field IS `#[serde(default)]` there and is defaulted
 * the same way here. `JSON.parse(…) as RecMeta` would instead accept `123` or
 * `{"foo":1}` and hand back an object whose `.segments` is `undefined`, turning
 * a readable error into a TypeError three call frames later.
 *
 * Also the shape `/rec/edit_meta` and `/rec/stop` return `meta` in (an
 * already-parsed object rather than a JSON string).
 */
export function coerceRecMeta(value: unknown): RecMeta {
  const record = recMetaRecord(value);
  return {
    durationCs: requiredNumber(record, "durationCs"),
    segments: requiredArray<RecSegment>(record, "segments"),
    cuts: requiredArray<RecCut>(record, "cuts"),
    maxSpeakers: defaultNumber(record.maxSpeakers, 0),
    speakerNames: defaultSpeakerNames(record.speakerNames),
    recognized: defaultArray<string>(record.recognized),
    chapters: defaultArray<RecMeta["chapters"][number]>(record.chapters),
    highlights: defaultArray<RecMeta["highlights"][number]>(record.highlights),
    notes: defaultArray<RecMeta["notes"][number]>(record.notes),
    readOf: defaultReadOf(record.readOf),
  };
}

export function recMetaRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

export function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`"${key}" must be a number`);
  return value;
}

export function requiredArray<T>(record: Record<string, unknown>, key: string): T[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`"${key}" must be an array`);
  return value as T[];
}

export function defaultNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export function defaultArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function defaultRecord<T>(value: unknown): Record<string, T> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, T>;
}

export function defaultSpeakerNames(value: unknown): Record<string, string> {
  return defaultRecord<string>(value) ?? {};
}

export function defaultReadOf(value: unknown): RecMeta["readOf"] {
  if (typeof value !== "object" || value === null) return null;
  return value as RecMeta["readOf"];
}
