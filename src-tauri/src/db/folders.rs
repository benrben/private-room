use super::*;

pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>, String> {
    query_rows(
        conn,
        "SELECT id, name FROM folders ORDER BY name COLLATE NOCASE ASC",
        [],
        |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        },
    )
}

fn reject_blank_folder_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Folder name cannot be empty.".into());
    }
    Ok(name)
}

fn folder_name_taken(name: &str) -> String {
    format!("A folder named \"{name}\" already exists.")
}

/// The folders table's UNIQUE index is case-SENSITIVE, so "Legal" and "legal"
/// could both exist and look identical in the sidebar. Reject the clash here.
/// `except_id` lets a rename keep its own current name (including a pure
/// change of capitalization, which is a legitimate rename).
fn folder_name_clashes(conn: &Connection, name: &str, except_id: Option<&str>) -> bool {
    conn.query_row(
        "SELECT 1 FROM folders WHERE name = ?1 COLLATE NOCASE
           AND (?2 IS NULL OR id <> ?2) LIMIT 1",
        params![name, except_id],
        |_| Ok(()),
    )
    .is_ok()
}

/// Create a folder. Names are UNIQUE (and, here, unique ignoring case), so a
/// clash is reported in plain language.
pub fn create_folder(conn: &Connection, name: &str) -> Result<Folder, String> {
    let name = reject_blank_folder_name(name)?;
    if folder_name_clashes(conn, name, None) {
        return Err(folder_name_taken(name));
    }
    let id = Uuid::new_v4().to_string();
    execute_unique(
        conn,
        "INSERT INTO folders(id, name) VALUES (?1, ?2)",
        params![id, name],
        || folder_name_taken(name),
    )?;
    Ok(Folder {
        id,
        name: name.to_string(),
    })
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = reject_blank_folder_name(name)?;
    if folder_name_clashes(conn, name, Some(id)) {
        return Err(folder_name_taken(name));
    }
    execute_unique(
        conn,
        "UPDATE folders SET name = ?2 WHERE id = ?1",
        params![id, name],
        || folder_name_taken(name),
    )
}

/// Delete a folder. Its files are moved back to the top level (folder_id → NULL)
/// FIRST — deleting a folder must never delete or hide files (ADD-16).
pub fn delete_folder(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE files SET folder_id = NULL WHERE folder_id = ?1",
        [id],
    )?;
    execute_one(conn, "DELETE FROM folders WHERE id = ?1", [id])
}

/// Move a file into a folder, or to the top level when `folder_id` is None.
pub fn move_file_to_folder(
    conn: &Connection,
    file_id: &str,
    folder_id: Option<&str>,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE files SET folder_id = ?2 WHERE id = ?1",
        params![file_id, folder_id],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_a_folder_keeps_its_files() {
        let conn = mem();
        let folder = create_folder(&conn, "Contracts").unwrap();
        let f1 = add_file(&conn, "a.txt", "alpha");
        let f2 = add_file(&conn, "b.txt", "beta");
        move_file_to_folder(&conn, &f1, Some(&folder.id)).unwrap();
        move_file_to_folder(&conn, &f2, Some(&folder.id)).unwrap();
        assert_eq!(get_file_meta(&conn, &f1).unwrap().folder_id.as_deref(), Some(folder.id.as_str()));

        delete_folder(&conn, &folder.id).unwrap();

        // Folder gone, but both files survive and are back at the top level.
        assert!(list_folders(&conn).unwrap().is_empty());
        assert_eq!(list_files(&conn).unwrap().len(), 2);
        assert_eq!(get_file_meta(&conn, &f1).unwrap().folder_id, None);
        assert_eq!(get_file_meta(&conn, &f2).unwrap().folder_id, None);
    }

    #[test]
    fn folder_names_are_unique() {
        let conn = mem();
        create_folder(&conn, "Legal").unwrap();
        assert!(create_folder(&conn, "Legal").is_err());
        assert!(create_folder(&conn, "  ").is_err());
    }

    #[test]
    fn folder_names_are_unique_ignoring_case() {
        // "Legal" and "legal" used to be able to sit side by side, looking
        // identical in the sidebar with no way to tell them apart.
        let conn = mem();
        let legal = create_folder(&conn, "Legal").unwrap();
        assert!(create_folder(&conn, "legal").is_err());
        assert!(create_folder(&conn, "LEGAL").is_err());
        // A rename onto another folder's name is refused the same way…
        let hr = create_folder(&conn, "HR").unwrap();
        assert!(rename_folder(&conn, &hr.id, "LEGAL").is_err());
        // …but re-capitalizing a folder's OWN name is a legitimate rename.
        rename_folder(&conn, &legal.id, "LEGAL").unwrap();
        assert_eq!(list_folders(&conn).unwrap().iter().filter(|f| f.name == "LEGAL").count(), 1);
    }
}
