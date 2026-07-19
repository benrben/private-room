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
    if real.len() < 2 {
        return Err("A protected detail needs at least 2 characters.".into());
    }
    if let Some(existing) = conn
        .query_row(
            "SELECT id, real_text, placeholder, category, source FROM privacy_entities
             WHERE lower(real_text) = lower(?1)",
            [real],
            entity_row,
        )
        .ok()
    {
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

/// Files with extracted text whose scan row is missing or stale for the given
/// rules hash. Returns (id, name, extracted_text) oldest-imported first, so a
/// long re-scan makes visible progress through the library in a stable order.
pub fn files_needing_privacy_scan(
    conn: &Connection,
    rules_sha256: &str,
) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, f.extracted_text FROM files f
             LEFT JOIN privacy_scans s ON s.file_id = f.id
             WHERE f.extracted_text IS NOT NULL AND length(f.extracted_text) > 0
               AND (s.file_id IS NULL OR s.rules_sha256 != ?1)
             ORDER BY f.created_at ASC, f.rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([rules_sha256], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
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
        set_privacy_scan(&conn, &fid, "t1", "r1").unwrap();
        assert!(files_needing_privacy_scan(&conn, "r1").unwrap().is_empty());
        // New rules hash → stale again.
        assert_eq!(files_needing_privacy_scan(&conn, "r2").unwrap().len(), 1);
    }

    #[test]
    fn short_entities_rejected() {
        let conn = db::mem();
        assert!(add_privacy_entity(&conn, " a ", "person", "user").is_err());
    }
}
