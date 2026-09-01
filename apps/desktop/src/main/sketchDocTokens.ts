/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { IS_WHITESPACE, Ink, MAX_LABEL_CHARS, asciiLower, eqIgnoreAsciiCase, inkParse, roundTiesAwayFromZero, rustTrim, rustTrimEnd } from "./sketchDocModel.js";
import { quote } from "./sketchDocRouting.js";
// ---------------------------------------------------------------------------
// The script language
// ---------------------------------------------------------------------------

/**
 * One line's worth of tokens, sorted by what they LOOK like rather than by
 * where they sit — the forgiving half of the parser. `named` is a `Map`, so
 * a line like `rect __proto__=1 …` cannot touch `Object.prototype`.
 */
export interface Tokens {
  nums: number[];
  named: Map<string, string>;
  words: string[];
  refs: string[];
  quoted: string[];
}

/** A named value if present, else the next positional number. */
export function tokenNum(t: Tokens, keys: readonly string[], pos: number): number | null {
  for (const k of keys) {
    const v = t.named.get(k);
    if (v !== undefined) {
      const n = parseNum(v);
      if (n !== null) {
        return n;
      }
    }
  }
  return t.nums[pos] ?? null;
}

export function tokenInk(t: Tokens): Ink | null {
  return namedTokenInk(t) ?? wordTokenInk(t.words);
}

export function namedTokenInk(t: Tokens): Ink | null {
  const named = t.named.get("ink") ?? t.named.get("color") ?? t.named.get("colour");
  return named === undefined ? null : inkParse(named);
}

export function wordTokenInk(words: readonly string[]): Ink | null {
  for (const word of words) {
    const parsed = inkParse(word);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function tokenHasFlag(t: Tokens, flag: string): boolean {
  if (t.words.some((w) => eqIgnoreAsciiCase(w, flag))) {
    return true;
  }
  const v = t.named.get(flag);
  if (v === undefined) {
    return false;
  }
  const lowered = asciiLower(v);
  return lowered === "true" || lowered === "yes" || lowered === "1";
}

export function rawTokenLabel(t: Tokens): string | undefined {
  const quoted = t.quoted[0];
  if (quoted !== undefined) return quoted;
  const label = t.named.get("label");
  if (label !== undefined) return label;
  return t.named.get("text");
}

export function tokenLabel(t: Tokens): string | null {
  const raw = rawTokenLabel(t);
  if (raw === undefined) {
    return null;
  }
  const clamped = clampLabel(raw);
  return clamped === "" ? null : clamped;
}

/** Words that were neither a colour nor a known flag. Reported rather than
 * ignored: a silently dropped token is how `rect 10 10 100 100 bleu` ends up
 * a different colour than the model believes it drew. */
export function tokenStrays(t: Tokens, flags: readonly string[]): string[] {
  return t.words.filter((w) => inkParse(w) === null && !flags.some((f) => eqIgnoreAsciiCase(w, f)));
}

/** Rust's `s.parse::<i64>()`, then `s.parse::<f64>()` filtered to finite and
 * rounded. The float grammar deliberately admits the exponent form Rust's
 * `f64::from_str` admits (`1e5`) and nothing JS's `Number()` would otherwise
 * wave through (hex, `Infinity`, a bare sign, embedded whitespace). */
export const FLOAT_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function parseNum(s: string): number | null {
  const t = rustTrim(s);
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) {
      return n;
    }
  }
  // A model asked for integers still produces `320.0` often enough that
  // rejecting it would be pedantry rather than safety.
  if (FLOAT_LITERAL.test(t)) {
    const f = Number(t);
    return Number.isFinite(f) ? roundTiesAwayFromZero(f) : null;
  }
  return null;
}

export function clampLabel(s: string): string {
  const t = rustTrim(s);
  const chars = [...t];
  if (chars.length <= MAX_LABEL_CHARS) {
    return t;
  }
  return rustTrimEnd(chars.slice(0, MAX_LABEL_CHARS).join(""));
}

export function isRef(tok: string): boolean {
  if (tok.startsWith("#") || tok.startsWith("e")) {
    const rest = tok.slice(1);
    return rest.length > 0 && /^[0-9]+$/.test(rest);
  }
  return false;
}

/** A sentinel marking a token that came from inside quotes — Rust's
 * `'\u{0}'`, one character ordinary script text can never carry. */
export const QUOTE_SENTINEL = "\u0000";

/**
 * Split one line into tokens, honouring quotes.
 *
 * `#` is both a comment marker and the prefix of a back-reference (`#2`), so
 * the digit test decides which. Getting this wrong in either direction is
 * silent: a comment parsed as a reference retargets an edit, and a reference
 * parsed as a comment drops the rest of the line.
 */
export function tokenize(line: string): string[] {
  const state: TokenizerState = { out: [], cur: "", quote: null };
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    const action = consumeTokenCharacter(state, c, chars[i + 1]);
    if (action === "stop") break;
    if (action === "skip") i += 1;
  }
  flushToken(state);
  return state.out;
}

export interface TokenizerState {
  out: string[];
  cur: string;
  quote: string | null;
}

export type TokenAction = "next" | "skip" | "stop";

export function consumeTokenCharacter(state: TokenizerState, current: string, next: string | undefined): TokenAction {
  return state.quote === null
    ? consumeBareTokenCharacter(state, current, next)
    : consumeQuotedTokenCharacter(state, current, next);
}

export function consumeQuotedTokenCharacter(
  state: TokenizerState,
  current: string,
  next: string | undefined
): TokenAction {
  if (current === "\\") return appendQuotedEscape(state, next);
  if (current === state.quote) {
    flushToken(state);
    state.quote = null;
    return "next";
  }
  state.cur += current;
  return "next";
}

export function appendQuotedEscape(state: TokenizerState, next: string | undefined): TokenAction {
  if (next === undefined) return "next";
  state.cur += next;
  return "skip";
}

export function consumeBareTokenCharacter(
  state: TokenizerState,
  current: string,
  next: string | undefined
): TokenAction {
  if (isQuoteCharacter(current)) {
    beginQuotedToken(state, current);
    return "next";
  }
  if (current === "#") return hashTokenAction(state, next);
  if (isTokenSeparator(current)) {
    flushToken(state);
    return "next";
  }
  state.cur += current;
  return "next";
}

export function isQuoteCharacter(value: string): boolean {
  return value === '"' || value === "'";
}

export function beginQuotedToken(state: TokenizerState, quote: string): void {
  flushToken(state);
  state.quote = quote;
  state.cur += QUOTE_SENTINEL;
}

export function hashTokenAction(state: TokenizerState, next: string | undefined): TokenAction {
  if (!referenceDigit(next)) return "stop";
  state.cur += "#";
  return "next";
}

export function referenceDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

export function isTokenSeparator(value: string): boolean {
  return IS_WHITESPACE.test(value) || value === ",";
}

export function flushToken(state: TokenizerState): void {
  if (state.cur === "") return;
  state.out.push(state.cur);
  state.cur = "";
}

export function sortTokens(raw: readonly string[]): Tokens {
  const t: Tokens = { nums: [], named: new Map(), words: [], refs: [], quoted: [] };
  for (const token of raw) sortToken(t, token);
  return t;
}

export function sortToken(tokens: Tokens, token: string): void {
  if (token.startsWith(QUOTE_SENTINEL)) {
    tokens.quoted.push(token.slice(1));
    return;
  }
  const named = namedToken(token);
  if (named !== null) {
    tokens.named.set(...named);
    return;
  }
  if (isRef(token)) {
    tokens.refs.push(token);
    return;
  }
  const number = parseNum(token);
  if (number !== null) {
    tokens.nums.push(number);
    return;
  }
  tokens.words.push(token);
}

export function namedToken(token: string): [string, string] | null {
  const equals = token.indexOf("=");
  if (equals <= 0) return null;
  const key = asciiLower(rustTrim(token.slice(0, equals)));
  return key === "" ? null : [key, rustTrim(token.slice(equals + 1))];
}

/** Canonical verb for a written one, or `""` for an unknown word (which the
 * caller reports with its ORIGINAL spelling). The synonyms are the words
 * models reach for unprompted; accepting them costs one lookup and saves
 * a round trip. */
export const VERB_ALIASES = new Map<string, string>([
  ["rect", "rect"], ["rectangle", "rect"], ["box", "rect"], ["square", "rect"],
  ["ellipse", "ellipse"], ["circle", "ellipse"], ["oval", "ellipse"], ["round", "ellipse"],
  ["text", "text"], ["note", "text"], ["label_at", "text"], ["write", "text"],
  ["arrow", "arrow"], ["line", "line"],
  ["pen", "pen"], ["stroke", "pen"], ["draw", "pen"], ["path", "pen"],
  ["link", "link"], ["connect", "link"], ["join", "link"],
  ["move", "move"], ["nudge", "move"], ["shift", "move"],
  ["label", "label"], ["rename", "label"], ["retitle", "label"],
  ["ink", "ink"], ["color", "ink"], ["colour", "ink"], ["recolor", "ink"], ["recolour", "ink"],
  ["delete", "delete"], ["remove", "delete"], ["erase", "delete"], ["del", "delete"],
  ["clear", "clear"], ["reset", "clear"],
  ["canvas", "canvas"], ["page", "canvas"], ["size", "canvas"],
]);

export function canonVerb(w: string): string {
  return VERB_ALIASES.get(asciiLower(w)) ?? "";
}

/** What a script did, so the tool result can be specific about it. "Drew 6
 * things" is not a receipt; "added e12…e17, moved e3" is. */
export interface ScriptOutcome {
  added: string[];
  changed: string[];
  removed: string[];
  cleared: boolean;
  /** The page size this script set, when it set one. A `canvas` line changes
   * no element, so without it recorded here a script that ONLY resizes reads
   * as "nothing changed": the editor is handed the wider page and the file on
   * disk keeps the old one. */
  resized: [number, number] | null;
  /** One line per statement, in order. The step-by-step trace the editor
   * animates; emitted with `sketch-drawn`, never in the tool result. */
  steps: string[];
  /** Lines this deliberately did not carry out, in words the model can act
   * on. {@link scriptOutcomeSummary} is the WHOLE of what `draw` hands back,
   * so a refusal recorded only in `steps` is one the model never hears — and
   * it sends the same line again on the next turn. */
  refused: string[];
}

export function newScriptOutcome(): ScriptOutcome {
  return { added: [], changed: [], removed: [], cleared: false, resized: null, steps: [], refused: [] };
}

export function scriptOutcomeIsEmpty(out: ScriptOutcome): boolean {
  return (
    out.added.length === 0 &&
    out.changed.length === 0 &&
    out.removed.length === 0 &&
    !out.cleared &&
    out.resized === null
  );
}

export function idList(ids: readonly string[]): string {
  if (ids.length <= 4) {
    return ids.join(", ");
  }
  return `${ids[0]}, ${ids[1]} and ${ids.length - 2} more`;
}

/** A one-line receipt naming real ids. */
export function scriptOutcomeSummary(out: ScriptOutcome): string {
  const parts = scriptOutcomeParts(out);
  // Last, and never suppressed by a change on another line: a script whose
  // fourth line was refused must not read as one that did everything asked.
  parts.push(...out.refused);
  return parts.length === 0 ? "nothing changed" : parts.join(", ");
}

export function scriptOutcomeParts(out: ScriptOutcome): string[] {
  const parts: string[] = [];
  addClearReceipt(parts, out.cleared);
  addResizeReceipt(parts, out.resized);
  addIdReceipt(parts, "added", out.added);
  addIdReceipt(parts, "changed", out.changed);
  addIdReceipt(parts, "deleted", out.removed);
  return parts;
}

export function addClearReceipt(parts: string[], cleared: boolean): void {
  if (cleared) parts.push("cleared the page");
}

export function addResizeReceipt(parts: string[], size: [number, number] | null): void {
  if (size !== null) parts.push(`set the page to ${size[0]}×${size[1]}`);
}

export function addIdReceipt(parts: string[], verb: string, ids: readonly string[]): void {
  if (ids.length > 0) parts.push(`${verb} ${idList(ids)}`);
}

/** A reference to an element: an existing id, or `#n` for the nth element
 * this script creates. */
