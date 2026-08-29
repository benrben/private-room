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

// -------------------------------------------------------- save_generated

/** `extraction::extension_of` — a `std::path::Path` extension: none for a
 * dotfile or a name with no dot, lower-cased. */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

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

// -------------------------------------------------------------- streamAnswer

/** Everything {@link streamAnswer} needs about the turn it is answering. */
export interface StreamAnswerRequest {
  model: string;
  question: string;
  chatMessages: SidecarChatMessage[];
  temperature: number | null;
  /** Mutated in place: `tokenUsage`/`agentPlan` are set from the sidecar's
   * reported usage/plan. See this file's module doc for what this port cannot
   * set (`wrote`/`boxes`/`annotation`/`editOutcomes`). */
  effects: ToolEffects;
  /** The host catalog's answer for this exact model. `null`/omitted means the
   * capability could not be resolved, not that the model is known blind. */
  supportsVision?: boolean | null;
  webEnabled: boolean;
  advisorsOn: boolean;
  /** Omitted by non-chat callers, which retain the normal tool policy. */
  evidencePolicy?: QuestionContext["evidencePolicy"];
  cancel: CancelFlag;
  /** PRIV-1: the user confirmed sharing real values for THIS turn only. */
  privacyBypass: boolean;
  turn: TurnId;
  /** The per-run room bridge's loopback URL + bearer token. REQUIRED, with no
   * default: a plausible-looking but wrong URL/token is worse than an explicit
   * "no bridge is wired up yet". */
  mcp: RunViaSidecarMcp;
}

/** Everything {@link streamAnswer} needs beyond the request itself. */
export interface StreamAnswerDeps {
  send: EventSender;
  /** Overridable for tests; defaults to `sidecar.ts`'s real `runViaSidecar`.
   * Tests bind `sidecar.ts`'s own `streamRun` to a fake NDJSON server's base
   * URL here — the seam that module already built for exactly this. */
  runViaSidecar?: typeof runViaSidecarReal;
  /** Which Ollama the sidecar should talk to (`ollama_base_url` on the wire,
   * `ollama::resolved_base_url()` in Rust). Defaults to the real C1-layered
   * resolver, so a room pointed at a remote "closet" box keeps working. */
  resolvedBaseUrl?: () => string;
  /**
   * `agent.rs::detected_advisors` — which cloud CLIs can act as advisors.
   * Resolving it is `AppState::external_cache` plus a blocking login-shell
   * probe, out of scope here. Default `[]`: the honest answer for "no detector
   * is wired up", NOT a claim that no advisor is installed — and the safe
   * direction, since it never hands a subtask to an advisor we did not find.
   */
  detectedAdvisors?: () => Promise<string[]>;
  /**
   * `privacy::active_policy().is_some()` — is this room's privacy door even
   * configured? Default `false`, which only suppresses the PRIV-1 "bypassed"
   * transcript note for a door that was never there to bypass. Announcing a
   * bypass that bypassed nothing would be its own small fabrication.
   */
  privacyActive?: () => boolean;
  /** The active room policy, captured once for both the outbound /run door and
   * the deterministic visible/stored answer boundary. */
  privacyPolicy?: () => PolicyState | null;
  /** `agent.rs::background_work_live` — see `turnNotices.ts` for why the job
   * read is injected (no `db-host/jobs.ts` exists yet). */
  jobStatuses?: () => Array<{ status: string }> | undefined;
}

/** How often the polled {@link CancelFlag} is checked in order to abort the
 * sidecar stream. `sidecar.ts` polls its own `AbortSignal` at the same cadence,
 * so chaining the two does not worsen a Stop's end-to-end latency. */
const CANCEL_BRIDGE_POLL_MS = 100;

/** Redact only visible answer text while preserving the turn envelope.
 *
 * `ask-round` replaces the live answer, so its unfinished suffix must be
 * discarded too; otherwise two different rounds could be joined into one
 * apparent protected value. */
function redactVisibleAnswerEvents(send: EventSender, redactor: StreamRedactor): EventSender {
  return (event, payload) => {
    if (event === "ask-round") {
      redactor.reset();
      send(event, payload);
      return;
    }
    if (event !== "ask-delta") {
      send(event, payload);
      return;
    }
    if (typeof payload === "string") {
      const visible = redactor.feed(payload);
      if (visible !== "") send(event, visible);
      return;
    }
    if (typeof payload !== "object" || payload === null) return;
    const envelope = payload as Record<string, unknown>;
    if (typeof envelope.v !== "string") return;
    const visible = redactor.feed(envelope.v);
    if (visible !== "") send(event, { ...envelope, v: visible });
  };
}

/**
 * Bridge `cancel.ts`'s polled {@link CancelFlag} (Rust's `Arc<AtomicBool>`) to
 * the `AbortSignal` `sidecar.ts` expects. They are two cancellation primitives
 * with no shared ancestor in this port, and the signal is load-bearing rather
 * than cosmetic: it is what makes `streamRun` POST the real `/cancel` (tearing
 * the HTTP connection down alone does NOT stop the Python run).
 */
function abortSignalFor(flag: CancelFlag): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  if (flag.load()) {
    controller.abort();
    return { signal: controller.signal, stop: () => {} };
  }
  const timer = setInterval(() => {
    if (flag.load()) {
      controller.abort();
      clearInterval(timer);
    }
  }, CANCEL_BRIDGE_POLL_MS);
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

/**
 * Phase 2 (unlocked): produce the answer. Ported from `agent.rs::stream_answer`.
 *
 * ENGINE PARITY (2026-07-24): there is ONE chat path. Every engine — local
 * Ollama, `:cloud`, an API provider, and the cloud CLIs — answers through the
 * sidecar's agent hub, so the main agent, the domain agents and their roster
 * events are the same code for all of them. A CLI engine only announces itself
 * first; it does not take a different route.
 *
 * ERROR HANDLING vs the Rust source. Rust's `stream_answer` can return `Err`,
 * from two `SidecarOutcome` variants that both mean "the run never started":
 * `Unavailable` (the sidecar could not start/connect before any tool ran) and
 * `EngineError` (a misconfigured provider). Its epilogue then swallows that
 * `Err` into an EMPTY string when the user had already pressed Stop, because a
 * stopped turn that never started is not an app failure to report.
 *
 * `sidecar.ts` reproduces NEITHER variant in its `SidecarOutcome` — by its own
 * doc, both belong to the batch that owns waking the daemon — so they arrive
 * here the only way they can in JS: `runViaSidecar` THROWS, because `ensureUp`
 * throws (`SIDECAR_UNAVAILABLE: <reason>`) when it cannot start the process.
 * That is the `Unavailable` class, reached before a single line of NDJSON, and
 * the `catch` below is where Rust's arm for it lives: the Stop swallow first,
 * then Rust's own user-facing sentence and its `eprintln!` of the underlying
 * reason (the app writes no log of its own, so a bare "the sidecar could not
 * start" was, in practice, the whole diagnosis available for a broken Python
 * install, a busy port and a crash on import alike).
 *
 * Everything that happens ONCE the stream is open is an outcome, never a
 * throw — see `transportFailure` in `sidecar.ts`, which exists so a severed
 * connection keeps the partial the user watched arrive.
 */
export async function streamAnswer(req: StreamAnswerRequest, deps: StreamAnswerDeps): Promise<string> {
  const privacyPolicy = deps.privacyPolicy === undefined
    ? activePrivacyPolicy()
    : deps.privacyPolicy();
  const privacyIsActive = privacyPolicy !== null || (deps.privacyActive?.() ?? false);
  // PRIV-1: an explicit bypass is loud — the transcript records that real
  // details were shared this once, whichever engine answers.
  if (req.privacyBypass && privacyIsActive) {
    req.turn.emit(deps.send, "ask-privacy", { bypassed: true });
  }

  // ARC-002: output privacy is provider-independent. A local model can repeat
  // a protected value just as easily as a cloud model can restore a placeholder
  // in its reply. Holding the undecidable token suffix prevents a split value
  // from flashing on screen before the final defensive redaction below.
  const outputRedactor =
    privacyPolicy !== null && !req.privacyBypass
      ? privacyPolicy.redactor.stream(emptyPrivacyReport())
      : null;
  const visibleSend = outputRedactor === null
    ? deps.send
    : redactVisibleAnswerEvents(deps.send, outputRedactor);

  const advisors = req.advisorsOn ? await (deps.detectedAdvisors?.() ?? Promise.resolve([])) : [];

  // CHG-5: the cloud engines say so out loud, before anything is sent. The
  // transparency belongs to the engine CHOICE, not to which code path answers.
  if (isCliEngine(req.model)) {
    req.turn.step(deps.send, "Asking your cloud AI (content leaves this Mac)");
  }

  const run = deps.runViaSidecar ?? runViaSidecarReal;
  const bridge = abortSignalFor(req.cancel);
  let outcome: SidecarOutcome;
  try {
    outcome = await run(
      {
        model: req.model,
        question: req.question,
        messages: req.chatMessages,
        temperature: req.temperature,
        ollamaBaseUrl: (deps.resolvedBaseUrl ?? resolvedBaseUrlReal)(),
        mcp: req.mcp,
        webEnabled: req.webEnabled,
        toolPolicy: req.evidencePolicy === "no-tools-no-sources" ? "none" : "auto",
        runId: req.turn.runId,
        privacy:
          privacyPolicy !== null && !req.privacyBypass
            ? policyPayload(privacyPolicy)
            : null,
        supportsVision: req.supportsVision ?? null,
        advisors,
      },
      { turn: req.turn, onEvent: visibleSend, signal: bridge.signal }
    );
  } catch (err) {
    // Rust's `SidecarOutcome::Unavailable` arm — see this function's doc.
    // The Stop swallow comes FIRST (`Err(_) if stopped => Ok(String::new())`):
    // `ask` then marks the empty answer `*(stopped)*` and persists it, which is
    // what the user asked for. Reporting "the AI engine is unavailable" for a
    // turn they stopped would describe a failure that did not happen.
    if (req.cancel.load()) {
      return "";
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`agent sidecar unavailable: ${reason}`);
    throw new Error(`AI engine unavailable — the agent sidecar could not start (${reason}).`);
  } finally {
    bridge.stop();
  }

  if (outputRedactor !== null) {
    const tail = outputRedactor.flush();
    if (tail !== "") req.turn.emit(deps.send, "ask-delta", tail);
  }

  const redactFinal = (text: string): string =>
    privacyPolicy !== null && !req.privacyBypass
      ? privacyPolicy.redactor.redact(text, emptyPrivacyReport())
      : text;

  // Merged on every outcome, mirroring `run_via_sidecar`'s own contract. A
  // `null` means "not reported this run" and must not erase what a bridge
  // session already recorded.
  if (outcome.usage !== null) {
    req.effects.tokenUsage = outcome.usage;
  }
  if (outcome.plan !== null) {
    req.effects.agentPlan = outcome.plan;
  }

  if (outcome.kind === "done") {
    if (outcome.text.trim() === "") {
      // The graph floors an empty answer to non-empty text before it reaches
      // the wire, so an empty `done` means the reply was LOST in transit, not
      // that the model said nothing. Which notice that deserves depends on
      // facts the runtime KNOWS — was it stopped, did a write already commit,
      // is a job from this turn still running — because "nothing was written.
      // Please try again." was a CLAIM, and it was false exactly when it
      // mattered (live QA 2026-07-30).
      return redactFinal(
        emptyReplyNotice(
          req.cancel.load(),
          req.effects.wrote,
          backgroundWorkLive(deps.jobStatuses ?? (() => undefined))
        )
      );
    }
    return redactFinal(outcome.text);
  }

  // `failed`: a tool may already have committed a side effect this turn, and
  // its effects are merged above. Throwing here would make the caller discard
  // BOTH the merged viewer effects and the reply — the file would change on
  // disk with no transcript entry and no viewer refresh. Return the partial as
  // a normal answer with an in-transcript failure note instead, and never
  // re-run (that would double the write).
  let out = outcome.text;
  if (out.trim() !== "") {
    out += "\n\n";
  }
  out += `*(The agent hit an error and stopped mid-run: ${outcome.error}. Any change shown here was already applied.)*`;
  return redactFinal(out);
}

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
    const turn = new TurnId(req.askId, req.chatId);
    // One immutable policy decision for the whole turn. A settings change or
    // room close while the model is running must not make its final suffix use
    // a different entity map than its first streamed delta.
    const turnPrivacyPolicy = deps.privacyPolicy === undefined
      ? activePrivacyPolicy()
      : deps.privacyPolicy();
    const redactTurnText = (text: string): string =>
      turnPrivacyPolicy !== null && !req.privacyBypass
        ? turnPrivacyPolicy.redactor.redact(text, emptyPrivacyReport())
        : text;

    const room = deps.room.currentRoom();
    if (room === null) {
      throw new Error("No room is open.");
    }
    const evidencePolicy = turnEvidencePolicyForQuestion(room.db, req.question);

    // ADD-31: name the two hidden phases — waking the daemon, and searching
    // the room — instead of one anonymous 30-second "Thinking locally…".
    const baseUrl = (deps.resolvedBaseUrl ?? resolvedBaseUrlReal)();
    if (!(await (deps.isAwake ?? isAwakeReal)(baseUrl))) {
      turn.step(deps.send, "Starting the local AI…");
    }
    // "Searching your files…" must NOT be emitted before the embed below: a
    // warm daemon holding a COLD embed model shows no chip at all through that
    // 274 MB load, so each phase names itself as it begins.
    let questionEmbedding: readonly number[] | null = null;
    if (evidencePolicy === "no-tools-no-sources") {
      turn.step(deps.send, "Answering without tools or room sources");
    } else {
      turn.step(deps.send, "Preparing the search…");
      // ADD-13: embed the request TEXT of an explicit `/skill` turn, never the
      // slash command itself — `ask`'s own `.map(|(_, request)| request)`.
      const skillRequest = explicitSkillRequest(req.question);
      const embeddingQuestion = skillRequest !== null ? skillRequest.request : req.question.trim();
      questionEmbedding = deps.embedQuestion ? await deps.embedQuestion(embeddingQuestion) : null;
      turn.step(deps.send, "Searching your files…");
    }

    // Phase 1 (locked): gather context, save the user message.
    const ctx: QuestionContext = await gatherContextAndSaveQuestionInRoom(
      room,
      req.chatId,
      req.question,
      req.attachments,
      questionEmbedding,
      req.viewing,
      {
        connectedMcpServers: deps.connectedMcpServers,
        prepareImage: deps.prepareImage,
        evidencePolicy,
      }
    );

    // Live-QA 2026-07-23: a PURE "save that as a file" turn is deterministic —
    // content = the previous assistant reply, name = whatever the user said.
    // The 4B model failed this twice (asked for the content, then fabricated a
    // different document without calling create_file), so CODE does it and the
    // model gets no vote. Attachments or transform verbs fall through.
    if (
      evidencePolicy === "normal"
      && req.attachments.length === 0
      && isPureSaveReference(req.question)
    ) {
      const prev = lastRealAssistantReply(room.db, req.chatId);
      if (prev !== null) {
        const name = requestedFileName(req.question) ?? "Saved answer";
        const meta = await saveGeneratedFileInRoom(room, name, stripStoppedSuffix(prev.content));
        try {
          deps.notifyFilesChanged?.();
        } catch {
          // Best-effort, matching Rust's `let _ = app.emit(...)`.
        }
        turn.step(deps.send, "Saved to the room");
        const text = redactTurnText(`Saved your previous answer to the room as "${meta.name}".`);
        turn.emit(deps.send, "ask-delta", text);
        const fx = createToolEffects();
        fx.wrote = true;
        return persistAssistantReplyPinned(deps.room, pin, req.chatId, text, [meta.name], effectsJson(fx));
      }
    }

    const models = await (deps.listModels ?? listModelsReal)();
    // ADD-29 parity: the selected engine drives the app itself — no silent
    // reroute to a local model.
    const model = ctx.explicitModel ?? bestDefault(models);

    // CHG-19: the "where is X?" grounding pass is DEFERRED to after the answer
    // (nothing in the reply depends on the boxes), so the warm chat model
    // streams its first token instead of waiting on a vision-model load.
    const effects = createToolEffects();
    // ADD-25: perception tools attach pixels only when the chat model can read
    // them AND the privacy door would not strip them; otherwise they fall back
    // to a local vision-model description.
    const modelSeesImages = deps.chatModelSeesImages
      ? await deps.chatModelSeesImages(model)
      : null;
    effects.visionChat = pixelsReachChatModel(
      model,
      modelSeesImages === true,
      {
        runsOnThisMac: deps.runsOnThisMac ?? (() => false),
        // The privacy valve grants this one retry permission to send pixels.
        privacyActive: () => !req.privacyBypass && (deps.privacyActive?.() ?? false),
      }
    );

    // Phase 2 (unlocked): answer.
    const answer = await streamAnswer(
      {
        model,
        question: req.question,
        chatMessages: ctx.chatMessages,
        temperature: ctx.temperature,
        effects,
        supportsVision: modelSeesImages,
        webEnabled: ctx.webEnabled,
        advisorsOn: ctx.advisorsOn,
        evidencePolicy: ctx.evidencePolicy,
        cancel,
        privacyBypass: req.privacyBypass,
        turn,
        mcp: deps.mcp(req.askId, ctx.advisorToolsOn),
      },
      {
        send: deps.send,
        runViaSidecar: deps.runViaSidecar,
        resolvedBaseUrl: deps.resolvedBaseUrl,
        detectedAdvisors: deps.detectedAdvisors,
        privacyActive: deps.privacyActive,
        privacyPolicy: () => turnPrivacyPolicy,
        jobStatuses: deps.jobStatuses,
      }
    );
    const stopped = cancel.load();

    // CHG-19 + CHG-17: ground the image NOW, and only if the model did not
    // already mark it (`effects.boxes`) and the user did not stop.
    if (effects.boxes === null && !stopped && ctx.firstImage !== null && deps.groundingPass !== undefined) {
      if (isLocateIntent(req.question, ctx.firstImage.name)) {
        const marked = await deps.groundingPass({ model, question: req.question, image: ctx.firstImage });
        if (marked !== null) {
          effects.boxes = marked;
          turn.step(deps.send, "Marked the image");
        }
      }
    }

    let content = answer;
    // CHG-10: deterministic anti-fabrication gate. The runtime KNOWS whether a
    // write/highlight happened this turn, so a claim that one did gets a plain
    // correction. Never over a stopped partial.
    if (!stopped) {
      const highlighted = effects.annotation !== null || effects.boxes !== null;
      if (claimsUnbackedAction(content, effects.wrote, highlighted)) {
        content +=
          "\n\n*(Correction: no file was actually changed this turn — the edit tool did not run or failed.)*";
      }
    }
    // ADD-7: mark the transcript so it matches what the user watched. A Stop
    // that also killed a Studio build has to SAY so, and only the tree knows
    // what this run had started — work that FINISHED before the Stop produced a
    // real artifact and is not listed. Written before the marker so the exact
    // `" *(stopped)*"` suffix stays last (the save-that path strips it by that
    // literal).
    if (stopped) {
      const also = node.stoppedChildren();
      if (also.length > 0) {
        content += `\n\n*(Also stopped: ${also.join(", ")}.)*`;
      }
      content += " *(stopped)*";
    }
    content = redactTurnText(content);

    // ADD-23: viewer effects ride the message's own `effects` column as
    // structured data — the visible answer stays plain prose.
    const effectsValue = effectsJson(effects);

    // Phase 3 (locked): save the assistant reply.
    return persistAssistantReplyPinned(deps.room, pin, req.chatId, content, ctx.sources, effectsValue);
  } finally {
    // `CancelGuard::drop` (`commands.rs:481-495`) removes BOTH halves on every
    // exit path — success, error, or cancel — so `close_room`'s drain (which
    // watches the flat `cancels` map) can see this turn finish, and a later run
    // reusing the id cannot inherit a finished run's children.
    deps.cancelState.cancels.delete(req.askId);
    forget(deps.cancelState, req.askId);
  }
}

/**
 * The newest assistant row that is a real ANSWER: not one of the app's own
 * failure notices, not a marker row, not empty. `is_failure_notice` is the
 * app's own check for "this row is one of OUR notices" — and this path, which
 * turns a previous reply into a FILE, was the one place that never asked it,
 * so a turn that failed left the user with a document containing only the
 * error text and the words "Saved your previous answer".
 */
function lastRealAssistantReply(db: Database.Database, chatId: string): Message | null {
  const rows = listMessages(db, chatId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!;
    if (m.role === "assistant" && m.kind === null && m.content.trim() !== "" && !isFailureNotice(m.content)) {
      return m;
    }
  }
  return null;
}

// ------------------------------------------------------------- handoff_chat

/** `token_usage.rs::CATEGORIES` — the 5 fixed breakdown categories, in the
 * order the frontend legend and segment stack use. Never reordered: a missing
 * or moved key silently drops a segment. */
const TOKEN_USAGE_CATEGORIES = ["system", "history", "tools", "skills", "files"] as const;

/**
 * `token_usage.rs::handoff_usage_value` — the post-handoff `AskTokenUsage`
 * snapshot, in the snake_case shape the sidecar emits.
 *
 * No LLM turn happens during a handoff, so nothing else would update the
 * token-budget bar until the next real one. The recap IS the whole
 * conversation the next turn starts from, so it is charged entirely to
 * `history`; every other category is honestly zero (nothing else exists yet)
 * and the whole snapshot is marked `estimated`.
 */
export function handoffUsageValue(recap: string, maxContext: number): Record<string, unknown> {
  const history = Math.floor(Buffer.byteLength(recap, "utf8") / CHARS_PER_TOKEN);
  const breakdown: Record<string, unknown> = {};
  for (const c of TOKEN_USAGE_CATEGORIES) {
    breakdown[c] = { tokens: c === "history" ? history : 0, estimated: true };
  }
  return { total_tokens: history, max_context: maxContext, estimated: true, breakdown };
}

/** Everything {@link handoffChat} needs beyond the chat id. */
export interface HandoffChatDeps {
  room: TurnRoomSource;
  listModels?: () => Promise<string[]>;
  /**
   * `commands::capabilities_for(model).context_window` — the engine's real
   * advertised window. Out of scope (`capabilities.rs`); the default is
   * "unpublished" (`null`), which is exactly what makes the 128,000 floor
   * below apply — the SAME floor Rust's own call site uses, not a number this
   * port invented.
   */
  contextWindowFor?: (model: string) => Promise<number | null>;
  /**
   * `ollama::handoff_summary`. Defaults to `engineRouting.ts`'s real
   * sidecar-routed call; tests inject a fake so no engine is needed.
   */
  handoffSummary?: (
    model: string,
    messages: SidecarChatMessage[],
    temperature: number | null
  ) => Promise<string>;
}

/**
 * Token-budget bar / context handoff: summarize the conversation the model
 * currently sees (already truncated at any earlier marker, per
 * `recentMessages`) and insert a fresh marker carrying the recap. Every future
 * turn in this chat then starts from that recap — the entire mechanism is
 * `recentMessages`'s truncation point, not a separate "compacted" state.
 * Ported from `agent.rs::handoff_chat`.
 */
export async function handoffChat(chatId: string, deps: HandoffChatDeps): Promise<Message> {
  // Phase 1 (locked): read what the model would currently see.
  const room = deps.room.currentRoom();
  if (room === null) {
    throw new Error("No room is open");
  }
  const explicitModel = modelSetting(room.db);
  const temperature = parseTemperature(getSetting(room.db, "temperature"));
  const newestFirst = recentMessages(room.db, chatId, MAX_HISTORY_MESSAGES);
  if (newestFirst.length === 0) {
    throw new Error("Nothing to summarize yet.");
  }
  const history = [...newestFirst].reverse();

  const models = await (deps.listModels ?? listModelsReal)();
  const model = explicitModel ?? bestDefault(models);

  // The engine's own window, read once and used twice (the budget below and
  // the bar's snapshot at the end). `null` means "not published", and the 128k
  // floor for that case stays HERE rather than inside the record — a made-up
  // number does not belong in something the app calls a fact.
  const maxContext = (await (deps.contextWindowFor?.(model) ?? Promise.resolve(null))) ?? 128_000;

  // FIT THE CONVERSATION TO THE ENGINE BEFORE SENDING IT. This is the one
  // history read with no compaction behind it: every row is flattened into a
  // single prompt for the one-shot `handoff_summary` gateway. Local Ollama
  // fits that to its window itself, but a `:cloud` model, an OpenRouter
  // provider and a cloud CLI trim NOTHING — so a long chat could overflow and
  // come back as an engine error precisely when the user pressed the button.
  const total = history.length;
  const messages: SidecarChatMessage[] = compactHistory(history, handoffBudgetBytes(maxContext)).map(
    ([role, content]) => ({ role: role as SidecarChatMessage["role"], content })
  );
  // What the recap could NOT cover has to be said: the marker is a hard
  // cut-off, so anything dropped is gone from the model's memory. The
  // transcript above the marker still shows it — this is what says to look.
  const uncovered = total - messages.length;

  // Phase 2 (unlocked): the summarization call — any engine, same as `ask`.
  // The recap BECOMES the model's entire memory of this conversation, so an
  // empty one is a FAILED handoff, not a handoff.
  const summarize = deps.handoffSummary ?? handoffSummaryReal;
  const raw = await summarize(model, messages, temperature);
  if (raw.trim() === "") {
    throw new Error(
      "The model returned an empty summary, so the conversation was left untouched. Try again, or switch models in Settings → Model."
    );
  }
  // No claim about WHY — only what was and was not covered.
  const summary =
    uncovered > 0
      ? `${raw}\n\n_This recap covers the most recent ${total - uncovered} of ${total} messages in this chat. The earlier ones are still above this marker in the transcript._`
      : raw;

  const usageValue = handoffUsageValue(summary, maxContext);

  // Phase 3 (locked): persist the marker, with that snapshot as its effects.
  // Re-read rather than reusing the handle from Phase 1: the summarization
  // above is an `.await`, and the room can close across it.
  const roomNow = deps.room.currentRoom();
  if (roomNow === null) {
    throw new Error("The room closed while summarizing.");
  }
  return insertHandoffMessage(roomNow.db, chatId, summary, usageValue);
}
