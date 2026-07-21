//! Encrypted persistence for Agent Skills. A skill is intentionally not a room
//! `file`: `skills` represents SKILL.md and `skill_resources` represents the
//! relative folder tree that travels with it.

use super::{execute_one, query_one, query_opt, query_rows};
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
    s.created_at, s.updated_at";

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
        "SELECT id, name, description, instructions, enabled, created_by, created_at, updated_at \
         FROM skills WHERE id = ?1",
        [id],
        skill_row,
    )
}

pub fn find_skill(conn: &Connection, name_or_id: &str) -> Result<Option<Skill>, String> {
    query_opt(
        conn,
        "SELECT id, name, description, instructions, enabled, created_by, created_at, updated_at \
         FROM skills WHERE id = ?1 OR lower(name) = lower(?1) LIMIT 1",
        [name_or_id],
        skill_row,
    )
}

pub fn create_skill(
    conn: &Connection,
    name: &str,
    description: &str,
    instructions: &str,
    enabled: bool,
    created_by: &str,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO skills(id, name, description, instructions, enabled, created_by) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            name,
            description,
            instructions,
            enabled as i64,
            created_by
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
) -> Result<(), String> {
    conn.execute(
        "UPDATE skills SET name=?2, description=?3, instructions=?4, \
         updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?1",
        params![id, name, description, instructions],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("A skill named \"{name}\" already exists.")
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

pub fn set_skill_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE skills SET enabled=?2, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?1",
        params![id, enabled as i64],
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
    query_one(
        conn,
        "SELECT id, skill_id, path, kind, content, created_at, updated_at \
         FROM skill_resources WHERE skill_id=?1 AND path=?2",
        params![skill_id, path],
        resource_row,
    )
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
    execute_one(
        conn,
        "DELETE FROM skill_resources WHERE skill_id=?1 AND path=?2",
        params![skill_id, path],
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
}
