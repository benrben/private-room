/**
 * Port of `src-tauri/src/extraction/pdf_quality.rs` — "is a PDF's extracted
 * text good enough to index?"
 *
 * THE PROBLEM (the Rust source's own doc): `pdf-extract` is a reader with no
 * layout model. It walks glyphs in content-stream order, which is right for a
 * single column of prose and wrong for everything else. On a two-column paper
 * it interleaves the columns line by line; on a table it runs the cells
 * together; on a page whose font has no usable ToUnicode map it emits the
 * glyph indices as letters. In every one of those cases it returns text and
 * reports success — so the room indexed the mess, RAG retrieved the mess, and
 * the model answered from the mess with nothing anywhere saying the page had
 * not been read. OCR already existed as a fallback but only for the empty
 * case, which catches only the image-only scan; everything above returns
 * *something*. This module is the missing question — "is this text, or is it
 * noise?" — asked of the output before it is trusted.
 *
 * THE SEAM (verified against the Rust, not yet wired — `commands/files.rs` is
 * its own migration item): `should_reread_with_ocr` gates OCR at both import
 * paths (`files.rs:128-130` and `:315-317`, `degraded_pdf && needs_ocr`,
 * alongside `ocrTools.ts`'s already-ported `isOcrCandidate`), and `choose`
 * picks the winner once Vision has run (`files.rs:525`, inside `run_ocr_job`).
 * The "chosen text equals what was already stored, so write nothing" check
 * lives in that caller in Rust and stays there here.
 */

/** A page of prose has a space roughly every 5-6 characters. Below this the
 * extractor has run words together — the ToUnicode/width failure — and the
 * result tokenizes into nothing a search can match. */
const MIN_SPACE_RATIO = 0.06;

/** Above this share of replacement characters, the encoding was not
 * understood. */
const MAX_REPLACEMENT_RATIO = 0.02;

/** Below this share of characters being letters/digits/space/punctuation, the
 * output is symbol soup rather than language. */
const MIN_READABLE_RATIO = 0.8;

/** Text shorter than this is judged only on "is it empty" — a title page or a
 * cover legitimately carries a dozen words, and ratios over 40 characters are
 * noise themselves. Exported because the Rust test pins the floor in both
 * directions and the ported test does too. */
export const MIN_SAMPLE = 200;

/** Sample the head rather than walk a 900-page book: the failure modes are
 * properties of the document's fonts and layout, not of one page. */
const SAMPLE_LIMIT = 20_000;

/** Why a PDF's extracted text was rejected. Carried so the decision can be
 * logged and tested by name rather than as a bare bool. Ported from
 * `PdfTextFault`, whose variants carry no serde rename, so the Rust names
 * transliterate to snake_case — the same choice `editGate.ts` makes for
 * `EditVerdict::NoAnswer` -> `"no_answer"`. */
export type PdfTextFault =
  /** Nothing at all — the classic image-only scan. */
  | "empty"
  /** Words run together: almost no spaces. */
  | "no_word_breaks"
  /** The font's character map wasn't understood. */
  | "undecodable"
  /** Mostly symbols rather than language. */
  | "not_language";

/** Judge extracted PDF text. `null` means "good enough to index". Ported from
 * `pdf_quality::fault_in`, early returns and check order included — the order
 * is load-bearing, since an undecodable reading is reported as such rather
 * than as the symbol soup it also is. */
export function faultIn(text: string): PdfTextFault | null {
  const trimmed = rustTrim(text);
  if (trimmed === "") {
    return "empty";
  }
  const sample = takeChars(trimmed, SAMPLE_LIMIT);
  if (sample.length < MIN_SAMPLE) {
    return null;
  }
  const total = sample.length;

  const replacement = sample.filter((c) => c === "\u{fffd}").length;
  if (replacement / total > MAX_REPLACEMENT_RATIO) {
    return "undecodable";
  }

  const readable = sample.filter(
    (c) => isAlphanumeric(c) || isUnicodeWhitespace(c) || isAsciiPunctuation(c)
  ).length;
  if (readable / total < MIN_READABLE_RATIO) {
    return "not_language";
  }

  // Word breaks: any whitespace counts, since a reader that emits one glyph
  // per line still separates its words.
  const spaces = sample.filter((c) => isUnicodeWhitespace(c)).length;
  if (spaces / total < MIN_SPACE_RATIO) {
    return "no_word_breaks";
  }
  return null;
}

/** True when this text should be replaced by an OCR pass over the rendered
 * pages. Named for the decision it drives. Ported from
 * `pdf_quality::should_reread_with_ocr`. */
export function shouldRereadWithOcr(text: string): boolean {
  return faultIn(text) !== null;
}

/**
 * Which of two readings of the same document to keep. Ported from
 * `pdf_quality::choose`.
 *
 * OCR is not automatically better: on a clean, well-encoded PDF the embedded
 * text is exact while Vision can misread a ligature or a digit. So the
 * extracted text is kept unless it is FAULTY, and the OCR is kept only if it
 * is not faulty itself — a scan of a blank page must not replace real text
 * with nothing.
 */
export function choose(extracted: string | null, ocr: string | null): string | null {
  if (extracted !== null && ocr !== null) return chooseBetweenReadings(extracted, ocr);
  return extracted ?? ocr;
}

function chooseBetweenReadings(extracted: string, ocr: string): string {
  if (faultIn(extracted) === null) return extracted;
  if (faultIn(ocr) === null) return ocr;
  return longerFaultyReading(extracted, ocr);
}

function longerFaultyReading(extracted: string, ocr: string): string {
  // Both are poor: keep whichever has more readable content, so a partial
  // reading still beats nothing. Rust weighs that with `str::len()`, which
  // is UTF-8 BYTES — so a Hebrew reading counts double against an ASCII one
  // and `.length` (UTF-16 code units) would flip the winner outright.
  return utf8Length(rustTrim(ocr)) > utf8Length(rustTrim(extracted)) ? ocr : extracted;
}

// ------------------------------------------------------------- char classes

/** Rust's `char::is_alphanumeric()` = `is_alphabetic() || is_numeric()`. The
 * first is Unicode's derived `Alphabetic` property, which is WIDER than the
 * `\p{L}` general category: it also covers the combining marks that carry
 * vowels in Hebrew, Arabic and the Indic scripts. Scored as `\p{L}`, a
 * vocalized Hebrew page reads ~0.61 readable and gets re-OCR'd on every
 * import. `is_numeric()` is the `N` category, i.e. `\p{Number}`. */
const ALPHANUMERIC_RE = /^[\p{Alphabetic}\p{Number}]$/u;

/** Unicode's `White_Space` property — the same property Rust's
 * `char::is_whitespace()` reads. Deliberately NOT JS's `\s`, which both
 * misses U+0085 (NEL) and adds U+FEFF (a BOM). Duplicated locally rather than
 * imported from `editMatchExtraction.ts`, matching this port's convention of
 * keeping a small pure predicate self-contained. */
const WHITE_SPACE_RE = /^\p{White_Space}$/u;

/** Rust's `char::is_ascii_punctuation()` — exactly the 32 ASCII punctuation
 * characters, never anything outside ASCII. A Unicode class such as `\p{P}`
 * would be a WIDER predicate: it would score curly quotes and em dashes as
 * readable on their own, loosening the ratio this guard depends on. */
const ASCII_PUNCTUATION_RE = /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/u;

function isAlphanumeric(c: string): boolean {
  return ALPHANUMERIC_RE.test(c);
}

function isUnicodeWhitespace(c: string): boolean {
  return WHITE_SPACE_RE.test(c);
}

function isAsciiPunctuation(c: string): boolean {
  return ASCII_PUNCTUATION_RE.test(c);
}

const WS_PREFIX_RE = /^\p{White_Space}+/u;
const WS_SUFFIX_RE = /\p{White_Space}+$/u;

/** Rust's `str::trim()`, which cuts exactly the `White_Space` property.
 * `String.prototype.trim()` is a DIFFERENT set: it leaves U+0085 (so an
 * extraction of nothing but page separators reads as content rather than as
 * the scan case) and it eats U+FEFF (so a BOM-only reading reads as empty and
 * queues an OCR pass Rust never queues). Duplicated from `sketchDoc.ts`'s
 * `rustTrim` rather than imported, per this port's convention. */
function rustTrim(s: string): string {
  return s.replace(WS_PREFIX_RE, "").replace(WS_SUFFIX_RE, "");
}

/** `text.chars().take(limit)`. A `for...of` step over a JS string yields one
 * Unicode scalar value per step, exactly as Rust's `chars()` does, and stops
 * at the cap rather than materializing a 900-page book first. */
function takeChars(text: string, limit: number): string[] {
  const out: string[] = [];
  for (const c of text) {
    if (out.length >= limit) {
      break;
    }
    out.push(c);
  }
  return out;
}

/** Real UTF-8 byte length — what Rust's `str::len()` reports. */
function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
