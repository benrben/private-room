/** Cohesive extraction from studiosCmds.ts; its public API remains on that module. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { Artifact, type Written } from "./artifactBuilder.js";
import {
  childOfRun,
  forget,
  guardCommit,
  remember,
  type CancelFlag,
  type CancelState,
  type GuardResult,
  type Node as CancelNode,
} from "./cancel.js";
import {
  fileNamesHint,
  findFileLike,
  getFileExtractedText,
  getFileName,
  listFiles,
  type FileMeta,
} from "./db-host/files.js";
import { titleFromName } from "./docsHtml.js";
import { byteLength } from "./extractionWindow.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { jsonStrField } from "./jsonTools.js";
import * as obs from "./obs.js";
import { chatStructured as chatStructuredReal } from "./ollamaGenerate.js";
import { bestLocalDefault, KEEP_ALIVE_WARM } from "./ollamaModels.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { clampBytes } from "./textClamp.js";
import { declaredFor } from "./capabilities.js";
import { isExternalEngine, ROLLBACK_BUSY } from "./turnContext.js";
import { isSummaryFile } from "./summarizeTools.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { readRoomFile } from "./workspace/roomContent.js";
// ============================================================================
// room access — this file's own minimal slice of the (not-yet-ported)
// AppState/Room, extended with the one field no other ported file has needed
// yet: the room's display NAME (gather_scope_text's whole-room scope reads
// `room.name`; every other ported runner only ever needed `db`/`path`).
// ============================================================================

/** `commands.rs::Room`, as much of it as this file's runners use. */
export interface RoomHandle {
  db: Database.Database;
  path: string;
  name: string;
  workspace?: WorkspaceService;
}

/** Mirrors `jobs.ts`'s own `RoomSource` (and is structurally compatible with
 * it), plus the same optional `rollingBack` probe `turnEngine.ts`'s
 * `TurnRoomSource` carries — `run_studio`'s own Wave-3 guard. */
export interface RoomSource {
  current(): RoomHandle | null;
  rollingBack?: () => boolean;
}

export const NO_ROOM_OPEN = "No room is open.";
/** Ported verbatim (both room-pin checkpoints in `run_studio_core` throw this
 * exact sentence). */
export const ROOM_CLOSED = "the room this job belongs to was closed";

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful room mutation, or a merely cosmetic progress step, into a
 * failed run. */
export type EmitFn = (event: string, payload: unknown) => void;

export function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = w.emit(...)`.
  }
}

/**
 * `docs_html.rs`'s `save_and_open`, duplicated (unexported where it already
 * lives, `chatCommandsKnowledge.ts` — see this module's own doc): commit a
 * fresh artifact, then tell the Files list to reload and the viewer to open
 * it.
 */
export async function saveAndOpen(rooms: RoomSource, emit: EmitFn | undefined, art: Artifact): Promise<Written> {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const written = room.workspace === undefined
    ? art.commit(room.db)
    : await art.commitToWorkspace(room.workspace);
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "agent-open-file", { id: written.meta.id });
  return written;
}

// `is_summary_file` (commands/summarize.rs) is now REAL, ported verbatim and
// exported by the concurrent `summarize.rs` batch (`summarizeTools.ts`) —
// imported above rather than duplicated a second time.

// ============================================================================
// gather_scope_text / gather_files_text
// ============================================================================

/**
 * Gather the text a studio command works over. `scope` = a file id (that one
 * file) or `null` (a slice of the whole room). Ported verbatim from
 * `gather_scope_text`.
 */
export function gatherScopeText(
  db: Database.Database,
  scope: string | null,
  roomName: string
): [label: string, text: string] {
  if (scope === null) {
    return gatherRoomScopeText(db, roomName);
  }
  return gatherOneFileScopeText(db, scope);
}

export function gatherOneFileScopeText(db: Database.Database, scope: string): [label: string, text: string] {
  const name = getFileName(db, scope); // throws when the id names nothing, matching `?`
  const text = getFileExtractedText(db, scope) ?? "";
  if (text.trim() === "") {
    throw new Error(`"${name}" has no readable text to work with.`);
  }
  return [titleFromName(name), clampBytes(text, 12_000)];
}

export function appendRoomScopeFile(db: Database.Database, blob: string, file: FileMeta): string | null {
  if (isSummaryFile(file.name, file.source)) {
    return blob;
  }
  if (byteLength(blob) >= 12_000) {
    return null;
  }
  const text = getFileExtractedText(db, file.id);
  if (text === null || text.trim() === "") {
    return blob;
  }
  return blob + `## ${file.name}\n${clampBytes(text, 1500)}\n\n`;
}

export function gatherRoomScopeText(db: Database.Database, roomName: string): [label: string, text: string] {
  let blob = "";
  for (const file of listFiles(db)) {
    const next = appendRoomScopeFile(db, blob, file);
    if (next === null) {
      break;
    }
    blob = next;
  }
  if (blob.trim() === "") {
    throw new Error("This room has no readable text to work with yet.");
  }
  return [roomName, blob];
}

/**
 * Gather readable text from an explicit set of file ids — the files/folders
 * the user @-mentioned in the Studio prompt. Ported verbatim from
 * `gather_files_text`.
 */
export function gatherFilesText(
  db: Database.Database,
  fileIds: readonly string[]
): [label: string, text: string] {
  let blob = "";
  const names: string[] = [];
  for (const id of fileIds) {
    const file = readableStudioFile(db, id);
    if (file === null) {
      continue;
    }
    if (byteLength(blob) >= 12_000) {
      break;
    }
    blob += `## ${file.name}\n${clampBytes(file.text, 3000)}\n\n`;
    names.push(titleFromName(file.name));
  }
  if (blob.trim() === "") {
    throw new Error("The files you mentioned have no readable text to work with.");
  }
  const label = names.length === 1 ? names[0]! : `${names.length} files`;
  return [label, blob];
}

export interface ReadableStudioFile {
  name: string;
  text: string;
}

export function readableStudioFile(db: Database.Database, id: string): ReadableStudioFile | null {
  try {
    const name = getFileName(db, id);
    const text = getFileExtractedText(db, id);
    return text === null || text.trim() === "" ? null : { name, text };
  } catch {
    return null;
  }
}

// ============================================================================
// safe_scope_name / fill_template
// ============================================================================

export const SCOPE_NAME_FOLD_CHARS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|", "\n", "\r", "\t"]);

/** Rust's `str::split_whitespace()`: splits on runs of Unicode whitespace,
 * yields no empty tokens. Local copy — `chatCommandsGenerate.ts` carries an
 * identical, unexported one for the same reason. */
export function splitWhitespaceUnicode(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

/** Fold a scope label into a file-name-safe fragment (no path/reserved
 * chars). Ported verbatim from `safe_scope_name`. `.take(60)` is CODE POINTS
 * (`chars()`), so truncation goes through `Array.from` rather than a UTF-16
 * `.slice()`, which would cut a surrogate pair in half. */
export function safeScopeName(label: string): string {
  const folded = Array.from(label)
    .map((c) => (SCOPE_NAME_FOLD_CHARS.has(c) ? " " : c))
    .join("");
  const cleaned = splitWhitespaceUnicode(folded).join(" ");
  const name = Array.from(cleaned).slice(0, 60).join("").trim();
  return name === "" ? "room" : name;
}

/**
 * Fill a built-in page template's `__SLOT__` placeholders in ONE
 * left-to-right pass — never rescanning substituted text (see the Rust
 * source's own doc: a file named `__CARDS__`, pasted in as the title by an
 * earlier slot, used to have the later slot's whole deck spliced into its own
 * `<title>` under chained `.replace()` calls). Ported verbatim from
 * `fill_template`. Ties (two slots' keys starting at the same position)
 * favor whichever slot appears EARLIER in `slots`, matching Rust's
 * `min_by_key`, which returns the first minimal element.
 */
export function fillTemplate(template: string, slots: ReadonlyArray<readonly [string, string]>): string {
  let out = "";
  let rest = template;
  for (;;) {
    const match = earliestTemplateSlot(rest, slots);
    if (match === null) {
      out += rest;
      return out;
    }
    out += rest.slice(0, match.at);
    out += match.value;
    rest = rest.slice(match.at + match.key.length);
  }
}

export interface TemplateSlotMatch {
  at: number;
  key: string;
  value: string;
}

export function earliestTemplateSlot(
  text: string,
  slots: ReadonlyArray<readonly [string, string]>
): TemplateSlotMatch | null {
  let match: TemplateSlotMatch | null = null;
  for (const [key, value] of slots) {
    const at = text.indexOf(key);
    if (at !== -1 && (match === null || at < match.at)) {
      match = { at, key, value };
    }
  }
  return match;
}
