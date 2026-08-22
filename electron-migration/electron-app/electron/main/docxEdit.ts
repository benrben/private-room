/**
 * Port of `src-tauri/src/commands/docx_edit.rs` (231 lines, read in full) —
 * the single `update_docx_text` command behind the Word-file editor's Save
 * button.
 *
 * THE GAP THIS CLOSES (the Rust source's own framing, kept verbatim because
 * it is the reason this command exists at all): the AI could already edit a
 * `.docx` in place through `edit_file`'s run-split OOXML matcher, which
 * rewrites `word/document.xml` while preserving every style, table and
 * image. The USER could not — the Edit button on a Word file offered "Edit
 * as text", which edited the EXTRACTED text and saved a separate `.md` copy,
 * leaving the original untouched. This command gives the person who owns the
 * document the same power over it the model already had.
 *
 * PER-PARAGRAPH ON PURPOSE. Replacing `word/document.xml` wholesale from
 * plain text would throw away everything that makes it a Word file. Instead
 * the paragraphs of the stored text are lined up against the paragraphs of
 * the edited text, and only the ones that actually differ are pushed through
 * the SAME matcher the model's `edit_file` uses — {@link docxReplaceText}
 * (`editMatchDocx.ts`, already ported from `extraction/docx.rs`). An
 * untouched paragraph is not rewritten at all, so its runs, fonts and fields
 * survive byte for byte. Adding or removing a paragraph is refused rather
 * than guessed at: with no anchor to hang a new `<w:p>` on, "insert here" is
 * not a question the text alone can answer.
 *
 * REUSES RATHER THAN DUPLICATES, per this batch's instructions:
 *   - {@link docxReplaceText} (`editMatchDocx.ts`) — the docx run-split
 *     matcher itself. Nothing here parses OOXML or a zip directly.
 *   - {@link extractText}/{@link storeFileBytes} (`editMatch.ts`) — the same
 *     `extraction::extract_text` dispatcher and `commands::files::
 *     store_file_bytes` single-write-path `commit_plans` itself uses, so a
 *     manual Word edit re-derives its searchable text and snapshots its
 *     version history exactly the way an AI edit does.
 *   - {@link extensionOf} (`editMatchExtraction.ts`), {@link getFileFull}/
 *     {@link getFileMeta} (`db-host/files.ts`).
 *
 * NOT PORTED: `edit_gate.rs` (Wave 2's diff-preview approval gate) is a
 * SEPARATE Rust module this command never calls — confirmed by reading
 * `docx_edit.rs` in full; `update_docx_text` writes directly through
 * `store_file_bytes` under the room lock, with no `gated_write` wrapper.
 * `edit_gate.rs` exists in this codebase only for the tool-invoked mutations
 * `agent.rs`'s `exec_tool` dispatches (`edit_file`/`edit_files`/`write_file`/
 * `set_cells`); it has no bearing on this file.
 *
 * NOT A MODEL TOOL: `update_docx_text` has no `exec_tool` arm in `agent.rs`
 * and no entry in `toolSpecs.ts`/`toolSchema.ts` (confirmed by grep) — it
 * exists purely for the built-in Word-file viewer's Save button, exactly
 * like the Rust `#[tauri::command]` it ports. Nothing in this file touches
 * `execTool.ts`.
 *
 * THE UNCONDITIONAL EMIT, preserved exactly as the Rust source has it: the
 * "room-files-changed" broadcast fires AFTER the room-locked body returns —
 * even down the no-op branch, where the edited text said exactly what the
 * document already said and nothing was written. That is the Rust source's
 * own control flow (the emit sits outside the closure `state.with_room` runs,
 * not inside either of its two return points), not an oversight introduced by
 * this port.
 *
 * NO IPC WIRING in this batch, same as `dictStopTimeout.ts`/`recIpc.ts`/
 * `previewTools.ts`: Phase 2 (renderer/preload) needs an explicit owner
 * go-ahead before touching the live shipping app. {@link registerDocxEditIpc}
 * exists, ready to be wired, but nothing calls it yet. `update_docx_text` is
 * already declared on `ipc-contract.ts`'s wire contract (`src/api.ts:237`'s
 * `invoke<FileMeta>("update_docx_text", { id, content })`), so the channel
 * name and argument shape need no invention here.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { getFileFull, getFileMeta, type FileMeta } from "./db-host/files.js";
import { extensionOf, isUnicodeWhitespace } from "./editMatchExtraction.js";
import { extractText, storeFileBytes } from "./editMatch.js";
import { docxReplaceText } from "./editMatchDocx.js";
import type { OpenRoom } from "./turnEngine.js";

// ------------------------------------------------------------- room/emit plumbing

/** The slice of the (not-yet-ported) `AppState` this command needs: whichever
 * room is open RIGHT NOW. Reuses `turnEngine.ts`'s {@link OpenRoom} rather
 * than inventing a second "how do I reach the open room" convention — same
 * reasoning `recIpc.ts`'s/`previewTools.ts`'s own `RoomSource` gives. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way `recIpc.ts` and
 * `previewTools.ts` already spell it. */
const NO_ROOM_OPEN = "No room is open.";

function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

/** `let _ = app.emit(...)` — a best-effort UI notification that must never
 * turn a successful save into a failed one. Same narrowest-possible contract
 * as `organizeTools.ts`'s/`safetyTools.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = app.emit(...)`.
  }
}

// --------------------------------------------------------------------- paragraphs

/** Rust's `str::lines()`: split on `\n`, drop a trailing `\r` from each line,
 * and produce NO final empty line for a string that ends in `\n`. A local
 * copy of `editMatchExtraction.ts`'s own (unexported) `linesOf` — the same
 * duplication choice `organizeTools.ts`'s local `extensionOf` documents,
 * until a future batch collapses these onto one shared module. */
function linesOf(s: string): string[] {
  if (s === "") {
    return [];
  }
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Rust's `str::trim_end()` — trims trailing `char::is_whitespace()`, the
 * Unicode `White_Space` property {@link isUnicodeWhitespace} already reads.
 * Deliberately NOT JS's native `.trimEnd()`, which both misses U+0085 (NEL)
 * and trims U+FEFF (a BOM Rust treats as an ordinary character) — the same
 * divergence `editMatchDocx.ts`'s `hasEdgeWhitespace` documents. Every
 * `White_Space` code point is in the BMP, so per-UTF-16-unit indexing is
 * exact here; no surrogate pair is ever a whitespace character. */
function trimEndUnicode(s: string): string {
  let end = s.length;
  while (end > 0 && isUnicodeWhitespace(s.charAt(end - 1))) {
    end -= 1;
  }
  return s.slice(0, end);
}

/** Rust's `str::trim()` — both ends, same Unicode property as
 * {@link trimEndUnicode}. */
function trimUnicode(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isUnicodeWhitespace(s.charAt(start))) {
    start += 1;
  }
  while (end > start && isUnicodeWhitespace(s.charAt(end - 1))) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** Paragraphs, as the reader sees them: non-empty lines, trimmed of the
 * trailing whitespace an editor adds. Ported verbatim from
 * `docx_edit::paragraphs`. */
function paragraphs(text: string): string[] {
  return linesOf(text)
    .map(trimEndUnicode)
    .filter((l) => trimUnicode(l) !== "");
}

/** A short, character-count-safe (not UTF-16-unit-safe) preview of a
 * paragraph for an error message — long enough to identify the line, short
 * enough not to dump a whole document into a dialog. Ported verbatim from
 * `docx_edit::snippet`; `[...s]` gives code-point iteration the same way
 * Rust's `chars()` does, matching `editMatchDocx.ts`'s own convention for
 * character-indexed text. */
function snippet(s: string): string {
  const trimmed = trimUnicode(s);
  const chars = [...trimmed];
  if (chars.length <= 60) {
    return trimmed;
  }
  return `${chars.slice(0, 60).join("")}…`;
}

/**
 * The core, split out so it is testable without a room. `null` is "the
 * edited text says exactly what the document already says" — reporting that
 * as an error made a whitespace-only change impossible to close: Save
 * answered "Could not save — Nothing changed.", and the unsaved-edits dialog
 * reads a failed save as "your edit is still in the editor" and stays up,
 * leaving Discard as the only way out. Ported verbatim from
 * `docx_edit::apply_paragraph_edits`; throws (matching Rust's `Result<_,
 * String>` propagated through `?` at the command layer) rather than
 * returning a discriminated union, since — unlike `edit_match.rs`'s
 * tool-facing errors — nothing here needs a content-free `outcome` tag.
 */
export function applyParagraphEdits(bytes: Uint8Array, before: string, after: string): Buffer | null {
  const oldParas = paragraphs(before);
  const newParas = paragraphs(after);
  if (oldParas.length !== newParas.length) {
    throw new Error(
      "This editor can change the wording of a Word file's paragraphs, but not add or " +
        `remove them — the document has ${oldParas.length} and the edited text has ` +
        `${newParas.length}. Undo the added or deleted line, or use "Save as a copy" to keep ` +
        "this version as a separate note."
    );
  }
  let patched: Uint8Array = bytes;
  let changed = 0;
  for (let i = 0; i < oldParas.length; i++) {
    const oldPara = oldParas[i]!;
    const newPara = newParas[i]!;
    if (oldPara === newPara) {
      continue;
    }
    // The extracted text of a header, a footnote or a comment reaches the
    // editor too, but only `word/document.xml` is rewritten — so a paragraph
    // that lives elsewhere simply won't match. Say which one rather than
    // reporting a bare failure.
    const result = docxReplaceText(patched, oldPara, newPara);
    if (!result.ok) {
      throw new Error(
        "One paragraph could not be written back into the Word file, so nothing was " +
          "saved. This happens when the changed line comes from a header, a footer, a " +
          "footnote or a comment — those are shown in the reader but live outside the " +
          `document body. Paragraph: "${snippet(oldPara)}"\n\n${result.error}`
      );
    }
    // A paragraph repeated verbatim elsewhere in the document would be
    // rewritten in both places. Refuse instead of silently changing a line
    // the user never looked at.
    if (result.count > 1) {
      throw new Error(
        `"${snippet(oldPara)}" appears ${result.count} times in this document, so saving ` +
          'would change all of them. Edit it in a way that makes the line unique, or use ' +
          '"Save as a copy".'
      );
    }
    patched = result.bytes;
    changed += 1;
  }
  if (changed === 0) {
    return null;
  }
  return Buffer.isBuffer(patched) ? patched : Buffer.from(patched);
}

// ---------------------------------------------------------------------- command

/**
 * Rewrite a Word file from edited text, paragraph by paragraph. Ported from
 * `docx_edit::update_docx_text`, minus the Tauri wrapper — takes the room's
 * already-resolved `Database.Database`, matching `previewTools.ts`'s/
 * `recIpc.ts`'s convention.
 *
 * Throws (matching the Rust `?` on `db::get_file_full`) when `id` names no
 * file in this room; throws the same plain-language refusals the Rust source
 * does for a non-.docx file, a file with no readable text, an edit that adds
 * or removes a paragraph, an edit that lands in a header/footer/footnote/
 * comment, and an edit that would touch a repeated paragraph more than once.
 *
 * The "room-files-changed" broadcast is UNCONDITIONAL — it fires even when
 * nothing was written (the no-op branch), because that is what the Rust
 * source does: the emit sits after `state.with_room` returns, not inside
 * either of its two return points.
 */
export function updateDocxText(db: Database.Database, id: string, content: string, emit?: EmitFn): FileMeta {
  const [name, , bytesRaw, extracted] = getFileFull(db, id);
  const bytes = bytesRaw ?? Buffer.alloc(0);
  if (extensionOf(name) !== "docx") {
    throw new Error(`"${name}" is not a Word document.`);
  }
  if (extracted === null) {
    throw new Error(`"${name}" has no readable text, so there is nothing to edit.`);
  }
  const patched = applyParagraphEdits(bytes, extracted, content);
  let meta: FileMeta;
  if (patched === null) {
    // The buffer says what the document already says. Nothing to write, and
    // no version to record — but this is a save that succeeded, so the
    // editor's dirty flag clears and the close the user asked for goes
    // through.
    meta = getFileMeta(db, id);
  } else {
    // The new searchable text is re-derived from the PATCHED FILE, never
    // taken from the editor's buffer: the two can legitimately differ (the
    // reader shows headers, footnotes and comments, which live in parts this
    // rewrite doesn't touch), and storing the buffer would quietly delete
    // them from the index.
    const text = extractText(name, patched);
    storeFileBytes(db, id, patched, text, "You edited the document");
    meta = getFileMeta(db, id);
  }
  // Every OTHER way of changing a file broadcasts this; the plain Save in the
  // built-in editor did not, so the Library, the Scripts index and the front
  // page all kept showing what the file used to say.
  emitSafely(emit, "room-files-changed", undefined);
  return meta;
}

/**
 * Registers {@link updateDocxText} on the `update_docx_text` channel — the
 * Rust `#[tauri::command]` name `src/api.ts`'s `invoke("update_docx_text", …)`
 * already uses, so the renderer side needs no rename. `ipcMain` is accepted
 * as a parameter, typed against the real `electron` module without importing
 * it at runtime, so this file resolves and tests under plain Node/vitest
 * exactly like `registerPreviewIpc`/`registerRecIpc` do.
 *
 * Exported and directly testable, but — same as `previewTools.ts`/
 * `recIpc.ts` — NOT called from any live main-process entrypoint by this
 * batch. Wiring it in is Phase 2 work pending an explicit owner go-ahead.
 */
export function registerDocxEditIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  emit?: EmitFn
): void {
  ipcMain.handle(
    "update_docx_text",
    (_event: IpcMainInvokeEvent, args: { id: string; content: string }) =>
      updateDocxText(openDb(room), args.id, args.content, emit)
  );
}
