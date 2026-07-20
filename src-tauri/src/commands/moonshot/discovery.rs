/// Wave 1a: `~/.arcelle/leash.json` — the discovery record an external
/// agent self-configures from (`cat ~/.arcelle/leash.json`) without the
/// user re-pasting a config. Written 0600 (it carries the bearer token) on
/// every Leash start, removed on stop, teardown, and app exit. `pid` is the
/// staleness check: after a crash the file may survive, so a reader should
/// verify the pid is alive before trusting the record; the next start
/// unconditionally overwrites it, so crash leftovers self-heal.
fn leash_json(port: u16, token: &str, scope: &str, room: &str) -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "token": token,
        "scope": scope,
        "room": room,
        "pid": std::process::id(),
        // Unix seconds — with `pid`, lets a reader judge staleness.
        "startedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })
}

/// The fixed discovery path. Home dir via tauri's resolver (no `dirs` crate).
fn discovery_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".arcelle").join("leash.json"))
}

pub(crate) fn write_discovery(
    app: &tauri::AppHandle,
    port: u16,
    token: &str,
    scope: &str,
    room: &str,
) -> Result<(), String> {
    write_discovery_at(&discovery_file(app)?, &leash_json(port, token, scope, room))
}

/// Write the record 0600, overwriting whatever is there. The mode is enforced
/// with `set_permissions` too — `mode(0o600)` only applies when the file is
/// created, and a pre-existing leftover must not keep looser permissions.
fn write_discovery_at(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    use std::os::unix::fs::PermissionsExt as _;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    f.write_all(value.to_string().as_bytes()).map_err(|e| e.to_string())
}

/// Remove the discovery record (stop / teardown / app exit). Best-effort and
/// idempotent — a missing file is fine.
pub(crate) fn remove_discovery(app: &tauri::AppHandle) {
    if let Ok(path) = discovery_file(app) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    #[test]
    fn discovery_file_fields_perms_and_removal() {
        let dir = std::env::temp_dir().join(format!("leash-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("leash.json");
        let v = leash_json(17872, "tok123", "full", "My Room");
        write_discovery_at(&path, &v).unwrap();
        // Content: every field an external agent needs to self-configure.
        let read: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read["version"], 1);
        assert_eq!(read["url"], "http://127.0.0.1:17872/mcp");
        assert_eq!(read["token"], "tok123");
        assert_eq!(read["scope"], "full");
        assert_eq!(read["room"], "My Room");
        assert_eq!(read["pid"], std::process::id());
        assert!(read["startedAt"].as_u64().unwrap() > 0);
        // 0600 — the bearer token must never be group/world readable, even
        // when a leftover file existed with looser permissions.
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_discovery_at(&path, &v).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // Removal is idempotent.
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
