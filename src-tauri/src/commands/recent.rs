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

/// Write `bytes` to `path` readable by THIS user only (0600).
///
/// The rooms themselves are encrypted, but this list is not: it holds the names
/// the user gave their rooms and where on disk they are. At the default 0644
/// every other account on the Mac — and every backup — could read
/// "Divorce papers" without touching a single encrypted byte. The mode is set
/// twice on purpose: `mode()` only applies when the file is CREATED, and a
/// leftover from an older build must not keep its looser permissions.
/// (Same shape as `moonshot::discovery::write_discovery_at`.)
pub(crate) fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    use std::os::unix::fs::PermissionsExt as _;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    f.write_all(bytes)
}

pub(crate) fn write_recent(app: &tauri::AppHandle, list: &[RecentRoom]) -> Result<(), String> {
    let path = recent_file(app)?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    // Temp-then-rename, like the checkpoint manifest: overwriting in place
    // leaves a truncated, unparseable file if the app dies or the disk fills
    // mid-write — and an unparseable recent.json silently reads back as "no
    // recent rooms at all". The temp file is written 0600 as well, because a
    // rename carries the mode with it.
    let tmp = path.with_extension("json.tmp");
    write_private(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
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

/// Stat every entry so a moved/deleted/unplugged room says so. Split out from
/// the command for the test, and because it is the only blocking part.
pub(crate) fn mark_missing(list: &mut [RecentRoom]) {
    for entry in list.iter_mut() {
        entry.missing = !std::path::Path::new(&entry.path).exists();
    }
}

#[tauri::command]
pub async fn list_recent(app: tauri::AppHandle) -> Result<Vec<RecentRoom>, String> {
    // A room that was moved, deleted, or lives on a drive that isn't plugged in
    // used to look exactly like a working one — you found out only after typing
    // the password. Stat each path as the list is handed over.
    //
    // ASYNC deliberately: a `pub fn` command runs on Tauri's MAIN thread, and
    // `exists()` on a recents entry that lives on an unresponsive network mount
    // blocks for the mount's timeout — freezing the start screen in exactly the
    // "drive that isn't plugged in" case this check exists for. Off the UI
    // thread, the worst case is that the start screen's list arrives late.
    tokio::task::spawn_blocking(move || {
        let mut list = read_recent(&app);
        mark_missing(&mut list);
        list
    })
    .await
    .map_err(|e| e.to_string())
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

    /// The recents list and the checkpoint index are the two PLAINTEXT files
    /// beside an encrypted room, and both hold names the user typed. At the
    /// default 0644 any other account on this Mac could read them.
    #[test]
    fn the_plaintext_room_index_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recent.json");
        // Pre-create it world-readable: an existing file from an older build
        // must be tightened, not left as it was.
        std::fs::write(&path, b"[]").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, b"[{\"name\":\"x\"}]").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "room names must not be world-readable");
        assert_eq!(std::fs::read(&path).unwrap(), b"[{\"name\":\"x\"}]");
    }

    #[test]
    fn a_room_whose_file_is_gone_is_marked_missing() {
        let dir = tempfile::tempdir().unwrap();
        let here = dir.path().join("here.arcelle");
        std::fs::write(&here, b"x").unwrap();
        let mk = |p: std::path::PathBuf| RecentRoom {
            name: "r".into(),
            path: p.to_string_lossy().into_owned(),
            opened_at: None,
            // Seeded TRUE for the present file and FALSE for the absent one, so
            // the assertions can only pass if the stat actually ran — a stale
            // `missing` cached in recent.json is never the answer.
            missing: true,
        };
        let mut list = vec![mk(here), mk(dir.path().join("moved-away.arcelle"))];
        list[1].missing = false;
        mark_missing(&mut list);
        assert!(!list[0].missing, "a room whose file is there is not missing");
        assert!(list[1].missing, "a moved/deleted room must be marked missing");
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
