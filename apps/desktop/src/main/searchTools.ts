/**
 * The user's own room-wide search (⌘F). Ported from
 * `src-tauri/src/commands/search.rs` (146 lines, read in full, including its
 * `#[cfg(test)] mod tests`).
 *
 * A THIN DISPATCHER, not new query logic: every actual read is one of
 * `db-host/files.ts`'s {@link filesContentFts}/{@link filesNameLike},
 * `db-host/messages.ts`'s {@link messagesLike}, or `db-host/memories.ts`'s
 * {@link memoriesLike} — all four already ported and already covered by their
 * own test suites. `db-host/retrieval.ts`'s {@link questionTerms},
 * {@link ftsMatchExpr} and {@link makeSnippet} are reused as-is, not
 * reimplemented. What THIS file owns is the one thing none of those pieces
 * know on their own: {@link ftsMatchAll} (an AND, not `ftsMatchExpr`'s OR —
 * see its own doc) and {@link searchAll}'s orchestration — running all four
 * queries off one typed string, deduping file hits between the content pass
 * and the name pass, and shaping the result into the one `SearchResults` the
 * overlay renders.
 *
 * NOT a model tool: checked against `toolSpecs.ts`/`toolSchema.ts` and
 * `execTool.ts` — the only "search" surface a model can invoke is
 * `search_room` (already wired, backed by `retrieveContextExcluding`, a
 * different feature answering a different need: context for an ANSWER, not a
 * result list for a person to click through). `search_all` appears nowhere in
 * `src-tauri/src/room_mcp.rs`/`commands/agent.rs`'s tool schema either — only
 * in `lib.rs`'s plain `#[tauri::command]` registration — so there is no
 * `execTool.ts` arm to add here.
 *
 * `RoomSource`/`openDb`/`NO_ROOM_OPEN` reuse `previewTools.ts`'s/`recIpc.ts`'s
 * established convention (their own docs give the reasoning) rather than
 * inventing a fourth "how do I reach the open room" shape.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { filesContentFts, filesNameLike } from "./db-host/files.js";
import { memoriesLike } from "./db-host/memories.js";
import { messagesLike } from "./db-host/messages.js";
import { ftsMatchExpr, makeSnippet, questionTerms } from "./db-host/retrieval.js";
import type { OpenRoom } from "./turnEngine.js";
import type { SearchResults } from "../shared/apiTypes.js";

/** Element types of {@link SearchResults}' three arrays — derived from the
 * shared, frontend-facing interface rather than redeclared, so the two can
 * never drift the way three independent field lists could. Named after the
 * Rust structs (`FileHit`/`MessageHit`/`MemoryHit`, `commands.rs`) purely for
 * readability at call sites in this file and its test. */
export type FileHit = SearchResults["files"][number];
export type MessageHit = SearchResults["messages"][number];
export type MemoryHit = SearchResults["memories"][number];

/** How many FILES the overlay's Files group may list from content hits. */
export const FILE_CONTENT_HITS = 15;

/**
 * The file-CONTENT expression for a search the user typed, requiring EVERY
 * term — the rule the other three queries already follow.
 *
 * {@link ftsMatchExpr} OR-joins its terms, which is right where it came from:
 * retrieval feeds a question to a model and wants recall. In a result list a
 * person reads it meant one query had two meanings at once — "deposit refund"
 * listed every document mentioning only deposits, next to a Messages group
 * restricted (by `likeAllClause`) to rows containing both words. Quoting
 * stays with {@link ftsMatchExpr} so a term with punctuation, or an FTS
 * keyword like "near", is escaped exactly once and in one place — each term
 * is passed through it ALONE, so its own drop-empty-quote rule applies per
 * term rather than to the whole joined string.
 *
 * What "every term" means here is the FTS row, which for file content is ONE
 * ~1,200-character chunk — not the whole document. So a long file that says
 * "deposit" on page 2 and "refund" on page 30 is not a content hit for
 * "deposit refund", the same way a chat message is only a hit when one
 * message holds both words.
 */
export function ftsMatchAll(terms: Iterable<string>): string | null {
  const quoted: string[] = [];
  for (const t of terms) {
    const q = ftsMatchExpr([t]);
    if (q !== null) {
      quoted.push(q);
    }
  }
  return quoted.length === 0 ? null : quoted.join(" AND ");
}

/**
 * ADD-6: search the user's own room across file names + content, chat
 * messages, and memories. File content rides the FTS5 index (HLT-3); messages
 * and memories use LIKE. Every hit carries a short snippet for the overlay.
 *
 * Ported from `search_all` (search.rs:37-113).
 */
export function searchAll(db: Database.Database, query: string): SearchResults {
  const trimmed = query.trim();
  if (trimmed === "") {
    return { files: [], messages: [], memories: [] };
  }
  const needle = trimmed.toLowerCase();

  // Files: content hits (FTS) first, then name-only matches not already shown.
  const files: FileHit[] = [];
  const seen = new Set<string>();
  const expr = ftsMatchAll(questionTerms(trimmed)) ?? ftsMatchAll([needle]);
  if (expr !== null) {
    // `filesContentFts` limits CHUNKS, and one long document can own all of
    // the best-ranked ones — a 15-chunk fetch then listed a single file and
    // dropped every other document that matched, unreachably. Over-fetch and
    // stop at the first N distinct files instead.
    for (const [id, name, chunk] of filesContentFts(db, expr, FILE_CONTENT_HITS * 20)) {
      if (files.length >= FILE_CONTENT_HITS) {
        break;
      }
      if (!seen.has(id)) {
        seen.add(id);
        files.push({ id, name, snippet: makeSnippet(chunk, trimmed, 60) });
      }
    }
  }
  // Name-only matches carry NO snippet. The row already shows the name (which
  // is where the match is), so repeating it as the preview line said the same
  // thing twice — and the overlay hands the snippet to the viewer as the text
  // to jump to, so a file name sent the viewer looking for words the document
  // does not contain and nothing was highlighted.
  for (const [id, name] of filesNameLike(db, needle)) {
    if (!seen.has(id)) {
      seen.add(id);
      files.push({ id, name, snippet: "" });
    }
  }

  const messages: MessageHit[] = messagesLike(db, needle).map(([chatId, messageId, content]) => ({
    chatId,
    messageId,
    snippet: makeSnippet(content, trimmed, 60),
  }));

  const memories: MemoryHit[] = memoriesLike(db, needle).map(([id, content]) => ({
    id,
    snippet: makeSnippet(content, trimmed, 60),
  }));

  return { files, messages, memories };
}

// ------------------------------------------------------------------- ipc

/** The slice of the (not-yet-ported) `AppState` this command needs: whichever
 * room is open RIGHT NOW. Reuses `turnEngine.ts`'s {@link OpenRoom} rather
 * than inventing a fourth "how do I reach the open room" convention — same
 * reasoning `recIpc.ts`'s/`previewTools.ts`'s own `RoomSource` gives. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way `recIpc.ts`,
 * `previewTools.ts` and `execTool.ts` already spell it. */
const NO_ROOM_OPEN = "No room is open.";

function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

/**
 * Registers the `search_all` channel on `ipcMain`, under the exact channel
 * name and `{ query }` argument shape `src/api.ts:350`'s `invoke(...)` call
 * already uses, so the renderer needs no rename. Same precedent as
 * `recIpc.ts`'s `registerRecIpc` and `previewTools.ts`'s
 * `registerPreviewIpc`: a small, single-command module registering its own
 * one channel rather than splitting a business-logic file from an IPC file.
 *
 * NOT wired into any bootstrap file — nothing here or elsewhere calls this
 * yet, per this migration's standing rule that `ipcMain.handle` never lands
 * in a live bootstrap file from a batch like this one.
 */
export function registerSearchIpc(ipcMain: Pick<IpcMain, "handle">, room: RoomSource): void {
  ipcMain.handle("search_all", (_event: IpcMainInvokeEvent, args: { query: string }) =>
    searchAll(openDb(room), args.query)
  );
}
