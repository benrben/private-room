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
import { ALNUM_CHAR, CmdCtx, GraphEdge, GraphNode, commandResult, isRecord, ownValue, requireRoom, splitWhitespaceUnicode } from "./chatGenerateContext.js";
import { askStreaming, askStructured, minutesPart } from "./chatGenerateDocuments.js";
import { StructuredWindowRequest } from "./chatGenerateSketch.js";
// ============================================================================
// #sketch — schema, merge, safe title (real + tested); layout is the seam
// ============================================================================

export const SKETCH_SYS =
  "You turn a document into a DIAGRAM. Identify the handful of things it describes and " +
  "how they connect. Return nodes — each with a short id, a LABEL of at most four words, " +
  "and a `note` of one short sentence explaining it — and edges between those ids, each " +
  "with a two or three word label saying what the connection IS. Mark an obvious " +
  'beginning or ending with kind "start" or "end". Aim for 4 to 9 nodes: a diagram is ' +
  "a picture of the shape of something, not a copy of it. Use ONLY what the source says. " +
  "Also give a `title` for the diagram and a short `explanation` of what it shows.";

export function sketchSource(ctx: CmdCtx, refctx: string): string {
  if (refctx.trim() !== "") return refctx;
  if (ctx.history.trim() !== "") return `Conversation:\n${ctx.history}`;
  if (ctx.args.trim() !== "") return `Topic: ${ctx.args}`;
  throw new Error("Give me something to draw — e.g. #sketch @plan.md, or #sketch how our login flow works.");
}

export function sketchWindowRequest(): StructuredWindowRequest {
  return {
    system: SKETCH_SYS,
    temperature: 0.2,
    schema: sketchSchema(),
    stepText: (part, total) =>
      total > 1 ? `Working out what to draw — part ${part}/${total}…` : "Working out what to draw…",
    userText: (window, part, total) =>
      total > 1
        ? `This is part ${part} of ${total} of ONE source, in order. Describe the diagram for THIS part; ` +
          `the other parts are handled separately and merged.\n\nSource:\n${window}`
        : `Source:\n${window}`,
  };
}

/** What the model is asked for: meaning, never geometry. Ported verbatim
 * from `sketch_schema`. */
export function sketchSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      explanation: { type: "string" },
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            note: { type: "string" },
            kind: { type: "string", enum: ["start", "step", "end"] },
          },
          required: ["id", "label"],
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            label: { type: "string" },
          },
          required: ["from", "to"],
        },
      },
    },
    required: ["title", "nodes"],
  };
}

/** A title a file can be called. Ported verbatim from `safe_file_stem`. */
export function safeFileStem(title: string): string {
  const cleaned = Array.from(title)
    .map((c) => (ALNUM_CHAR.test(c) || " -_&+()".includes(c) ? c : " "))
    .join("");
  const squashed = splitWhitespaceUnicode(cleaned).join(" ");
  const out = squashed.trim().replace(/^-+|-+$/g, "").trim();
  if (out === "") {
    return "Sketch";
  }
  return Array.from(out).slice(0, 60).join("");
}

/** Fold the per-window descriptions into one diagram. Ported verbatim from
 * `merge_sketch`. */
export function sketchPartText(part: Record<string, unknown>, key: string): string {
  return typeof part[key] === "string" ? (part[key] as string).trim() : "";
}

export function sketchPartRecords(part: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = part[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function mergedSketchTitle(current: string, part: Record<string, unknown>): string {
  return current === "" ? sketchPartText(part, "title") : current;
}

export function appendSketchExplanation(current: string, part: Record<string, unknown>): string {
  const next = sketchPartText(part, "explanation");
  if (next === "") return current;
  return current === "" ? next : `${current} ${next}`;
}

export function sketchNode(value: Record<string, unknown>): GraphNode | null {
  const id = sketchPartText(value, "id");
  if (id === "") return null;
  const rawLabel = typeof value.label === "string" ? value.label : id;
  const label = rawLabel.trim();
  if (label === "") return null;
  const node: GraphNode = { id, label };
  const note = sketchPartText(value, "note");
  if (note !== "") node.note = note;
  if (typeof value.kind === "string") node.kind = value.kind;
  return node;
}

export function appendSketchNodes(
  values: readonly Record<string, unknown>[],
  seen: Set<string>,
  output: GraphNode[],
): void {
  for (const value of values) {
    const node = sketchNode(value);
    if (node === null || seen.has(node.id)) continue;
    seen.add(node.id);
    output.push(node);
  }
}

export function sketchEndpoint(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? (value[key] as string) : null;
}

export function sketchEdge(value: Record<string, unknown>): GraphEdge | null {
  const from = sketchEndpoint(value, "from");
  const to = sketchEndpoint(value, "to");
  if (from === null || to === null) return null;
  const edge: GraphEdge = { from, to };
  const label = sketchPartText(value, "label");
  if (label !== "") edge.label = label;
  return edge;
}

export function appendSketchEdges(
  values: readonly Record<string, unknown>[],
  seen: Set<string>,
  output: GraphEdge[],
): void {
  for (const value of values) {
    const edge = sketchEdge(value);
    if (edge === null) continue;
    const key = JSON.stringify([edge.from, edge.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(edge);
  }
}

export function mergeSketch(
  parts: readonly unknown[]
): { title: string; explanation: string; nodes: GraphNode[]; edges: GraphEdge[] } {
  let title = "";
  let explanation = "";
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const have = new Set<string>();
  const wired = new Set<string>();

  for (const raw of parts) {
    const part = minutesPart(raw);
    title = mergedSketchTitle(title, part);
    explanation = appendSketchExplanation(explanation, part);
    appendSketchNodes(sketchPartRecords(part, "nodes"), have, nodes);
    appendSketchEdges(sketchPartRecords(part, "edges"), wired, edges);
  }
  const finalTitle = title === "" ? "Sketch" : safeFileStem(title);
  return { title: finalTitle, explanation, nodes, edges };
}

// ============================================================================
// #summarize
// ============================================================================

export async function summarizeRoom(ctx: CmdCtx, db: RoomHandle["db"]): Promise<CommandResult> {
  const inventory = listFileInventory(db);
  if (inventory.length === 0) {
    throw new Error("This room has no files to summarize yet.");
  }
  let listing = "";
  for (const [name, mime, summary] of inventory) {
    if (summary !== null && summary.trim() !== "") {
      listing += `- ${name} — ${summary.trim()}\n`;
    } else {
      listing += `- ${name} (${mime})\n`;
    }
  }
  const digested = await digest(ctx, listing, "Reading the file list");
  const out = await askStreaming(
    ctx,
    "You describe what a personal document room is for, based only on the file list given.",
    `Given these files, describe in 3-4 sentences what this room is about, then suggest 3 things the user could ask.\n\nFiles:\n${digested}`
  );
  return commandResult(
    `${out}\n\n_Tip: the “Summarize room” button saves this as a file with per-file notes._`,
    []
  );
}

export async function summarizeFile(ctx: CmdCtx, db: RoomHandle["db"], fileId: string): Promise<CommandResult> {
  const [name, , , textRaw] = getFileFull(db, fileId);
  const text = textRaw ?? "";
  if (text.trim() === "") {
    throw new Error(`"${name}" has no readable text to summarize.`);
  }
  const doc = await digest(ctx, text, `Reading ${name}`);
  if (doc.trim() === "") {
    throw new Error(`Couldn't read "${name}" — the model returned nothing.`);
  }
  const out = await askStreaming(
    ctx,
    "You summarize a document faithfully and concisely.",
    `Summarize this document in 3-4 sentences, then list up to 3 key points as bullets.\n\n${doc}`
  );
  return commandResult(out, [name]);
}

export async function cmdSummarize(ctx: CmdCtx): Promise<CommandResult> {
  const db = requireRoom(ctx.rooms).db;
  const fileId = ctx.refs[0];
  return fileId === undefined ? summarizeRoom(ctx, db) : summarizeFile(ctx, db, fileId);
}

// ============================================================================
// #compare
// ============================================================================

export interface ComparisonEvidence {
  file: string;
  quote: string;
}

export interface ComparisonClaim {
  claim: string;
  evidence: ComparisonEvidence[];
}

export function comparisonSchema(): Record<string, unknown> {
  const evidence = {
    type: "object",
    additionalProperties: false,
    required: ["file", "quote"],
    properties: { file: { type: "string" }, quote: { type: "string" } },
  };
  const claim = {
    type: "object",
    additionalProperties: false,
    required: ["claim", "evidence"],
    properties: { claim: { type: "string" }, evidence: { type: "array", items: evidence } },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["overview", "similarities", "differences"],
    properties: {
      // The overview is a claim too. Keeping it in the same evidence shape as
      // every bullet prevents a fluent, unsupported summary sentence from
      // bypassing the per-file quote verifier below.
      overview: claim,
      similarities: { type: "array", items: claim },
      differences: { type: "array", items: claim },
    },
  };
}

export function comparisonText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function normalizedEvidenceText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

export function verifiedComparisonEvidence(
  value: unknown,
  sourceByName: ReadonlyMap<string, string>,
): ComparisonEvidence | null {
  if (!isRecord(value)) return null;
  const file = comparisonText(ownValue(value, "file"));
  const quote = comparisonText(ownValue(value, "quote"));
  const source = sourceByName.get(file);
  if (source === undefined || Array.from(quote).length < 4) return null;
  return normalizedEvidenceText(source).includes(normalizedEvidenceText(quote)) ? { file, quote } : null;
}

export function verifiedEvidence(
  values: readonly unknown[],
  sourceByName: ReadonlyMap<string, string>,
): ComparisonEvidence[] {
  const evidence: ComparisonEvidence[] = [];
  for (const value of values) {
    const item = verifiedComparisonEvidence(value, sourceByName);
    if (item !== null) evidence.push(item);
  }
  return evidence;
}

export function comparisonClaimFields(value: unknown): { claim: string; evidence: readonly unknown[] } | null {
  if (!isRecord(value)) return null;
  const claim = comparisonText(ownValue(value, "claim"));
  const evidence = ownValue(value, "evidence");
  return claim === "" || !Array.isArray(evidence) ? null : { claim, evidence };
}

export function supportsComparisonClaim(evidence: readonly ComparisonEvidence[], needTwoFiles: boolean): boolean {
  if (evidence.length === 0) return false;
  return !needTwoFiles || new Set(evidence.map((item) => item.file)).size >= 2;
}

export function verifiedComparisonClaim(
  value: unknown,
  sourceByName: ReadonlyMap<string, string>,
  needTwoFiles: boolean,
): ComparisonClaim | null {
  const fields = comparisonClaimFields(value);
  if (fields === null) return null;
  const evidence = verifiedEvidence(fields.evidence, sourceByName);
  return supportsComparisonClaim(evidence, needTwoFiles) ? { claim: fields.claim, evidence } : null;
}

/** Accept only claims carrying a quote that exists in the named source.
 * This is deliberately mechanical: a fluent comparison with no supporting
 * span is rejected instead of being shown as a fact. */
export function verifiedComparisonClaims(
  value: unknown,
  sourceByName: ReadonlyMap<string, string>,
  needTwoFiles: boolean
): ComparisonClaim[] {
  if (!Array.isArray(value)) return [];
  const out: ComparisonClaim[] = [];
  for (const raw of value) {
    const claim = verifiedComparisonClaim(raw, sourceByName, needTwoFiles);
    if (claim !== null) out.push(claim);
  }
  return out;
}

export function renderComparisonSection(title: string, claims: readonly ComparisonClaim[]): string {
  if (claims.length === 0) {
    const verb = title === "Overview" ? "was" : "were";
    return `### ${title}\n\n- No supported ${title.toLowerCase()} ${verb} found.`;
  }
  return `### ${title}\n\n${claims.map((item) => {
    const refs = item.evidence.map((e) => `**${e.file}**: “${e.quote}”`).join("; ");
    return `- ${item.claim} (${refs})`;
  }).join("\n")}`;
}

export async function comparisonDigests(
  ctx: CmdCtx,
  files: ReadonlyArray<readonly [string, string]>,
): Promise<string[]> {
  const digests: string[] = [];
  for (const [name, text] of files) {
    if (text.trim() === "") {
      continue;
    }
    const d = await digest(ctx, text, `Reading ${name}`);
    if (d.trim() !== "") {
      digests.push(`[file: ${name}]\n${d}`);
    }
  }
  return digests;
}

export function parsedComparison(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (isRecord(parsed)) return parsed;
  } catch {
    // The single user-facing error below covers malformed and non-object replies.
  }
  throw new Error("The comparison was not grounded in readable source evidence. Try again.");
}

export function comparisonResult(
  parsed: Record<string, unknown>,
  sourceByName: ReadonlyMap<string, string>,
): CommandResult {
  const overview = verifiedComparisonClaims([ownValue(parsed, "overview")], sourceByName, true);
  const similarities = verifiedComparisonClaims(ownValue(parsed, "similarities"), sourceByName, true);
  const differences = verifiedComparisonClaims(ownValue(parsed, "differences"), sourceByName, false);
  if (overview.length === 0 && similarities.length === 0 && differences.length === 0) {
    throw new Error("The comparison contained no claims supported by quotes from the named files.");
  }
  const verified = [...overview, ...similarities, ...differences];
  const usedNames = [...new Set(verified.flatMap((claim) => claim.evidence.map((evidence) => evidence.file)))];
  const out = [
    renderComparisonSection("Overview", overview),
    renderComparisonSection("Similarities", similarities),
    renderComparisonSection("Differences", differences),
  ]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  return commandResult(out, usedNames);
}

export async function cmdCompare(ctx: CmdCtx): Promise<CommandResult> {
  if (ctx.refs.length < 2) {
    throw new Error("Add at least two files with @ — e.g. #compare @plan-a.md @plan-b.md");
  }
  const files = refsFiles(requireRoom(ctx.rooms).db, ctx.refs);
  const sourceByName = new Map(files.map(([name, text]) => [name, text] as const));
  const digests = await comparisonDigests(ctx, files);
  if (digests.length < 2) {
    throw new Error("Those files have no readable text to compare.");
  }
  const raw = await askStructured(
    ctx,
    "Compare documents using only grounded evidence. Every claim must include the exact source file name and " +
      "a short verbatim quote from that same file. The overview and every similarity need evidence from at least " +
      "two different files. " +
      "Never transfer a fact from one file to another.",
    `Compare these separately labelled documents.\n\n${digests.join("\n\n")}`,
    0.1,
    comparisonSchema()
  );
  return comparisonResult(parsedComparison(raw), sourceByName);
}
