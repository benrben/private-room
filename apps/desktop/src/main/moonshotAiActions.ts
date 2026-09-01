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
 *   - `isSummaryFile`, needed by {@link gatherScopeText}'s whole-room branch
 *     to exclude the app's own generated room summary from being
 *     summarized/analyzed/etc. again — USED TO BE a direct, private port of
 *     `commands/summarize.rs::is_summary_file` (2 lines), duplicated because
 *     `summarize.rs` had no Electron port yet (`moonshotFrontPage.ts` carried
 *     an identical private copy for the identical reason). `summarizeTools.ts`
 *     is now that real port and exports {@link isSummaryFile} for real, so
 *     this file imports it instead — the same promotion
 *     {@link resolveStructuredModel} itself already got below, the moment
 *     `moonshotCmds.ts` existed to import it from.
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
import type { FileMeta } from "./db-host/files.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { resolveStructuredModel } from "./moonshotCmds.js";
import { AI_ACTIONS, aiActionPrompts, type AiActionSpec } from "./moonshotAiPrompts.js";
import {
  generateUiText,
  memorySuggestion,
  ownField,
  requireRoom,
  suggestFileMeta,
  type AiSidecarDeps,
  type RoomHandle,
  type RoomSource,
} from "./moonshotAiSidecar.js";
import {
  gatherFilesText,
  gatherScopeText,
  safeScopeName,
  studioInstruction,
} from "./moonshotAiScope.js";
import {
  sidecarErrorSentinel,
  sidecarJsonCancellable,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";
import { emitUnowned, type EventSender } from "./turn.js";

export type { AiActionDef, FileMetaSuggestion, MemorySuggestion };
export { aiActionPrompts } from "./moonshotAiPrompts.js";
export {
  generateUiText,
  memorySuggestion,
  suggestFileMeta,
  type AiSidecarDeps,
  type RoomHandle,
  type RoomSource,
} from "./moonshotAiSidecar.js";
export { gatherFilesText, gatherScopeText, safeScopeName, studioInstruction } from "./moonshotAiScope.js";

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
// ============================================================================
// studios.rs's small text-gathering/naming helpers — the exact slice
// `ai_actions.rs` calls. See this module's own doc.
// ============================================================================

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
async function saveAndOpen(rooms: RoomSource, send: EventSender, art: Artifact): Promise<Written> {
  const room = requireRoom(rooms);
  const written = room.workspace === undefined
    ? art.commit(room.db)
    : await art.commitToWorkspace(room.workspace);
  emitSafely(send, "room-files-changed", undefined);
  emitSafely(send, "agent-open-file", { id: written.meta.id });
  return written;
}

// ============================================================================
// D5/D12: the 14 AI actions
// ============================================================================

// ============================================================================
// ai_action — run one action over a scope (or explicit @-refs) and save the
// Markdown result into the room.
// ============================================================================

/** {@link AiSidecarDeps}, plus the two seams only {@link aiAction} itself
 * needs: the cancel-tree registry chat's Stop shares, and the event channel
 * for the "ask-step" chip / `room-files-changed` / `agent-open-file`. */
export interface AiActionDeps extends AiSidecarDeps {
  cancelState: CancelState;
  send: EventSender;
}

function aiActionSpec(action: string): AiActionSpec {
  const spec = AI_ACTIONS.find((candidate) => candidate.id === action);
  if (spec === undefined) {
    throw new Error(`"${action}" isn't a known AI action.`);
  }
  return spec;
}

function assertAiActionCanStart(rooms: RoomSource): void {
  if (rooms.rollingBack?.() ?? false) {
    throw new Error("The room is rolling back — try again in a moment.");
  }
}

function actionSourceText(
  room: RoomHandle,
  scope: string | null,
  refs: readonly string[] | null
): [string, string] {
  return refs !== null && refs.length > 0
    ? gatherFilesText(room.db, refs)
    : gatherScopeText(room.db, scope, room.name);
}

async function aiActionModel(deps: AiSidecarDeps): Promise<string> {
  const model = await resolveStructuredModel(deps.rooms, { listModels: deps.listModels });
  if (model === undefined) {
    throw new Error("The local AI (Ollama) isn't running — start it and try again.");
  }
  return model;
}

function announceAiAction(send: EventSender, title: string, model: string): void {
  emitUnowned(
    send,
    "ask-step",
    runsOnThisMac(model) ? title : `${title} — your cloud AI is working (content leaves this Mac)…`
  );
}

async function requestAiAction(
  deps: AiSidecarDeps,
  spec: AiActionSpec,
  model: string,
  text: string,
  instructions: string,
  question: string | null,
  cancel: CancelFlag
): Promise<SidecarPostOutcome> {
  const body = {
    model,
    action: spec.id,
    text,
    instructions,
    question,
    base_url: resolvedBaseUrl(),
  };
  const post = deps.post ?? sidecarJsonCancellable;
  return post("/ai_action", body, cancel);
}

function aiActionFailure(
  error: Extract<SidecarPostOutcome, { kind: "error" }>['error'],
  model: string
): Error {
  if (["UNKNOWN_ACTION", "NEEDS_LANGUAGE", "EMPTY_RESULT"].includes(error.code)) {
    return new Error(error.error);
  }
  return new Error(sidecarErrorSentinel(error, model));
}

function aiActionMarkdown(outcome: SidecarPostOutcome, cancel: CancelFlag, title: string, model: string): string {
  const notSavedWhat = `the ${title} result`;
  if (outcome.kind === "stopped") {
    throw new Error(`Stopped — ${notSavedWhat} was not saved.`);
  }
  if (outcome.kind === "error") {
    throw aiActionFailure(outcome.error, model);
  }
  const guard = guardCommit(cancel, notSavedWhat);
  if (!guard.ok) {
    throw new Error(guard.error);
  }
  const markdown = ownField(outcome.value, "markdown");
  return typeof markdown === "string" ? markdown : "";
}

async function saveAiActionResult(
  deps: Pick<AiActionDeps, "rooms" | "send">,
  spec: AiActionSpec,
  label: string,
  markdown: string
): Promise<FileMeta> {
  const name = `${spec.title} - ${safeScopeName(label)}.md`;
  const written = await saveAndOpen(
    deps.rooms,
    deps.send,
    Artifact.new(name, "text/markdown", markdown).by(spec.title)
  );
  return written.meta;
}

function unregisterAiAction(deps: Pick<AiActionDeps, "cancelState">, opId: string | null): void {
  if (opId !== null) {
    deps.cancelState.cancels.delete(opId);
    forget(deps.cancelState, opId);
  }
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
  const spec = aiActionSpec(action);
  // Wave 3 (Idea 9): don't start one while a rollback is swapping the DB.
  assertAiActionCanStart(deps.rooms);
  const node = registerAiActionCancel(deps.cancelState, opId, spec.title);
  const cancel = node.flag();
  try {
    const instr = studioInstruction(instructions, spec.defaultPrompt);
    const room = requireRoom(deps.rooms);
    const [label, text] = actionSourceText(room, scope, refs);
    const model = await aiActionModel(deps);

    // Say where the material is going, exactly as a Studio run does. Owner
    // replacement #4: started from the file header and belongs to no
    // conversation, so its chip is emitted UNOWNED (null ids) rather than
    // borrowed from whichever chat happens to be open.
    announceAiAction(deps.send, spec.title, model);
    const outcome = await requestAiAction(deps, spec, model, text, instr, question, cancel);
    // Stopped between the answer arriving and the save: nothing lands. Same
    // commit-time rule every other write-side effect uses.
    const content = aiActionMarkdown(outcome, cancel, spec.title, model);
    // ART-1: re-running the same action over the same scope versions the
    // earlier result instead of leaving two files nobody can tell apart. No
    // `.fromFiles(refs)`/`.cancelWith(cancel)` — Rust's own `Artifact::new(..)
    // .by(spec.title)` calls neither (the cancel flag was already checked
    // immediately above via `guardCommit`).
    return saveAiActionResult(deps, spec, label, content);
  } finally {
    // `CancelGuard::drop` removes BOTH halves on every exit path — success,
    // thrown error, or Stop — but only when an `opId` was actually
    // registered (a `null` opId never touched either registry).
    unregisterAiAction(deps, opId);
  }
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
