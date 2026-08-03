import { ChatCommand, FileMeta, Folder, SkillSummary, Specialist } from "../api";

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
export function resolveRefs(
  text: string,
  files: FileMeta[],
  folders: Folder[],
): { refIds: string[]; cleaned: string } {
  // Build match candidates, longest label first (so "Room summary.md" wins over
  // a file literally named "Room").
  const candidates: { label: string; ids: string[] }[] = [];
  for (const fo of folders) {
    const ids = files.filter((f) => f.folderId === fo.id).map((f) => f.id);
    candidates.push({ label: `${fo.name}/`, ids });
  }
  for (const f of files) candidates.push({ label: f.name, ids: [f.id] });
  candidates.sort((a, b) => b.label.length - a.label.length);

  const refIds: string[] = [];
  let cleaned = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "@") {
      const rest = text.slice(i + 1);
      const hit = candidates.find((c) =>
        rest.toLowerCase().startsWith(c.label.toLowerCase()),
      );
      if (hit) {
        for (const id of hit.ids) if (!refIds.includes(id)) refIds.push(id);
        i += 1 + hit.label.length;
        continue;
      }
    }
    cleaned += text[i];
    i += 1;
  }
  // Only HORIZONTAL runs collapse — removing an "@name" span leaves a double
  // space behind, and that is all this tidy-up is for. Newlines are the user's
  // structure (a multi-line brief under a #command reaches the model intact).
  return {
    refIds,
    cleaned: cleaned
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim(),
  };
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

/** One row of the composer's autocomplete popover. */
export interface AutocompleteItem {
  key: string;
  label: string;
  hint: string;
  insert: string;
  usage?: string;
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
      hint: sp.area,
      insert: `*${sp.key} `,
      usage: sp.label,
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
): {
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
} {
  const { refIds, cleaned } = resolveRefs(text, files, folders);
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
  if (tag) {
    const key = tag[1].toLowerCase();
    const rest = tag[2].trim();
    // A null roster means the menu never loaded — the tag is still the user's
    // clear instruction, so it travels rather than being refused on a fact we
    // never established. This is the ONE path on which a tag leaves here
    // unchecked, and it is safe because the sidecar re-checks every tag it
    // receives against the live catalog and refuses it BY NAME in the answer
    // (`prompts.TAG_UNAVAILABLE_ANSWER`) — an unknown tag is never silently
    // dropped into an ordinary turn on either side of the wire.
    if (specialists !== null && !specialists.some((sp) => sp.key === key)) {
      return { args: cleaned, refIds, specialistError: key };
    }
    if (/^[/#][a-z0-9-]+\b/.test(rest)) {
      return { args: cleaned, refIds, tagConflict: true };
    }
    return { specialist: key, args: rest, refIds };
  }
  const skill = /^\/([a-z0-9-]+)\b\s*([\s\S]*)$/.exec(cleaned);
  if (skill) {
    const name = skill[1].toLowerCase();
    if (!skills.some((candidate) => candidate.enabled && candidate.name === name)) {
      return { args: cleaned, refIds, skillError: name };
    }
    return { skill: name, args: skill[2].trim(), refIds };
  }
  const m = /^#([a-z-]+)\b\s*([\s\S]*)$/.exec(cleaned);
  if (!m) return { args: cleaned, refIds };
  const name = m[1];
  if (!commands.some((c) => c.name === name)) {
    return { args: cleaned, refIds, commandError: name };
  }
  return { command: name, args: m[2].trim(), refIds };
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

/** Friendly file name for the sidebar: drop the extension (the type icon
 * already conveys it) and turn underscores into spaces. The full original
 * name still rides along in a tooltip and on export. */
export function displayName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const cleaned = base.replace(/_+/g, " ").trim();
  return cleaned || name;
}

/** Display names that more than one file in the room would answer to.
 *
 * Memoized on the ARRAY IDENTITY rather than recomputed per row: every file row
 * asks, and rebuilding the set each time would be quadratic in the size of the
 * library. `s.files` is replaced wholesale on every change, so identity is
 * exactly the right cache key. */
let ambiguousFor: { name: string }[] | null = null;
let ambiguousSet = new Set<string>();

export function ambiguousDisplayNames(files: { name: string }[]): Set<string> {
  if (files === ambiguousFor) return ambiguousSet;
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const f of files) {
    const key = displayName(f.name).toLowerCase();
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  }
  ambiguousFor = files;
  ambiguousSet = dupes;
  return dupes;
}

/**
 * What to call a file on screen.
 *
 * `displayName` drops the extension, which reads better right up until two
 * files disagree only in that extension. Live QA imported `file-sample_1MB.doc`
 * and `file-sample_1MB.docx` and got two library rows both labelled
 * "file-sample 1MB", with no way to tell which was which — and the tab strip
 * truncated both to "file e…". Where the tidy name is ambiguous, the real
 * filename is the honest one.
 */
export function fileLabel(name: string, files: { name: string }[]): string {
  const base = displayName(name);
  return ambiguousDisplayNames(files).has(base.toLowerCase()) ? name : base;
}

/** Human-friendly timestamp for a saved version (ADD-2). Spelled-out month so
 * it's never ambiguous between D/M/Y and M/D/Y locales (e.g. "Jul 5, 2026,
 * 12:47 AM"). */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** ART-1: one short line saying what produced a version of a generated
 * artifact — "Written by #minutes · from 2 files".
 *
 * Returns "" when the room recorded nothing worth saying, and the strip then
 * shows NO attribution line at all. That silence is the point: "Ask before AI
 * edits files" is off, so the History strip is where a person finds out an AI
 * wrote something, and a line that appeared for every version would stop
 * carrying that information. A run id alone is not shown — it identifies the
 * write for support, it does not tell the reader anything.
 *
 * Only ids and counts cross this boundary; the source FILES are counted, never
 * named, because their names are room content the strip has no need of. */
export function provenanceLine(
  p: { agent?: string; tool?: string; sourceFileIds?: string[] } | null | undefined,
): string {
  if (!p) return "";
  const who = p.agent || p.tool;
  const n = p.sourceFileIds?.length ?? 0;
  if (!who && n === 0) return "";
  const parts: string[] = [];
  if (who) parts.push(`Written by ${who}`);
  if (n > 0) parts.push(`from ${n} file${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** The backend reports a stopped local engine two ways: the friendly
 * "isn't running" string (resolve_local_model → None) and the raw
 * "OLLAMA_DOWN" sentinel (a send that fails mid-request). Treat both as down so
 * the "Open Ollama" recovery button appears in either case. */
export function isOllamaDown(msg: string): boolean {
  return msg.includes("OLLAMA_DOWN") || msg.includes("isn't running");
}
