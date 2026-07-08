# The `.roomai` file format — v1

A `.roomai` file **is** a Private Room. There is no other state: your files,
your chats, the AI's memory, generated documents, settings — everything a room
holds lives inside this one file. Copy it, back it up, or AirDrop it, and you
have moved the whole workspace.

This document describes the format so that anyone — not just this app — can
open, verify, and read a room they hold the password for. The format is meant
to outlive the app: if this project ever disappears, the spec below plus the
`roomai` command-line tool (both open) are enough to get your data back.

- **Status:** stable v1 (`format_version = 1`).
- **Reference implementation:** the Private Room app and the `roomai` CLI, both
  built from the same Rust code in this repository (`src-tauri/src/db.rs`).
  They are the source of truth; where prose and code disagree, the code wins.

---

## 1. The container

A `.roomai` file is a single **[SQLCipher](https://www.zetetic.net/sqlcipher/)
database** — an ordinary SQLite database with every page encrypted with
**AES-256**. There is no wrapper, no archive, no extra header of our own. Read
the raw bytes without the key and you get noise; there is nothing to see.

- **Key.** The database key is your room password. SQLCipher derives the actual
  encryption key from it internally (PBKDF2). The app never stores the password.
- **Cipher parameters are pinned.** On both create and open, the app runs:

  ```sql
  PRAGMA cipher_compatibility = 4;
  ```

  This pins the room to the **SQLCipher 4 default parameter set** (AES-256,
  HMAC page authentication, PBKDF2 key derivation). Pinning it explicitly means
  a future SQLCipher release that changes its own defaults can still open older
  rooms — the file says which parameters it was written with, so nothing is
  silently misread.
- **Foreign keys** are enabled per connection (`PRAGMA foreign_keys = ON`), so
  deleting a file cascades to its chunks and versions.
- **`PRAGMA user_version`** is used internally as a small migration counter
  (currently `1`). Openers should not rely on it as a format version — use the
  `meta` table below for that.

Opening a room is: open the SQLite file → apply the key → `PRAGMA
cipher_compatibility = 4` → run one read (a wrong key fails here as
"file is not a database") → confirm `meta.format = 'roomai'`.

---

## 2. The `meta` table

`meta` is a plain key/value table that identifies the file and records how it
was built.

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

| Key | Written | Meaning |
|---|---|---|
| `format` | always, at create | Always `roomai`. An opener should refuse a file where this is missing or different. |
| `format_version` | always, at create | Currently `1`. Bumped only for a breaking change to the format. |
| `name` | always, at create | The room's display name. |
| `embed_model` | once the room is embedded | The embedding model used for semantic search, e.g. `nomic-embed-text`. **Absent** in a fresh room or a keyword-only room that has never been embedded. |
| `embed_dim` | once the room is embedded | The embedding dimension as a string, e.g. `768`. Lets a reader validate the `chunks.embedding` blobs. |

`embed_model` / `embed_dim` are stamped the first time embeddings are computed.
Treat them as advisory: their absence just means "this room has no vectors
yet", and keyword search still works.

---

## 3. Core tables

Every table below is created with `CREATE TABLE IF NOT EXISTS`, and schema
changes for older rooms are applied by a `migrate()` step on open, so a room
made by an older app keeps working. An opener should be tolerant: treat missing
optional tables/columns as empty, not as corruption.

### `folders` — one flat level of folders
```sql
CREATE TABLE folders (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
```
A file's `folder_id` is `NULL` at the top level. There is no nesting in v1.

### `files` — the documents in the room
```sql
CREATE TABLE files (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  mime_type      TEXT,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'upload',   -- e.g. 'upload', 'generated', 'web'
  original_bytes BLOB,                             -- the file's exact bytes
  extracted_text TEXT,                             -- text pulled out for search
  folder_id      TEXT,                             -- NULL = top level
  ai_summary     TEXT,                             -- cached one-line "what is this", or NULL
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```
`original_bytes` is the byte-exact original — an export of it is identical to
what was imported. `extracted_text` is a best-effort text layer (from a Rust
extractor, on-device OCR, or transcription) used for search; it may be `NULL`.
`ai_summary` is a cache that is cleared to `NULL` whenever the file's content
changes.

### `chunks` — the search index (rows), and `chunks_fts` (index)
```sql
CREATE TABLE chunks (
  id        TEXT PRIMARY KEY,
  file_id   TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,       -- order within the file
  text      TEXT NOT NULL,          -- the chunk's text
  embedding BLOB                    -- optional; see §4
);
CREATE INDEX idx_chunks_file ON chunks(file_id);

-- Full-text index over chunk text. External-content FTS5: the terms live here,
-- the rows live in `chunks`. Porter stemming so 'invoices' matches 'invoice'.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, content='chunks', content_rowid='rowid', tokenize='porter unicode61'
);
-- Triggers keep chunks_fts in sync on every INSERT / UPDATE / DELETE of chunks.
```
`chunks` is derived data: it is rebuilt from `files.extracted_text`, so a reader
that only wants documents can ignore it. `chunks_fts` is a standard FTS5
external-content table kept in sync by triggers; do not write to it directly.

### `chats` and `messages` — conversation history
```sql
CREATE TABLE chats (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT,                  -- NULL only in very old rooms (migrated on open)
  role       TEXT NOT NULL,         -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  sources    TEXT,                  -- JSON array of source labels (file names), or NULL
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_messages_chat ON messages(chat_id);
```
`sources` is a JSON-encoded array of strings — the files an answer was grounded
in. Older rooms may hold messages with a `NULL` `chat_id`; the app adopts these
into a legacy chat on open.

### `memories` — facts the AI is always given
```sql
CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

### `file_versions` — undo history for edits
```sql
CREATE TABLE file_versions (
  id       TEXT PRIMARY KEY,
  file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  bytes    BLOB NOT NULL,          -- the file's previous bytes
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  cause    TEXT NOT NULL           -- why the snapshot was taken
);
CREATE INDEX idx_file_versions_file ON file_versions(file_id);
```
The previous bytes of a file are snapshotted here before each overwrite, so any
edit can be undone. Snapshots are dropped when the file is deleted.

### `web_pages` — offline copies of imported links
```sql
CREATE TABLE web_pages (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  title         TEXT,
  raw_html      BLOB,
  readable_text TEXT,
  saved_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_web_pages_url ON web_pages(url);   -- one cached copy per URL
```

### `settings` — per-room preferences
```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```
Per-room settings (model, temperature, custom instructions, Touch ID, online
features, the room's role, whether the room-as-MCP-server switch is on, and so
on). Keys are an app-level concern and may grow between versions; an opener that
does not recognise a key should leave it alone.

> **Transient caches.** A room may also contain small cache tables such as
> `web_searches` (short-lived web-search results, keyed by query). These are
> disposable — safe to ignore, and safe to drop.

---

## 4. The embedding blob format

When present, `chunks.embedding` is a vector encoded as a **contiguous array of
little-endian IEEE-754 `f32` values** — 4 bytes per dimension, no header. A blob
whose length is not a whole multiple of 4 is treated as absent. The number of
dimensions is recorded in `meta.embed_dim` (e.g. `768` for `nomic-embed-text`).
Embeddings are optional and derived: keyword (FTS5) search works without them.

---

## 5. The optional `.recovery` sidecar

A room's password is the only key, and it is never stored inside the encrypted
database (a copy of the key cannot live in the thing it unlocks). Recovery is
therefore **opt-in and lives in a separate file** next to the room:

```
Case.roomai            ← the room (encrypted)
Case.roomai.recovery   ← optional recovery sidecar (this file)
```

The sidecar is small JSON:

```json
{ "v": 1, "salt": "<base64>", "nonce": "<base64>", "ct": "<base64>" }
```

It holds the room password, wrapped under a human recovery code:

- **Recovery code** — a 30-character code shown to you once at creation,
  written as 6 groups of 4 uppercase characters separated by dashes
  (e.g. `K7QF-3M2X-…`). Normalize it before use: strip spaces and dashes and
  uppercase it.
- **Key derivation** — `key = PBKDF2-HMAC-SHA256(recovery_code, salt, 200000
  iterations, 32 bytes)`.
- **Wrap** — `ct = AES-256-GCM(key, nonce, plaintext = room password as UTF-8)`.

To recover: read the sidecar, derive the key from the recovery code, AES-GCM
open `ct` to get the room password, then open the room normally with that
password. If there is no sidecar, the room simply has no recovery — that is a
valid, fully supported state. Delete the sidecar and recovery is gone; the room
itself is untouched.

The sidecar contains **no room content and no database key** — only a copy of
your password, and only readable with your recovery code. Lose both the password
and the recovery code and the room stays closed. There is no other way in.

---

## 6. Compatibility rules for openers

If you write a tool that reads `.roomai` files, follow these rules so you stay
compatible as the format grows:

1. **Check `meta.format = 'roomai'`** before trusting anything else.
2. **Respect `format_version`.** v1 tools should read any `format_version = 1`
   room. A higher version may contain things you do not understand — read what
   you recognise; do not assume corruption.
3. **Tolerate missing optional tables and columns.** Older rooms genuinely lack
   some of them; the reference implementation adds them on open.
4. **Treat `chunks`, `chunks_fts`, `ai_summary`, and `embedding` as derived.**
   They can always be rebuilt from `files`. Don't depend on them being present.
5. **Never write to `chunks_fts` directly** — go through `chunks` and let the
   triggers maintain the index.

The `roomai` CLI (`roomai verify` / `roomai info` / `roomai export`) is the
smallest such tool and a good worked example.
