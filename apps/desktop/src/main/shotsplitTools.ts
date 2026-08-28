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

/** The most shots one script may be cut into. Twenty minutes of finished
 * video at 15 seconds a shot, and eighty paid generations — far past any real
 * episode, low enough that a mistyped number cannot queue a bill. */
export const MAX_PARTS = 80;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Rust's `as usize`/`as u32` — a SATURATING, TRUNCATING float-to-integer cast
 * (`NaN` → 0, negatives → 0, fractions truncated toward zero).
 *
 * `split_script(script: &str, parts: usize)` and `parts_for(total_seconds:
 * u32, per_shot: u32)` cannot be handed a `NaN`, a negative or a fraction:
 * Rust's type system already did this cast at the caller (`story.rs`'s
 * `(minutes.max(0.0) * 60.0).round() as u32`). TypeScript's `number` carries
 * all three straight into the body, and each does real damage:
 *
 *   - `splitScript("", NaN)` reached `new Array(NaN)` and threw
 *     `RangeError: Invalid array length` — a CRASH where Rust returns `[""]`.
 *   - `partsFor(NaN, 15)` answered `NaN` instead of Rust's `1`.
 *   - `splitScript(s, 2.7)` produced THREE shots; a `usize` cannot be 2.7.
 *
 * This is reachable, not theoretical: `storyPlanSplit` passes its own
 * `minutes`/`secondsEach` through to both, and Electron's IPC
 * (`structuredClone`) can carry a `NaN` from the renderer where Tauri's JSON
 * argument decoding never could. Doing the cast HERE, at the two entry points
 * whose Rust signatures are integer-typed, is the faithful translation of
 * that signature rather than a new invention.
 */
function asWholeNonNegative(n: number): number {
  return Number.isNaN(n) ? 0 : Math.max(0, Math.trunc(n));
}

/** `usize::div_ceil` for the two call sites below (both non-negative in every
 * real call: `total_seconds`/`per_shot` are u32 in Rust, and this file's own
 * callers never pass negatives). */
function divCeil(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/** `str.chars().count()` — a Unicode scalar-value count, NOT `string.length`
 * (which counts UTF-16 code units and would over-count anything outside the
 * BMP). */
function charCount(s: string): number {
  return Array.from(s).length;
}

/** `char::is_whitespace` (Unicode White_Space) — see the module doc's
 * "UNICODE FIDELITY" note. */
function isWhitespaceChar(c: string): boolean {
  return /\s/u.test(c);
}

/** `c.is_ascii_digit()`. */
function isAsciiDigit(c: string): boolean {
  return c.length === 1 && c >= "0" && c <= "9";
}

/** `char::to_ascii_uppercase` applied to a whole string, character by
 * character — ASCII letters only, everything else (accents, Hebrew, an em
 * dash) passed through untouched. Deliberately NOT `.toUpperCase()`, which
 * would uppercase far more than Rust's source does. */
function toAsciiUppercase(s: string): string {
  return Array.from(s)
    .map((c) => {
      const code = c.codePointAt(0)!;
      return code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : c;
    })
    .join("");
}

/** `str::trim_matches(pred)` — trims from BOTH ends. */
function trimMatches(s: string, pred: (c: string) => boolean): string {
  const chars = Array.from(s);
  let start = 0;
  let end = chars.length;
  while (start < end && pred(chars[start]!)) start += 1;
  while (end > start && pred(chars[end - 1]!)) end -= 1;
  return chars.slice(start, end).join("");
}

/** `str::trim_start_matches(pred)` — trims from the START only. */
function trimStartMatches(s: string, pred: (c: string) => boolean): string {
  const chars = Array.from(s);
  let start = 0;
  while (start < chars.length && pred(chars[start]!)) start += 1;
  return chars.slice(start).join("");
}

/** `str::trim_end_matches(pred)` — trims from the END only. */
function trimEndMatches(s: string, pred: (c: string) => boolean): string {
  const chars = Array.from(s);
  let end = chars.length;
  while (end > 0 && pred(chars[end - 1]!)) end -= 1;
  return chars.slice(0, end).join("");
}

/**
 * `str::lines()` — see the module doc's "UNICODE FIDELITY" paragraph for why
 * this is not a plain `.split("\n")`: an empty string has ZERO lines (not
 * one), a trailing `\n` produces no extra empty entry, and each line has any
 * trailing `\r` stripped.
 */
function rustLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) {
    parts.pop();
  }
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** The index of the maximum value in `values`, ties won by the LAST index —
 * `Iterator::max_by_key`'s documented tie-break, matched with `>=`. Callers
 * must pass a non-empty array (mirrors the Rust call site's own
 * `.expect("non-empty")`). */
function argmaxLastTie(values: readonly number[]): number {
  let bestIndex = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i]! >= bestValue) {
      bestValue = values[i]!;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// --------------------------------------------------------------- sentences

/** Where a sentence may end. `…` is included because a script written by
 * hand uses it constantly, and `\n` because a line break in a script is a
 * beat. */
function isBoundary(c: string): boolean {
  return c === "." || c === "!" || c === "?" || c === "…" || c === "\n";
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
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    current += c;
    i += 1;
    if (!isBoundary(c)) continue;
    // Run on through the rest of a `?!` or `...` cluster and the space after
    // it, so the next sentence starts at a word rather than at a stray space
    // or a second full stop.
    while (i < chars.length) {
      const next = chars[i]!;
      if (isBoundary(next) || next === " " || next === "\t" || next === '"' || next === "”") {
        current += next;
        i += 1;
      } else {
        break;
      }
    }
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
  if (parts === 1) {
    return [script.trim()];
  }

  const pieces = sentences(script);
  if (pieces.length === 0) {
    return new Array(parts).fill("");
  }

  const total = pieces.reduce((sum, p) => sum + charCount(p), 0);
  const target = Math.max(Math.floor(total / parts), 1);

  // 1. Break up any sentence long enough to dominate a shot on its own.
  //
  // Every shot is the SAME number of seconds, so the text in each should be
  // about the same size. Left whole, a 400-character paragraph took one
  // 15-second shot while three ten-character lines took the other three —
  // the same screen time for forty times the content. Sentence integrity is
  // worth a lot, but not that.
  const units: string[] = [];
  for (const piece of pieces) {
    const length = charCount(piece);
    const n = divCeil(length, Math.max(target, 1));
    if (n > 1 && length > target) {
      units.push(...splitWords(piece, Math.min(n, parts)));
    } else {
      units.push(piece);
    }
  }

  // 2. Still not enough to go round? Split the LONGEST repeatedly, so one
  //    enormous paragraph is broken up before a short aside is cut in half.
  while (units.length < parts) {
    const index = argmaxLastTie(units.map((p) => charCount(p)));
    const longest = units[index]!;
    units.splice(index, 1);
    const halves = splitWords(longest, 2);
    units.splice(index, 0, ...halves);
  }

  // 3. Pack toward the ideal boundaries, choosing for each unit whether
  //    closing BEFORE it lands nearer the boundary than closing after it.
  //    Packing greedily "until full" instead overshot every time — a shot
  //    would close only once it was already past its share, so each one ran
  //    long and the last took whatever was left.
  const out: string[] = [];
  let current = "";
  let used = 0;

  units.forEach((unit, index) => {
    const remainingUnits = units.length - index;
    const remainingSlots = parts - out.length;
    if (current !== "" && remainingSlots > 1) {
      // Every remaining unit needs its own shot, or the count fails.
      const mustClose = remainingUnits === remainingSlots;
      const boundary = Math.floor((total * (out.length + 1)) / parts);
      const after = used + charCount(unit);
      const closingNow = Math.abs(used - boundary);
      const closingLater = Math.abs(after - boundary);
      if (mustClose || closingNow <= closingLater) {
        out.push(current);
        current = "";
      }
    }
    current += unit;
    used += charCount(unit);
  });
  if (current !== "" || out.length < parts) {
    out.push(current);
  }
  // Belt and braces: the count is the contract the caller builds rows from.
  while (out.length > parts) {
    const tail = out.pop() ?? "";
    if (out.length > 0) {
      out[out.length - 1] = out[out.length - 1]! + tail;
    }
  }
  while (out.length < parts) {
    out.push("");
  }
  return out.map((p) => p.trim());
}

// ------------------------------------------------------------ script chunks

/** One chunk the script itself declared, with the length it asked for. */
export interface Chunk {
  action: string;
  seconds: number;
}

/** `12:34` at `i`, as seconds, plus where it ends — or `null`. Ported from
 * `read_clock`. */
function readClock(chars: readonly string[], i: number): [seconds: number, end: number] | null {
  let at = i;
  let minutes = 0;
  let digits = 0;
  while (at < chars.length && isAsciiDigit(chars[at]!) && digits < 2) {
    minutes = minutes * 10 + Number(chars[at]);
    at += 1;
    digits += 1;
  }
  if (digits === 0 || at >= chars.length || chars[at] !== ":") {
    return null;
  }
  at += 1;
  let seconds = 0;
  let got = 0;
  while (at < chars.length && isAsciiDigit(chars[at]!) && got < 2) {
    seconds = seconds * 10 + Number(chars[at]);
    at += 1;
    got += 1;
  }
  if (got !== 2 || seconds >= 60) {
    return null;
  }
  return [minutes * 60 + seconds, at];
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
  if (t.startsWith("#") || Array.from(t).every((c) => c === "-" || c === "=" || c === "*")) {
    return true;
  }
  const bare = trimMatches(t, (c) => c === "*" || c === "#" || c === " ");
  return bare.startsWith("INT.") || bare.startsWith("EXT.") || bare.startsWith("INT/EXT");
}

/** A closing line about the document rather than a beat in it. Ported from
 * `is_end_matter`.
 *
 * It rides on the LAST chunk, so without this the final shot's prompt ends
 * with "END OF EPISODE 1 — condensed to 5:00 (300 seconds)" — instructions to
 * a reader, sent to a model as though they were something to draw. */
function isEndMatter(line: string): boolean {
  const bare = toAsciiUppercase(trimMatches(line, (c) => c === "*" || c === "#" || c === "_" || c === " "));
  return bare.startsWith("END OF ") || bare === "END" || bare.startsWith("FADE OUT.");
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
    if (t === "" || isHeading(t) || isEndMatter(t)) {
      continue;
    }
    if (out !== "") {
      out += " ";
    }
    out += t;
  }
  const stripped = out.replaceAll("**", "").replaceAll("__", "");
  return trimStartMatches(stripped, (c) => isRangeDash(c) || isWhitespaceChar(c) || c === ":").trim();
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
  // (where the marker starts, where it ends, its duration)
  const marks: Array<[start: number, end: number, seconds: number]> = [];

  let i = 0;
  while (i < chars.length) {
    if (!isAsciiDigit(chars[i]!)) {
      i += 1;
      continue;
    }
    // A clock reached from mid-number ("1234:56") is not a timestamp.
    if (i > 0 && isAsciiDigit(chars[i - 1]!)) {
      i += 1;
      continue;
    }
    // And a range written mid-sentence is prose about the episode, not a
    // beat in it.
    if (!startsLine(chars, i)) {
      i += 1;
      continue;
    }
    const start = readClock(chars, i);
    if (start === null) {
      i += 1;
      continue;
    }
    const [startSeconds, afterStart] = start;
    let at = afterStart;
    while (at < chars.length && chars[at] === " ") {
      at += 1;
    }
    if (at >= chars.length || !isRangeDash(chars[at]!)) {
      i = afterStart;
      continue;
    }
    at += 1;
    while (at < chars.length && chars[at] === " ") {
      at += 1;
    }
    const end = readClock(chars, at);
    if (end === null) {
      i = afterStart;
      continue;
    }
    const [endSeconds, afterEnd] = end;
    marks.push([i, afterEnd, Math.max(endSeconds - startSeconds, 0)]);
    i = afterEnd;
  }

  if (marks.length < 2) {
    return undefined;
  }

  const slice = (from: number, to: number): string => chars.slice(from, to).join("");

  // Headings found at the END of one region belong to the NEXT beat: a
  // screenplay puts the scene line above the action it introduces.
  let pending = trailingHeadings(slice(0, marks[0]![0]));
  const out: Chunk[] = [];

  marks.forEach(([, bodyFrom, seconds], index) => {
    const bodyTo = index + 1 < marks.length ? marks[index + 1]![0] : chars.length;
    const region = slice(bodyFrom, bodyTo);
    const carried = trailingHeadings(region);

    let action = "";
    if (pending !== "") {
      action += pending;
      action += ". ";
    }
    action += clean(region);
    pending = carried;

    out.push({
      action: trimEndMatches(action.trim(), (c) => c === ".").trim(),
      // A malformed or zero-length range falls back to something usable
      // rather than refusing the whole script over one typo.
      seconds: clamp(seconds, 1, 60),
    });
  });
  return out;
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
