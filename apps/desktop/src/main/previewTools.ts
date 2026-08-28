/**
 * Port of `src-tauri/src/commands/preview.rs` (47 lines, read in full) — the
 * `quicklook_preview` command that asks macOS to draw a page image for a room
 * file this app cannot render itself: `.key`, `.pages`, `.numbers`, legacy
 * `.doc`/`.ppt`, RAW photos, PSD, 3D models — the long tail with a Quick Look
 * extension installed on this Mac. Rust:
 *
 * ```rust
 * pub async fn quicklook_preview(app: tauri::AppHandle, id: String)
 *     -> Result<Option<QuickLookPreview>, String> {
 *     let (name, bytes) = {
 *         let state = app.state::<AppState>();
 *         let guard = state.room.lock().unwrap();
 *         let room = guard.as_ref().ok_or("No room is open.")?;
 *         let (name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
 *         (name, bytes.unwrap_or_default())
 *     };
 *     if bytes.is_empty() { return Ok(None); }
 *     let png = tauri::async_runtime::spawn_blocking(move ||
 *         crate::quicklook::preview_png(&name, &bytes)).await
 *         .map_err(|e| format!("The preview could not be drawn: {e}"))?;
 *     Ok(png.map(|png| QuickLookPreview { png_b64: base64::...encode(png) }))
 * }
 * ```
 *
 * `Ok(None)` is a NORMAL answer here, not a failure: "this Mac can't preview
 * it either" is what the viewer shows in place of an error banner, exactly as
 * the Rust doc comment says. This port keeps that three-way shape —
 * `QuickLookPreview` (drew something), `null` (nothing to draw, or no bytes at
 * all), a thrown error (the read itself failed, or the render step could not
 * even be attempted).
 *
 * SPLIT ACROSS TWO SUBSYSTEMS: the actual pixel-drawing (`quicklook.rs`'s
 * `QLThumbnailGenerator` call, all objc2/PyObjC) is PyObjC work that belongs in
 * the Python sidecar, behind a `/quicklook` HTTP endpoint the plan describes
 * ("Electron main: read blob from DB, POST bytes to the sidecar's QuickLook
 * endpoint, return PNG"). This file is the OTHER half — the one the Rust
 * command itself does inline: resolve the open room, read the file's
 * (name, bytes) via `db::get_file_full`, short-circuit on empty bytes, and
 * shape the final `QuickLookPreview | null`.
 *
 * HONEST GAP, not a fabricated result (rule of this migration): the Python
 * sidecar has no `/quicklook` route yet — verified by searching this
 * migration tree for one before writing this file. {@link quicklookPreview}
 * therefore takes the render step as an INJECTABLE {@link PreviewRenderFn},
 * exactly the seam `jobDownload.ts` cuts for its own not-yet-ported
 * `download_to_temp` engine: the default, {@link previewRenderNotImplemented},
 * rejects with a clearly labelled reason rather than returning `null` (which
 * would misrepresent "we never tried" as "the OS tried and drew nothing").
 * Everything ELSE in this file — the room lookup, the DB read, the
 * empty-bytes short-circuit, the base64 shaping — runs for real against a
 * real fixture room, so a `quicklook_preview` call reaches a real, specific
 * error rather than hanging or silently succeeding.
 *
 * DEVIATION — no re-wrap of the render failure: Rust's
 * `"The preview could not be drawn: {e}"` wraps only a `JoinError` (the
 * blocking task PANICKED); `preview_png` itself has no `Err` path at all, so
 * that wrapper never fires for an ordinary render outcome. A `render()`
 * rejection here has no meaningful "panicked vs. returned Err" distinction to
 * preserve, and wrapping it would bury the exact NOT_IMPLEMENTED marker a
 * caller or test matches on — `jobDownload.ts`'s own `downloadToTempNotImplemented`
 * is left unwrapped end to end for the same reason. `quicklookPreview` lets a
 * `render()` rejection propagate as-is.
 *
 * ROOM-LOCK EQUIVALENCE: the Rust source deliberately reads the bytes, then
 * DROPS the room mutex, before the (possibly multi-second) render call — "a
 * preview must not freeze every other room operation behind it." There is no
 * literal mutex here (`better-sqlite3` is synchronous, off the event loop for
 * the read itself), but the same shape is preserved structurally:
 * {@link quicklookPreview} takes an already-resolved `Database.Database` —
 * exactly `fileTools.ts`'s convention — reads the row synchronously, and only
 * THEN `await`s the render step. `registerPreviewIpc` resolves the room once
 * per call, matching `recIpc.ts`'s `openDb`.
 *
 * NOT a model tool: `quicklook_preview` has no `exec_tool` arm in
 * `agent.rs` (confirmed by grep) and is not in `toolSpecs.ts` — it exists
 * purely for the viewer UI, exactly like the Rust `#[tauri::command]` it
 * ports. Nothing in this file touches `execTool.ts`.
 *
 * NO IPC WIRING in this batch, same as `dictStopTimeout.ts` and `recIpc.ts`:
 * Phase 2 (renderer/preload) needs an explicit owner go-ahead before touching
 * the live shipping app. {@link registerPreviewIpc} exists, ready to be
 * wired, but nothing here calls it.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import { getFileFull } from "./db-host/files.js";
import { readRoomFile } from "./workspace/roomContent.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import type { OpenRoom } from "./turnEngine.js";
import type { QuickLookPreview } from "../shared/apiTypes.js";

/** The slice of the (not-yet-ported) `AppState` this command needs: whichever
 * room is open RIGHT NOW. Reuses `turnEngine.ts`'s {@link OpenRoom} rather than
 * inventing a second "how do I reach the open room" convention — same
 * reasoning `recIpc.ts`'s own `RoomSource` gives. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way `recIpc.ts` and
 * `execTool.ts` already spell it. */
const NO_ROOM_OPEN = "No room is open.";

function openRoom(room: RoomSource): OpenRoom {
  const open = room.currentRoom();
  if (open === null) throw new Error(NO_ROOM_OPEN);
  return open;
}

/**
 * `quicklook::preview_png(name: &str, bytes: &[u8]) -> Option<Vec<u8>>`, as an
 * injectable seam: given the file's name (QuickLook dispatches on its
 * EXTENSION) and its decrypted bytes, render one page as a PNG — or resolve
 * `null` when the OS genuinely has nothing to draw. A real implementation
 * calls the Python sidecar's QuickLook endpoint; see this module's doc for why
 * none is wired in yet.
 */
export type PreviewRenderFn = (name: string, bytes: Buffer) => Promise<Buffer | null>;

/** The labelled reason {@link previewRenderNotImplemented} fails with. Exported
 * so a caller or a test can recognize it without hand-copying the string. */
export const QUICKLOOK_RENDER_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: quicklook.rs's QLThumbnailGenerator render (macOS Quick Look via " +
  "PyObjC, behind the Python sidecar's planned /quicklook endpoint) has no port yet — that " +
  "endpoint does not exist in this sidecar. The room lookup, the file read, and the " +
  "empty-bytes short-circuit around it are real; only the actual page render is stubbed.";

/** {@link quicklookPreview}'s render step falls back to when no real renderer
 * is supplied — a clearly-labelled failure, never a fabricated preview or a
 * fabricated "nothing to draw". */
export const previewRenderNotImplemented: PreviewRenderFn = () =>
  Promise.reject(new Error(QUICKLOOK_RENDER_NOT_IMPLEMENTED));

/** Production Quick Look renderer hosted by the Python sidecar. */
export const renderQuickLook: PreviewRenderFn = async (name, bytes) => {
  const outcome = await sidecarJsonCancellable("/quicklook", {
    name,
    data_b64: bytes.toString("base64"),
  }, new CancelFlag(), 30_000);
  if (outcome.kind === "stopped") throw new Error("The preview was stopped.");
  if (outcome.kind === "error") throw new Error(outcome.error.error);
  const raw = outcome.value as { png_b64?: unknown } | null;
  if (raw?.png_b64 === null || raw?.png_b64 === undefined) return null;
  if (typeof raw.png_b64 !== "string") throw new Error("The preview renderer returned unreadable data.");
  return Buffer.from(raw.png_b64, "base64");
};

/**
 * Port of `commands::quicklook_preview`. Takes the room's ALREADY-UNWRAPPED
 * `Database.Database` — `registerPreviewIpc` resolves it once per call,
 * matching `recIpc.ts`'s `openDb` / `fileTools.ts`'s convention.
 *
 * Throws (matching the Rust `?` on `db::get_file_full`) when `id` names no
 * file in this room. Resolves `null`, not an error, when the file has no
 * bytes at all or when `render` reports the OS drew nothing — both are
 * legitimate answers the Rust doc comment insists on, not failures.
 */
export async function quicklookPreview(
  db: Database.Database,
  id: string,
  render: PreviewRenderFn = previewRenderNotImplemented
): Promise<QuickLookPreview | null> {
  const [name, , storedBytes] = getFileFull(db, id);
  // `bytes.unwrap_or_default()` — a NULL blob (never actually stored, but the
  // column is nullable) reads as empty rather than throwing.
  const bytes = storedBytes ?? Buffer.alloc(0);
  if (bytes.length === 0) {
    return null;
  }
  const png = await render(name, bytes);
  return png === null ? null : { pngB64: png.toString("base64") };
}

/** Workspace-aware command path; legacy callers keep the synchronous DB helper above. */
export async function quicklookPreviewInRoom(
  open: OpenRoom,
  id: string,
  render: PreviewRenderFn = previewRenderNotImplemented,
): Promise<QuickLookPreview | null> {
  const file = await readRoomFile(open, id);
  const bytes = file.bytes ?? Buffer.alloc(0);
  if (bytes.length === 0) return null;
  const png = await render(file.name, bytes);
  return png === null ? null : { pngB64: png.toString("base64") };
}

/**
 * Registers {@link quicklookPreview} on the `quicklook_preview` channel —
 * the Rust `#[tauri::command]` name `src/api.ts`'s `invoke("quicklook_preview",
 * …)` already uses, so the renderer side needs no rename. `ipcMain` is
 * accepted as a parameter, typed against the real `electron` module without
 * importing it at runtime, so this file resolves and tests under plain
 * Node/vitest exactly like `registerDictIpc`/`registerRecIpc` do.
 *
 * Exported and directly testable, but — same as `dictStopTimeout.ts` and
 * `recIpc.ts` — NOT called from any live main-process entrypoint by this
 * batch. Wiring it in is Phase 2 work pending an explicit owner go-ahead.
 */
export function registerPreviewIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  render?: PreviewRenderFn
): void {
  ipcMain.handle(
    "quicklook_preview",
    (_event: IpcMainInvokeEvent, args: { id: string }) =>
      quicklookPreviewInRoom(openRoom(room), args.id, render)
  );
}
