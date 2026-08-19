use super::*;

/// PRIV-1: one protected entity — a real string that must never reach a
/// non-local model, and the stable placeholder that replaces it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyEntity {
    pub id: String,
    pub real_text: String,
    pub placeholder: String,
    pub category: String,
    pub source: String,
}

/// The display series per category. `concept` findings (user topic rules) get
/// the neutral "Private" series; everything else names its kind so the user
/// can read a redacted answer ("[Person A] met [Person B] at [Address A]").
fn series_for(category: &str) -> &'static str {
    match category {
        "person" => "Person",
        "address" => "Address",
        "phone" => "Phone",
        "email" => "Email",
        "id" => "ID",
        "org" => "Org",
        _ => "Private",
    }
}

/// A..Z, then AA..AZ, BA.. — stable, readable, never runs out.
fn letters(mut n: usize) -> String {
    let mut out = String::new();
    loop {
        out.insert(0, (b'A' + (n % 26) as u8) as char);
        n /= 26;
        if n == 0 {
            break;
        }
        n -= 1;
    }
    out
}

/// Insert `real_text` into the entity map, minting the next free placeholder in
/// its category's series. Case-insensitive duplicate of an existing entity
/// returns the existing row unchanged (a 'user' source upgrades a 'scan' row —
/// the block list is the stronger claim). Empty/whitespace text is rejected.
pub fn add_privacy_entity(
    conn: &Connection,
    real_text: &str,
    category: &str,
    source: &str,
) -> Result<PrivacyEntity, String> {
    let real = real_text.trim();
    // The redactor's own floor, counted the way the message states it and the
    // way the redactor applies it: in CHARACTERS. `real.len()` is bytes, so a
    // single Hebrew or accented letter passed a test its own error text said it
    // failed, and was stored as an item the panel lists as protected and
    // `Redactor::new` then discards.
    if !crate::commands::is_protectable(real) {
        return Err(format!(
            "A protected detail needs at least {} characters.",
            crate::commands::MIN_PROTECTED_CHARS
        ));
    }
    if let Some(existing) = find_entity_ignoring_case(conn, real)? {
        if source == "user" && existing.source != "user" {
            conn.execute(
                "UPDATE privacy_entities SET source = 'user' WHERE id = ?1",
                [&existing.id],
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(existing);
    }
    let series = series_for(category);
    // Next free letter in this series: count existing placeholders of the series.
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM privacy_entities WHERE placeholder LIKE ?1",
            [format!("[{series} %")],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut n = count as usize;
    let placeholder = loop {
        let candidate = format!("[{series} {}]", letters(n));
        let taken: i64 = conn
            .query_row(
                "SELECT count(*) FROM privacy_entities WHERE placeholder = ?1",
                [&candidate],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if taken == 0 {
            break candidate;
        }
        n += 1;
    };
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO privacy_entities(id, real_text, placeholder, category, source)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, real, placeholder, category, source],
    )
    .map_err(|e| e.to_string())?;
    Ok(PrivacyEntity {
        id,
        real_text: real.to_string(),
        placeholder,
        category: category.to_string(),
        source: source.to_string(),
    })
}

/// The existing entity whose real text is the same string ignoring case, if any.
///
/// Done in Rust rather than in SQL because SQLite's `lower()` only folds ASCII:
/// "JOSÉ MUÑOZ" did not match "José Muñoz", so one person became two rows with
/// two placeholders — the panel listed them twice and only one of the two was
/// ever emitted. The table is a hand-curated block list plus scan findings, so
/// reading it whole costs less than the correctness did.
fn find_entity_ignoring_case(
    conn: &Connection,
    real: &str,
) -> Result<Option<PrivacyEntity>, String> {
    let wanted = real.to_lowercase();
    let mut stmt = conn
        .prepare("SELECT id, real_text, placeholder, category, source FROM privacy_entities")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], entity_row).map_err(|e| e.to_string())?;
    for row in rows {
        let row = row.map_err(|e| e.to_string())?;
        if row.real_text.to_lowercase() == wanted {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

fn entity_row(row: &rusqlite::Row) -> rusqlite::Result<PrivacyEntity> {
    Ok(PrivacyEntity {
        id: row.get(0)?,
        real_text: row.get(1)?,
        placeholder: row.get(2)?,
        category: row.get(3)?,
        source: row.get(4)?,
    })
}

/// Every protected entity, user block-list rows first, then by recency.
pub fn list_privacy_entities(conn: &Connection) -> Result<Vec<PrivacyEntity>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, real_text, placeholder, category, source FROM privacy_entities
             ORDER BY source = 'user' DESC, created_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], entity_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn delete_privacy_entity(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM privacy_entities WHERE id = ?1", params![id])
}

/// Mark a SCAN-found entity "not private after all". The row stays (tombstone)
/// so a re-scan can't silently re-add it: the scanner's `known` list includes
/// dismissed reals, and the rule builder skips them.
pub fn dismiss_privacy_entity(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE privacy_entities SET source = 'dismissed' WHERE id = ?1",
        params![id],
    )
}

/// The scan bookkeeping row for one file, if any: (text_sha256, rules_sha256).
pub fn get_privacy_scan(conn: &Connection, file_id: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT text_sha256, rules_sha256 FROM privacy_scans WHERE file_id = ?1",
        [file_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .ok()
}

pub fn set_privacy_scan(
    conn: &Connection,
    file_id: &str,
    text_sha256: &str,
    rules_sha256: &str,
) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT INTO privacy_scans(file_id, text_sha256, rules_sha256, scanned_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(file_id) DO UPDATE SET
           text_sha256 = excluded.text_sha256,
           rules_sha256 = excluded.rules_sha256,
           scanned_at = excluded.scanned_at",
        params![file_id, text_sha256, rules_sha256],
    )
}

/// The digest stored in `privacy_scans.text_sha256`: sha256 hex of the exact
/// text that was scanned. ONE definition, because the writer
/// (`commands::privacy`, after a completed scan) and the staleness reader below
/// must agree byte for byte — two spellings of "hash the text" that drift mean
/// either re-scanning everything forever or never re-scanning anything.
pub fn privacy_text_sha(text: &str) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

/// Files with extracted text whose scan row is missing, or stale for the given
/// rules hash, or stale because THE TEXT ITSELF CHANGED since it was scanned.
/// Returns (id, name, extracted_text) oldest-imported first, so a long re-scan
/// makes visible progress through the library in a stable order.
///
/// THE BUG THIS EXISTS FOR: the scan row has always recorded the digest of the
/// text it read, and nothing ever compared it again — only the rules hash was
/// tested. So a file edited (or a recording re-transcribed) after its scan kept
/// its "this file is protected" row forever: new names, addresses and ID
/// numbers in it were never found, and went to a cloud model unhidden even
/// after pressing "Scan now". The stored digest is the only thing that can see
/// that, so it is now part of the staleness test.
///
/// The digest is recomputed rather than compared in SQL (SQLite has no sha256),
/// which costs one hash of every already-scanned file's text per call. That is
/// the deliberate trade: this runs on scan starts and on Settings/Home status
/// reads, not per keystroke, and the alternative — trusting a write-time
/// invalidation hook — is a promise every future writer of `extracted_text` has
/// to keep, which is exactly the kind of promise this door does not rely on.
pub fn files_needing_privacy_scan(
    conn: &Connection,
    rules_sha256: &str,
) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, f.extracted_text, s.rules_sha256, s.text_sha256 FROM files f
             LEFT JOIN privacy_scans s ON s.file_id = f.id
             WHERE f.trashed_at IS NULL
               AND f.extracted_text IS NOT NULL AND length(f.extracted_text) > 0
             ORDER BY f.created_at ASC, f.rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|(_, _, text, scanned_rules, scanned_text)| match (scanned_rules, scanned_text) {
            (Some(rules), Some(digest)) => {
                rules != rules_sha256 || *digest != privacy_text_sha(text)
            }
            // No scan row (or a half-written one): never scanned under any rules.
            _ => true,
        })
        .map(|(id, name, text, _, _)| (id, name, text))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn minting_walks_the_series_per_category() {
        let conn = db::mem();
        let a = add_privacy_entity(&conn, "Ben Reich", "person", "scan").unwrap();
        let b = add_privacy_entity(&conn, "Dana Levi", "person", "scan").unwrap();
        let c = add_privacy_entity(&conn, "12 Herzl St", "address", "scan").unwrap();
        assert_eq!(a.placeholder, "[Person A]");
        assert_eq!(b.placeholder, "[Person B]");
        assert_eq!(c.placeholder, "[Address A]");
    }

    #[test]
    fn duplicate_real_text_returns_existing_and_user_upgrades_scan() {
        let conn = db::mem();
        let a = add_privacy_entity(&conn, "Ben Reich", "person", "scan").unwrap();
        let b = add_privacy_entity(&conn, "ben reich", "person", "user").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(b.placeholder, "[Person A]");
        let all = list_privacy_entities(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].source, "user");
    }

    #[test]
    fn letters_series_goes_past_z() {
        assert_eq!(letters(0), "A");
        assert_eq!(letters(25), "Z");
        assert_eq!(letters(26), "AA");
        assert_eq!(letters(27), "AB");
    }

    #[test]
    fn scan_state_tracks_staleness() {
        let conn = db::mem();
        let fid = db::add_file(&conn, "a.txt", "Ben Reich's lease");
        assert_eq!(files_needing_privacy_scan(&conn, "r1").unwrap().len(), 1);
        set_privacy_scan(&conn, &fid, &privacy_text_sha("Ben Reich's lease"), "r1").unwrap();
        assert!(files_needing_privacy_scan(&conn, "r1").unwrap().is_empty());
        // New rules hash → stale again.
        assert_eq!(files_needing_privacy_scan(&conn, "r2").unwrap().len(), 1);
    }

    #[test]
    fn editing_a_scanned_file_restales_it() {
        // The leak this pins: a file scanned once stayed "protected" forever,
        // so names added to it afterwards reached a cloud model unhidden.
        let conn = db::mem();
        let fid = db::add_file(&conn, "a.txt", "nothing private here");
        set_privacy_scan(&conn, &fid, &privacy_text_sha("nothing private here"), "r1").unwrap();
        assert!(files_needing_privacy_scan(&conn, "r1").unwrap().is_empty());

        db::set_file_extracted_text(&conn, &fid, "now it names Dana Levi, 054-1234567").unwrap();
        let pending = files_needing_privacy_scan(&conn, "r1").unwrap();
        assert_eq!(pending.len(), 1, "an edited file must come back for a re-scan");
        assert_eq!(pending[0].0, fid);
        assert_eq!(pending[0].2, "now it names Dana Levi, 054-1234567");

        // Re-scanning the NEW text settles it again (no permanent re-scan loop).
        set_privacy_scan(
            &conn,
            &fid,
            &privacy_text_sha("now it names Dana Levi, 054-1234567"),
            "r1",
        )
        .unwrap();
        assert!(files_needing_privacy_scan(&conn, "r1").unwrap().is_empty());
    }

    #[test]
    fn a_half_written_scan_row_is_never_trusted() {
        // Belt and braces: an empty digest (older row, interrupted write) must
        // read as "not scanned", never as "scanned and unchanged".
        let conn = db::mem();
        let fid = db::add_file(&conn, "a.txt", "text");
        set_privacy_scan(&conn, &fid, "", "r1").unwrap();
        assert_eq!(files_needing_privacy_scan(&conn, "r1").unwrap().len(), 1);
    }

    #[test]
    fn short_entities_rejected() {
        let conn = db::mem();
        assert!(add_privacy_entity(&conn, " a ", "person", "user").is_err());
    }

    #[test]
    fn the_length_floor_counts_characters_not_bytes() {
        // One Hebrew letter is two BYTES, so the old `real.len() < 2` accepted
        // it while the error text promised a two-CHARACTER floor — and the
        // redactor then discarded the item the panel called protected.
        let conn = db::mem();
        assert!(add_privacy_entity(&conn, "א", "person", "user").is_err());
        assert!(add_privacy_entity(&conn, "אב", "person", "user").is_ok());
    }

    #[test]
    fn duplicates_are_folded_past_ascii() {
        // SQLite's lower() is ASCII-only, so this pair used to become two rows
        // with two placeholders for one person.
        let conn = db::mem();
        let a = add_privacy_entity(&conn, "José Muñoz", "person", "user").unwrap();
        let b = add_privacy_entity(&conn, "JOSÉ MUÑOZ", "person", "scan").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(b.placeholder, "[Person A]");
        assert_eq!(list_privacy_entities(&conn).unwrap().len(), 1);
    }
}
