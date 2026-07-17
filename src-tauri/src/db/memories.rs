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

pub fn add_memory(conn: &Connection, content: &str) -> Result<Memory, String> {
    let id = Uuid::new_v4().to_string();
    execute_one(
        conn,
        "INSERT INTO memories(id, content) VALUES (?1, ?2)",
        params![id, content],
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
        created_at,
    })
}

pub fn list_memories(conn: &Connection) -> Result<Vec<Memory>, String> {
    query_rows(
        conn,
        "SELECT id, content, created_at FROM memories ORDER BY created_at ASC",
        [],
        |r| {
            Ok(Memory {
                id: r.get(0)?,
                content: r.get(1)?,
                created_at: r.get(2)?,
            })
        },
    )
}

pub fn delete_memory(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM memories WHERE id = ?1", [id])
}

/// UX-5: overwrite a memory's text in place.
pub fn update_memory(conn: &Connection, id: &str, content: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE memories SET content = ?2 WHERE id = ?1",
        params![id, content],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_update_persists() {
        let conn = mem();
        let m = add_memory(&conn, "old text").unwrap();
        update_memory(&conn, &m.id, "new text").unwrap();
        let got = list_memories(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].content, "new text");
    }
}
