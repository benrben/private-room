import { type CancelFlag } from "./cancel.js";
import { type ToolEffects } from "./execTool.js";
import { activePolicy as activePrivacyPolicy, policyPayload, type PolicyState } from "./privacy.js";
import { emptyPrivacyReport, type StreamRedactor } from "./privacyRedact.js";
import { resolvedBaseUrl as resolvedBaseUrlReal } from "./engineRouting.js";
import { type QuestionContext } from "./gatherContext.js";
import { runViaSidecar as runViaSidecarReal, type RunViaSidecarMcp, type SidecarChatMessage, type SidecarOutcome } from "./sidecar.js";
import { TurnId, type EventSender } from "./turn.js";
import { backgroundWorkLive, emptyReplyNotice } from "./turnNotices.js";
import { isCliEngine } from "./turnContext.js";
import { redactTurnText } from "./turnEngine.js";



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
export

/** How often the polled {@link CancelFlag} is checked in order to abort the
 * sidecar stream. `sidecar.ts` polls its own `AbortSignal` at the same cadence,
 * so chaining the two does not worsen a Stop's end-to-end latency. */
const CANCEL_BRIDGE_POLL_MS = 100;
export

/** Redact only visible answer text while preserving the turn envelope.
 *
 * `ask-round` replaces the live answer, so its unfinished suffix must be
 * discarded too; otherwise two different rounds could be joined into one
 * apparent protected value. */
function redactVisibleAnswerEvents(send: EventSender, redactor: StreamRedactor): EventSender {
  return (event, payload) => redactVisibleAnswerEvent(send, redactor, event, payload);
}
export function redactVisibleAnswerEvent(
  send: EventSender,
  redactor: StreamRedactor,
  event: string,
  payload: unknown
): void {
  if (event === "ask-round") {
    redactor.reset();
    send(event, payload);
    return;
  }
  if (event !== "ask-delta") {
    send(event, payload);
    return;
  }
  redactDeltaEvent(send, redactor, payload);
}
export function redactDeltaEvent(send: EventSender, redactor: StreamRedactor, payload: unknown): void {
  if (typeof payload === "string") {
    sendRedactedDelta(send, redactor, payload);
    return;
  }
  const envelope = deltaEnvelope(payload);
  if (envelope !== null) {
    sendRedactedDelta(send, redactor, envelope.v, envelope);
  }
}
export type DeltaEnvelope = Record<string, unknown> & { v: string };
export function deltaEnvelope(payload: unknown): DeltaEnvelope | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const envelope = payload as Record<string, unknown>;
  return typeof envelope.v === "string" ? (envelope as DeltaEnvelope) : null;
}
export function sendRedactedDelta(
  send: EventSender,
  redactor: StreamRedactor,
  text: string,
  envelope?: DeltaEnvelope
): void {
  const visible = redactor.feed(text);
  if (visible !== "") {
    send("ask-delta", envelope === undefined ? visible : { ...envelope, v: visible });
  }
}
export

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
  const privacyPolicy = resolveStreamPrivacyPolicy(deps);
  announcePrivacyBypass(req, deps, privacyPolicy);
  const outputRedactor = streamOutputRedactor(req, privacyPolicy);
  const visibleSend = visibleStreamSender(deps.send, outputRedactor);
  const advisors = await streamAdvisors(req, deps);
  announceCliEngine(req, deps.send);
  const outcome = await runStream(req, deps, privacyPolicy, advisors, visibleSend);
  if (outcome === null) {
    return "";
  }
  flushStreamRedactor(req, deps.send, outputRedactor);
  mergeStreamEffects(req.effects, outcome);
  return redactTurnText(streamOutcomeText(req, deps, outcome), privacyPolicy, req.privacyBypass);
}
export function resolveStreamPrivacyPolicy(deps: StreamAnswerDeps): PolicyState | null {
  return deps.privacyPolicy === undefined ? activePrivacyPolicy() : deps.privacyPolicy();
}
export function announcePrivacyBypass(req: StreamAnswerRequest, deps: StreamAnswerDeps, privacyPolicy: PolicyState | null): void {
  const privacyIsActive = privacyPolicy !== null || (deps.privacyActive?.() ?? false);
  if (req.privacyBypass && privacyIsActive) {
    req.turn.emit(deps.send, "ask-privacy", { bypassed: true });
  }
}
export function streamOutputRedactor(req: StreamAnswerRequest, privacyPolicy: PolicyState | null): StreamRedactor | null {
  return privacyPolicy !== null && !req.privacyBypass ? privacyPolicy.redactor.stream(emptyPrivacyReport()) : null;
}
export function visibleStreamSender(send: EventSender, redactor: StreamRedactor | null): EventSender {
  return redactor === null ? send : redactVisibleAnswerEvents(send, redactor);
}
export async function streamAdvisors(req: StreamAnswerRequest, deps: StreamAnswerDeps): Promise<string[]> {
  return req.advisorsOn ? await (deps.detectedAdvisors?.() ?? Promise.resolve([])) : [];
}
export function announceCliEngine(req: StreamAnswerRequest, send: EventSender): void {
  if (isCliEngine(req.model)) {
    req.turn.step(send, "Asking your cloud AI (content leaves this Mac)");
  }
}
export async function runStream(
  req: StreamAnswerRequest,
  deps: StreamAnswerDeps,
  privacyPolicy: PolicyState | null,
  advisors: string[],
  onEvent: EventSender
): Promise<SidecarOutcome | null> {
  const run = deps.runViaSidecar ?? runViaSidecarReal;
  const bridge = abortSignalFor(req.cancel);
  try {
    return await run(
      sidecarRequest(req, deps, privacyPolicy, advisors),
      { turn: req.turn, onEvent, signal: bridge.signal }
    );
  } catch (error) {
    return unavailableStreamOutcome(req.cancel, error);
  } finally {
    bridge.stop();
  }
}
export function sidecarRequest(
  req: StreamAnswerRequest,
  deps: StreamAnswerDeps,
  privacyPolicy: PolicyState | null,
  advisors: string[]
): Parameters<typeof runViaSidecarReal>[0] {
  return {
    model: req.model,
    question: req.question,
    messages: req.chatMessages,
    temperature: req.temperature,
    ollamaBaseUrl: (deps.resolvedBaseUrl ?? resolvedBaseUrlReal)(),
    mcp: req.mcp,
    webEnabled: req.webEnabled,
    toolPolicy: req.evidencePolicy === "no-tools-no-sources" ? "none" : "auto",
    runId: req.turn.runId,
    privacy: privacyPayload(privacyPolicy, req.privacyBypass),
    supportsVision: req.supportsVision ?? null,
    advisors,
  };
}
export function privacyPayload(privacyPolicy: PolicyState | null, privacyBypass: boolean): ReturnType<typeof policyPayload> | null {
  return privacyPolicy !== null && !privacyBypass ? policyPayload(privacyPolicy) : null;
}
export function unavailableStreamOutcome(cancel: CancelFlag, error: unknown): null {
  if (cancel.load()) {
    return null;
  }
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`agent sidecar unavailable: ${reason}`);
  throw new Error(`AI engine unavailable — the agent sidecar could not start (${reason}).`);
}
export function flushStreamRedactor(req: StreamAnswerRequest, send: EventSender, redactor: StreamRedactor | null): void {
  if (redactor === null) {
    return;
  }
  const tail = redactor.flush();
  if (tail !== "") {
    req.turn.emit(send, "ask-delta", tail);
  }
}
export function mergeStreamEffects(effects: ToolEffects, outcome: SidecarOutcome): void {
  if (outcome.usage !== null) {
    effects.tokenUsage = outcome.usage;
  }
  if (outcome.plan !== null) {
    effects.agentPlan = outcome.plan;
  }
}
export function streamOutcomeText(req: StreamAnswerRequest, deps: StreamAnswerDeps, outcome: SidecarOutcome): string {
  return outcome.kind === "done" ? completedStreamText(req, deps, outcome) : failedStreamText(outcome);
}
export function completedStreamText(
  req: StreamAnswerRequest,
  deps: StreamAnswerDeps,
  outcome: Extract<SidecarOutcome, { kind: "done" }>
): string {
  if (outcome.text.trim() !== "") {
    return outcome.text;
  }
  return emptyReplyNotice(
    req.cancel.load(),
    req.effects.wrote,
    backgroundWorkLive(deps.jobStatuses ?? (() => undefined))
  );
}
export function failedStreamText(outcome: Extract<SidecarOutcome, { kind: "failed" }>): string {
  const separator = outcome.text.trim() === "" ? "" : "\n\n";
  return `${outcome.text}${separator}*(The agent hit an error and stopped mid-run: ${outcome.error}. Any change shown here was already applied.)*`;
}
