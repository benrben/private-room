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
import { clampBytes, clampWords, excerpt, normalizeForMatch, tailBytes } from "./textClamp.js";

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

/** A spreadsheet's own ceilings: columns run A..XFD (three letters, 16 384)
 * and rows stop at 1 048 576. Enforced BEFORE the column accumulator runs — a
 * long run of letters used to multiply its way past `usize`, producing a
 * meaningless index that then took the app down when the grid was resized to
 * reach it. From `commands/spreadsheet.rs`. */
const MAX_A1_COL_LETTERS = 3;
const MAX_A1_ROW = 1_048_576;

/** Rust's `c.is_ascii_alphabetic()`, applied to an already-uppercased cell. */
const ASCII_UPPER = /[A-Z]/;
/** Rust's `digits.chars().all(|c| c.is_ascii_digit())`. JS `$` matches only at
 * end of input (no Python-style trailing-newline leniency), so this is a total
 * check. */
const ASCII_DIGITS_ONLY = /^[0-9]+$/;

/** "B7" → zero-based (row, col). `null` when it isn't A1 notation. Ported
 * verbatim from `commands/spreadsheet.rs`'s `parse_a1`. */
export function parseA1(cellRaw: string): [number, number] | null {
  const cell = cellRaw.trim().toUpperCase();
  let i = 0;
  while (i < cell.length && ASCII_UPPER.test(cell[i] as string)) {
    i += 1;
  }
  const letters = cell.slice(0, i);
  const digits = cell.slice(i);
  if (letters === "" || digits === "" || !ASCII_DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (letters.length > MAX_A1_COL_LETTERS) {
    return null;
  }
  let col = 0;
  for (const c of letters) {
    col = col * 26 + (c.charCodeAt(0) - "A".charCodeAt(0) + 1);
  }
  col -= 1;
  // Rust's `digits.parse::<usize>()` already refuses a number too large for
  // `usize`; the row ceiling refuses one that merely LOOKS valid but would
  // grow the grid until the app runs out of memory. `Number(digits)` cannot
  // fail on an all-digit string, so the ceiling is the whole check here.
  const row = Number(digits);
  if (!Number.isFinite(row) || row === 0 || row > MAX_A1_ROW) {
    return null;
  }
  return [row - 1, col];
}

/** A lone cell, or a `first:second` range whose two ends both parse as A1
 * cells. Mirrors Rust's `splitn(2, ':')` — only the FIRST colon splits, so
 * "A1:B2:C3" tries "B2:C3" as the second half and fails it. Ported verbatim
 * from `commands/spreadsheet.rs`'s `is_a1_range`. */
export function isA1Range(range: string): boolean {
  const idx = range.indexOf(":");
  if (idx === -1) {
    return parseA1(range) !== null;
  }
  return parseA1(range.slice(0, idx)) !== null && parseA1(range.slice(idx + 1)) !== null;
}

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

/** Each whitespace-delimited word of `text` as a (start, end, key) span, where
 * key is the {@link norm}-alized form; words that normalize to empty (pure
 * punctuation) are dropped. Ported from `agent.rs`'s private
 * `words_with_byte_spans`, adapted from byte to code-point spans. */
function wordsWithSpans(text: string): { chars: string[]; words: WordSpan[] } {
  const chars = Array.from(text);
  const words: WordSpan[] = [];
  let start: number | null = null;
  for (let i = 0; i < chars.length; i++) {
    if (WHITESPACE.test(chars[i] as string)) {
      if (start !== null) {
        const key = norm(chars.slice(start, i).join(""));
        if (key !== "") {
          words.push({ start, end: i, key });
        }
        start = null;
      }
    } else if (start === null) {
      start = i;
    }
  }
  if (start !== null) {
    const key = norm(chars.slice(start).join(""));
    if (key !== "") {
      words.push({ start, end: chars.length, key });
    }
  }
  return { chars, words };
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
  const qWords = quote
    .split(WHITESPACE_RUN)
    .filter((w) => w !== "")
    .map(norm)
    .filter((w) => w !== "");
  if (qWords.length < 3) {
    return null; // too short to approximate safely
  }
  const { chars, words: h } = wordsWithSpans(extracted);
  if (h.length === 0) {
    return null;
  }
  const qSet = new Set(qWords);
  const win = qWords.length;
  let best: { score: number; si: number; ei: number } | null = null;
  for (const w of [Math.max(win - 2, 2), win, win + 2]) {
    if (w > h.length) {
      continue;
    }
    for (let i = 0; i <= h.length - w; i++) {
      let score = 0;
      for (let k = i; k < i + w; k++) {
        if (qSet.has((h[k] as WordSpan).key)) {
          score += 1;
        }
      }
      if (best === null || score > best.score) {
        best = { score, si: i, ei: i + w };
      }
    }
  }
  if (best === null || best.score * 2 <= win) {
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
  const cell = cellArg !== null && parseA1(cellArg) !== null ? cellArg : null;
  const findArg = asOptionalString(args.find);
  const requested = findArg !== null && findArg.trim() !== "" ? findArg : null;

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
  let find = requested;
  let approx = false;
  if (requested !== null && text !== null && !quoteIsGrounded(text, requested)) {
    find = closestSnippet(text, requested); // null when nothing is close
    approx = true;
  }

  emitSafely(emit, "agent-open-file", { id, page, cell, find });

  let target = "";
  if (page !== null) {
    target = ` at page ${page}`;
  } else if (cell !== null) {
    target = ` at cell ${cell}`;
  } else if (find !== null) {
    target = ` at "${find}"`;
  }

  let note = "";
  if (approx && find !== null) {
    note =
      "\n(The exact text you asked for isn't in the file — jumped to the closest " +
      "real passage instead. Quote text verbatim from search_room next time.)";
  } else if (approx) {
    note =
      "\n(That text isn't in this file — opened it from the start. Use search_room " +
      "first and copy the passage exactly.)";
  }

  // Head AND tail. The head alone made "did my append land?" unanswerable with
  // this tool — the only verb an agent has for reading back a file it just
  // wrote (self-test 2026-08-01, wave 3). Char-safe both ends.
  let snippet = "";
  if (text !== null) {
    const head = clampBytes(text, 1200);
    const tail = tailBytes(text, 600);
    snippet = tail === "" ? `\nIt begins:\n${head}` : `\nIt begins:\n${head}\n…\nIt ends:\n${tail}`;
  }

  return ok(`Opened "${realName}" in the viewer${target}.${note}${snippet}`);
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
export function buildAnnotation(
  id: string,
  realName: string,
  extracted: string | null,
  quoteRaw: string,
  range: string,
  page: number | null,
  sheet: string | null,
  note: string | null
): { ok: true; payload: Record<string, unknown>; described: string } | { ok: false; error: string } {
  const quote = quoteRaw.trim();
  if (range !== "") {
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
  if (quote !== "") {
    // ADD-22: on a miss, don't hard-fail — anchor on the closest real passage
    // so a paraphrased/near quote still highlights (marked approximate).
    let finalQuote: string;
    let approx: boolean;
    if (quoteIsGrounded(extracted ?? "", quote)) {
      finalQuote = quote;
      approx = false;
    } else {
      const snip = closestSnippet(extracted ?? "", quote);
      if (snip === null) {
        return {
          ok: false,
          error:
            `Could not find that text in "${realName}". Copy a short snippet exactly as ` +
            "it appears in the file (use search_room or open_file to see its text first).",
        };
      }
      finalQuote = snip;
      approx = true;
    }
    return {
      ok: true,
      payload: { fileId: id, name: realName, quote: finalQuote, page, note, approx },
      described: approx ? `"${finalQuote}" (closest match)` : `"${finalQuote}"`,
    };
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
