/** Cohesive extraction from chatCommandsGenerate.ts; its public API remains on that module. */
import { Agent as UndiciAgent } from "undici";
import { CancelFlag } from "./cancel.js";
import { Artifact, type Written } from "./artifactBuilder.js";
import {
  askQuiet,
  cmdWindows,
  digest,
  type CmdCtx as KnowledgeCmdCtx,
  type CommandResult,
  type EmitFn,
} from "./chatCommandsKnowledge.js";
import { htmlDocument, htmlEscape, htmlNoteName, refsContext, refsFiles } from "./docsHtml.js";
import {
  availableName,
  currentDate,
  getFileFull,
  listFileInventory,
  setFileExtractedText,
} from "./db-host/files.js";
import { serializeDelim } from "./editMatchCells.js";
import { extensionOf } from "./editMatchExtraction.js";
import { createToolEffects } from "./execTool.js";
import { chatStructured, plainGenerateBody } from "./ollamaGenerate.js";
import { isCliEngine } from "./turnContext.js";
import { webAccessEnabled } from "./gatherContext.js";
import { blockedNote, fetchReadable, joinNames, searchWeb } from "./web.js";
import { linkFileName } from "./browser/saved.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import { createRoomFile, readRoomFile } from "./workspace/roomContent.js";
import { SIDECAR_DOWN, sidecarErrorSentinel, type SidecarError } from "./sidecarJsonCancellable.js";
import {
  authedHeaders,
  busy,
  ensureUp,
  splitCompleteLines,
  waitForNextChunkOrCancel,
  type ChunkReader,
  type ChunkStep,
} from "./sidecar.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { injectPolicy } from "./privacy.js";
import { defaultProviderDeps, ensureProviderCatalog, injectProviderRuntime, type ProviderDeps } from "./providers.js";
import type { WebHit } from "../shared/apiTypes.js";

export type { CommandResult };
import { CmdCtx, KEEP_ALIVE_WARM, MediaKind, generateStream, isRecord } from "./chatGenerateContext.js";
// ============================================================================
// watch_stream — the per-command watchdog
// ============================================================================

/** Longest gap with no token before a STREAMED step counts as stalled.
 * Ported verbatim from `COMMAND_STREAM_IDLE_SECS`. */
export const COMMAND_STREAM_IDLE_SECS = 300;

/** The cloud-CLI twin — sized past the sidecar's own wedged-CLI budget
 * (900s). A CLI engine streams its answer text live now, but its SILENT
 * phases are still whole work sessions — thinking blocks and tool loops emit
 * no text delta for minutes at a time. Ported verbatim from
 * `COMMAND_STREAM_IDLE_CLI_SECS`. */
export const COMMAND_STREAM_IDLE_CLI_SECS = 960;

/** How long Stop waits for the stream to notice the flag by itself before
 * hanging up on its behalf. Ported verbatim from `COMMAND_STOP_GRACE_MS`. */
export const COMMAND_STOP_GRACE_MS = 1_500;

/** THE one copy of this rule (`chatCommands.ts` re-exports it). Keyed on the
 * ENGINE KIND (the subprocess CLIs only — OpenRouter is a real chat API on
 * the ordinary clock), not the `streaming` declaration: the CLI engines
 * stream now, but what this clock really measures is tolerable silence, and
 * a harness thinking or driving its tools is silent on the text channel
 * while being entirely alive. */
export function streamIdleSecs(model: string): number {
  return isCliEngine(model) ? COMMAND_STREAM_IDLE_CLI_SECS : COMMAND_STREAM_IDLE_SECS;
}

export type StreamWatchResult =
  | { tag: "value"; value: string }
  | { tag: "error"; error: unknown }
  | { tag: "tick" };

export function settledStream(fut: Promise<string>): Promise<Exclude<StreamWatchResult, { tag: "tick" }>> {
  return fut.then(
    (value) => ({ tag: "value", value }),
    (error: unknown) => ({ tag: "error", error })
  );
}

export async function waitForStreamResult(
  settled: Promise<Exclude<StreamWatchResult, { tag: "tick" }>>,
): Promise<StreamWatchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = new Promise<{ tag: "tick" }>((resolve) => {
    timer = setTimeout(() => resolve({ tag: "tick" }), 200);
  });
  try {
    return await Promise.race([settled, tick]);
  } finally {
    clearTimeout(timer);
  }
}

export function completedStreamValue(result: StreamWatchResult): string | null {
  if (result.tag === "value") return result.value;
  if (result.tag === "error") throw result.error;
  return null;
}

export function stoppedStreamValue(
  cancel: CancelFlag,
  stopSeenAt: number | null,
  graceMs: number,
  abort: () => void,
  partial: { readonly current: string },
): { stopSeenAt: number | null; value: string | null } {
  if (!cancel.load()) return { stopSeenAt, value: null };
  const since = stopSeenAt ?? Date.now();
  if (Date.now() - since < graceMs) return { stopSeenAt: since, value: null };
  abort();
  return { stopSeenAt: since, value: partial.current };
}

export function streamIsIdle(lastToken: { readonly current: number }, idleSecs: number): boolean {
  return Date.now() - lastToken.current >= idleSecs * 1000;
}

/**
 * Race `fut` against Stop-grace and an idle ceiling. Ported from
 * `watch_stream`, adapted for JS's lack of Rust's "dropping a future cancels
 * its work": on either give-up path this calls `abort()` (the caller's hook
 * into {@link generateStream}'s `AbortController`) before returning/throwing,
 * which is what actually closes the connection here — see this file's module
 * doc.
 *
 * `lastToken`/`partial` are caller-owned mutable boxes (`{current: T}`, this
 * port's idiom for "the same cell several closures write to") updated by the
 * stream's own delta callback; `fut` itself is raced repeatedly against a
 * fresh ~200ms timer each loop, the same "re-race the SAME pending promise"
 * idiom `sidecar.ts`'s `waitForNextChunkOrCancel` already establishes, so a
 * result that becomes ready mid-tick is picked up on the very next microtask
 * rather than waiting out a whole poll interval.
 */
export async function watchStream(
  fut: Promise<string>,
  abort: () => void,
  cancel: CancelFlag,
  lastToken: { readonly current: number },
  partial: { readonly current: string },
  idleSecs: number,
  graceMs: number
): Promise<string> {
  const settled = settledStream(fut);
  let stopSeenAt: number | null = null;
  for (;;) {
    const completed = completedStreamValue(await waitForStreamResult(settled));
    if (completed !== null) return completed;
    const stopped = stoppedStreamValue(cancel, stopSeenAt, graceMs, abort, partial);
    stopSeenAt = stopped.stopSeenAt;
    if (stopped.value !== null) return stopped.value;
    if (streamIsIdle(lastToken, idleSecs)) {
      abort();
      throw new Error(
        "The model stopped responding. Try a shorter selection, or switch to a faster model in Settings."
      );
    }
  }
}

// ============================================================================
// ask_streaming / ask_structured — the two CmdCtx methods knowledge.rs never
// needed (see this file's module doc)
// ============================================================================

/** One model call streamed live into the chat. Ported from `ask_streaming`. */
export async function askStreaming(ctx: CmdCtx, system: string, user: string): Promise<string> {
  const messages: SidecarChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const body = plainGenerateBody(ctx.model, messages, ctx.temperature, KEEP_ALIVE_WARM);
  const controller = new AbortController();
  const lastToken = { current: Date.now() };
  const partial = { current: "" };
  const turn = ctx.turn;
  const send = ctx.send;
  const streamFn = ctx.generateStream ?? generateStream;
  const fut = streamFn("/generate_stream", body, ctx.cancel, controller, (d) => {
    lastToken.current = Date.now();
    partial.current += d;
    turn.emit(send, "ask-delta", d);
  });
  return watchStream(
    fut,
    () => controller.abort(),
    ctx.cancel,
    lastToken,
    partial,
    streamIdleSecs(ctx.model),
    COMMAND_STOP_GRACE_MS
  );
}

/** ADD-22: like `askQuiet`, but the reply is constrained to `schema`. Ported
 * from `ask_structured` (no timeout wrapper in Rust either). */
export async function askStructured(
  ctx: CmdCtx,
  system: string,
  user: string,
  temp: number | null,
  schema: unknown
): Promise<string> {
  const fn = ctx.chatStructured ?? chatStructured;
  const messages: SidecarChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return fn(ctx.model, messages, temp, KEEP_ALIVE_WARM, schema, { cancel: ctx.cancel });
}

// ============================================================================
// genuinely unported dependencies — mediaKind (stt.rs slice; the two seams'
// types/defaults are declared earlier, alongside CmdCtx)
// ============================================================================

/** `stt::media_kind` — ported verbatim (pure, no decoding). */
export function mediaKind(mime: string, ext: string): MediaKind | null {
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  return extensionMediaKind(ext);
}

export const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "wav", "aac", "flac", "aiff", "aif", "caf", "ogg", "opus"]);
export const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v"]);

export function extensionMediaKind(ext: string): MediaKind | null {
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

// ============================================================================
// docs_html/minutes.rs — doc_hero / minutes_schema / merge_minutes /
// render_minutes_html (local ports — see module doc)
// ============================================================================

/** Ported verbatim from `docs_html.rs`'s `doc_hero`. */
export function docHero(eyebrow: string, title: string, subHtml: string): string {
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

/** Extract the LAST markdown table in `text` as rows of cells (header
 * first). Ported verbatim from `docs_html.rs`'s `extract_md_table`. */
export function extractMdTable(text: string): string[][] | null {
  let last: string[][] | null = null;
  let cur: string[][] = [];
  const flush = (): void => {
    if (cur.length >= 2) {
      last = cur;
    }
    cur = [];
  };
  for (const line of text.split(/\r\n|\n/)) {
    const t = line.trim();
    if (!t.includes("|")) {
      flush();
      continue;
    }
    if (Array.from(t).every((c) => c === "|" || c === "-" || c === ":" || c === " ")) {
      continue; // a separator row like |---|---| carries no data
    }
    const trimmed = t.replace(/^\|+/, "").replace(/\|+$/, "");
    cur.push(trimmed.split("|").map((c) => c.trim()));
  }
  flush();
  return last;
}

/** Ported verbatim from `minutes_schema`. */
export function minutesSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      date: { type: "string" },
      attendees: { type: "array", items: { type: "string" } },
      timeline: {
        type: "array",
        items: {
          type: "object",
          properties: {
            time: { type: "string" },
            topic: { type: "string" },
            summary: { type: "string" },
          },
          required: ["topic", "summary"],
        },
      },
      decisions: { type: "array", items: { type: "string" } },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: { owner: { type: "string" }, task: { type: "string" } },
          required: ["task"],
        },
      },
    },
    required: ["title", "timeline"],
  };
}

export interface MinutesDoc {
  title: string;
  date: string;
  attendees: string[];
  timeline: Array<Record<string, unknown>>;
  decisions: string[];
  actions: Array<Record<string, unknown>>;
}

export function minutesField(v: unknown, k: string): string {
  const r = isRecord(v) ? v[k] : undefined;
  return typeof r === "string" ? r.trim() : "";
}

export function minutesPart(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

export function minutesValues(part: Record<string, unknown>, key: string): readonly unknown[] {
  const value = part[key];
  return Array.isArray(value) ? value : [];
}

export function minutesKey(value: string): string {
  return value.trim().toLowerCase();
}

export function firstMinutesValue(parts: readonly unknown[], key: string): string {
  for (const raw of parts) {
    const value = minutesField(raw, key);
    if (value !== "") return value;
  }
  return "";
}

export function appendDistinctMinutesStrings(
  values: readonly unknown[],
  seen: Set<string>,
  output: string[],
): void {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    const key = minutesKey(text);
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
}

export function mergeMinutesStrings(parts: readonly unknown[], key: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of parts) {
    appendDistinctMinutesStrings(minutesValues(minutesPart(raw), key), seen, output);
  }
  return output;
}

export function appendTimelineItems(
  values: readonly unknown[],
  seen: Set<string>,
  output: Array<Record<string, unknown>>,
): void {
  for (const value of values) {
    if (!isRecord(value)) continue;
    const topic = minutesField(value, "topic");
    const summary = minutesField(value, "summary");
    if (topic === "" && summary === "") continue;
    const key = `${minutesKey(topic)}|${minutesKey(summary)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
}

export function mergeTimelineItems(parts: readonly unknown[]): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const output: Array<Record<string, unknown>> = [];
  for (const raw of parts) {
    appendTimelineItems(minutesValues(minutesPart(raw), "timeline"), seen, output);
  }
  return output;
}

export function appendActionItems(
  values: readonly unknown[],
  seen: Set<string>,
  output: Array<Record<string, unknown>>,
): void {
  for (const value of values) {
    if (!isRecord(value)) continue;
    const owner = minutesField(value, "owner");
    const task = minutesField(value, "task");
    if (task === "") continue;
    const key = `${minutesKey(owner)}|${minutesKey(task)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
}

export function mergeActionItems(parts: readonly unknown[]): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const output: Array<Record<string, unknown>> = [];
  for (const raw of parts) {
    appendActionItems(minutesValues(minutesPart(raw), "actions"), seen, output);
  }
  return output;
}

/** Merge per-window minutes into one document's worth of structured fields —
 * deterministic, so a long meeting cannot lose its second half to a model
 * that only had room for the first. Ported verbatim from `merge_minutes`. */
export function mergeMinutes(parts: readonly unknown[]): MinutesDoc {
  return {
    title: firstMinutesValue(parts, "title"),
    date: firstMinutesValue(parts, "date"),
    attendees: mergeMinutesStrings(parts, "attendees"),
    timeline: mergeTimelineItems(parts),
    decisions: mergeMinutesStrings(parts, "decisions"),
    actions: mergeActionItems(parts),
  };
}

export function nonemptyMinutesStrings(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

export function minutesMeta(date: string, attendees: readonly string[]): string {
  const meta: string[] = [];
  if (date !== "") meta.push(htmlEscape(date));
  if (attendees.length > 0) {
    meta.push(`${attendees.length} attendee${attendees.length === 1 ? "" : "s"}`);
  }
  return meta.join(" · ");
}

export function attendeeHtml(attendees: readonly string[]): string {
  if (attendees.length === 0) return "";
  let html = '<div class="chips">';
  for (const attendee of attendees) {
    html += `<span class="chip">${htmlEscape(attendee)}</span>`;
  }
  return `${html}</div>\n`;
}

export function meaningfulTimelineItem(item: Record<string, unknown>): boolean {
  return minutesField(item, "topic") !== "" || minutesField(item, "summary") !== "";
}

export function timelineFieldHtml(className: string, value: string, tag: "div" | "p"): string {
  return value === "" ? "" : `<${tag} class="${className}">${htmlEscape(value)}</${tag}>`;
}

export function timelineItemHtml(item: Record<string, unknown>): string {
  return (
    "<li>" +
    timelineFieldHtml("time", minutesField(item, "time"), "div") +
    timelineFieldHtml("topic", minutesField(item, "topic"), "div") +
    timelineFieldHtml("summary", minutesField(item, "summary"), "p") +
    "</li>\n"
  );
}

export function timelineHtml(timeline: readonly Record<string, unknown>[]): string {
  const items = timeline.filter(meaningfulTimelineItem);
  if (items.length === 0) return "";
  let html = '<h2>Timeline</h2>\n<ul class="tl">\n';
  for (const item of items) html += timelineItemHtml(item);
  return `${html}</ul>\n`;
}

export function stringSectionHtml(title: string, className: string, values: readonly string[]): string {
  if (values.length === 0) return "";
  let html = `<h2>${title}</h2>\n<ul class="${className}">\n`;
  for (const value of values) html += `<li>${htmlEscape(value)}</li>\n`;
  return `${html}</ul>\n`;
}

export function actionRows(actions: readonly Record<string, unknown>[]): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const action of actions) {
    const task = minutesField(action, "task");
    if (task !== "") rows.push([minutesField(action, "owner"), task]);
  }
  return rows;
}

export function actionHtml(actions: readonly Record<string, unknown>[]): string {
  const rows = actionRows(actions);
  if (rows.length === 0) return "";
  let html = '<h2>Action items</h2>\n<table class="actions">\n<tr><th>Owner</th><th>Task</th></tr>\n';
  for (const [owner, task] of rows) {
    const ownerHtml = owner === "" ? "—" : htmlEscape(owner);
    html += `<tr><td>${ownerHtml}</td><td>${htmlEscape(task)}</td></tr>\n`;
  }
  return `${html}</table>\n`;
}

/** Render structured minutes into a timeline-styled HTML body. Ported
 * verbatim from `render_minutes_html`. */
export function renderMinutesHtml(p: MinutesDoc, title: string): string {
  const date = p.date.trim();
  const attendees = nonemptyMinutesStrings(p.attendees);
  return (
    docHero("Meeting minutes", title, minutesMeta(date, attendees)) +
    attendeeHtml(attendees) +
    timelineHtml(p.timeline) +
    stringSectionHtml("Decisions", "checks", nonemptyMinutesStrings(p.decisions)) +
    actionHtml(p.actions)
  );
}
