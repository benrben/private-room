/**
 * Moonshot D5/D6/D7 + the generic UI-text pipe: the 14-entry AI-actions menu
 * (Summarize/Analyze/…/Research/Compare/…), the after-a-turn "worth
 * remembering?" prompt, the Smart-import file-metadata suggester, and the
 * shared `generate_ui_text` conduit several UI surfaces use for a short
 * model-authored line. Ported from
 * `src-tauri/src/commands/moonshot/ai_actions.rs` (539 lines, read in full,
 * including its `#[cfg(test)] mod tests`).
 *
 * `moonshot.rs` (the top-level dispatcher, read first per this batch's own
 * instructions) holds three things — `resolve_structured_model`,
 * `recommended_models` and `ensure_embed_model`. A CONCURRENT batch ported
 * that whole file as `moonshotCmds.ts` while this one was in flight (its own
 * module doc names exactly this situation: "the day one of the six
 * submodules above gets ported, it can import this directly"). This file
 * does that: {@link resolveStructuredModel} is imported from `moonshotCmds.ts`
 * rather than re-derived — see "SHARED HELPERS" below for the room-shape
 * adapter that requires. `recommendedModels`/`ensureEmbedModel` (D1/D2)
 * belong to no submodule `ai_actions.rs` touches and stay out of scope here.
 *
 * NOT MODEL-INVOCABLE. Verified by reading `agent.rs`'s whole `exec_tool`
 * match-arm list and `toolSpecs.ts`'s `BUILTIN_TOOL_NAMES`: neither has an
 * `"ai_action"`/`"memory_suggestion"`/`"suggest_file_meta"`/
 * `"generate_ui_text"` arm anywhere. All four are plain `#[tauri::command]`s
 * the FRONTEND calls directly (the AI-actions menu, the post-turn "Remember
 * this?" chip, Smart import, and a handful of UI-text call sites) — so this
 * batch makes no change to `execTool.ts`, per this batch's own conditional
 * instruction ("if so wire it in").
 *
 * ============================================================================
 * SHARED HELPERS PORTED HERE, NOT ELSEWHERE — AND WHY THAT IS HONEST
 * ============================================================================
 * `ai_actions.rs` itself calls several small functions that live in OTHER,
 * still-unported (or, for `resolve_structured_model`, now separately-ported)
 * Rust files. Each is a short, pure (or nearly pure) function this file can
 * port VERBATIM without dragging in the rest of its home file, so each is
 * ported here — the same "port the minimal real slice, name where it came
 * from" choice `chatCommandsKnowledge.ts` made for `save_and_open` and
 * `docsHtml.ts` made for `title_from_name`'s neighbours:
 *
 *   - {@link gatherScopeText}/{@link gatherFilesText}/{@link safeScopeName}/
 *     {@link studioInstruction} — `commands/studios.rs`. That file (844
 *     lines: the flashcards/mind-map/podcast pipeline) is NOT ported this
 *     batch; only the four small text-gathering/naming helpers `ai_actions.rs`
 *     actually calls are, verbatim.
 *   - `registerAiActionCancel` (private) — a direct port of
 *     `studios.rs::register_studio_cancel`, ALWAYS called with `parent_run:
 *     None` from `ai_action` (an AI action has no parent run — it starts from
 *     a file/room header, never from inside another turn), so the `parent_run`
 *     parameter is dropped rather than plumbed through unused.
 *   - `saveAndOpen` (private) — a direct port of `docs_html.rs::save_and_open`,
 *     duplicated rather than imported from a hypothetical shared copy for the
 *     same reason `chatCommandsKnowledge.ts` gives for its own copy: it is
 *     four lines, and every existing copy lives inside a much larger,
 *     unrelated file.
 *   - `isSummaryFile` (private) — a direct port of
 *     `commands/summarize.rs::is_summary_file` (2 lines), needed by
 *     {@link gatherScopeText}'s whole-room branch to exclude the app's own
 *     generated room summary from being summarized/analyzed/etc. again.
 *     `moonshotFrontPage.ts` (the concurrent batch above) carries an identical
 *     private copy for the identical reason — this port's established
 *     "duplicate a small pure predicate rather than import across an
 *     unrelated file" convention (`storyTools.ts`'s own doc names it), not an
 *     oversight.
 *
 * `resolveStructuredModel` ITSELF is NOT re-derived here: `moonshotCmds.ts`
 * (the concurrent port of `moonshot.rs`, the dispatcher these submodules
 * live under) now carries the real one, and this file imports it — see the
 * ROOM-SHAPE ADAPTER note below for the one wrinkle that creates.
 *
 * ============================================================================
 * ROOM-SHAPE ADAPTER: this file's `RoomSource` vs `moonshotCmds.ts`'s
 * ============================================================================
 * `moonshotCmds.ts::resolveStructuredModel` takes a `RoomSource` whose
 * `currentRoom()` returns `turnEngine.ts`'s `OpenRoom` (`{db, path}` only).
 * This file's own `gatherScopeText` whole-room branch additionally needs the
 * room's NAME (`commands.rs::Room.name`, cached at open/rename time) as the
 * whole-room label's fallback — a field `OpenRoom` does not carry. Rather
 * than widen `OpenRoom` itself (out of scope: `turnEngine.ts` is a committed
 * file from an earlier batch) or duplicate a second `resolveStructuredModel`,
 * this file's {@link RoomHandle} EXTENDS `OpenRoom` with `name`, and its
 * {@link RoomSource} is passed to the imported `resolveStructuredModel`
 * as-is: a `currentRoom(): RoomHandle | null` is structurally assignable to
 * the `currentRoom(): OpenRoom | null` that function expects (return-type
 * covariance — `RoomHandle` is an `OpenRoom` plus one field), so no adapter
 * function is actually needed at the call site, only the type extension.
 *
 * REUSED, not re-derived — every one of these already has a real Electron
 * port this batch imports rather than shadows:
 *   - `resolveStructuredModel` (`moonshotCmds.ts` — see the ROOM-SHAPE
 *     ADAPTER note above), `resolvedBaseUrl`/`listModels` (`engineRouting.ts`,
 *     the default it wraps).
 *   - `runsOnThisMac` (`capabilities.ts`), `clampBytes` (`textClamp.ts`),
 *     `titleFromName` (`docsHtml.ts`), `stripMarkupBlocks` (`db-host/retrieval.ts`),
 *     `isFailureNotice` (`turnNotices.ts`), `emitUnowned`/`EventSender`
 *     (`turn.ts` — that file's own doc names `ai_action` as the reason
 *     `emitUnowned` exists at all: "today only the AI-actions menu command,
 *     which runs from the file header and belongs to no conversation at
 *     all"), `CancelFlag`/`CancelState`/`childOfRun`/`remember`/`forget`/
 *     `guardCommit` (`cancel.ts`), `Artifact`/`Written` (`artifactBuilder.ts`),
 *     `sidecarJsonCancellable`/`sidecarErrorSentinel` (`sidecarJsonCancellable.ts`),
 *     `getFileName`/`getFileExtractedText`/`listFiles`/`type FileMeta`
 *     (`db-host/files.ts`), `listMessages`/`type Message` (`db-host/messages.ts`),
 *     `getSetting` transitively via `modelSetting`.
 *   - {@link AiActionDef}/{@link MemorySuggestion}/{@link FileMetaSuggestion} —
 *     already declared, camelCase and field-for-field with the Rust structs,
 *     in `../shared/apiTypes.ts` (the `storyTools.ts`/`bulkReport.ts`
 *     convention for a wire shape that already exists there); `AiActionDef`'s
 *     `scope: "file" | "room"` union is reused as-is rather than widened to
 *     `string`.
 *
 * EVERYTHING IN THIS FILE IS REAL — no `NOT_IMPLEMENTED` stub anywhere. Every
 * MIGRATION-Phase-3 comment in the Rust source ("the prompt table / schema /
 * model call / markdown extraction all live in the sidecar's /ai_action") was
 * already true on the Rust side before this port even started: Rust's own
 * `ai_action`/`memory_suggestion`/`suggest_file_meta`/`generate_ui_text`
 * commands are themselves thin — DB gather, model resolution, one HTTP POST
 * to an already-real sidecar endpoint, one save — and every one of those
 * pieces now has a real Electron counterpart, so nothing here degrades to a
 * fabrication or a refusal.
 *
 * ONE KNOWN, DELIBERATE SIMPLIFICATION: Rust's `state.with_room` wraps every
 * DB error through `humanize_storage_error` (a room-specific "your disk/
 * permissions" rewrite). No Electron port of that wrapper exists anywhere in
 * this migration yet, and every sibling file that reads through a
 * `RoomSource` (`storyTools.ts`, `chatCommandsKnowledge.ts`, `feedbackTools.ts`,
 * …) already accepts the same gap — a storage failure here surfaces as
 * whatever the `better-sqlite3` driver itself throws, not the humanized
 * sentence. Not a fidelity concern for the actual FEATURE behavior this batch
 * owns (the DB layer under it is real and errors for real; only the wording
 * of a rare storage-layer failure is unwrapped).
 *
 * Per rule 4 (this batch's own instructions) and `recIpc.ts`'s precedent,
 * {@link registerMoonshotAiActionsIpc} is declared and directly tested but
 * NOT wired into any bootstrap file.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { AiActionDef, FileMetaSuggestion, MemorySuggestion } from "../shared/apiTypes.js";
import { Artifact, type Written } from "./artifactBuilder.js";
import { runsOnThisMac } from "./capabilities.js";
import {
  CancelFlag,
  childOfRun,
  forget,
  guardCommit,
  remember,
  type CancelState,
  type Node as CancelNode,
} from "./cancel.js";
import { getFileExtractedText, getFileName, listFiles, type FileMeta } from "./db-host/files.js";
import { listMessages, type Message } from "./db-host/messages.js";
import { stripMarkupBlocks } from "./db-host/retrieval.js";
import { titleFromName } from "./docsHtml.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { resolveStructuredModel } from "./moonshotCmds.js";
import {
  sidecarErrorSentinel,
  sidecarJsonCancellable,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";
import { clampBytes } from "./textClamp.js";
import { isFailureNotice } from "./turnNotices.js";
import { emitUnowned, type EventSender } from "./turn.js";
import type { OpenRoom } from "./turnEngine.js";

export type { AiActionDef, FileMetaSuggestion, MemorySuggestion };

// ============================================================================
// room access — `currentRoom()`, matching `moonshotCmds.ts`'s/`recIpc.ts`'s/
// `turnEngine.ts`'s convention (this file is a sibling command-and-IPC layer
// in the same "moonshot" family, not a `jobs.ts`-style background runner) —
// see the module doc's ROOM-SHAPE ADAPTER note for why `RoomHandle` extends
// `OpenRoom` rather than reusing it unmodified.
// ============================================================================

/** `commands.rs::Room`, the one field beyond `OpenRoom` this file reads:
 * `name`, cached at open/rename time — `gatherScopeText`'s whole-room branch
 * falls back to it. */
export interface RoomHandle extends OpenRoom {
  name: string;
}

/** `commands.rs::Room` access, plus the ONE `AppState` flag `ai_action`
 * itself checks before starting: `state.rolling_back()` (Wave 3, Idea 9) — a
 * DB rollback is mid-swap, so no new AI action may begin. Default: not
 * rolling back, mirroring `turnEngine.ts`'s `TurnRoomSource.rollingBack?`. */
export interface RoomSource {
  currentRoom(): RoomHandle | null;
  rollingBack?(): boolean;
}

const NO_ROOM_OPEN = "No room is open.";

function requireRoom(rooms: RoomSource): RoomHandle {
  const room = rooms.currentRoom();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return room;
}

// ============================================================================
// studios.rs's small text-gathering/naming helpers — the exact slice
// `ai_actions.rs` calls. See this module's own doc.
// ============================================================================

/** `commands/summarize.rs::is_summary_file` (`SUMMARY_FILE_NAME` inlined —
 * two lines, ported verbatim rather than importing a whole unported module
 * for one string comparison). True for the app's own generated room-summary
 * file, current HTML name or the legacy Markdown one, but only when it was
 * actually GENERATED — a user file that merely shares the name is not
 * excluded. */
function isSummaryFile(name: string, source: string): boolean {
  return (name === "Room summary.html" || name === "Room summary.md") && source === "generated";
}

/** The byte cap every gathered blob (whole document, whole-room digest, or
 * @-ref concatenation) is held to before it reaches a model call. Ported
 * verbatim from `studios.rs`'s repeated `12_000` literal. */
const SCOPE_TEXT_CAP = 12_000;
/** Per-file cap inside the whole-room digest — `studios.rs`'s `1500`. */
const WHOLE_ROOM_PER_FILE_CAP = 1_500;
/** Per-file cap inside an @-ref concatenation — `studios.rs`'s `3000`. */
const REFS_PER_FILE_CAP = 3_000;

/**
 * Gather the text an AI action works over: one file (`scope` names a file
 * id) or a slice of the whole room (`scope` is `null`). Ported verbatim from
 * `studios.rs::gather_scope_text`. Returns `[label, text]`, or throws the
 * exact sentence the frontend toasts when there is nothing readable.
 */
export function gatherScopeText(
  db: Database.Database,
  scope: string | null,
  roomName: string
): [string, string] {
  if (scope !== null) {
    const name = getFileName(db, scope);
    const text = getFileExtractedText(db, scope) ?? "";
    if (text.trim() === "") {
      throw new Error(`"${name}" has no readable text to work with.`);
    }
    return [titleFromName(name), clampBytes(text, SCOPE_TEXT_CAP)];
  }
  let blob = "";
  for (const f of listFiles(db)) {
    if (isSummaryFile(f.name, f.source)) {
      continue;
    }
    if (Buffer.byteLength(blob, "utf8") >= SCOPE_TEXT_CAP) {
      break;
    }
    const t = getFileExtractedText(db, f.id);
    if (t === null || t.trim() === "") {
      continue;
    }
    blob += `## ${f.name}\n${clampBytes(t, WHOLE_ROOM_PER_FILE_CAP)}\n\n`;
  }
  if (blob.trim() === "") {
    throw new Error("This room has no readable text to work with yet.");
  }
  return [roomName, blob];
}

/**
 * Gather readable text from an explicit set of file ids — the files/folders
 * the user @-mentioned. Ported verbatim from `studios.rs::gather_files_text`.
 * A missing file id (`getFileName` throwing) is skipped, matching Rust's
 * `let Ok(name) = ... else { continue; }`.
 */
export function gatherFilesText(db: Database.Database, fileIds: readonly string[]): [string, string] {
  let blob = "";
  const names: string[] = [];
  for (const id of fileIds) {
    let name: string;
    try {
      name = getFileName(db, id);
    } catch {
      continue;
    }
    const text = getFileExtractedText(db, id);
    if (text === null || text.trim() === "") {
      continue;
    }
    if (Buffer.byteLength(blob, "utf8") >= SCOPE_TEXT_CAP) {
      break;
    }
    blob += `## ${name}\n${clampBytes(text, REFS_PER_FILE_CAP)}\n\n`;
    names.push(titleFromName(name));
  }
  if (blob.trim() === "") {
    throw new Error("The files you mentioned have no readable text to work with.");
  }
  const label = names.length === 1 ? names[0]! : `${names.length} files`;
  return [label, blob];
}

/** Characters a generated file name must not carry — path separators,
 * reserved punctuation, and line-breaking whitespace. Ported verbatim from
 * `studios.rs::safe_scope_name`'s match arm. */
const SCOPE_NAME_FORBIDDEN = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|", "\n", "\r", "\t"]);

/** Fold a scope label into a file-name-safe fragment. Ported verbatim from
 * `studios.rs::safe_scope_name`, including the 60-codepoint cap (Unicode
 * SCALAR VALUES via `[...cleaned]`, matching Rust's `chars().take(60)` —
 * never a UTF-16 `.slice(0, 60)`, which would cut an astral character in
 * half). */
export function safeScopeName(label: string): string {
  let folded = "";
  for (const ch of label) {
    folded += SCOPE_NAME_FORBIDDEN.has(ch) ? " " : ch;
  }
  const cleaned = folded
    .split(/\p{White_Space}+/u)
    .filter((w) => w !== "")
    .join(" ");
  const name = [...cleaned].slice(0, 60).join("").trim();
  return name === "" ? "room" : name;
}

/** The instruction to run with: the user's edited prompt if non-empty after
 * trimming, else the action's default. Ported verbatim from
 * `studios.rs::studio_instruction`. */
export function studioInstruction(supplied: string | null, defaultPrompt: string): string {
  const trimmed = supplied?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : defaultPrompt;
}

/**
 * `studios.rs::register_studio_cancel`, called from `ai_action` with
 * `parent_run` always `None` (an AI action starts from a file/room header,
 * never as a child of another run) — so that parameter is dropped here
 * rather than threaded through with one constant caller. Creates this
 * action's cancel-tree root, and — only when the frontend supplied an
 * `opId` — registers it in the SAME flat/tree registries chat's Stop uses,
 * so `cancelId(state, opId)` reaches it.
 */
function registerAiActionCancel(cancelState: CancelState, opId: string | null, label: string): CancelNode {
  const node = childOfRun(cancelState, null, label);
  if (opId !== null) {
    cancelState.cancels.set(opId, node.flag());
    remember(cancelState, opId, node);
  }
  return node;
}

/**
 * Read one field off a sidecar reply the way Rust reads it — `v["markdown"]`
 * on a `serde_json::Value`, which has no prototype chain to inherit from.
 *
 * A bare `v.markdown` on a `JSON.parse` result reads `Object.prototype`'s
 * `markdown` when the object has none of its own, and this codebase has found
 * a `"__proto__"`-keyed write polluting `Object.prototype` FIVE times. The
 * consequences here are not cosmetic: `ai_action` would SAVE the inherited
 * string into the room as the model's answer, `memory_suggestion` would offer
 * an invented fact behind a one-click Save-to-memory button (the exact live-QA
 * failure its own Rust doc comment records), and `generate_ui_text` would
 * render it as model-authored UI copy. `moonshotFrontPage.ts` already reads
 * its own `/label` reply this way; these four endpoints now match.
 */
function ownField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Best-effort raw (non-turn-enveloped) emit — matches Rust's bare `let _ =
 * window.emit(...)`. Named `EmitFn` per `chatCommandsKnowledge.ts`'s own
 * convention, though this file reuses ONE `EventSender` channel for both the
 * enveloped step chip and these raw events, exactly as Rust's `ai_action`
 * emits all three off the SAME `window`. */
function emitSafely(send: EventSender, event: string, payload: unknown): void {
  try {
    send(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

/**
 * `docs_html.rs::save_and_open`: commit a fresh artifact, then tell the
 * Files list to reload and the viewer to open it. Ported verbatim; see this
 * module's own doc for why it is duplicated here rather than imported.
 */
function saveAndOpen(rooms: RoomSource, send: EventSender, art: Artifact): Written {
  const room = requireRoom(rooms);
  const written = art.commit(room.db);
  emitSafely(send, "room-files-changed", undefined);
  emitSafely(send, "agent-open-file", { id: written.meta.id });
  return written;
}

// ============================================================================
// D5/D12: the 14 AI actions
// ============================================================================

/** One AI action's full definition, INCLUDING its default prompt — the same
 * shape the frontend sees (`ai_action_prompts` holds nothing back; the doc
 * comment on the Rust `AiActionSpec` about "the frontend sees only the
 * `AiActionDef` fields" is stale relative to the struct's actual fields,
 * which is why this port collapses the internal/external split into one
 * type rather than reproducing a distinction the Rust source itself no
 * longer draws). */
type AiActionSpec = AiActionDef;

/**
 * The 14 actions, in menu order: 9 file-scope, then 5 room-scope. Order and
 * the scope/needsQuestion/needsLanguage flags are the cross-agent contract
 * with the frontend — ported verbatim, string for string, from
 * `ai_actions.rs::AI_ACTIONS`.
 */
const AI_ACTIONS: readonly AiActionSpec[] = [
  // ---- file scope ----
  {
    id: "summarize",
    title: "Summarize",
    description: "A one-line TL;DR and the key points.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Summarize this material: a one-line TL;DR, then the key points as a short list.",
  },
  {
    id: "analyze",
    title: "Analyze",
    description: "Structure, themes, sentiment, risks, and open questions.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Analyze this material: its structure, main themes, sentiment, risks, and open questions.",
  },
  {
    id: "explain",
    title: "Explain",
    description: "A plain-language walkthrough of the material.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Explain this material in plain language, as if to a smart friend new to the topic.",
  },
  {
    id: "extract",
    title: "Extract",
    description: "Entities, dates, figures, and action items as a table.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Extract the entities, dates, figures, and action items from this material.",
  },
  {
    id: "outline",
    title: "Outline",
    description: "A clean nested outline of the points.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Turn this material into a clean, nested outline of its points.",
  },
  {
    id: "rewrite",
    title: "Rewrite",
    description: "A tightened, clearer version.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Rewrite this material into a tighter, clearer version that keeps every point.",
  },
  {
    id: "qa_pack",
    title: "Q&A pack",
    description: "Study question-and-answer pairs.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Write a set of study question-and-answer pairs covering this material.",
  },
  {
    id: "fact_check",
    title: "Fact check",
    description: "Flag claims the material doesn't support.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Fact-check this material and flag any claim it doesn't actually support.",
  },
  // ADD-27: translate any file (including a recording's transcript) into a
  // user-picked language. The language rides in the `question` parameter.
  {
    id: "translate",
    title: "Translate",
    description: "Translate the material into any language.",
    scope: "file",
    needsQuestion: false,
    needsLanguage: true,
    defaultPrompt: "Translate this material into the target language, keeping its structure.",
  },
  // ---- room scope ----
  {
    id: "research",
    title: "Research",
    description: "Answer a question with a cited synthesis of the room.",
    scope: "room",
    needsQuestion: true,
    needsLanguage: false,
    defaultPrompt: "Answer the question using this room, and cite the files you draw on.",
  },
  {
    id: "compare",
    title: "Compare",
    description: "Diff the files side by side.",
    scope: "room",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Compare these files side by side — what they agree on and where they differ.",
  },
  {
    id: "timeline",
    title: "Timeline",
    description: "A chronology from the dated mentions.",
    scope: "room",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Build a chronological timeline from the dated events mentioned in this material.",
  },
  {
    id: "themes",
    title: "Themes",
    description: "Group the material into topic clusters.",
    scope: "room",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Group this material into its main themes, with the points under each.",
  },
  {
    id: "gaps",
    title: "Gaps",
    description: "What's missing given the rest of the room.",
    scope: "room",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Given this room, point out what's missing or still unanswered.",
  },
];

/**
 * The catalog of AI actions for the frontend menu — the same list
 * {@link aiAction} runs, minus nothing (see {@link AiActionSpec}'s own doc).
 * Ported from `ai_action_prompts`. Returns a fresh array each call so a
 * caller can never mutate the shared roster.
 */
export function aiActionPrompts(): AiActionDef[] {
  return [...AI_ACTIONS];
}

// ============================================================================
// ai_action — run one action over a scope (or explicit @-refs) and save the
// Markdown result into the room.
// ============================================================================

/** `sidecar::sidecar_json_cancellable`'s signature, narrowed to what this
 * module calls it with — the same local-alias convention `feedbackTools.ts`'s
 * `SidecarPostFn` and `filePass.ts`'s establish for one shared type rather
 * than importing an unrelated module for it. */
type SidecarPostFn = (
  path: string,
  body: unknown,
  cancel: CancelFlag,
  timeoutMs?: number
) => Promise<SidecarPostOutcome>;

/** Dependencies every command in this file that talks to the sidecar shares:
 * which room is open, and the two network seams a test can fake. */
export interface AiSidecarDeps {
  rooms: RoomSource;
  /** `ollama::list_models()`. Defaults to the real, already-ported
   * `engineRouting.ts` implementation. */
  listModels?: () => Promise<string[]>;
  /** Defaults to the real {@link sidecarJsonCancellable}. */
  post?: SidecarPostFn;
}

/** {@link AiSidecarDeps}, plus the two seams only {@link aiAction} itself
 * needs: the cancel-tree registry chat's Stop shares, and the event channel
 * for the "ask-step" chip / `room-files-changed` / `agent-open-file`. */
export interface AiActionDeps extends AiSidecarDeps {
  cancelState: CancelState;
  send: EventSender;
}

/**
 * Run one AI action over a scope (or explicit @-refs) and save the Markdown
 * result into the room, returning its {@link FileMeta}. Ported from
 * `ai_action`. `refs` win over `scope` exactly when `refs` is non-empty —
 * Rust's `refs.as_ref().filter(|r| !r.is_empty())` filters on the WHOLE
 * vec's emptiness, not per-element, so a caller cannot opt back into
 * scope-gathering by sending an empty-string ref. `question` is used only by
 * `research`; `instructions` overrides the action's default prompt.
 */
export async function aiAction(
  deps: AiActionDeps,
  action: string,
  scope: string | null,
  refs: readonly string[] | null,
  instructions: string | null,
  question: string | null,
  // The frontend's id for this run, so Stop can reach it. `null` because the
  // agent's own tool path (were one ever added) has no button to press.
  opId: string | null
): Promise<FileMeta> {
  const spec = AI_ACTIONS.find((s) => s.id === action);
  if (spec === undefined) {
    throw new Error(`"${action}" isn't a known AI action.`);
  }
  // Wave 3 (Idea 9): don't start one while a rollback is swapping the DB.
  if (deps.rooms.rollingBack?.() ?? false) {
    throw new Error("The room is rolling back — try again in a moment.");
  }
  const node = registerAiActionCancel(deps.cancelState, opId, spec.title);
  const cancel = node.flag();
  try {
    const instr = studioInstruction(instructions, spec.defaultPrompt);
    const room = requireRoom(deps.rooms);
    const [label, text] =
      refs !== null && refs.length > 0 ? gatherFilesText(room.db, refs) : gatherScopeText(room.db, scope, room.name);

    const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
    if (model === undefined) {
      throw new Error("The local AI (Ollama) isn't running — start it and try again.");
    }

    // Say where the material is going, exactly as a Studio run does. Owner
    // replacement #4: started from the file header and belongs to no
    // conversation, so its chip is emitted UNOWNED (null ids) rather than
    // borrowed from whichever chat happens to be open.
    emitUnowned(
      deps.send,
      "ask-step",
      runsOnThisMac(model)
        ? spec.title
        : `${spec.title} — your cloud AI is working (content leaves this Mac)…`
    );

    const body = {
      model,
      action: spec.id,
      text,
      instructions: instr,
      question,
      base_url: resolvedBaseUrl(),
    };
    const post = deps.post ?? sidecarJsonCancellable;
    const outcome = await post("/ai_action", body, cancel);
    const notSavedWhat = `the ${spec.title} result`;
    if (outcome.kind === "stopped") {
      // Stop for a one-shot endpoint IS dropping the request: the sidecar
      // side cancels the task and actually ends the generation. Same
      // "nothing was saved" contract every other stopped write uses.
      throw new Error(`Stopped — ${notSavedWhat} was not saved.`);
    }
    if (outcome.kind === "error") {
      // NEEDS_LANGUAGE / EMPTY_RESULT / UNKNOWN_ACTION carry the exact toast
      // string as `error` — surfaced verbatim; any real engine failure maps
      // to the usual OLLAMA_DOWN / MODEL_MISSING:<model> sentinel.
      const { code, error } = outcome.error;
      if (code === "UNKNOWN_ACTION" || code === "NEEDS_LANGUAGE" || code === "EMPTY_RESULT") {
        throw new Error(error);
      }
      throw new Error(sidecarErrorSentinel(outcome.error, model));
    }
    // Stopped between the answer arriving and the save: nothing lands. Same
    // commit-time rule every other write-side effect uses.
    const guard = guardCommit(cancel, notSavedWhat);
    if (!guard.ok) {
      throw new Error(guard.error);
    }
    const markdown = ownField(outcome.value, "markdown");
    const content = typeof markdown === "string" ? markdown : "";
    const name = `${spec.title} - ${safeScopeName(label)}.md`;
    // ART-1: re-running the same action over the same scope versions the
    // earlier result instead of leaving two files nobody can tell apart. No
    // `.fromFiles(refs)`/`.cancelWith(cancel)` — Rust's own `Artifact::new(..)
    // .by(spec.title)` calls neither (the cancel flag was already checked
    // immediately above via `guardCommit`).
    const written = saveAndOpen(
      deps.rooms,
      deps.send,
      Artifact.new(name, "text/markdown", content).by(spec.title)
    );
    return written.meta;
  } finally {
    // `CancelGuard::drop` removes BOTH halves on every exit path — success,
    // thrown error, or Stop — but only when an `opId` was actually
    // registered (a `null` opId never touched either registry).
    if (opId !== null) {
      deps.cancelState.cancels.delete(opId);
      forget(deps.cancelState, opId);
    }
  }
}

// ============================================================================
// D6: memory suggestion
// ============================================================================

function noMemorySuggestion(): MemorySuggestion {
  return { worth: false, fact: "" };
}

/** The newest message of one role, stripped of viewer markup blocks — or
 * `null` when the chat has none. Two independent backward scans, matching
 * Rust's own two independent `.iter().rev().find(...)` calls. */
function lastByRole(msgs: readonly Message[], role: string): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === role) {
      return stripMarkupBlocks(msgs[i]!.content);
    }
  }
  return null;
}

/**
 * D6: after an exchange, judge whether a single durable fact is worth saving
 * to the room's long-term memory. Never writes memory itself — the frontend
 * confirms, then calls the existing add-memory command. Ported from
 * `memory_suggestion`. Model down / no exchange / a failure notice / any
 * sidecar failure all degrade to "not worth remembering", never an error.
 */
export async function memorySuggestion(deps: AiSidecarDeps, chatId: string): Promise<MemorySuggestion> {
  const room = requireRoom(deps.rooms);
  const msgs = listMessages(room.db, chatId);
  const lastUser = lastByRole(msgs, "user");
  const lastAssistant = lastByRole(msgs, "assistant");
  if (lastUser === null || lastAssistant === null) {
    return noMemorySuggestion();
  }
  // A turn that produced no answer has nothing worth remembering, and the
  // suggester cannot tell: what it receives as "the assistant's answer" is
  // Arcelle's own failure notice.
  if (isFailureNotice(lastAssistant)) {
    return noMemorySuggestion();
  }
  const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
  if (model === undefined) {
    return noMemorySuggestion();
  }
  const body = {
    model,
    base_url: resolvedBaseUrl(),
    user_text: lastUser,
    assistant_text: lastAssistant,
  };
  const post = deps.post ?? sidecarJsonCancellable;
  const outcome = await post("/memory_suggestion", body, new CancelFlag());
  if (outcome.kind !== "value") {
    // Rust's `Err(_) => Ok(default)` folds ANY sidecar failure to "not worth
    // saving" — including "stopped", unreachable here since the flag above
    // is never set.
    return noMemorySuggestion();
  }
  const worth = ownField(outcome.value, "worth");
  const fact = ownField(outcome.value, "fact");
  return {
    worth: typeof worth === "boolean" ? worth : false,
    fact: typeof fact === "string" ? fact : "",
  };
}

// ============================================================================
// D7: suggest file metadata
// ============================================================================

/**
 * D7: propose a tidy title, one folder, and a few tags for a file, over the
 * first ~2000 chars of its text (clamped sidecar-side). Suggestion only —
 * the frontend applies it via the existing rename/folder/move commands.
 * Ported from `suggest_file_meta`. Model down / too little text / any
 * sidecar failure all echo the current name with an empty folder and no
 * tags, never an error.
 */
export async function suggestFileMeta(deps: AiSidecarDeps, fileId: string): Promise<FileMetaSuggestion> {
  const room = requireRoom(deps.rooms);
  const currentName = getFileName(room.db, fileId);
  const text = getFileExtractedText(room.db, fileId) ?? "";
  const echo = (): FileMetaSuggestion => ({ title: titleFromName(currentName), folder: "", tags: [] });
  // A rename/file-under proposal is only as good as the text behind it. A
  // failed or trivial extraction yields a few stray words — proposing
  // metadata from that reads as nonsense, so stay quiet instead. Counts
  // Unicode SCALAR VALUES, matching Rust's `chars().count()`.
  if ([...text.trim()].length < 80) {
    return echo();
  }
  const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
  if (model === undefined) {
    return echo();
  }
  const body = {
    model,
    base_url: resolvedBaseUrl(),
    current_name: currentName,
    text,
  };
  const post = deps.post ?? sidecarJsonCancellable;
  const outcome = await post("/suggest_file_meta", body, new CancelFlag());
  if (outcome.kind !== "value") {
    return echo();
  }
  const title = ownField(outcome.value, "title");
  const folder = ownField(outcome.value, "folder");
  const tags = ownField(outcome.value, "tags");
  return {
    title: typeof title === "string" ? title : "",
    folder: typeof folder === "string" ? folder : "",
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
  };
}

// ============================================================================
// generic adaptive UI text
// ============================================================================

/**
 * A small, generic "write me a short piece of adaptive UI text from local
 * facts" pipe, shared by several UI surfaces. This command owns NO
 * per-feature prompt wording — the caller composes `prompt` itself. Ported
 * from `generate_ui_text`. No local model resolvable, a dead sidecar, a
 * timeout, or the sidecar's own post-generation validation rejecting the
 * result are ALL the same outcome: `null`, never a thrown error — a missing
 * generation must render as "no generated text" (the caller's static
 * fallback), not as an app error. Needs no open room: {@link resolveStructuredModel}
 * degrades to the tuned default when none is.
 */
export async function generateUiText(
  deps: AiSidecarDeps,
  kind: string,
  prompt: string,
  facts: unknown,
  maxWords: number
): Promise<string | null> {
  const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
  if (model === undefined) {
    return null;
  }
  const body = {
    model,
    base_url: resolvedBaseUrl(),
    kind,
    prompt,
    facts,
    max_words: maxWords,
  };
  const post = deps.post ?? sidecarJsonCancellable;
  const outcome = await post("/generate_ui_text", body, new CancelFlag());
  if (outcome.kind !== "value") {
    return null;
  }
  const text = ownField(outcome.value, "text");
  return typeof text === "string" ? text : null;
}

// -------------------------------------------------------------- IPC (unwired)

/**
 * Register every channel this file owns on `ipcMain`. NOT wired into any
 * bootstrap file (rule 4) — it exists, ready to be wired, once a
 * preload/renderer batch needs it. Channel names and argument shapes match
 * `shared/ipc-contract.ts`'s existing `ai_action_prompts`/`ai_action`/
 * `memory_suggestion`/`suggest_file_meta`/`generate_ui_text` entries exactly.
 */
export function registerMoonshotAiActionsIpc(ipcMain: Pick<IpcMain, "handle">, deps: AiActionDeps): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("ai_action_prompts", () => aiActionPrompts());
  handle(
    "ai_action",
    (args: {
      action: string;
      scope: string | null;
      refs: string[] | null;
      instructions: string | null;
      question: string | null;
      opId: string | null;
    }) => aiAction(deps, args.action, args.scope, args.refs, args.instructions, args.question, args.opId)
  );
  handle("memory_suggestion", (args: { chatId: string }) => memorySuggestion(deps, args.chatId));
  handle("suggest_file_meta", (args: { fileId: string }) => suggestFileMeta(deps, args.fileId));
  handle(
    "generate_ui_text",
    (args: { kind: string; prompt: string; facts: unknown; maxWords: number }) =>
      generateUiText(deps, args.kind, args.prompt, args.facts, args.maxWords)
  );
}
