use super::*;

/// Path to the recent-rooms list in the app's own data folder (outside any
/// room). Rooms are encrypted; this file holds only names and paths.
pub(crate) fn recent_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recent.json"))
}

pub(crate) fn read_recent(app: &tauri::AppHandle) -> Vec<RecentRoom> {
    recent_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn write_recent(app: &tauri::AppHandle, list: &[RecentRoom]) -> Result<(), String> {
    let path = recent_file(app)?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    // Temp-then-rename, like the checkpoint manifest: overwriting in place
    // leaves a truncated, unparseable file if the app dies or the disk fills
    // mid-write — and an unparseable recent.json silently reads back as "no
    // recent rooms at all".
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Push a room to the front of the recents: most-recent-first, deduped by path,
/// capped at 5.
pub(crate) fn merge_recent(mut list: Vec<RecentRoom>, entry: RecentRoom) -> Vec<RecentRoom> {
    list.retain(|r| r.path != entry.path);
    list.insert(0, entry);
    list.truncate(5);
    list
}

/// Point every recents entry for `path` at a new name (`rename_room`). The
/// recents list carries its own copy of each room's name — it has to, since it
/// names rooms that are locked and cannot be read — so a rename that only wrote
/// the room's `meta` would leave the start screen showing the old name until
/// that room was next opened.
pub(crate) fn rename_recent(mut list: Vec<RecentRoom>, path: &str, name: &str) -> Vec<RecentRoom> {
    for entry in list.iter_mut().filter(|r| r.path == path) {
        entry.name = name.to_string();
    }
    list
}

pub(crate) fn push_recent(app: &tauri::AppHandle, name: &str, path: &str) {
    let opened_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64);
    let list = merge_recent(
        read_recent(app),
        RecentRoom {
            name: name.to_string(),
            path: path.to_string(),
            opened_at,
            missing: false,
        },
    );
    let _ = write_recent(app, &list);
}

#[tauri::command]
pub fn list_recent(app: tauri::AppHandle) -> Result<Vec<RecentRoom>, String> {
    // A room that was moved, deleted, or lives on a drive that isn't plugged in
    // used to look exactly like a working one — you found out only after typing
    // the password. Stat each path as the list is handed over.
    let mut list = read_recent(&app);
    for entry in list.iter_mut() {
        entry.missing = !std::path::Path::new(&entry.path).exists();
    }
    Ok(list)
}

#[tauri::command]
pub fn remove_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut list = read_recent(&app);
    list.retain(|r| r.path != path);
    write_recent(&app, &list)
}

#[tauri::command]
pub fn clear_recent(app: tauri::AppHandle) -> Result<(), String> {
    write_recent(&app, &[])
}

// ---------------------------------------------------------------- memory


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_dedup_and_cap() {
        let mk = |p: &str| RecentRoom {
            name: p.into(),
            path: p.into(),
            opened_at: None,
            missing: false,
        };
        let mut list: Vec<RecentRoom> = Vec::new();
        for p in ["a", "b", "c", "d", "e", "f"] {
            list = merge_recent(list, mk(p));
        }
        // Newest first, capped at 5 (the oldest, "a", fell off).
        assert_eq!(list.len(), 5);
        assert_eq!(list[0].path, "f");
        assert_eq!(list.last().unwrap().path, "b");
        // Re-opening an existing path moves it to the front without duplicating.
        list = merge_recent(list, mk("c"));
        assert_eq!(list.len(), 5);
        assert_eq!(list[0].path, "c");
        assert_eq!(list.iter().filter(|r| r.path == "c").count(), 1);
    }

    #[test]
    fn renaming_a_room_renames_its_recents_entry() {
        // A room could never be renamed at all; now that it can, the start
        // screen must not keep showing the name the room had when it was
        // created — the recents list holds its own copy of it.
        let mk = |p: &str, n: &str| RecentRoom {
            name: n.into(),
            path: p.into(),
            opened_at: Some(1),
            missing: false,
        };
        let list = vec![mk("/a.roomai", "Old"), mk("/b.roomai", "Other")];
        let renamed = rename_recent(list, "/a.roomai", "New");
        assert_eq!(renamed[0].name, "New");
        assert_eq!(renamed[0].path, "/a.roomai");
        // Every other field, and every other room, is left alone.
        assert_eq!(renamed[0].opened_at, Some(1));
        assert_eq!(renamed[1].name, "Other");
        // A path that isn't in the list is a no-op, not an insert.
        let untouched = rename_recent(renamed, "/gone.roomai", "Nope");
        assert_eq!(untouched.len(), 2);
        assert_eq!(untouched[0].name, "New");
    }
}
