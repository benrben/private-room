use super::*;

pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM folders ORDER BY name COLLATE NOCASE ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Create a folder. Names are UNIQUE, so a clash is reported in plain language.
pub fn create_folder(conn: &Connection, name: &str) -> Result<Folder, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Folder name cannot be empty.".into());
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO folders(id, name) VALUES (?1, ?2)",
        params![id, name],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("A folder named \"{name}\" already exists.")
        } else {
            e.to_string()
        }
    })?;
    Ok(Folder {
        id,
        name: name.to_string(),
    })
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Folder name cannot be empty.".into());
    }
    conn.execute(
        "UPDATE folders SET name = ?2 WHERE id = ?1",
        params![id, name],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("A folder named \"{name}\" already exists.")
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

/// Delete a folder. Its files are moved back to the top level (folder_id → NULL)
/// FIRST — deleting a folder must never delete or hide files (ADD-16).
pub fn delete_folder(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE files SET folder_id = NULL WHERE folder_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move a file into a folder, or to the top level when `folder_id` is None.
pub fn move_file_to_folder(
    conn: &Connection,
    file_id: &str,
    folder_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE files SET folder_id = ?2 WHERE id = ?1",
        params![file_id, folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
}
