use crate::commands::{Chat, FileMeta, FileVersion, Folder, Memory, Message, TrashedFile};
use crate::extraction;
use rusqlite::{params, Connection};
use uuid::Uuid;

// A3 recovery-key crypto. aes-gcm 0.10 / pbkdf2 0.12 / rand 0.8 are added to
// Cargo.toml by the CONFIG track; base64 0.22 + sha2 0.10 already ship.
use aes_gcm::aead::{AeadInPlace, KeyInit, Nonce, Tag};
use aes_gcm::Aes256Gcm;
use base64::{engine::general_purpose::STANDARD, Engine};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;

mod artifacts;
mod browse;
mod chats;
mod embeddings;
mod files;
mod folders;
mod jobs;
mod memories;
mod messages;
mod meta;
mod privacy;
mod recordings;
mod schema;
mod settings;
mod skills;
mod util;
mod versions;
mod web_cache;
mod workflows;

pub use artifacts::*;
pub use browse::*;
pub use chats::*;
pub use embeddings::*;
pub use files::*;
pub use folders::*;
pub use jobs::*;
pub use memories::*;
pub use messages::*;
pub use meta::*;
pub use privacy::*;
pub use recordings::*;
pub use schema::*;
pub use settings::*;
pub use skills::*;
pub(crate) use util::*;
pub use versions::*;
pub use web_cache::*;
pub use workflows::*;

// ==================================================================
// Room-persistence CRUD. Everything below is the only place raw SQL
// against these tables should live — commands.rs calls these functions
// instead of issuing SQL of its own.
// ==================================================================

/// Target chunk size (chars) for the room's keyword search index.
const CHUNK_TARGET_CHARS: usize = 1200;
/// HLT-4: hard cap on chunks indexed per file. A file that hits it is only
/// partially searchable; `FileMeta.partially_indexed` surfaces that live via a
/// chunk-count check, so this cap and that flag must agree.
/// Was 2000 (~2M chars) — a 1,200-page Hebrew Bible overflowed it and its
/// last books (קהלת!) silently missed the index. 20,000 chunks ≈ 20M chars
/// covers any real document; indexing stays seconds, and the flag still
/// guards the truly pathological.
pub const CHUNK_CAP: usize = 20_000;

/// Column list shared by every FileMeta query: the base row plus folder_id and
/// a live chunk count for `partially_indexed` (HLT-4). Kept as one constant so
/// the row mapper's indices always line up with the SELECT.
pub(crate) const FILE_META_COLS: &str = "f.id, f.name, f.mime_type, f.size_bytes, f.source, \
     f.extracted_text, f.created_at, f.folder_id, \
     (SELECT count(*) FROM chunks WHERE file_id = f.id), f.origin_url";

/// Trash: the clause that makes a query mean "files that are in this room".
/// Written once so the dozens of listing/search/count queries that must exclude
/// deleted files all say the same thing, and so grepping for `NOT_TRASHED`
/// finds every one of them.
///
/// Assumes the `files` table is aliased `f` — the shape `FILE_META_COLS`
/// already forces. Queries that don't alias spell the clause out inline.
pub(crate) const NOT_TRASHED: &str = "f.trashed_at IS NULL";

pub(crate) fn file_meta_row(row: &rusqlite::Row) -> rusqlite::Result<FileMeta> {
    let chunk_count: i64 = row.get(8)?;
    Ok(FileMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        mime_type: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        size_bytes: row.get(3)?,
        source: row.get(4)?,
        has_text: row.get::<_, Option<String>>(5)?.is_some(),
        created_at: row.get(6)?,
        folder_id: row.get(7)?,
        // HLT-4: hitting the cap means only the first part is searchable.
        partially_indexed: chunk_count >= CHUNK_CAP as i64,
        // BROWSE-3: where this file came from, when it came over the network.
        // The column has been written since BROWSE-2 and read by nothing —
        // provenance is only useful if the UI can show it.
        origin_url: row.get(9)?,
    })
}

/// Chunk `text` (if any) into the search index for `file_id`. Hebrew
/// nikud/cantillation are stripped first: the FTS tokenizer (unicode61)
/// treats those combining marks as separators, so pointed words would index
/// as single-letter fragments no plain query can ever match (קהלת vs קֹהֶלֶת).
///
/// Trash: a TRASHED file's chunks are written to `trashed_chunks` instead of
/// the live index. This is not a detail — the background OCR and transcription
/// workers finish long after the import that queued them, and a file deleted in
/// the meantime would otherwise have its freshly extracted text indexed into a
/// room that is no longer showing the file. Routing here (rather than at the
/// three call sites) keeps the invariant the retrieval queries depend on —
/// `chunks` holds only the text of files that are IN the room — true by
/// construction. It also keeps the stash current, so a restore months later
/// brings back the text the file actually has, not the text it had when it was
/// deleted.
pub(crate) fn insert_chunks(conn: &Connection, file_id: &str, text: Option<&str>) -> Result<(), String> {
    if let Some(text) = text {
        // A missing row reads as "not trashed": the only caller that can be in
        // that position is `insert_file`, which has just written the row.
        let trashed: bool = conn
            .query_row(
                "SELECT trashed_at IS NOT NULL FROM files WHERE id = ?1",
                [file_id],
                |r| r.get(0),
            )
            .unwrap_or(false);
        let sql = if trashed {
            "INSERT INTO trashed_chunks(id, file_id, seq, text) VALUES (?1, ?2, ?3, ?4)"
        } else {
            "INSERT INTO chunks(id, file_id, seq, text) VALUES (?1, ?2, ?3, ?4)"
        };
        let text = extraction::strip_hebrew_marks(text);
        // A book-length import is up to CHUNK_CAP rows, and each row also fires
        // the `chunks_fts_ai` trigger. One autocommitted `execute` per chunk
        // means one fsync per chunk — seconds of import turned into minutes —
        // and a crash part-way through left the file HALF-indexed, which reads
        // as "the search index has this document" while most of it is missing.
        // A SAVEPOINT (not BEGIN: `commit_plans` and `restore_file_version`
        // already hold a transaction when they reach here, and SAVEPOINTs nest)
        // makes the whole chunking one atomic, one-fsync unit, and a prepared
        // statement is compiled once rather than per row.
        let sp = format!("chunk_{}", Uuid::new_v4().simple());
        conn.execute_batch(&format!("SAVEPOINT \"{sp}\"")).map_err(|e| e.to_string())?;
        let written = (|| -> Result<(), String> {
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            for (seq, chunk) in extraction::chunk_text(&text, CHUNK_TARGET_CHARS)
                .into_iter()
                .take(CHUNK_CAP)
                .enumerate()
            {
                stmt.execute(params![
                    Uuid::new_v4().to_string(),
                    file_id,
                    seq as i64,
                    chunk
                ])
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        match written {
            Ok(()) => {
                conn.execute_batch(&format!("RELEASE \"{sp}\"")).map_err(|e| e.to_string())?;
            }
            Err(e) => {
                // Roll the partial index back so "indexed" never half-means it.
                let _ = conn
                    .execute_batch(&format!("ROLLBACK TO \"{sp}\"; RELEASE \"{sp}\""));
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Drop a file's search chunks from BOTH the live index and the trash stash,
/// ahead of re-indexing it. Every content rewrite goes through here: clearing
/// only `chunks` would leave a trashed file's stash holding the text it had
/// when it was deleted, and a restore would put that stale text back into the
/// index beside the file's real, newer content.
pub(crate) fn clear_chunks(conn: &Connection, file_id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM chunks WHERE file_id = ?1", [file_id])?;
    execute_one(conn, "DELETE FROM trashed_chunks WHERE file_id = ?1", [file_id])
}

/// Today's date as YYYY-MM-DD, from SQLite so it matches stored timestamps.
pub fn current_date(conn: &Connection) -> String {
    conn.query_row("SELECT strftime('%Y-%m-%d','now')", [], |r| r.get(0))
        .unwrap_or_default()
}

/// Resolve a model-supplied file name (or fragment) to the newest match.
/// Lowercases `fragment` itself; the error message keeps the original case.
/// ADD-22: a short "(Files in this room: …)" hint appended to file-not-found
/// errors, so a small model can correct the name from the real list instead of
/// guessing again. Best-effort; capped so it never bloats the tool result.
pub(crate) fn file_names_hint(conn: &Connection) -> String {
    let names: Vec<String> = conn
        .prepare("SELECT name FROM files WHERE trashed_at IS NULL ORDER BY created_at DESC LIMIT 10")
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();
    if names.is_empty() {
        " This room has no files yet.".to_string()
    } else {
        format!(" Files in this room: {}.", names.join(", "))
    }
}

/// True when `table` has a column named `column` (used to guard ALTER TABLE
/// migrations so they run exactly once).
pub(crate) fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(cols.iter().any(|c| c == column))
}

/// True when a table (or virtual table) named `name` exists.
pub(crate) fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
            [name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

/// CHG-33: normalize a search query for cache keying — lowercase, trim, collapse
/// internal whitespace — so exact repeats and case/spacing variants share a row.
/// The key used to be namespaced by provider+endpoint, from when a room could
/// point at one of several engines; there is only one search provider now, so the
/// query alone identifies the row. Rows written by the old scheme simply never
/// match again and age out on the 15-minute TTL.
pub(crate) fn search_key(query: &str) -> String {
    query.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Fresh in-memory DB with the current SCHEMA — same statements a new room
/// runs, so it exercises the folders table, folder_id column, and the FTS5
/// virtual table + triggers. Shared by the submodule unit tests.
#[cfg(test)]
pub(crate) fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

#[cfg(test)]
pub(crate) fn add_file(conn: &Connection, name: &str, text: &str) -> String {
    insert_file(conn, name, "text/plain", text.as_bytes(), Some(text), "upload")
        .unwrap()
        .id
}

/// A unique throwaway room path in the OS temp dir (a real SQLCipher file).
#[cfg(test)]
pub(crate) fn temp_room_path() -> String {
    std::env::temp_dir()
        .join(format!("pr-test-{}.room", uuid::Uuid::new_v4()))
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_chunking_leaves_no_half_indexed_file() {
        // CHG: chunking used to be one autocommitted INSERT per chunk, so a
        // failure (or a crash) part-way through left the earlier chunks in the
        // index — the file read as searchable while most of it was missing.
        let conn = mem();
        let id = insert_file(&conn, "a.txt", "text/plain", b"x", None, "upload").unwrap().id;
        // Fail on the 5th chunk, the way an interrupted import would.
        conn.execute_batch(
            "CREATE TEMP TRIGGER fail_late BEFORE INSERT ON chunks WHEN NEW.seq = 4 \
             BEGIN SELECT RAISE(ABORT, 'interrupted'); END;",
        )
        .unwrap();
        let long = "word ".repeat(CHUNK_TARGET_CHARS * 6 / 5);
        assert!(insert_chunks(&conn, &id, Some(&long)).is_err());
        let left: i64 = conn
            .query_row("SELECT count(*) FROM chunks WHERE file_id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "a failed chunking must leave the file un-indexed, not half-indexed");
    }

    #[test]
    fn chunking_nests_inside_a_caller_transaction() {
        // `commit_plans` / `restore_file_version` already hold BEGIN IMMEDIATE
        // when they reach here, so the batching must be a SAVEPOINT, not BEGIN.
        let conn = mem();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        let id = insert_file(&conn, "b.txt", "text/plain", b"x", None, "upload").unwrap().id;
        let long = "word ".repeat(CHUNK_TARGET_CHARS * 6 / 5);
        insert_chunks(&conn, &id, Some(&long)).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM chunks WHERE file_id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert!(n >= 2, "expected several chunks, got {n}");
    }
}
