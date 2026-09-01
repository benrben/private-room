/**
 * A chat turn, top to bottom. Ported from `src-tauri/src/commands/agent.rs`:
 *
 *   - {@link ask} — lines ~413-664, the top-level turn entry.
 *   - {@link streamAnswer} — lines ~1278-1444, drives the sidecar `/run` call
 *     (already-ported `sidecar.ts`) and turns its outcome into answer text.
 *   - {@link persistAssistantReply}/{@link persistAssistantReplyPinned} —
 *     lines ~1481-1533, the room-pin-checked write of the assistant's reply.
 *   - {@link handoffChat} — lines ~1665-1758, the context-handoff / token-
 *     budget-bar summarizer, plus `token_usage::handoff_usage_value`.
 *   - {@link saveGeneratedFile} — `commands/files.rs::save_generated_impl`'s DB
 *     half, which the deterministic "save that" bypass writes through.
 *
 * FAITHFULLY PORTED, matching the Rust source's own documented invariants:
 *   - the mid-rollback refusal, checked BEFORE anything is registered.
 *   - cancel registration ({@link registerRun}) and its removal on EVERY exit
 *     path — success, thrown error, or Stop — from BOTH registry halves, in
 *     one `finally`. `CancelGuard::drop` (`commands.rs:481-495`) removes the
 *     flat `cancels` entry AND calls `cancel::forget`; `cancel.ts`'s `forget`
 *     clears only the tree half, so calling it alone would leak the flag every
 *     room-close drain waits on.
 *   - the "Starting the local AI…" → "Preparing the search…" → embed →
 *     "Searching your files…" step ORDER. The Rust source names this a
 *     previously-fixed defect (the search chip used to fire before a 274 MB
 *     embed model load): each phase names itself as it BEGINS. Do not reorder,
 *     and do not move the embed out from between the last two.
 *   - the room-pin check on the final write ({@link persistAssistantReplyPinned},
 *     over B3's already-ported `roomPin.ts`): a straggler whose room changed
 *     underneath it is REFUSED and handed back in memory instead. Content
 *     crossing a room boundary onto disk is the one thing this app must never
 *     do.
 *   - the pure-save-reference deterministic bypass (including its
 *     `isFailureNotice` guard, so a turn that failed is never turned into a
 *     document containing only the error text).
 *   - the anti-fabrication correction, and the `*(Also stopped: …)*` /
 *     `*(stopped)*` markers in the Rust source's exact order — the bare suffix
 *     stays the LAST thing in the message, because the save-that path strips
 *     it by that literal string.
 *
 * OUT OF SCOPE, injected as documented seams rather than faked (each on its
 * own field below): Ollama liveness/model listing/summarization
 * (`engineRouting.ts`), the question embedding (`retrieval/backfill.rs`'s
 * `embed_question` — an Ollama call, explicitly out of scope per
 * `retrieval.ts`), per-model capability lookups (`chat_model_sees_images`,
 * `capabilities_for(...).context_window`), the post-answer image-grounding
 * pass (`grounding_pick` + `ground_prepared_image`), cloud-CLI advisor
 * detection, the privacy door's `active_policy()`, and background-job
 * liveness.
 *
 * ONE GAP WORTH NAMING LOUDLY: the per-turn MCP bridge. In Rust the tool
 * effects (`wrote`/`boxes`/`annotation`/`editOutcomes`) are one `&mut
 * ToolEffects` threaded synchronously through `exec_tool`; here the sidecar is
 * a separate process that calls back over a loopback bridge no batch has stood
 * up yet. {@link streamAnswer} therefore takes the bridge's `{url, token}` and
 * the `ToolEffects` object as REQUIRED inputs it does not fabricate: it sets
 * `tokenUsage`/`agentPlan` for real from the sidecar outcome, and READS
 * `wrote`/`boxes`/`annotation` (for the fabrication gate and the empty-reply
 * notice) while leaving them for whoever wires a real bridge session in.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import {
  forget,
  registerRun,
  type CancelFlag,
  type CancelState,
  type Node as CancelNode,
} from "./cancel.js";
import { availableName, insertFile, type FileMeta } from "./db-host/files.js";
import { createRoomFile } from "./workspace/roomContent.js";
import {
  insertHandoffMessage,
  insertMessage,
  listMessages,
  recentMessages,
  type Message,
} from "./db-host/messages.js";
import { compactHistory } from "./db-host/retrieval.js";
import { getSetting } from "./db-host/settings.js";
import { createToolEffects, effectsJson, type ToolEffects } from "./execTool.js";
import { activePolicy as activePrivacyPolicy, policyPayload, type PolicyState } from "./privacy.js";
import { emptyPrivacyReport, type StreamRedactor } from "./privacyRedact.js";
import {
  handoffSummary as handoffSummaryReal,
  isAwake as isAwakeReal,
  listModels as listModelsReal,
  resolvedBaseUrl as resolvedBaseUrlReal,
} from "./engineRouting.js";
import {
  gatherContextAndSaveQuestionInRoom,
  modelSetting,
  parseTemperature,
  turnEvidencePolicyForQuestion,
  type FirstImage,
  type GatherContextDeps,
  type QuestionContext,
} from "./gatherContext.js";
import { RoomPin, type RoomPinSource } from "./roomPin.js";
import {
  runViaSidecar as runViaSidecarReal,
  type RunViaSidecarMcp,
  type SidecarChatMessage,
  type SidecarOutcome,
} from "./sidecar.js";
import { TurnId, type EventSender } from "./turn.js";
import { backgroundWorkLive, claimsUnbackedAction, emptyReplyNotice, isFailureNotice } from "./turnNotices.js";
import {
  CHARS_PER_TOKEN,
  MAX_HISTORY_MESSAGES,
  ROLLBACK_BUSY,
  bestDefault,
  explicitSkillRequest,
  handoffBudgetBytes,
  isCliEngine,
  isLocateIntent,
  isPureSaveReference,
  pixelsReachChatModel,
  requestedFileName,
  stripStoppedSuffix,
  type PreparedImage,
} from "./turnContext.js";
import { OpenRoom, TurnRoomSource, persistAssistantReplyPinned, saveGeneratedFileInRoom } from "./turnPersistence.js";
export { persistAssistantReply, persistAssistantReplyPinned, saveGeneratedFile, saveGeneratedFileInRoom } from "./turnPersistence.js";
export type { OpenRoom, TurnRoomSource } from "./turnPersistence.js";

import { StreamAnswerDeps, streamAnswer } from "./turnStream.js";
export { streamAnswer } from "./turnStream.js";
export type { StreamAnswerRequest, StreamAnswerDeps } from "./turnStream.js";


// -------------------------------------------------------------------- ask

/** One turn's request, field-for-field the Tauri command's own parameters. */
export interface AskRequest {
  askId: string;
  chatId: string;
  question: string;
  attachments: readonly string[];
  /** The NAME of the file the user has open while asking, when they have one.
   * A name and nothing more: file names already ride in this turn's room
   * inventory, so it discloses nothing new, while the CONTENT stays behind the
   * paperclip — the user's own gesture, not ours to spend for them. */
  viewing: string | null;
  /** PRIV-1: set only by the chat valve's confirmed re-ask. */
  privacyBypass: boolean;
}

/** Everything {@link ask} needs beyond the request itself. */
export interface AskDeps {
  room: TurnRoomSource;
  cancelState: CancelState;
  send: EventSender;
  /**
   * The per-run room MCP bridge's loopback URL + token, chosen per run.
   * REQUIRED — see {@link StreamAnswerRequest.mcp}. `advisorToolsOn` (ADD-21,
   * resolved by Phase 1) is handed over so whoever builds the real bridge can
   * decide whether a consulted advisor also reaches the room's connected MCP
   * tools; this is the only seam that decision can reach from here.
   */
  mcp: (runId: string, advisorToolsOn: boolean) => RunViaSidecarMcp;
  /**
   * `backfill.rs::embed_question` — ADD-13's question embedding, computed
   * BEFORE the room is read (an Ollama call, and the lock is never held across
   * it). Out of scope per `retrieval.ts`'s own note; omitted means keyword-only
   * retrieval, the exact degradation `retrieveContext` already documents for
   * "the embed model is absent". Failure should resolve `null`, not throw:
   * Rust's `embed_question` returns `None` on any failure.
   */
  embedQuestion?: (question: string) => Promise<readonly number[] | null>;
  /** Forwarded to {@link gatherContextAndSaveQuestion} — see that module for
   * both defaults. */
  connectedMcpServers?: GatherContextDeps["connectedMcpServers"];
  prepareImage?: (bytes: Buffer) => PreparedImage;
  /** Overridable for tests; default to `engineRouting.ts`'s real functions. */
  isAwake?: (base: string) => Promise<boolean>;
  resolvedBaseUrl?: () => string;
  listModels?: () => Promise<string[]>;
  runViaSidecar?: typeof runViaSidecarReal;
  detectedAdvisors?: StreamAnswerDeps["detectedAdvisors"];
  privacyActive?: StreamAnswerDeps["privacyActive"];
  privacyPolicy?: StreamAnswerDeps["privacyPolicy"];
  jobStatuses?: StreamAnswerDeps["jobStatuses"];
  /**
   * `models.rs::chat_model_sees_images` — can THIS engine read attached
   * pixels? A live capability lookup, out of scope. Default `false`, which
   * under-credits a capable engine rather than telling a text-only one it can
   * see pixels it cannot (ADD-25's fallback then has a local vision model
   * describe the capture instead, so no perception is lost — only speed).
   */
  chatModelSeesImages?: (model: string) => Promise<boolean>;
  /** The exact per-turn effects sink also owned by the short-lived room MCP
   * bridge. Supplying it keeps image attachments and action receipts on one
   * run-scoped object; omitted callers receive a fresh sink as before. */
  effects?: ToolEffects;
  /** `commands::runs_on_this_mac` — see `turnContext.ts`'s
   * {@link pixelsReachChatModel}. Default `false`. */
  runsOnThisMac?: (model: string) => boolean;
  /**
   * CHG-19's post-answer image-grounding pass (`grounding_pick` +
   * `ground_prepared_image`) — real Ollama vision calls, out of scope.
   * Omitted (the default) skips the pass, which is behaviorally identical to
   * "nothing installed here can see", never a fabricated capability. Wire a
   * real `prepareImage` alongside it: the default pass-through reports 0×0
   * dimensions, which would misplace boxes.
   */
  groundingPass?: (args: {
    model: string;
    question: string;
    image: FirstImage;
  }) => Promise<{ fileId: string; name: string; boxes: unknown } | null>;
  /** Best-effort `"room-files-changed"` broadcast after the save-that fast
   * path writes a file — see {@link saveGeneratedFile}. Failures swallowed,
   * matching Rust's `let _ = app.emit(...)`. */
  notifyFilesChanged?: () => void;
}

/**
 * The top-level turn entry. Ported from `agent.rs::ask` — see this file's
 * module doc for the full list of what is faithful and what is a seam.
 */
export async function ask(req: AskRequest, deps: AskDeps): Promise<Message> {
  // Wave 3 (Idea 9): don't start a turn while a rollback is swapping the DB —
  // it would save messages that either fail or land against the wrong room.
  if (deps.room.rollingBack?.() ?? false) {
    throw new Error(ROLLBACK_BUSY);
  }

  // The room this turn belongs to, taken before anything can await. Every
  // write at the end is checked against it.
  const pin = RoomPin.take(deps.room);

  // ADD-7 / owner replacement #3: this ask's flag is the ROOT of its cancel
  // tree, so work the turn starts (a Studio build, a background job) can be
  // attached to it by run id and a Stop reaches that too.
  const node: CancelNode = registerRun(deps.cancelState, req.askId, "this answer");
  const cancel = node.flag();
  try {
    return await runAsk(req, deps, pin, node, cancel);
  } finally {
    // `CancelGuard::drop` (`commands.rs:481-495`) removes BOTH halves on every
    // exit path — success, error, or cancel — so `close_room`'s drain (which
    // watches the flat `cancels` map) can see this turn finish, and a later run
    // reusing the id cannot inherit a finished run's children.
    deps.cancelState.cancels.delete(req.askId);
    forget(deps.cancelState, req.askId);
  }
}

interface AskTurn {
  turn: TurnId;
  room: OpenRoom;
  privacyPolicy: PolicyState | null;
  evidencePolicy: QuestionContext["evidencePolicy"];
}

interface AnswerSetup {
  model: string;
  effects: ToolEffects;
  modelSeesImages: boolean | null;
}

async function runAsk(
  req: AskRequest,
  deps: AskDeps,
  pin: RoomPin | null,
  node: CancelNode,
  cancel: CancelFlag
): Promise<Message> {
  const askTurn = openAskTurn(req, deps);
  const questionEmbedding = await prepareQuestionEmbedding(req, deps, askTurn);
  const context = await gatherAskContext(req, deps, askTurn, questionEmbedding);
  const saved = await savePreviousAnswer(req, deps, pin, askTurn);
  if (saved !== null) {
    return saved;
  }
  const setup = await prepareAnswer(req, deps, context);
  const answer = await streamTurnAnswer(req, deps, askTurn, context, setup, cancel);
  const stopped = cancel.load();
  await groundAnswer(req, deps, askTurn.turn, context, setup, stopped);
  const content = finalAnswerContent(answer, node, setup.effects, stopped, askTurn.privacyPolicy, req.privacyBypass);
  return persistAssistantReplyPinned(deps.room, pin, req.chatId, content, context.sources, effectsJson(setup.effects));
}

function openAskTurn(req: AskRequest, deps: AskDeps): AskTurn {
  const turn = new TurnId(req.askId, req.chatId);
  const privacyPolicy = resolveAskPrivacyPolicy(deps);
  const room = deps.room.currentRoom();
  if (room === null) {
    throw new Error("No room is open.");
  }
  return {
    turn,
    room,
    privacyPolicy,
    evidencePolicy: turnEvidencePolicyForQuestion(room.db, req.question),
  };
}

function resolveAskPrivacyPolicy(deps: AskDeps): PolicyState | null {
  return deps.privacyPolicy === undefined ? activePrivacyPolicy() : deps.privacyPolicy();
}

async function prepareQuestionEmbedding(
  req: AskRequest,
  deps: AskDeps,
  askTurn: AskTurn
): Promise<readonly number[] | null> {
  const baseUrl = (deps.resolvedBaseUrl ?? resolvedBaseUrlReal)();
  if (!(await (deps.isAwake ?? isAwakeReal)(baseUrl))) {
    askTurn.turn.step(deps.send, "Starting the local AI…");
  }
  if (askTurn.evidencePolicy === "no-tools-no-sources") {
    askTurn.turn.step(deps.send, "Answering without tools or room sources");
    return null;
  }
  askTurn.turn.step(deps.send, "Preparing the search…");
  const embedding = deps.embedQuestion === undefined ? null : await deps.embedQuestion(embeddingQuestion(req.question));
  askTurn.turn.step(deps.send, "Searching your files…");
  return embedding;
}

function embeddingQuestion(question: string): string {
  const skillRequest = explicitSkillRequest(question);
  return skillRequest === null ? question.trim() : skillRequest.request;
}

function gatherAskContext(
  req: AskRequest,
  deps: AskDeps,
  askTurn: AskTurn,
  questionEmbedding: readonly number[] | null
): Promise<QuestionContext> {
  return gatherContextAndSaveQuestionInRoom(
    askTurn.room,
    req.chatId,
    req.question,
    req.attachments,
    questionEmbedding,
    req.viewing,
    {
      connectedMcpServers: deps.connectedMcpServers,
      prepareImage: deps.prepareImage,
      evidencePolicy: askTurn.evidencePolicy,
    }
  );
}

async function savePreviousAnswer(
  req: AskRequest,
  deps: AskDeps,
  pin: RoomPin | null,
  askTurn: AskTurn
): Promise<Message | null> {
  if (!isPureSaveTurn(req, askTurn.evidencePolicy)) {
    return null;
  }
  const previous = lastRealAssistantReply(askTurn.room.db, req.chatId);
  if (previous === null) {
    return null;
  }
  const name = requestedFileName(req.question) ?? "Saved answer";
  const file = await saveGeneratedFileInRoom(askTurn.room, name, stripStoppedSuffix(previous.content));
  notifyFilesChanged(deps);
  askTurn.turn.step(deps.send, "Saved to the room");
  const content = redactTurnText(
    `Saved your previous answer to the room as "${file.name}".`,
    askTurn.privacyPolicy,
    req.privacyBypass
  );
  askTurn.turn.emit(deps.send, "ask-delta", content);
  return persistSavedReply(deps.room, pin, req.chatId, content, file.name);
}

function isPureSaveTurn(req: AskRequest, evidencePolicy: QuestionContext["evidencePolicy"]): boolean {
  return evidencePolicy === "normal" && req.attachments.length === 0 && isPureSaveReference(req.question);
}

function notifyFilesChanged(deps: AskDeps): void {
  try {
    deps.notifyFilesChanged?.();
  } catch {
    // Best-effort, matching Rust's `let _ = app.emit(...)`.
  }
}

function persistSavedReply(room: TurnRoomSource, pin: RoomPin | null, chatId: string, content: string, fileName: string): Message {
  const effects = createToolEffects();
  effects.wrote = true;
  return persistAssistantReplyPinned(room, pin, chatId, content, [fileName], effectsJson(effects));
}

async function prepareAnswer(req: AskRequest, deps: AskDeps, context: QuestionContext): Promise<AnswerSetup> {
  const models = await (deps.listModels ?? listModelsReal)();
  const model = context.explicitModel ?? bestDefault(models);
  const effects = deps.effects ?? createToolEffects();
  const modelSeesImages = await imageCapability(deps, model);
  effects.visionChat = pixelsReachChatModel(model, modelSeesImages === true, imagePolicy(deps, req.privacyBypass));
  return { model, effects, modelSeesImages };
}

async function imageCapability(deps: AskDeps, model: string): Promise<boolean | null> {
  return deps.chatModelSeesImages === undefined ? null : await deps.chatModelSeesImages(model);
}

function imagePolicy(deps: AskDeps, privacyBypass: boolean): { runsOnThisMac: (model: string) => boolean; privacyActive: () => boolean } {
  return {
    runsOnThisMac: deps.runsOnThisMac ?? (() => false),
    privacyActive: () => !privacyBypass && (deps.privacyActive?.() ?? false),
  };
}

function streamTurnAnswer(
  req: AskRequest,
  deps: AskDeps,
  askTurn: AskTurn,
  context: QuestionContext,
  setup: AnswerSetup,
  cancel: CancelFlag
): Promise<string> {
  return streamAnswer(
    {
      model: setup.model,
      question: req.question,
      chatMessages: context.chatMessages,
      temperature: context.temperature,
      effects: setup.effects,
      supportsVision: setup.modelSeesImages,
      webEnabled: context.webEnabled,
      advisorsOn: context.advisorsOn,
      evidencePolicy: context.evidencePolicy,
      cancel,
      privacyBypass: req.privacyBypass,
      turn: askTurn.turn,
      mcp: deps.mcp(req.askId, context.advisorToolsOn),
    },
    {
      send: deps.send,
      runViaSidecar: deps.runViaSidecar,
      resolvedBaseUrl: deps.resolvedBaseUrl,
      detectedAdvisors: deps.detectedAdvisors,
      privacyActive: deps.privacyActive,
      privacyPolicy: () => askTurn.privacyPolicy,
      jobStatuses: deps.jobStatuses,
    }
  );
}

async function groundAnswer(
  req: AskRequest,
  deps: AskDeps,
  turn: TurnId,
  context: QuestionContext,
  setup: AnswerSetup,
  stopped: boolean
): Promise<void> {
  const image = context.firstImage;
  if (!shouldGroundImage(setup.effects, stopped, image)) {
    return;
  }
  const groundingPass = deps.groundingPass;
  if (groundingPass === undefined) {
    return;
  }
  if (!isLocateIntent(req.question, image.name)) {
    return;
  }
  const marked = await groundingPass({ model: setup.model, question: req.question, image });
  if (marked === null) {
    return;
  }
  setup.effects.boxes = marked;
  turn.step(deps.send, "Marked the image");
}

function shouldGroundImage(
  effects: ToolEffects,
  stopped: boolean,
  image: FirstImage | null
): image is FirstImage {
  return effects.boxes === null && !stopped && image !== null;
}

function finalAnswerContent(
  answer: string,
  node: CancelNode,
  effects: ToolEffects,
  stopped: boolean,
  privacyPolicy: PolicyState | null,
  privacyBypass: boolean
): string {
  const corrected = stopped ? answer : correctUnbackedAction(answer, effects);
  const content = stopped ? appendStoppedSuffix(corrected, node) : corrected;
  return redactTurnText(content, privacyPolicy, privacyBypass);
}

function correctUnbackedAction(answer: string, effects: ToolEffects): string {
  const highlighted = effects.annotation !== null || effects.boxes !== null;
  if (!claimsUnbackedAction(answer, effects.wrote, highlighted)) {
    return answer;
  }
  return `${answer}\n\n*(Correction: no file was actually changed this turn — the edit tool did not run or failed.)*`;
}

function appendStoppedSuffix(answer: string, node: CancelNode): string {
  const stoppedChildren = node.stoppedChildren();
  const children = stoppedChildren.length > 0 ? `\n\n*(Also stopped: ${stoppedChildren.join(", ")}.)*` : "";
  return `${answer}${children} *(stopped)*`;
}

function redactTurnText(text: string, privacyPolicy: PolicyState | null, privacyBypass: boolean): string {
  return privacyPolicy !== null && !privacyBypass
    ? privacyPolicy.redactor.redact(text, emptyPrivacyReport())
    : text;
}
import { lastRealAssistantReply } from "./turnHandoff.js";
export { handoffUsageValue, handoffChat } from "./turnHandoff.js";
export type { HandoffChatDeps } from "./turnHandoff.js";


export { redactTurnText };
