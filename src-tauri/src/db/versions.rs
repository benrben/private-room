use super::*;

// ---------------------------------------------------------------- file versions (ADD-2)

/// Copy a file's CURRENT state into history before it is overwritten,
/// labelled with `cause`, then keep only the newest 10 versions for that
/// file. The snapshot is compound — bytes, extracted text, and any recording
/// meta — because for a Recording the bytes are the unchanged WAV and what
/// is being replaced IS the transcript: restoring bytes alone could never
/// bring the old words, speakers, or cuts back. A file with no stored bytes
/// yet (nothing to preserve) is a no-op.
pub fn snapshot_file_version(conn: &Connection, file_id: &str, cause: &str) -> Result<(), String> {
    let current: Option<(Option<Vec<u8>>, Option<String>)> = conn
        .query_row(
            "SELECT original_bytes, extracted_text FROM files WHERE id = ?1",
            [file_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((Some(bytes), text)) = current else { return Ok(()) };
    let rec_meta: Option<String> = conn
        .query_row("SELECT meta FROM recordings WHERE file_id = ?1", [file_id], |r| r.get(0))
        .ok();
    conn.execute(
        "INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![Uuid::new_v4().to_string(), file_id, bytes, text, rec_meta, cause],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM file_versions WHERE file_id = ?1 AND id NOT IN (
           SELECT id FROM file_versions WHERE file_id = ?1
           ORDER BY saved_at DESC, rowid DESC LIMIT 10)",
        [file_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A file's saved versions, newest first.
pub fn list_file_versions(conn: &Connection, file_id: &str) -> Result<Vec<FileVersion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, saved_at, cause FROM file_versions WHERE file_id = ?1
             ORDER BY saved_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([file_id], |r| {
            Ok(FileVersion {
                id: r.get(0)?,
                saved_at: r.get(1)?,
                cause: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// One saved version's full snapshot: (owning file id, bytes, extracted
/// text, recording meta). Text/meta are None on rows saved before the
/// compound snapshot existed.
pub fn get_version(
    conn: &Connection,
    version_id: &str,
) -> Result<(String, Vec<u8>, Option<String>, Option<String>), String> {
    conn.query_row(
        "SELECT file_id, bytes, text, rec_meta FROM file_versions WHERE id = ?1",
        [version_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .map_err(|_| "That version is no longer available.".to_string())
}

// ---------------------------------------------------------------- password / maintenance

/// Verify a password against a room file on a fresh, throwaway connection —
/// used by SEC-4 change-password so an open room can't be re-keyed by a
/// walk-up attacker, and to open a freshly duplicated copy (ADD-4).
pub fn verify_password(path: &str, password: &str) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    apply_key(&conn, password)?;
    verify_key(&conn).map_err(|_| "The current password is not correct.".to_string())
}

/// Change the encryption key of an OPEN connection (SQLCipher rekey).
pub fn rekey(conn: &Connection, new_password: &str) -> Result<(), String> {
    conn.pragma_update(None, "rekey", new_password)
        .map_err(|e| e.to_string())
}

/// Open a room copy with its current key, then re-key it to `new_password`
/// (ADD-4 duplicate-with-new-password).
pub fn rekey_copy(path: &str, current_password: &str, new_password: &str) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    apply_key(&conn, current_password)?;
    verify_key(&conn).map_err(|_| "Could not open the copied room to set its password.".to_string())?;
    conn.pragma_update(None, "rekey", new_password)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- recovery key (sidecar, A3)
//
// An optional recovery code that can re-open a room when the password is lost.
// The subtle part is WHERE to keep the wrapped password. It CANNOT live inside
// the room's own database: that database is encrypted with the very password
// we're trying to recover, so a wrap stored inside it would already need the
// thing you've forgotten to be read at all — a chicken-and-egg. So the wrap
// lives in a small plaintext SIDECAR file beside the room ("<room>.recovery").
// That is safe because the wrap itself is encrypted: the password is sealed
// with AES-256-GCM under a key stretched from the high-entropy recovery code by
// PBKDF2-HMAC-SHA256 (200k iters). Without the code the sidecar is useless.
// Purely additive — a room with no sidecar simply has no recovery (A4).

/// PBKDF2 iteration count for deriving the recovery key from the code.
const RECOVERY_PBKDF2_ITERS: u32 = 200_000;
/// Human-friendly, unambiguous alphabet for recovery codes: base32-ish with the
/// look-alike characters (I, L, O, 0, 1) left out so a hand-copied code is hard
/// to mistype.
const RECOVERY_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// The sidecar path for a room: the room file's path with ".recovery" appended.
fn recovery_sidecar_path(room_path: &str) -> String {
    format!("{room_path}.recovery")
}

/// On-disk shape of the sidecar: base64 salt/nonce/ciphertext plus a version so
/// the format can evolve. `ct` is the GCM body followed by its 16-byte tag.
#[derive(serde::Serialize, serde::Deserialize)]
struct RecoveryWrap {
    v: u32,
    salt: String,
    nonce: String,
    ct: String,
}

/// Stretch a (normalized) recovery code + salt into a 32-byte AES key.
fn derive_recovery_key(code_normalized: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(code_normalized.as_bytes(), salt, RECOVERY_PBKDF2_ITERS, &mut key);
    key
}

/// A fresh recovery code: 6 groups of 4 alphabet chars joined by '-'
/// (e.g. `K7QF-3M2X-...`), 24 random characters in all.
fn generate_recovery_code() -> String {
    let mut rng = rand::rngs::OsRng;
    let mut raw = [0u8; 24];
    rng.fill_bytes(&mut raw);
    let chars: Vec<char> = raw
        .iter()
        .map(|b| RECOVERY_ALPHABET[*b as usize % RECOVERY_ALPHABET.len()] as char)
        .collect();
    chars
        .chunks(4)
        .map(|g| g.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// Normalize a user-typed code before use: drop dashes/spaces/anything that is
/// not a letter or digit, and uppercase — so `k7qf 3m2x` matches `K7QF-3M2X`.
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Create a recovery code for `room_path`, seal `password` under it, and write
/// the sidecar. Returns the human-readable code (with dashes) to show ONCE.
/// CONTRACT-NOTE: uses aes-gcm's detached in-place API (`*_in_place_detached`)
/// so it compiles whether or not the `alloc`/`std` feature is enabled on the
/// aes-gcm dep — the ergonomic `Aead::encrypt` (Vec) methods are alloc-gated.
/// CONTRACT-NOTE: `pbkdf2_hmac` needs pbkdf2's default `hmac` feature (on by
/// default in 0.12); keep default-features when CONFIG pins the dep.
pub fn write_recovery(room_path: &str, password: &str) -> Result<String, String> {
    let code = generate_recovery_code();
    let normalized = normalize_code(&code);

    let mut rng = rand::rngs::OsRng;
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);

    let key = derive_recovery_key(&normalized, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut buf = password.as_bytes().to_vec();
    let tag = cipher
        .encrypt_in_place_detached(Nonce::<Aes256Gcm>::from_slice(&nonce), b"", &mut buf)
        .map_err(|_| "Could not create the recovery key.".to_string())?;
    buf.extend_from_slice(tag.as_slice());

    let wrap = RecoveryWrap {
        v: 1,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ct: STANDARD.encode(&buf),
    };
    let json = serde_json::to_string(&wrap).map_err(|e| e.to_string())?;
    std::fs::write(recovery_sidecar_path(room_path), json).map_err(|e| e.to_string())?;
    Ok(code)
}

/// True when a recovery sidecar exists for this room.
pub fn has_recovery(room_path: &str) -> bool {
    std::path::Path::new(&recovery_sidecar_path(room_path)).exists()
}

/// Delete a room's recovery sidecar. Used when re-wrapping after a password
/// change fails: a sidecar wrapping the OLD password must not stay behind, or
/// the unlock gate would keep offering a recovery code that can never work.
pub fn remove_recovery(room_path: &str) -> Result<(), String> {
    std::fs::remove_file(recovery_sidecar_path(room_path)).map_err(|e| e.to_string())
}

/// Recover the ROOM PASSWORD from its recovery sidecar + code, WITHOUT opening
/// the room. The app's recovery-unlock command needs the plaintext password to
/// hold in memory (for rekey / change-password / duplicate), so this is split
/// out from `open_with_recovery`. A wrong code (or a missing/corrupt sidecar)
/// returns a plain Err — never a panic.
pub fn recover_password(room_path: &str, code: &str) -> Result<String, String> {
    let json = std::fs::read_to_string(recovery_sidecar_path(room_path))
        .map_err(|_| "No recovery key was set up for this room.".to_string())?;
    let wrap: RecoveryWrap =
        serde_json::from_str(&json).map_err(|_| "The recovery file is unreadable.".to_string())?;
    if wrap.v != 1 {
        return Err("This recovery file was written by a newer version.".into());
    }
    let salt = STANDARD
        .decode(&wrap.salt)
        .map_err(|_| "The recovery file is corrupt.".to_string())?;
    let nonce = STANDARD
        .decode(&wrap.nonce)
        .map_err(|_| "The recovery file is corrupt.".to_string())?;
    let combined = STANDARD
        .decode(&wrap.ct)
        .map_err(|_| "The recovery file is corrupt.".to_string())?;
    if nonce.len() != 12 || combined.len() < 16 {
        return Err("The recovery file is corrupt.".into());
    }

    let normalized = normalize_code(code);
    let key = derive_recovery_key(&normalized, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let (body, tag) = combined.split_at(combined.len() - 16);
    let mut buf = body.to_vec();
    cipher
        .decrypt_in_place_detached(
            Nonce::<Aes256Gcm>::from_slice(&nonce),
            b"",
            &mut buf,
            Tag::<Aes256Gcm>::from_slice(tag),
        )
        .map_err(|_| "That recovery code is not correct.".to_string())?;
    String::from_utf8(buf).map_err(|_| "That recovery code is not correct.".to_string())
}

/// Re-open a room using its recovery code: recover the password, then open the
/// room normally. A wrong code (or a missing/corrupt sidecar) returns a plain
/// Err — never a panic.
pub fn open_with_recovery(room_path: &str, code: &str) -> Result<Connection, String> {
    let password = recover_password(room_path, code)?;
    open_room(room_path, &password)
}

/// Bytes sitting in the database's free pages — space a VACUUM would reclaim.
pub fn reclaimable_bytes(conn: &Connection) -> Result<i64, String> {
    let freelist: i64 = conn
        .pragma_query_value(None, "freelist_count", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let page_size: i64 = conn
        .pragma_query_value(None, "page_size", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(freelist * page_size)
}

/// Compact the database in place (SEC-7).
pub fn vacuum(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("VACUUM").map_err(|e| e.to_string())
}

/// Test-only: a fresh in-memory database with the live SCHEMA applied — same
/// tables a new room gets. Shared by unit tests in this crate (incl. the
/// retrieval blend test in `commands`).
#[cfg(test)]
pub fn open_in_memory_schema() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

/// A consistent copy of the live, encrypted database to `dest` — keeps the
/// current key (ADD-4). `dest` is single-quote-escaped into the statement
/// since VACUUM INTO does not accept bound parameters.
pub fn vacuum_into(conn: &Connection, dest: &str) -> Result<(), String> {
    let escaped = dest.replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}'"))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_roundtrips_and_rejects_wrong_code() {
        // A3: create room → write_recovery → open_with_recovery(code) decrypts;
        // messy formatting still works; a wrong code errors cleanly (no panic).
        let path = temp_room_path();
        {
            let _conn = create_room(&path, "the-real-password", "Recoverable").unwrap();
        }
        assert!(!has_recovery(&path));
        let code = write_recovery(&path, "the-real-password").unwrap();
        assert!(has_recovery(&path));
        // 6 groups of 4 characters, dash-separated.
        assert_eq!(code.split('-').count(), 6);
        assert!(code.split('-').all(|g| g.chars().count() == 4));

        // Correct code opens, even lowercased / space-separated / padded.
        let messy = format!("  {}  ", code.to_lowercase().replace('-', " "));
        let conn = open_with_recovery(&path, &messy).unwrap();
        assert_eq!(get_meta(&conn, "name").as_deref(), Some("Recoverable"));
        drop(conn);

        // A wrong code fails with an Err, not a panic.
        assert!(open_with_recovery(&path, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF").is_err());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(recovery_sidecar_path(&path));
    }

    #[test]
    fn rewrite_and_remove_recovery() {
        // F4: after a password change the sidecar is re-wrapped — the old code
        // stops working, the new one recovers the NEW password. And
        // remove_recovery deletes the sidecar (errors, not panics, when gone).
        let path = temp_room_path();
        let old_code = write_recovery(&path, "old-password").unwrap();
        let new_code = write_recovery(&path, "new-password").unwrap();
        assert_eq!(recover_password(&path, &new_code).unwrap(), "new-password");
        assert!(recover_password(&path, &old_code).is_err());

        remove_recovery(&path).unwrap();
        assert!(!has_recovery(&path));
        assert!(remove_recovery(&path).is_err());
    }
}
