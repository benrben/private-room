use super::*;

/// ADD-6: memories whose content contains `needle` (already lowercased) —
/// (memory id, content).
pub fn memories_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String)>, String> {
    query_rows(
        conn,
        "SELECT id, content FROM memories WHERE lower(content) LIKE '%' || ?1 || '%'
         ORDER BY created_at DESC LIMIT 30",
        [needle],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// Wave 1b (idea 5): `category` is one of preference|fact|project|instruction
/// (callers normalize via `normalize_category`), or None = uncategorized.
pub fn add_memory(
    conn: &Connection,
    content: &str,
    category: Option<&str>,
) -> Result<Memory, String> {
    let id = Uuid::new_v4().to_string();
    execute_one(
        conn,
        "INSERT INTO memories(id, content, category) VALUES (?1, ?2, ?3)",
        params![id, content, category],
    )?;
    let created_at: String = query_one(
        conn,
        "SELECT created_at FROM memories WHERE id = ?1",
        [&id],
        |r| r.get(0),
    )?;
    Ok(Memory {
        id,
        content: content.to_string(),
        category: category.map(str::to_string),
        created_at,
    })
}

pub fn list_memories(conn: &Connection) -> Result<Vec<Memory>, String> {
    query_rows(
        conn,
        "SELECT id, content, category, created_at FROM memories ORDER BY created_at ASC",
        [],
        |r| {
            Ok(Memory {
                id: r.get(0)?,
                content: r.get(1)?,
                category: r.get(2)?,
                created_at: r.get(3)?,
            })
        },
    )
}

pub fn delete_memory(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM memories WHERE id = ?1", [id])
}

/// UX-5: overwrite a memory's text (and, Wave 1b, its category) in place.
pub fn update_memory(
    conn: &Connection,
    id: &str,
    content: &str,
    category: Option<&str>,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE memories SET content = ?2, category = ?3 WHERE id = ?1",
        params![id, content, category],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_update_persists() {
        let conn = mem();
        let m = add_memory(&conn, "old text", None).unwrap();
        update_memory(&conn, &m.id, "new text", None).unwrap();
        let got = list_memories(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].content, "new text");
    }

    #[test]
    fn memory_category_roundtrip() {
        let conn = mem();
        let m = add_memory(&conn, "answers in Hebrew, please", Some("preference")).unwrap();
        assert_eq!(m.category.as_deref(), Some("preference"));
        let got = list_memories(&conn).unwrap();
        assert_eq!(got[0].category.as_deref(), Some("preference"));
        // An edit can move it to another category — or clear it.
        update_memory(&conn, &m.id, "answers in Hebrew", Some("instruction")).unwrap();
        assert_eq!(
            list_memories(&conn).unwrap()[0].category.as_deref(),
            Some("instruction")
        );
        update_memory(&conn, &m.id, "answers in Hebrew", None).unwrap();
        assert!(list_memories(&conn).unwrap()[0].category.is_none());
    }

    #[test]
    fn memory_category_nullable_for_legacy_rows() {
        // A row inserted the pre-category way (no category value) reads back
        // as None — exactly what migrated legacy rooms hold.
        let conn = mem();
        conn.execute(
            "INSERT INTO memories(id, content) VALUES ('legacy', 'old note')",
            [],
        )
        .unwrap();
        let got = list_memories(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].category.is_none());
    }
}
