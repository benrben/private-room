/**
 * Cut a long script into a fixed number of shots. Ported from
 * `src-tauri/src/commands/shotsplit.rs` (689 lines, read in full, including
 * both its `#[cfg(test)] mod tests` and its `mod episode_tests` — all
 * reproduced in `shotsplitTools.test.ts`, the second against the same fixture
 * file the Rust test reads).
 *
 * NO DEPENDENCY ON `video.rs`: this module was flagged as a possible
 * `video.rs` consumer going in, but the Rust source has no `use` of it and no
 * call into it — confirmed by reading the whole file and grepping
 * `src-tauri/src` for `shotsplit::` and `video::` cross-references. It is
 * self-contained pure text/number logic, no native dependency of any kind, so
 * every piece below is a real, non-stubbed port — the same posture
 * `castparse.ts` took for the same reason.
 *
 * NOT ITS OWN `#[tauri::command]`: `shotsplit.rs` exports only plain
 * `pub(crate)` functions and a struct; the one caller is
 * `commands/story.rs`'s `story_plan_split`, already ported (with a
 * NOT_IMPLEMENTED stub, pending this exact port) as `storyTools.ts`'s
 * `storyPlanSplit`. This batch wires that stub to the real implementation —
 * see the "NOW REAL" note on {@link storyPlanSplit... } in `storyTools.ts`.
 *
 * NOT MODEL-INVOCABLE: grepped `src-tauri/src/commands/agent.rs`'s whole
 * `exec_tool` match-arm list — no `shotsplit`/`split_script`/`script_chunks`
 * arm exists there, and `story_plan_split` itself is registered only in
 * `lib.rs`'s `tauri::generate_handler!` list (a page a person clicks around
 * in), never in a tool schema. Repeated over this migration's
 * `toolSpecs.ts`/`toolSchema.ts`/`execTool.ts` (also grepped): no reference
 * anywhere. Nothing here touches `execTool.ts`.
 *
 * WHY NO MODEL IS ASKED (from the Rust module doc, worth keeping): a
 * five-minute episode is at most twenty 15–20 second shots, and splitting
 * that many ways is a job a model does approximately — it drops a sentence it
 * judged redundant, rewrites another — where this module's whole contract is
 * exact: put the parts back together and every word of the input is still
 * there. A test asserts it (`everyWordOfTheScriptSurvivesTheSplit` below).
 * It is also free, instant, and nothing leaves the Mac.
 *
 * UNICODE FIDELITY: the Rust source counts and indexes by `char` (a Unicode
 * scalar value), not by byte — `piece.chars().count()`, `chars: Vec<char>`,
 * `text.chars().peekable()`. A JS string is UTF-16, so every place the Rust
 * source measures or walks "characters" here goes through {@link charCount}/
 * `Array.from` rather than `.length`/bracket indexing, which would silently
 * split a surrogate pair. `char::is_whitespace` and `str::trim`'s Unicode
 * White_Space definition is matched with a `/\s/u` test ({@link
 * isWhitespaceChar}) — close enough for every character either side's own
 * test suite exercises; JS's built-in `.trim()` is used wherever the Rust
 * source itself calls `str::trim` (both trim near-identical Unicode
 * White_Space sets). `char::to_ascii_uppercase` — ASCII-only, unlike
 * `str::to_uppercase` — is reproduced literally by {@link toAsciiUppercase}
 * rather than substituted with `.toUpperCase()`, so a non-ASCII line (a
 * Hebrew or accented end-matter heading) is left exactly as untouched as the
 * Rust source leaves it.
 *
 * `str::lines()` — splits on `\n`, strips a trailing `\r` from each line, and
 * a trailing `\n` produces no extra empty entry, all of which differ from a
 * plain `.split("\n")` — is reproduced as {@link rustLines} rather than
 * assumed equivalent; `clean` and `trailingHeadings` both depend on getting
 * this exactly right (an extra trailing blank line would flip `is_empty()`
 * checks that decide whether a scene heading is "at the end of a region").
 *
 * `Iterator::max_by_key`'s documented tie-break — "if several elements are
 * equally maximum, the LAST one is returned" — is preserved by {@link
 * argmaxLastTie} using `>=` rather than `>`; the longest-first rebalancing
 * pass in {@link splitScript} depends on breaking ties the same way Rust
 * does or a script with two equally-long sentences could pick a different one
 * to split first than the shipped app would.
 */

import {
  argmaxLastTie,
  asWholeNonNegative,
  charCount,
  clamp,
  divCeil,
  isAsciiDigit,
  isWhitespaceChar,
  rustLines,
  toAsciiUppercase,
  trimEndMatches,
  trimMatches,
  trimStartMatches,
} from "./shotsplitText.js";

/** The most shots one script may be cut into. Twenty minutes of finished
 * video at 15 seconds a shot, and eighty paid generations — far past any real
 * episode, low enough that a mistyped number cannot queue a bill. */
export const MAX_PARTS = 80;

// --------------------------------------------------------------- sentences

/** Where a sentence may end. `…` is included because a script written by
 * hand uses it constantly, and `\n` because a line break in a script is a
 * beat. */
function isBoundary(c: string): boolean {
  return c === "." || c === "!" || c === "?" || c === "…" || c === "\n";
}

function isSentenceTail(c: string): boolean {
  return isBoundary(c) || c === " " || c === "\t" || c === '"' || c === "”";
}

function boundaryTail(chars: readonly string[], from: number) {
  let at = from;
  let text = "";
  while (at < chars.length && isSentenceTail(chars[at]!)) {
    text += chars[at]!;
    at += 1;
  }
  return { at, text };
}

/**
 * Break text into sentences, each keeping its own punctuation and spacing.
 * Ported from `sentences`.
 *
 * Nothing is trimmed away here: every character of the input lands in
 * exactly one piece, which is what makes the round-trip test possible.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  const chars = Array.from(text);
  let at = 0;
  while (at < chars.length) {
    const c = chars[at]!;
    current += c;
    at += 1;
    if (!isBoundary(c)) continue;
    // Run on through the rest of a `?!` or `...` cluster and the space after
    // it, so the next sentence starts at a word rather than at a stray space
    // or a second full stop.
    const tail = boundaryTail(chars, at);
    current += tail.text;
    at = tail.at;
    out.push(current);
    current = "";
  }
  if (current !== "") {
    out.push(current);
  }
  return out;
}

/** `str.split_inclusive(char::is_whitespace)` — each returned piece ends
 * right after (and includes) the whitespace char that ends it, except
 * possibly the last piece if the text has no trailing whitespace. An empty
 * string yields no pieces. */
function splitInclusiveWhitespace(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const c of Array.from(text)) {
    current += c;
    if (isWhitespaceChar(c)) {
      out.push(current);
      current = "";
    }
  }
  if (current !== "") {
    out.push(current);
  }
  return out;
}

/**
 * Split one piece into `n` pieces on word boundaries. Ported from
 * `split_words`.
 *
 * The fallback for a script with fewer sentences than shots — one long
 * unpunctuated paragraph, which is a real way people write. Splitting
 * mid-word would be worse than any imbalance, so word boundaries win over
 * evenness.
 */
export function splitWords(text: string, n: number): string[] {
  if (n <= 1) {
    return [text];
  }
  const words = splitInclusiveWhitespace(text);
  if (words.length <= n) {
    // Fewer words than pieces: give one word each and pad with blanks rather
    // than losing any. A blank shot is visible and editable; a dropped line
    // is neither.
    const out = words.slice();
    while (out.length < n) out.push("");
    return out;
  }
  const per = Math.floor(words.length / n);
  const extra = words.length % n;
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < n; i += 1) {
    // The first `extra` pieces take one more word, so the remainder is
    // spread rather than dumped on the last piece.
    const take = per + (i < extra ? 1 : 0);
    out.push(words.slice(at, at + take).join(""));
    at += take;
  }
  return out;
}

function splitDominatingPiece(piece: string, target: number, parts: number) {
  const length = charCount(piece);
  const count = divCeil(length, target);
  return count > 1 && length > target
    ? splitWords(piece, Math.min(count, parts))
    : [piece];
}

function splitDominatingPieces(
  pieces: string[],
  target: number,
  parts: number,
) {
  const units: string[] = [];
  for (const piece of pieces)
    units.push(...splitDominatingPiece(piece, target, parts));
  return units;
}

function growUnitsToCount(units: string[], parts: number) {
  while (units.length < parts) {
    const index = argmaxLastTie(units.map((unit) => charCount(unit)));
    const longest = units[index]!;
    units.splice(index, 1, ...splitWords(longest, 2));
  }
}

function shouldCloseBeforeUnit(
  current: string,
  unit: string,
  used: number,
  total: number,
  completed: number,
  remainingUnits: number,
  remainingSlots: number,
  parts: number,
) {
  if (current === "" || remainingSlots <= 1) return false;
  if (remainingUnits === remainingSlots) return true;
  const boundary = Math.floor((total * (completed + 1)) / parts);
  const after = used + charCount(unit);
  return Math.abs(used - boundary) <= Math.abs(after - boundary);
}

function packUnits(units: string[], total: number, parts: number) {
  const out: string[] = [];
  let current = "";
  let used = 0;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    if (
      shouldCloseBeforeUnit(
        current,
        unit,
        used,
        total,
        out.length,
        units.length - index,
        parts - out.length,
        parts,
      )
    ) {
      out.push(current);
      current = "";
    }
    current += unit;
    used += charCount(unit);
  }
  return { current, out };
}

function finishParts(out: string[], current: string, parts: number): string[] {
  if (current !== "" || out.length < parts) out.push(current);
  // `packUnits` refuses to close once one slot remains, so it produces at
  // most `parts - 1` completed pieces; the final push above cannot overflow.
  while (out.length < parts) out.push("");
  return out.map((piece) => piece.trim());
}

/**
 * Cut `script` into exactly `parts` shots. Ported from `split_script`.
 *
 * Sentences are packed greedily toward an even share of the total length, but
 * never at the cost of the count: if packing would leave fewer pieces than
 * asked for, the remaining sentences are split by words to make up the
 * difference. The concatenation of the result always equals the input.
 */
export function splitScript(script: string, partsArg: number): string[] {
  // `parts: usize` in Rust — see {@link asWholeNonNegative}.
  const parts = clamp(asWholeNonNegative(partsArg), 1, MAX_PARTS);
  if (parts === 1) return [script.trim()];
  const pieces = sentences(script);
  if (pieces.length === 0) return new Array(parts).fill("");
  const total = pieces.reduce((sum, piece) => sum + charCount(piece), 0);
  const units = splitDominatingPieces(
    pieces,
    Math.max(Math.floor(total / parts), 1),
    parts,
  );
  growUnitsToCount(units, parts);
  const packed = packUnits(units, total, parts);
  return finishParts(packed.out, packed.current, parts);
}

// ------------------------------------------------------------ script chunks

/** One chunk the script itself declared, with the length it asked for. */
export interface Chunk {
  action: string;
  seconds: number;
}

/** `12:34` at `i`, as seconds, plus where it ends — or `null`. Ported from
 * `read_clock`. */
function canReadClockDigit(
  chars: readonly string[],
  at: number,
  digits: number,
) {
  return at < chars.length && digits < 2 && isAsciiDigit(chars[at]!);
}

function readClockDigits(chars: readonly string[], from: number) {
  let at = from;
  let value = 0;
  let digits = 0;
  while (canReadClockDigit(chars, at, digits)) {
    value = value * 10 + Number(chars[at]);
    at += 1;
    digits += 1;
  }
  return { at, digits, value };
}

function hasClockMinutes(
  chars: readonly string[],
  minute: ReturnType<typeof readClockDigits>,
) {
  return (
    minute.digits > 0 && minute.at < chars.length && chars[minute.at] === ":"
  );
}

function validClockSeconds(second: ReturnType<typeof readClockDigits>) {
  return second.digits === 2 && second.value < 60;
}

function readClock(
  chars: readonly string[],
  i: number,
): [seconds: number, end: number] | null {
  const minutes = readClockDigits(chars, i);
  if (!hasClockMinutes(chars, minutes)) return null;
  const seconds = readClockDigits(chars, minutes.at + 1);
  if (!validClockSeconds(seconds)) return null;
  return [minutes.value * 60 + seconds.value, seconds.at];
}

/** Is this the dash in `00:00–00:15`? Any of the three people actually
 * type. */
function isRangeDash(c: string): boolean {
  return c === "-" || c === "–" || c === "—";
}

/** Is this line a scene heading rather than action? Ported from
 * `is_heading`.
 *
 * Headings sit BETWEEN beats in a screenplay, and they are the single most
 * useful line for drawing the shot — `EXT. LUMINA — MARKET DISTRICT — DAY` is
 * the setting, stated exactly. So they are not discarded as markup; they are
 * carried down onto the beat that follows them. */
function isHeading(line: string): boolean {
  const t = line.trim();
  if (t === "") {
    return false;
  }
  if (
    t.startsWith("#") ||
    Array.from(t).every((c) => c === "-" || c === "=" || c === "*")
  ) {
    return true;
  }
  const bare = trimMatches(t, (c) => c === "*" || c === "#" || c === " ");
  return (
    bare.startsWith("INT.") ||
    bare.startsWith("EXT.") ||
    bare.startsWith("INT/EXT")
  );
}

/** A closing line about the document rather than a beat in it. Ported from
 * `is_end_matter`.
 *
 * It rides on the LAST chunk, so without this the final shot's prompt ends
 * with "END OF EPISODE 1 — condensed to 5:00 (300 seconds)" — instructions to
 * a reader, sent to a model as though they were something to draw. */
function isEndMatter(line: string): boolean {
  const bare = toAsciiUppercase(
    trimMatches(line, (c) => c === "*" || c === "#" || c === "_" || c === " "),
  );
  return (
    bare.startsWith("END OF ") || bare === "END" || bare.startsWith("FADE OUT.")
  );
}

/** Does a marker at `i` START its line? Ported from `starts_line`.
 *
 * A real chunk marker opens a beat — `**00:00–00:15** — …` — possibly behind
 * bold stars, a bullet or a quote mark. A range written mid-sentence is PROSE
 * about the episode, not a beat in it. Only what begins a line is a mark. */
function startsLine(chars: readonly string[], i: number): boolean {
  let at = i;
  while (at > 0) {
    const c = chars[at - 1]!;
    if (c === "\n") {
      return true;
    }
    if (!"*-#>|\t _[(".includes(c)) {
      return false;
    }
    at -= 1;
  }
  return true;
}

/** Strip screenplay/markdown decoration from one beat's text. Ported from
 * `clean`. */
function clean(text: string): string {
  let out = "";
  for (const line of rustLines(text)) {
    const t = line.trim();
    if (isHeading(t) || t === "" || isEndMatter(t)) {
      continue;
    }
    if (out !== "") {
      out += " ";
    }
    out += t;
  }
  const stripped = out.replaceAll("**", "").replaceAll("__", "");
  return trimStartMatches(
    stripped,
    (c) => isRangeDash(c) || isWhitespaceChar(c) || c === ":",
  ).trim();
}

/** The heading lines at the end of a region, joined — the scene the NEXT beat
 * happens in. Ported from `trailing_headings`. */
function trailingHeadings(region: string): string {
  const lines = rustLines(region);
  const found: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const t = line.trim();
    if (t === "") continue;
    if (!isHeading(t)) break;
    const bare = trimMatches(t, (c) => c === "#" || c === "*" || c === " ");
    // A rule (`---`) is decoration, not a place.
    if (bare !== "" && !Array.from(bare).every((c) => c === "-" || c === "=")) {
      found.push(bare);
    }
  }
  found.reverse();
  return found.join(" — ");
}

type Marker = [start: number, end: number, seconds: number];
type MarkerRead = { marker?: Marker; next: number };

function skipMarkerSpaces(chars: readonly string[], from: number) {
  let at = from;
  while (at < chars.length && chars[at] === " ") at += 1;
  return at;
}

function readRangeEnd(chars: readonly string[], afterStart: number) {
  const dash = skipMarkerSpaces(chars, afterStart);
  if (dash >= chars.length || !isRangeDash(chars[dash]!)) return null;
  return readClock(chars, skipMarkerSpaces(chars, dash + 1));
}

function markerPrefix(chars: readonly string[], at: number) {
  return (
    isAsciiDigit(chars[at]!) &&
    !(at > 0 && isAsciiDigit(chars[at - 1]!)) &&
    startsLine(chars, at)
  );
}

function readMarker(chars: readonly string[], at: number): MarkerRead {
  if (!markerPrefix(chars, at)) return { next: at + 1 };
  const start = readClock(chars, at);
  if (!start) return { next: at + 1 };
  const end = readRangeEnd(chars, start[1]);
  if (!end) return { next: start[1] };
  return {
    marker: [at, end[1], Math.max(end[0] - start[0], 0)],
    next: end[1],
  };
}

function markersIn(chars: readonly string[]): Marker[] {
  const marks: Marker[] = [];
  let at = 0;
  while (at < chars.length) {
    const read = readMarker(chars, at);
    if (read.marker) marks.push(read.marker);
    at = read.next;
  }
  return marks;
}

function markerSlice(chars: readonly string[], from: number, to: number) {
  return chars.slice(from, to).join("");
}

function chunkAction(pending: string, region: string) {
  const prefix = pending === "" ? "" : `${pending}. `;
  return trimEndMatches(
    `${prefix}${clean(region)}`.trim(),
    (c) => c === ".",
  ).trim();
}

function chunksFromMarkers(chars: readonly string[], marks: Marker[]): Chunk[] {
  let pending = trailingHeadings(markerSlice(chars, 0, marks[0]![0]));
  const out: Chunk[] = [];
  for (let index = 0; index < marks.length; index += 1) {
    const [, bodyFrom, seconds] = marks[index]!;
    const bodyTo =
      index + 1 < marks.length ? marks[index + 1]![0] : chars.length;
    const region = markerSlice(chars, bodyFrom, bodyTo);
    out.push({
      action: chunkAction(pending, region),
      seconds: clamp(seconds, 1, 60),
    });
    pending = trailingHeadings(region);
  }
  return out;
}

/**
 * Read the chunks a script declared for itself, if it declared any. Ported
 * from `script_chunks`.
 *
 * A script written as `**00:00–00:15** — …` has already been broken into
 * shots BY ITS AUTHOR, with the lengths they chose. Re-cutting it by
 * character count would throw that away and produce boundaries in the middle
 * of their beats — which is exactly what makes a storyboard useless. So the
 * author's own marks win whenever there are any, and the length of each shot
 * comes from their own timestamps rather than from one number applied to all
 * twenty (a real script has a 10-second beat in it).
 *
 * `undefined` when fewer than two markers are found — one stray `5:00` in a
 * sentence is not a shot list.
 */
export function scriptChunks(script: string): Chunk[] | undefined {
  const chars = Array.from(script);
  const marks = markersIn(chars);
  return marks.length < 2 ? undefined : chunksFromMarkers(chars, marks);
}

/** How many shots a wanted runtime needs at a given shot length. Ported from
 * `parts_for`. Rounded UP: twenty 15-second shots is 300 seconds, and asking
 * for 305 should give twenty-one rather than quietly losing the last five. */
export function partsFor(totalSeconds: number, perShot: number): number {
  // `total_seconds: u32, per_shot: u32` in Rust — see
  // {@link asWholeNonNegative}.
  const per = Math.max(asWholeNonNegative(perShot), 1);
  return clamp(divCeil(asWholeNonNegative(totalSeconds), per), 1, MAX_PARTS);
}
