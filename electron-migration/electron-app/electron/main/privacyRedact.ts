/**
 * PRIV-1/PRIV-2: the mechanical redact/restore engine — the part of the
 * privacy gatekeeper that does not trust a model's judgment. Ported from
 * `src-tauri/src/commands/privacy.rs`'s "Mechanics" section (its module doc
 * plus lines ~36-230 and the `#[cfg(test)]` cases that exercise `Redactor`).
 *
 * Split out of `privacy.ts` because it is the one piece of that Rust module
 * with a genuinely different shape: everything else there is commands, a
 * process-global cache and an async scan loop, while this is pure text
 * transformation with a real algorithmic core worth isolating and testing on
 * its own.
 *
 * THE MATCHING SEMANTICS THIS PORT MUST PRESERVE. Rust builds ONE
 * `aho_corasick::AhoCorasick` per room over every protected string, configured
 * `.ascii_case_insensitive(true)` + `.match_kind(MatchKind::LeftmostLongest)`,
 * and calls `find_iter` for NON-OVERLAPPING matches — PLUS an explicit
 * lower/upper spelling appended for every rule containing a non-ASCII letter
 * ({@link caseVariants}). Four properties of that configuration are
 * load-bearing, and a regex alternation or a per-rule `String.replaceAll` loop
 * would get at least one of them wrong:
 *
 *   1. LEFTMOST-LONGEST, not leftmost-first and not pattern-list order. At
 *      every position, among every protected string that could start there,
 *      the LONGEST wins — so a room protecting both "Ben" and "Ben Reich"
 *      redacts "Ben Reich" as ONE entity, never as "[Person B] Reich".
 *      (Insertion order deciding this would be `MatchKind::LeftmostFirst`, a
 *      different mode the Rust source deliberately does not use.)
 *   2. NON-OVERLAPPING: a match consumes its span, and the search resumes at
 *      its end.
 *   3. SUBSTRING, not whole-word. A protected "Ben" turns "benchmark" into
 *      "[Person B]chmark" — ugly, and recorded as a known cost in the Rust
 *      source's own AUDIT comment rather than "fixed", because word
 *      boundaries do not only tidy text, they HIDE LESS: "5551234" would stop
 *      matching inside "+9725551234" and "BenReich" would stop matching
 *      unspaced. `substring matching over-redacts but never leaks` in this
 *      file's tests pins both halves of that trade.
 *   4. ASCII-ONLY case folding, PLUS explicit case spellings for anything with
 *      a non-ASCII letter. `ascii_case_insensitive` folds A-Z/a-z and nothing
 *      else, while the sidecar's Python half of the same door uses `re.I`,
 *      which folds every script — so without {@link caseVariants} the two
 *      halves of one door would disagree about the same name, and the
 *      disagreement fell on this side (the "what the cloud sees" preview and
 *      the outbound connector masking let the real spelling through).
 *
 * THIS PORT'S ENGINE. Node has no built-in Aho-Corasick and this workspace has
 * no package with these exact semantics, so the matcher is implemented here as
 * a plain trie over the (already case-widened) pattern set, walked fresh from
 * every not-yet-consumed position: follow trie edges while the ASCII-folded
 * input keeps matching a stored prefix, remembering the DEEPEST terminal node
 * passed. That remembered depth is by construction the longest pattern
 * matching AT that position (there is only one path through a trie for one
 * string, so "keep walking, remember the last accepting node" cannot rank a
 * shorter pattern over a longer one), and fixing the start to the smallest
 * unconsumed index makes "leftmost" automatic. Properties (1) and (2) are
 * therefore structural here, not a consequence of how the rule list happens to
 * be ordered — which is why this port, unlike the Rust source, does not need
 * its defensive longest-first `sort_by` at all.
 *
 * DELIBERATELY NOT ADDED: failure links (the real `aho-corasick` crate's
 * performance trick, which turns "restart at every position" into "never
 * revisit a byte"). A room's protected set is small — a personal block list
 * plus what the local scanner found — and the walk already skips instantly
 * past any position whose first character opens no pattern, so the worst case
 * is O(text x longest pattern) on inputs measured in one document at a time.
 * Getting the LeftmostLongest SELECTION provably right matters far more here
 * than constant factors, and failure links could be added later without
 * changing one exported signature.
 *
 * NOT REPRODUCED, ON PURPOSE: Unicode normalization. `aho-corasick` compares
 * raw bytes, so an NFC "é" (U+00E9) and an NFD "e"+U+0301 are different
 * strings to it and are different strings here too, on both sides of the
 * ocean. `an NFC and an NFD spelling ... do not cross-match` pins that as a
 * matched property, not a bug to paper over by normalizing text nobody asked
 * this module to normalize.
 */

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

/** The shortest a protected item may be, in CODE POINTS.
 *
 * Anything shorter is dropped by the redactor: a one-character rule matches
 * somewhere in almost every sentence and would turn the whole payload into
 * placeholders. Enforced both where an item is ADDED (`db-host/privacy.ts`'s
 * `addPrivacyEntity`, and `privacy.ts`'s `addPrivacyBlock`) and where it is
 * USED (the {@link Redactor} constructor's own filter) — ONE definition, so
 * Settings can never list an item as protected that the redactor then silently
 * discards. Ported from `commands::privacy::MIN_PROTECTED_CHARS`. */
export const MIN_PROTECTED_CHARS = 2;

/** Can this text be enforced mechanically? Counts CODE POINTS (`Array.from`),
 * matching Rust's `.chars().count()` — a single Hebrew or accented letter is
 * ONE character but TWO UTF-8 bytes, so a byte count would accept exactly what
 * the error message promises is rejected, and `.length` (UTF-16 units) would
 * miscount an astral character the other way. Ported from
 * `commands::privacy::is_protectable`. */
export function isProtectable(text: string): boolean {
  return Array.from(text.trim()).length >= MIN_PROTECTED_CHARS;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** What the door did on one turn — feeds the chat indicator. Ported from
 * `PrivacyReport` (`#[derive(Default)]`, `rename_all = "camelCase"`);
 * field-for-field the `AskPrivacy` wire shape in `shared/apiTypes.ts`. */
export interface PrivacyReport {
  entitiesHidden: number;
  replacements: number;
  imagesBlocked: number;
}

/** A fresh all-zero report — the stand-in for `PrivacyReport::default()`. */
export function emptyPrivacyReport(): PrivacyReport {
  return { entitiesHidden: 0, replacements: 0, imagesBlocked: 0 };
}

/** One protected rule, or one direction of the redact/restore table: (search
 * text, what it becomes). Rust's `(String, String)`, spelled as a named pair
 * so call sites read. */
export type PrivacyRule = readonly [text: string, becomes: string];

// ---------------------------------------------------------------------------
// ASCII folding + case variants
// ---------------------------------------------------------------------------

/** Every character of `s` is ASCII — Rust's `str::is_ascii()`. */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
}

/** Fold ONE UTF-16 code unit exactly the way `ascii_case_insensitive` folds a
 * byte: A-Z -> a-z, everything else (including every non-ASCII character, and
 * either half of a surrogate pair) untouched. Applied to both the pattern set
 * at build time and the haystack at match time, so it never has to be undone
 * to read a replacement back out. */
function foldAscii(ch: string): string {
  const code = ch.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : ch;
}

/** A rule's extra spellings for the matcher: nothing for plain ASCII (the
 * matcher folds that itself), and the lower/upper Unicode forms otherwise,
 * deduplicated against the original and each other — a caseless script like
 * Hebrew yields `toLowerCase() === toUpperCase() === real`, so both are
 * dropped and no variant is added. Ported verbatim from
 * `commands::privacy::case_variants`. */
function caseVariants(real: string): string[] {
  if (isAscii(real)) {
    return [];
  }
  const out: string[] = [];
  for (const variant of [real.toLowerCase(), real.toUpperCase()]) {
    if (variant !== real && !out.includes(variant)) {
      out.push(variant);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The trie matcher
// ---------------------------------------------------------------------------

interface TrieNode {
  /** A `Map`, not an object: keys here are attacker-influenceable text (a
   * character out of a room's own documents), and an object would resolve
   * `"__proto__"`/`"constructor"` against `Object.prototype` instead of
   * against this node's real children. `Map` has no such inherited keys — the
   * same reasoning `mcpConfig.ts`'s `ownMap`/`hasOwn` helpers spell out for
   * connector names. */
  children: Map<string, TrieNode>;
  /** What a pattern ENDING exactly here becomes, or `null` for a node that is
   * only a prefix of something longer. Holding the replacement in the node
   * (rather than an index into a parallel table) removes the question of what
   * a pattern-list reordering would mean entirely. */
  becomes: string | null;
}

function newNode(): TrieNode {
  return { children: new Map(), becomes: null };
}

/** The longest pattern matching at one position: how far it reaches (in UTF-16
 * code units, so it can be handed straight to `String.prototype.slice`) and
 * what it becomes. */
interface TrieMatch {
  length: number;
  becomes: string;
}

/**
 * The compiled matcher over one direction's pattern list (real -> placeholder,
 * or placeholder -> real) — the stand-in for one `Option<AhoCorasick>`.
 * {@link build} answers `null` for an empty pattern list (Rust's `build_ac`
 * returning `None`), so a caller with nothing to match never walks a trie.
 *
 * INDEXED BY UTF-16 CODE UNIT, not by code point: patterns and haystack are
 * walked the same way, so a surrogate pair simply matches as its two units,
 * and a match can never START mid-pair (that would need a pattern beginning
 * with a lone low surrogate, which no room text produces). Doing it this way
 * keeps the whole substitution on plain string slices — no per-character array
 * of the input, which for a book-sized `extracted_text` is the difference
 * between one string walk and allocating one JS string per character.
 */
class PatternMatcher {
  private readonly root: TrieNode = newNode();

  private constructor() {}

  static build(patterns: readonly PrivacyRule[]): PatternMatcher | null {
    if (patterns.length === 0) {
      return null;
    }
    const matcher = new PatternMatcher();
    for (const [text, becomes] of patterns) {
      matcher.insert(text, becomes);
    }
    return matcher;
  }

  private insert(pattern: string, becomes: string): void {
    let node = this.root;
    for (let i = 0; i < pattern.length; i++) {
      const key = foldAscii(pattern[i]!);
      let next = node.children.get(key);
      if (next === undefined) {
        next = newNode();
        node.children.set(key, next);
      }
      node = next;
    }
    // Two DIFFERENT patterns can fold to one trie path only if they are ASCII
    // case variants of each other, which `findEntityIgnoringCase` already
    // prevents from arising out of real room data. The FIRST insertion keeps
    // the slot, and rules are inserted before their own case variants, so the
    // canonical spelling wins that tie — an arbitrary but deterministic
    // tie-break `aho-corasick` also has to make somehow.
    if (node.becomes === null) {
      node.becomes = becomes;
    }
  }

  /** The longest pattern matching `text` starting EXACTLY at `start`, or
   * `null` if none does. */
  longestMatchAt(text: string, start: number): TrieMatch | null {
    let node = this.root;
    let bestLength = -1;
    let bestBecomes: string | null = null;
    for (let i = start; i < text.length; i++) {
      const next = node.children.get(foldAscii(text[i]!));
      if (next === undefined) {
        break;
      }
      node = next;
      if (node.becomes !== null) {
        bestLength = i - start + 1;
        bestBecomes = node.becomes;
      }
    }
    return bestLength <= 0 ? null : { length: bestLength, becomes: bestBecomes! };
  }
}

/**
 * Walk `text` left to right, replacing every leftmost-longest, non-overlapping
 * match, and (when `report` is given) counting replacements and DISTINCT
 * entities hidden — keyed by REPLACEMENT text, not by pattern, so a name
 * hidden in two capitalisations is still one name hidden (Rust's
 * `HashSet<&str>` over `table[..].1`). Ported from `Redactor::sub`.
 */
function substitute(matcher: PatternMatcher | null, text: string, report: PrivacyReport | null): string {
  if (matcher === null) {
    return text;
  }
  let out = "";
  let last = 0;
  let i = 0;
  let replacements = 0;
  const seen = new Set<string>();
  while (i < text.length) {
    const m = matcher.longestMatchAt(text, i);
    if (m === null) {
      i += 1;
      continue;
    }
    out += text.slice(last, i) + m.becomes;
    replacements += 1;
    seen.add(m.becomes);
    i += m.length;
    last = i;
  }
  if (last === 0) {
    // Nothing matched (a match at 0 would have advanced `last` past it), so
    // there is nothing to add to `report` either — hand the input straight
    // back rather than rebuilding an identical string. The `masked !== text`
    // question callers like `maskOutboundWeb` ask compares string VALUES, so
    // this is a shortcut, never the reason that comparison works.
    return text;
  }
  out += text.slice(last);
  if (report !== null) {
    report.replacements += replacements;
    report.entitiesHidden += seen.size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The JSON walk
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Store `value` under `key` as an OWN data property.
 *
 * PROTOTYPE-POLLUTION GUARD, the same class of bug the MCP marketplace batch
 * found and fixed next door (`mcpConfig.ts`'s `setOwn`/`hasOwn`/`ownMap`): a
 * plain `out[key] = value` invokes `Object.prototype`'s `__proto__` SETTER for
 * that one key. Nothing is stored, the key silently vanishes from the result,
 * and (when the value is an object) the rebuilt result quietly inherits from
 * attacker-supplied data instead. The values walked here are a cloud model's
 * tool-call arguments and a connector's reply — untrusted JSON whose
 * round-trip through this door must not make anything worse — and
 * `"__proto__"` survives `JSON.parse` as an ordinary own property, so this
 * rebuild is exactly where reading one would turn into corrupting the walk's
 * own output. `defineProperty` never consults the prototype chain, so every
 * key, `"__proto__"` included, lands as an ordinary enumerable own property —
 * which is what `serde_json::Map` does on the Rust side.
 */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Walk an arbitrary JSON value, replacing every STRING leaf via `f` and
 * leaving every other value (number, boolean, null) untouched — the shared
 * recursion of `Redactor::restore_value`/`redact_value`. */
function mapJsonStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") {
    return f(v);
  }
  if (Array.isArray(v)) {
    return v.map((x) => mapJsonStrings(x, f));
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    // `Object.entries` reads OWN enumerable keys only — an inherited member is
    // not part of this value and must not be copied into the rebuilt one.
    for (const [k, x] of Object.entries(v)) {
      setOwn(out, k, mapJsonStrings(x, f));
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// The Redactor
// ---------------------------------------------------------------------------

/**
 * The compiled redact/restore engine over one room's entity map. Ported from
 * `commands::privacy::Redactor`.
 *
 * KNOWN, DELIBERATE over-redaction — see property (3) in this file's module
 * doc. It is a recorded cost, not an oversight.
 */
export class Redactor {
  private readonly ruleCount: number;
  private readonly redactMatcher: PatternMatcher | null;
  private readonly restoreMatcher: PatternMatcher | null;
  private readonly longestRedactPattern: number;

  /**
   * `rules` is (real, placeholder) as the room stores them. Anything under the
   * character floor, or with a blank placeholder, is dropped here as well as
   * at the two write-time entrances — a `Redactor` can still be constructed
   * directly from an arbitrary list (every test does exactly that), and the
   * door's floor may not depend on who built the list.
   */
  constructor(rulesIn: readonly PrivacyRule[]) {
    const rules = rulesIn.filter(([real, placeholder]) => isProtectable(real) && placeholder.trim() !== "");
    this.ruleCount = rules.length;

    // The matcher's table is the rules PLUS their non-ASCII case spellings,
    // each rule inserted immediately before its own variants (see `insert`).
    // No longest-first sort: unlike the Rust source's defensive one, nothing
    // here reads pattern order — the trie walk is what prefers "Ben Reich"
    // over "Ben", whichever went in first.
    const redactPatterns: PrivacyRule[] = [];
    for (const [real, placeholder] of rules) {
      redactPatterns.push([real, placeholder]);
      for (const variant of caseVariants(real)) {
        redactPatterns.push([variant, placeholder]);
      }
    }
    this.redactMatcher = PatternMatcher.build(redactPatterns);
    this.longestRedactPattern = redactPatterns.reduce(
      (longest, [real]) => Math.max(longest, real.length),
      0,
    );

    // Restore is built from the CANONICAL rules only: a placeholder must come
    // back as the room's own spelling, never a case variant of it.
    this.restoreMatcher = PatternMatcher.build(rules.map(([real, placeholder]) => [placeholder, real] as const));
  }

  /** real -> placeholder (counted into `report`). */
  redact(text: string, report: PrivacyReport): string {
    return substitute(this.redactMatcher, text, report);
  }

  /** placeholder -> real (uncounted — restoring is not hiding). */
  restore(text: string): string {
    return substitute(this.restoreMatcher, text, null);
  }

  /** Restore placeholders anywhere in a JSON value: the cloud model asks to
   * search "[Person A]", and the room tool has to see the name. Ported from
   * `Redactor::restore_value`. */
  restoreValue(v: unknown): unknown {
    return mapJsonStrings(v, (s) => this.restore(s));
  }

  /** Redact real strings anywhere in a JSON value — the mirror of
   * {@link restoreValue}, used to mask a tool call's arguments before they
   * leave the Mac to a REMOTE connector. Ported from `Redactor::redact_value`. */
  redactValue(v: unknown, report: PrivacyReport): unknown {
    return mapJsonStrings(v, (s) => this.redact(s, report));
  }

  /** Build a bounded real -> placeholder redactor for token streams.
   *
   * A protected value may cross any delta boundary. Redacting each delta on
   * its own would release both halves unchanged. The stream holds only starts
   * that still need more input before leftmost-longest matching can decide. */
  stream(report: PrivacyReport): StreamRedactor {
    return new StreamRedactor(
      this.redactMatcher,
      this.longestRedactPattern,
      report,
    );
  }

  /** No usable rule survived the floor — the room has nothing to mask
   * mechanically. Ported from `Redactor::is_empty`. */
  isEmpty(): boolean {
    return this.ruleCount === 0;
  }
}

/** Stream-safe counterpart to {@link Redactor.redact}.
 *
 * Constructed by {@link Redactor.stream}, which owns the compiled matcher and
 * knows the true longest case-expanded pattern. */
export class StreamRedactor {
  private buffer = "";
  private readonly seen = new Set<string>();

  constructor(
    private readonly matcher: PatternMatcher | null,
    private readonly longestPattern: number,
    private readonly report: PrivacyReport,
  ) {}

  /** Redact one delta and return only text that is safe to display now. */
  feed(delta: string): string {
    if (this.matcher === null || this.longestPattern === 0) return delta;
    this.buffer += delta;
    // A pattern beginning before this index already has its full maximum
    // possible length in the buffer, so future input cannot change its match.
    const decidedStarts = this.buffer.length - this.longestPattern + 1;
    return decidedStarts > 0 ? this.drain(decidedStarts) : "";
  }

  /** Release the final bounded suffix at the end of a stream. */
  flush(): string {
    if (this.matcher === null || this.buffer === "") return "";
    return this.drain(Number.POSITIVE_INFINITY);
  }

  /** Drop an unfinished suffix when the UI starts a replacement model round. */
  reset(): void {
    this.buffer = "";
  }

  private drain(decidedStarts: number): string {
    let out = "";
    let consumed = 0;
    while (consumed < this.buffer.length && consumed < decidedStarts) {
      const match = this.matcher!.longestMatchAt(this.buffer, consumed);
      if (match === null) {
        out += this.buffer[consumed]!;
        consumed += 1;
        continue;
      }
      out += match.becomes;
      consumed += match.length;
      this.report.replacements += 1;
      if (!this.seen.has(match.becomes)) {
        this.seen.add(match.becomes);
        this.report.entitiesHidden += 1;
      }
    }
    this.buffer = this.buffer.slice(consumed);
    return out;
  }
}
