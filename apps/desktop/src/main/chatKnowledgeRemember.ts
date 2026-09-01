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
import { CmdCtx, requireRoom } from "./chatKnowledgeContext.js";
import { capFanOut } from "./chatKnowledgeFiles.js";
// ============================================================================
// JSON-response helpers — own-property reads only (rule 2: never index a
// parsed, model-influenced JSON value with a bare `[key]`).
// ============================================================================

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** `v["text"].as_str().unwrap_or_default()` — the `/generate_doc` response
 * body, or `""` for a missing/non-string field. */
export function textFromGenerateDoc(v: unknown): string {
  if (!isRecord(v)) {
    return "";
  }
  const t = ownValue(v, "text");
  return typeof t === "string" ? t : "";
}

/** `v["items"].as_array().map(|a| a.iter().filter_map(as_str))
 * .unwrap_or_default()` — the `/knowledge_extract` mode:list response. */
export function itemsFromKnowledgeExtract(v: unknown): string[] {
  if (!isRecord(v)) {
    return [];
  }
  const arr = ownValue(v, "items");
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr.filter((x): x is string => typeof x === "string");
}

/** `v["values"].clone()` — the `/knowledge_extract` mode:fields response's
 * `values` object, or `null` when absent/malformed (which {@link valueStr}
 * already reads as "every field missing"). */
export function valuesFromKnowledgeExtract(v: unknown): unknown {
  if (!isRecord(v)) {
    return null;
  }
  const values = ownValue(v, "values");
  return values === undefined ? null : values;
}

// ============================================================================
// #remember
// ============================================================================

/** What a command produces: a chat message plus optional viewer effects.
 * Ported from `chat_commands.rs::CommandResult` — `effects` is never
 * `Option`, matching Rust's `#[derive(Default)]` struct field (always a real,
 * all-empty {@link ToolEffects} when a command sets nothing). */
export interface CommandResult {
  content: string;
  sources: string[];
  effects: ToolEffects;
}

/**
 * `#remember <fact>` — save a fact to the room's permanent memory. Ported
 * verbatim from `cmd_remember`.
 *
 * Calls the DB layer's {@link addMemory} directly, NOT `library.ts`'s UI/tool
 * wrapper — Rust's own `cmd_remember` calls `db::add_memory` directly too,
 * bypassing `commands::library::add_memory`'s length cap. Deliberate, per the
 * Rust source's own comment: "a fact worth remembering isn't worth silently
 * cutting at 500 characters. (Settings -> Memory still applies its own editor
 * limit.)" `duplicateMemory` (the UX-5 exact-duplicate check) still applies —
 * only the CAP is skipped.
 */
export async function cmdRemember(ctx: CmdCtx): Promise<CommandResult> {
  const fact = ctx.args.trim();
  if (fact === "") {
    throw new Error("Usage: #remember <fact>");
  }
  const room = requireRoom(ctx.rooms);
  if (duplicateMemory(room.db, fact) !== null) {
    return {
      content: "That's already in this room's memory.",
      sources: [],
      effects: createToolEffects(),
    };
  }
  addMemory(room.db, fact, null);
  return {
    content: `Saved to memory:\n\n> ${fact}`,
    sources: [],
    effects: createToolEffects(),
  };
}

// ============================================================================
// #find
// ============================================================================

/** `chat_commands/knowledge.rs::MAX_FIND_MATCHES` — see that file's own doc:
 * `#find` asks for EVERY match on purpose (it is a result list, not prompt
 * context), but an embedded room can answer a common word with hundreds of
 * chunks, each copied whole into one chat message. The rest is COUNTED, not
 * silently dropped. */
export const MAX_FIND_MATCHES = 50;

/** `find_body` — the match list `#find` prints, and what it says about the
 * matches it left out. Ported verbatim. Exported for direct testing — see
 * {@link capFanOut}'s own note on why. */
export function findBody(
  query: string,
  chunks: readonly ScoredChunk[],
): string {
  let body = `Matches for **${query}** (${chunks.length}):\n\n`;
  for (const c of chunks.slice(0, MAX_FIND_MATCHES)) {
    const snippet = makeSnippet(c.text, query, 140);
    body += `- **${c.fileName}** — ${snippet}\n`;
  }
  const rest = chunks.length - MAX_FIND_MATCHES;
  if (rest > 0) {
    body += `\n…and ${rest} more — narrow the search to see them.\n`;
  }
  body += "\n_Click a file below to open it._";
  return body;
}

/**
 * `#find <keywords>` — search the room's files for content and list every
 * match (not the six chunks a prompt call could afford). Ported verbatim from
 * `cmd_find`.
 */
export async function cmdFind(ctx: CmdCtx): Promise<CommandResult> {
  const query = ctx.args.trim();
  if (query === "") {
    throw new Error("Usage: #find <keywords>");
  }
  const emb = await embedQuestion(query);
  const room = requireRoom(ctx.rooms);
  const [chunks, fallback] = retrieveContextLimited(
    room.db,
    query,
    emb,
    new Set<number>(),
    null,
  );
  if (fallback || chunks.length === 0) {
    return {
      content: `No matches found for **${query}**.`,
      sources: [],
      effects: createToolEffects(),
    };
  }
  // The chips name the files whose matches are actually ON SCREEN: a chip for
  // a match the list didn't print is an invitation to look for something that
  // isn't there.
  const sources: string[] = [];
  for (const c of chunks.slice(0, MAX_FIND_MATCHES)) {
    if (!sources.includes(c.fileName)) {
      sources.push(c.fileName);
    }
  }
  return {
    content: findBody(query, chunks),
    sources,
    effects: createToolEffects(),
  };
}
