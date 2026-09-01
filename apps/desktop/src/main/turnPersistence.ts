import type Database from "better-sqlite3-multiple-ciphers";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { availableName, insertFile, type FileMeta } from "./db-host/files.js";
import { createRoomFile } from "./workspace/roomContent.js";
import { insertMessage, type Message } from "./db-host/messages.js";
import { RoomPin, type RoomPinSource } from "./roomPin.js";



// ------------------------------------------------------------- room access

/** The open room as one read: its live connection and its path. Re-read
 * whenever the CURRENT state is needed, mirroring `state.room.lock()` —
 * which returns whatever is open NOW, not what was open when the turn began.
 * That difference is the whole reason {@link RoomPin} exists. */
export interface OpenRoom {
  db: Database.Database;
  path: string;
  workspace?: WorkspaceService;
}


/**
 * The slice of the (not-yet-ported) `AppState` a turn needs: {@link RoomPinSource}'s
 * epoch/path pair, plus the currently open room's connection. A future
 * host-state batch should implement this (or adapt to it) rather than
 * inventing a second notion of "which room, which connection".
 *
 * `currentRoomPath()` (from `RoomPinSource`) and `currentRoom()!.path` must
 * always agree — implement the former in terms of the latter.
 */
export interface TurnRoomSource extends RoomPinSource {
  /** The currently open room, or `null` when none is open. */
  currentRoom(): OpenRoom | null;
  /** `state.rolling_back()` — a DB rollback is swapping the file out, so no
   * new turn may start (Wave 3, Idea 9). Default: not rolling back. */
  rollingBack?: () => boolean;
}


// ------------------------------------------------------ persist the reply

/** As {@link persistAssistantReplyPinned} with no pin — write into whatever
 * room is open now. Ported from `persist_assistant_reply`; kept for parity
 * with the Rust source's own two-function shape. */
export function persistAssistantReply(
  room: TurnRoomSource,
  chatId: string,
  content: string,
  sources: readonly string[],
  effectsValue: Record<string, unknown> | null
): Message {
  return persistAssistantReplyPinned(room, null, chatId, content, sources, effectsValue);
}


/**
 * Phase 3: save the assistant's reply — ONLY if the room open right now is
 * still the exact (path, epoch) this turn was pinned to at its start. Ported
 * from `persist_assistant_reply_pinned`.
 *
 * A refusal is quiet by design: HLT-7 — a room locked mid-answer is already
 * closed, and "No room is open" as an error toast tells the user nothing they
 * can act on, so the message comes back unsaved, in memory, for the caller to
 * show. A pin MISMATCH takes the same quiet path for a stronger reason: a call
 * that blocked longer than it took the user to open a second `.roomai` would
 * otherwise write this turn's text, sources and effects into the NEW room's
 * encrypted database, keyed by a chat id that exists only in the old one.
 *
 * Read order mirrors the Rust source: `roomEpoch()` before the room itself
 * (`state.room_epoch()` then `state.room.lock()`).
 */
export function persistAssistantReplyPinned(
  room: TurnRoomSource,
  pin: RoomPin | null,
  chatId: string,
  content: string,
  sources: readonly string[],
  effectsValue: Record<string, unknown> | null
): Message {
  const epoch = room.roomEpoch();
  const open = room.currentRoom();
  if (open !== null && (pin === null || pin.holds(epoch, open.path))) {
    return insertMessage(open.db, chatId, "assistant", content, sources, effectsValue);
  }
  return {
    id: "",
    role: "assistant",
    content,
    sources: [...sources],
    createdAt: "",
    effects: effectsValue,
    kind: null,
  };
}
export

// -------------------------------------------------------- save_generated

/** `extraction::extension_of` — a `std::path::Path` extension: none for a
 * dotfile or a name with no dot, lower-cased. */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}
export

/** A small, honest substitute for the `mime_guess` crate: real for every
 * extension a generated note/script/data file actually uses, and defaulting to
 * `text/plain` exactly as `mime_guess::from_path(..).first_or(TEXT_PLAIN)`
 * does for anything it has no entry for either. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  py: "text/x-python",
  js: "text/javascript",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};
export

/** `MIME_BY_EXT[extensionOf(name)] ?? "text/plain"`, own-property-guarded —
 * see `docsHtml.ts`'s `noteMime` for the bug this pattern fixes.
 * `requestedName` (this function's only caller passes the USER'S typed "save
 * that as …" text straight through) can carry an extension of
 * `constructor`/`__proto__`/…, which reads `Object`/`Object.prototype` off
 * the plain `{}` literal above rather than `undefined`; `?? "text/plain"`
 * never fires for a non-nullish value, and a non-string mime reaching
 * `insertFile` dies inside better-sqlite3 instead of falling back like
 * `mime_guess::from_path` (no prototype chain to leak) does in Rust. */
function mimeFor(name: string): string {
  const ext = extensionOf(name);
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext) ? (MIME_BY_EXT[ext] as string) : "text/plain";
}


/**
 * `files.rs::save_generated_impl`, DB half: insert freshly authored text as a
 * new room file, defaulting to `.md` when the requested name carries no
 * extension.
 *
 * NOT PORTED: the Rust source then emits `"room-files-changed"` so an open
 * Scripts/Library view re-indexes. That is a broadcast to every window, with
 * no equivalent wired up in this migration — {@link ask} takes it as the
 * optional `notifyFilesChanged` dep instead, swallowing failures the way
 * Rust's `let _ = app.emit(...)` does.
 */
export function saveGeneratedFile(db: Database.Database, requestedName: string, content: string): FileMeta {
  const name = extensionOf(requestedName) === "" ? `${requestedName}.md` : requestedName;
  return insertFile(db, name, mimeFor(name), Buffer.from(content, "utf8"), content, "generated");
}


export async function saveGeneratedFileInRoom(
  room: OpenRoom,
  requestedName: string,
  content: string,
): Promise<FileMeta> {
  if (room.workspace === undefined) return saveGeneratedFile(room.db, requestedName, content);
  const requested = extensionOf(requestedName) === "" ? `${requestedName}.md` : requestedName;
  const name = availableName(room.db, requested);
  return createRoomFile(
    room,
    name,
    mimeFor(name),
    Buffer.from(content, "utf8"),
    content,
    "generated",
  );
}
