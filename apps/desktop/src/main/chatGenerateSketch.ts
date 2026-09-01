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
import { CmdCtx, MediaKind, commandResult, emitSafely, layoutGraphNotImplemented, requireRoom, transcribeAudioNotImplemented } from "./chatGenerateContext.js";
import { mergeSketch, sketchSource, sketchWindowRequest } from "./chatGenerateData.js";
import { askStructured, extractMdTable, mediaKind, mergeMinutes, minutesSchema, renderMinutesHtml } from "./chatGenerateDocuments.js";
// ============================================================================
// #transcribe
// ============================================================================

export interface TranscriptionInput {
  room: RoomHandle;
  fileId: string;
  name: string;
  ext: string;
  text: string;
  kind: MediaKind | null;
}

export function transcriptionInput(ctx: CmdCtx): TranscriptionInput {
  const fileId = ctx.refs[0];
  if (fileId === undefined) {
    throw new Error("Add a recording with @ — e.g. #transcribe @meeting.m4a");
  }
  const room = requireRoom(ctx.rooms);
  const [name, mimeRaw, , textRaw] = getFileFull(room.db, fileId);
  const mime = mimeRaw ?? "";
  const text = textRaw ?? "";
  const ext = extensionOf(name);
  const kind = mediaKind(mime, ext);
  return { room, fileId, name, ext, text, kind };
}

export function cachedTranscriptResult(name: string, text: string): CommandResult {
  return commandResult(`Transcript of **${name}**:\n\n${text.trim()}`, [name]);
}

export function cacheTranscript(input: TranscriptionInput, transcript: string): void {
  const fullText = `(transcribed from recording)\n${transcript}`;
  try {
    setFileExtractedText(input.room.db, input.fileId, fullText);
  } catch {
    // best-effort, matching Rust's `let _ = db::update_file_content(...)`
  }
}

export async function transcribeNewAudio(ctx: CmdCtx, input: TranscriptionInput): Promise<CommandResult> {
  if (input.kind === null) {
    throw new Error(`"${input.name}" isn't an audio or video file.`);
  }
  ctx.turn.step(ctx.send, `Transcribing ${input.name} (long recordings take a while)…`);
  const bytes = (await readRoomFile(input.room, input.fileId)).bytes;
  if (bytes === null) {
    throw new Error("This recording has no stored audio.");
  }
  const transcribeAudio = ctx.transcribeAudio ?? transcribeAudioNotImplemented;
  const transcript = (await transcribeAudio(bytes, input.ext, input.kind)).trim();
  if (transcript === "") {
    throw new Error(
      `Couldn't get any speech from "${input.name}" — it may be silent, music-only, or an unreadable format.`
    );
  }
  cacheTranscript(input, transcript);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  return commandResult(`Transcript of **${input.name}**:\n\n${transcript}`, [input.name]);
}

export async function cmdTranscribe(ctx: CmdCtx): Promise<CommandResult> {
  const input = transcriptionInput(ctx);
  return input.text.trim() === ""
    ? transcribeNewAudio(ctx, input)
    : cachedTranscriptResult(input.name, input.text);
}

// ============================================================================
// #minutes
// ============================================================================

export const MINUTES_SYS =
  "You turn a meeting transcript or notes into structured minutes. Produce a short " +
  "title; the date if stated; attendees if named; a TIMELINE of the discussion as an " +
  "ordered list of items, each with an optional time or phase label, a short topic, and " +
  "a 1-2 sentence summary; the key decisions; and action items with an owner when known. " +
  "Base everything ONLY on the source — leave a field empty rather than inventing it.";

export interface StructuredWindowRequest {
  system: string;
  temperature: number;
  schema: Record<string, unknown>;
  stepText: (part: number, total: number) => string;
  userText: (window: string, part: number, total: number) => string;
}

export interface StructuredWindowParts {
  parts: unknown[];
  total: number;
}

export async function parsedStructuredWindow(
  ctx: CmdCtx,
  request: StructuredWindowRequest,
  window: string,
  part: number,
  total: number,
): Promise<unknown | undefined> {
  try {
    const raw = await askStructured(ctx, request.system, request.userText(window, part, total), request.temperature, request.schema);
    return JSON.parse(raw.trim());
  } catch {
    ctx.unread.count += 1;
    return undefined;
  }
}

export async function structuredWindowParts(
  ctx: CmdCtx,
  source: string,
  request: StructuredWindowRequest,
): Promise<StructuredWindowParts> {
  const windows = cmdWindows(source);
  const parts: unknown[] = [];
  for (let index = 0; index < windows.length; index++) {
    if (ctx.cancel.load()) break;
    const part = index + 1;
    ctx.turn.step(ctx.send, request.stepText(part, windows.length));
    const parsed = await parsedStructuredWindow(ctx, request, windows[index]!, part, windows.length);
    if (parsed !== undefined) parts.push(parsed);
  }
  return { parts, total: windows.length };
}

export function minutesSource(ctx: CmdCtx, refctx: string): string {
  if (ctx.refs.length > 0 && refctx.trim() === "") {
    throw new Error(
      "That file has no readable text yet — if it's a recording, run #transcribe on it first, then #minutes."
    );
  }
  if (refctx.trim() !== "") return refctx;
  if (ctx.history.trim() !== "") return `Conversation:\n${ctx.history}`;
  throw new Error(
    "Give me something to turn into minutes — e.g. #minutes @meeting.m4a (a transcript or notes), " +
      "or run it after a discussion in this chat."
  );
}

export function minutesWindowRequest(): StructuredWindowRequest {
  return {
    system: MINUTES_SYS,
    temperature: 0.3,
    schema: minutesSchema(),
    stepText: (part, total) =>
      total > 1 ? `Building the meeting minutes — part ${part}/${total}…` : "Building the meeting minutes…",
    userText: (window, part, total) =>
      total > 1
        ? `This is part ${part} of ${total} of one meeting, in order. Minute THIS part only; earlier and ` +
          `later parts are handled separately.\n\nSource:\n${window}`
        : `Source:\n${window}`,
  };
}

export async function cmdMinutes(ctx: CmdCtx): Promise<CommandResult> {
  const room = requireRoom(ctx.rooms);
  const [refctx, refNames] = refsContext(room.db, ctx.refs);
  const source = minutesSource(ctx, refctx);
  const { parts, total } = await structuredWindowParts(ctx, source, minutesWindowRequest());

  const parsed = mergeMinutes(parts);
  if (parsed.timeline.length === 0) {
    throw new Error(
      "Couldn't find a meeting to summarize in that source. Point #minutes at a transcript or notes " +
        "with @, e.g. #minutes @meeting.m4a."
    );
  }
  const title = parsed.title.trim() !== "" ? parsed.title.trim() : "Meeting minutes";
  const body = renderMinutesHtml(parsed, title);
  const doc = htmlDocument(title, body);
  const name = htmlNoteName(title);
  const artifact = Artifact.note(name, doc)
    .by("#minutes")
    .duringRun(ctx.turn.runId)
    .fromFiles(ctx.refs)
    .cancelWith(ctx.cancel);
  const written = room.workspace === undefined
    ? artifact.commit(room.db)
    : await artifact.commitToWorkspace(room.workspace);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  emitSafely(ctx.emit, "agent-open-file", { id: written.meta.id });
  const items = parsed.timeline.length;
  const coverage =
    total > 1
      ? ` — a ${items}-point timeline, read in ${total} passes over the whole source`
      : " — a timeline of the meeting";
  return commandResult(`Created **${written.meta.name}**${coverage}.`, refNames);
}

// ============================================================================
// #sketch
// ============================================================================

export function sketchLayout(ctx: CmdCtx): NonNullable<CmdCtx["layoutGraph"]> {
  return ctx.layoutGraph === undefined ? layoutGraphNotImplemented : ctx.layoutGraph;
}

export async function commitSketchArtifact(room: RoomHandle, artifact: Artifact): Promise<Written> {
  if (room.workspace === undefined) return artifact.commit(room.db);
  return artifact.commitToWorkspace(room.workspace);
}

export function sketchCoverage(total: number): string {
  return total > 1 ? `, read in ${total} passes over the whole source` : "";
}

export async function cmdSketch(ctx: CmdCtx): Promise<CommandResult> {
  const room = requireRoom(ctx.rooms);
  const [refctx, refNames] = refsContext(room.db, ctx.refs);
  const source = sketchSource(ctx, refctx);
  const { parts, total } = await structuredWindowParts(ctx, source, sketchWindowRequest());

  const { title, explanation, nodes, edges } = mergeSketch(parts);
  if (nodes.length === 0) {
    throw new Error(
      "Couldn't find anything to draw in that source. Point #sketch at a document with some structure " +
        "to it — a plan, a process, a design — or describe what to draw."
    );
  }
  ctx.turn.step(ctx.send, "Drawing it…");
  const layoutGraph = sketchLayout(ctx);
  const doc = layoutGraph(nodes, edges);

  const name = `${title}.sketch`;
  const artifact = Artifact.note(name, doc.toJson())
    .indexedAs(doc.extractedText())
    .by("#sketch")
    .duringRun(ctx.turn.runId)
    .fromFiles(ctx.refs)
    .cancelWith(ctx.cancel);
  const written = await commitSketchArtifact(room, artifact);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  emitSafely(ctx.emit, "agent-open-file", { id: written.meta.id });

  const boxes = nodes.length;
  const arrows = edges.length;
  const coverage = sketchCoverage(total);
  let content = `Drew **${written.meta.name}** — ${boxes} box(es) and ${arrows} connection(s)${coverage}.`;
  if (explanation.trim() !== "") {
    content += `\n\n${explanation.trim()}`;
  }
  content +=
    '\n\nAsk for changes in your own words — "add a box for the retry path", "mark the payment step red", ' +
    '"drop the last two" — and I will redraw it.';
  return commandResult(content, refNames);
}

// ============================================================================
// #to-sheet
// ============================================================================

export async function cmdToSheet(ctx: CmdCtx): Promise<CommandResult> {
  const rows = extractMdTable(ctx.history);
  if (rows === null) {
    throw new Error("No table found in a recent answer to convert.");
  }
  const csv = serializeDelim(rows, ",");
  const room = requireRoom(ctx.rooms);
  const artifact = Artifact.note("table.csv", csv).by("#to-sheet").duringRun(ctx.turn.runId);
  const written = room.workspace === undefined
    ? artifact.commit(room.db)
    : await artifact.commitToWorkspace(room.workspace);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  emitSafely(ctx.emit, "agent-open-file", { id: written.meta.id });
  return commandResult(
    `Saved the table as **${written.meta.name}** (${Math.max(rows.length - 1, 0)} row(s)).`,
    [written.meta.name]
  );
}
