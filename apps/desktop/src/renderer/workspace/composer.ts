import { ChatCommand, FileMeta, Folder, SkillSummary, Specialist } from "../api";

export {
  ambiguousDisplayNames,
  displayName,
  fileLabel,
  formatWhen,
  isOllamaDown,
  provenanceLine,
} from "./composerPresentation";

// ---- "#command" / "/skill" / "*specialist" / "@reference" parsing -------

/** What kind of thing the composer's autocomplete is offering. */
export type AutocompleteKind = "cmd" | "ref" | "skill" | "agent";

/** Live autocomplete popover state for the composer. */
export interface AutocompleteState {
  kind: AutocompleteKind;
  /** The partial token being typed (after #, @, /, or *), lowercased for matching. */
  query: string;
  /** Byte offset of the '#', '@', '/', or '*' that opened this token. */
  start: number;
  /** Highlighted item index. */
  index: number;
}

/** The token immediately left of the caret, if it's a "#…", "/…", "*…" or "@…"
 *  being typed (i.e. no whitespace since the sigil). Returns null otherwise. */
export function tokenAtCaret(
  value: string,
  caret: number,
): { kind: AutocompleteKind; start: number; query: string } | null {
  const before = value.slice(0, caret);
  // A '#' command only makes sense as the first token of the message.
  const cmd = /^#([a-z-]*)$/.exec(before);
  if (cmd) {
    return { kind: "cmd", start: 0, query: cmd[1].toLowerCase() };
  }
  // An explicit skill invocation is also the first token. Enabled skills are
  // presented as /skill-name and the backend loads that SKILL.md for the turn.
  const skill = /^\/([a-z0-9-]*)$/.exec(before);
  if (skill) {
    return { kind: "skill", start: 0, query: skill[1].toLowerCase() };
  }
  // "*name" — the owner's tag for "run this specialist" (2026-08-03). First
  // token only, for the same reason the other two are: anywhere else a '*' is
  // multiplication, a footnote or the start of a bullet, and opening a menu
  // over it would fight the user mid-sentence.
  const agent = /^\*([a-z]*)$/.exec(before);
  if (agent) {
    return { kind: "agent", start: 0, query: agent[1].toLowerCase() };
  }
  // '@' references can appear anywhere; match back to the sigil (allows spaces
  // in the query so multi-word filenames can be typed/filtered).
  const at = /@([^@\n]*)$/.exec(before);
  if (at) {
    return { kind: "ref", start: caret - at[1].length - 1, query: at[1].toLowerCase() };
  }
  return null;
}

/** Resolve every "@name" / "@folder/" span in `text` against the room's files
 *  and folders (longest-name-first so spaces work), returning the collected
 *  file ids and the text with those spans removed. Unmatched "@…" is left as
 *  literal text. */
type ReferenceCandidate = { label: string; ids: string[] };

function referenceCandidates(
  files: FileMeta[],
  folders: Folder[],
): ReferenceCandidate[] {
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  return [
    ...folderFileReferenceCandidates(files, folderNames),
    ...folderReferenceCandidates(files, folders),
    ...files.map((file) => ({ label: file.name, ids: [file.id] })),
  ].sort((a, b) => b.label.length - a.label.length);
}

function folderFileReferenceCandidates(
  files: FileMeta[],
  folderNames: Map<string, string>,
): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  for (const file of files) {
    const folderName = file.folderId === null ? undefined : folderNames.get(file.folderId);
    if (folderName !== undefined) {
      candidates.push({ label: `${folderName}/${file.name}`, ids: [file.id] });
    }
  }
  return candidates;
}

function folderReferenceCandidates(
  files: FileMeta[],
  folders: Folder[],
): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  for (const folder of folders) {
    const ids = files.filter((file) => file.folderId === folder.id).map((file) => file.id);
    candidates.push({ label: `${folder.name}/`, ids });
  }
  return candidates;
}

function matchingReference(rest: string, candidates: ReferenceCandidate[]): ReferenceCandidate | undefined {
  return candidates.find((candidate) =>
    rest.toLowerCase().startsWith(candidate.label.toLowerCase()),
  );
}

function appendReferenceIds(refIds: string[], ids: string[]): void {
  for (const id of ids) if (!refIds.includes(id)) refIds.push(id);
}

function removeReferences(
  text: string,
  candidates: ReferenceCandidate[],
): { refIds: string[]; cleaned: string } {
  const refIds: string[] = [];
  let cleaned = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "@") {
      cleaned += text[index];
      index += 1;
      continue;
    }
    const hit = matchingReference(text.slice(index + 1), candidates);
    if (!hit) {
      cleaned += text[index];
      index += 1;
      continue;
    }
    appendReferenceIds(refIds, hit.ids);
    index += 1 + hit.label.length;
  }
  return { refIds, cleaned };
}

function tidyReferenceWhitespace(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function resolveRefs(
  text: string,
  files: FileMeta[],
  folders: Folder[],
): { refIds: string[]; cleaned: string } {
  // Build match candidates, longest label first (so "Room summary.md" wins over
  // a file literally named "Room").
  // A file inside a folder is displayed and inserted as `Folder/file.ext`.
  // Add that complete spelling before the folder candidate itself. Otherwise
  // `@Research/findings.md` matches only `Research/`, attaches the whole
  // folder, and leaves the literal `findings.md` behind in a command's args.
  // Longest-first sorting below then makes the complete file reference win
  // while preserving `@Research/` as the explicit whole-folder spelling.
  const { refIds, cleaned } = removeReferences(text, referenceCandidates(files, folders));
  // Only HORIZONTAL runs collapse — removing an "@name" span leaves a double
  // space behind, and that is all this tidy-up is for. Newlines are the user's
  // structure (a multi-line brief under a #command reaches the model intact).
  return { refIds, cleaned: tidyReferenceWhitespace(cleaned) };
}

/** The backend only honours an explicit skill when "/name" is the FIRST token
 *  of the message (`explicit_skill_request` in agent.rs). Typing a file
 *  reference first ("@lease.pdf /lease-review …") would otherwise be accepted
 *  and then silently ignored, so the token is hoisted to the front before the
 *  message is sent. The "@" spans stay in the text — Regenerate parses them
 *  back out of the saved message. */
export function hoistSkill(text: string, skill: string): string {
  if (/^\s*\//.test(text)) return text.trim();
  // Normally the token stands alone; the loose form covers a reference that
  // ran straight into it ("@x/lease-review"), which `resolveRefs` still reads
  // as a skill once the "@x" span is lifted out.
  const spaced = new RegExp(`(^|\\s)/${skill}(?=\\s|$)`);
  const loose = new RegExp(`/${skill}(?=\\s|$)`);
  const without = (spaced.test(text) ? text.replace(spaced, "$1") : text.replace(loose, ""))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  return without ? `/${skill} ${without}` : `/${skill}`;
}

/** The same hoist `hoistSkill` performs, for the "*specialist" tag.
 *
 * The sidecar reads the tag from the FIRST token of the question it is sent
 * (`agents.tagged_specialist`), so "@lease.pdf *file summarize it" — which
 * `parseComposer` reads correctly, because it parses the text with the "@"
 * spans already lifted out — would arrive with the tag buried and be treated as
 * an ordinary turn. Sending and showing the same text keeps the transcript
 * honest about what was actually asked. */
export function hoistTag(text: string, key: string): string {
  if (/^\s*\*/.test(text)) return text.trim();
  const spaced = new RegExp(`(^|\\s)\\*${key}(?=\\s|$)`);
  const loose = new RegExp(`\\*${key}(?=\\s|$)`);
  const without = (spaced.test(text) ? text.replace(spaced, "$1") : text.replace(loose, ""))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  return without ? `*${key} ${without}` : `*${key}`;
}

/** Which sigil token the message currently OPENS with, or null.
 *
 * Purely for the composer's tool row: the Action / Skill / Specialist chip that
 * matches the token being composed is drawn as chosen, so "this turn is going to
 * one specialist" is visible on the control as well as in the text. It is a
 * DISPLAY derivation and nothing routes off it — `parseComposer` below is still
 * the only thing that decides what is actually sent.
 *
 * The three patterns are deliberately the same ones `parseComposer` uses,
 * including the `(?=\s|$)` lookahead on the tag: a message that opens with
 * markdown emphasis ("*important* note") is NOT a specialist tag, and a chip
 * that lit up for it would be telling the user something the sender disagrees
 * with. The bare sigil alone matches as well ("*", the instant the menu opens),
 * but a sigil followed by a SPACE does not: "* bullet" and "# heading" are
 * markdown, and neither parser reads them as a token either. */
export function openingSigil(text: string): "#" | "/" | "*" | null {
  if (/^\*([a-z]+(?=\s|$)|$)/.test(text)) return "*";
  if (/^\/([a-z0-9-]+(?=\s|$)|$)/.test(text)) return "/";
  if (/^#([a-z-]+(?=\s|$)|$)/.test(text)) return "#";
  return null;
}

// ---- how a message is SET: the hand, or the interface sans ----------------
//
// The AI pane is meant to read as two people passing notes in the same
// notebook, and the rule for which face a message takes is about LENGTH and
// KIND, never about who wrote it:
//
//   short message, ordinary prose ....... the hand (Kalam)
//   long message ........................ the interface sans
//   code, tables, citations, paths ...... the interface sans (mono inside it)
//
// So a one-line question from the user and a one-line "Nothing in this room
// mentions that" from the AI are both handwritten, and a 900-word answer from
// either is not.

/** Where the handwriting stops.
 *
 * The conversation column is 720px wide (`.messages` in chat.css). Kalam at
 * --fs-hand (15px) averages a little over 7px per glyph, so a line of it holds
 * roughly 95 characters — 280 is three lines, which is exactly the length
 * paper.css reserves the hand for ("annotations, dates, counts, short notes").
 *
 * Checked against what messages in this app are actually like. The four canned
 * prompts in the empty chat run 25-40 characters; the room's generated starter
 * questions are one sentence by construction (front_page.rs asks for "short"
 * ones); a reply that is only an acknowledgement — "Nothing in this room
 * mentions that", "Done — both are filed under Leases" — is well under 100.
 * Every one of those stays in the hand. A `#command` answer, a file summary or
 * any explanation with a structure to it clears 280 on its first paragraph and
 * lands in the sans, which is what the reader needs for a long run anyway.
 *
 * Length is only half of it: "Saved it as Notes.md" is nine words and still
 * comes back false, because the sniff below sees a filename. That is deliberate
 * — the one detail in that sentence is the thing the reader has to be able to
 * go and find. */
/* The "is this message handwritten?" decision deliberately does NOT live here.
 *
 * It used to, as `readsAsHandwriting` — a second implementation with a
 * different threshold that nothing ever imported, while ChatPane used
 * markup.ts's `isHandwritten`. The two disagreed, and the copy with the
 * important guard (anything outside Kalam's bundled latin + latin-ext subsets)
 * was the dead one, so Hebrew and CJK messages were being set in a face with
 * no glyphs for them. Its stoppers have been merged into markup.ts, which is
 * the one the pane actually calls.
 *
 * Nothing in THIS file should classify a message anyway: the composer's job is
 * the field, and what the user is typing is always the sans — they have to see
 * exactly what they are about to send. */

/** One row of the composer's autocomplete popover. */
export interface AutocompleteItem {
  key: string;
  label: string;
  hint: string;
  insert: string;
  usage?: string;
  /** A visible explanation row that cannot be selected or dispatched. */
  disabled?: boolean;
}

/** The "*" menu's rows: the room's specialists filtered by what's been typed.
 *
 * Substring rather than prefix matching, like the "@" menu and unlike "#" and
 * "/": the key is an identifier and the user is looking for a job to be done,
 * so "sign in to a site" is found by typing "site" against the AREA and "flash"
 * finds the Studio agent through neither its key nor its label. Every row is
 * one AGENT — the Browser agent has its own key here rather than sitting
 * unnamed under "web", which is how the owner came to report that this room had
 * no browser at all (2026-08-03). */
export function specialistItems(
  specialists: readonly Specialist[],
  query: string,
): AutocompleteItem[] {
  const q = query.trim().toLowerCase();
  return specialists
    .filter((sp) =>
      [sp.key, sp.label, sp.area].some((field) => field.toLowerCase().includes(q)),
    )
    .map((sp) => ({
      key: `ag-${sp.key}`,
      label: `*${sp.key}`,
      hint: sp.capabilityReason ?? sp.area,
      insert: `*${sp.key} `,
      usage:
        sp.capability === "unavailable"
          ? `${sp.label} · ${sp.localHandoff ? "On this Mac" : "Unavailable"}`
          : sp.capability === "inspect-only"
            ? `${sp.label} · Inspect only`
            : sp.label,
      disabled: sp.capability === "unavailable",
    }));
}

/** What the "*" menu says INSTEAD of rows, when it has none — "" when it has
 *  rows to show.
 *
 * An empty menu is the one thing this must never be: the whole feature is a
 * promise about which specialists exist, so "we don't know yet", "this room
 * genuinely has none" and "none of them match what you typed" are three
 * different answers and the menu gives the one that is true. `specialists` is
 * null until the roster has been fetched — never an empty array standing in
 * for an unknown one. */
export function specialistNote(
  specialists: readonly Specialist[] | null,
  error: string,
  query: string,
): string {
  if (specialists === null) {
    return error
      ? `The specialists couldn't be loaded: ${error}`
      : "Looking up this room's specialists…";
  }
  if (specialists.length === 0) {
    return "This room has no specialists to hand a turn to right now.";
  }
  if (specialistItems(specialists, query).length === 0) {
    return `No specialist here matches "${query}".`;
  }
  return "";
}

/** What the user is told when "*name" names no specialist this room has.
 *
 * ONE wording, for every path that can refuse a tag (sending, and rewriting a
 * message and asking again) — the same discipline `#command` and `/skill`
 * already follow, and the FIRST SENTENCE of the answer the sidecar gives a tag
 * that reaches it anyway (`prompts.TAG_UNAVAILABLE_ANSWER`, which refuses it in
 * code rather than asking a model to): no such specialist, and here are the
 * ones there are. A refusal that does not name the alternatives leaves the user
 * guessing at a vocabulary the app already knows, and a user must not be able
 * to tell which of the two layers caught their typo.
 *
 * A typo ("*banana") and a real specialist this room cannot serve ("*web" with
 * the internet off) get the SAME sentence on purpose. The roster is the room's
 * reachable specialists, so "isn't one this room has" is true of both, and the
 * distinction between them is not one the person typing can act on differently.
 */
export function specialistErrorMessage(
  name: string,
  specialists: readonly Specialist[] | null,
): string {
  const selected = (specialists ?? []).find((sp) => sp.key === name);
  if (selected?.capability === "unavailable") {
    return selected.capabilityReason
      ?? `*${name} is unavailable while Cloud Privacy is active. Switch to On this Mac to use this specialist.`;
  }
  const names = (specialists ?? []).map((sp) => `*${sp.key}`).join(", ");
  return `*${name} isn't a specialist this room has. ${
    names ? `Try: ${names}` : "This room has no specialists right now."
  }`;
}

/** A file name that no file in the room is using yet: "AI note.md" →
 *  "AI note 2.md". Two answers saved with the suggested name would otherwise
 *  both be called "AI note.md", and a source chip can only ever open one of
 *  them (the newest). */
export function uniqueFileName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

type ParsedComposer = {
  command?: string;
  skill?: string;
  specialist?: string;
  args: string;
  refIds: string[];
  commandError?: string;
  skillError?: string;
  specialistError?: string;
  /** A "*specialist" tag was typed together with a "/skill" or a "#command".
   *  All three are read from the FIRST token, so honouring one means silently
   *  dropping the other — which is the one thing that must not happen. */
  tagConflict?: boolean;
};

function specialistIsAvailable(
  specialists: readonly Specialist[] | null,
  key: string,
): boolean {
  if (specialists === null) return true;
  const selected = specialists.find((specialist) => specialist.key === key);
  return selected !== undefined && selected.capability !== "unavailable";
}

function parseSpecialistTag(
  cleaned: string,
  refIds: string[],
  specialists: readonly Specialist[] | null,
): ParsedComposer | undefined {
  // The specialist tag is read FIRST because it owns the same position the
  // skill token does, and its absence must not depend on what follows it.
  //
  // This regex is the SAME one the sidecar's `agents._TAG_RE` is, character
  // class included, and it has to be — the two layers must agree on what is
  // even a tag before they can agree on what to do with one.
  //
  // The lookahead: with a plain `\b` the two parsers disagreed about markdown,
  // and the frontend was the one that was wrong. "*important* note" ends the
  // token on the closing star, which `\b` accepts — so the composer refused to
  // send an ordinary emphasised sentence ("*important isn't a specialist this
  // room has") while the sidecar, which requires whitespace or end-of-string
  // after the name, would have read the very same text as no tag at all.
  //
  // The [a-z] class: the sidecar once also matched "_" and "." so that a
  // model's spellings of a domain ("*ask_web_agent", "*chat.browse") resolved
  // here too. This parser cannot lex those, so it sent them as ordinary prose
  // — and the sidecar dispatched the Web agent for a turn the composer had
  // shown as untagged. The tag's vocabulary is now exactly what the "*" menu
  // inserts, on both sides.
  const tag = /^\*([a-z]+)(?=\s|$)\s*([\s\S]*)$/.exec(cleaned);
  if (!tag) return undefined;
  const key = tag[1].toLowerCase();
  const rest = tag[2].trim();
  // A null roster means the menu never loaded — the tag is still the user's
  // clear instruction, so it travels rather than being refused on a fact we
  // never established. This is the ONE path on which a tag leaves here
  // unchecked, and it is safe because the sidecar re-checks every tag it
  // receives against the live catalog and refuses it BY NAME in the answer
  // (`prompts.TAG_UNAVAILABLE_ANSWER`) — an unknown tag is never silently
  // dropped into an ordinary turn on either side of the wire.
  if (!specialistIsAvailable(specialists, key)) {
    return { args: cleaned, refIds, specialistError: key };
  }
  if (/^[/#][a-z0-9-]+\b/.test(rest)) {
    return { args: cleaned, refIds, tagConflict: true };
  }
  return { specialist: key, args: rest, refIds };
}

function parseSkillRequest(
  cleaned: string,
  refIds: string[],
  skills: SkillSummary[],
): ParsedComposer | undefined {
  const skill = /^\/([a-z0-9-]+)\b\s*([\s\S]*)$/.exec(cleaned);
  if (!skill) return undefined;
  const name = skill[1].toLowerCase();
  if (!skills.some((candidate) => candidate.enabled && candidate.name === name)) {
    return { args: cleaned, refIds, skillError: name };
  }
  return { skill: name, args: skill[2].trim(), refIds };
}

function parseCommandRequest(
  cleaned: string,
  refIds: string[],
  commands: ChatCommand[],
): ParsedComposer {
  const command = /^#([a-z-]+)\b\s*([\s\S]*)$/.exec(cleaned);
  if (!command) return { args: cleaned, refIds };
  const name = command[1];
  if (!commands.some((c) => c.name === name)) {
    return { args: cleaned, refIds, commandError: name };
  }
  return { command: name, args: command[2].trim(), refIds };
}

/** Parse a composed message into a command (if any), its cleaned args, and the
 *  resolved @-file ids. `commandError` is set when "#word" names no command;
 *  `specialistError` when "*word" names no specialist THIS ROOM HAS. */
export function parseComposer(
  text: string,
  commands: ChatCommand[],
  skills: SkillSummary[],
  files: FileMeta[],
  folders: Folder[],
  specialists: readonly Specialist[] | null = null,
): ParsedComposer {
  const { refIds, cleaned } = resolveRefs(text, files, folders);
  return parseSpecialistTag(cleaned, refIds, specialists)
    ?? parseSkillRequest(cleaned, refIds, skills)
    ?? parseCommandRequest(cleaned, refIds, commands);
}

/** Read a File (pasted image) into base64 without the data: prefix (ADD-8). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result);
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
