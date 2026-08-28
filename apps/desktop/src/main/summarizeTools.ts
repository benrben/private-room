/**
 * "Summarize room" — the ADD-17/ADD-22/ADD-30 reduce pipeline. Ported from
 * `src-tauri/src/commands/summarize.rs` (387 lines, read in full, including
 * its `#[cfg(test)] mod tests`): {@link SUMMARY_FILE_NAME}/
 * {@link MAX_SUMMARY_FILES}, {@link isSummaryFile}, {@link summarizeOneFile}
 * (the map step — one file's one-line description), {@link combineSummary}
 * (the reduce step — the room's purpose paragraph + suggested questions), and
 * {@link writeRoomSummary} (assemble + save the one canonical
 * "Room summary.html").
 *
 * MIGRATION Phase 3 (per the Rust source's own comment on `summarize_one_file`):
 * the actual language-model compute — smart_filter, the `read_text` paging
 * loop, the structured final call, `clean_one_liner` — all live in the
 * Python sidecar behind `/summarize_file` and `/combine_summary` already.
 * Both functions here are thin proxies, exactly as their Rust originals are:
 * build the body, POST, unwrap the JSON. There is no new model-calling logic
 * to invent.
 *
 * NOT A MODEL TOOL: confirmed by grep, `summarize_room`/`write_room_summary`/
 * `summarize_one_file`/`combine_summary` have no `exec_tool` arm in
 * `agent.rs` and no entry in `toolSpecs.ts` — they are `pub(crate)` Rust
 * functions called only from `commands/jobs.rs`'s "Summarize room" button
 * driver (`spawn_deep_summary`) and, for `summarize_one_file` alone, from
 * `stt_cmds.rs`'s auto-index filler. Nothing in this file is wired into
 * `execTool.ts`.
 *
 * ============================================================================
 * KNOWN OVERLAP — `summarizeOneFile` vs. `workflowEngine.ts`'s
 * `summarizeOneFileViaSidecar`
 * ============================================================================
 * In Rust there is exactly ONE `summarize_one_file`, reused by both
 * `jobs.rs::summarize_one_liner` (the "Summarize room" map step) and
 * `stt_cmds.rs`'s auto-index filler. In this port that reuse is currently
 * duplicated: `workflowEngine.ts`'s `summarize_file` workflow node needed the
 * same thin proxy before this file (`summarize.rs`'s own port) existed, and
 * wrote its own copy (`summarizeOneFileViaSidecar`), hardcoding
 * `KEEP_ALIVE_WARM` where Rust's real signature takes `keep_alive` as a
 * parameter (needed so `stt_cmds.rs`'s call site can pass `KEEP_ALIVE_SHORT`
 * instead). {@link summarizeOneFile} here is the byte-faithful port of the
 * real four-plus-`keep_alive`-parameter signature. The two are NOT merged in
 * this batch — `workflowEngine.ts` belongs to an earlier, already-tested
 * batch, and rule 6 of this migration only authorizes touching `execTool.ts`
 * additively; collapsing the duplicate is future cleanup, flagged here rather
 * than silently left for someone to rediscover.
 *
 * ============================================================================
 * LOCAL COPIES, matching this port's own established convention
 * ============================================================================
 * `docHero`/`fileGlyph`: `docs_html.rs`'s originals. `docsHtml.ts` already
 * ports `docHero` — PRIVATE, unexported, with its own doc comment naming
 * `commands/summarize.rs` as the (until now) future caller that would need
 * to duplicate it rather than import it. `fileGlyph` has no port anywhere
 * yet (`docsHtml.ts`'s own doc lists it under "STILL NOT PORTED... a
 * different caller"). Both are duplicated here rather than exporting
 * `docsHtml.ts`'s private one — the same choice `sidecarJsonCancellable.ts`
 * documents making for its own local `isConnectionRefused` ("duplicated
 * locally rather than importing a non-exported helper... this port's
 * established convention for a small shared predicate").
 *
 * `storeFileBytes`/`EmitFn`/`emitSafely`: local copies matching the standing
 * convention `filePass.ts`, `organizeTools.ts`, `recBridge.ts`,
 * `safetyTools.ts` and `workflowEngine.ts` already establish independently
 * (`filePass.ts`'s own comment: "Small enough to inline rather than pull in
 * the rest of `files.rs`").
 *
 * ============================================================================
 * DEVIATIONS
 * ============================================================================
 * - No `tauri::Window`/`AppState`. {@link RoomSource} is this file's own
 *   minimal seam (the "declares minimal, explicitly-named seams" convention
 *   `jobs.ts`'s header documents) — NOT a reuse of `jobs.ts`'s `RoomSource`/
 *   `RoomHandle` or `turnEngine.ts`'s `OpenRoom`, because neither carries the
 *   room's display NAME, which `combineSummary`'s `room_name` argument and
 *   the generated page's title both need. `window.emit` becomes
 *   {@link WriteRoomSummaryDeps.emit}, an optional {@link EmitFn}.
 * - {@link WriteRoomSummaryDeps.combineSummary} is an injectable seam Rust's
 *   own `write_room_summary` signature has no equivalent of — added for the
 *   same reason `workflowEngine.ts`'s `SummarizeOneFileFn` and `jobs.ts`'s
 *   `RenderPodcastAudio` are injectable despite their Rust originals calling
 *   the real thing unconditionally: a unit test must be able to drive the
 *   room-pin / existing-file / capped-list logic without a live sidecar.
 *   Defaults to the real {@link combineSummary}, never a fabricated stand-in.
 * - `pinnedRoom` returns the whole {@link SummaryRoom} (Rust: `&'a Room`)
 *   rather than a nullable `Database.Database` the way `jobs.ts`'s
 *   `pinnedDb` does, because it must also preserve Rust's TWO DISTINCT error
 *   strings ("the room this job belongs to was closed" for a pin mismatch,
 *   "No room is open." for the unpinned/nothing-open case) — `pinnedDb`
 *   collapses both to a bare `null` and only supports the pinned case
 *   (`roomPath: string`, not `string | null`).
 *
 * ============================================================================
 * NOT PORTED
 * ============================================================================
 * `summarize_pages_past_first_window` — `#[ignore]`d in the Rust source
 * itself ("Needs a running Ollama with a tool-capable local model"), a live
 * end-to-end proof that the sidecar's own `read_text` paging loop really
 * drives past the first context window. It exercises the SIDECAR's internal
 * behavior, not anything this file computes, and has no meaning without a
 * live model — not ported, honestly, rather than faked as a mocked pass.
 *
 * `write_room_summary` itself has no caller yet in this migration:
 * `jobs.rs`'s `spawn_deep_summary`/`start_deep_summary_inner` (the
 * "Summarize room" button's job driver, the only Rust call site) is `jobs.ts`'s
 * own documented "WHAT IS DELIBERATELY OUT OF SCOPE" — it needs
 * `ollama::list_models`/`capabilities::runs_on_this_mac` (engine routing) and
 * `extraction::smart_filter`, neither ported yet. {@link writeRoomSummary} is
 * fully real and fully tested against a real fixture room, ready to be wired
 * in once that driver lands — the same "exists, ready to be wired, but
 * nothing calls it" shape `previewTools.ts`'s `registerPreviewIpc` documents
 * for itself.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import {
  currentDate,
  getFileMeta,
  getFileName,
  inTransaction,
  insertFile,
  listFilesForSummary,
  trashFile,
  updateFileContent,
  type FileMeta,
  type TrashActor,
} from "./db-host/files.js";
import { listMemories } from "./db-host/memories.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { createRoomFile, writeRoomFile } from "./workspace/roomContent.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { htmlDocument, htmlEscape } from "./docsHtml.js";
import { sidecarErrorSentinel, sidecarJsonCancellable } from "./sidecarJsonCancellable.js";

/** The one canonical, overwrite-in-place summary file (ADD-17). ADD-22: HTML
 * (the "Summarize room" button generates an HTML page rendered in the
 * sandboxed viewer). The legacy Markdown name is still recognized for
 * exclusion below. Ported verbatim from `SUMMARY_FILE_NAME`. */
export const SUMMARY_FILE_NAME = "Room summary.html";

/** Cap per run so a huge room stays within the small local context; the rest
 * are listed by name with a note. Ported verbatim from `MAX_SUMMARY_FILES`. */
export const MAX_SUMMARY_FILES = 50;

/** `commands::models::KEEP_ALIVE_WARM` — a plain literal, not a re-port of
 * that (unported) module: this port's established per-file convention (the
 * same local copy `filePass.ts`/`workflowEngine.ts` already carry). */
const KEEP_ALIVE_WARM = "30m";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ============================================================================
// is_summary_file
// ============================================================================

/**
 * True for the app's own generated summary file — excluded from its own
 * summary. Matches both the current HTML name and the legacy
 * "Room summary.md" so an old room's Markdown summary isn't fed back into
 * the new one. A user-uploaded file that happens to share the name is NOT
 * excluded (source must be "generated"). Ported verbatim from
 * `is_summary_file`.
 */
export function isSummaryFile(name: string, source: string): boolean {
  return (name === SUMMARY_FILE_NAME || name === "Room summary.md") && source === "generated";
}

// ============================================================================
// summarize_one_file — the map step (ADD-17/ADD-27)
// ============================================================================

/**
 * Describe a single file in one sentence. All of the compute — the sidecar's
 * smart_filter, the `read_text` paging when the file doesn't fit one window,
 * the final schema-constrained call, `clean_one_liner` — is byte-reproduced
 * in the sidecar's own `/summarize_file`; this posts the six fields it needs
 * and reads back `summary` (already clamped to <=200 chars, may be `""`).
 *
 * Throws the same sentinel the Rust `?` propagates: `OLLAMA_DOWN`,
 * `MODEL_MISSING:<model>`, or a `Local AI error (…): …` line — only for a
 * FATAL engine failure; the endpoint degrades internally to a samples-only
 * answer otherwise. `keepAlive` still lets the caller choose how long the
 * background filler keeps the model resident (CHG-22) vs. a short-lived
 * caller that wants it released promptly.
 *
 * Rust calls the non-cancellable `sidecar_json` here deliberately — a
 * `summarize_one_file` call that has started always runs to completion. A
 * fresh {@link CancelFlag} that nothing can flip reproduces exactly that
 * through the already-ported cancellable transport, matching
 * `workflowEngine.ts`'s `summarizeOneFileViaSidecar` reasoning for the same
 * choice, rather than duplicating a second POST client for one missing
 * feature.
 */
export async function summarizeOneFile(
  model: string,
  name: string,
  mime: string,
  text: string,
  keepAlive: string
): Promise<string> {
  const body = {
    model,
    name,
    text,
    mime,
    base_url: resolvedBaseUrl(),
    keep_alive: keepAlive,
  };
  const outcome = await sidecarJsonCancellable("/summarize_file", body, new CancelFlag());
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  if (outcome.kind === "stopped") {
    // Unreachable: the flag above is never handed to anything that could set
    // it. An honest branch rather than a cast that claims otherwise.
    throw new Error("STOPPED");
  }
  const summary = asRecord(outcome.value)?.summary;
  return typeof summary === "string" ? summary : "";
}

// ============================================================================
// combine_summary — the reduce step (ADD-17)
// ============================================================================

/** The shape {@link writeRoomSummary} needs from a reduce call — matches
 * {@link combineSummary}'s own signature, injectable for tests. */
export type CombineSummaryFn = (
  model: string,
  roomName: string,
  memories: readonly string[],
  fileLines: string
) => Promise<[purpose: string, questions: string[]]>;

/**
 * One call producing the "What this room is for" paragraph and up to three
 * suggested questions, given the per-file one-liners for context. The
 * deterministic file list is assembled by the caller ({@link writeRoomSummary}) —
 * never invented here.
 *
 * The two reduce calls (free-text purpose + string-array questions), the
 * context assembly and the questions cap all live in the sidecar's
 * `/combine_summary`. Error rule reproduced from Rust: the purpose call
 * propagates as a thrown sentinel; the questions call swallows to `[]`
 * inside the endpoint, so a thrown error here means the purpose call failed.
 * Ported verbatim from `combine_summary`.
 */
export const combineSummary: CombineSummaryFn = async (model, roomName, memories, fileLines) => {
  const body = {
    model,
    room_name: roomName,
    file_lines: fileLines,
    memories: [...memories],
    base_url: resolvedBaseUrl(),
    keep_alive: KEEP_ALIVE_WARM,
  };
  const outcome = await sidecarJsonCancellable("/combine_summary", body, new CancelFlag());
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  if (outcome.kind === "stopped") {
    // Unreachable — see summarizeOneFile's identical comment.
    throw new Error("STOPPED");
  }
  const rec = asRecord(outcome.value);
  const purpose = typeof rec?.purpose === "string" ? rec.purpose : "";
  const questionsRaw = rec?.questions;
  const questions = Array.isArray(questionsRaw)
    ? questionsRaw.filter((x): x is string => typeof x === "string")
    : [];
  return [purpose, questions];
};

// ============================================================================
// pinned_room
// ============================================================================

/** One open room, as much of it as this file needs — unlike `jobs.ts`'s
 * `RoomHandle`/`turnEngine.ts`'s `OpenRoom`, this carries the room's display
 * NAME (`combineSummary`'s `room_name` argument and the generated page's
 * title both need it). See this module's own doc for why it is not reused
 * from either sibling seam. */
export interface SummaryRoom {
  db: Database.Database;
  path: string;
  name: string;
  workspace?: WorkspaceService;
}

/** Minimal stand-in for `tauri::State<'_, AppState>`'s room access, scoped to
 * exactly what this file needs: the currently open room, or `null`. */
export interface RoomSource {
  current(): SummaryRoom | null;
}

/**
 * Resolve the open room, honoring an optional pin (the path of the room the
 * caller started in). With a pin, a room that was closed or swapped mid-run
 * counts as gone — the caller's writes must never land in whatever room
 * happens to be open NOW. Ported verbatim from `pinned_room`.
 *
 * Throws "the room this job belongs to was closed" for a pin that names a
 * DIFFERENT room than the one open now (including none open at all), and
 * "No room is open." only for the unpinned case with nothing open — the two
 * distinct sentences Rust's `Result<&Room, String>` carries, preserved
 * exactly rather than collapsed to one generic refusal.
 */
export function pinnedRoom(rooms: RoomSource, pin: string | null): SummaryRoom {
  const room = rooms.current();
  if (pin !== null) {
    if (room !== null && room.path === pin) {
      return room;
    }
    throw new Error("the room this job belongs to was closed");
  }
  if (room !== null) {
    return room;
  }
  throw new Error("No room is open.");
}

// ============================================================================
// write_room_summary
// ============================================================================

/** Best-effort UI notification — the same narrow local contract ~16 other
 * files in this port already establish independently (`filePass.ts`'s own
 * comment: "until the day these collapse onto one shared module"). */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = w.emit(...)`.
  }
}

/** `store_file_bytes` (`commands/files.rs`) — snapshot the file's current
 * state into history, then overwrite it. Local copy; see this module's own
 * doc for why (the `filePass.ts`/`organizeTools.ts` convention). */
function storeFileBytes(db: Database.Database, id: string, bytes: Uint8Array, text: string | null, cause: string): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

/** Rust's `existing_id.filter(|id| db::get_file_name(&room.conn, id).is_ok())` —
 * a NULL blob (never actually stored) or a genuinely missing/trashed row
 * both read as "not there". */
function fileStillFindableById(db: Database.Database, id: string): boolean {
  try {
    getFileName(db, id);
    return true;
  } catch {
    return false;
  }
}

/** An emoji glyph for a file, chosen by extension, so each row of the
 * summary's file list reads at a glance. Ported verbatim from `file_glyph`
 * (`docs_html.rs`) — not ported anywhere else yet (`docsHtml.ts`'s own doc
 * lists it under "STILL NOT PORTED... a different caller"; this is that
 * caller). `pub(crate)` in Rust, so exported here too for a future caller to
 * reuse rather than re-derive. */
export function fileGlyph(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  switch (ext) {
    case "pdf":
      return "\u{1F4D5}"; // 📕
    case "csv":
    case "tsv":
    case "xls":
    case "xlsx":
    case "numbers":
      return "\u{1F4CA}"; // 📊
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "heic":
    case "tiff":
      return "\u{1F5BC}\u{FE0F}"; // 🖼️
    case "mp3":
    case "m4a":
    case "wav":
    case "aac":
    case "flac":
    case "ogg":
    case "aiff":
      return "\u{1F3A7}"; // 🎧
    case "mp4":
    case "mov":
    case "mkv":
    case "webm":
    case "avi":
      return "\u{1F3AC}"; // 🎬
    case "html":
    case "htm":
      return "\u{1F310}"; // 🌐
    case "md":
    case "markdown":
    case "txt":
    case "rtf":
      return "\u{1F4DD}"; // 📝
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "xml":
      return "\u{1F5C2}\u{FE0F}"; // 🗂️
    case "zip":
    case "tar":
    case "gz":
    case "7z":
      return "\u{1F5DC}\u{FE0F}"; // 🗜️
    case "doc":
    case "docx":
    case "pages":
      return "\u{1F4D8}"; // 📘
    case "ppt":
    case "pptx":
    case "key":
      return "\u{1F4FD}\u{FE0F}"; // 📽️
    default:
      return "\u{1F4C4}"; // 📄
  }
}

/** A polished document header: an uppercase accent eyebrow, a large title, an
 * optional muted subline, and an accent rule. Local copy of `docsHtml.ts`'s
 * own private `docHero` — see this module's own doc for why (that file's doc
 * comment names `commands/summarize.rs` as exactly this future caller, and
 * deliberately leaves it unexported). Ported verbatim from `doc_hero`. */
function docHero(eyebrow: string, title: string, subHtml: string): string {
  let h = '<header class="hero">\n';
  if (eyebrow !== "") {
    h += `<div class="eyebrow">${htmlEscape(eyebrow)}</div>\n`;
  }
  h += `<h1>${htmlEscape(title)}</h1>\n`;
  if (subHtml.trim() !== "") {
    h += `<p class="sub">${subHtml}</p>\n`;
  }
  h += '<div class="rule"></div>\n</header>\n';
  return h;
}

/** {@link writeRoomSummary}'s injectable seams — see this module's own doc
 * for why {@link combineSummary} is injectable despite Rust's own signature
 * having no equivalent parameter. */
export interface WriteRoomSummaryDeps {
  emit?: EmitFn;
  combineSummary?: CombineSummaryFn;
}

/** `{display, liner}` for one file — `folder/name` when foldered, plain name
 * otherwise. Local helper; ported inline from the two identical `match &f.folder`
 * arms `write_room_summary` repeats (the initial pass and the capped tail). */
function displayName(f: { name: string; folder: string | null }): string {
  return f.folder !== null ? `${f.folder}/${f.name}` : f.name;
}

/**
 * Reduce + write: assemble "Room summary.html" from the CACHED per-file
 * one-liners and save it into the room. The cache is expected to already be
 * filled by the (not yet ported) ADD-30 deep-summary job or `#summarize` —
 * so this makes exactly two model calls (via {@link combineSummary}: purpose
 * + questions) regardless of room size.
 *
 * `pin` guards EVERY room access here: the reduce awaits a model call that
 * can take minutes, and a room swapped in that window must error out, never
 * receive the old room's summary. Ported verbatim from `write_room_summary`,
 * re-acquiring {@link pinnedRoom} at the same three points the Rust source
 * re-locks `state.room`: once to gather context, once (after the reduce
 * await) to read `saved_date`, and once more, immediately before the write,
 * to re-check the existing summary file is still findable by id — a summary
 * deleted from the Library during the multi-minute reduce must not be
 * silently resurrected by a by-id write into its now-trashed row.
 */
export async function writeRoomSummary(
  rooms: RoomSource,
  model: string,
  pin: string | null,
  deps: WriteRoomSummaryDeps = {}
): Promise<FileMeta> {
  const combine = deps.combineSummary ?? combineSummary;

  const room0 = pinnedRoom(rooms, pin);
  const all = listFilesForSummary(room0.db);
  const existingRow = all.find((f) => f.name === SUMMARY_FILE_NAME && f.source === "generated");
  const legacyRow = all.find((f) => f.name === "Room summary.md" && f.source === "generated");
  const legacyMdId = legacyRow?.id ?? null;
  const files = all.filter((f) => !isSummaryFile(f.name, f.source));
  const memories = listMemories(room0.db).map((m) => m.content);
  const roomName = room0.name;

  if (files.length === 0) {
    throw new Error("This room has no files to summarize yet.");
  }
  const capped = files.length > MAX_SUMMARY_FILES;

  // `fileLines` is the text context handed to the reduce step; `fileItems`
  // (display, one-liner) drives the deterministic HTML file list.
  let fileLines = "";
  const fileItems: Array<[string, string | null]> = [];
  for (const f of files.slice(0, MAX_SUMMARY_FILES)) {
    const display = displayName(f);
    const liner = f.aiSummary !== null ? f.aiSummary.trim() : "";
    if (liner !== "") {
      fileLines += `- ${display} — ${liner}\n`;
      fileItems.push([display, liner]);
    } else {
      fileLines += `- ${display} (${f.mime})\n`;
      fileItems.push([display, null]);
    }
  }

  // Reduce: purpose paragraph + suggested questions, on ONLY the summarized
  // files' one-liners — the beyond-cap name-only tail is for the
  // deterministic "## Files" section and is appended AFTER, so it never
  // crowds the context the model actually needs here.
  const [purpose, questions] = await combine(model, roomName, memories, fileLines);

  if (capped) {
    for (const f of files.slice(MAX_SUMMARY_FILES)) {
      fileItems.push([displayName(f), null]);
    }
  }

  // Re-acquire: the reduce just awaited a model call that can take minutes.
  const savedDate = currentDate(pinnedRoom(rooms, pin).db);

  // ADD-22: assemble a self-contained HTML page (rendered in the sandboxed,
  // network-blocked viewer). Purpose + questions come from the model as
  // guaranteed fields; the file list is deterministic. Everything is escaped.
  let body = docHero("Room summary", roomName, `Generated on ${htmlEscape(savedDate)}`);
  body += "<h2>What this room is for</h2>\n";
  body += `<div class="lead-wrap"><p class="lead">${
    purpose === "" ? "A personal document room." : htmlEscape(purpose)
  }</p></div>\n`;
  body += `<h2>Files <span class="count">${fileItems.length}</span></h2>\n<ul class="files">\n`;
  for (const [display, liner] of fileItems) {
    const icon = fileGlyph(display);
    if (liner !== null) {
      body +=
        `<li><span class="ic">${icon}</span><div><div class="nm">${htmlEscape(display)}</div>` +
        `<div class="ds">${htmlEscape(liner)}</div></div></li>\n`;
    } else {
      body += `<li><span class="ic">${icon}</span><div><div class="nm">${htmlEscape(display)}</div></div></li>\n`;
    }
  }
  body += "</ul>\n";
  if (capped) {
    body += `<p class="note">Only the first ${MAX_SUMMARY_FILES} files were summarized; the rest are listed by name.</p>\n`;
  }
  if (questions.length > 0) {
    body += '<h2>Try asking</h2>\n<ol class="asks">\n';
    for (const q of questions) {
      body += `<li>${htmlEscape(q)}</li>\n`;
    }
    body += "</ol>\n";
  }
  const content = htmlDocument(`${roomName} — Room summary`, body);

  // Phase 3 (locked): write the ONE canonical summary file — overwrite in
  // place (ADD-2 keeps the previous versions) or create it the first time.
  // Re-acquire once more, immediately before the write.
  const room1 = pinnedRoom(rooms, pin);
  // `existingRow` was read BEFORE the reduce, which awaits the model for
  // minutes — long enough for the user to delete the old summary in the
  // Library. A by-id write would happily fill the trashed row, and the
  // metadata read that follows is trash-aware and would then fail: an error
  // on screen over a file that was silently rewritten where nobody can see
  // it. Ask again, the same trash-aware way, and write a new summary when
  // the old one is gone.
  const existingId =
    existingRow !== undefined && fileStillFindableById(room1.db, existingRow.id) ? existingRow.id : null;
  const bytes = Buffer.from(content, "utf8");
  let meta: FileMeta;
  if (existingId !== null) {
    meta = room1.workspace === undefined
      ? (storeFileBytes(room1.db, existingId, bytes, content, "Summarized"), getFileMeta(room1.db, existingId))
      : await writeRoomFile(room1, existingId, bytes, content, "Summarized");
  } else {
    meta = room1.workspace === undefined
      ? insertFile(room1.db, SUMMARY_FILE_NAME, "text/html", bytes, content, "generated")
      : await createRoomFile(room1, SUMMARY_FILE_NAME, "text/html", bytes, content, "generated");
  }
  // ADD-22: drop the legacy Markdown summary so only the HTML one remains.
  // Trashed, not destroyed, and labelled with the command that did it: this
  // is the app removing a file the user never asked it to remove, which is
  // precisely the case the trash exists to make visible and undoable.
  if (legacyMdId !== null) {
    const actor: TrashActor = { kind: "app", what: "summarize_room" };
    try {
      if (room1.workspace === undefined) trashFile(room1.db, legacyMdId, actor);
      else await room1.workspace.trash(legacyMdId);
    } catch {
      // Best-effort, mirrors Rust's `let _ = db::trash_file(...)`.
    }
  }
  emitSafely(deps.emit, "room-files-changed", undefined);
  return meta;
}
