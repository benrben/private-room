use super::*;

// ---------------------------------------------------------------- file versions (ADD-2)

/// How many UNPINNED versions of one file the room keeps. Pinned versions are
/// outside this window entirely — see `pinned` in the schema. Public so the
/// History strip can state the number instead of the user discovering it by
/// losing the eleventh save.
pub const VERSIONS_KEPT: usize = 10;

/// Copy a file's CURRENT state into history before it is overwritten,
/// labelled with `cause`, then keep only the newest [`VERSIONS_KEPT`] UNPINNED
/// versions for that file. The snapshot is compound — bytes, extracted text,
/// and any recording meta — because for a Recording the bytes are the
/// unchanged WAV and what is being replaced IS the transcript: restoring bytes
/// alone could never bring the old words, speakers, or cuts back. A file with
/// no stored bytes yet (nothing to preserve) is a no-op.
pub fn snapshot_file_version(conn: &Connection, file_id: &str, cause: &str) -> Result<(), String> {
    let current: Option<(Option<Vec<u8>>, Option<String>, Option<String>)> = query_opt(
        conn,
        "SELECT original_bytes, extracted_text, provenance FROM files WHERE id = ?1",
        [file_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let Some((Some(bytes), text, provenance)) = current else { return Ok(()) };
    let rec_meta: Option<String> = conn
        .query_row("SELECT meta FROM recordings WHERE file_id = ?1", [file_id], |r| r.get(0))
        .ok();
    execute_one(
        conn,
        "INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause, provenance)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![Uuid::new_v4().to_string(), file_id, bytes, text, rec_meta, cause, provenance],
    )?;
    // A PINNED version is neither counted nor deleted: pinning it is the user
    // saying "this is the one I might need back", and a rolling window that
    // could still evict it would be a promise the room does not keep.
    execute_one(
        conn,
        &format!(
            "DELETE FROM file_versions WHERE file_id = ?1 AND pinned = 0 AND id NOT IN (
               SELECT id FROM file_versions WHERE file_id = ?1 AND pinned = 0
               ORDER BY saved_at DESC, rowid DESC LIMIT {VERSIONS_KEPT})"
        ),
        [file_id],
    )
}

/// Pin or unpin one saved version (the History strip's "Keep" toggle). Errors
/// when the id is not a version of a live file, so an unpin from a stale tab
/// cannot silently do nothing while reporting success.
pub fn set_version_pinned(conn: &Connection, version_id: &str, pinned: bool) -> Result<(), String> {
    execute_existing(
        conn,
        "UPDATE file_versions SET pinned = ?2 WHERE id = ?1",
        params![version_id, if pinned { 1 } else { 0 }],
        "That version is no longer available.",
    )
}

/// Delete ONE saved version outright — the History strip's per-row delete.
/// This is the only way to get a large old snapshot's bytes back out of the
/// room short of deleting the file: every version stores the whole file, so ten
/// edits of a 200 MB recording are ten 200 MB rows. Deliberately not undoable
/// (there is no history of the history), which is why the UI confirms first.
pub fn delete_file_version(conn: &Connection, version_id: &str) -> Result<(), String> {
    execute_existing(
        conn,
        "DELETE FROM file_versions WHERE id = ?1",
        [version_id],
        "That version is no longer available.",
    )
}

/// Total bytes this file's saved versions occupy — what the History strip shows
/// so "old versions eat disk space" is a number the user can see, not a
/// surprise. Sums the stored blob and text; a room with no versions is 0.
pub fn versions_bytes(conn: &Connection, file_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(bytes) + COALESCE(LENGTH(text), 0)), 0)
         FROM file_versions WHERE file_id = ?1",
        [file_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// A file's saved versions, newest first. `provenance` is what made THAT
/// version's content (ART-1) — absent on every version saved before provenance
/// was recorded, and on every version a person typed, so the History strip
/// attributes a version only where the app actually witnessed the write.
///
/// Empty for a trashed file, by the join. The rows themselves stay — trash is
/// reversible and a restore must bring the whole history back — but listing
/// them by id would let a stale tab keep drawing a deleted file's History
/// strip: when it was edited, what each edit was for, and which agent and tool
/// made it.
pub fn list_file_versions(conn: &Connection, file_id: &str) -> Result<Vec<FileVersion>, String> {
    query_rows(
        conn,
        "SELECT v.id, v.saved_at, v.cause, v.provenance, v.pinned, LENGTH(v.bytes)
         FROM file_versions v JOIN files f ON f.id = v.file_id
         WHERE v.file_id = ?1 AND f.trashed_at IS NULL
         ORDER BY v.saved_at DESC, v.rowid DESC",
        [file_id],
        |r| {
            let raw: Option<String> = r.get(3)?;
            Ok(FileVersion {
                id: r.get(0)?,
                saved_at: r.get(1)?,
                cause: r.get(2)?,
                provenance: raw.and_then(|j| serde_json::from_str(&j).ok()),
                pinned: r.get::<_, i64>(4)? != 0,
                bytes: r.get::<_, i64>(5)?,
            })
        },
    )
}

/// The provenance stored ON a saved version, as raw JSON. Restoring a version
/// restores what made it too, so the head never claims a run that produced
/// different bytes (see `commands::safety::restore_file_version`).
pub fn version_provenance_json(conn: &Connection, version_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT provenance FROM file_versions WHERE id = ?1",
        [version_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

/// Point a file's CURRENT provenance at `json` (or clear it with None).
pub fn set_file_provenance(conn: &Connection, file_id: &str, json: Option<&str>) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE files SET provenance = ?2 WHERE id = ?1",
        params![file_id, json],
    )
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
///
/// The draw is REJECTION-SAMPLED, not `byte % 31`. 256 is not a multiple of the
/// 31-character alphabet, so the modulo mapped 9 byte values onto each of the
/// first eight letters and 8 onto the rest — every character of the one secret
/// this app asks you to copy onto paper was ~12% likelier to be A–H. Drawing
/// again whenever the byte lands in the ragged tail (>= 248) makes the
/// distribution exactly uniform; the expected number of extra bytes is under 1
/// per code.
fn generate_recovery_code() -> String {
    let mut rng = rand::rngs::OsRng;
    let n = RECOVERY_ALPHABET.len() as u8; // 31, so `limit` is 248
    let limit = 256u16 - (256u16 % n as u16);
    let mut chars: Vec<char> = Vec::with_capacity(24);
    let mut buf = [0u8; 32];
    while chars.len() < 24 {
        rng.fill_bytes(&mut buf);
        for b in buf {
            if (b as u16) < limit {
                chars.push(RECOVERY_ALPHABET[(b % n) as usize] as char);
                if chars.len() == 24 {
                    break;
                }
            }
        }
    }
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
    write_sidecar_atomically(&recovery_sidecar_path(room_path), &json)?;
    Ok(code)
}

/// Write the recovery sidecar the way the checkpoint manifest and the recents
/// list are written: into a temp file beside it, flushed to disk, then renamed
/// over the old one.
///
/// `fs::write` truncates the existing sidecar first. A crash, a power loss or a
/// full disk in that window leaves a 0-byte or half-written wrap — and the wrap
/// is the ONLY copy of the sealed password. `has_recovery` just tests that the
/// path exists, so the unlock screen would go on offering a recovery code that
/// can never work, and you would find out on the one day it mattered. The most
/// likely moment for that crash is a password change, which re-writes this file
/// over a working one. The temp file sits beside the room so the rename stays
/// on one volume (rename across volumes is not atomic, and is not even allowed).
fn write_sidecar_atomically(path: &str, json: &str) -> Result<(), String> {
    use std::io::Write as _;
    let tmp = format!("{path}.tmp");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let staged = f
        .write_all(json.as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|e| e.to_string());
    drop(f);
    if let Err(e) = staged {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
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

    #[test]
    fn recovery_alphabet_is_drawn_uniformly() {
        // The modulo draw mapped 9 of 256 byte values onto each of the first 8
        // alphabet characters and 8 onto the other 23 — ~12.5% bias on every
        // character of the one secret we ask the user to write down. With
        // rejection sampling the letter frequencies converge; with `% 31` they
        // do not, and this margin is far outside sampling noise at this N.
        let mut counts = [0usize; 31];
        let mut total = 0usize;
        for _ in 0..2000 {
            for c in generate_recovery_code().chars().filter(|c| *c != '-') {
                let idx = RECOVERY_ALPHABET.iter().position(|b| *b as char == c).unwrap();
                counts[idx] += 1;
                total += 1;
            }
        }
        assert_eq!(total, 2000 * 24);
        let biased: usize = counts[..8].iter().sum();
        let rest: usize = counts[8..].iter().sum();
        // Uniform ⇒ biased/8 ≈ rest/23. Under `% 31` the per-character rate in
        // the first 8 is 9/8 of the rest's; assert we are within 4% of parity.
        let a = biased as f64 / 8.0;
        let b = rest as f64 / 23.0;
        assert!(
            (a / b - 1.0).abs() < 0.04,
            "recovery alphabet is not uniform: first-8 rate {a:.1} vs rest {b:.1}"
        );
    }

    #[test]
    fn recovery_sidecar_is_written_temp_then_renamed() {
        // 483: `fs::write` truncates the live sidecar first, so a crash in that
        // window leaves the only copy of the sealed password unusable while
        // `has_recovery` still reports it exists. Proven two ways: a pre-placed
        // `.tmp` (a previous crashed write) is replaced rather than tripping the
        // new write up, and an unwritable temp path leaves the OLD sidecar
        // intact and readable rather than destroying it.
        let path = temp_room_path();
        let code = write_recovery(&path, "first-password").unwrap();
        let sidecar = recovery_sidecar_path(&path);
        std::fs::write(format!("{sidecar}.tmp"), b"junk from a crashed write").unwrap();

        // A failed write must not have consumed the existing sidecar.
        assert!(write_sidecar_atomically("/nonexistent-dir-xyz/x.recovery", "{}").is_err());
        assert_eq!(recover_password(&path, &code).unwrap(), "first-password");

        // A successful write leaves no temp file behind and swaps the wrap.
        let code2 = write_recovery(&path, "second-password").unwrap();
        assert!(!std::path::Path::new(&format!("{sidecar}.tmp")).exists());
        assert_eq!(recover_password(&path, &code2).unwrap(), "second-password");

        let _ = std::fs::remove_file(&sidecar);
    }

    #[test]
    fn all_four_open_paths_pin_the_cipher_parameters() {
        // The A1 pin lived at two of the four call sites: `create_room` and
        // `open_room` had it, `verify_password` and `rekey_copy` did not. It is
        // now inside `apply_key`, so every path that keys a connection pins it.
        // A room created with the pin must therefore be readable by BOTH of the
        // paths that previously skipped it, including after a re-key.
        let path = temp_room_path();
        {
            let _conn = create_room(&path, "the-password", "Pinned").unwrap();
        }
        verify_password(&path, "the-password").unwrap();
        assert!(verify_password(&path, "not-the-password").is_err());

        let copy = format!("{path}.copy");
        std::fs::copy(&path, &copy).unwrap();
        rekey_copy(&copy, "the-password", "another-password").unwrap();
        // The re-keyed copy opens on the ordinary path — i.e. the parameter set
        // `rekey_copy` wrote and the one `open_room` expects are the same one.
        let conn = open_room(&copy, "another-password").unwrap();
        assert_eq!(get_meta(&conn, "name").as_deref(), Some("Pinned"));
        drop(conn);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&copy);
    }

    /// The behavioural test above cannot FAIL without the fix: SQLCipher 4 is
    /// the linked library's default today, so an unpinned `verify_password` /
    /// `rekey_copy` still opens the same rooms. The whole point of pinning is
    /// the build where the default is NOT 4 — which no test here can create.
    /// So the invariant is checked structurally instead: keying a connection
    /// happens in exactly one place, and that place pins. A fifth caller that
    /// spells `PRAGMA key` itself would re-open the hole, and this fails.
    #[test]
    fn keying_a_connection_happens_only_where_the_cipher_is_pinned() {
        const SCHEMA_RS: &str = include_str!("schema.rs");
        const VERSIONS_RS: &str = include_str!("versions.rs");
        // The pin lives with the key, inside `apply_key`.
        // Needles assembled at run time so this test's own source does not
        // contain them and count itself.
        let q = '"';
        let key_call = format!("pragma_update(None, {q}key{q}");
        let pin = format!("PRAGMA cipher{}compatibility", '_');

        let apply = SCHEMA_RS
            .split_once("pub(crate) fn apply_key")
            .expect("apply_key must exist")
            .1;
        let body = &apply[..apply.find("\n}\n").expect("apply_key body")];
        assert!(body.contains(&key_call), "apply_key must set the key");
        assert!(
            body.contains(&pin),
            "apply_key must pin the cipher parameters alongside the key"
        );
        // …and nowhere else: a new open path that keys a connection on its own
        // would skip the pin, which is exactly how two of the four call sites
        // came to be missing it.
        let keyings: usize =
            [SCHEMA_RS, VERSIONS_RS].iter().map(|src| src.matches(&key_call).count()).sum();
        assert_eq!(
            keyings, 1,
            "a connection is keyed outside apply_key — that path skips the cipher pin"
        );
        // The pin itself is written once, so it cannot drift between call sites.
        let pins: usize = [SCHEMA_RS, VERSIONS_RS].iter().map(|src| src.matches(&pin).count()).sum();
        assert_eq!(pins, 1, "the cipher pin is spelled out in more than one place");
    }

    #[test]
    fn pinned_versions_survive_the_rolling_prune_and_can_be_deleted() {
        // 468: the eleventh save silently dropped the oldest version and there
        // was no way to protect or delete one. A pinned version is neither
        // counted by nor evicted by the prune; delete removes exactly one row.
        let conn = open_in_memory_schema();
        conn.execute(
            "INSERT INTO files(id, name, mime_type, original_bytes) VALUES ('f1','a.txt','text/plain', X'00')",
            [],
        )
        .unwrap();
        // The oldest version, pinned.
        snapshot_file_version(&conn, "f1", "first").unwrap();
        let oldest = list_file_versions(&conn, "f1").unwrap()[0].id.clone();
        set_version_pinned(&conn, &oldest, true).unwrap();

        // Well past the window: without the pin the first one is long gone.
        for i in 0..VERSIONS_KEPT + 5 {
            snapshot_file_version(&conn, "f1", &format!("save {i}")).unwrap();
        }
        let all = list_file_versions(&conn, "f1").unwrap();
        assert!(
            all.iter().any(|v| v.id == oldest && v.pinned),
            "a pinned version was evicted by the rolling prune"
        );
        // The pinned row is EXTRA — the window still holds its full count.
        assert_eq!(all.iter().filter(|v| !v.pinned).count(), VERSIONS_KEPT);
        assert!(all.iter().all(|v| v.bytes > 0));
        assert!(versions_bytes(&conn, "f1").unwrap() > 0);

        delete_file_version(&conn, &oldest).unwrap();
        let after = list_file_versions(&conn, "f1").unwrap();
        assert!(after.iter().all(|v| v.id != oldest));
        assert_eq!(after.len(), VERSIONS_KEPT);
        assert!(delete_file_version(&conn, "no-such-version").is_err());
    }
}
