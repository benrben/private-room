/** Cohesive extraction from editMatch.ts; the facade preserves its public API. */
import { closestSnippet } from "./fileTools.js";
import { clampBytes } from "./textClamp.js";
import { fuzzyFind, normalizeNeedle } from "./editMatchFuzzy.js";
import { findSectionRangeHtml, htmlEscape, htmlReplaceText, stripHtml } from "./editMatchHtml.js";
import { allNeedsExactError, EditError, type EditMethod, type EditRefinements, hasPositionalRefinement, MAX_FUZZY_BYTES, multiOccurrenceError, nonUtf8Error, refinementNotFoundError, refinementsEmpty, sectionNotFoundError, strictUtf8OrNull, tooLargeForFuzzyError } from "./editMatchCore.js";
import { unrefinedTextEdit } from "./editMatchPlans.js";


/** `content.matches(needle).count()` — non-overlapping literal occurrences.
 * An empty needle counts as zero here (Rust would report one match per
 * character boundary); every caller guards `old_text` non-empty first, and
 * zero is the answer that routes an empty quote to the honest "not found"
 * message rather than a nonsensical ambiguity count. */
export function countLiteralOccurrences(content: string, needle: string): number {
  return needle === "" ? 0 : content.split(needle).length - 1;
}


/** `content.match_indices(needle)` — every non-overlapping literal
 * occurrence's `[start, endExclusive)`. */
function matchIndicesLiteral(content: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (needle === "") {
    return out;
  }
  let idx = 0;
  for (;;) {
    const found = content.indexOf(needle, idx);
    if (found === -1) {
      return out;
    }
    out.push([found, found + needle.length]);
    idx = found + needle.length;
  }
}


/** Real UTF-8 byte length — what Rust's `str::len()` reports, and the unit
 * {@link MAX_FUZZY_BYTES} is expressed in. */
export function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}


// ------------------------------------------------------------- markdown sections

/** One ATX (`#`-prefixed) Markdown heading: `#`-count = level (1-6), a space
 * required after the hashes (CommonMark's rule — keeps a code comment like
 * `#!/usr/bin/env` from being misread as a heading). Ported from
 * `edit_match::MarkdownHeading`. */
interface MarkdownHeading {
  readonly level: number;
  readonly text: string;
  /** Where this heading's own line starts — where the PRECEDING section
   * ends. */
  readonly lineStart: number;
  /** Right after this heading's line — where the section it introduces
   * begins. */
  readonly sectionStart: number;
}


/** `content.split_inclusive('\n')` — each piece keeps its own trailing `\n`;
 * the last piece has none if the string doesn't end with one, and there is no
 * empty final piece for a string that does. */
function splitInclusiveByNewline(content: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const idx = content.indexOf("\n", start);
    if (idx === -1) {
      if (start < content.length) {
        lines.push(content.slice(start));
      }
      return lines;
    }
    lines.push(content.slice(start, idx + 1));
    start = idx + 1;
  }
}


type SectionRangeResult =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly headings: string[] };


/**
 * The Markdown counterpart to `html_edit::find_section_range`. Same
 * same-or-higher-level rule (a sub-heading doesn't end its parent's section).
 * Does NOT skip fenced code blocks — a `#` comment inside a fence could be
 * misread as a heading; a narrow but real limitation carried over from the
 * Rust source rather than silently "fixed" in the port. Ported from
 * `edit_match::find_markdown_section_range`.
 */
function findMarkdownSectionRange(content: string, section: string): SectionRangeResult {
  const headings = markdownHeadings(content);
  const needle = normalizeNeedle(section).join("");
  const idx = headings.findIndex((h) => normalizeNeedle(h.text).join("") === needle);
  return markdownSectionResult(content, headings, idx);
}


function markdownHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let pos = 0;
  for (const line of splitInclusiveByNewline(content)) {
    addMarkdownHeading(headings, line, pos);
    pos += line.length;
  }
  return headings;
}


function addMarkdownHeading(headings: MarkdownHeading[], line: string, position: number): void {
  const trimmed = line.replace(/[\r\n]+$/, "");
  const hashes = markdownHashCount(trimmed);
  if (!validMarkdownHeading(trimmed, hashes)) return;
  headings.push({ level: hashes, text: trimmed.slice(hashes).trim(), lineStart: position, sectionStart: position + line.length });
}


function markdownHashCount(line: string): number {
  let hashes = 0;
  while (hashes < line.length && line[hashes] === "#") hashes += 1;
  return hashes;
}


function validMarkdownHeading(line: string, hashes: number): boolean {
  const after = line[hashes];
  return hashes >= 1 && hashes <= 6 && (after === " " || after === "\t");
}


function markdownSectionResult(content: string, headings: MarkdownHeading[], index: number): SectionRangeResult {
  if (index === -1) return { ok: false, headings: headings.map((heading) => heading.text) };
  const heading = headings[index]!;
  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
  return { ok: true, start: heading.sectionStart, end: next === undefined ? content.length : next.lineStart };
}


// ------------------------------------------------------------ refined resolution

/** What every `computeEditBytes` branch produces. */
export interface ComputedEdit {
  readonly bytes: Buffer;
  readonly count: number;
  readonly method: EditMethod;
}


/**
 * The plain text path's fuzzy fallback, scoped to one Markdown section.
 * `section` narrows WHERE to look; it is not a claim that the quote is
 * byte-perfect, so a quote the forgiving matcher would have found in the whole
 * file must still be found inside the section — otherwise scoping an edit to a
 * heading silently turned the tolerant matcher off. `fuzzyFind` reports
 * positions relative to the section, so the hit is offset by the section's
 * start before splicing. Ported from `edit_match::fuzzy_in_section`.
 */
function fuzzyInSection(
  realName: string,
  content: string,
  range: { start: number; end: number },
  oldText: string,
  newText: string,
  all: boolean | undefined,
  section: string
): ComputedEdit {
  if (utf8Length(content) > MAX_FUZZY_BYTES) {
    throw new EditError(tooLargeForFuzzyError(realName), "not_found");
  }
  if (all === true) {
    throw new EditError(allNeedsExactError(oldText, realName), "all_needs_exact");
  }
  const scope = content.slice(range.start, range.end);
  const found = fuzzyFind(scope, oldText);
  if (found.kind === "unique") {
    const out = content.slice(0, range.start + found.start) + newText + content.slice(range.start + found.end);
    return { bytes: Buffer.from(out, "utf8"), count: 1, method: "fuzzy" };
  }
  if (found.kind === "ambiguous") {
    throw new EditError(
      `That text appears in ${found.count} places in the "${section}" section of "${realName}" ` +
        `with slightly different spacing or punctuation. Include more surrounding text ` +
        `so it matches exactly one place.`,
      "ambiguous"
    );
  }
  const hint = closestSnippet(scope, oldText);
  const hintNote = hint !== null ? ` The closest text there is: "${clampBytes(hint, 200)}".` : "";
  throw new EditError(
    `Could not find that text in the "${section}" section of "${realName}". ` +
      `Copy it from that section, or drop section to search the whole file.${hintNote}`,
    "not_found"
  );
}


/**
 * Resolve `old_text` against `content` using `prefixContext`/`suffixContext`/
 * `occurrence` instead of the ambiguity-or-unique guard the plain path uses. A
 * POSITIONAL refinement requires an EXACT (non-fuzzy) quote — it is meant to
 * narrow candidates the model already found via search_room/open_file, not to
 * also absorb typographic drift, and combining both would make a
 * wrong-candidate pick unfalsifiable. `section` carries no such claim: on its
 * own it only says WHERE to look, so a miss there falls through to
 * {@link fuzzyInSection}. Enumerates every candidate span up front, which is
 * why this needs its own function rather than reusing `fuzzyFind`'s
 * unique/ambiguous/not-found shape. Ported from
 * `edit_match::resolve_with_refinements`.
 */
function resolveWithRefinements(
  realName: string,
  content: string,
  oldText: string,
  newText: string,
  all: boolean | undefined,
  refine: EditRefinements
): ComputedEdit {
  const sectionRange = markdownRefinementRange(realName, content, refine.section);
  const candidates = refinedCandidates(content, oldText, sectionRange);
  if (candidates.length === 0) return noRefinedCandidates(realName, content, sectionRange, oldText, newText, all, refine);
  const filtered = contextFilteredCandidates(realName, content, candidates, refine);
  return refinedCandidateResult(realName, content, oldText, newText, all, refine, filtered);
}


function markdownRefinementRange(realName: string, content: string, section: string | undefined): { start: number; end: number } | null {
  if (section === undefined) return null;
  const found = findMarkdownSectionRange(content, section);
  if (!found.ok) throw new EditError(sectionNotFoundError(section, realName, found.headings), "not_found");
  return { start: found.start, end: found.end };
}


function refinedCandidates(content: string, oldText: string, range: { start: number; end: number } | null): Array<[number, number]> {
  return matchIndicesLiteral(content, oldText).filter(([start, end]) => withinRange(start, end, range));
}


function withinRange(start: number, end: number, range: { start: number; end: number } | null): boolean {
  return range === null || (start >= range.start && end <= range.end);
}


function noRefinedCandidates(
  realName: string, content: string, range: { start: number; end: number } | null, oldText: string, newText: string,
  all: boolean | undefined, refine: EditRefinements,
): ComputedEdit {
  if (range !== null && refine.section !== undefined && !hasPositionalRefinement(refine)) {
    return fuzzyInSection(realName, content, range, oldText, newText, all, refine.section);
  }
  throw new EditError(refinementNotFoundError(realName, refine), "not_found");
}


function contextFilteredCandidates(
  realName: string, content: string, candidates: Array<[number, number]>, refine: EditRefinements,
): Array<[number, number]> {
  if (refine.prefixContext === undefined && refine.suffixContext === undefined) return candidates;
  const filtered = candidates.filter(([start, end]) => candidateMatchesContext(content, start, end, refine));
  if (filtered.length === 0) throw new EditError(contextMismatchMessage(realName), "not_found");
  return filtered;
}


function candidateMatchesContext(content: string, start: number, end: number, refine: EditRefinements): boolean {
  const prefix = refine.prefixContext;
  const suffix = refine.suffixContext;
  return (prefix === undefined || content.slice(0, start).endsWith(prefix)) && (suffix === undefined || content.slice(end).startsWith(suffix));
}


function contextMismatchMessage(realName: string): string {
  return `old_text matches in "${realName}", but the surrounding text you gave ` +
    "doesn't appear next to it there. Copy prefix_context/suffix_context exactly as they appear too, or drop them.";
}


function refinedCandidateResult(
  realName: string, content: string, oldText: string, newText: string, all: boolean | undefined,
  refine: EditRefinements, candidates: Array<[number, number]>,
): ComputedEdit {
  if (refine.occurrence !== undefined) return occurrenceCandidateResult(realName, content, newText, refine, candidates);
  if (candidates.length === 1) return replaceCandidate(content, candidates[0]!, newText);
  return multipleRefinedCandidates(realName, content, oldText, newText, all, candidates);
}


function occurrenceCandidateResult(
  realName: string, content: string, newText: string, refine: EditRefinements, candidates: Array<[number, number]>,
): ComputedEdit {
  const occurrence = refine.occurrence!;
  if (!validOccurrence(occurrence, candidates.length)) throw occurrenceRangeError(realName, refine, candidates.length);
  return replaceCandidate(content, candidates[occurrence - 1]!, newText);
}


function validOccurrence(occurrence: number, count: number): boolean {
  return Number.isInteger(occurrence) && occurrence >= 1 && occurrence <= count;
}


function occurrenceRangeError(realName: string, refine: EditRefinements, count: number): EditError {
  const hasContext = refine.prefixContext !== undefined || refine.suffixContext !== undefined;
  const contextNote = hasContext ? " with that surrounding text" : "";
  return new EditError(`old_text matches ${count} place(s) in "${realName}"${contextNote}; occurrence must be between 1 and ${count}.`, "not_found");
}


function multipleRefinedCandidates(
  realName: string, content: string, oldText: string, newText: string, all: boolean | undefined, candidates: Array<[number, number]>,
): ComputedEdit {
  if (all === true) return replaceAllCandidates(content, newText, candidates);
  const message = multiOccurrenceError(oldText, candidates.length, realName, true).replace(
    "Include more surrounding text",
    "Add prefix_context/suffix_context, pass occurrence, or include more surrounding text",
  );
  throw new EditError(message, "ambiguous");
}


function replaceAllCandidates(content: string, newText: string, candidates: Array<[number, number]>): ComputedEdit {
  let out = content;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const [start, end] = candidates[index]!;
    out = out.slice(0, start) + newText + out.slice(end);
  }
  return { bytes: Buffer.from(out, "utf8"), count: candidates.length, method: "exact_all" };
}


function replaceCandidate(content: string, candidate: [number, number], newText: string): ComputedEdit {
  const [start, end] = candidate;
  return { bytes: Buffer.from(content.slice(0, start) + newText + content.slice(end), "utf8"), count: 1, method: "exact" };
}


// ------------------------------------------------------------- compute_edit_bytes

/** The HTML branch of `computeEditBytes`, ported verbatim. */
export function computeEditBytesHtml(
  realName: string,
  bytes: Uint8Array,
  oldText: string,
  newText: string,
  all: boolean | undefined,
  refine: EditRefinements
): ComputedEdit {
  const content = editableUtf8(realName, bytes);
  const scope = htmlEditScope(realName, content, refine.section);
  const replaced = htmlReplacement(realName, scope, oldText, htmlEscape(newText));
  assertHtmlReplacementIsUnambiguous(realName, oldText, all, replaced.count);
  return htmlComputedEdit(content, scope.range, replaced.html, replaced.count);
}


function editableUtf8(realName: string, bytes: Uint8Array): string {
  const content = strictUtf8OrNull(bytes);
  if (content === null) throw new EditError(nonUtf8Error(realName), "wrong_type");
  return content;
}


interface HtmlEditScope { readonly content: string; readonly range: { start: number; end: number } | null; readonly note: string; }


function htmlEditScope(realName: string, content: string, section: string | undefined): HtmlEditScope {
  if (section === undefined) return { content, range: null, note: "" };
  const found = findSectionRangeHtml(content, section);
  if (!found.ok) throw new EditError(sectionNotFoundError(section, realName, found.headings), "not_found");
  const range = { start: found.start, end: found.end };
  return { content: content.slice(range.start, range.end), range, note: ` in the "${section}" section` };
}


function htmlReplacement(realName: string, scope: HtmlEditScope, oldText: string, newText: string) {
  const replaced = htmlReplaceText(scope.content, oldText, newText);
  if (replaced.ok) return replaced;
  const hint = closestSnippet(stripHtml(scope.content), oldText);
  const hintNote = hint === null ? "" : ` The closest text on the page is: "${clampBytes(hint, 200)}".`;
  throw new EditError(`Could not find that exact text in "${realName}"${scope.note}. Copy it exactly, including spacing and punctuation.${hintNote}`, "not_found");
}


function assertHtmlReplacementIsUnambiguous(realName: string, oldText: string, all: boolean | undefined, count: number): void {
  if (count > 1 && all !== true) throw new EditError(multiOccurrenceError(oldText, count, realName, all !== undefined), "ambiguous");
}


function htmlComputedEdit(content: string, range: { start: number; end: number } | null, replacement: string, count: number): ComputedEdit {
  const html = range === null ? replacement : content.slice(0, range.start) + replacement + content.slice(range.end);
  return { bytes: Buffer.from(html, "utf8"), count, method: "html" };
}


/** The plain-text-extension branch of `computeEditBytes`, ported verbatim. */
export function computeEditBytesText(
  realName: string,
  bytes: Uint8Array,
  oldText: string,
  newText: string,
  all: boolean | undefined,
  refine: EditRefinements
): ComputedEdit {
  const content = editableUtf8(realName, bytes);
  if (!refinementsEmpty(refine)) return resolveWithRefinements(realName, content, oldText, newText, all, refine);
  return unrefinedTextEdit(realName, content, oldText, newText, all);
}
