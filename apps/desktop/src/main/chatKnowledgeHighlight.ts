/** Cohesive extraction from chatCommandsKnowledge.ts; its public API remains on that module. */
import { CancelFlag } from "./cancel.js";
import { Artifact, type Written } from "./artifactBuilder.js";
import {
  htmlNoteName,
  htmlTitledDoc,
  noteMime,
  refsContext,
  refsFiles,
  titleFromName,
} from "./docsHtml.js";
import { getFileFull } from "./db-host/files.js";
import { addMemory } from "./db-host/memories.js";
import {
  makeSnippet,
  retrieveContextLimited,
  type ScoredChunk,
} from "./db-host/retrieval.js";
import { resolvedBaseUrl, stripThinkSpans } from "./engineRouting.js";
import { extensionOf } from "./editMatchExtraction.js";
import { parseDelim, serializeDelim } from "./editMatchCells.js";
import { byteLength, partitionWindows, sliceUtf8 } from "./extractionWindow.js";
import { createToolEffects, type ToolEffects } from "./execTool.js";
import { buildAnnotation } from "./fileTools.js";
import { valueStr } from "./jsonTools.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import { duplicateMemory } from "./libraryTools.js";
import {
  generate as generateReal,
  type GenerateOpts,
} from "./ollamaGenerate.js";
import { embedQuestion } from "./retrievalBackfill.js";
import type { SidecarChatMessage } from "./sidecar.js";
import {
  sidecarErrorSentinel,
  sidecarJsonCancellable,
} from "./sidecarJsonCancellable.js";
import { TurnId, type EventSender } from "./turn.js";

export type { ScoredChunk };
import { CmdCtx, announceWindowStep, askQuiet, cmdWindows, emitSafely, noteUnread, requireRoom } from "./chatKnowledgeContext.js";
import { CommandResult } from "./chatKnowledgeRemember.js";
// ============================================================================
// #highlight
// ============================================================================

/** `chat_commands/knowledge.rs::QUOTE_SYS` — verbatim. */
export const QUOTE_SYS =
  "You locate an exact passage. Output ONLY the shortest verbatim quote from the " +
  "document that best matches the request — copied character-for-character, with no " +
  "quotation marks around it and no other words. If this part of the document does not " +
  "contain the requested thing, output nothing at all.";

/** Repeatedly strip a trailing literal suffix — Rust's
 * `str::trim_end_matches(pat)`, which removes the pattern from the end AS
 * MANY TIMES as it matches, not just once. */
export function stripTrailingRepeated(s: string, suffix: string): string {
  let out = s;
  while (out.endsWith(suffix)) {
    out = out.slice(0, out.length - suffix.length);
  }
  return out;
}

/** Repeatedly strip a leading/trailing literal CHARACTER from both ends —
 * Rust's `str::trim_matches(char)`. */
export function trimMatchesChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) {
    start += 1;
  }
  while (end > start && s[end - 1] === ch) {
    end -= 1;
  }
  return s.slice(start, end);
}

export type HighlightMatch = { payload: Record<string, unknown>; described: string };

export function highlightFileId(ctx: CmdCtx): string {
  const fileId = ctx.refs[0];
  if (fileId === undefined) {
    throw new Error("Add a file with @ — e.g. #highlight the total in @invoice.pdf");
  }
  return fileId;
}

export function highlightRequest(args: string): string {
  let request = args.trim();
  request = stripTrailingRepeated(request, " in");
  request = stripTrailingRepeated(request, " on");
  request = request.trim();
  if (request === "") {
    throw new Error("Say what to highlight — e.g. #highlight the signature in @contract.pdf");
  }
  return request;
}

export function highlightableText(room: RoomHandle, fileId: string): { name: string; text: string } {
  const [name, , , storedText] = getFileFull(room.db, fileId);
  const text = storedText ?? "";
  if (text.trim() === "") throw new Error(`"${name}" has no readable text to highlight.`);
  return { name, text };
}

export async function highlightWindow(
  ctx: CmdCtx,
  fileId: string,
  name: string,
  fullText: string,
  request: string,
  window: string,
): Promise<HighlightMatch | null> {
  let quote: string;
  try {
    quote = await askQuiet(ctx, QUOTE_SYS, `Request: ${request}\n\nDocument:\n${window}`, 0.0);
  } catch {
    noteUnread(ctx);
    return null;
  }
  const normalizedQuote = trimMatchesChar(quote.trim(), '"').trim();
  if (normalizedQuote === "") return null;
  const built = buildAnnotation(fileId, name, fullText, normalizedQuote, "", null, null, null);
  return built.ok ? { payload: built.payload, described: built.described } : null;
}

export async function findHighlight(
  ctx: CmdCtx,
  fileId: string,
  name: string,
  text: string,
  request: string,
): Promise<HighlightMatch | null> {
  const windows = cmdWindows(text);
  const total = windows.length;
  for (let index = 0; index < windows.length; index++) {
    if (ctx.cancel.load()) break;
    announceWindowStep(ctx, "Looking for it", index, total);
    const match = await highlightWindow(ctx, fileId, name, text, request, windows[index] as string);
    if (match !== null) return match;
  }
  return null;
}

/**
 * `#highlight <thing> in @file` — mark an exact passage in a file so it shows
 * in the viewer. Reads the WHOLE document, one window at a time, stopping at
 * the first window that yields a quote the file actually contains. Ported
 * verbatim from `cmd_highlight`.
 */
export async function cmdHighlight(ctx: CmdCtx): Promise<CommandResult> {
  const fileId = highlightFileId(ctx);
  const request = highlightRequest(ctx.args);
  const source = highlightableText(requireRoom(ctx.rooms), fileId);
  const found = await findHighlight(ctx, fileId, source.name, source.text, request);
  if (found === null) {
    throw new Error(`Couldn't find an exact passage for "${request}" in ${source.name}.`);
  }
  emitSafely(ctx.emit, "agent-annotate", found.payload);
  const effects = createToolEffects();
  effects.annotation = found.payload;
  return {
    content: `Highlighted ${found.described} in **${source.name}**.`,
    sources: [source.name],
    effects,
  };
}
