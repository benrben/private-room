/**
 * Read a character sheet that already exists into people the room can use.
 * Ported from `src-tauri/src/commands/castparse.rs` (399 lines, read in full,
 * including its `#[cfg(test)] mod tests` — all seven are reproduced in
 * `castparse.test.ts`).
 *
 * PULLED IN AS A DEPENDENCY OF `storyTools.ts` — `commands/story.rs`'s
 * `story_read_cast_file` (both fallback branches) and `story_add_cast_many`
 * need `ParsedMember`/`MAX_FOUND`/`parse_cast`. Unlike `shotsplit.rs` (the one
 * dependency `storyTools.ts` genuinely leaves unported — see its module doc;
 * `media_limits.rs` was the other but has since been ported as
 * `mediaLimits.ts`), this one is small, entirely self-contained pure string
 * logic with no dependency of its own, so it is ported here in full rather
 * than left as a second honest gap.
 *
 * The complaint this answers is a fair one: the room is built on files, the
 * heroes are already written down in one, and the Story tab was asking for all
 * of it to be typed in again. Retyping a document you already have is not data
 * entry, it is a bug with a text box in front of it.
 *
 * **No model is asked.** This is the same choice `shotsplit.rs` makes and for
 * the same reasons: it is free, it is instant, nothing leaves the Mac, and —
 * the part that matters for a character sheet — it cannot quietly invent a
 * hero who is not in the file, or reword a description into something the
 * author did not write. A model would read messier files better; it would also
 * be the only component here capable of hallucinating a cast member.
 *
 * What it can and cannot do is therefore worth stating plainly, because the UI
 * states it too: this recognises the shapes people actually write character
 * sheets in, and when it recognises nothing it says so rather than guessing. A
 * file it cannot read costs one glance, not one wrong cast.
 */

/**
 * The Rust `ParsedMember` struct (`#[serde(rename_all = "camelCase")]`) —
 * someone found in a document, before anyone has agreed to keep them. The same
 * shape goes out to the preview and comes back with the user's edits on it, so
 * the round trip is the point.
 *
 * NOT redeclared: it already exists, camelCased and field-for-field, in
 * `shared/apiTypes.ts` (and `shared/ipc-contract.ts` types the
 * `story_add_cast_many` channel against THAT one), so it is imported from
 * there rather than forked into a second definition — the same choice
 * `organize.ts`/`bulkReport.ts` made for `BulkReport`. Re-exported so a caller
 * of this module needs only this import.
 */
import type { ParsedMember } from "../shared/apiTypes.js";

export type { ParsedMember };

/** A ceiling on one import. A document that yields more than this is being
 * misread — a novel's every capitalised line, say — and importing sixty people
 * nobody asked for is worse than importing none. */
export const MAX_FOUND = 40;

/** Field labels people actually write. Checked longest-first so "backstory" is
 * never matched as "story" with a stray "back" left in the value. */
const LOOK_LABELS: readonly string[] = [
  "appearance",
  "description",
  "looks like",
  "look",
  "looks",
  "wearing",
  "visual",
  "design",
];
const STORY_LABELS: readonly string[] = [
  "backstory",
  "background",
  "biography",
  "history",
  "story",
  "bio",
  "wants",
  "voice",
];

/** `str::split_whitespace()`: splits on runs of Unicode whitespace, yields no
 * empty tokens. `\p{White_Space}`, not `\s` — the same divergence `files.ts`'s
 * own private copy of this helper documents (`\s` omits U+0085 NEL and adds
 * U+FEFF). */
function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

/** `str::trim_matches(pat)` — strip a leading/trailing run of characters
 * satisfying `pred` from BOTH ends. */
function trimMatches(s: string, pred: (c: string) => boolean): string {
  let start = 0;
  let end = s.length;
  while (start < end && pred(s[start]!)) {
    start += 1;
  }
  while (end > start && pred(s[end - 1]!)) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** `str::trim_end_matches(pat)` for a literal string pattern: strip ALL
 * trailing occurrences, repeatedly — not just one. */
function trimEndMatches(s: string, pat: string): string {
  let out = s;
  while (pat.length > 0 && out.endsWith(pat)) {
    out = out.slice(0, out.length - pat.length);
  }
  return out;
}

/** Strip markdown emphasis and list bullets from around a heading. Exported
 * because `castparse.rs`'s own `mod tests` calls it directly. */
export function bare(line: string): string {
  let s = line.trim();
  // Rust's `s.trim_start_matches(lead)` strips EVERY leading occurrence of
  // `lead` (it is a loop over one `char`, not a single strip), so each of the
  // six lead characters is stripped repeatedly before moving to the next.
  for (const lead of ["#", "-", "*", "+", ">", "•"]) {
    while (s.startsWith(lead)) {
      s = s.slice(lead.length);
    }
  }
  s = s.trim();
  // `**Mira**`, `__Mira__`, `*Mira*`
  s = trimMatches(s, (c) => c === "*" || c === "_").trim();
  return trimEndMatches(s, ":").trim();
}

/** Words that name a SECTION rather than a person. Without this, "Characters"
 * and "Cast" become the first two heroes of every document. Exported because
 * `castparse.rs`'s own `mod tests` calls it directly. */
export function isSectionWord(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return [
    "cast",
    "characters",
    "character",
    "people",
    "heroes",
    "dramatis personae",
    "the cast",
    "roles",
    "contents",
    "notes",
    "synopsis",
    "logline",
    "setting",
    "script",
    "scenes",
    "shots",
  ].includes(lower);
}

/**
 * Is this one of the field labels that live INSIDE a person's block?
 *
 * Without this, `Backstory:` on its own line opens a new hero called
 * "Backstory" and steals the rest of the real one's description.
 */
function isFieldLabel(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return LOOK_LABELS.includes(lower) || STORY_LABELS.includes(lower);
}

/** Every word capitalised, and short. Deliberately strict: this is the only
 * place an unmarked line can start a person, so a miss costs a heading the user
 * can add, while a false positive costs a hero made out of a sentence. */
function looksLikeAName(name: string): boolean {
  // `name.len()` in Rust is UTF-8 BYTE length, not char count — matched here
  // via `Buffer.byteLength` rather than `.length` (UTF-16 code units), the same
  // choice `files.ts`'s own chunking helpers make for the same reason.
  if (Buffer.byteLength(name, "utf8") > 40) {
    return false;
  }
  const words = splitWhitespace(name);
  if (words.length === 0 || words.length > 3) {
    return false;
  }
  return words.every((w) => {
    // `c.is_uppercase()` on the first char: a character that HAS a distinct
    // lowercase form and already equals its own uppercase form. A digit or a
    // punctuation mark (upper === lower) is not uppercase, matching Rust.
    const first = [...w][0];
    return first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase();
  });
}

/** `str::split_once(':')` — the head before the FIRST colon and the rest after
 * it, or `null` when there is no colon at all. */
function splitOnce(line: string, sep: string): [string, string] | null {
  const at = line.indexOf(sep);
  if (at < 0) {
    return null;
  }
  return [line.slice(0, at), line.slice(at + sep.length)];
}

function isStyledHeading(raw: string, marker: string): boolean {
  return raw.startsWith(marker) && trimEndMatches(raw, ":").endsWith(marker);
}

function isMarkedHeading(raw: string): boolean {
  if (raw.startsWith("#")) return true;
  return isStyledHeading(raw, "**") || isStyledHeading(raw, "__");
}

function headingName(raw: string): string {
  const split = splitOnce(raw, ":");
  return bare(split === null ? raw : split[0]);
}

function isReservedHeadingName(name: string): boolean {
  return name === "" || isSectionWord(name) || isFieldLabel(name);
}

function headingHasPunctuation(name: string): boolean {
  return name.includes(".") || name.includes(",") || name.includes(";");
}

function isUnmarkedPersonHeading(raw: string, name: string, wordy: boolean, punctuated: boolean): boolean {
  return raw.includes(":") && !wordy && !punctuated && looksLikeAName(name);
}

/**
 * Is this line the start of a new person? Exported because `castparse.rs`'s own
 * `mod tests` calls it directly.
 *
 * Deliberately conservative. A false positive splits one hero into two and puts
 * half their description under a name that is really a sentence, which is a
 * worse and much less obvious failure than missing a heading.
 */
export function isPersonHeading(line: string): boolean {
  const raw = line.trim();
  if (raw === "") return false;
  // A markdown heading is unambiguous — but `# Characters` is a section title,
  // not a person, and is filtered out by the name test below.
  const marked = isMarkedHeading(raw);
  const name = headingName(raw);
  if (isReservedHeadingName(name)) return false;
  // A name is short and has no sentence punctuation in it. Four words covers
  // "Captain Mira Halloran" without swallowing a line of prose.
  const wordy = splitWhitespace(name).length > 4;
  const punctuated = headingHasPunctuation(name);
  if (marked) return !wordy && !punctuated;
  // Unmarked, so the bar is higher: only `Name:` opening a line, and only when
  // the head reads like a name rather than a clause. Without the capitalisation
  // test, "The tide turns: the rope goes slack" opens a hero called "The tide
  // turns" — and the whole scene lands in his description.
  return isUnmarkedPersonHeading(raw, name, wordy, punctuated);
}

/** Split `label: value` when the label is one we know. */
function labelled(line: string, labels: readonly string[]): string | null {
  const split = splitOnce(line, ":");
  if (split === null) {
    return null;
  }
  const [rawHead, rest] = split;
  const head = bare(rawHead).toLowerCase();
  const matches = labels.some((l) => head === l || head.startsWith(`${l} `));
  return matches ? rest.trim() : null;
}

function tidy(lines: readonly string[]): string {
  return lines
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" ")
    .trim();
}

/**
 * Turn one person's lines into what-they-look-like and who-they-are.
 *
 * Labelled fields win when the author wrote them, because then the split is the
 * author's rather than ours. Otherwise the first paragraph is taken as the
 * description and the rest as the story — the order character sheets are
 * conventionally written in, and the only guess in this file.
 */
type BlockField = "looks" | "story";

interface BlockSplitState {
  readonly looks: string[];
  readonly story: string[];
  labelledAny: boolean;
  current: BlockField | null;
}

interface LabelledBlockLine {
  readonly field: BlockField;
  readonly value: string;
}

function splitBlock(block: readonly string[]): [string, string] {
  const state = scanBlock(block);
  if (state.labelledAny) return [tidy(state.looks), tidy(state.story)];
  return splitUnlabelledBlock(state.looks);
}

function scanBlock(block: readonly string[]): BlockSplitState {
  const state: BlockSplitState = { looks: [], story: [], labelledAny: false, current: null };
  for (const line of block) addBlockLine(state, line);
  return state;
}

function addBlockLine(state: BlockSplitState, line: string): void {
  const trimmed = line.trim();
  if (trimmed === "") return addBlockBlank(state);
  const labelledLine = labelledBlockLine(trimmed);
  if (labelledLine !== null) return addLabelledBlockLine(state, labelledLine);
  addBlockContinuation(state, trimmed);
}

function addBlockBlank(state: BlockSplitState): void {
  state.current = null;
  if (!state.labelledAny) state.looks.push("");
}

function labelledBlockLine(line: string): LabelledBlockLine | null {
  const lookValue = labelled(line, LOOK_LABELS);
  if (lookValue !== null) return { field: "looks", value: lookValue };
  const storyValue = labelled(line, STORY_LABELS);
  return storyValue === null ? null : { field: "story", value: storyValue };
}

function addLabelledBlockLine(state: BlockSplitState, line: LabelledBlockLine): void {
  state.labelledAny = true;
  state.current = line.field;
  if (line.value !== "") blockFieldLines(state, line.field).push(line.value);
}

function addBlockContinuation(state: BlockSplitState, line: string): void {
  const field = state.current ?? (state.labelledAny ? "story" : "looks");
  blockFieldLines(state, field).push(line);
}

function blockFieldLines(state: BlockSplitState, field: BlockField): string[] {
  return field === "looks" ? state.looks : state.story;
}

function splitUnlabelledBlock(lines: readonly string[]): [string, string] {
  const splitAt = firstParagraphBreak(lines);
  if (splitAt === null) return [tidy(lines), ""];
  return [tidy(lines.slice(0, splitAt)), tidy(lines.slice(splitAt + 1))];
}

function firstParagraphBreak(lines: readonly string[]): number | null {
  let hasContent = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim() === "") {
      if (hasContent) return index;
    } else {
      hasContent = true;
    }
  }
  return null;
}

/**
 * `str::lines()` — split on `\n`, strip a trailing `\r` from each line, and
 * (unlike `String.prototype.split("\n")`) yield NO trailing empty entry for a
 * string that ends in a final line ending: `"a\n".split("\n")` is `["a", ""]`,
 * while Rust's `"a\n".lines()` is just `["a"]`. Only the SINGLE trailing
 * artifact is dropped — an empty line in the middle of the text is a real line
 * and stays.
 *
 * Load-bearing for {@link parseCast}: a character sheet ending with a trailing
 * newline (nearly all of them) would otherwise push one extra empty line onto
 * the last person's block.
 */
function rustLines(text: string): string[] {
  const parts = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * Read a document into the people it describes.
 *
 * Returns an empty array when it recognises nothing — never a guess. The caller
 * shows that as "this file does not look like a character sheet", which is a
 * fact the reader can act on, unlike one invented hero.
 */
interface CastParseState {
  readonly found: ParsedMember[];
  name: string;
  block: string[];
}

export function parseCast(text: string): ParsedMember[] {
  const state: CastParseState = { found: [], name: "", block: [] };
  for (const line of rustLines(text)) {
    if (collectCastLine(state, line)) return state.found;
  }
  closeCastMember(state);
  return state.found.filter((member) => member.name !== "");
}

function collectCastLine(state: CastParseState, line: string): boolean {
  if (!isPersonHeading(line)) {
    if (state.name !== "") state.block.push(line);
    return false;
  }
  closeCastMember(state);
  if (state.found.length >= MAX_FOUND) return true;
  openCastMember(state, line);
  return false;
}

function closeCastMember(state: CastParseState): void {
  if (state.name === "") {
    state.block = [];
    return;
  }
  const [description, story] = splitBlock(state.block);
  state.found.push({ name: state.name, description, story });
  state.name = "";
  state.block = [];
}

function openCastMember(state: CastParseState, line: string): void {
  const raw = line.trim();
  const split = splitOnce(raw, ":");
  if (split === null) {
    state.name = bare(raw);
    return;
  }
  const [head, rest] = split;
  state.name = bare(head);
  if (rest.trim() !== "") state.block.push(rest.trim());
}
