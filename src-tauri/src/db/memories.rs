use super::*;

/// ADD-6: memories containing every word of `needle` (already lowercased), in
/// any order — (memory id, content). The words are taken LITERALLY; see
/// `files_name_like` for why all three of `search_all`'s queries have to agree
/// about both of those rules.
pub fn memories_like(conn: &Connection, needle: &str) -> Result<Vec<(String, String)>, String> {
    let terms = search_terms(needle);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id, content FROM memories WHERE trashed_at IS NULL{}
         ORDER BY created_at DESC LIMIT 30",
        like_all_clause("content", &terms, 1),
    );
    query_rows(conn, &sql, rusqlite::params_from_iter(terms), |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
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
        "SELECT id, content, category, created_at FROM memories \
         WHERE trashed_at IS NULL ORDER BY created_at ASC",
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

/// S9 (2026-08-04): soft delete, same shape as `trash_file`/`restore_file` —
/// the row, its content and its history stay exactly where they are; only a
/// flag changes. `delete_memory` was the app's one truly irreversible AI
/// action (every file write has a snapshot; this had nothing). Trashing an
/// already-trashed memory is refused rather than re-stamped, for the same
/// reason `trash_file` refuses it: a second trash would overwrite the record
/// of who actually deleted it.
pub fn delete_memory(conn: &Connection, id: &str, actor: TrashActor<'_>) -> Result<(), String> {
    let (kind, actor_id) = actor.parts();
    let n = conn
        .execute(
            "UPDATE memories
             SET trashed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                 trashed_by = ?2, trashed_by_id = ?3
             WHERE id = ?1 AND trashed_at IS NULL",
            params![id, kind, actor_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("That memory is not in this room.".into());
    }
    Ok(())
}

/// Put a trashed memory back — same "error, not a no-op" reasoning as
/// `restore_file`: a caller offering Restore on a memory already active is
/// showing a stale list, and silently succeeding would confirm a state it
/// never checked. Not exposed to the agent — recovery is a human action.
pub fn restore_memory(conn: &Connection, id: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE memories SET trashed_at = NULL, trashed_by = NULL, trashed_by_id = NULL
             WHERE id = ?1 AND trashed_at IS NOT NULL",
            [id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("That memory is not in the trash.".into());
    }
    Ok(())
}

/// UX-5: overwrite a memory's text (and, Wave 1b, its category) in place.
///
/// Scoped to a memory that is still IN the room, and an error when it is not —
/// the same invariant every by-id write to `files` carries. An edit typed into
/// a card whose memory was trashed in the meantime (the agent's forget tool, or
/// another window) landed on the trashed row, reported success, and vanished
/// from the list: the text was gone from the screen, still in the database, and
/// waiting to reappear the moment anyone restored it.
pub fn update_memory(
    conn: &Connection,
    id: &str,
    content: &str,
    category: Option<&str>,
) -> Result<(), String> {
    execute_existing(
        conn,
        "UPDATE memories SET content = ?2, category = ?3
         WHERE id = ?1 AND trashed_at IS NULL",
        params![id, content, category],
        "That memory is not in this room.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_memory_search_takes_like_wildcards_literally() {
        // The sibling of `files_name_like`'s test: all three of `search_all`'s
        // queries have to agree about what the same needle means.
        let conn = mem();
        add_memory(&conn, "the deposit is 50% of rent", None).unwrap();
        add_memory(&conn, "50 pounds a week", None).unwrap();
        add_memory(&conn, "file a_b is the master", None).unwrap();
        add_memory(&conn, "file axb is a copy", None).unwrap();

        let hits = memories_like(&conn, "50%").unwrap();
        assert_eq!(hits.len(), 1, "`%` still wildcarded: {hits:?}");
        assert!(hits[0].1.contains("50% of rent"));

        let hits = memories_like(&conn, "a_b").unwrap();
        assert_eq!(hits.len(), 1, "`_` still wildcarded: {hits:?}");
        assert!(hits[0].1.contains("a_b"));

        assert_eq!(memories_like(&conn, "pounds").unwrap().len(), 1);
    }

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

    #[test]
    fn deleting_a_memory_soft_deletes_it_content_survives() {
        let conn = mem();
        let m = add_memory(&conn, "call every Friday", None).unwrap();
        delete_memory(&conn, &m.id, TrashActor::Agent("delete_memory")).unwrap();
        // Gone from every read path an agent or the UI would use...
        assert!(list_memories(&conn).unwrap().is_empty());
        assert!(memories_like(&conn, "Friday").unwrap().is_empty());
        // ...but the row itself, and its text, are still there.
        let raw: String = conn
            .query_row("SELECT content FROM memories WHERE id = ?1", [&m.id], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "call every Friday");
    }

    #[test]
    fn restoring_a_memory_returns_it_to_every_listing() {
        let conn = mem();
        let m = add_memory(&conn, "call every Friday", None).unwrap();
        delete_memory(&conn, &m.id, TrashActor::User).unwrap();
        assert!(list_memories(&conn).unwrap().is_empty());
        restore_memory(&conn, &m.id).unwrap();
        let got = list_memories(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].content, "call every Friday");
    }

    #[test]
    fn deleting_an_already_deleted_memory_is_refused_not_re_stamped() {
        // Same reasoning as `trash_file`: a second trash would overwrite the
        // record of who actually deleted it.
        let conn = mem();
        let m = add_memory(&conn, "x", None).unwrap();
        delete_memory(&conn, &m.id, TrashActor::Agent("delete_memory")).unwrap();
        let err = delete_memory(&conn, &m.id, TrashActor::User).unwrap_err();
        assert!(err.contains("not in this room"), "got: {err}");
    }

    #[test]
    fn restoring_a_memory_that_is_not_trashed_is_an_error_not_a_no_op() {
        let conn = mem();
        let m = add_memory(&conn, "x", None).unwrap();
        let err = restore_memory(&conn, &m.id).unwrap_err();
        assert!(err.contains("not in the trash"), "got: {err}");
    }

    /// Editing a memory that has been trashed since the card was opened is
    /// REFUSED, not silently swallowed. The old UPDATE matched on id alone, so
    /// the typed text landed on the trashed row: the save said nothing, the
    /// refetched list no longer held it, and restoring the memory later brought
    /// back the post-deletion text as if it had always been there.
    #[test]
    fn editing_a_trashed_memory_is_refused_and_changes_nothing() {
        let conn = mem();
        let m = add_memory(&conn, "call every Friday", None).unwrap();
        delete_memory(&conn, &m.id, TrashActor::Agent("delete_memory")).unwrap();

        let err = update_memory(&conn, &m.id, "call every Tuesday", None).unwrap_err();
        assert!(err.contains("not in this room"), "got: {err}");

        // The trashed row still says what it said when it was trashed.
        let raw: String = conn
            .query_row("SELECT content FROM memories WHERE id = ?1", [&m.id], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "call every Friday");
        // …and putting it back cannot resurrect an edit nobody could see.
        restore_memory(&conn, &m.id).unwrap();
        assert_eq!(list_memories(&conn).unwrap()[0].content, "call every Friday");
    }

    #[test]
    fn editing_a_memory_that_was_never_here_is_refused() {
        let conn = mem();
        let err = update_memory(&conn, "no-such-id", "text", None).unwrap_err();
        assert!(err.contains("not in this room"), "got: {err}");
    }
}
