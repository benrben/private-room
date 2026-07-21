import { ChatCommand, FileMeta, Folder, SkillSummary } from "../api";

// ---- "#command" / "/skill" / "@reference" parsing ----------------------

/** Live autocomplete popover state for the composer. */
export interface AutocompleteState {
  kind: "cmd" | "ref" | "skill";
  /** The partial token being typed (after #, @, or /), lowercased for matching. */
  query: string;
  /** Byte offset of the '#', '@', or '/' that opened this token. */
  start: number;
  /** Highlighted item index. */
  index: number;
}

/** The token immediately left of the caret, if it's a "#…", "/…", or "@…" being typed
 *  (i.e. no whitespace since the sigil). Returns null otherwise. */
export function tokenAtCaret(
  value: string,
  caret: number,
): { kind: "cmd" | "ref" | "skill"; start: number; query: string } | null {
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
  return { refIds, cleaned: cleaned.replace(/\s+/g, " ").trim() };
}

/** Parse a composed message into a command (if any), its cleaned args, and the
 *  resolved @-file ids. `commandError` is set when "#word" names no command. */
export function parseComposer(
  text: string,
  commands: ChatCommand[],
  skills: SkillSummary[],
  files: FileMeta[],
  folders: Folder[],
): {
  command?: string;
  skill?: string;
  args: string;
  refIds: string[];
  commandError?: string;
  skillError?: string;
} {
  const { refIds, cleaned } = resolveRefs(text, files, folders);
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

/** The backend reports a stopped local engine two ways: the friendly
 * "isn't running" string (resolve_local_model → None) and the raw
 * "OLLAMA_DOWN" sentinel (a send that fails mid-request). Treat both as down so
 * the "Open Ollama" recovery button appears in either case. */
export function isOllamaDown(msg: string): boolean {
  return msg.includes("OLLAMA_DOWN") || msg.includes("isn't running");
}
