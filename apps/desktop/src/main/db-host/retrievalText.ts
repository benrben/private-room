import { stripHebrewMarks } from "./files.js";

/** Remove fenced viewer-markup payloads from conversational text. */
export function stripMarkupBlocks(content: string): string {
  let out = content;
  for (const tag of ["```boxes", "```annotation"]) {
    let start = out.indexOf(tag);
    while (start !== -1) {
      const after = out.slice(start + tag.length);
      const end = after.indexOf("```");
      out = (end !== -1 ? out.slice(0, start) + after.slice(end + 3) : out.slice(0, start)).trim();
      start = out.indexOf(tag);
    }
  }
  return out;
}

/** Shared search stopwords used by retrieval and moonshot indexing. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "is", "to", "of", "in", "on", "at", "it", "be", "as", "by", "an", "or", "if", "we", "do",
  "so", "up", "my", "me", "no", "us", "am", "he",
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
  "out", "get", "has", "him", "his", "how", "new", "now", "see", "two", "way", "who", "did",
  "its", "let", "say", "she", "too", "use", "that", "with", "have", "this", "will", "your",
  "from", "they", "know", "want", "been", "good", "much", "some", "time", "what", "when",
  "which", "about", "would", "there", "their", "were", "them", "then", "than", "into", "also",
  "just", "like", "over", "such", "only", "most", "make", "after", "where", "does", "please",
  "could", "should", "tell",
]);

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Unicode equivalent of Rust's split on non-alphanumeric characters. */
export const NOT_ALPHANUMERIC = /[^\p{Alphabetic}\p{N}]+/u;

/** Normalize a question into de-duplicated, meaningful search terms. */
export function questionTerms(question: string): string[] {
  const stripped = stripHebrewMarks(question);
  const words = stripped.toLowerCase().split(NOT_ALPHANUMERIC);
  const terms: string[] = [];
  for (const word of words) {
    if (byteLen(word) >= 2 && !STOPWORDS.has(word) && !terms.includes(word)) {
      terms.push(word);
    }
    if (terms.length >= 24) {
      break;
    }
  }
  return terms;
}

/** Build a safely quoted FTS5 match expression from normalized terms. */
export function ftsMatchExpr(terms: Iterable<string>): string | null {
  const quoted: string[] = [];
  for (const t of terms) {
    const q = `"${t.replaceAll('"', "")}"`;
    if (q.length > 2) {
      quoted.push(q);
    }
  }
  return quoted.length === 0 ? null : quoted.join(" OR ");
}

function fold(ch: string): string {
  return ch === "ς" ? "σ" : ch;
}

function foldString(s: string): string {
  return Array.from(s).map(fold).join("");
}

function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

function lastIndexAtOrBefore(starts: readonly number[], at: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] as number) <= at) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return Math.max(0, lo - 1);
}

interface NormalizedSnippetText {
  readonly chars: string[];
  readonly lower: string;
  readonly starts: number[];
}

function normalizedSnippetText(haystack: string): NormalizedSnippetText {
  const chars = Array.from(splitWhitespace(haystack).join(" "));
  const starts: number[] = [];
  let lower = "";
  for (const character of chars) {
    starts.push(lower.length);
    lower += foldString(character.toLowerCase());
  }
  return { chars, lower, starts };
}

function snippetMatch(lower: string, candidate: string): number | null {
  const folded = foldString(candidate.trim().toLowerCase());
  if (folded === "") return null;
  const index = lower.indexOf(folded);
  return index === -1 ? null : index;
}

function firstSnippetMatch(lower: string, candidates: readonly string[]): number | null {
  for (const candidate of candidates) {
    const index = snippetMatch(lower, candidate);
    if (index !== null) return index;
  }
  return null;
}

function selectiveSnippetTerms(needle: string): string[] {
  return [...questionTerms(needle)].sort((left, right) => Array.from(right).length - Array.from(left).length);
}

function snippetMatchPosition(lower: string, needle: string): number | null {
  const phrase = snippetMatch(lower, needle);
  if (phrase !== null) return phrase;
  const selective = firstSnippetMatch(lower, selectiveSnippetTerms(needle));
  return selective ?? firstSnippetMatch(lower, splitWhitespace(needle));
}

function unmatchedSnippet(chars: readonly string[], radius: number): string {
  const preview = chars.slice(0, radius * 2).join("");
  return chars.length > radius * 2 ? `${preview}…` : preview;
}

function matchedSnippet(chars: readonly string[], starts: readonly number[], at: number, radius: number): string {
  const position = lastIndexAtOrBefore(starts, at);
  const start = Math.max(0, position - radius);
  const end = Math.min(position + radius, chars.length);
  return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("")}${end < chars.length ? "…" : ""}`;
}

/** Extract a whitespace-normalized snippet around the best query match. */
export function makeSnippet(haystack: string, needle: string, radius: number): string {
  const text = normalizedSnippetText(haystack);
  const at = snippetMatchPosition(text.lower, needle);
  return at === null
    ? unmatchedSnippet(text.chars, radius)
    : matchedSnippet(text.chars, text.starts, at, radius);
}
