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
import { CmdCtx, KEEP_ALIVE_WARM, cmdWindows, noteUnread, requireRoom, saveAndOpen, step } from "./chatKnowledgeContext.js";
import { capFanOut } from "./chatKnowledgeFiles.js";
import { CommandResult, valuesFromKnowledgeExtract } from "./chatKnowledgeRemember.js";
// ============================================================================
// #extract
// ============================================================================

/**
 * Deterministic column extraction for a CSV/TSV file: if EVERY requested
 * field names a column header (case-insensitively), return one output row per
 * data row holding just those columns — no model call at all. `null` for a
 * non-tabular file, or when any requested field doesn't match a header, so
 * the caller falls back to the model-based scalar path. Ported verbatim from
 * `tabular_field_rows`. Exported for direct testing — see {@link capFanOut}'s
 * own note on why.
 */
export function tabularFieldRows(
  name: string,
  text: string,
  fields: readonly string[],
): string[][] | null {
  const delim = tabularDelimiter(name);
  if (delim === null) {
    return null;
  }
  const table = parseDelim(text, delim);
  const header = table[0];
  if (header === undefined) return null;
  const columns = matchingColumns(header, fields);
  return columns === null ? null : selectedTableRows(table.slice(1), columns);
}

export function tabularDelimiter(name: string): string | null {
  const extension = extensionOf(name);
  if (extension === "csv") return ",";
  if (extension === "tsv") return "\t";
  return null;
}

export function matchingColumns(header: string[], fields: readonly string[]): number[] | null {
  const cols: number[] = [];
  for (const field of fields) {
    const index = header.findIndex((cell) => normalizedCell(cell) === normalizedCell(field));
    if (index === -1) return null;
    cols.push(index);
  }
  return cols;
}

export function normalizedCell(value: string): string {
  return value.trim().toLowerCase();
}

export function selectedTableRows(table: string[][], columns: number[]): string[][] {
  const rows: string[][] = [];
  for (const row of table) {
    if (!row.some((cell) => cell.trim() !== "")) continue;
    rows.push(columns.map((column) => row[column] ?? ""));
  }
  return rows;
}

/**
 * Strip the trailing "from"/"in"/"of" the UI leaves behind after removing the
 * @tokens — but only as a WHOLE WORD (a field merely ENDING in those letters,
 * "gross margin", "country of origin", "burden of proof", keeps them). Ported
 * verbatim from `strip_trailing_preposition`. Exported for direct testing —
 * see {@link capFanOut}'s own note on why.
 */
export function stripTrailingPreposition(args: string): string {
  const s = args.replace(/\s+$/, "");
  for (const word of ["from", "in", "of"]) {
    if (s.endsWith(word)) {
      const rest = s.slice(0, s.length - word.length);
      if (rest === "" || /\s$/.test(rest)) {
        return rest.replace(/\s+$/, "");
      }
    }
  }
  return s;
}

/** Parse the field-list portion of `#extract … from @file`.
 *
 * The composer normally removes @-reference tokens before dispatch, but a
 * multi-folder reference can leave its display filename behind. Only treat a
 * standalone `from` as the source-clause delimiter when the remaining text
 * actually looks like a reference (an @ token, path, or filename extension).
 * This keeps ordinary fields such as “revenue from subscriptions” intact. */
export function extractFieldNames(args: string): string[] {
  const withoutTrailing = stripTrailingPreposition(args.trim());
  const fromClauses = [...withoutTrailing.matchAll(/\s+from\s+/giu)];
  const sourceClause = fromClauses.find((match) => {
    const residue = withoutTrailing
      .slice((match.index ?? 0) + match[0].length)
      .trim();
    return (
      /(?:^|\s)@\S+/u.test(residue) ||
      /[/\\]/u.test(residue) ||
      /\.[a-z0-9]{1,12}["']?(?:\s|$)/iu.test(residue)
    );
  });
  const fieldList =
    sourceClause === undefined
      ? withoutTrailing
      : withoutTrailing.slice(0, sourceClause.index).trimEnd();
  return fieldList
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field !== "");
}

export function extractReferences(ctx: CmdCtx): readonly string[] {
  if (ctx.refs.length === 0) {
    throw new Error("Add files with @ — e.g. #extract revenue, CEO from @a.pdf @b.pdf");
  }
  return ctx.refs;
}

export function requiredExtractFields(args: string): string[] {
  const fields = extractFieldNames(args);
  if (fields.length === 0) {
    throw new Error("Say which fields to extract — e.g. #extract revenue, CEO from @a @b");
  }
  return fields;
}

export function fieldExtractionRequest(ctx: CmdCtx, fields: string[], document: string): Record<string, unknown> {
  return {
    model: ctx.model,
    base_url: resolvedBaseUrl(),
    mode: "fields",
    fields,
    document,
    temperature: 0.0,
    keep_alive: KEEP_ALIVE_WARM,
  };
}

export function saveFoundFieldValues(
  fields: readonly string[],
  values: unknown,
  found: Map<string, string>,
): void {
  for (const field of fields) {
    const value = valueStr(values, field).trim();
    if (value !== "" && value.toLowerCase() !== "(not found)") {
      found.set(field, value);
    }
  }
}

export async function readExtractionWindow(
  ctx: CmdCtx,
  missing: string[],
  document: string,
  found: Map<string, string>,
): Promise<void> {
  const outcome = await sidecarJsonCancellable(
    "/knowledge_extract",
    fieldExtractionRequest(ctx, missing, document),
    new CancelFlag(),
  );
  if (outcome.kind !== "value") {
    noteUnread(ctx);
    return;
  }
  saveFoundFieldValues(missing, valuesFromKnowledgeExtract(outcome.value), found);
}

export function extractWindowStep(
  ctx: CmdCtx,
  name: string,
  windowIndex: number,
  windowTotal: number,
  fileIndex: number,
  fileTotal: number,
): void {
  if (windowTotal > 1) {
    step(ctx, `Reading ${name} — part ${windowIndex + 1}/${windowTotal} (${fileIndex + 1}/${fileTotal})`);
  }
}

export async function extractedScalarRow(
  ctx: CmdCtx,
  name: string,
  text: string,
  fields: string[],
  fileIndex: number,
  fileTotal: number,
): Promise<string[]> {
  const found = new Map<string, string>();
  const windows = cmdWindows(text);
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
    if (ctx.cancel.load() || found.size === fields.length) break;
    extractWindowStep(ctx, name, windowIndex, windows.length, fileIndex, fileTotal);
    const missing = fields.filter((field) => !found.has(field));
    await readExtractionWindow(ctx, missing, windows[windowIndex] as string, found);
  }
  return [name, ...fields.map((field) => found.get(field) ?? "(not found)")];
}

export async function extractedFileRows(
  ctx: CmdCtx,
  name: string,
  text: string,
  fields: string[],
  fileIndex: number,
  fileTotal: number,
): Promise<string[][]> {
  const rows = tabularFieldRows(name, text, fields);
  if (rows !== null) return rows.map((row) => [name, ...row]);
  return [await extractedScalarRow(ctx, name, text, fields, fileIndex, fileTotal)];
}

export async function extractionRows(
  ctx: CmdCtx,
  files: Array<[string, string]>,
  fields: string[],
): Promise<string[][]> {
  const rows: string[][] = [["File", ...fields]];
  for (let index = 0; index < files.length; index++) {
    if (ctx.cancel.load()) break;
    const [name, text] = files[index] as [string, string];
    step(ctx, `Reading ${name} (${index + 1}/${files.length})`);
    rows.push(...await extractedFileRows(ctx, name, text, fields, index, files.length));
  }
  return rows;
}

export async function saveExtractedRows(
  ctx: CmdCtx,
  rows: string[][],
): Promise<Written> {
  return saveAndOpen(
    ctx.rooms,
    ctx.emit,
    Artifact.new("extract.csv", noteMime("extract.csv"), serializeDelim(rows, ","))
      .by("#extract")
      .duringRun(ctx.turn.runId)
      .fromFiles(ctx.refs)
      .cancelWith(ctx.cancel),
  );
}

/**
 * `#extract <field, field…> from @a @b` — pull the same fields out of several
 * files into a spreadsheet. Reads each file whole, window by window, keeping
 * the first real value found for each field and stopping once every field is
 * answered. Ported verbatim from `cmd_extract`.
 */
export async function cmdExtract(ctx: CmdCtx): Promise<CommandResult> {
  const references = extractReferences(ctx);
  const fields = requiredExtractFields(ctx.args);
  const room = requireRoom(ctx.rooms);
  const files = refsFiles(room.db, references);
  const written = await saveExtractedRows(ctx, await extractionRows(ctx, files, fields));
  const meta = written.meta;
  return {
    content: `Extracted ${fields.length} field(s) from ${files.length} file(s) into **${meta.name}**.`,
    sources: [meta.name],
    effects: createToolEffects(),
  };
}
