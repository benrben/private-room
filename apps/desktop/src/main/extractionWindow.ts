/**
 * ADD-27/ADD-32: windowed, filtered reads over a file's extracted text.
 * Ported from `src-tauri/src/extraction/window.rs` (293 lines, read in full,
 * including its `#[cfg(test)] mod tests`).
 *
 * Genuinely missing dependency, not a re-port: `commands/jobs/file_pass.rs`
 * (this batch's real target) calls `extraction::smart_filter` and
 * `extraction::partition_windows` directly to build a pass's plan, and
 * neither had an Electron port yet — `jobs.ts`'s own module doc names this
 * exact gap ("`extraction::smart_filter` / `partition_windows`... reserved
 * for future batches"). This file is that future batch, scoped to exactly the
 * two functions (plus the byte-slicing primitive) file_pass needs — not the
 * rest of `extraction/` (chunking, pdf, format detection), which stays
 * unported.
 *
 * BYTE OFFSETS, NOT STRING INDICES — the one deviation worth flagging up
 * front. Rust's `str::len()`/`&str` ranges are UTF-8 BYTE offsets, and
 * `PassPlan.windows` (file_pass.rs) persists exactly those byte spans into
 * the room, so a resumed pass must re-slice the identical bytes a fresh room
 * would. JS strings are UTF-16 code units, so every offset computed here is
 * done in BYTE space via `Buffer.from(text, "utf8")` and translated back with
 * `.toString("utf8")` — never `string.length`/`.slice()`, which would produce
 * a DIFFERENT windowing for any file containing so much as one non-ASCII
 * character (accented names, curly quotes, Hebrew, emoji). The multibyte test
 * below (`é`.repeat(5000), 2 bytes/char) is the one that would catch a
 * regression to string-index arithmetic.
 *
 * The second deviation to know about is inside {@link WORDISH_CHAR}: Rust's
 * `char::is_alphanumeric()` is the derived ALPHABETIC property plus N, and
 * `\p{L}` is not the same set. See that constant's own comment — the gap
 * between them is exactly the combining marks pointed Hebrew is made of, and
 * getting it wrong deletes whole lines of it before the model ever sees them.
 */

// ------------------------------------------------------------- smart_filter

/** Floor on a partition window's target size, so a caller can't ask
 * {@link partitionWindows} for pathologically tiny windows. */
export const READ_WINDOW_MIN = 200;

/** How many identical lines in a row are carried through unchanged — see the
 * Rust source's own comment: collapsing every duplicate to one is a silent
 * edit of the data (three identical ledger rows must still read as three),
 * so only a run LONGER than any table anyone reads row-by-row is noise. */
const MAX_IDENTICAL_RUN = 6;

/** Rust's `str::lines()`: splits on `\n` or `\r\n`, yields NO trailing empty
 * entry for a final line terminator (unlike `string.split("\n")`, which
 * leaves one), and strips exactly one trailing `\r` per line. */
function rustLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutFinalNewline.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Rust's `char::is_whitespace()`/`str::trim_end()`/`str::trim()` all follow
 * Unicode's White_Space property — `\p{White_Space}`, not `\s`, is the
 * faithful regex equivalent (established convention: see `files.ts`'s
 * `splitWhitespace`, which documents the same divergence). */
const WHITE_SPACE_RUN_END = /\p{White_Space}+$/u;
const ALL_WHITE_SPACE = /^\p{White_Space}*$/u;

function trimEnd(s: string): string {
  return s.replace(WHITE_SPACE_RUN_END, "");
}

function isBlank(s: string): boolean {
  return ALL_WHITE_SPACE.test(s);
}

/** UTF-8 byte length — what Rust's `str::len()` measures, and what
 * `looks_like_noise`'s early-out gate compares against (NOT the codepoint
 * count the rest of that function uses). */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * One codepoint that makes a line read as text rather than as a blob:
 * letters, digits, whitespace, ordinary punctuation, and the rules/pipes real
 * tables are drawn with (ASCII `|`/`+` and the box-drawing block
 * U+2500–U+257F). Ported from `is_wordish` as ONE character class so
 * {@link wordishCount} can scan a line in a single pass — the previous
 * per-codepoint `String.fromCodePoint(cp)` + two `RegExp.test` calls allocated
 * a string and ran two regexes for every character of every ≥40-byte line,
 * which is a main-process freeze on the 20 MB extraction this module's own
 * doc names as the case it exists for.
 *
 * `\p{Alphabetic}`, NOT `\p{L}`: Rust's `char::is_alphanumeric()` is
 * `is_alphabetic() || is_numeric()`, and `is_alphabetic()` is the derived
 * Alphabetic property — which includes Other_Alphabetic combining marks that
 * are category Mn, not L. Hebrew niqqud (U+05B0–U+05BD), Arabic harakat and
 * Indic vowel signs are all in that gap, so `\p{L}` alone judges POINTED
 * HEBREW as up to a third non-wordish and can drop a real line of it as noise.
 */
const WORDISH_CHAR = /[\p{Alphabetic}\p{N}\p{White_Space}|+─-╿.,;:!?'"()\-/&%$€@]/gu;

/** How many of `line`'s codepoints are {@link WORDISH_CHAR} — Rust's
 * `line.chars().filter(|c| is_wordish(*c)).count()`. The `u` flag makes each
 * match one whole codepoint, so an astral character counts once, not twice. */
function wordishCount(line: string): number {
  WORDISH_CHAR.lastIndex = 0;
  let n = 0;
  while (WORDISH_CHAR.exec(line) !== null) {
    n += 1;
  }
  return n;
}

/** Rust's `str::chars().count()` — codepoints, not UTF-16 code units, without
 * materializing the array `Array.from(line).length` would build. */
function isSurrogatePairAt(s: string, index: number): boolean {
  const high = s.charCodeAt(index);
  const low = s.charCodeAt(index + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function codePointCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    n += 1;
    if (isSurrogatePairAt(s, i)) i += 1;
  }
  return n;
}

/** Rust's `str::split_whitespace()`: runs of Unicode whitespace, no empty
 * tokens. Local copy — the same choice `files.ts`'s own `splitWhitespace`
 * documents making, until the two collapse onto one `extraction.ts`. */
function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

/**
 * A long line that is mostly symbols, or that IS one unbroken 80+ char run
 * (base64, hex dumps, minified blobs), is junk for a human-language summary.
 * Ported verbatim from `looks_like_noise` — see its Rust doc comment for why
 * both halves of the check are deliberately narrow (a compact table row and a
 * citation ending in one long URL both used to be misjudged as noise).
 */
function looksLikeNoise(line: string): boolean {
  if (byteLen(line) < 40) {
    return false;
  }
  const total = Math.max(1, codePointCount(line));
  if (wordishCount(line) / total < 0.7) {
    return true;
  }
  // A web address is content, however long. Anything else only counts when it
  // is essentially the entire line.
  return splitWhitespace(line)
    .filter((w) => !w.includes("://"))
    .some((w) => {
      const n = codePointCount(w);
      return n > 80 && n * 10 >= total * 9;
    });
}

/** Close off a collapsed run by writing down what it stood for. Nothing is
 * removed silently: the count is the part that carries the meaning. */
function pushOmittedNote(out: string[], omitted: { n: number }): void {
  if (omitted.n === 0) {
    return;
  }
  const plural = omitted.n === 1 ? "line" : "lines";
  out.push(`[${omitted.n} more identical ${plural} omitted]\n`);
  omitted.n = 0;
}

interface FilterState {
  prevLine: string;
  run: number;
  blankRun: number;
  omitted: { n: number };
}

function retainBlankLine(out: string[], state: FilterState): void {
  pushOmittedNote(out, state.omitted);
  state.blankRun += 1;
  if (state.blankRun === 1) out.push("\n");
}

function isOmittedRepeatedLine(out: string[], state: FilterState, line: string): boolean {
  if (line !== state.prevLine) {
    pushOmittedNote(out, state.omitted);
    state.run = 1;
    return false;
  }
  state.run += 1;
  if (state.run <= MAX_IDENTICAL_RUN) return false;
  state.omitted.n += 1;
  return true;
}

function retainTextLine(out: string[], state: FilterState, line: string): void {
  state.blankRun = 0;
  if (isOmittedRepeatedLine(out, state, line) || looksLikeNoise(line)) return;
  out.push(line);
  out.push("\n");
  state.prevLine = line;
}

/**
 * Drop the low-signal lines a 20 MB extraction is full of — binary/base64
 * junk, runs of blank lines, a boilerplate line repeated past all meaning —
 * so every character the model reads is worth reading. Ported verbatim from
 * `extraction::smart_filter`.
 */
export function smartFilter(text: string): string {
  const out: string[] = [];
  const state: FilterState = { prevLine: "", run: 0, omitted: { n: 0 }, blankRun: 0 };
  for (const rawLine of rustLines(text)) {
    const trimmed = trimEnd(rawLine);
    if (isBlank(trimmed)) {
      retainBlankLine(out, state);
      continue;
    }
    retainTextLine(out, state, trimmed);
  }
  pushOmittedNote(out, state.omitted);
  return out.join("");
}

// ------------------------------------------------------------- byte boundaries

/** A UTF-8 continuation byte (`10xxxxxx`) — never the first byte of a
 * character, so a cut landing on one is never a valid char boundary. */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Rust's (hand-rolled, `str`-stable) `floor_char_boundary`: the largest byte
 * index `<= i` that is a char boundary. */
function floorCharBoundary(buf: Buffer, i: number): number {
  let idx = Math.min(i, buf.length);
  while (idx > 0 && isContinuationByte(buf[idx] as number)) {
    idx -= 1;
  }
  return idx;
}

/** The smallest byte index `>= i` that is a char boundary. */
function ceilCharBoundary(buf: Buffer, i: number): number {
  let idx = Math.min(i, buf.length);
  while (idx < buf.length && isContinuationByte(buf[idx] as number)) {
    idx += 1;
  }
  return idx;
}

function isCharBoundary(buf: Buffer, i: number): boolean {
  return i === 0 || i === buf.length || !isContinuationByte(buf[i] as number);
}

/**
 * Rust's `str::get(start..end)`: the UTF-8 byte slice `[start, end)`, or
 * `null` when the range is out of bounds OR either end is not a char
 * boundary — never a panic, never a silently-corrupted slice. This is what
 * `file_pass.rs`'s map step calls to read one window's text out of the plan's
 * persisted byte spans, and what makes a stale/re-derived plan a clean error
 * ("the file's text no longer matches this pass") instead of a crash or a
 * mis-sliced window.
 */
export function sliceUtf8(text: string, start: number, end: number): string | null {
  const buf = Buffer.from(text, "utf8");
  if (start > end || start > buf.length || end > buf.length) {
    return null;
  }
  if (!isCharBoundary(buf, start) || !isCharBoundary(buf, end)) {
    return null;
  }
  return buf.subarray(start, end).toString("utf8");
}

/** The byte length of `text` — Rust's `str::len()`, i.e. `text_len` in
 * `PassPlan`. NOT `text.length` (UTF-16 code units). */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * ADD-32: partition a whole text into consecutive windows of ~`target` bytes
 * for an exhaustive file pass — every byte lands in exactly one window (plus
 * a small `overlap` carried from the previous window so nothing straddling a
 * cut is lost). Cuts prefer a paragraph break, then a line break, then
 * whitespace, searched in the last 20% of the window; a boundary is never
 * forced onto a pathological wall of text — it just cuts at the byte limit
 * (char-safe). Returns `[start, end)` BYTE spans into `text`; deterministic,
 * so a resumed job re-derives the identical plan from the same text. Ported
 * verbatim from `extraction::partition_windows`.
 */
export function partitionWindows(
  text: string,
  target: number,
  overlap: number
): Array<[number, number]> {
  const buf = Buffer.from(text, "utf8");
  const total = buf.length;
  if (total === 0) {
    return [];
  }
  const boundedTarget = Math.max(target, READ_WINDOW_MIN);
  const boundedOverlap = Math.min(overlap, Math.floor(boundedTarget / 4));
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  while (cursor < total) {
    const start = floorCharBoundary(buf, Math.max(0, cursor - boundedOverlap));
    const hardEnd = ceilCharBoundary(buf, Math.min(cursor + boundedTarget, total));
    let end: number;
    if (hardEnd >= total) {
      end = total;
    } else {
      const seamFrom = floorCharBoundary(
        buf,
        hardEnd - Math.min(Math.floor(boundedTarget / 5), hardEnd - cursor)
      );
      const seamRel = findSeam(buf, seamFrom, hardEnd);
      end = seamRel !== null && seamFrom + seamRel > cursor ? ceilCharBoundary(buf, seamFrom + seamRel) : hardEnd;
    }
    spans.push([start, end]);
    cursor = end;
  }
  return spans;
}

/**
 * Where inside `buf[from, to)` a natural seam ends — a paragraph break, then
 * a line break, then any Unicode whitespace character — searched from the
 * END (Rust's `rfind`), so the cut lands as close to the window's target size
 * as a seam allows. Returns a BYTE offset relative to `from` (one past the
 * seam, matching Rust's `+1`/`+2`), or `null` if the slice has no seam at
 * all — a wall of text (this function's own test) then cuts at the hard byte
 * limit rather than forcing a boundary that doesn't exist.
 */
function findSeam(buf: Buffer, from: number, to: number): number | null {
  const slice = buf.subarray(from, to);
  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph !== -1) {
    return paragraph + 2;
  }
  const newline = slice.lastIndexOf("\n");
  if (newline !== -1) {
    return newline + 1;
  }
  // Unicode whitespace fallback: decode (both ends are already char
  // boundaries, by construction) and find the LAST whitespace character's
  // byte offset — mirroring Rust's `rfind(char::is_whitespace)`, whose `+1`
  // can land mid-character for a multibyte whitespace codepoint and relies
  // on the caller's `ceil_char_boundary` to round forward past it, which
  // {@link partitionWindows} does too.
  const str = slice.toString("utf8");
  let lastMatchStrIndex = -1;
  const re = /\p{White_Space}/gu;
  for (let m = re.exec(str); m !== null; m = re.exec(str)) {
    lastMatchStrIndex = m.index;
  }
  if (lastMatchStrIndex === -1) {
    return null;
  }
  const byteIndex = Buffer.byteLength(str.slice(0, lastMatchStrIndex), "utf8");
  return byteIndex + 1;
}
