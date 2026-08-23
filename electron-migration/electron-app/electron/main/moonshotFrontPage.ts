/**
 * D4: the front page — the instant, model-free landing view shown on unlock,
 * plus its lazy AI-generated starter questions. Ported from
 * `src-tauri/src/commands/moonshot/front_page.rs` (227 lines, read in full,
 * including its `#[cfg(test)] mod tests` — both are reproduced in
 * `moonshotFrontPage.test.ts`).
 *
 * NOT model-invocable: `front_page`/`front_page_suggestions` are registered
 * ONLY in `lib.rs`'s `tauri::generate_handler!` list (lines 367-368) — grepped
 * for "front_page" across the whole `src-tauri/src` tree and it appears
 * nowhere in `agent.rs`'s `exec_tool` match arms or any tool-spec file. Per
 * this batch's own instructions, `execTool.ts` needed no change.
 *
 * NO NOT_IMPLEMENTED STUB NEEDED — everything `front_page.rs` touches already
 * has a real Electron port:
 *  - `db::list_files`/`list_chats`/`list_memories`/`room_file_count`/
 *    `get_meta`/`set_meta` — all real, in `db-host/{files,chats,memories,meta}.ts`.
 *  - `resolve_structured_model` — real, reused from `moonshotCmds.ts` (see
 *    the OVERLAP note below), not re-derived.
 *  - `ollama::resolved_base_url` — real, `engineRouting.ts`.
 *  - `sidecar::sidecar_json("/label", ...)` — real, via
 *    `sidecarJsonCancellable.ts` (driven with a never-set flag, the same
 *    adaptation `feedbackTools.ts`/`storyTools.ts` already make for a Rust
 *    call site with no cancellation of its own). The sidecar's own `/label`
 *    endpoint is implemented (`sidecar/arcelle_sidecar/server.py`,
 *    `LabelRequest` in `config.py`) and matches this file's request shape
 *    field for field (`model`, `base_url`, `room_name`, `files`).
 *
 * ============================================================================
 * OVERLAP WITH `moonshotCmds.ts` — READ BEFORE CHANGING EITHER FILE
 * ============================================================================
 * `moonshotCmds.ts` (ported concurrently with this file, from
 * `commands/moonshot.rs` — the parent dispatcher `front_page.rs` is one of
 * six submodules under) already carries a REAL, working port of
 * `resolve_structured_model`, written explicitly anticipating this file: its
 * own module doc says a submodule port "can import this directly instead of
 * re-deriving a private copy the way `feedbackTools.ts` and `recBridge.ts`
 * were forced to." This file does exactly that — imports
 * {@link resolveStructuredModel}/{@link RoomSource} from `moonshotCmds.ts`
 * rather than shipping a third copy. An EARLIER version of this file (before
 * `moonshotCmds.ts` existed in this tree) carried its own duplicate; it was
 * deleted in favor of this import the moment the overlap was found, per rule
 * 6's "add additively, don't duplicate what another batch already landed"
 * spirit applied to `moonshotCmds.ts` instead of `execTool.ts`.
 *
 * One consequence: this file uses `moonshotCmds.ts`'s room-access convention
 * throughout (`turnEngine.ts`'s {@link OpenRoom} / a `RoomSource` with
 * `currentRoom()`), NOT `jobs.ts`'s differently-named `RoomHandle`/
 * `current()` — `moonshotCmds.ts`'s own doc gives the reason: this is "a
 * command-and-IPC layer like `recIpc.ts`/`ollamaModels.ts`, not a background
 * job runner," and `front_page.rs`'s port is exactly that too.
 *
 * FIDELITY NOTE, preserved from before the merge — {@link resolveStructuredModel}
 * (in `moonshotCmds.ts`) re-reads `rooms.currentRoom()` ITSELF rather than
 * taking an already-resolved `Database.Database`. This looks redundant next
 * to {@link frontPageSuggestions}, which already snapshots the room's path/
 * name/files earlier in the same call — but it is not a mistake, it MATCHES
 * Rust exactly: `resolve_structured_model(&state)` re-locks `state.room`
 * fresh, independently of the `room_path`/`room_name`/`file_names`/`cached`
 * tuple captured in the scope above it. If a room is swapped mid-call, the
 * model resolved can be the NEW room's model, not the snapshotted one — Rust
 * only catches that swap later, at the caching step
 * (`if room.path == room_path`). This port reproduces that race, not a
 * cleaned-up version of it. See `moonshotFrontPage.test.ts`'s
 * `sequencedRooms`-driven tests for both re-read points exercised directly.
 *
 * ONE DEPENDENCY STILL NEEDED PORTING HERE, TINY AND DUPLICATED RATHER THAN
 * SHARED, following this rewrite's established "too small to justify a
 * shared port" precedent (`storyTools.ts`'s own module doc lists
 * `splitWhitespace`/`namesAppear`, `capabilities.ts` lists
 * `isCloudModel`/`primaryCliScope`, as exactly this):
 *
 *  - {@link isSummaryFile} — `commands::summarize::is_summary_file`. That
 *    whole module (`summarize.rs`) has no Electron port yet, but the
 *    predicate itself is two string comparisons and an `&&`, reproduced
 *    verbatim here rather than invented. When `summarize.rs` is ported for
 *    real, that file's version should become the shared one and this local
 *    copy should be deleted in favor of importing it — exactly the
 *    "duplicated now, promote later" note `feedbackTools.ts` makes about its
 *    own `bestLocalDefault`.
 *
 * REUSED, not re-declared:
 *  - {@link FrontPage} — already declared, camelCase and field-for-field with
 *    the Rust struct, in `../shared/apiTypes.ts` (the `storyTools.ts`
 *    convention for a type that already exists there).
 *  - `OpenRoom` (`turnEngine.ts`), {@link resolveStructuredModel}/
 *    {@link RoomSource} (`moonshotCmds.ts`) — see the OVERLAP note above.
 *    `front_page_suggestions` also needs the room's NAME, which `OpenRoom`
 *    does not carry (Rust's `Room` struct has one, but nothing here has
 *    ported that whole type) — derived instead exactly as Rust populates it
 *    at open time (`roomManager.ts:816`):
 *    `getMeta(db, "name") ?? roomNameFromPath(path)`.
 *  - `resolvedBaseUrl` (`engineRouting.ts`), `sidecarJsonCancellable`
 *    (`sidecarJsonCancellable.ts`), `roomNameFromPath` (`roomManager.ts`) —
 *    all real, already-ported implementations, not stand-ins.
 *
 * Per this rewrite's "no ipcMain wiring in this batch" convention
 * (`recIpc.ts`, `storyTools.ts`, rule 4), {@link registerFrontPageIpc} is
 * NOT wired into any bootstrap file. Channel names and the (empty) argument
 * shape are the pre-migration frontend's real contract (`src/api.ts:1473-
 * 1477`, already declared in `shared/ipc-contract.ts:770-771`), not invented.
 *
 * DEVIATION — errors, not `Result`: this batch's `#[tauri::command]`s all
 * either succeed or degrade to an empty/cached answer; neither Rust command
 * has an error path a caller acts on (`front_page`'s own `?` only ever fails
 * on a broken DB connection, which throws here exactly as `queryOne`/
 * `queryRows` already throw for every other reader in `db-host`).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { FileMeta as ApiFileMeta, FrontPage } from "../shared/apiTypes.js";
import { CancelFlag } from "./cancel.js";
import { listChats } from "./db-host/chats.js";
import { SECTION_ONLY, roomFileCount, listFiles, type FileMeta as DbFileMeta } from "./db-host/files.js";
import { listMemories } from "./db-host/memories.js";
import { getMeta, setMeta } from "./db-host/meta.js";
import { queryOne } from "./db-host/util.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { resolveStructuredModel, type RoomSource } from "./moonshotCmds.js";
import { roomNameFromPath } from "./roomManager.js";
import {
  sidecarJsonCancellable,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";
import type { OpenRoom } from "./turnEngine.js";

export type { FrontPage };
export type { OpenRoom, RoomSource };

// ---------------------------------------------------- is_summary_file (dup)

/** `commands::summarize::SUMMARY_FILE_NAME` — the one canonical, overwrite-
 * in-place summary file. See this module's doc for why this is duplicated
 * rather than imported. */
const SUMMARY_FILE_NAME = "Room summary.html";

/** `commands::summarize::is_summary_file`, verbatim: true for the app's own
 * generated summary file (current HTML name, or the legacy Markdown name so
 * an old room's summary is not fed back into a new one), so both `frontPageOf`
 * and `frontPageSuggestions` leave the room's own output out of the strip and
 * the file-name list they show/send. A user upload sharing the name is NOT
 * excluded — `source` must be `"generated"`. */
function isSummaryFile(name: string, source: string): boolean {
  return (name === SUMMARY_FILE_NAME || name === "Room summary.md") && source === "generated";
}

// ------------------------------------------------------------ FileMeta shape

/**
 * `db-host/files.ts`'s own `FileMeta.libraryVisibility` is typed as plain
 * `string` (read straight off the column with `as string`, matching every
 * other column in that mapper), while the frontend contract in
 * `shared/apiTypes.ts` narrows it to the two values the column is ever
 * actually written with (`SECTION_ONLY`/`LINKED`, in
 * `markSectionOnly`/`setLibraryVisibility`). This maps the ALREADY-CORRECT
 * runtime value onto that narrower type via an equality check against the
 * SAME constant those writers use — not a blind cast — so {@link frontPageOf}
 * can return the real `shared/apiTypes.ts` `FrontPage` shape the IPC contract
 * promises, the same "answer the contract that already exists" choice
 * `storyTools.ts`'s module doc documents making for its own six result types.
 */
function toApiFileMeta(f: DbFileMeta): ApiFileMeta {
  return {
    ...f,
    libraryVisibility: f.libraryVisibility === SECTION_ONLY ? "sectionOnly" : "linked",
  };
}

// ------------------------------------------------------- cached suggestions

/** `front_page.rs::FRONT_PAGE_SUGGESTIONS_KEY` — the `meta` row the lazy
 * suggestions are cached under, and the one `frontPageOf`'s own `suggestions`
 * field reads back. */
export const FRONT_PAGE_SUGGESTIONS_KEY = "front_page_suggestions";

/**
 * `db::get_meta(conn, FRONT_PAGE_SUGGESTIONS_KEY).and_then(|s|
 * serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default()`.
 *
 * ALL of the array or NONE of it: `serde_json::from_str::<Vec<String>>` fails
 * its WHOLE parse the moment any element is not a string, and `.ok()` folds
 * that (or a missing key, or invalid JSON) to `None` — same all-or-nothing
 * rule `storyTools.ts`'s `parseParsedMembers` documents for the identical
 * Rust idiom, and deliberately NOT the element-by-element filtering
 * {@link parseLabelQuestions} below does for the sidecar's live reply (a
 * `serde_json::Value` array filtered with `filter_map`, a different Rust
 * function with a different, more lenient contract).
 */
function parseCachedSuggestions(db: Database.Database): string[] {
  const raw = getMeta(db, FRONT_PAGE_SUGGESTIONS_KEY);
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    return [];
  }
  return parsed;
}

// -------------------------------------------------------------- front_page

/**
 * The front page as a pure function of the room's DB. Ported from
 * `front_page_of` — split out of the command in Rust so its counts could be
 * checked against the other count surfaces in a test without a live app;
 * exported here for the same reason, since this port's tests live in a
 * separate file rather than a `#[cfg(test)] mod tests { use super::*; }`.
 */
export function frontPageOf(db: Database.Database): FrontPage {
  const recentFiles = listFiles(db)
    .filter((f) => !isSummaryFile(f.name, f.source))
    .slice(0, 5)
    .map(toApiFileMeta);
  const recentChats = listChats(db).slice(0, 5);
  // No `.slice()` here — Rust's own `front_page_of` does not cap `memories`,
  // only `recent_files`/`recent_chats`.
  const memories = listMemories(db);
  // Trash: `roomFileCount` carries the same predicate `listFiles` (just
  // above) uses, so the count and the list on this page cannot disagree about
  // what is in the room.
  const fileCount = roomFileCount(db);
  // Both counts propagate rather than falling back to 0 — a query failure
  // here throws (via `queryOne`), matching `listFiles`'s own throw-on-error
  // convention, rather than reporting "0 files, 0 chats" as if the room were
  // actually empty.
  const chatCount = queryOne(db, "SELECT count(*) FROM chats", [], (r) => r[0] as number);
  const suggestions = parseCachedSuggestions(db);
  return { recentFiles, recentChats, memories, suggestions, fileCount, chatCount };
}

/**
 * D4: the instant, model-free landing view shown on unlock. Ported from
 * `front_page`. Never blocks the unlock — only reads stored rows and
 * whatever suggestions are already cached; fresh ones come from the lazy
 * {@link frontPageSuggestions} the frontend calls after painting.
 *
 * No room open answers the all-zero page Rust does (`Ok(FrontPage{...})`
 * with every field empty/zero) rather than throwing — unlike `story_*`'s
 * "No room is open." refusal, because this command is the FIRST thing a
 * fresh unlock screen calls and must have something to draw immediately.
 */
export function frontPage(rooms: RoomSource): FrontPage {
  const room = rooms.currentRoom();
  if (room === null) {
    return {
      recentFiles: [],
      recentChats: [],
      memories: [],
      suggestions: [],
      fileCount: 0,
      chatCount: 0,
    };
  }
  return frontPageOf(room.db);
}

// ----------------------------------------------------- front_page_suggestions

/** Rust's `sidecar::sidecar_json` signature, narrowed to what this module
 * calls it with — the same local alias `feedbackTools.ts`/`filePass.ts` keep
 * for the identical reason. */
type SidecarPostFn = (path: string, body: unknown, cancel: CancelFlag) => Promise<SidecarPostOutcome>;

/** A flag that is never set — drives {@link sidecarJsonCancellable} as a
 * plain, uncancellable POST, matching Rust's own non-cancellable
 * `sidecar::sidecar_json` call. A fresh instance per call, never a shared
 * module-level one, so no caller can observe it having been flipped by an
 * earlier, unrelated request — the same convention `feedbackTools.ts`'s
 * `neverCancelled` documents. */
function neverCancelled(): CancelFlag {
  return new CancelFlag();
}

export interface FrontPageSuggestionsDeps {
  /** Which room, if any, is currently open. Read more than once — once here,
   * and again inside `moonshotCmds.ts`'s {@link resolveStructuredModel} (see
   * this module's OVERLAP/fidelity note) — matching Rust's own repeated
   * `state.room.lock()`. */
  rooms: RoomSource;
  /** `ollama::list_models()`, forwarded to {@link resolveStructuredModel}.
   * Defaults to the real, already-ported `engineRouting.ts` implementation
   * (`resolveStructuredModel`'s own default). */
  listModels?: () => Promise<string[]>;
  /** `sidecar::sidecar_json("/label", &body)`. Defaults to the real
   * {@link sidecarJsonCancellable} driven with a flag that is never set. */
  post?: SidecarPostFn;
}

/**
 * `v["questions"].as_array().map(|a| a.iter().filter_map(|x|
 * x.as_str().map(str::to_string)).collect()).unwrap_or_default()`.
 *
 * Element-by-element: a non-string element is DROPPED, not fatal to the
 * whole array (`filter_map`, not a typed `Vec<String>` deserialize) — the
 * opposite leniency from {@link parseCachedSuggestions}'s all-or-nothing
 * cache read, because this is Rust reading a loosely-typed `serde_json::Value`
 * by hand rather than deserializing into a concrete type. A reply that is not
 * an object, has no `questions` key, or whose `questions` is not an array,
 * answers `[]` — `reply["questions"]` on any of those indexes to
 * `Value::Null`, whose `.as_array()` is `None`.
 *
 * Reads `questions` via `hasOwnProperty`, not a bare `obj.questions` — the
 * same own-property discipline `feedbackTools.ts`'s `readDraft` states for
 * reading a JSON-parsed reply, so an `Object.prototype` already polluted by
 * an unrelated bug elsewhere in the app cannot be misread as this reply
 * having answered.
 */
function parseLabelQuestions(value: unknown): string[] {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const arr = Object.prototype.hasOwnProperty.call(obj, "questions") ? obj.questions : undefined;
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr.filter((x): x is string => typeof x === "string");
}

/**
 * D4: generate up to three short starter questions grounded in the room's
 * name and file list, cache them in `meta`, and return them. Ported from
 * `front_page_suggestions`. Degrades to the cached list (or empty) when the
 * model is unreachable, the sidecar call fails, or the room is empty.
 *
 * The prompt/schema/parse/take-3 all live in the sidecar's `/label` endpoint,
 * exactly as in Rust — this function's own job is only: gather the room
 * snapshot, resolve a model (via `moonshotCmds.ts`'s real
 * {@link resolveStructuredModel}), POST, parse the reply loosely, and cache
 * under a room-path pin so a generation that outlives a room switch cannot
 * file one room's questions under another.
 */
export async function frontPageSuggestions(deps: FrontPageSuggestionsDeps): Promise<string[]> {
  const room = deps.rooms.currentRoom();
  if (room === null) {
    return [];
  }
  const roomPath = room.path;
  const roomName = getMeta(room.db, "name") ?? roomNameFromPath(room.path);
  const fileNames = listFiles(room.db)
    .filter((f) => !isSummaryFile(f.name, f.source))
    .slice(0, 30)
    .map((f) => f.name);
  const cached = parseCachedSuggestions(room.db);

  if (fileNames.length === 0) {
    return [];
  }

  const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
  if (model === undefined) {
    // Offline: reuse whatever was cached before.
    return cached;
  }

  const body = {
    model,
    base_url: resolvedBaseUrl(),
    room_name: roomName,
    files: fileNames,
  };
  const post = deps.post ?? sidecarJsonCancellable;
  // Any sidecar failure (or a `stopped` outcome, unreachable in practice since
  // `neverCancelled()`'s flag is never set — the same "kept for a total union"
  // choice `feedbackTools.ts` documents) reads as Rust's `Err(_) => Vec::new()`.
  const outcome = await post("/label", body, neverCancelled());
  const questions = outcome.kind === "value" ? parseLabelQuestions(outcome.value) : [];

  if (questions.length === 0) {
    return cached;
  }

  // These questions name THIS room's files. The model call above can take
  // minutes, so cache them only if the same room is still open — unlocking
  // another one mid-generation must not file one room's questions in another.
  const stillOpen = deps.rooms.currentRoom();
  if (stillOpen !== null && stillOpen.path === roomPath) {
    try {
      setMeta(stillOpen.db, FRONT_PAGE_SUGGESTIONS_KEY, JSON.stringify(questions));
    } catch {
      // `let _ = db::set_meta(...)`: the CACHE write is best-effort. Rust
      // returns the questions whatever happens here, and it must — a room
      // whose disk is full or whose DB is momentarily read-only would
      // otherwise turn a perfectly good generation into a failed command,
      // three times in a row, with nothing to show for the minutes it took.
    }
  }
  return questions;
}

// -------------------------------------------------------------- IPC (unwired)

/**
 * Register the front-page channels on `ipcMain`. NOT wired into any
 * bootstrap file (rule 4) — ready for a future preload/renderer batch.
 * Channel names and the empty argument shape match the pre-migration
 * frontend's real contract (`src/api.ts:1473-1477`), already declared in
 * `shared/ipc-contract.ts:770-771`.
 *
 * Neither handler throws "No room is open." — both {@link frontPage} and
 * {@link frontPageSuggestions} already answer an empty/all-zero result for
 * that case, matching Rust's own `Ok(...)` (never `Err`) for a locked/no-room
 * unlock screen.
 */
export function registerFrontPageIpc(ipcMain: Pick<IpcMain, "handle">, rooms: RoomSource): void {
  ipcMain.handle("front_page", (_event: IpcMainInvokeEvent) => frontPage(rooms));
  ipcMain.handle("front_page_suggestions", (_event: IpcMainInvokeEvent) =>
    frontPageSuggestions({ rooms })
  );
}
