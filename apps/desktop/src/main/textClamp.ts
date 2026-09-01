/**
 * Text-clamping and excerpt helpers shared across the agent tool surface.
 *
 * Ported verbatim from `src-tauri/src/commands/agent.rs`: `normalize_for_match`,
 * `floor_boundary`, `clamp_bytes`, `clamp_bytes_marked`, `clamp_marked`,
 * `clamp_chars`, `tail_bytes`, `clamp_words`, `excerpt`.
 *
 * A note on the byte/char split the Rust source draws throughout: Rust's
 * `String` is UTF-8 bytes, so it needs BYTE-safe clamps (`clamp_bytes`,
 * `tail_bytes`, `floor_boundary`) for anything measured in bytes, and
 * CHAR-safe ones (`clamp_chars`, `clamp_words`, `clamp_marked`, `excerpt`) for
 * anything measured in Unicode scalar values. JS strings are UTF-16 code
 * units, which has no direct analogue of a "byte cap" — the byte-oriented
 * functions below operate on `Buffer.byteLength`/UTF-8 byte slicing so the
 * NUMBER each one clamps to means exactly what it means in the Rust source
 * (a cap stated in bytes must still be a byte cap here, or a room's Hebrew
 * content would silently get twice the budget of the same room's English
 * content — see `clamp_chars`'s own doc in the Rust source for the mirror-image
 * bug this guards against). The char-oriented ones use `[...s]` (iteration by
 * Unicode code point) rather than `s.length` (UTF-16 code units), so an
 * astral character is never counted as two or split in half.
 */

// ------------------------------------------------------------- normalize_for_match

/** Hebrew nikud/cantillation code points folded away by {@link normalizeForMatch}
 * — U+0591-05BD, U+05BF, U+05C1-05C2, U+05C4-05C5, U+05C7 (the same ranges
 * `extraction::is_heb_mark` recognizes). */
const HEBREW_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0591, 0x05bd],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
];
const HEBREW_MARK_POINTS = new Set([0x05bf, 0x05c7]);

function inCodePointRange(codePoint: number, [first, last]: readonly [number, number]): boolean {
  return codePoint >= first && codePoint <= last;
}

function isHebMark(cp: number): boolean {
  return HEBREW_MARK_POINTS.has(cp) || HEBREW_MARK_RANGES.some((range) => inCodePointRange(cp, range));
}

const MATCH_CHARACTER_FOLDS: Readonly<Record<string, string>> = {
  "‘": "'",
  "’": "'",
  "ʼ": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "־": "-",
  "ﬁ": "fi",
  "ﬂ": "fl",
};

function foldedMatchCharacter(ch: string): string {
  return isHebMark(ch.codePointAt(0)!) ? "" : (MATCH_CHARACTER_FOLDS[ch] ?? ch);
}

/**
 * Case- and whitespace-insensitive form used to verify quotes the model wants
 * to highlight or edit actually exist in a file. Ported verbatim from
 * `normalize_for_match`. Typographic look-alikes (curly quotes, dashes,
 * ligatures) are folded so extracted text and model quotes can meet in the
 * middle; Hebrew maqaf/nikud are folded for the same reason.
 */
export function normalizeForMatch(s: string): string {
  let folded = "";
  for (const ch of s.toLowerCase()) {
    folded += foldedMatchCharacter(ch);
  }
  return folded.split(/\s+/).filter((w) => w.length > 0).join(" ");
}

// ------------------------------------------------------------------ byte clamps

/**
 * Largest byte index `<= max` that is a UTF-8 char boundary, mirroring Rust's
 * stable stand-in for `str::floor_char_boundary`. `s` is treated as its UTF-8
 * byte encoding; the returned index is a BYTE offset into that encoding, safe
 * to pass to {@link Buffer.prototype.toString} without splitting a multi-byte
 * codepoint.
 */
export function floorBoundary(s: string, max: number): number {
  const buf = Buffer.from(s, "utf8");
  if (max >= buf.length) {
    return buf.length;
  }
  let cut = max;
  // A UTF-8 continuation byte has its top two bits `10`; back up until we
  // land on a lead byte (or byte 0) — the JS equivalent of Rust's
  // `s.is_char_boundary(cut)`.
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) {
    cut -= 1;
  }
  return cut;
}

/** Truncate a string to at most `max` UTF-8 BYTES without ever splitting a
 * char. Ported verbatim from `clamp_bytes`; appends nothing. */
export function clampBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) {
    return s;
  }
  return buf.subarray(0, floorBoundary(s, max)).toString("utf8");
}

/**
 * As {@link clampBytes}, but a cut SAYS SO — `marker` is appended, and the
 * total still fits `max` bytes. Ported verbatim from `clamp_bytes_marked`.
 */
export function clampBytesMarked(s: string, max: number, marker: string): string {
  const originalBytes = Buffer.byteLength(s, "utf8");
  if (originalBytes <= max) {
    return s;
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const out = clampBytes(s, Math.max(0, max - markerBytes));
  return out + marker;
}

/** The LAST `max` UTF-8 bytes of `s`, never splitting a char. Empty when `s`
 * already fits. Ported verbatim from `tail_bytes`. */
export function tailBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) {
    return "";
  }
  let cut = buf.length - max;
  while (cut < buf.length && (buf[cut]! & 0xc0) === 0x80) {
    cut += 1;
  }
  return buf.subarray(cut).toString("utf8");
}

// ------------------------------------------------------------------ char clamps

/**
 * Clamp text a MODEL reads as a complete sentence, marking the cut. Counts
 * Unicode CODE POINTS (`[...s]`), not UTF-16 units, so a Hebrew description
 * gets the same budget as an English one. Ported verbatim from `clamp_marked`.
 */
export function clampMarked(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) {
    return s;
  }
  const keep = Math.max(0, max - 1);
  const cut = chars.slice(0, keep).join("");
  // Don't leave a dangling separator hanging before the marker.
  const trimmed = cut.replace(/\s+$/, "").replace(/[,;:\-(]+$/, "");
  return `${trimmed.replace(/\s+$/, "")}…`;
}

/** Truncate a string to at most `max` Unicode CODE POINTS. Ported verbatim
 * from `clamp_chars`. */
export function clampChars(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) {
    return s;
  }
  return chars.slice(0, max).join("");
}

/**
 * Clip a string to `max` chars at a trailing word boundary when possible, for
 * one-line inventory descriptions. Never splits a char. Ported verbatim from
 * `clamp_words` — INCLUDING the Rust source's own apples-to-oranges
 * comparison: `rfind` returns a UTF-8 BYTE index, compared against `max / 2`,
 * a CHAR count. Measuring the found whitespace as a UTF-8 byte offset here
 * (rather than a UTF-16 index, which would silently disagree with Rust for
 * any non-ASCII text before the cut) reproduces that exact comparison rather
 * than "fixing" it into a different heuristic.
 */
export function clampWords(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) {
    return s;
  }
  let out = chars.slice(0, max).join("");
  const spaceIdx = lastWhitespaceByteIndex(out);
  if (spaceIdx !== -1 && spaceIdx > Math.floor(max / 2)) {
    out = Buffer.from(out, "utf8").subarray(0, spaceIdx).toString("utf8");
  }
  return `${out}…`;
}

/** The UTF-8 byte offset of the last whitespace char in `s`, or -1. Mirrors
 * Rust's `out.rfind(char::is_whitespace)`. */
function lastWhitespaceByteIndex(s: string): number {
  let lastByteIdx = -1;
  let byteIdx = 0;
  for (const ch of s) {
    if (/\s/.test(ch)) {
      lastByteIdx = byteIdx;
    }
    byteIdx += Buffer.byteLength(ch, "utf8");
  }
  return lastByteIdx;
}

/**
 * A char-safe, whitespace-preserving excerpt centered on the first
 * case-insensitive match of `query` (falling back to the first query word,
 * then the text start). Ported verbatim from `excerpt` — INCLUDING its
 * exact latent quirk: the match position is found in the LOWER-CASED text
 * but then used to index the ORIGINAL text (`text[..byte]` in Rust, `text.
 * slice(0, matchIdx)` here), which is only exactly right when lower-casing
 * does not change a string's length — true for ordinary text, occasionally
 * false for a handful of characters (Turkish İ → "i̇"). Preserved rather
 * than "fixed" because this is a behavior-preserving port.
 */
function lowerMatchIndex(lower: string, candidate: string): number | null {
  const needle = candidate.trim().toLowerCase();
  if (needle.length === 0) return null;
  const index = lower.indexOf(needle);
  return index === -1 ? null : index;
}

function queryMatchIndex(lower: string, query: string): number | null {
  const wholeQuery = lowerMatchIndex(lower, query);
  if (wholeQuery !== null) return wholeQuery;
  for (const word of query.split(/\s+/).filter((candidate) => candidate.length > 0)) {
    const match = lowerMatchIndex(lower, word);
    if (match !== null) return match;
  }
  return null;
}

function unmatchedExcerpt(chars: string[], maxChars: number): string {
  const prefix = chars.slice(0, maxChars).join("");
  return chars.length > maxChars ? `${prefix}…` : prefix;
}

function matchedExcerpt(text: string, chars: string[], matchIndex: number, maxChars: number): string {
  // `lower.indexOf` returns a UTF-16 index; convert to a CODE-POINT position
  // so slicing `chars` (already split by code point) lines up, mirroring the
  // Rust source's `text[..byte].chars().count()`.
  const charPos = [...text.slice(0, matchIndex)].length;
  const radius = Math.floor(maxChars / 2);
  const start = Math.max(0, charPos - radius);
  const end = Math.min(start + maxChars, chars.length);
  const before = start > 0 ? "…" : "";
  const after = end < chars.length ? "…" : "";
  return `${before}${chars.slice(start, end).join("")}${after}`;
}

export function excerpt(text: string, query: string, maxChars: number): string {
  const chars = [...text];
  const matchIndex = queryMatchIndex(text.toLowerCase(), query);
  if (matchIndex === null) return unmatchedExcerpt(chars, maxChars);
  return matchedExcerpt(text, chars, matchIndex, maxChars);
}
