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
import { CmdCtx, KEEP_ALIVE_WARM, commitArtifact, digest, emitSafely, requireRoom, saveAndOpen, step } from "./chatKnowledgeContext.js";
import { CommandResult, itemsFromKnowledgeExtract, textFromGenerateDoc } from "./chatKnowledgeRemember.js";
// ============================================================================
// #add-file
// ============================================================================

/** `chat_commands/knowledge.rs::MAX_FAN_OUT_FILES` — see that file's own doc:
 * `#add-file for each …` has no preview and no undo, so an unbounded list (a
 * pasted table, a CSV) filled the room. */
export const MAX_FAN_OUT_FILES = 25;

/** `cap_fan_out` — the fan-out list, cut to {@link MAX_FAN_OUT_FILES}, plus
 * HOW MANY were left out. Ported verbatim. Exported (unlike Rust's private
 * `cap_fan_out`) purely so this module's own test suite can exercise the cut
 * directly, the same access Rust's `#[cfg(test)] mod tests { use super::*; }`
 * gets for free — see `filePass.ts`'s `loadArtifact`/`storeArtifact` for the
 * identical, already-established convention. */
export function capFanOut(items: readonly string[]): [string[], number] {
  const over = Math.max(0, items.length - MAX_FAN_OUT_FILES);
  return [items.slice(0, MAX_FAN_OUT_FILES), over];
}

export interface AddFileIdea {
  nameHint: string | null;
  topic: string;
}

export interface FanOutItems {
  history: string;
  items: string[];
}

export type FanOutSaveResult =
  | { kind: "created"; name: string }
  | { kind: "skipped" }
  | { kind: "room-closed" };

export function addFileArgs(args: string): string {
  const trimmed = args.trim();
  if (trimmed === "") {
    throw new Error(
      "Usage: #add-file <name>: <topic>   (or)   #add-file for each <thing>",
    );
  }
  return trimmed;
}

export function fanOutSubject(args: string): string | null {
  const position = args.toLowerCase().indexOf("for each");
  if (position === -1) return null;
  return args
    .slice(position + "for each".length)
    .trim()
    .replace(/^:+/, "")
    .trim();
}

export function fanOutListRequest(
  ctx: CmdCtx,
  subject: string,
  history: string,
): Record<string, unknown> {
  return {
    model: ctx.model,
    base_url: resolvedBaseUrl(),
    mode: "list",
    subject,
    conversation: history,
    temperature: 0.0,
    keep_alive: KEEP_ALIVE_WARM,
  };
}

export async function listedFanOutItems(
  ctx: CmdCtx,
  subject: string,
): Promise<FanOutItems> {
  const history = await digest(ctx, ctx.history, "Reading the conversation");
  const outcome = await sidecarJsonCancellable(
    "/knowledge_extract",
    fanOutListRequest(ctx, subject, history),
    new CancelFlag(),
  );
  if (outcome.kind === "error")
    throw new Error(sidecarErrorSentinel(outcome.error, ctx.model));
  const items =
    outcome.kind === "value" ? itemsFromKnowledgeExtract(outcome.value) : [];
  if (items.length === 0) {
    throw new Error(
      "Couldn't find a list to iterate over in this chat. Name the items explicitly, " +
        "e.g. #add-file for each: AAPL, MSFT, NVDA.",
    );
  }
  return { history, items };
}

export function fanOutDocumentRequest(
  ctx: CmdCtx,
  item: string,
  history: string,
): Record<string, unknown> {
  return {
    model: ctx.model,
    base_url: resolvedBaseUrl(),
    mode: "each",
    item,
    history,
    temperature: 0.4,
    keep_alive: KEEP_ALIVE_WARM,
  };
}

export async function generatedFanOutBody(
  ctx: CmdCtx,
  item: string,
  history: string,
): Promise<string> {
  const outcome = await sidecarJsonCancellable(
    "/generate_doc",
    fanOutDocumentRequest(ctx, item, history),
    ctx.cancel,
  );
  return outcome.kind === "value" ? textFromGenerateDoc(outcome.value) : "";
}

export async function saveFanOutItem(
  ctx: CmdCtx,
  item: string,
  body: string,
): Promise<FanOutSaveResult> {
  if (body.trim() === "") return { kind: "skipped" };
  const room = ctx.rooms.current();
  if (room === null) return { kind: "room-closed" };
  const name = htmlNoteName(item);
  const doc = htmlTitledDoc(name, item, body);
  try {
    const artifact = Artifact.note(name, doc)
      .by("#add-file")
      .duringRun(ctx.turn.runId)
      .cancelWith(ctx.cancel);
    const written = await commitArtifact(room, artifact);
    return { kind: "created", name: written.meta.name };
  } catch {
    return { kind: "skipped" };
  }
}

export async function createFanOutItem(
  ctx: CmdCtx,
  item: string,
  history: string,
  index: number,
  total: number,
): Promise<FanOutSaveResult> {
  step(ctx, `Creating file for ${item} (${index + 1}/${total})`);
  return saveFanOutItem(
    ctx,
    item,
    await generatedFanOutBody(ctx, item, history),
  );
}

export async function createFanOutFiles(
  ctx: CmdCtx,
  items: readonly string[],
  history: string,
): Promise<string[]> {
  const created: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (ctx.cancel.load()) break;
    const result = await createFanOutItem(
      ctx,
      items[index]!,
      history,
      index,
      items.length,
    );
    if (result.kind === "room-closed") break;
    if (result.kind === "created") created.push(result.name);
  }
  return created;
}

export function fanOutResult(created: string[], over: number): CommandResult {
  if (created.length === 0)
    throw new Error("Couldn't create any files — the model returned nothing.");
  const list = created.map((name) => `- ${name}`).join("\n");
  const cappedNote =
    over > 0
      ? `\n\nStopped at ${MAX_FAN_OUT_FILES} files — ${over} more were named. ` +
        "Ask again naming the ones you still want."
      : "";
  return {
    content:
      `Created ${created.length} file(s):\n${list}${cappedNote}\n\n` +
      "_Delete any you don't want from the Files list._",
    sources: created,
    effects: createToolEffects(),
  };
}

export async function cmdAddFilesForEach(
  ctx: CmdCtx,
  subject: string,
): Promise<CommandResult> {
  const { history, items } = await listedFanOutItems(ctx, subject);
  const [capped, over] = capFanOut(items);
  const created = await createFanOutFiles(ctx, capped, history);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  return fanOutResult(created, over);
}

export function addFileIdea(args: string): AddFileIdea {
  const colon = args.indexOf(":");
  if (colon === -1) return { nameHint: null, topic: args };
  const name = args.slice(0, colon);
  const topic = args.slice(colon + 1);
  const words = name.split(/\s+/u).filter((word) => word !== "");
  return topic.trim() !== "" && words.length <= 8
    ? { nameHint: name.trim(), topic: topic.trim() }
    : { nameHint: null, topic: args };
}

export function singleDocumentRequest(
  ctx: CmdCtx,
  topic: string,
  context: string,
): Record<string, unknown> {
  return {
    model: ctx.model,
    base_url: resolvedBaseUrl(),
    mode: "single",
    topic,
    context,
    temperature: 0.4,
    keep_alive: KEEP_ALIVE_WARM,
  };
}

export async function generatedSingleBody(
  ctx: CmdCtx,
  topic: string,
  context: string,
): Promise<string> {
  const outcome = await sidecarJsonCancellable(
    "/generate_doc",
    singleDocumentRequest(ctx, topic, context),
    ctx.cancel,
  );
  if (outcome.kind === "value") return textFromGenerateDoc(outcome.value);
  if (outcome.kind === "stopped") return "";
  throw new Error(sidecarErrorSentinel(outcome.error, ctx.model));
}

export function singleDocumentName(idea: AddFileIdea): string {
  if (idea.nameHint === null) return htmlNoteName(idea.topic);
  return extensionOf(idea.nameHint) !== ""
    ? idea.nameHint
    : `${idea.nameHint}.html`;
}

export async function saveSingleFile(
  ctx: CmdCtx,
  name: string,
  body: string,
): Promise<CommandResult> {
  const doc = htmlTitledDoc(name, titleFromName(name), body);
  const written = await saveAndOpen(
    ctx.rooms,
    ctx.emit,
    Artifact.new(name, noteMime(name), doc)
      .by("#add-file")
      .duringRun(ctx.turn.runId)
      .fromFiles(ctx.refs)
      .cancelWith(ctx.cancel),
  );
  const meta = written.meta;
  return {
    content: written.versioned
      ? `Rewrote **${meta.name}** and opened it — the previous version is in History.`
      : `Created **${meta.name}** and opened it.`,
    sources: [meta.name],
    effects: createToolEffects(),
  };
}

export async function cmdAddSingleFile(
  ctx: CmdCtx,
  args: string,
): Promise<CommandResult> {
  const idea = addFileIdea(args);
  const room = requireRoom(ctx.rooms);
  const [rawContext] = refsContext(room.db, ctx.refs);
  const context = await digest(ctx, rawContext, "Reading the pinned files");
  const body = await generatedSingleBody(ctx, idea.topic, context);
  if (body.trim() === "")
    throw new Error("The model returned nothing — try rephrasing the topic.");
  return saveSingleFile(ctx, singleDocumentName(idea), body);
}

/**
 * `#add-file <name>: <topic>` or `#add-file for each <thing>` — write a new
 * note/document, or one per item enumerated from the conversation. Ported
 * verbatim from `cmd_add_file`.
 */
export async function cmdAddFile(ctx: CmdCtx): Promise<CommandResult> {
  const args = addFileArgs(ctx.args);
  const subject = fanOutSubject(args);
  return subject === null
    ? cmdAddSingleFile(ctx, args)
    : cmdAddFilesForEach(ctx, subject);
}
