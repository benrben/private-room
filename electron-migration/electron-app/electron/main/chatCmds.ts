/**
 * Chat lifecycle + paste-import: `list_chats`/`create_chat`/`delete_chat`/
 * `get_messages`/`rename_chat`/`delete_message`/`import_image_bytes`/
 * `import_audio_bytes`. Ported from `src-tauri/src/commands/chat.rs` (131
 * lines, read in full, including its `#[cfg(test)] mod tests`).
 *
 * NAMING TRAP, RESOLVED AGAINST THE REAL SOURCE RATHER THAN ASSUMED: this is
 * `commands/chat.rs` — Tauri's OWN meaning of "commands" (an IPC handler the
 * renderer invokes) — not the "#command" hash-command chat FEATURE the
 * project memory describes. That feature is `commands/chat_commands.rs` (785
 * lines) plus `commands/chat_commands/{generate,knowledge}.rs`, a separate,
 * much larger, still-unported module this file does not touch. Reading
 * `chat.rs` end to end confirms it: eight small CRUD/import commands over
 * `db::*`, no `#`-prefix parsing, no dispatch table, nothing that reads a
 * command's "whole source". A plausible-sounding assumption from the task
 * brief turned out to be exactly wrong; this doc records that so a future
 * reader does not repeat the mistake.
 *
 * NO EXEC_TOOL ARM: grepping `agent.rs`'s `exec_tool` match arms (and this
 * migration's `execTool.ts`/`toolSpecs.ts`/`toolSchema.ts`) for all eight
 * command names — `list_chats`, `create_chat`, `delete_chat`, `get_messages`,
 * `rename_chat`, `delete_message`, `import_image_bytes`, `import_audio_bytes`
 * — finds NONE of them anywhere. All eight are registered only in `lib.rs`'s
 * `tauri::generate_handler!` list (verified). These are typed by a human
 * clicking around the chat UI — never called by the model — so this file adds
 * no `execTool.ts` arm.
 *
 * WHAT THIS FILE IS: the thin `#[tauri::command]` layer this port's house
 * style already establishes (`recIpc.ts`, `roomCheckpoints.ts`,
 * `storyTools.ts`) — plain functions taking a {@link RoomManagerState}
 * directly, throwing a plain `Error` where the Rust source returns
 * `Err(String)`, plus a {@link registerChatIpc} at the bottom that is NOT
 * wired into any bootstrap file (rule 4) — tested by invoking the captured
 * handlers directly, the same posture as every sibling `register*Ipc`.
 * Channel names and argument shapes match `electron/shared/ipc-contract.ts`
 * (`list_chats`…`import_audio_bytes`, already declared there from
 * `src/api.ts`), so a future preload/renderer batch needs no renaming.
 *
 * `AppState::with_room` — the room guard plus `humanize_storage_error` on
 * whatever the closure throws — is reused as {@link withRoom} below, over the
 * real {@link RoomManagerState}/{@link Room}/{@link humanizeStorageError}
 * `roomManager.ts` already ports, the same seam `roomCheckpoints.ts`'s own
 * `createCheckpointCore` wraps its one `with_room` call in. Every one of
 * `chat.rs`'s eight commands calls `state.with_room(...)`, so all eight go
 * through it here (verified against `commands.rs`'s own `with_room`
 * definition, not assumed).
 *
 * TWO ORDER-OF-CHECKS DETAILS THAT ARE EASY TO FLATTEN BY ACCIDENT, so it is
 * worth being explicit that {@link importImageBytes} and
 * {@link importAudioBytes} DELIBERATELY do not share one shape:
 *   - `import_image_bytes` decodes its base64 INSIDE the `with_room` closure
 *     — a room that is not open is reported as "No room is open.", never a
 *     decode error, even for garbage input.
 *   - `import_audio_bytes` decodes its base64 BEFORE calling `with_room` —
 *     a decode failure is reported as such even with no room open. It also
 *     reads `state.room_epoch()` AFTER `with_room` returns, not before —
 *     the epoch the STT queue entry is pinned to is the one in effect right
 *     after the insert, matching the Rust source's own statement order.
 *
 * ONE UNPORTED DEPENDENCY (rule 3 — honest refusal, not a fabricated result):
 * `enqueue_stt` (`commands/files.rs`'s `STT_TX` mpsc channel + `run_stt_job`,
 * the background OCR/STT worker lane) has no Electron port anywhere in this
 * migration yet. Its Rust call site is `-> ()`, fire-and-forget, and its own
 * one failure mode (the channel `send` erroring) is already swallowed there
 * — `import_audio_bytes` returns `Ok(meta)` regardless of whether the queue
 * accepted the job. {@link enqueueSttNotImplemented} mirrors that shape
 * exactly the way `roomManager.ts`'s own `spawnRoomServerIfEnabledNotImplemented`
 * does for its D9 gap: it LOGS (never throws), so a paste/import still
 * succeeds and returns a real, persisted `FileMeta` — only the automatic
 * background transcription that would normally follow does not run. A real
 * implementation slots in later via {@link ChatCmdsDeps.enqueueStt}.
 *
 * `extensionOf` and the two MIME lookup tables below are local copies/
 * substitutes for `extraction::extension_of` and the `mime_guess` crate —
 * the same "no shared `extraction.ts` yet, so every file that needs the tiny
 * extension helper carries its own copy" choice `turnEngine.ts`, `organize.ts`,
 * `docsHtml.ts`, `organizeTools.ts` and `textUtil.ts` already made (see any of
 * their module docs). Unlike `check_paste_size` (which chat.rs's own test
 * module exercises byte-for-byte below), NEITHER mime table is covered by any
 * Rust test — the fallback `mime_guess` branches in `import_image_bytes` and
 * `import_audio_bytes` are reached only for extensions outside each
 * function's few explicit cases, so these are honest, reasonably-scoped
 * approximations of the crate's well-known entries, not verified byte-for-
 * byte. Only the parts a real Rust test *does* cover (`check_paste_size`, and
 * `import_audio_bytes`'s explicit `"m4a" | "mp4"` / `"webm"` overrides, copied
 * verbatim) are held to that bar.
 *
 * `decodeBase64Strict` is a third local copy of the strict base64 decoder
 * `externalAdvisor.ts` and `skillsCmds.ts` each already carry (see either
 * one's doc for why `Buffer.from(s, "base64")` alone is unsafe here — it is
 * lenient and never throws, which would turn a corrupt paste into a corrupt
 * file silently written into the room).
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createChat as dbCreateChat, deleteChat as dbDeleteChat, listChats as dbListChats, renameChat as dbRenameChat, type Chat } from "./db-host/chats.js";
import { availableName, insertFile, type FileMeta } from "./db-host/files.js";
import { deleteMessage as dbDeleteMessage, listMessages as dbListMessages, type Message } from "./db-host/messages.js";
import { humanizeStorageError, NO_ROOM_OPEN, type Room, type RoomManagerState } from "./roomManager.js";
import { MAX_DOWNLOAD_BYTES } from "./web.js";
import { createRoomFile } from "./workspace/roomContent.js";

// ============================================================================
// with_room
// ============================================================================

function requireRoom(state: RoomManagerState): Room {
  if (state.room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return state.room;
}

/** `AppState::with_room` — see this file's module doc. */
function withRoom<T>(state: RoomManagerState, f: (room: Room) => T): T {
  const room = requireRoom(state);
  try {
    return f(room);
  } catch (err) {
    throw humanizeStorageError(err, room.path);
  }
}

// ============================================================================
// check_paste_size
// ============================================================================

/**
 * D15: a pasted image or voice note is held in memory whole and stored as one
 * SQLite blob, exactly like a file added by link — so it gets the same
 * ceiling instead of no ceiling at all. Measured on the BASE64 (4 chars per 3
 * bytes) so an oversized paste is refused before it is decoded into a second
 * copy. Ported from `check_paste_size`; throws instead of returning
 * `Result<(), String>` (this port's house style — see `util.ts`'s "errors,
 * not `Result`" note).
 *
 * `b64Len` is a JS string's `.length` (UTF-16 code units), not Rust's `str::len`
 * (UTF-8 bytes) — the two agree exactly for the ASCII-only alphabet a real
 * base64 payload is made of, which is the only input this is ever measured
 * against.
 */
export function checkPasteSize(b64Len: number, displayName: string): void {
  const size = Math.floor(b64Len / 4) * 3;
  if (size > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `${displayName} is ${Math.floor(size / (1024 * 1024))} MB — larger than the ` +
        `${Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB limit for a room file.`
    );
  }
}

// ============================================================================
// small local substitutes — see module doc
// ============================================================================

/** `extraction::extension_of` — a `std::path::Path` extension: none for a
 * dotfile or a name with no dot, lower-cased. Local copy; see module doc. */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

/** `base64::engine::general_purpose::STANDARD.decode` — strict: standard
 * alphabet, canonical padding, no whitespace or newlines. See module doc for
 * why Node's own lenient `Buffer.from(s, "base64")` is unsafe used alone. */
function decodeBase64Strict(s: string): Buffer | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    return null;
  }
  return Buffer.from(s, "base64");
}

/** `obj[key]` on a plain `{}` literal is not safe when `key` comes from a
 * file NAME (room- or model-adjacent input): `table["__proto__"]` resolves
 * the object's OWN prototype rather than `undefined`, which `?? fallback`
 * then never catches — a non-string value would reach `db::insert_file`'s
 * `mime` column. Same `hasOwnProperty`-guarded read `jsonTools.ts`'s
 * `ownValue`, `privacy.ts`, and `workflowCompose.ts` already use for exactly
 * this reason (this app has shipped `Object.prototype` pollution twice —
 * `mcpConfig.ts`, `privacyRedact.ts` — per `jsonTools.ts`'s own doc). */
function tableGet(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** `mime_guess::from_path(&name).first_or(mime_guess::mime::IMAGE_PNG)
 * .essence_str()` — a narrow substitute scoped to what a pasted screenshot
 * plausibly is (ADD-8's only caller, {@link importImageBytes}). The default
 * ("image/png") is copied verbatim from the Rust source's own fallback; see
 * module doc for why the table itself is an honest approximation, not a
 * verified one. */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  ico: "image/x-icon",
};

function guessImageMime(name: string): string {
  return tableGet(IMAGE_MIME_BY_EXT, extensionOf(name)) ?? "image/png";
}

/** `mime_guess::from_path(&name).first_raw().unwrap_or("audio/mp4")` — the
 * FALLBACK arm only. `import_audio_bytes`'s own `"m4a" | "mp4"` / `"webm"`
 * overrides are ported verbatim in {@link audioMimeFor} and never reach this
 * table. Default copied verbatim from the Rust source's own `unwrap_or`; see
 * module doc for why the table itself is an honest approximation. */
const AUDIO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/x-wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/x-flac",
  aac: "audio/aac",
  opus: "audio/opus",
  amr: "audio/amr",
  caf: "audio/x-caf",
  aiff: "audio/x-aiff",
  aif: "audio/x-aiff",
};

/** ADD-18: store a mime WKWebView will play back — AAC-in-MP4/M4A and WebM
 * get their exact literal values (ported verbatim, matching the Rust
 * source's own comment: guessers label `.m4a` "audio/m4a", which `<audio>`
 * silently refuses). Everything else falls back to a `mime_guess` guess. */
function audioMimeFor(ext: string, name: string): string {
  if (ext === "m4a" || ext === "mp4") {
    return "audio/mp4";
  }
  if (ext === "webm") {
    return "audio/webm";
  }
  return tableGet(AUDIO_MIME_BY_EXT, extensionOf(name)) ?? "audio/mp4";
}

// ============================================================================
// enqueue_stt — NOT PORTED (rule 3)
// ============================================================================

/** `commands/files.rs::JobMeta` — the STT/OCR worker lane's queue entry.
 * Field names camelCased to match this migration's convention
 * (`room_path`→`roomPath`); `mime`/`ext` travel alongside `name` because the
 * worker branches on them without re-deriving from it. */
export interface JobMeta {
  id: string;
  name: string;
  mime: string;
  ext: string;
  roomPath: string;
  /** Wave 3 (Idea 9): the room epoch at enqueue — see module doc. */
  epoch: number;
}

export type EnqueueStt = (job: JobMeta) => void;

export const STT_ENQUEUE_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: enqueue_stt — the OCR/STT worker lane " +
  "(src-tauri/src/commands/files.rs's STT_TX mpsc channel + run_stt_job) has " +
  "no Electron port yet. The recording is still stored as a real room file " +
  "(import_audio_bytes's own db::insert_file half is fully ported); only the " +
  "automatic background transcription Rust queues right after that does not " +
  "run in this build.";

/** The ready-made default for {@link ChatCmdsDeps.enqueueStt} — see module
 * doc for why this logs rather than throws. */
export const enqueueSttNotImplemented: EnqueueStt = (_job) => {
  console.error(STT_ENQUEUE_NOT_IMPLEMENTED);
};

/** The one dependency `chat.rs`'s commands need beyond {@link RoomManagerState}. */
export interface ChatCmdsDeps {
  enqueueStt?: EnqueueStt;
}

// ============================================================================
// list_chats / create_chat / delete_chat / get_messages / rename_chat /
// delete_message
// ============================================================================

export function listChats(state: RoomManagerState): Chat[] {
  return withRoom(state, (room) => dbListChats(room.conn));
}

export function createChat(state: RoomManagerState): Chat {
  return withRoom(state, (room) => dbCreateChat(room.conn));
}

export function deleteChat(state: RoomManagerState, id: string): void {
  withRoom(state, (room) => dbDeleteChat(room.conn, id));
}

export function getMessages(state: RoomManagerState, chatId: string): Message[] {
  return withRoom(state, (room) => dbListMessages(room.conn, chatId));
}

/** ADD-9: give a chat an explicit title (persists in the room file). */
export function renameChat(state: RoomManagerState, id: string, title: string): void {
  withRoom(state, (room) => dbRenameChat(room.conn, id, title));
}

/** ADD-9: delete one message — regenerate drops the last assistant reply,
 * then re-runs `ask` with the previous user question. */
export function deleteMessage(state: RoomManagerState, id: string): void {
  withRoom(state, (room) => dbDeleteMessage(room.conn, id));
}

// ============================================================================
// import_image_bytes / import_audio_bytes
// ============================================================================

/** ADD-8: import a pasted screenshot. Base64-decode, then go through the
 * same insert/index path any uploaded file uses (source "upload"). The
 * decode happens INSIDE `with_room` — see module doc's order-of-checks note. */
export function importImageBytes(state: RoomManagerState, name: string, b64: string): FileMeta {
  checkPasteSize(b64.length, name);
  return withRoom(state, (room) => {
    const bytes = decodeBase64Strict(b64);
    if (bytes === null) {
      throw new Error(`Could not read the pasted image: not valid base64.`);
    }
    return insertFile(room.conn, name, guessImageMime(name), bytes, null, "upload");
  });
}

/** Folder-room form used by live IPC. The sealed-room function above remains
 * synchronous for compatibility with its direct callers and tests. */
export async function importImageBytesHybrid(
  state: RoomManagerState,
  name: string,
  b64: string,
): Promise<FileMeta> {
  checkPasteSize(b64.length, name);
  const room = requireRoom(state);
  if (room.workspace === undefined) return importImageBytes(state, name, b64);
  const bytes = decodeBase64Strict(b64);
  if (bytes === null) throw new Error("Could not read the pasted image: not valid base64.");
  try {
    return await createRoomFile(
      { db: room.conn, path: room.path },
      availableName(room.conn, name),
      guessImageMime(name),
      bytes,
      null,
      "upload",
    );
  } catch (error) {
    throw humanizeStorageError(error, room.path);
  }
}

/** ADD-18: store a voice note recorded inside the room, then transcribe it in
 * the background exactly like an imported recording — the room ends up with
 * BOTH the audio file and its searchable timestamped transcript (once
 * {@link ChatCmdsDeps.enqueueStt} has a real implementation; see module doc).
 * The decode happens BEFORE `with_room`, and the epoch is read AFTER it
 * returns — see module doc's order-of-checks note; both are load-bearing,
 * not incidental. */
export function importAudioBytes(
  state: RoomManagerState,
  deps: ChatCmdsDeps,
  name: string,
  b64: string
): FileMeta {
  checkPasteSize(b64.length, name);
  const bytes = decodeBase64Strict(b64);
  if (bytes === null) {
    throw new Error(`Could not read the recording: not valid base64.`);
  }
  const ext = extensionOf(name);
  const mime = audioMimeFor(ext, name);
  const { meta, roomPath } = withRoom(state, (room) => ({
    meta: insertFile(room.conn, name, mime, bytes, null, "upload"),
    roomPath: room.path,
  }));
  const epoch = state.roomEpoch;
  const enqueueStt = deps.enqueueStt ?? enqueueSttNotImplemented;
  enqueueStt({ id: meta.id, name, mime, ext, roomPath, epoch });
  return meta;
}

export async function importAudioBytesHybrid(
  state: RoomManagerState,
  deps: ChatCmdsDeps,
  name: string,
  b64: string,
): Promise<FileMeta> {
  checkPasteSize(b64.length, name);
  const bytes = decodeBase64Strict(b64);
  if (bytes === null) throw new Error("Could not read the recording: not valid base64.");
  const room = requireRoom(state);
  if (room.workspace === undefined) return importAudioBytes(state, deps, name, b64);
  const ext = extensionOf(name);
  const mime = audioMimeFor(ext, name);
  let meta: FileMeta;
  try {
    meta = await createRoomFile(
      { db: room.conn, path: room.path },
      availableName(room.conn, name),
      mime,
      bytes,
      null,
      "upload",
    );
  } catch (error) {
    throw humanizeStorageError(error, room.path);
  }
  const enqueueStt = deps.enqueueStt ?? enqueueSttNotImplemented;
  enqueueStt({ id: meta.id, name: meta.name, mime, ext, roomPath: room.path, epoch: state.roomEpoch });
  return meta;
}

// ============================================================================
// IPC registration — NOT wired into any bootstrap file (rule 4)
// ============================================================================

/** Register every `chat.rs` command channel on `ipcMain`, closing over the
 * SAME {@link RoomManagerState} `roomManagerIpc.ts`/`roomCheckpoints.ts`
 * register their own commands against — one open room for the whole process.
 * Every handler is THIN: nothing but argument forwarding, exactly as
 * `recIpc.ts`'s own module doc describes for its handlers. `ipcMain` is a
 * parameter typed against the real `electron` module without importing it at
 * runtime, so this file resolves under plain Node/vitest like every sibling
 * `register*Ipc`. */
export function registerChatIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: ChatCmdsDeps = {}
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("list_chats", (): Chat[] => listChats(state));
  handle("create_chat", (): Chat => createChat(state));
  handle("delete_chat", (args: { id: string }): void => deleteChat(state, args.id));
  handle("get_messages", (args: { chatId: string }): Message[] => getMessages(state, args.chatId));
  handle("rename_chat", (args: { id: string; title: string }): void =>
    renameChat(state, args.id, args.title)
  );
  handle("delete_message", (args: { id: string }): void => deleteMessage(state, args.id));
  handle("import_image_bytes", (args: { name: string; b64: string }): Promise<FileMeta> =>
    importImageBytesHybrid(state, args.name, args.b64)
  );
  handle("import_audio_bytes", (args: { name: string; b64: string }): Promise<FileMeta> =>
    importAudioBytesHybrid(state, deps, args.name, args.b64)
  );
}
