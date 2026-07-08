use super::*;

/// ADD-2: a file's saved versions (newest first).
#[tauri::command]
pub fn list_file_versions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<FileVersion>, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::list_file_versions(&room.conn, &id)
}

/// ADD-2: restore a saved version's bytes. Goes back through `store_file_bytes`,
/// so the CURRENT state is snapshotted first — restoring is itself undoable.
#[tauri::command]
pub fn restore_file_version(
    window: tauri::Window,
    state: State<'_, AppState>,
    version_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let (file_id, bytes) = db::get_version(&room.conn, &version_id)?;
    let name = db::get_file_name(&room.conn, &file_id)?;
    let text = extraction::extract_text(&name, &bytes)
        .or_else(|| String::from_utf8(bytes.clone()).ok());
    store_file_bytes(&room.conn, &file_id, &bytes, text.as_deref(), "Restored")?;
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("file-updated", &file_id);
    Ok(())
}

/// ADD-1: write one file's original bytes out as a normal (unencrypted) file.
#[tauri::command]
pub fn export_file(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
) -> Result<(), String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let bytes = db::get_file_bytes(&room.conn, &id)?
        .ok_or("This file has no stored content to export.")?;
    std::fs::write(&dest_path, &bytes).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(())
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
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
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
}

/// SEC-4: rotate the room's password. Verifies `current` on a second throwaway
/// connection, then re-keys the live connection.
#[tauri::command]
pub fn change_password(
    state: State<'_, AppState>,
    current: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.chars().count() < 8 {
        return Err("Password must be at least 8 characters.".into());
    }
    let mut guard = state.room.lock().unwrap();
    let room = guard.as_mut().ok_or("No room is open.")?;
    db::verify_password(&room.path, &current)?;
    db::rekey(&room.conn, &new_password)?;
    room.password = new_password;
    // ADD-11: keep Touch ID working after a password change. Chosen behavior:
    // UPDATE the Keychain entry with the new password (re-store overwrites it).
    // Storing creates a fresh biometric item and needs no prompt. If it somehow
    // fails, delete the stale entry so Touch ID can never hand back the old
    // password — the room then falls back to typing until re-enabled.
    if crate::biometrics::has(&room.path)
        && crate::biometrics::store(&room.path, &room.password).is_err()
    {
        let _ = crate::biometrics::delete(&room.path);
    }
    Ok(())
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
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    db::vacuum_into(&room.conn, &dest_path)?;
    if let Some(pw) = new_password {
        if let Err(e) = db::rekey_copy(&dest_path, &room.password, &pw) {
            let _ = std::fs::remove_file(&dest_path);
            return Err(e);
        }
    }
    Ok(())
}

/// SEC-7: compact the open room on demand, reporting how much was reclaimed.
#[tauri::command]
pub fn compact_room(state: State<'_, AppState>) -> Result<String, String> {
    let guard = state.room.lock().unwrap();
    let room = guard.as_ref().ok_or("No room is open.")?;
    let reclaimable = db::reclaimable_bytes(&room.conn)?;
    let mb = reclaimable as f64 / (1024.0 * 1024.0);
    if mb < 0.05 {
        return Ok("Nothing to recover.".into());
    }
    db::vacuum(&room.conn)?;
    Ok(format!("Recovered {mb:.1} MB."))
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

}
