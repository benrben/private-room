//! Encrypted persistence for Agent Skills. A skill is intentionally not a room
//! `file`: `skills` represents SKILL.md and `skill_resources` represents the
//! relative folder tree that travels with it.

use super::{execute_existing, execute_one, query_one, query_opt, query_rows};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub created_by: String,
    /// Which sub-agent owns this skill (`agent:` in SKILL.md frontmatter).
    /// Empty = GENERAL: offered to every agent, which is what every skill
    /// authored before 2026-07-24 stays.
    pub agent: String,
    pub resource_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub enabled: bool,
    pub created_by: String,
    /// See `SkillSummary::agent`.
    pub agent: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillResource {
    pub id: String,
    pub skill_id: String,
    pub path: String,
    pub kind: String,
    pub content: Vec<u8>,
    pub created_at: String,
    pub updated_at: String,
}

const SUMMARY_COLS: &str = "s.id, s.name, s.description, s.enabled, s.created_by, \
    (SELECT count(*) FROM skill_resources r WHERE r.skill_id = s.id), \
    s.created_at, s.updated_at, s.agent";

fn summary_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SkillSummary> {
    Ok(SkillSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        enabled: r.get::<_, i64>(3)? != 0,
        created_by: r.get(4)?,
        resource_count: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        agent: r.get(8)?,
    })
}

fn skill_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Skill> {
    Ok(Skill {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        instructions: r.get(3)?,
        enabled: r.get::<_, i64>(4)? != 0,
        created_by: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        agent: r.get(8)?,
    })
}

fn resource_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SkillResource> {
    Ok(SkillResource {
        id: r.get(0)?,
        skill_id: r.get(1)?,
        path: r.get(2)?,
        kind: r.get(3)?,
        content: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

pub fn list_skills(conn: &Connection, enabled_only: bool) -> Result<Vec<SkillSummary>, String> {
    let where_clause = if enabled_only {
        "WHERE s.enabled = 1"
    } else {
        ""
    };
    query_rows(
        conn,
        &format!(
            "SELECT {SUMMARY_COLS} FROM skills s {where_clause} ORDER BY s.name COLLATE NOCASE"
        ),
        [],
        summary_row,
    )
}

pub fn get_skill(conn: &Connection, id: &str) -> Result<Skill, String> {
    query_one(
        conn,
        "SELECT id, name, description, instructions, enabled, created_by, created_at, updated_at, \
         agent FROM skills WHERE id = ?1",
        [id],
        skill_row,
    )
}

pub fn find_skill(conn: &Connection, name_or_id: &str) -> Result<Option<Skill>, String> {
    query_opt(
        conn,
        "SELECT id, name, description, instructions, enabled, created_by, created_at, updated_at, \
         agent FROM skills WHERE id = ?1 OR lower(name) = lower(?1) LIMIT 1",
        [name_or_id],
        skill_row,
    )
}

/// The skills table's UNIQUE index is case-SENSITIVE, so "Legal" and "legal"
/// could both exist — while every LOOKUP is case-INSENSITIVE (`find_skill`
/// matches `lower(name)` and takes the first row it gets). Two skills whose
/// names differ only in capitals are therefore indistinguishable to anyone
/// asking for one by name, and whichever SQLite returns first quietly runs.
/// Reject the clash at the write instead. `except_id` lets a rename keep its own
/// name, including a pure change of capitalization, which is a real rename.
fn skill_name_clashes(conn: &Connection, name: &str, except_id: Option<&str>) -> bool {
    conn.query_row(
        "SELECT 1 FROM skills WHERE name = ?1 COLLATE NOCASE
           AND (?2 IS NULL OR id <> ?2) LIMIT 1",
        params![name, except_id],
        |_| Ok(()),
    )
    .is_ok()
}

pub fn create_skill(
    conn: &Connection,
    name: &str,
    description: &str,
    instructions: &str,
    enabled: bool,
    created_by: &str,
    agent: &str,
) -> Result<String, String> {
    if skill_name_clashes(conn, name, None) {
        return Err(format!("A skill named \"{name}\" already exists."));
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO skills(id, name, description, instructions, enabled, created_by, agent) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            name,
            description,
            instructions,
            enabled as i64,
            created_by,
            agent
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("A skill named \"{name}\" already exists.")
        } else {
            e.to_string()
        }
    })?;
    Ok(id)
}

pub fn update_skill(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    instructions: &str,
    agent: &str,
) -> Result<(), String> {
    if skill_name_clashes(conn, name, Some(id)) {
        return Err(format!("A skill named \"{name}\" already exists."));
    }
    // The affected-row count is the whole point here. A skill deleted in
    // another window (or by the assistant) while this one was open still
    // matched no row, changed nothing, and returned Ok — so Save reported
    // success and threw the edited instructions away. Empty must read as empty.
    let changed = conn
        .execute(
            "UPDATE skills SET name=?2, description=?3, instructions=?4, agent=?5, \
             updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?1",
            params![id, name, description, instructions, agent],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("A skill named \"{name}\" already exists.")
            } else {
                e.to_string()
            }
        })?;
    if changed == 0 {
        return Err(SKILL_GONE.to_string());
    }
    Ok(())
}

/// What every write to a skill that is no longer there says. Word-for-word the
/// sentence `commands::skills`' own existence check uses, so whichever guard
/// fires first the user reads the same thing.
pub const SKILL_GONE: &str = "That skill no longer exists — it was deleted.";

pub fn set_skill_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<(), String> {
    // Same reason as `update_skill`: turning a deleted skill on said "on".
    execute_existing(
        conn,
        "UPDATE skills SET enabled=?2, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?1",
        params![id, enabled as i64],
        SKILL_GONE,
    )
}

pub fn delete_skill(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM skills WHERE id=?1", [id])
}

pub fn list_skill_resources(
    conn: &Connection,
    skill_id: &str,
) -> Result<Vec<SkillResource>, String> {
    query_rows(
        conn,
        "SELECT id, skill_id, path, kind, content, created_at, updated_at \
         FROM skill_resources WHERE skill_id=?1 ORDER BY path COLLATE NOCASE",
        [skill_id],
        resource_row,
    )
}

pub fn get_skill_resource(
    conn: &Connection,
    skill_id: &str,
    path: &str,
) -> Result<SkillResource, String> {
    query_opt(
        conn,
        "SELECT id, skill_id, path, kind, content, created_at, updated_at \
         FROM skill_resources WHERE skill_id=?1 AND path=?2",
        params![skill_id, path],
        resource_row,
    )?
    .ok_or_else(|| missing_resource(conn, skill_id, path))
}

/// A skill that has no file at this path, in words.
///
/// `query_one` answered SQLite's own "Query returned no rows", and that string
/// went out unchanged: to the model as the whole result of
/// `read_skill_resource` — for a SKILL.md naming a file nobody bundled, which
/// is the ordinary way this happens — and to the editor as a red toast when a
/// row that had been deleted underneath it was clicked. The paths the skill
/// DOES have are the half that answers the question.
fn missing_resource(conn: &Connection, skill_id: &str, path: &str) -> String {
    let who = get_skill(conn, skill_id)
        .map(|s| format!("\"{}\"", s.name))
        .unwrap_or_else(|_| "That skill".to_string());
    let has: Vec<String> = list_skill_resources(conn, skill_id)
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.path)
        .collect();
    if has.is_empty() {
        format!("{who} has no file at {path} — no files travel with it at all.")
    } else {
        format!("{who} has no file at {path}. It carries: {}.", has.join(", "))
    }
}

pub fn upsert_skill_resource(
    conn: &Connection,
    skill_id: &str,
    path: &str,
    kind: &str,
    content: &[u8],
) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT INTO skill_resources(id, skill_id, path, kind, content) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(skill_id, path) DO UPDATE SET kind=excluded.kind, content=excluded.content, \
         updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')",
        params![Uuid::new_v4().to_string(), skill_id, path, kind, content],
    )?;
    execute_one(
        conn,
        "UPDATE skills SET updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?1",
        [skill_id],
    )
}

pub fn delete_skill_resource(conn: &Connection, skill_id: &str, path: &str) -> Result<(), String> {
    // A DELETE that matched nothing used to answer Ok, and the tool above it
    // reported "Deleted references/policy.md from skill \"review\"." for a file
    // the skill never had — a cleanup the model then believed and passed on.
    // Unlike `delete_skill`, absence here is not the intent satisfied: the
    // caller named a particular file.
    execute_existing(
        conn,
        "DELETE FROM skill_resources WHERE skill_id=?1 AND path=?2",
        params![skill_id, path],
        &format!("That skill has no file at {path}."),
    )?;
    execute_one(
        conn,
        "UPDATE skills SET updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?1",
        [skill_id],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_are_separate_from_room_files_and_resources_cascade() {
        let conn = crate::db::mem();
        let id = create_skill(
            &conn,
            "review-contract",
            "Review contracts",
            "Do the work.",
            true,
            "user",
            "files.read",
        )
        .unwrap();
        upsert_skill_resource(&conn, &id, "references/policy.md", "reference", b"policy").unwrap();
        assert_eq!(list_skills(&conn, false).unwrap()[0].resource_count, 1);
        let file_count: i64 = conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(file_count, 0);
        delete_skill(&conn, &id).unwrap();
        let resource_count: i64 = conn
            .query_row("SELECT count(*) FROM skill_resources", [], |r| r.get(0))
            .unwrap();
        assert_eq!(resource_count, 0);
    }

    /// Two skills whose names differ only in capitals are indistinguishable to
    /// `find_skill`, which matches `lower(name)` and takes the first row — so
    /// the room can hold "Legal" and "legal" and the wrong one quietly runs.
    #[test]
    fn a_skill_name_that_differs_only_in_capitals_is_refused() {
        let conn = crate::db::mem();
        let id = create_skill(&conn, "Legal", "Contracts", "Do the work.", true, "user", "")
            .unwrap();
        let err = create_skill(&conn, "legal", "Other", "Something else.", true, "user", "")
            .expect_err("a case-only duplicate was accepted");
        assert!(err.contains("already exists"), "{err}");
        // A rename is still allowed to change only the capitalization…
        update_skill(&conn, &id, "LEGAL", "Contracts", "Do the work.", "").unwrap();
        assert_eq!(find_skill(&conn, "legal").unwrap().unwrap().name, "LEGAL");
        // …but must not collide with a DIFFERENT skill.
        let other =
            create_skill(&conn, "Tax", "Tax", "Do the work.", true, "user", "").unwrap();
        assert!(update_skill(&conn, &other, "legal", "Tax", "Do the work.", "").is_err());
    }

    /// AUDIT 175. `UPDATE … WHERE id=?` against a row that is no longer there
    /// changes nothing and reports success, so a skill deleted while its editor
    /// was open answered "Saved" and kept none of what was typed. Turning one on
    /// behaved the same way, and both told the assistant its write had landed.
    #[test]
    fn writing_to_a_deleted_skill_fails_instead_of_claiming_success() {
        let conn = crate::db::mem();
        let id = create_skill(&conn, "gone", "d", "Do the work.", true, "user", "").unwrap();
        delete_skill(&conn, &id).unwrap();

        let err = update_skill(&conn, &id, "gone", "d", "Edited text.", "")
            .expect_err("saving a deleted skill reported success");
        assert!(err.contains("no longer exists"), "{err}");
        let err = set_skill_enabled(&conn, &id, false)
            .expect_err("disabling a deleted skill reported success");
        assert!(err.contains("no longer exists"), "{err}");

        // A live skill is untouched by the guard.
        let live = create_skill(&conn, "here", "d", "Do the work.", false, "user", "").unwrap();
        update_skill(&conn, &live, "here", "d", "Edited text.", "").unwrap();
        set_skill_enabled(&conn, &live, true).unwrap();
        assert!(get_skill(&conn, &live).unwrap().enabled);
    }

    /// The same defect one level down: a resource DELETE that matched no row
    /// reported success, and the tool above it told the model it had removed a
    /// file the skill never had.
    #[test]
    fn deleting_a_resource_that_was_never_there_is_refused_not_reported_as_done() {
        let conn = crate::db::mem();
        let id = create_skill(&conn, "review", "d", "Do the work.", true, "user", "").unwrap();
        upsert_skill_resource(&conn, &id, "references/policy.md", "reference", b"policy").unwrap();

        let err = delete_skill_resource(&conn, &id, "references/old-policy.md")
            .expect_err("deleting a path the skill never had reported success");
        assert!(err.contains("no file at references/old-policy.md"), "{err}");
        // The file that IS there still goes, and only once.
        delete_skill_resource(&conn, &id, "references/policy.md").unwrap();
        assert!(delete_skill_resource(&conn, &id, "references/policy.md").is_err());
        assert!(list_skill_resources(&conn, &id).unwrap().is_empty());
    }

    /// A skill whose SKILL.md names a file nobody bundled: the model was handed
    /// SQLite's "Query returned no rows" as the whole answer.
    #[test]
    fn a_missing_resource_is_explained_in_words_and_lists_what_is_there() {
        let conn = crate::db::mem();
        let id = create_skill(&conn, "review", "d", "Do the work.", true, "user", "").unwrap();
        upsert_skill_resource(&conn, &id, "references/policy.md", "reference", b"policy").unwrap();

        let err = get_skill_resource(&conn, &id, "references/risk-policy.md")
            .expect_err("a missing resource read as a row");
        assert!(!err.contains("Query returned no rows"), "{err}");
        assert!(err.contains("\"review\" has no file at references/risk-policy.md"), "{err}");
        assert!(err.contains("references/policy.md"), "what it does carry is missing: {err}");

        // A skill that bundles nothing says that rather than listing an empty set.
        let bare = create_skill(&conn, "bare", "d", "Do the work.", true, "user", "").unwrap();
        let err = get_skill_resource(&conn, &bare, "notes.md").unwrap_err();
        assert!(err.contains("no files travel with it"), "{err}");

        // And a resource that IS there is still returned.
        assert_eq!(
            get_skill_resource(&conn, &id, "references/policy.md").unwrap().content,
            b"policy"
        );
    }
}
