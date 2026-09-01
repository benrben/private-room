/** Pure skill, evidence, room-file, and save-reference request parsing. */

import { clampChars } from "./textClamp.js";

const MAX_ADVERTISED_SKILLS = 12;
const MAX_ADVERTISED_SKILL_CHARS = 200;

function skillNameEnd(rest: string): number {
  const whitespace = /\p{White_Space}/u.exec(rest);
  return whitespace === null ? rest.length : whitespace.index;
}

function validSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[a-z0-9-]+$/.test(name);
}

/** `agent.rs::explicit_skill_request` — `"/lease-review check the clause"` ->
 * `{name: "lease-review", request: "check the clause"}`; a bare `/x` yields an
 * empty request. `null` when the question does not open with a valid `/name`
 * (lowercase ascii/digits/hyphen, 1-64 chars). */
export function explicitSkillRequest(question: string): { name: string; request: string } | null {
  const trimmed = question.trimStart();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const rest = trimmed.slice(1);
  const end = skillNameEnd(rest);
  const name = rest.slice(0, end);
  if (!validSkillName(name)) {
    return null;
  }
  return { name, request: rest.slice(end).trim() };
}

// ------------------------------------------------------ hard evidence policy

/** Host-authoritative evidence policy for one turn. */
export type TurnEvidencePolicy = "normal" | "no-tools-no-sources";

/** Recognize a direct instruction not to use tools or file/outside evidence.
 * A question that merely does not need tools remains in normal mode. */
export function explicitlyProhibitsToolsOrSources(text: string): boolean {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (normalized === "") return false;

  const targets =
    "(?:tools?|file(?: system)?(?: reads?)?|files?|documents?|room(?: data| files?)?|workspace(?: files?)?|sources?|attachments?|retrieval|search|web|internet|browsing)";
  const qualifiers =
    "(?:(?:any|the|outside|external|online|room|workspace|local|additional|other|bundled|browser|file|available)\\s+){0,3}";
  const direct = new RegExp(
    `\\b(?:do not|don't|dont|never)\\s+(?:use|call|run|invoke|access|read|open|search|retrieve|consult|browse|look at|load)\\s+(?:from\\s+)?${qualifiers}${targets}\\b`,
  );
  const without = new RegExp(`\\b(?:without|with no|using no)\\s+${qualifiers}${targets}\\b`);
  const terse = new RegExp(`(?:^|[.!?;:]\\s*)no\\s+${qualifiers}${targets}\\b`);
  const ownKnowledge =
    /\b(?:answer|respond|reply|work)\s+(?:only\s+)?(?:from|using)\s+(?:your\s+)?(?:own|general)\s+knowledge(?:\s+only)?\b/;
  return direct.test(normalized) || without.test(normalized) || terse.test(normalized) || ownKnowledge.test(normalized);
}

/** Selected skill instructions are policy input too. */
export function resolveTurnEvidencePolicy(
  userRequest: string,
  selectedSkillInstructions: string | null = null,
): TurnEvidencePolicy {
  return explicitlyProhibitsToolsOrSources(userRequest)
    || (selectedSkillInstructions !== null
      && explicitlyProhibitsToolsOrSources(selectedSkillInstructions))
    ? "no-tools-no-sources"
    : "normal";
}

/** `agent.rs::advertise_skills` — level 1 of skill progressive disclosure: the
 * block offering the room's enabled GENERAL skills at the top of every
 * question. Empty when there are none; a cut always SAYS it was cut, because
 * the model is the only reader and a list that silently ends at twelve is a
 * list it thinks is complete. */
export function advertiseSkills(skills: ReadonlyArray<readonly [name: string, description: string]>): string {
  if (skills.length === 0) {
    return "";
  }
  let out =
    "Available Agent Skills (specialized instructions). If one clearly matches the question, call read_skill before doing the work:\n";
  for (const [name, description] of skills.slice(0, MAX_ADVERTISED_SKILLS)) {
    const desc = clampChars(description, MAX_ADVERTISED_SKILL_CHARS);
    // BYTE lengths, matching Rust's `desc.len() < description.len()`
    // (`String::len()` is UTF-8 bytes). `desc` is always a prefix of
    // `description`, so this agrees with a char comparison either way — the
    // byte form is kept because it is what the source says.
    const ellipsis = Buffer.byteLength(desc, "utf8") < Buffer.byteLength(description, "utf8") ? "…" : "";
    out += `- ${name}: ${desc}${ellipsis}\n`;
  }
  if (skills.length > MAX_ADVERTISED_SKILLS) {
    out += `(…and ${skills.length - MAX_ADVERTISED_SKILLS} more enabled skills, not listed here — call list_skills to see them all.)\n`;
  }
  return `${out}\n`;
}

// ------------------------------------------------ explicit room-file scope

/** Is one side of a filename mention a word boundary?
 *
 * Filenames commonly end in an ASCII letter (`notes.md`). A plain substring
 * check would therefore treat `notes.md` as explicitly named inside
 * `old-notes.md.bak`, silently narrowing retrieval to the wrong file. Common
 * filename/path punctuation also continues a name; Unicode letters and numbers
 * count as word characters because room names are not English-only. */
function fileMentionStartBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[\p{Alphabetic}\p{N}._\/-]/u.test(ch);
}

function fileMentionEndBoundary(question: string, at: number): boolean {
  const ch = question[at];
  if (ch === undefined) return true;
  if (/[\p{Alphabetic}\p{N}_\/-]/u.test(ch)) return false;
  // A dot followed by a filename character extends the name (`notes.md.bak`);
  // a terminal sentence dot after `notes.md` is ordinary punctuation.
  return ch !== "." || !/[\p{Alphabetic}\p{N}_-]/u.test(question[at + 1] ?? "");
}

function mentionIndex(question: string, candidate: string): number {
  let at = question.indexOf(candidate);
  while (at !== -1) {
    const before = at === 0 ? undefined : question[at - 1];
    const afterAt = at + candidate.length;
    if (fileMentionStartBoundary(before) && fileMentionEndBoundary(question, afterAt)) {
      return at;
    }
    at = question.indexOf(candidate, at + 1);
  }
  return -1;
}

interface FileMentionEntry {
  canonical: string;
  folded: string;
  basename: string;
  qualified: boolean;
  order: number;
}

function fileMentionEntries(
  inventory: ReadonlyArray<readonly [name: string, mime: string, summary: string | null]>
): FileMentionEntry[] {
  return inventory.map(([name], order) => {
    const canonical = name.normalize("NFC");
    const folded = canonical.toLowerCase();
    const slash = folded.lastIndexOf("/");
    return {
      canonical,
      folded,
      basename: slash === -1 ? folded : folded.slice(slash + 1),
      qualified: slash !== -1,
      order,
    };
  });
}

function basenameCounts(entries: readonly FileMentionEntry[]): Map<string, number> {
  const basenameCounts = new Map<string, number>();
  for (const entry of entries) {
    basenameCounts.set(entry.basename, (basenameCounts.get(entry.basename) ?? 0) + 1);
  }
  return basenameCounts;
}

function entryMentionIndex(
  question: string,
  entry: FileMentionEntry,
  counts: ReadonlyMap<string, number>
): number {
  const direct = mentionIndex(question, entry.folded);
  if (direct !== -1 || !entry.qualified || counts.get(entry.basename) !== 1) {
    return direct;
  }
  return mentionIndex(question, entry.basename);
}

function canResolveNamedFiles(question: string, inventory: readonly unknown[]): boolean {
  return question.trim() !== "" && inventory.length > 0;
}

/** Resolve the normal room files the user explicitly names in this question.
 *
 * The inventory supplies canonical display paths (`Research/findings.md`). A
 * folder-qualified mention always wins. A basename mention is accepted only
 * when exactly one inventory row has that basename; with two `notes.md` files
 * Arcelle does not guess. Results follow the order in which the user named
 * them, not database creation order.
 *
 * This is intentionally pure. It is the boundary used by the context gatherer
 * before retrieval, so unrelated room chunks never enter a turn that named
 * exact files (ARC-QA-005). */
export function explicitlyNamedRoomFiles(
  questionRaw: string,
  inventory: ReadonlyArray<readonly [name: string, mime: string, summary: string | null]>,
): string[] {
  const question = questionRaw.normalize("NFC").toLowerCase();
  if (!canResolveNamedFiles(question, inventory)) return [];

  const entries = fileMentionEntries(inventory);
  const counts = basenameCounts(entries);

  const found: Array<{ name: string; at: number; order: number }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const at = entryMentionIndex(question, entry, counts);
    if (at === -1) continue;
    if (seen.has(entry.folded)) continue;
    seen.add(entry.folded);
    found.push({ name: entry.canonical, at, order: entry.order });
  }
  found.sort((a, b) => a.at - b.at || a.order - b.order);
  return found.slice(0, 12).map((entry) => entry.name);
}

// -------------------------------------------------- save-that-as-a-file

const NAME_MARKERS = ["called ", "named ", "titled ", "as file ", "בשם "];

/**
 * `agent.rs::find_ci` — case-insensitive substring search returning CODE-POINT
 * `[start, end)` offsets into the ORIGINAL `haystack`.
 *
 * `haystack.toLowerCase().indexOf(needle)` is the obvious version and it is
 * subtly wrong: lowercasing is not length-preserving (Turkish `İ` lowercases
 * to TWO characters), so an index found in the lowered copy can point
 * somewhere else in the original. Sliding a same-length window over the
 * ORIGINAL and lowering only that window keeps every offset native to the
 * string that will actually be cut. `needleLower` must already be lowercase.
 */
function findCi(haystack: string, needleLower: string): [number, number] | null {
  const chars = Array.from(haystack);
  const n = Array.from(needleLower).length;
  for (let k = 0; k + n <= chars.length; k++) {
    if (chars.slice(k, k + n).join("").toLowerCase() === needleLower) {
      return [k, k + n];
    }
  }
  return null;
}

/** Rust's `trim_matches`, code-point-wise: drop leading AND trailing chars the
 * predicate rejects. */
function trimEdgeChars(s: string, keep: (ch: string) => boolean): string {
  const arr = Array.from(s);
  let start = 0;
  let end = arr.length;
  while (start < end && !keep(arr[start]!)) {
    start++;
  }
  while (end > start && !keep(arr[end - 1]!)) {
    end--;
  }
  return arr.slice(start, end).join("");
}

const QUOTE_CHARS = new Set(['"', "'", "“", "”", "„"]);
const SENTENCE_END_CHARS = new Set([".", "!", "?"]);

function nameAfterMarker(question: string, marker: string): string | null {
  const hit = findCi(question, marker);
  return hit === null ? null : Array.from(question).slice(hit[1]).join("").trim();
}

function trimSentenceEndChars(name: string): string {
  const chars = Array.from(name);
  let last = chars.length;
  while (last > 0 && SENTENCE_END_CHARS.has(chars[last - 1]!)) last--;
  return chars.slice(0, last).join("").trim();
}

function validRequestedFileName(name: string): string | null {
  const unquoted = trimEdgeChars(name, (ch) => !QUOTE_CHARS.has(ch));
  const cleaned = trimSentenceEndChars(unquoted);
  return cleaned.length > 0 && Array.from(cleaned).length <= 80 ? cleaned : null;
}

/** `agent.rs::requested_file_name` — `"…called Summary"` / `"…named Q3 notes"`
 * / `"…בשם סיכום"` -> the requested file name, when the save turn carries one. */
export function requestedFileName(question: string): string | null {
  const q = question.trim();
  for (const marker of NAME_MARKERS) {
    const afterMarker = nameAfterMarker(q, marker);
    const name = afterMarker === null ? null : validRequestedFileName(afterMarker);
    if (name !== null) return name;
  }
  return null;
}

/** `agent.rs::is_bare_save_reference` — a short save/record turn whose object
 * is a bare reference ("that", "this", "it", "זה") rather than inline content,
 * so the turn can carry a deterministic anaphora hint. */
export function isBareSaveReference(question: string): boolean {
  const q = question.toLowerCase();
  if (Array.from(q).length > 160) {
    return false;
  }
  const VERBS = [
    "save",
    "keep ",
    "record",
    "write that",
    "write this",
    "write it",
    "note that",
    "note this",
    "jot",
    "שמור",
    "שמרי",
    "תשמור",
    "רשום",
    "רשמי",
  ];
  const REFERENTS = [
    "that",
    "this",
    "it ",
    " it",
    "the above",
    "your answer",
    "your reply",
    "your summary",
    "זה",
    "זאת",
    "את זה",
    "התשובה",
  ];
  return VERBS.some((v) => q.includes(v)) && REFERENTS.some((r) => q.includes(r));
}

const PURE_SAVE_ALLOWED: ReadonlySet<string> = new Set([
  // verbs
  "save", "saves", "saved", "keep", "store", "record", "write", "jot", "note", "put", "add",
  // referents
  "that", "this", "it", "above", "answer", "reply", "response", "message", "text", "output",
  "last", "previous", "your",
  // filler
  "a", "an", "the", "as", "to", "in", "into", "on", "of", "for", "my", "our", "please", "down",
  "here", "just", "new", "file", "files", "document", "doc", "note's", "notes", "room", "library",
  "somewhere",
  // Hebrew equivalents
  "שמור", "שמרי", "תשמור", "רשום", "רשמי", "זה", "זאת", "את", "קובץ", "כקובץ", "חדש", "בחדר",
  "התשובה", "בבקשה", "לקובץ", "אותו",
]);

function isAlnumOrApostrophe(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch) || ch === "'";
}

/**
 * `agent.rs::is_pure_save_reference` — a PURE save-that turn (nothing to do
 * but write the previous reply verbatim) is executed by CODE and the model
 * gets no vote; see `turnEngine.ts`'s `ask` for the fast path this gates.
 *
 * Decided by an ALLOW-list over every word outside an explicit "…called X"
 * name, never a blacklist of transform verbs — those cannot be enumerated, so
 * a blacklist would silently hand "save that translated to Hebrew" to a
 * deterministic copy.
 */
export function isPureSaveReference(question: string): boolean {
  if (!isBareSaveReference(question)) {
    return false;
  }
  let body = question.trim();
  for (const marker of NAME_MARKERS) {
    const hit = findCi(body, marker);
    if (hit !== null) {
      body = Array.from(body).slice(0, hit[0]).join("");
    }
  }
  const words = body
    .split(/[\p{White_Space},;:]/u)
    .map((w) => trimEdgeChars(w, isAlnumOrApostrophe).toLowerCase())
    .filter((w) => w.length > 0);
  return words.every((w) => PURE_SAVE_ALLOWED.has(w));
}

/** The stopped marker the save-that fast path strips off the reply it is
 * copying. Rust does this with `trim_end_matches(" *(stopped)*")`, which
 * removes EVERY trailing repetition, not just one — kept exactly. */
export function stripStoppedSuffix(s: string): string {
  const suffix = " *(stopped)*";
  let out = s;
  while (out.endsWith(suffix)) {
    out = out.slice(0, out.length - suffix.length);
  }
  return out;
}
