/**
 * REAL logic for four of `exec_tool`'s arms — `list_room_files`,
 * `search_room`, `open_file`, `annotate_file` — ported from
 * `src-tauri/src/commands/agent.rs`'s corresponding match arms
 * (`list_room_files` ~3088, `search_room` ~3122, `open_file` ~3153,
 * `annotate_file` ~3219).
 *
 * Every DB read goes through the already-committed `db-host/files.ts`
 * (`listFilesBrief`, `placementNote`, `findFileLikeFull`, `findFileLike`,
 * `getFileExtractedText`) and `db-host/retrieval.ts`
 * (`retrieveContextExcluding`); nothing those modules already expose is
 * re-implemented here. Likewise `clamp_bytes`/`tail_bytes`/`clamp_words`/
 * `excerpt`/`normalize_for_match` come from `textClamp.ts`.
 *
 * PORTED HERE because nothing else in this rewrite carries them yet:
 *  - `closest_snippet` (agent.rs ~39) and its private `norm` /
 *    `words_with_byte_spans` (agent.rs ~322-352) — the word-overlap fallback
 *    that anchors a paraphrased quote to a REAL, verbatim substring.
 *  - `build_annotation` (agent.rs ~354) — the shared validation for a
 *    highlight quote or a spreadsheet cell range.
 *  - `parse_a1` / `is_a1_range` — despite being called from `annotate_file`
 *    and `open_file`, these live in `commands/spreadsheet.rs` (~10-42);
 *    ported here rather than dragging in that whole module for two small
 *    pure functions neither arm needs anything else from.
 *
 * NOT PORTED — honestly narrowed, matching each arm's own upstream gap
 * rather than faking a stand-in:
 *  - `embed_question` (an Ollama call, `retrieval/backfill.rs`) has no
 *    Electron port yet, and `retrieval.ts`'s own module doc lists it out of
 *    scope. {@link execSearchRoom} always passes a `null` question embedding,
 *    which is EXACTLY the path the Rust arm itself takes on a machine with no
 *    embed model installed ("`None` → keyword-only retrieval", its own
 *    comment). Degraded, not faked — and identically degraded in both.
 *  - the `injected_rowids` exclusion set (CHG-16) is always an empty `Set`.
 *    The Rust arm's own comment says the same is true of every LIVE caller:
 *    "Every live caller reaches this over the room bridge, which does NOT
 *    know — so the exclusion set is empty here."
 *
 * TWO KINDS OF FAILURE, kept apart deliberately. `findFileLike`/
 * `findFileLikeFull` THROW to signal "no such file" — that is this port's
 * spelling of Rust's `Err(String)`, a domain answer the model must see, so
 * both are caught and returned as `ok: false`. A genuine SQLite failure from
 * `listFilesBrief`/`retrieveContextExcluding` is NOT caught, matching how
 * every other real arm in `execTool.ts` calls its DB layer (`listMemories`,
 * `memoriesLike`, …): infrastructure faults propagate to the one try/catch in
 * `bridgeDispatcher.ts` rather than being flattened into a tool result that
 * reads like the room answered.
 *
 * Each exported `exec*` takes the room's ALREADY-UNWRAPPED
 * `Database.Database` — `execTool.ts`'s dispatch resolves `requireRoom` once,
 * exactly as it does before every other real arm — plus whatever the Rust
 * arm's own `args` / `window.emit` / `ToolEffects` touch, and nothing more.
 * This module has no dependency, type or value, on `execTool.ts`:
 * {@link FileToolOutcome} is a structurally-identical sibling of that file's
 * `ToolOutcome` rather than an import, so `execTool.ts` stays the only side of
 * this seam that has to know the other exists.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import {
  findFileLike,
  findFileLikeFull,
  getFileExtractedText,
  listFilesBrief,
  placementNote,
} from "./db-host/files.js";
import { retrieveContextExcluding } from "./db-host/retrieval.js";
import { isA1Range, parseA1 } from "./fileToolsA1.js";
import { clampBytes, clampWords, excerpt, normalizeForMatch, tailBytes } from "./textClamp.js";

export { isA1Range, parseA1 } from "./fileToolsA1.js";

// ------------------------------------------------------------------- shell

/** `exec_tool`'s `Result<String, String>` for these arms. Structurally
 * identical to `execTool.ts`'s own `ToolOutcome` — see the module doc for why
 * it is a sibling type rather than an import. */
export type FileToolOutcome = { ok: true; text: string } | { ok: false; error: string };

function ok(text: string): FileToolOutcome {
  return { ok: true, text };
}

function fail(error: string): FileToolOutcome {
  return { ok: false, error };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `args["k"].as_str().unwrap_or_default()`. */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `args["k"].as_str()` — the argument as given when it is a string, `null`
 * for anything else (missing, a number, a boolean, …). */
function asOptionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** `args["k"].as_u64()` — a non-negative JSON integer, or `null` for anything
 * else (missing, a float, a negative number, a string). */
function asOptionalUint(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful call into a failed one. The narrowest possible contract
 * (just the callback), so this module needs no view of `ExecToolDeps`. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

// ------------------------------------------------------------ list_room_files

/** How many file rows one listing may return before it starts crowding out
 * the system prompt (CHG-1). */
const MAX_LISTED_FILES = 100;

/** Ported from `exec_tool`'s `"list_room_files"` arm. */
export function execListRoomFiles(db: Database.Database): FileToolOutcome {
  const all = listFilesBrief(db);
  const total = all.length;
  // CHG-1: cap the row count so a file-heavy room can't crowd out the system
  // prompt. CHG-23: show each file's cached one-liner when it has one.
  const rows = all
    .slice(0, MAX_LISTED_FILES)
    .map(([name, mime, size, summary, [origin, visibility]]) => {
      const placed = placementNote(origin, visibility);
      const trimmed = summary?.trim() ?? "";
      if (trimmed !== "") {
        return `- ${name} (${mime}, ${size} bytes)${placed} — ${clampWords(trimmed, 120)}`;
      }
      return `- ${name} (${mime}, ${size} bytes)${placed}`;
    });
  if (total > MAX_LISTED_FILES) {
    rows.push(
      `…and ${total - MAX_LISTED_FILES} more files — use search_room to find content or open_file by name.`
    );
  }
  return ok(rows.length === 0 ? "The room has no files." : rows.join("\n"));
}

// ---------------------------------------------------------------- search_room

/**
 * Ported from `exec_tool`'s `"search_room"` arm — see the module doc for the
 * `embed_question` / `injected_rowids` gaps this INHERITS from its Rust
 * upstream rather than introduces.
 */
export function execSearchRoom(db: Database.Database, args: Record<string, unknown>): FileToolOutcome {
  const query = asString(args.query);
  const [chunks, fallback] = retrieveContextExcluding(db, query, null, new Set<number>());
  // `fallback` means the retrieval layer padded with recent content because
  // nothing actually matched. CHG-10: padding is never presented as a hit.
  if (fallback || chunks.length === 0) {
    return ok("No matching content found.");
  }
  return ok(
    chunks
      .slice(0, 4)
      // Char-safe, match-centered excerpt (the Rust original was once a raw
      // byte slice that panicked on multibyte text and poisoned the mutex).
      .map((c) => `[${c.fileName}]\n${excerpt(c.text, query, 800)}`)
      .join("\n\n")
  );
}

// ----------------------------------------------------------- A1 cell parsing

// ------------------------------------------------------ closest-snippet match

/** Rust's `char::is_alphanumeric()` — the Alphabetic property plus general
 * category N, which is WIDER than `\p{L}`: Hebrew nikud (Mn, Other_Alphabetic)
 * counts as alphanumeric to Rust and must count here too, or a pointed word's
 * comparison key would silently differ from the one the Rust source computes. */
const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;
/** Rust's `char::is_whitespace()` — the White_Space property. Deliberately not
 * JS's `\s`, which both misses U+0085 (NEL) and adds U+FEFF. */
const WHITESPACE = /\p{White_Space}/u;
const WHITESPACE_RUN = /\p{White_Space}+/u;

/** Collapse a token to its comparison key: alphanumerics only, lowercased.
 * Ported verbatim from `agent.rs`'s private `norm`. */
function norm(word: string): string {
  let out = "";
  for (const ch of word) {
    if (ALPHANUMERIC.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}

/** One whitespace-delimited word as a span over `Array.from(text)`. Rust uses
 * UTF-8 BYTE offsets; code-point indices are the JS analogue — equally safe to
 * slice on (they never split a character) and needing no encode/decode step. */
interface WordSpan {
  start: number;
  end: number;
  key: string;
}

function appendWord(chars: string[], start: number | null, end: number, words: WordSpan[]): void {
  if (start === null) {
    return;
  }
  const key = norm(chars.slice(start, end).join(""));
  if (key !== "") {
    words.push({ start, end, key });
  }
}

function nextWordStart(chars: string[], index: number, start: number | null, words: WordSpan[]): number | null {
  if (WHITESPACE.test(chars[index] as string)) {
    appendWord(chars, start, index, words);
    return null;
  }
  return start ?? index;
}

/** Each whitespace-delimited word of `text` as a (start, end, key) span, where
 * key is the {@link norm}-alized form; words that normalize to empty (pure
 * punctuation) are dropped. Ported from `agent.rs`'s private
 * `words_with_byte_spans`, adapted from byte to code-point spans. */
function wordsWithSpans(text: string): { chars: string[]; words: WordSpan[] } {
  const chars = Array.from(text);
  const words: WordSpan[] = [];
  let start: number | null = null;
  for (let i = 0; i < chars.length; i++) {
    start = nextWordStart(chars, i, start, words);
  }
  appendWord(chars, start, chars.length, words);
  return { chars, words };
}

interface SnippetWindow {
  score: number;
  si: number;
  ei: number;
}

function normalizedWords(quote: string): string[] {
  return quote
    .split(WHITESPACE_RUN)
    .filter((word) => word !== "")
    .map(norm)
    .filter((word) => word !== "");
}

function snippetWindowWidths(wordCount: number): number[] {
  return [Math.max(wordCount - 2, 2), wordCount, wordCount + 2];
}

function windowScore(words: WordSpan[], start: number, width: number, quoteWords: Set<string>): number {
  let score = 0;
  for (let index = start; index < start + width; index++) {
    if (quoteWords.has((words[index] as WordSpan).key)) {
      score += 1;
    }
  }
  return score;
}

function isBetterWindow(best: SnippetWindow | null, candidate: SnippetWindow): boolean {
  return best === null || candidate.score > best.score;
}

function bestSnippetWindow(
  words: WordSpan[],
  quoteWords: Set<string>,
  widths: number[]
): SnippetWindow | null {
  let best: SnippetWindow | null = null;
  for (const width of widths) {
    if (width > words.length) {
      continue;
    }
    for (let start = 0; start <= words.length - width; start++) {
      const candidate = { score: windowScore(words, start, width, quoteWords), si: start, ei: start + width };
      if (isBetterWindow(best, candidate)) {
        best = candidate;
      }
    }
  }
  return best;
}

function isSolidSnippetMatch(best: SnippetWindow | null, quoteWordCount: number): best is SnippetWindow {
  return best !== null && best.score * 2 > quoteWordCount;
}

/**
 * ADD-22: when an exact/normalized quote can't be found (small models
 * paraphrase or drop a word), locate the passage in `extracted` that best
 * matches by word overlap and return it VERBATIM, so the viewer's own matcher
 * can still highlight it. `null` when nothing is a solid match — a strict word
 * majority is required so this never highlights something unrelated. The
 * returned string is always a real substring of `extracted`. Ported verbatim
 * from `agent.rs`'s `closest_snippet`.
 */
export function closestSnippet(extracted: string, quote: string): string | null {
  const qWords = normalizedWords(quote);
  if (qWords.length < 3) {
    return null; // too short to approximate safely
  }
  const { chars, words: h } = wordsWithSpans(extracted);
  if (h.length === 0) {
    return null;
  }
  const qSet = new Set(qWords);
  const win = qWords.length;
  const best = bestSnippetWindow(h, qSet, snippetWindowWidths(win));
  if (!isSolidSnippetMatch(best, win)) {
    return null; // need a strict majority of the quote's words present
  }
  return chars.slice((h[best.si] as WordSpan).start, (h[best.ei - 1] as WordSpan).end).join("");
}

/** Does `quote` appear in `extracted` under {@link normalizeForMatch}? PDF
 * extraction breaks words unpredictably, so a space-free comparison is tried
 * before calling it a miss. The shared half of `open_file`'s and
 * `annotate_file`'s identical grounding checks in the Rust source. */
function quoteIsGrounded(extracted: string, quote: string): boolean {
  const haystack = normalizeForMatch(extracted);
  const needle = normalizeForMatch(quote);
  return (
    haystack.includes(needle) || haystack.replaceAll(" ", "").includes(needle.replaceAll(" ", ""))
  );
}

// ------------------------------------------------------------------ open_file

function validCell(value: string | null): string | null {
  return value !== null && parseA1(value) !== null ? value : null;
}

function requestedFind(value: string | null): string | null {
  return value !== null && value.trim() !== "" ? value : null;
}

interface GroundedFind {
  find: string | null;
  approx: boolean;
}

function groundedFind(text: string | null, requested: string | null): GroundedFind {
  if (requested === null || text === null || quoteIsGrounded(text, requested)) {
    return { find: requested, approx: false };
  }
  return { find: closestSnippet(text, requested), approx: true };
}

function openTarget(page: number | null, cell: string | null, find: string | null): string {
  if (page !== null) {
    return ` at page ${page}`;
  }
  if (cell !== null) {
    return ` at cell ${cell}`;
  }
  return find !== null ? ` at "${find}"` : "";
}

function openNote(approx: boolean, find: string | null): string {
  if (!approx) {
    return "";
  }
  if (find !== null) {
    return (
      "\n(The exact text you asked for isn't in the file — jumped to the closest " +
      "real passage instead. Quote text verbatim from search_room next time.)"
    );
  }
  return (
    "\n(That text isn't in this file — opened it from the start. Use search_room " +
    "first and copy the passage exactly.)"
  );
}

function fileSnippet(text: string | null): string {
  if (text === null) {
    return "";
  }
  const head = clampBytes(text, 1200);
  const tail = tailBytes(text, 600);
  return tail === "" ? `\nIt begins:\n${head}` : `\nIt begins:\n${head}\n…\nIt ends:\n${tail}`;
}

/** Ported from `exec_tool`'s `"open_file"` arm. `emit` is
 * `window.emit("agent-open-file", …)`, threaded through exactly like
 * `execTool.ts`'s own `deps.emit` for the memory arms — optional, and
 * swallowed on failure. */
export function execOpenFile(
  db: Database.Database,
  args: Record<string, unknown>,
  emit?: EmitFn
): FileToolOutcome {
  const name = asString(args.name).toLowerCase();
  const page = asOptionalUint(args.page);
  const cellArg = asOptionalString(args.cell);
  const cell = validCell(cellArg);
  const findArg = asOptionalString(args.find);
  const requested = requestedFind(findArg);

  let id: string;
  let realName: string;
  let text: string | null;
  try {
    [id, realName, text] = findFileLikeFull(db, name);
  } catch (e) {
    return fail(errMessage(e));
  }

  // Ground `find` in the file's REAL text before the viewer hunts for it (the
  // same ADD-22 net as annotate_file): a model quoting from memory drifts —
  // "בירושלים" for the file's "בירושלם" — and an exact-match viewer then
  // silently stays on page 1. Verify the passage, or swap in the closest real
  // one. With no extracted text there is nothing to verify against, so the
  // request is passed through unjudged, exactly as Rust's `(f, _)` arm does.
  const { find, approx } = groundedFind(text, requested);

  emitSafely(emit, "agent-open-file", { id, page, cell, find });

  // Head AND tail. The head alone made "did my append land?" unanswerable with
  // this tool — the only verb an agent has for reading back a file it just
  // wrote (self-test 2026-08-01, wave 3). Char-safe both ends.
  return ok(
    `Opened "${realName}" in the viewer${openTarget(page, cell, find)}.${openNote(approx, find)}${fileSnippet(text)}`
  );
}

// -------------------------------------------------------------- annotate_file

/**
 * Build a viewer annotation payload for a file, verifying a text quote appears
 * verbatim in the extracted text (normalization-tolerant, with a space-free
 * fallback for PDFs). Returns the payload plus a short human description;
 * fails if the quote can't be found or neither a quote nor a cell range was
 * given. Ported verbatim from `agent.rs`'s `build_annotation`.
 *
 * EXPORTED (2026-08, the `chat_commands/knowledge.rs` batch) for
 * `chatCommandsKnowledge.ts`'s `#highlight`, whose Rust counterpart
 * (`chat_commands/knowledge.rs::cmd_highlight`) calls this SAME
 * `agent.rs::build_annotation` function directly — one function, two Rust
 * callers, and now two TS callers of one export rather than a second copy.
 */
type AnnotationResult =
  | { ok: true; payload: Record<string, unknown>; described: string }
  | { ok: false; error: string };

interface ResolvedAnnotationQuote {
  quote: string;
  approx: boolean;
}

function rangeAnnotation(
  id: string,
  realName: string,
  range: string,
  sheet: string | null,
  note: string | null
): AnnotationResult {
  if (!isA1Range(range)) {
    return {
      ok: false,
      error: `"${range}" is not a cell range — use A1 notation like B7 or B2:D5.`,
    };
  }
  return {
    ok: true,
    payload: { fileId: id, name: realName, sheet, range, note },
    described: `cells ${range}`,
  };
}

function resolveAnnotationQuote(extracted: string | null, quote: string): ResolvedAnnotationQuote | null {
  const text = extracted ?? "";
  if (quoteIsGrounded(text, quote)) {
    return { quote, approx: false };
  }
  const snippet = closestSnippet(text, quote);
  if (snippet === null) {
    return null;
  }
  return { quote: snippet, approx: true };
}

function quoteAnnotation(
  id: string,
  realName: string,
  extracted: string | null,
  quote: string,
  page: number | null,
  note: string | null
): AnnotationResult {
  const resolved = resolveAnnotationQuote(extracted, quote);
  if (resolved === null) {
    return {
      ok: false,
      error:
        `Could not find that text in "${realName}". Copy a short snippet exactly as ` +
        "it appears in the file (use search_room or open_file to see its text first).",
    };
  }
  return {
    ok: true,
    payload: { fileId: id, name: realName, quote: resolved.quote, page, note, approx: resolved.approx },
    described: resolved.approx ? `"${resolved.quote}" (closest match)` : `"${resolved.quote}"`,
  };
}

export function buildAnnotation(
  id: string,
  realName: string,
  extracted: string | null,
  quoteRaw: string,
  range: string,
  page: number | null,
  sheet: string | null,
  note: string | null
): AnnotationResult {
  const quote = quoteRaw.trim();
  if (range !== "") {
    return rangeAnnotation(id, realName, range, sheet, note);
  }
  if (quote !== "") {
    // ADD-22: on a miss, don't hard-fail — anchor on the closest real passage
    // so a paraphrased/near quote still highlights (marked approximate).
    return quoteAnnotation(id, realName, extracted, quote, page, note);
  }
  return { ok: false, error: "Provide either exact text to highlight, or a cell range for spreadsheets." };
}

/**
 * Ported from `exec_tool`'s `"annotate_file"` arm. `effects` is narrowed to
 * the one field this arm ever sets, so this module needs no dependency on
 * `execTool.ts`'s full `ToolEffects` type — a `ToolEffects` value satisfies
 * this shape structurally, extra fields and all.
 *
 * The success sentence claims only that the viewer was SENT there. Whether the
 * mark landed is the viewer's own business and never travels back — a PDF page
 * that has not rendered yet simply misses. The grounding check above already
 * reports when the quote itself drifted.
 */
export function execAnnotateFile(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { annotation: unknown },
  emit?: EmitFn
): FileToolOutcome {
  const name = asString(args.name);
  const quote = asString(args.text);
  const page = asOptionalUint(args.page);
  const sheet = asOptionalString(args.sheet);
  const range = asString(args.range).trim().toUpperCase();
  const note = asOptionalString(args.note);

  let id: string;
  let realName: string;
  try {
    [id, realName] = findFileLike(db, name);
  } catch (e) {
    return fail(errMessage(e));
  }
  const extracted = getFileExtractedText(db, id);

  const built = buildAnnotation(id, realName, extracted, quote, range, page, sheet, note);
  if (!built.ok) {
    return fail(built.error);
  }
  effects.annotation = built.payload;
  emitSafely(emit, "agent-annotate", built.payload);
  return ok(`Sent the viewer to ${built.described} in "${realName}".`);
}
