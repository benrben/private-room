/**
 * Chat messages, plus the search-term/LIKE-clause plumbing every other
 * "search this text" query in the room shares. Ported from
 * `src-tauri/src/db/messages.rs`.
 *
 * `likeEscape`/`searchTerms`/`likeAllClause` are not messages-specific, but
 * they live here because that is where the Rust source puts them — every
 * sibling module reaches them through `use super::*`, and all three of
 * `search_all`'s queries have to agree about what one needle means.
 * `memories.ts` (and, when it lands, `files.ts`) imports them from here.
 *
 * PLACEHOLDER STYLE: the Rust source binds with NUMBERED placeholders, and
 * `recent_messages` below reuses `?1` twice in one statement to bind
 * `chat_id` once for two occurrences. `better-sqlite3` cannot bind a plain
 * array against `?N` placeholders (see `util.ts`'s module comment), so every
 * query here uses anonymous `?` and a Rust `?1` occurring twice becomes two
 * `?`s with the SAME value repeated in the params array — same bind, same
 * behaviour, different spelling.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { executeOne, queryOne, queryRows, type Row } from "./util.js";

/**
 * Mirrors the Rust `Message` struct (`commands.rs`, `#[serde(rename_all =
 * "camelCase")]`) — the shape every message-returning function here hands
 * back.
 *
 * Deliberately NOT the `Message` in `shared/apiTypes.ts`: that one narrows
 * `effects` to `MessageEffects | null`, while the column (and Rust's field)
 * is a generic `serde_json::Value` carrying two different real payloads —
 * {@link insertMessage}'s viewer boxes/annotations and
 * {@link insertHandoffMessage}'s post-handoff token-usage snapshot. Narrowing
 * to one here would be a lie about the other. The frontend projection stays
 * the frontend's.
 */
export interface Message {
  id: string;
  role: string;
  content: string;
  sources: string[];
  createdAt: string;
  /** Structured viewer effects (boxes/annotation) produced by tools during
   * this turn — arbitrary parsed JSON, or `null`. Persisted in its own column
   * so `content` stays plain prose; never parsed back out of the text. */
  effects: unknown;
  /** Marks a non-ordinary row without repurposing `role` — today only
   * `"handoff"` (a context-compaction summary marker). `null` for every
   * ordinary user/assistant message. */
  kind: string | null;
}

// ------------------------------------------------------------- search plumbing

/** Escape the LIKE wildcards in a user's search text so `%` and `_` match
 * themselves. `%` and `_` are the only two characters SQLite's LIKE treats
 * specially, so searching "50%" silently matched every row containing "50",
 * and "a_b" matched "axb". Every `LIKE '%' || ? || '%'` query must pair this
 * with `ESCAPE '\'` — see {@link likeAllClause} for the shape. */
export function likeEscape(needle: string): string {
  let out = "";
  for (const ch of needle) {
    if (ch === "\\" || ch === "%" || ch === "_") {
      out += "\\";
    }
    out += ch;
  }
  return out;
}

/** How many words of a query are actually matched on. A query is a handful of
 * words; the cap only stops a pasted paragraph from building a statement with
 * a hundred `LIKE` clauses in it. Words past the cap are IGNORED, which widens
 * the result set — never narrows it — so nothing a user typed can silently
 * remove a row that the words we did use match. */
const MAX_SEARCH_TERMS = 8;

/** Rust's `str::split_whitespace()`: splits on runs of whitespace, yields no
 * empty tokens, and gives nothing at all for an empty or whitespace-only
 * string — unlike a naive `.split(/\s+/)`, which turns `""` into `[""]` and
 * would make a whitespace-only query a match-everything query.
 *
 * `\p{White_Space}` and NOT `\s`, because those are two different sets and
 * Rust splits on the first one — `char::is_whitespace` IS the Unicode
 * White_Space property. `\s` omits U+0085 NEL and adds U+FEFF, so a
 * `trim()` + `/\s+/u` pair disagreed with the Rust build in both directions:
 * a BOM pasted in from a file split one word into two, and NEL — a real line
 * break in text that came through a Latin-1 pipeline — did not split at all,
 * leaving one term no row could ever contain, which NARROWS the result set to
 * nothing. (The cap's own comment promises the opposite: what search does with
 * a word it cannot use is widen, never narrow.) The `.filter()` replaces the
 * `trim()` — leading and trailing separators produce empty tokens, which
 * `split_whitespace` does not yield. */
function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

/** The words a hit must contain, escaped and ready to bind.
 *
 * Search used to be ONE literal substring, so "diarisation speaker" found
 * nothing in a room full of "speaker diarisation" — the words were right and
 * the order was not. Splitting on whitespace and requiring ALL of them, in any
 * order, is what people already expect of a search box. A query with no
 * whitespace behaves exactly as it always did. */
export function searchTerms(needle: string): string[] {
  return splitWhitespace(needle).slice(0, MAX_SEARCH_TERMS).map(likeEscape);
}

/** `AND lower(<col>) LIKE …` once per term.
 *
 * Returned as SQL text rather than a fixed clause because the term count is
 * the user's, not ours. Every clause carries `ESCAPE '\'` — {@link searchTerms}
 * escapes the wildcards, and an escape without the clause does nothing.
 *
 * The Rust signature also takes `first_param`, because every clause there is
 * spelled `?{first_param + i}`. This port's placeholders are anonymous (see
 * the module comment), so there is nothing left for that argument to number
 * and it is DROPPED rather than kept as a no-op a future caller could mistake
 * for still doing something. Callers append `terms` to their params in order,
 * after whatever they already bound. */
export function likeAllClause(col: string, terms: readonly string[]): string {
  return terms.map(() => ` AND lower(${col}) LIKE '%' || ? || '%' ESCAPE '\\'`).join("");
}

// ------------------------------------------------------------------- messages

/** Parse JSON, or `null` if it is not valid JSON at all. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Rust's `serde_json::from_str::<Vec<String>>(s).ok()`: a value that is not
 * an array OF STRINGS fails to deserialize and is dropped. An array holding
 * numbers is not a `Vec<String>` there and must not be handed back as a
 * `string[]` here. */
function parseStringArray(raw: string): string[] | null {
  const parsed = tryParseJson(raw);
  if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
    return parsed as string[];
  }
  return null;
}

/** ADD-6: chat messages containing every word of `needle` (which the caller
 * has already lowercased — the column side is `lower(content)`), in any order
 * — [chat id, message id, content]. Orphan (`chat_id` NULL) rows are skipped.
 * The words are taken LITERALLY: their LIKE wildcards are escaped here, so
 * callers pass the user's raw text. */
export function messagesLike(
  db: Database.Database,
  needle: string
): Array<[string, string, string]> {
  const terms = searchTerms(needle);
  if (terms.length === 0) {
    return [];
  }
  const sql = `SELECT chat_id, id, content FROM messages WHERE chat_id IS NOT NULL${likeAllClause(
    "content",
    terms
  )}
     ORDER BY rowid DESC LIMIT 30`;
  return queryRows(db, sql, terms, (r) => [r[0] as string, r[1] as string, r[2] as string]);
}

/** The stamp the row's own `created_at` DEFAULT assigned it. */
function messageCreatedAt(db: Database.Database, id: string): string {
  return queryOne(db, "SELECT created_at FROM messages WHERE id = ?", [id], (r) => r[0] as string);
}

/** Insert a new message and return it (with the row's assigned timestamp).
 * `effects` is the structured viewer payload (boxes/annotation) for the turn,
 * stored as JSON in its own column — never folded into `content`, so the
 * transcript stays plain prose (ADD-23). Pass `null` for none. */
export function insertMessage(
  db: Database.Database,
  chatId: string,
  role: string,
  content: string,
  sources: readonly string[],
  effects: unknown
): Message {
  const id = randomUUID();
  const sourcesJson = JSON.stringify(sources);
  const effectsJson = effects === null || effects === undefined ? null : JSON.stringify(effects);
  executeOne(
    db,
    `INSERT INTO messages(id, chat_id, role, content, sources, effects)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, chatId, role, content, sourcesJson, effectsJson]
  );
  return {
    id,
    role,
    content,
    sources: [...sources],
    createdAt: messageCreatedAt(db, id),
    effects: effects ?? null,
    kind: null,
  };
}

/** Room map: the `sources` list of the newest `limit` answers that cited
 * anything, newest first — one array of file NAMES per message.
 *
 * Names, not ids, is what the column holds (see {@link insertMessage}), so the
 * caller has to resolve them and must expect misses: a renamed file, or a
 * second run that bumped a name to "X (2)", no longer matches the name the
 * answer was written with. An unresolved name is dropped, never guessed at —
 * and so is a row whose JSON does not deserialize, rather than failing the
 * whole call. */
export function recentMessageSources(db: Database.Database, limit: number): string[][] {
  const raw = queryRows(
    db,
    `SELECT sources FROM messages
     WHERE sources IS NOT NULL AND sources <> '' AND sources <> '[]'
     ORDER BY rowid DESC LIMIT ?`,
    [limit],
    (r) => r[0] as string
  );
  const out: string[][] = [];
  for (const s of raw) {
    const parsed = parseStringArray(s);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  return out;
}

/** A context-handoff summary marker: `role='assistant'` (so it renders and
 * counts like a normal reply everywhere that isn't handoff-aware) but
 * `kind='handoff'` marks it as the compaction point — {@link recentMessages}
 * starts a turn's history from the latest one, and the frontend renders it as
 * a distinct divider rather than an ordinary chat bubble. `effects` — same
 * shape as {@link insertMessage}'s — carries the post-handoff token-usage
 * snapshot (no LLM "ask" turn happens as part of a handoff, so no
 * `ask-token-usage` event would otherwise fire). */
export function insertHandoffMessage(
  db: Database.Database,
  chatId: string,
  summary: string,
  effects: unknown
): Message {
  const id = randomUUID();
  const effectsJson = effects === null || effects === undefined ? null : JSON.stringify(effects);
  executeOne(
    db,
    `INSERT INTO messages(id, chat_id, role, content, sources, kind, effects)
     VALUES (?, ?, 'assistant', ?, '[]', 'handoff', ?)`,
    [id, chatId, summary, effectsJson]
  );
  return {
    id,
    role: "assistant",
    content: summary,
    sources: [],
    createdAt: messageCreatedAt(db, id),
    effects: effects ?? null,
    kind: "handoff",
  };
}

function messageRow(r: Row): Message {
  const sourcesJson = r[3] as string | null;
  const effectsJson = r[5] as string | null;
  return {
    id: r[0] as string,
    role: r[1] as string,
    content: r[2] as string,
    sources: sourcesJson === null ? [] : (parseStringArray(sourcesJson) ?? []),
    createdAt: r[4] as string,
    effects: effectsJson === null ? null : tryParseJson(effectsJson),
    kind: r[6] as string | null,
  };
}

/** All messages for a chat, oldest first. */
export function listMessages(db: Database.Database, chatId: string): Message[] {
  return queryRows(
    db,
    `SELECT id, role, content, sources, created_at, effects, kind FROM messages
     WHERE chat_id = ? ORDER BY rowid ASC`,
    [chatId],
    messageRow
  );
}

/** ADD-9: delete one message by id (used by regenerate to drop the last
 * assistant reply before re-asking). */
export function deleteMessage(db: Database.Database, id: string): void {
  executeOne(db, "DELETE FROM messages WHERE id = ?", [id]);
}

/** The most recent `limit` (role, content) pairs for a chat, newest first —
 * callers reverse this to get chronological order for a prompt.
 *
 * Context handoff: if this chat has a `kind='handoff'` marker, history starts
 * there (that row's own content — the summary — included), not from the chat's
 * actual first message. So the model sees only the summary plus whatever came
 * after it, which is the entire point of "hand off" freeing up context. A chat
 * with no handoff marker is unaffected (falls back to 0, i.e. every row
 * qualifies). `limit` of `-1` is SQLite's own "no limit" — `#`-commands use it
 * to read the whole conversation. */
export function recentMessages(
  db: Database.Database,
  chatId: string,
  limit: number
): Array<[string, string]> {
  return queryRows(
    db,
    `SELECT role, content FROM messages
     WHERE chat_id = ?
       AND rowid >= COALESCE(
             (SELECT MAX(rowid) FROM messages WHERE chat_id = ? AND kind = 'handoff'),
             0)
     ORDER BY rowid DESC LIMIT ?`,
    [chatId, chatId, limit],
    (r) => [r[0] as string, r[1] as string]
  );
}

// TODO: replace with the real export once `files.ts` lands. `roomCounts`'
// file half is Rust's `room_file_count` (`src-tauri/src/db/files.rs`), which
// is a `db/files.rs` concern out of scope for this batch. This is a MINIMAL
// stand-in reproducing that function's exact one-line query — `count(*)` over
// `files f` with the shared `NOT_TRASHED` clause (`f.trashed_at IS NULL`, see
// the constant in `src-tauri/src/db.rs`) — duplicated rather than invented,
// only so `roomCounts` has something real to call. It is not new persistence.
function roomFileCountStub(db: Database.Database): number {
  return queryOne(
    db,
    "SELECT count(*) FROM files f WHERE f.trashed_at IS NULL",
    [],
    (r) => r[0] as number
  );
}

/** [file count, message count] for the room summary shown in RoomInfo.
 *
 * The file half is `room_file_count`, not a `count(*)` spelled out again
 * here: RoomInfo, the front page and the Library badge are all answering the
 * same question, so they ask it in one place. (Stubbed above until `files.ts`
 * lands.) */
export function roomCounts(db: Database.Database): [number, number] {
  const fileCount = roomFileCountStub(db);
  const messageCount = queryOne(db, "SELECT count(*) FROM messages", [], (r) => r[0] as number);
  return [fileCount, messageCount];
}
