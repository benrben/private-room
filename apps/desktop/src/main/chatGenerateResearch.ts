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
import { CmdCtx, commandResult, emitSafely, errorMessage, requireRoom } from "./chatGenerateContext.js";
// ============================================================================
// #translate
// ============================================================================

/** How many chunks in a row may fail before a chunked pass stops trying.
 * Ported verbatim from `CHUNK_GIVE_UP_AFTER`. */
export const CHUNK_GIVE_UP_AFTER = 3;

/** Best-effort bookkeeping for a chunked pass. Ported verbatim from
 * `ChunkFailures`. */
export class ChunkFailures {
  private first: string | null = null;
  private run = 0;

  /** Record a failed chunk. `true` means the run is long enough that the
   * engine, not the slice, is the problem. */
  note(err: string): boolean {
    if (this.first === null) {
      this.first = err;
    }
    this.run += 1;
    return this.run >= CHUNK_GIVE_UP_AFTER;
  }

  /** A chunk came back fine, so the failures so far were local ones. */
  ok(): void {
    this.run = 0;
  }

  /** What to say when the pass produced nothing at all. */
  nothingSaved(): string {
    return this.first ?? "The model returned nothing to save.";
  }
}

export type TranslationLocale = "he" | "other";

/** Resolve the locale names Arcelle documents for its deterministic quality
 * floor.  Keep this deliberately small: unknown languages still get the
 * preservation checks below, while Hebrew gets additional script/terminology
 * guidance for the installed-app failure that prompted ARC-012. */
export function translationLocale(language: string): TranslationLocale {
  const normalized = language.normalize("NFKC").trim().toLocaleLowerCase();
  return ["he", "he-il", "hebrew", "עברית"].includes(normalized) ? "he" : "other";
}

export function translationSystemPrompt(language: string): string {
  const common =
    `You translate text into ${language}. Output ONLY the translation, preserving Markdown structure. ` +
    "Preserve every URL, number, identifier, inline-code span, and fenced code block exactly. " +
    "Use consistent terminology and do not add commentary.";
  if (translationLocale(language) !== "he") return common;
  return common +
    " Write idiomatic modern Hebrew, not a word-for-word calque. Keep terminology consistent, " +
    "preserve proper names unless they have a standard Hebrew form, and check gender, number, " +
    "construct-state grammar, and right-to-left punctuation before answering.";
}

export function allMatches(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), (match) => match[0]);
}

export function multisetCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function takeMultisetValue(counts: Map<string, number>, value: string): boolean {
  const count = counts.get(value);
  if (count === undefined || count === 0) return false;
  if (count === 1) counts.delete(value);
  else counts.set(value, count - 1);
  return true;
}

export function consumesMultiset(counts: Map<string, number>, values: readonly string[]): boolean {
  for (const value of values) {
    if (!takeMultisetValue(counts, value)) return false;
  }
  return counts.size === 0;
}

export function sameMultiset(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && consumesMultiset(multisetCounts(expected), actual);
}

export const TRANSLATION_LITERAL_CHECKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["URLs", /https?:\/\/[^\s<>()]+/gu],
  ["numbers", /(?<![\p{L}\p{N}_])\d[\d.,:/%+-]*(?![\p{L}\p{N}_])/gu],
  ["inline code", /`[^`\n]+`/gu],
  ["fenced code blocks", /```[^\n]*\n[\s\S]*?```/gu],
];

export function literalValidationIssues(source: string, candidate: string): string[] {
  const issues: string[] = [];
  for (const [label, pattern] of TRANSLATION_LITERAL_CHECKS) {
    if (!sameMultiset(allMatches(source, pattern), allMatches(candidate, pattern))) {
      issues.push(`${label} were not preserved exactly`);
    }
  }
  return issues;
}

export function textOutsideTranslationLiterals(source: string): string {
  return source
    .replace(/```[^\n]*\n[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]+`/gu, " ")
    .replace(/https?:\/\/[^\s<>()]+/gu, " ");
}

export function hebrewScriptIssue(source: string, candidate: string, language: string): string | null {
  if (translationLocale(language) !== "he") return null;
  if (!/\p{L}{2,}/u.test(textOutsideTranslationLiterals(source))) return null;
  return /[\u0590-\u05FF]/u.test(candidate) ? null : "a Hebrew translation must contain Hebrew script";
}

/** A bounded, deterministic quality floor. It cannot judge literary style,
 * but it prevents the concrete bad outcomes from being saved as complete:
 * English-only Hebrew output, mojibake, and damaged source literals. */
export function translationValidationIssues(
  source: string,
  candidate: string,
  language: string,
): string[] {
  const trimmed = candidate.trim();
  if (trimmed === "") return ["the translation was empty"];
  const issues: string[] = [];
  if (/[\uFFFD]|(?:Ã.|Â.|â[\u0080-\uFFFF]|ðŸ)/u.test(trimmed)) {
    issues.push("the translation contains replacement or mojibake characters");
  }
  issues.push(...literalValidationIssues(source, trimmed));
  const hebrewIssue = hebrewScriptIssue(source, trimmed, language);
  if (hebrewIssue !== null) {
    issues.push(hebrewIssue);
  }
  return issues;
}

export async function translatedChunk(ctx: CmdCtx, source: string, language: string): Promise<string> {
  const system = translationSystemPrompt(language);
  let candidate = await askQuiet(ctx, system, source, 0.2);
  let issues = translationValidationIssues(source, candidate, language);
  if (issues.length === 0) return candidate;

  candidate = await askQuiet(
    ctx,
    system + " The previous attempt failed deterministic validation. Correct every listed issue.",
    `SOURCE:\n${source}\n\nREJECTED TRANSLATION:\n${candidate}\n\nVALIDATION ERRORS:\n` +
      issues.map((issue) => `- ${issue}`).join("\n"),
    0.0,
  );
  issues = translationValidationIssues(source, candidate, language);
  if (issues.length > 0) {
    throw new Error(`Translation quality validation failed: ${issues.join("; ")}.`);
  }
  return candidate;
}

export function requiredTranslationLanguage(args: string): string {
  const trimmed = args.trim();
  const lastTo = trimmed.lastIndexOf(" to ");
  let language = trimmed;
  if (lastTo !== -1) {
    language = trimmed.slice(lastTo + 4);
  } else if (trimmed.startsWith("to ")) {
    language = trimmed.slice(3);
  }
  language = language.trim();
  if (language === "") {
    throw new Error("Say the target language — e.g. #translate @notes.md to Spanish");
  }
  return language;
}

export interface TranslationRequest {
  room: RoomHandle;
  name: string;
  text: string;
  language: string;
}

export function translationRequest(ctx: CmdCtx): TranslationRequest {
  const fileId = ctx.refs[0];
  if (fileId === undefined) {
    throw new Error("Add a file with @ — e.g. #translate @notes.md to Spanish");
  }
  const language = requiredTranslationLanguage(ctx.args);
  const room = requireRoom(ctx.rooms);
  const [name, , , textRaw] = getFileFull(room.db, fileId);
  const text = textRaw ?? "";
  if (text.trim() === "") {
    throw new Error(`"${name}" has no readable text to translate.`);
  }
  return { room, name, text, language };
}

export function translationChunks(text: string): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += 3000) {
    chunks.push(chars.slice(i, i + 3000).join(""));
  }
  return chunks;
}

export type TranslationChunkOutcome =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "error"; readonly error: string };

export async function translateOneChunk(ctx: CmdCtx, chunk: string, language: string): Promise<TranslationChunkOutcome> {
  try {
    return { kind: "value", value: await translatedChunk(ctx, chunk, language) };
  } catch (err) {
    return { kind: "error", error: errorMessage(err) };
  }
}

export interface TranslationPass {
  output: string;
  successfulParts: Set<number>;
  failures: ChunkFailures;
}

export async function translateChunks(ctx: CmdCtx, chunks: readonly string[], language: string): Promise<TranslationPass> {
  let output = "";
  const successfulParts = new Set<number>();
  const failures = new ChunkFailures();
  for (let i = 0; i < chunks.length; i++) {
    if (ctx.cancel.load()) {
      break;
    }
    ctx.turn.step(ctx.send, `Translating part ${i + 1}/${chunks.length}`);
    const outcome = await translateOneChunk(ctx, chunks[i]!, language);
    if (outcome.kind === "error") {
      if (failures.note(outcome.error)) {
        break;
      }
      continue;
    }
    failures.ok();
    output += `${outcome.value.trim()}\n`;
    successfulParts.add(i + 1);
  }
  return { output, successfulParts, failures };
}

export function missingTranslationParts(total: number, successfulParts: ReadonlySet<number>): number[] {
  return Array.from(
    { length: total },
    (_unused, index) => index + 1,
  ).filter((part) => !successfulParts.has(part));
}

export function partialTranslationNote(
  translatedParts: number,
  total: number,
  missingParts: readonly number[],
  name: string,
  cancel: CancelFlag,
): string {
  const why = cancel.load()
    ? "the run was stopped"
    : "the model failed or returned output that did not pass translation validation";
  return (
    `\n\n---\n\n_Partial translation — translated ${translatedParts} of ${total} parts. ` +
    `Part${missingParts.length === 1 ? "" : "s"} ${missingParts.join(", ")} ` +
    `${missingParts.length === 1 ? "is" : "are"} missing from "${name}" because ${why}._\n`
  );
}

export interface TranslationOutput {
  content: string;
  complete: boolean;
}

export function translationOutput(pass: TranslationPass, total: number, name: string, cancel: CancelFlag): TranslationOutput {
  if (pass.output.trim() === "") {
    throw new Error(pass.failures.nothingSaved());
  }
  const missingParts = missingTranslationParts(total, pass.successfulParts);
  const complete = missingParts.length === 0;
  if (complete) {
    return { content: pass.output, complete };
  }
  return {
    content: pass.output + partialTranslationNote(pass.successfulParts.size, total, missingParts, name, cancel),
    complete,
  };
}

export function translatedFileName(name: string, language: string): string {
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx !== -1 ? name.slice(0, dotIdx) : name;
  return `${base} (${language}).md`;
}

export async function commitTranslation(
  room: RoomHandle,
  name: string,
  content: string,
  ctx: CmdCtx,
): Promise<Written> {
  // ART-1: no cancel flag here on purpose — a Stop mid-translation keeps the
  // parts already translated (the partial note above says so), so the write
  // is the honest record of what was done, not work that should be thrown
  // away.
  const artifact = Artifact.note(name, content)
    .by("#translate")
    .duringRun(ctx.turn.runId)
    .fromFiles(ctx.refs);
  return room.workspace === undefined
    ? artifact.commit(room.db)
    : await artifact.commitToWorkspace(room.workspace);
}

export function translationResult(
  complete: boolean,
  sourceName: string,
  language: string,
  written: Written,
): CommandResult {
  const action = complete ? "Translated" : "Partially translated";
  return commandResult(
    `${action} **${sourceName}** into ${language} → **${written.meta.name}**.`,
    [written.meta.name],
  );
}

export async function cmdTranslate(ctx: CmdCtx): Promise<CommandResult> {
  const { room, name, text, language } = translationRequest(ctx);
  const chunks = translationChunks(text);
  const pass = await translateChunks(ctx, chunks, language);
  const output = translationOutput(pass, chunks.length, name, ctx.cancel);
  const written = await commitTranslation(room, translatedFileName(name, language), output.content, ctx);
  emitSafely(ctx.emit, "room-files-changed", undefined);
  emitSafely(ctx.emit, "agent-open-file", { id: written.meta.id });
  return translationResult(output.complete, name, language, written);
}
