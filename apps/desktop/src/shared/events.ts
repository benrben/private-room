// Extracted from src/api.ts: every `listen<PayloadType>("event-name", ...)`
// subscription (the `api.onXxx` methods) plus the generic `askEvent<T>`
// wrapper that the `ask-*` / turn events are built on. Byte-faithful
// type-level extraction — no renamed fields, no invented shapes. Where the
// source used an inline anonymous payload type, it is given a real exported
// name here (each one's doc-comment below says which channel it came from).

import type {
  BrowseJournalRow,
  BrowserSearchResult,
  RoomInfo,
  SketchDrawn,
  AskStep,
  AskPlanStep,
  AskActiveAgent,
  AskReport,
  AskPrivacy,
  AskTokenUsage,
  PrivacyScanProgress,
  StudioStep,
  JobProgress,
  WorkflowNodeEvent,
  ScriptApproveRequest,
  AgentOpenFilePayload,
  AnnotationPayload,
  OrganizedChange,
  McpApproveRequest,
  EditApproveRequest,
  McpServerStatus,
  AgentUiRequest,
  RecSegment,
} from "./apiTypes.js";
import type { HarnessEvent } from "./harnessTypes.js";
import type { WorkspaceOperationProgressEvent } from "./workspaceProgress.js";

/** The wire shape of every `ask-*` / turn event: the payload the listener
 * wants, in `v`, under the ids of the run and chat that produced it. Built by
 * `crate::turn` on the host side (see `AskTurn` in apiTypes.ts). Every
 * `askEvent<T>(event, cb)` call site in api.ts is sugar over
 * `listen<AskEnvelope<T>>(event, ...)` — the envelope is what is ACTUALLY on
 * the wire; `askEvent` unwraps `v` (and defaults `runId`/`chatId` to `null`
 * when `v` arrives unwrapped, which the app's own host never does) before
 * handing the caller `(v, turn)`. The ids can genuinely be `null`: an emitter
 * that belongs to no conversation says so explicitly
 * (`crate::turn::emit_unowned`) rather than borrowing one. */
export interface AskEnvelope<T> {
  runId: string | null;
  chatId: string | null;
  v: T;
}

// ---- named payload types for call sites that used an inline anonymous
// object type in api.ts (kept field-for-field identical) -------------------

/** `browser-blocked`: a navigation refused by the same guard `fetch_page`
 * uses (a private or non-web address). */
export interface BrowserBlockedEvent {
  url: string;
}

/** `browser-download`: a file the page downloaded finished importing into
 * the room (`ok`), or truthfully failed (`ok: false`, `error` says why). */
export interface BrowserDownloadEvent {
  url: string;
  name: string;
  ok: boolean;
  error?: string;
}

/** `browser-download-oversize`: a download that has already grown past the
 * size a room file may be, reported WHILE it runs. */
export interface BrowserDownloadOversizeEvent {
  url: string;
  name: string;
  bytes: number;
  detail: string;
}

/** `runtime-progress`: fetching an MCP connector runtime ("uv" | "node"). */
export interface RuntimeProgressEvent {
  kind: string;
  phase: string;
  got: number;
  total: number;
}

/** `mcp-oauth-url`: an OAuth sign-in reached the browser step; carries the
 * authorize URL for the manual "open / copy" fallback. */
export interface McpOauthUrlEvent {
  server: string;
  url: string;
}

/** `stt-download-progress`: the on-device Whisper voice model downloading. */
export interface SttDownloadProgressEvent {
  got: number;
  total: number;
  percent: number;
}

/** `ask-step-status`'s envelope payload (`AskEnvelope<AskStepStatusEvent>`):
 * outcome of the most recent tool step, so a failed chip reads failed. `node`
 * (when present) says WHOSE most-recent step this resolves. */
export interface AskStepStatusEvent {
  ok: boolean;
  node?: string | null;
}

/** `import-progress`: live import queue — done/total/current name, plus a
 * final receipt (`done === total`) carrying imported/failed counts. */
export interface ImportProgressEvent {
  done: number;
  total: number;
  name: string;
  imported?: number;
  failed?: number;
}

/** `rec-read-done`: the reading finished — reload the recording so the tabs
 * fill in. (Source `listen()` call had no explicit generic; this is the type
 * the wrapper's own `cb` parameter declares.) */
export interface RecReadDoneEvent {
  fileId: string;
}

/** `rec-partial`: a live partial transcript line while a recording runs. */
export interface RecPartialEvent {
  fileId: string;
  source: "mic" | "sys";
  t0: number;
  text: string;
}

/** `rec-segment`: one finalized transcript segment. */
export interface RecSegmentEvent {
  fileId: string;
  segment: RecSegment;
}

/** `rec-segment-drop`: a row already on screen was the microphone's echo of
 * meeting audio the system lane captured too — remove it. */
export interface RecSegmentDropEvent {
  fileId: string;
  id: string;
}

/** `rec-relabel`: the meeting's speakers were re-derived from every voice
 * heard so far. `speakerNames` carries the name overlay; `recognized` names
 * which speakers were matched to a saved voice this pass. */
export interface RecRelabelEvent {
  fileId: string;
  labels: { id: string; speaker: string }[];
  speakerNames?: Record<string, string>;
  recognized?: string[];
}

/** `rec-level`: live mic/system meters while recording. */
export interface RecLevelEvent {
  fileId: string;
  mic: number;
  sys: number;
  durationCs: number;
}

/** `rec-state`: the recording's running/paused/stopped status. */
export interface RecStateEvent {
  fileId: string;
  status: string;
  durationCs: number;
}

/** `rec-save-progress`: stop→saved drain progress. The audio is already
 * durable when the first event arrives; `remaining` counts phrase decodes
 * still queued. */
export interface RecSaveProgressEvent {
  fileId: string;
  stage: "transcribing" | "writing";
  remaining: number;
}

/** `rec-source`: a recording input source's own status line. */
export interface RecSourceEvent {
  fileId: string;
  source: string;
  status: string;
  message: string;
}

/** `rec-error`: a recording-lane error tied to a specific file. */
export interface RecErrorEvent {
  fileId: string;
  message: string;
}

/** `rec-live-translation`: a live-translated line during recording. */
export interface RecLiveTranslationEvent {
  fileId: string;
  segId: string;
  text: string;
}

/** `rec-translate-progress`: whole-transcript translation progress. */
export interface RecTranslateProgressEvent {
  fileId: string;
  done: number;
  total: number;
}

/** `rec-retranscribe`: rebuilding a saved recording's whole transcript. */
export interface RecRetranscribeEvent {
  fileId: string;
  doneCs: number;
  totalCs: number;
}

/** `ytdlp-progress`: a video/audio download's own progress line. */
export interface YtdlpProgressEvent {
  status: string;
  percent: number | null;
}

// ---- every event channel, keyed by its exact wire-string name ------------
//
// Payloads for `ask-*` / turn events are `AskEnvelope<T>` — that is what is
// literally on the wire (see AskEnvelope doc above); the `api.onAskXxx`
// wrappers unwrap `.v` before calling their own `cb`, but the contract
// describes the wire shape, not the wrapper's convenience signature.
//
// Channels whose api.ts `listen(...)` call carried no generic at all AND
// whose callback takes no argument (`onXxx: (cb: () => void)`) are modeled
// as `unknown` — the source never declared a payload type for them.
export type EventPayloads = {
  "browser-journal": BrowseJournalRow;
  "browser-navigated": string;
  "browser-searched": BrowserSearchResult;
  "browser-blocked": BrowserBlockedEvent;
  "browser-download": BrowserDownloadEvent;
  "browser-download-oversize": BrowserDownloadOversizeEvent;
  "runtime-progress": RuntimeProgressEvent;
  "mcp-oauth-url": McpOauthUrlEvent;
  "dict-partial": string;
  "stt-download-progress": SttDownloadProgressEvent;
  "stt-progress": [string, string];
  "ocr-progress": [string, string];
  "open-room-file": string;
  "room-rolled-back": RoomInfo;
  "ask-delta": AskEnvelope<string>;
  "sketch-drawn": SketchDrawn;
  "ask-step": AskEnvelope<string | AskStep>;
  "ask-lane": AskEnvelope<string>;
  "ask-plan": AskEnvelope<AskPlanStep[]>;
  "ask-agent": AskEnvelope<AskActiveAgent>;
  "ask-step-status": AskEnvelope<AskStepStatusEvent>;
  "ask-round": AskEnvelope<unknown>;
  "ask-report": AskEnvelope<AskReport>;
  "ask-privacy": AskEnvelope<AskPrivacy>;
  "ask-token-usage": AskEnvelope<AskTokenUsage>;
  "privacy-scan": PrivacyScanProgress;
  "studio-step": StudioStep;
  "job-progress": JobProgress;
  "workflow-node": WorkflowNodeEvent;
  "workflows-changed": unknown;
  "skills-changed": unknown;
  "memories-changed": unknown;
  "script-approve-request": ScriptApproveRequest;
  "import-progress": ImportProgressEvent;
  "agent-open-file": AgentOpenFilePayload;
  "agent-annotate": AnnotationPayload;
  "file-updated": string;
  "assistant-organized": OrganizedChange;
  "room-files-changed": unknown;
  "mcp-approve-request": McpApproveRequest;
  "edit-approve-request": EditApproveRequest;
  "mcp-status": McpServerStatus[];
  "rec-read-done": RecReadDoneEvent;
  "rec-partial": RecPartialEvent;
  "rec-segment": RecSegmentEvent;
  "rec-segment-drop": RecSegmentDropEvent;
  "rec-relabel": RecRelabelEvent;
  "rec-level": RecLevelEvent;
  "rec-state": RecStateEvent;
  "rec-save-progress": RecSaveProgressEvent;
  "rec-source": RecSourceEvent;
  "rec-error": RecErrorEvent;
  "rec-live-translation": RecLiveTranslationEvent;
  "rec-translate-progress": RecTranslateProgressEvent;
  "rec-retranscribe": RecRetranscribeEvent;
  "quit-requested": unknown;
  "menu-action": string;
  "ytdlp-progress": YtdlpProgressEvent;
  "agent-ui-request": AgentUiRequest;
  "pull-progress": { status: string; percent: number | null };
  "harness-event": HarnessEvent;
  "workspace-operation-progress": WorkspaceOperationProgressEvent;
};

// extracted events: browser-journal, browser-navigated, browser-searched,
// browser-blocked, browser-download, browser-download-oversize,
// runtime-progress, mcp-oauth-url, dict-partial, stt-download-progress,
// stt-progress, ocr-progress, open-room-file, room-rolled-back, ask-delta,
// sketch-drawn, ask-step, ask-lane, ask-plan, ask-agent, ask-step-status,
// ask-round, ask-report, ask-privacy, ask-token-usage, privacy-scan,
// studio-step, job-progress, workflow-node, workflows-changed,
// skills-changed, memories-changed, script-approve-request, import-progress,
// agent-open-file, agent-annotate, file-updated, assistant-organized,
// room-files-changed, mcp-approve-request, edit-approve-request, mcp-status,
// rec-read-done, rec-partial, rec-segment, rec-segment-drop, rec-relabel,
// rec-level, rec-state, rec-save-progress, rec-source, rec-error,
// rec-live-translation, rec-translate-progress, rec-retranscribe,
// quit-requested, menu-action, ytdlp-progress, agent-ui-request
// (59 channels total, plus the AskEnvelope<T> wrapper they build on)
