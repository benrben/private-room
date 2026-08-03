use super::*;

/// ADD-2: a file's saved versions (newest first).
#[tauri::command]
pub fn list_file_versions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<FileVersion>, String> {
    state.with_room(|room| db::list_file_versions(&room.conn, &id))
}

/// How many unpinned versions a file keeps — so the History strip can SAY it.
/// The eleventh save used to drop the oldest version with nothing on screen
/// ever mentioning a limit.
#[tauri::command]
pub fn file_versions_kept() -> usize {
    db::VERSIONS_KEPT
}

/// Keep (or stop keeping) one saved version: a pinned version is not counted
/// by, and never deleted by, the rolling prune on the next save.
#[tauri::command]
pub fn pin_file_version(
    state: State<'_, AppState>,
    version_id: String,
    pinned: bool,
) -> Result<(), String> {
    state.with_room(|room| db::set_version_pinned(&room.conn, &version_id, pinned))
}

/// Delete one saved version. Every version stores the WHOLE file, so this is
/// the only way to reclaim a big snapshot's space without deleting the file
/// itself. There is no history of the history: the caller confirms first.
#[tauri::command]
pub fn delete_file_version(state: State<'_, AppState>, version_id: String) -> Result<(), String> {
    state.with_room(|room| db::delete_file_version(&room.conn, &version_id))
}

/// ART-1: what produced the file's CURRENT content, if the app recorded it.
/// `None` for everything a person made or imported, and for every file written
/// before provenance existed — the History strip shows nothing at all rather
/// than crediting a run that may not have written what is on screen.
#[tauri::command]
pub fn get_file_provenance(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<db::Provenance>, String> {
    state.with_room(|room| db::file_provenance(&room.conn, &id))
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

/// The body of [`restore_file_version`], over a plain connection — pure for the
/// same reason `version_content` is: the restore's invariants (bytes, text,
/// recording meta and ART-1 provenance all move together, or none of them do)
/// are exactly what a unit test needs to hold, and they cannot be reached
/// through a `State`. Returns the id of the file that was restored.
pub(crate) fn restore_version_into(conn: &Connection, version_id: &str) -> Result<String, String> {
    let (file_id, bytes, text, rec_meta) = db::get_version(conn, version_id)?;
    // A version row outlives a delete (trash is reversible, and a restored file
    // must find its whole history waiting), so a version id held by an open tab
    // still resolves after the file is gone. Writing through it would put an old
    // draft into a file the room is not showing and fire `file-updated` for it —
    // the resurrection `db::get_file_meta` documents. The name doubles as the
    // re-derivation input below, so the guard costs nothing.
    let name = db::get_file_name(conn, &file_id)
        .map_err(|_| "That file is no longer in this room.".to_string())?;
    // Versions saved before compound snapshots carry no text: re-derive it.
    let text = text.or_else(|| {
        extraction::extract_text(&name, &bytes).or_else(|| String::from_utf8(bytes.clone()).ok())
    });
    // ART-1: whatever made THIS version made the file's content again, so the
    // head's provenance moves back with the bytes. Read before the write,
    // because `store_file_bytes` snapshots the outgoing head (and its
    // provenance) on the way past. A version with none CLEARS the head's —
    // restoring a hand-typed state must not leave an AI run credited for it.
    let back_to = db::version_provenance_json(conn, version_id);
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    let restored = store_file_bytes(conn, &file_id, &bytes, text.as_deref(), "Restored")
        .and_then(|_| db::set_file_provenance(conn, &file_id, back_to.as_deref()))
        .and_then(|_| match &rec_meta {
            Some(meta) => db::set_rec_meta(conn, &file_id, meta),
            None => Ok(()),
        });
    match restored {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string())?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(file_id)
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
    let file_id = state.with_room(|room| restore_version_into(&room.conn, &version_id))?;
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("file-updated", &file_id);
    Ok(())
}

// ------------------------------------------------------ the "came from the web" mark
//
// macOS shows its "downloaded from the Internet — are you sure?" warning off a
// single extended attribute, `com.apple.quarantine`. A file that arrived in a
// room over the network carries that history in `files.origin_url`, but the
// bytes written back out on export were plain, unmarked files: the warning that
// would have appeared had the user downloaded the same installer in Safari
// simply never came. Exporting must not launder a download.
//
// Declared here rather than pulling in `libc`: two one-line macOS syscalls do
// not justify a new direct dependency on a crate this app has never needed.

unsafe extern "C" {
    fn setxattr(
        path: *const std::ffi::c_char,
        name: *const std::ffi::c_char,
        value: *const std::ffi::c_void,
        size: usize,
        position: u32,
        options: std::ffi::c_int,
    ) -> std::ffi::c_int;
}

/// The `com.apple.quarantine` value written on an exported download.
///
/// Format is `flags;hex-timestamp;agent;uuid`. The last two fields are
/// DELIBERATELY the app name and an empty uuid: the real Safari-style value
/// ends with a LaunchServices id that ties the file back to the URL it came
/// from, and the origin URL is the user's — it belongs inside the room, not in
/// an attribute travelling on a file they just put on their Desktop. Flag
/// `0001` (QTN_FLAG_DOWNLOAD) is the bit Gatekeeper reads, which is the whole
/// point of the mark.
pub(crate) fn quarantine_value(now_secs: u64) -> String {
    format!("0001;{now_secs:x};Arcelle;")
}

/// Put the quarantine mark on a just-exported file. Best-effort: a filesystem
/// that cannot hold extended attributes (a FAT USB stick, a network share) is
/// not a reason to fail an export the user asked for, and the caller has
/// already written the bytes.
pub(crate) fn mark_as_downloaded(path: &std::path::Path) {
    use std::os::unix::ffi::OsStrExt as _;
    let Ok(cpath) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return;
    };
    let name = c"com.apple.quarantine";
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let value = quarantine_value(now);
    // SAFETY: both pointers are valid, NUL-terminated C strings that outlive
    // the call, and `size` is the exact byte length of `value`.
    unsafe {
        setxattr(
            cpath.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            0,
        );
    }
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
        // Read BEFORE the write: a file that came over the network keeps the
        // "downloaded" mark on the way out (see `mark_as_downloaded`).
        let from_web = db::file_origin_url(&room.conn, &id).is_some();
        std::fs::write(&dest_path, &bytes).map_err(|e| format!("Could not save the file: {e}"))?;
        if from_web {
            mark_as_downloaded(std::path::Path::new(&dest_path));
        }
        Ok(())
    })
}

/// Reduce a stored file name to something that can only land INSIDE the folder
/// the user picked: keep the last path component and neutralise separators /
/// NUL. Nothing validates a file's name on the way IN (a download, a
/// model-generated file and a skill resource all name themselves), so a row
/// called `../../Library/LaunchAgents/x.plist` would otherwise write outside
/// the chosen folder. The `roomai` CLI's `sanitize` is the same rule for the
/// same reason — the two live in different crates and cannot share it.
pub(crate) fn safe_export_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | '\0') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    }
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
            let name = unique_export_name(&safe_export_name(&f.name), |candidate| {
                dir.join(candidate).exists()
            });
            let out = dir.join(&name);
            std::fs::write(&out, &bytes)
                .map_err(|e| format!("Could not write \"{name}\": {e}"))?;
            // A room's downloads leave as downloads: exporting must not strip
            // the mark macOS shows its Gatekeeper warning off.
            if f.origin_url.is_some() {
                mark_as_downloaded(&out);
            }
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
    // NOT fatal — the room itself is already re-keyed and refusing now would be
    // worse — but it must not pass as a clean success either: the frontend asks
    // `list_stranded_checkpoints` straight afterwards and names what is stuck on
    // the old password, while the user still remembers it.
    //
    // The counter is deliberately content-free: a checkpoint path carries the
    // room's own file name, which is the user's, and it never goes to a log.
    let mut stranded = 0u32;
    for ck in checkpoint_ck_paths(&room_path) {
        if db::rekey_copy(&ck, &current, &new_password).is_err() {
            stranded += 1;
        }
    }
    if stranded > 0 {
        eprintln!("change_password: {stranded} checkpoint(s) could not be re-keyed");
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
    fn export_name_can_never_escape_the_chosen_folder() {
        // A stored name is never validated on the way in, so "Export all files"
        // used to hand it straight to `dir.join(...)`.
        assert_eq!(safe_export_name("../../Library/LaunchAgents/evil.plist"), "evil.plist");
        assert_eq!(safe_export_name("/etc/passwd"), "passwd");
        assert_eq!(safe_export_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(safe_export_name(".."), "unnamed");
        assert_eq!(safe_export_name("   "), "unnamed");
        assert_eq!(safe_export_name("with\0nul.txt"), "with_nul.txt");
        // Ordinary names are untouched.
        assert_eq!(safe_export_name("Lease 2026.pdf"), "Lease 2026.pdf");
        // And the sanitized name is what the clash suffix is built from.
        let taken: std::collections::HashSet<String> = ["evil.plist".to_string()].into();
        assert_eq!(
            unique_export_name(&safe_export_name("../evil.plist"), |c| taken.contains(c)),
            "evil (2).plist"
        );
    }

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

    /// A version id held by an open History strip still resolves after the file
    /// is deleted — the version rows deliberately survive, so a restore from the
    /// trash finds its whole history intact. Neither door it opens may lead back
    /// into the file: comparing would show a deleted file's text side by side,
    /// and restoring would write an old draft into it and tell the UI it changed.
    #[test]
    fn a_version_of_a_trashed_file_can_neither_be_read_nor_restored_through() {
        let conn = db::open_in_memory_schema();
        let fid = db::insert_file(
            &conn, "offer.txt", "text/plain", b"we offer 90 days", Some("we offer 90 days"), "upload",
        ).unwrap().id;
        db::snapshot_file_version(&conn, &fid, "Edited").unwrap();
        let vid = db::list_file_versions(&conn, &fid).unwrap()[0].id.clone();
        db::update_file_content(&conn, &fid, b"we offer 30 days", Some("we offer 30 days")).unwrap();

        db::trash_file(&conn, &fid, db::TrashActor::User).unwrap();

        assert!(version_content(&conn, &vid).is_err(), "the compare view has nothing to show");
        assert!(restore_version_into(&conn, &vid).is_err());
        // The row is untouched by the refused restore — a later undelete gets
        // the file exactly as the user left it.
        let (_, _, text, _) = db::get_version(&conn, &vid).unwrap();
        assert_eq!(text.as_deref(), Some("we offer 90 days"));
        db::restore_file(&conn, &fid).unwrap();
        assert_eq!(
            db::get_file_extracted_text(&conn, &fid).as_deref(),
            Some("we offer 30 days"),
            "the trashed file kept the content it had, not the version nobody restored"
        );
        // And with the file back, the strip and the restore work again.
        assert_eq!(db::list_file_versions(&conn, &fid).unwrap().len(), 1);
        assert_eq!(restore_version_into(&conn, &vid).unwrap(), fid);
        assert_eq!(db::get_file_extracted_text(&conn, &fid).as_deref(), Some("we offer 90 days"));
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

    #[test]
    fn an_exported_download_keeps_its_came_from_the_web_mark() {
        // Exporting used to write plain, unmarked files, so a room's downloaded
        // installer came out of the room with Gatekeeper's warning stripped —
        // the one export that most needed it.
        let dir = std::env::temp_dir().join(format!("arcelle-qtn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let downloaded = dir.join("installer.dmg");
        let hand_made = dir.join("notes.txt");
        std::fs::write(&downloaded, b"payload").unwrap();
        std::fs::write(&hand_made, b"mine").unwrap();

        mark_as_downloaded(&downloaded);

        assert_eq!(
            read_quarantine(&downloaded).as_deref().map(|v| v.split(';').next().unwrap_or("")),
            Some("0001"),
            "an exported download must carry the QTN_FLAG_DOWNLOAD bit"
        );
        // And it carries no origin URL — the room's provenance stays in the room.
        let value = read_quarantine(&downloaded).unwrap();
        assert!(!value.contains("http"), "the mark must not carry the origin URL: {value}");
        assert_eq!(value.split(';').count(), 4, "flags;time;agent;uuid — got {value}");
        // A file the user made themselves is left alone: quarantining every
        // export would put a scary dialog in front of their own documents.
        assert_eq!(read_quarantine(&hand_made), None);

        assert_eq!(quarantine_value(0x6890_0000), "0001;68900000;Arcelle;");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Read `com.apple.quarantine` back off a path (test-only mirror of the
    /// setter, so the assertion is about the real filesystem, not our string).
    fn read_quarantine(path: &std::path::Path) -> Option<String> {
        use std::os::unix::ffi::OsStrExt as _;
        unsafe extern "C" {
            fn getxattr(
                path: *const std::ffi::c_char,
                name: *const std::ffi::c_char,
                value: *mut std::ffi::c_void,
                size: usize,
                position: u32,
                options: std::ffi::c_int,
            ) -> isize;
        }
        let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut buf = [0u8; 256];
        // SAFETY: valid NUL-terminated path, a buffer we own, and its length.
        let n = unsafe {
            getxattr(
                cpath.as_ptr(),
                c"com.apple.quarantine".as_ptr(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
                0,
            )
        };
        if n <= 0 {
            return None;
        }
        String::from_utf8(buf[..n as usize].to_vec()).ok()
    }

    #[test]
    fn a_checkpoint_that_missed_the_rekey_is_reported_not_silently_stranded() {
        // The re-key loop swallowed every failure, so the password change
        // reported a clean success and the user met the stranded checkpoint
        // weeks later — as a rollback error blaming the password they typed.
        let path = db::temp_room_path();
        let dir = checkpoints_dir(&path);
        {
            let conn = db::create_room(&path, "old-password", "Room").unwrap();
            db::insert_file(&conn, "a.txt", "text/plain", b"hi", Some("hi"), "upload").unwrap();
            write_checkpoint(&conn, &dir, "Before the big edit", false).unwrap();
            write_checkpoint(&conn, &dir, "Weekly", false).unwrap();
        }
        // Every checkpoint still opens with the old password: nothing stranded.
        assert!(stranded_checkpoint_names(&path, "old-password").is_empty());

        // Re-key ONE of them and leave the other behind, exactly as a failed
        // `rekey_copy` in change_password's loop does.
        let one = checkpoint_ck_paths(&path).into_iter().next().unwrap();
        db::rekey_copy(&one, "old-password", "new-password-xx").unwrap();

        let stuck = stranded_checkpoint_names(&path, "new-password-xx");
        assert_eq!(stuck.len(), 1, "exactly one checkpoint is still on the old key");
        assert!(
            stuck[0] == "Before the big edit" || stuck[0] == "Weekly",
            "a stranded checkpoint is named by the name the user gave it, got {:?}",
            stuck[0]
        );
        // And once the laggard is re-keyed too, nothing is reported — the answer
        // is recomputed from the files, never remembered from the failure.
        for ck in checkpoint_ck_paths(&path) {
            let _ = db::rekey_copy(&ck, "old-password", "new-password-xx");
        }
        assert!(stranded_checkpoint_names(&path, "new-password-xx").is_empty());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
