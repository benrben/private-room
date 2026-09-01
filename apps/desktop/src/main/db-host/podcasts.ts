/**
 * A podcast script as data — port of `src-tauri/src/db/podcasts.rs` (438
 * lines, read in full including its `#[cfg(test)] mod tests`).
 *
 * The `podcasts` table already exists in `schema.sql`/`migrate.ts` (an
 * earlier batch created it, ready for whoever ported this module); nothing
 * here touches the schema.
 *
 * THE BUG THIS MODULE EXISTS FOR (see {@link stripSpeakerLabel}'s own doc):
 * a model states a turn's speaker twice — once as the `speaker` field, once
 * again inside the `line` text ("Ada: welcome in") — because that is what
 * dialogue looks like in its training data. Stripped at the read/write
 * boundary here, once, so a host never reads their own name aloud, the page
 * never prints the name twice, and the transcript never doubles it either.
 *
 * ESTABLISHED CONVENTIONS reused from `util.ts`: `queryOpt`/`queryRows`/
 * `executeOne`, positional `?` placeholders (a Rust `?1`/`?2` reused across a
 * statement becomes the same JS value repeated in the params array — see
 * {@link savePodcast}), and `.raw()` row access by position matching Rust's
 * `r.get(i)`.
 *
 * `PodcastHost`/`PodcastTurn`/`Podcast` are NOT redeclared — they already
 * exist, field-for-field, in `../../shared/apiTypes.ts` (and
 * `../../shared/ipc-contract.ts` already pins `get_podcast`/`set_podcast_cast`'s
 * exact args/result shapes), the same convention `peaksTools.ts`'s `AudioPeaks`
 * import documents: importing rather than inventing a second copy that could
 * drift from what the (not-yet-wired) preload/viewer side already expects.
 *
 * `eqIgnoreAsciiCase` is a small local predicate, not imported from anywhere
 * (nothing in this port exports one yet) — this port's established convention
 * for a small shared predicate with no canonical home (see `organizeTools.ts`'s
 * local `extensionOf`).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { executeOne, queryOpt, type Row } from "./util.js";
import type { Podcast, PodcastHost, PodcastTurn } from "../../shared/apiTypes.js";

// Re-exported (see this module's own doc, above) so every import site in this
// directory can pull the types from here without a second import line.
export type { Podcast, PodcastHost, PodcastTurn };

// =====================================================================
// str::eq_ignore_ascii_case — ASCII-only folding
// =====================================================================

/** `str::eq_ignore_ascii_case` — ASCII-only folding. Deliberately NOT
 * `toLowerCase()`: JS folds the full Unicode table, so `K` (U+212A) would
 * equal `k`, which is not what Rust's byte-for-byte ASCII fold reports. */
function asciiLowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

export function eqIgnoreAsciiCase(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (asciiLowerCode(a.charCodeAt(i)) !== asciiLowerCode(b.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

// =====================================================================
// strip_speaker_label — the bug fix
// =====================================================================

/** Decoration a model wraps a speaker label in: `**Ada:**`, `[Ada]:`,
 * `> Ada:`. Ported verbatim from `DECOR`. */
const DECOR = new Set(["*", "_", "[", "]", "#", ">", '"', "'", "“", "”", " ", "\t"]);

/** A speaker label is short. Past this (in UTF-8 BYTES, matching Rust's
 * `char_indices` bound), a colon belongs to prose. */
const MAX_LABEL_BYTES = 48;

function trimStartDecor(s: string): string {
  let i = 0;
  while (i < s.length && DECOR.has(s[i] as string)) {
    i++;
  }
  return s.slice(i);
}

function trimDecor(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && DECOR.has(s[start] as string)) {
    start++;
  }
  while (end > start && DECOR.has(s[end - 1] as string)) {
    end--;
  }
  return s.slice(start, end);
}

/** `char::is_whitespace()`-equivalent leading trim — Unicode `White_Space`,
 * not just ASCII `\s`. Used only for `line.trim_start()`. */
function trimStartUnicode(s: string): string {
  return s.replace(/^\p{White_Space}+/u, "");
}

/**
 * Byte length of a leading `Name:` run, or `null` if the line doesn't open
 * with this speaker's own name. Ported verbatim from `label_len`, tracking
 * BOTH the UTF-8 byte offset (Rust's `take_while` bound) and the UTF-16
 * string index (what `text.slice()` needs) as it scans, so the returned
 * index is a JS string index used consistently by {@link stripSpeakerLabel}.
 */
function labelColon(text: string): number | null {
  let byteIdx = 0;
  let strIdx = 0;
  for (const ch of text) {
    if (byteIdx > MAX_LABEL_BYTES) {
      break;
    }
    if (ch === ":") {
      return strIdx;
    }
    byteIdx += Buffer.byteLength(ch, "utf8");
    strIdx += ch.length;
  }
  return null;
}

function labelMatchesSpeaker(prefix: string, name: string): boolean {
  if (prefix === "") {
    return false;
  }
  const firstWord = name.split(/\p{White_Space}+/u).find((word) => word !== "") ?? name;
  return eqIgnoreAsciiCase(prefix, name) || eqIgnoreAsciiCase(prefix, firstWord);
}

function labelLen(text: string, speaker: string): number | null {
  const name = speaker.trim();
  if (name === "") {
    return null;
  }
  const colonAt = labelColon(text);
  if (colonAt === null) {
    return null;
  }
  const prefix = trimDecor(text.slice(0, colonAt));
  return labelMatchesSpeaker(prefix, name) ? colonAt + 1 : null;
}

/**
 * Drop a leading `Speaker:` label from a line — see this module's own doc
 * for the bug this exists to fix. Only ever strips a prefix that matches
 * THIS turn's own speaker (case-insensitively, ASCII-only), or that
 * speaker's first word, so an ordinary sentence containing a colon survives
 * untouched. Ported verbatim from `strip_speaker_label`.
 *
 * A line that is ONLY a label strips to `""`; callers decide what that
 * means.
 */
export function stripSpeakerLabel(line: string, speaker: string): string {
  let text = trimStartUnicode(line);
  // Bounded, not unbounded: `Ada: Ada: hi` is real (a re-generated script fed
  // its own previous output), but an unbounded loop on adversarial input is
  // not worth it.
  for (let i = 0; i < 2; i++) {
    const n = labelLen(text, speaker);
    if (n === null) {
      break;
    }
    text = trimStartDecor(text.slice(n));
  }
  return text;
}

/** Strip every turn's own speaker label, in place. A line that is nothing
 * BUT a label keeps its original text. Ported verbatim from
 * `strip_speaker_labels`. */
export function stripSpeakerLabels(turns: PodcastTurn[]): void {
  for (const t of turns) {
    const cleaned = stripSpeakerLabel(t.line, t.speaker);
    if (cleaned !== "") {
      t.line = cleaned;
    }
  }
}

// =====================================================================
// the table
// =====================================================================

/** Parse a `turns` JSON column the way `serde_json::from_str::<Vec<
 * PodcastTurn>>(..).unwrap_or_default()` does: not just "is it an array",
 * but "does every item have the required shape" — one malformed item fails
 * the WHOLE deserialization in Rust (a derived `Deserialize` on `Vec<T>`),
 * so this reports the whole column as empty rather than dropping just that
 * item. A row whose JSON will not parse this way is treated as an EMPTY
 * script rather than as a failed read (`podcast_row`'s own comment: the page
 * is still in the library and still opens; what is lost is the ability to
 * record it). */
function parseJsonArray(raw: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function turnFrom(item: unknown): PodcastTurn | null {
  const value = objectRecord(item);
  if (value === null) {
    return null;
  }
  const speaker = requiredString(value, "speaker");
  const line = requiredString(value, "line");
  return speaker === null || line === null ? null : { speaker, line };
}

function parseTurnsColumn(raw: string): PodcastTurn[] {
  const parsed = parseJsonArray(raw);
  if (parsed === null) {
    return [];
  }
  const out: PodcastTurn[] = [];
  for (const item of parsed) {
    const turn = turnFrom(item);
    if (turn === null) {
      return [];
    }
    out.push(turn);
  }
  return out;
}

/** Same shape-validating parse as {@link parseTurnsColumn}, for the
 * `cast_json` column (`Vec<PodcastHost>` — `name` required, the rest
 * `#[serde(default)]`). */
function objectRecord(item: unknown): Record<string, unknown> | null {
  return typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
}

function requiredString(value: Record<string, unknown>, name: string): string | null {
  const field = value[name];
  return typeof field === "string" ? field : null;
}

function optionalHostField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  return typeof field === "string" ? field : "";
}

function castHostFrom(item: unknown): PodcastHost | null {
  const value = objectRecord(item);
  if (value === null) {
    return null;
  }
  const name = requiredString(value, "name");
  if (name === null) {
    return null;
  }
  return {
    name,
    voice: optionalHostField(value, "voice"),
    rate: optionalHostField(value, "rate"),
    pitch: optionalHostField(value, "pitch"),
  };
}

function parseCastColumn(raw: string): PodcastHost[] {
  const parsed = parseJsonArray(raw);
  if (parsed === null) {
    return [];
  }
  const out: PodcastHost[] = [];
  for (const item of parsed) {
    const host = castHostFrom(item);
    if (host === null) {
      return [];
    }
    out.push(host);
  }
  return out;
}

function podcastRow(r: Row): Podcast {
  // On the way OUT as well as in, so scripts written before the label strip
  // existed are fixed where they are read instead of needing a migration.
  const turns = parseTurnsColumn(r[2] as string);
  stripSpeakerLabels(turns);
  return {
    fileId: r[0] as string,
    title: r[1] as string,
    turns,
    cast: parseCastColumn(r[3] as string),
    audioFileId: r[4] as string | null,
    createdAt: r[5] as string,
  };
}

/** The podcast belonging to a script page, if it has one. `null` covers two
 * real cases the caller must not conflate with an error: a file that is not
 * a podcast at all, and a podcast PAGE generated before this table existed
 * (or by the old HTML-authoring path), which has no turns to record. Ported
 * verbatim from `get_podcast`. */
export function getPodcast(db: Database.Database, fileId: string): Podcast | null {
  return queryOpt(
    db,
    "SELECT file_id, title, turns, cast_json, audio_file_id, created_at FROM podcasts WHERE file_id = ?",
    [fileId],
    podcastRow
  );
}

/** Store (or replace) a script's structure. Called by the studio's
 * `after_save` hook with the model's own JSON already parsed. Ported
 * verbatim from `save_podcast`. */
export function savePodcast(
  db: Database.Database,
  fileId: string,
  title: string,
  turns: readonly PodcastTurn[],
  cast: readonly PodcastHost[]
): void {
  const turnsJson = JSON.stringify(turns);
  const castJson = JSON.stringify(cast);
  executeOne(
    db,
    `INSERT INTO podcasts(file_id, title, turns, cast_json, audio_file_id)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(file_id) DO UPDATE SET title = ?, turns = ?, cast_json = ?`,
    [fileId, title, turnsJson, castJson, title, turnsJson, castJson]
  );
}

/** Replace the cast — the user re-casting a host, or changing a voice.
 * Deliberately does NOT clear `audio_file_id` (see the Rust source's own
 * comment: the previously rendered episode is still a real file the user may
 * be listening to). Ported verbatim from `set_podcast_cast`. */
export function setPodcastCast(db: Database.Database, fileId: string, cast: readonly PodcastHost[]): void {
  const castJson = JSON.stringify(cast);
  executeOne(db, "UPDATE podcasts SET cast_json = ? WHERE file_id = ?", [castJson, fileId]);
}

/** Point a script at the episode that was rendered from it. Ported verbatim
 * from `set_podcast_audio`. */
export function setPodcastAudio(db: Database.Database, fileId: string, audioFileId: string): void {
  executeOne(db, "UPDATE podcasts SET audio_file_id = ? WHERE file_id = ?", [audioFileId, fileId]);
}

/**
 * Build the opening cast from a script's turns: one host per DISTINCT
 * speaker (case/whitespace-insensitive), each handed the next unused voice
 * from `available` (best-first) so no two hosts share a voice. An empty
 * catalog yields hosts with empty voice ids ("the product default"). Ported
 * verbatim from `cast_from_turns`.
 */
export function castFromTurns(turns: readonly PodcastTurn[], available: readonly string[]): PodcastHost[] {
  const hosts: PodcastHost[] = [];
  for (const t of turns) {
    const name = t.speaker.trim();
    if (name === "") {
      continue;
    }
    if (hosts.some((h) => eqIgnoreAsciiCase(h.name, name))) {
      continue;
    }
    const voice = available[hosts.length] ?? "";
    hosts.push({ name, voice, rate: "", pitch: "" });
  }
  return hosts;
}

/** Fold every turn's speaker onto the cast's spelling of that name, in
 * place — the join key every voice lookup, transcript label and panel
 * preview depends on. Ported verbatim from `normalize_turn_speakers`. */
export function normalizeTurnSpeakers(turns: PodcastTurn[], cast: readonly PodcastHost[]): void {
  for (const t of turns) {
    const host = cast.find((h) => eqIgnoreAsciiCase(h.name, t.speaker.trim()));
    if (host !== undefined) {
      t.speaker = host.name;
    }
  }
}
