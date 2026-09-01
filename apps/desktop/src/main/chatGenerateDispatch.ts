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
import { CmdCtx, commandResult, emitSafely, requireRoom } from "./chatGenerateContext.js";
import { askStreaming } from "./chatGenerateDocuments.js";
// ============================================================================
// #research — D8, the Airlock
// ============================================================================

export type ResearchSource = readonly [name: string, text: string];

export interface ReadableResearchPage {
  title: string;
  text: string;
}

export function researchUnavailableResult(): CommandResult {
  return commandResult(
    "Web access is off in this room. Turn it on in **Settings → Online features**, then try #research again.",
    []
  );
}

export function emptyResearchResult(question: string, failed: readonly string[]): CommandResult {
  if (failed.length === 0) return commandResult(`No web results found for **${question}**.`, []);
  return commandResult(
    `The web search for **${question}** did not run — ${joinNames(failed)} could not be ` +
      "reached (blocked, rate limited or too slow). This does not mean there is nothing to find; " +
      "try again in a few minutes.",
    []
  );
}

export async function readableResearchPage(url: string): Promise<ReadableResearchPage | null> {
  try {
    const page = await fetchReadable(url);
    return page.text.trim() === "" ? null : { title: page.title, text: page.text };
  } catch {
    return null;
  }
}

export async function saveResearchPage(
  room: RoomHandle,
  name: string,
  title: string,
  url: string,
  text: string,
): Promise<string | null> {
  try {
    const saved = currentDate(room.db);
    const content = `# ${title}\n\nSource: ${url}\nSaved: ${saved}\n\n${text}`;
    const meta = await createRoomFile(room, name, "text/markdown", Buffer.from(content, "utf8"), content, "web");
    room.db.prepare("UPDATE files SET origin_url = ? WHERE id = ?").run(url, meta.id);
    return meta.name;
  } catch {
    return null;
  }
}

export function researchTitle(hit: WebHit, page: ReadableResearchPage): string {
  return page.title.trim() === "" ? hit.title : page.title;
}

export async function importResearchSources(
  ctx: CmdCtx,
  room: RoomHandle,
  hits: readonly WebHit[],
): Promise<ResearchSource[]> {
  const imported: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    if (ctx.cancel.load()) break;
    ctx.turn.step(ctx.send, `Saving source: ${hit.title} (leaves this Mac)`);
    const fetched = await readableResearchPage(hit.url);
    if (fetched === null) continue;
    const title = researchTitle(hit, fetched);
    const name = availableName(room.db, linkFileName(title, hit.url));
    const metaName = await saveResearchPage(room, name, title, hit.url, fetched.text);
    if (metaName === null) continue;
    imported.push([metaName, fetched.text]);
  }
  return imported;
}

export async function researchContext(ctx: CmdCtx, imported: readonly ResearchSource[]): Promise<string> {
  let context = "";
  for (const [name, text] of imported) {
    const digestText = await digest(ctx, text, `Reading ${name}`);
    context += `## Source: ${name}\n${digestText}\n\n`;
  }
  return digest(ctx, context, "Reading the saved sources");
}

export async function researchAnswer(ctx: CmdCtx, question: string, sources: string[], context: string): Promise<string> {
  ctx.turn.step(ctx.send, "Answering from the saved sources");
  try {
    return await askStreaming(
      ctx,
      "You answer the user's question using ONLY the provided sources, which were just saved into their " +
        "workspace. Cite the source file names inline where relevant. If the sources don't cover it, say " +
        "so plainly.",
      `Question: ${question}\n\nSources:\n${context}`
    );
  } catch {
    return `Saved ${sources.length} source(s) into the room:\n${sources.map((name) => `- ${name}`).join("\n")}`;
  }
}

export function completedResearchResult(answer: string, sourceNames: string[]): CommandResult {
  const content = answer.trim() === ""
    ? `Saved ${sourceNames.length} source(s) into the room:\n${sourceNames.map((name) => `- ${name}`).join("\n")}`
    : answer;
  return commandResult(content, sourceNames);
}

export async function cmdResearch(ctx: CmdCtx): Promise<CommandResult> {
  const question = ctx.args.trim();
  if (question === "") {
    throw new Error("Usage: #research <question>");
  }
  const room = requireRoom(ctx.rooms);
  if (!webAccessEnabled(room.db)) return researchUnavailableResult();
  ctx.turn.step(ctx.send, `Searching the web for "${question}" (leaves this Mac)`);
  const page = await searchWeb(question);
  if (page.hits.length === 0) {
    const note = blockedNote(page);
    return emptyResearchResult(question, note === null ? [] : page.failed);
  }
  const imported = await importResearchSources(ctx, room, page.hits);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  if (imported.length === 0) {
    return commandResult(
      `Found results for **${question}** but couldn't save any readable copies — the pages may be ` +
        "blocked or empty. Try a different question.",
      []
    );
  }
  const sourceNames = imported.map(([name]) => name);
  const answer = await researchAnswer(ctx, question, sourceNames, await researchContext(ctx, imported));
  return completedResearchResult(answer, sourceNames);
}
