use super::*;

/// ADD-2: a file's saved versions (newest first).
#[tauri::command]
pub fn list_file_versions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<FileVersion>, String> {
    state.with_room(|room| db::list_file_versions(&room.conn, &id))
}

/// Idea 11: the text of one saved version alongside the file's CURRENT text,
/// both shaped by `content_text` so the compare view diffs like-for-like. Pure
/// over a connection (no `State`) so it is unit-testable against
/// `open_in_memory_schema`. Text-only; bytes never cross the boundary.
pub(crate) fn version_content(
    conn: &Connection,
    version_id: &str,
) -> Result<VersionContent, String> {
    let (file_id, vbytes, vtext, _rec_meta) = db::get_version(conn, version_id)?;
    let (name, mime, cbytes, cextracted) = db::get_file_full(conn, &file_id)?;
    let mime = mime.unwrap_or_default();
    // Versions saved before compound snapshots carry no text: re-derive it
    // exactly as `restore_file_version` does, so the diff matches a restore.
    let vtext = vtext.or_else(|| {
        extraction::extract_text(&name, &vbytes).or_else(|| String::from_utf8(vbytes.clone()).ok())
    });
    let version_text = content_text(&name, &mime, &vbytes, vtext);
    let current_text = content_text(&name, &mime, &cbytes.unwrap_or_default(), cextracted);
    Ok(VersionContent { file_name: name, version_text, current_text })
}

/// Idea 11: read one saved version's comparable text (and the file's current
/// text) WITHOUT restoring — the compare view's only new command. A pure read:
/// no version row is written, `file-updated` never fires.
#[tauri::command]
pub fn get_file_version(
    state: State<'_, AppState>,
    version_id: String,
) -> Result<VersionContent, String> {
    state.with_room(|room| version_content(&room.conn, &version_id))
}

/// ADD-2: restore a saved version. Goes back through `store_file_bytes`,
/// so the CURRENT state is snapshotted first — restoring is itself undoable.
/// A version is a compound snapshot: bytes, extracted text, and (for a
/// Recording) the transcript meta all come back together, in one
/// transaction — a half-restored recording would show words from one era
/// against speakers from another.
#[tauri::command]
pub fn restore_file_version(
    window: tauri::Window,
    state: State<'_, AppState>,
    version_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    state.with_room(|room| {
        let (file_id, bytes, text, rec_meta) = db::get_version(&room.conn, &version_id)?;
        // Versions saved before compound snapshots carry no text: re-derive it.
        let text = text.or_else(|| {
            let name = db::get_file_name(&room.conn, &file_id).ok()?;
            extraction::extract_text(&name, &bytes).or_else(|| String::from_utf8(bytes.clone()).ok())
        });
        room.conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
        let restored = store_file_bytes(&room.conn, &file_id, &bytes, text.as_deref(), "Restored")
            .and_then(|_| match &rec_meta {
                Some(meta) => db::set_rec_meta(&room.conn, &file_id, meta),
                None => Ok(()),
            });
        match restored {
            Ok(()) => room.conn.execute_batch("COMMIT").map_err(|e| e.to_string())?,
            Err(e) => {
                let _ = room.conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
        let _ = window.emit("room-files-changed", ());
        let _ = window.emit("file-updated", &file_id);
        Ok(())
    })
}

/// ADD-1: write one file's original bytes out as a normal (unencrypted) file.
#[tauri::command]
pub fn export_file(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
) -> Result<(), String> {
    state.with_room(|room| {
        let bytes = db::get_file_bytes(&room.conn, &id)?
            .ok_or("This file has no stored content to export.")?;
        std::fs::write(&dest_path, &bytes).map_err(|e| format!("Could not save the file: {e}"))?;
        Ok(())
    })
}

/// Choose a destination name inside a folder that will not overwrite anything:
/// on a clash, insert " (2)", " (3)", … before the extension. `is_taken`
/// reports whether a candidate name already exists.
pub(crate) fn unique_export_name(name: &str, is_taken: impl Fn(&str) -> bool) -> String {
    if !is_taken(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    };
    let mut n = 2u32;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if !is_taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// ADD-1: export every file into `dest_dir`, never overwriting. Returns the
/// number written.
#[tauri::command]
pub fn export_all(state: State<'_, AppState>, dest_dir: String) -> Result<u32, String> {
    state.with_room(|room| {
        let dir = std::path::Path::new(&dest_dir);
        if !dir.is_dir() {
            return Err("Choose a folder to export into.".into());
        }
        let files = db::list_files(&room.conn)?;
        let mut written = 0u32;
        for f in files {
            let bytes = db::get_file_bytes(&room.conn, &f.id)?.unwrap_or_default();
            // Files written earlier this run land on disk, so the existence check
            // also dedups same-named files against each other.
            let name = unique_export_name(&f.name, |candidate| dir.join(candidate).exists());
            std::fs::write(dir.join(&name), &bytes)
                .map_err(|e| format!("Could not write \"{name}\": {e}"))?;
            written += 1;
        }
        Ok(written)
    })
}

/// SEC-4: rotate the room's password. Verifies `current` on a second throwaway
/// connection, then re-keys the live connection. When the room has a recovery
/// sidecar it is re-wrapped around the NEW password and the FRESH code is
/// returned (to show once) — the old code decrypts to a password that no
/// longer opens the room. Returns `None` when the room had no recovery.
#[tauri::command]
pub fn change_password(
    state: State<'_, AppState>,
    current: String,
    new_password: String,
) -> Result<Option<String>, String> {
    if new_password.chars().count() < 8 {
        return Err("Password must be at least 8 characters.".into());
    }
    // Wave 3 (Idea 9): a rollback is verifying/rekeying checkpoints of its own —
    // don't rekey the live room + its checkpoints underneath it.
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    // Rekey the live room under the lock (fast: one SQLCipher rekey plus the
    // biometrics/recovery re-wrap). Capture the path and the OLD password —
    // `current` is already verified — so the per-checkpoint rekey below runs
    // WITHOUT the room mutex: Wave 3 (Idea 9) each `.roomck` is a full room copy
    // (possibly GB-scale), and rekey_copy rewrites every page; holding the room
    // lock across that loop would freeze every ask/save/job for minutes.
    let room_path = {
        let mut guard = state.room.lock().unwrap();
        let room = guard.as_mut().ok_or("No room is open.")?;
        db::verify_password(&room.path, &current)?;
        db::rekey(&room.conn, &new_password)?;
        room.password = new_password.clone();
        // ADD-11: keep Touch ID working after a password change. Chosen
        // behavior: UPDATE the Keychain entry with the new password (re-store
        // overwrites it). Storing creates a fresh biometric item and needs no
        // prompt. If it somehow fails, delete the stale entry so Touch ID can
        // never hand back the old password — the room then falls back to typing
        // until re-enabled.
        if crate::biometrics::has(&room.path)
            && crate::biometrics::store(&room.path, &room.password).is_err()
        {
            let _ = crate::biometrics::delete(&room.path);
        }
        room.path.clone()
    };
    // Same policy for the recovery sidecar: it wraps the password, so after a
    // rekey the old code would recover a password that no longer opens the
    // room. Re-wrap under the new password and hand back the fresh code; if
    // re-wrapping fails, delete the stale sidecar so the unlock gate never
    // offers a code that cannot work.
    // Wave 1a, chosen behavior: the Leash's `leash_token` is NOT rotated here —
    // it is a separate credential for a separate boundary (loopback MCP, not
    // the file), and silently breaking every pasted external-agent config on a
    // password change would look like data loss. Revocation is the explicit
    // "Regenerate token" action (`regenerate_leash_token`), which also severs
    // live connections.
    let new_code = if db::has_recovery(&room_path) {
        match db::write_recovery(&room_path, &new_password) {
            Ok(code) => Some(code),
            Err(_) => {
                let _ = db::remove_recovery(&room_path);
                None
            }
        }
    } else {
        None
    };
    // Wave 3 (Idea 9): `vacuum_into` copies keep the key of the moment they were
    // made, so a later rekey would strand every checkpoint. Re-key each one from
    // the OLD password (`current`) to the new, off the room lock. A failure is
    // logged, not fatal — the password change still succeeds, and a stranded
    // checkpoint is caught (with a clear error) by verify_password at rollback.
    for ck in checkpoint_ck_paths(&room_path) {
        if let Err(e) = db::rekey_copy(&ck, &current, &new_password) {
            eprintln!("checkpoint rekey failed for {ck}: {e}");
        }
    }
    Ok(new_code)
}

/// ADD-4: a full copy of the open room as it is now, optionally with its own
/// new password. The original is never touched.
#[tauri::command]
pub fn duplicate_room(
    state: State<'_, AppState>,
    dest_path: String,
    new_password: Option<String>,
) -> Result<(), String> {
    if let Some(pw) = &new_password {
        if pw.chars().count() < 8 {
            return Err("Password must be at least 8 characters.".into());
        }
    }
    if std::path::Path::new(&dest_path).exists() {
        return Err("A file already exists at that location.".into());
    }
    state.with_room(|room| {
        db::vacuum_into(&room.conn, &dest_path)?;
        if let Some(pw) = new_password {
            if let Err(e) = db::rekey_copy(&dest_path, &room.password, &pw) {
                let _ = std::fs::remove_file(&dest_path);
                return Err(e);
            }
        }
        Ok(())
    })
}

/// SEC-7: compact the open room on demand, reporting how much was reclaimed.
#[tauri::command]
pub fn compact_room(state: State<'_, AppState>) -> Result<String, String> {
    state.with_room(|room| {
        let reclaimable = db::reclaimable_bytes(&room.conn)?;
        let mb = reclaimable as f64 / (1024.0 * 1024.0);
        if mb < 0.05 {
            return Ok("Nothing to recover.".into());
        }
        db::vacuum(&room.conn)?;
        Ok(format!("Recovered {mb:.1} MB."))
    })
}

// ---------------------------------------------------------------- recent rooms (ADD-5)


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_name_suffixes_on_clash() {
        use std::collections::HashSet;
        let mut taken: HashSet<String> = HashSet::new();
        // Unclaimed name is used as-is.
        assert_eq!(unique_export_name("fresh.txt", |c| taken.contains(c)), "fresh.txt");
        // Clash inserts the suffix before the extension.
        taken.insert("report.pdf".into());
        assert_eq!(unique_export_name("report.pdf", |c| taken.contains(c)), "report (2).pdf");
        // Keeps counting while suffixed names are also taken.
        taken.insert("report (2).pdf".into());
        assert_eq!(unique_export_name("report.pdf", |c| taken.contains(c)), "report (3).pdf");
        // No extension → suffix goes at the end.
        taken.insert("README".into());
        assert_eq!(unique_export_name("README", |c| taken.contains(c)), "README (2)");
        // A leading dot is not an extension separator.
        taken.insert(".gitignore".into());
        assert_eq!(unique_export_name(".gitignore", |c| taken.contains(c)), ".gitignore (2)");
    }

    // ------------------------------------------------ Idea 11: version compare

    #[test]
    fn version_content_returns_stored_text_and_current() {
        // (a) a compound (text-bearing) version diffs its stored text against
        // the file's current text — for a .txt both are the RAW bytes' text,
        // so indentation is preserved (no whitespace normalization). This is
        // the second-pass addendum's corrected expectation.
        let conn = db::open_in_memory_schema();
        let fid = db::insert_file(
            &conn, "note.txt", "text/plain",
            b"line one\n  indented two", Some("line one\n  indented two"), "upload",
        ).unwrap().id;
        db::snapshot_file_version(&conn, &fid, "Edited").unwrap();
        let vid = db::list_file_versions(&conn, &fid).unwrap()[0].id.clone();
        db::update_file_content(&conn, &fid, b"line one\n  changed two", Some("line one\n  changed two")).unwrap();

        let vc = version_content(&conn, &vid).unwrap();
        assert_eq!(vc.file_name, "note.txt");
        assert_eq!(vc.version_text.as_deref(), Some("line one\n  indented two"));
        assert_eq!(vc.current_text.as_deref(), Some("line one\n  changed two"));
    }

    #[test]
    fn version_content_rederives_null_text() {
        // (b) a pre-compound version row with text = NULL still yields text —
        // re-derived from its bytes, matching what restore would produce.
        let conn = db::open_in_memory_schema();
        let fid = db::insert_file(
            &conn, "old.txt", "text/plain", b"current", Some("current"), "upload",
        ).unwrap().id;
        conn.execute(
            "INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause)
             VALUES ('v-legacy', ?1, ?2, NULL, NULL, 'legacy')",
            rusqlite::params![fid, b"legacy bytes".to_vec()],
        ).unwrap();
        let vc = version_content(&conn, "v-legacy").unwrap();
        assert_eq!(vc.version_text.as_deref(), Some("legacy bytes"));
        assert_eq!(vc.current_text.as_deref(), Some("current"));
    }

    #[test]
    fn version_content_unknown_id_errors() {
        // (c) an unknown version id returns the "no longer available" error.
        let conn = db::open_in_memory_schema();
        assert!(version_content(&conn, "does-not-exist").is_err());
    }

    // ------------------------------------------------ Idea 9: password rekey

    #[test]
    fn change_password_rekeys_checkpoints() {
        // The change_password loop re-keys every checkpoint via rekey_copy so a
        // password change never strands them from a later rollback. Exercise
        // the exact mechanism (checkpoint_ck_paths + rekey_copy round-trip) on
        // a real SQLCipher room + checkpoint.
        let path = db::temp_room_path();
        let dir = checkpoints_dir(&path);
        let ck_id = {
            let conn = db::create_room(&path, "old-password", "Room").unwrap();
            db::insert_file(&conn, "a.txt", "text/plain", b"hi", Some("hi"), "upload").unwrap();
            write_checkpoint(&conn, &dir, "cp", false).unwrap().id
        };
        let ck_path = checkpoint_file_path(&dir, &ck_id);
        // Before: only the old password opens the checkpoint.
        assert!(db::verify_password(&ck_path, "old-password").is_ok());
        assert!(db::verify_password(&ck_path, "new-password-xx").is_err());
        // The loop change_password runs off the room lock:
        for ck in checkpoint_ck_paths(&path) {
            db::rekey_copy(&ck, "old-password", "new-password-xx").unwrap();
        }
        // After: the NEW password opens it; the old no longer does.
        assert!(db::verify_password(&ck_path, "new-password-xx").is_ok());
        assert!(db::verify_password(&ck_path, "old-password").is_err());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
