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
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Push a room to the front of the recents: most-recent-first, deduped by path,
/// capped at 5.
pub(crate) fn merge_recent(mut list: Vec<RecentRoom>, entry: RecentRoom) -> Vec<RecentRoom> {
    list.retain(|r| r.path != entry.path);
    list.insert(0, entry);
    list.truncate(5);
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
        },
    );
    let _ = write_recent(app, &list);
}

#[tauri::command]
pub fn list_recent(app: tauri::AppHandle) -> Result<Vec<RecentRoom>, String> {
    Ok(read_recent(&app))
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
        let mk = |p: &str| RecentRoom { name: p.into(), path: p.into(), opened_at: None };
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

}
