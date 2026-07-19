//! Wave 4a (Idea 2): persistence for LLM graph workflows, their run history, and
//! their schedules. Pure DB plumbing — the definition format, compiler, executor
//! and scheduler live in `commands::jobs::workflow` / `::scheduler`.
//!
//! `definition` and `binding` are stored as JSON text but surface to the runner
//! and the frontend as `serde_json::Value`, so the caller never re-parses.

use super::{execute_one, query_one, query_rows};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One saved workflow. `definition` is the immutable WorkflowDef JSON; `binding`
/// scopes where it surfaces (general vs file-kind — shortcuts extension).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub definition: serde_json::Value,
    pub status: String,
    pub created_by: String,
    pub binding: serde_json::Value,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// One execution of a workflow — its trigger, the job it drove, and how it ended.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub job_id: Option<String>,
    pub trigger: String,
    pub status: String,
    pub error: Option<String>,
    pub input_file_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// A workflow's schedule. `kind` = interval|daily|weekly; `param` encodes the
/// preset (minutes, "HH:MM", or "DOW HH:MM"). Only ACTIVE workflows with an
/// ENABLED schedule are ever fired by the tick loop.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub workflow_id: String,
    pub kind: String,
    pub param: String,
    pub enabled: bool,
    pub catch_up: bool,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_job_id: Option<String>,
}

const WF_COLS: &str = "id, name, description, emoji, definition, status, created_by, \
     binding, pinned, created_at, updated_at";

fn row_to_workflow(r: &rusqlite::Row) -> rusqlite::Result<Workflow> {
    let definition: String = r.get(4)?;
    let binding: String = r.get(7)?;
    Ok(Workflow {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        emoji: r.get(3)?,
        definition: serde_json::from_str(&definition).unwrap_or(serde_json::Value::Null),
        status: r.get(5)?,
        created_by: r.get(6)?,
        binding: serde_json::from_str(&binding)
            .unwrap_or_else(|_| serde_json::json!({"scope": "general"})),
        pinned: r.get::<_, i64>(8)? != 0,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

/// Insert a new workflow (always as a draft — activation is an explicit user
/// act). Returns the new id.
#[allow(clippy::too_many_arguments)]
pub fn create_workflow(
    conn: &Connection,
    name: &str,
    description: &str,
    emoji: &str,
    definition: &serde_json::Value,
    created_by: &str,
    binding: &serde_json::Value,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    execute_one(
        conn,
        "INSERT INTO workflows(id, name, description, emoji, definition, status, created_by, binding) \
         VALUES(?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7)",
        params![
            id,
            name,
            description,
            emoji,
            definition.to_string(),
            created_by,
            binding.to_string()
        ],
    )?;
    Ok(id)
}

/// Overwrite a workflow's editable fields and bump `updated_at`. The caller
/// decides the status transition (an edit to an active workflow drops it to
/// draft — the review gate).
pub fn update_workflow(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    emoji: &str,
    definition: &serde_json::Value,
    binding: &serde_json::Value,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE workflows SET name = ?2, description = ?3, emoji = ?4, definition = ?5, \
         binding = ?6, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
        params![
            id,
            name,
            description,
            emoji,
            definition.to_string(),
            binding.to_string()
        ],
    )
}

pub fn set_workflow_status(conn: &Connection, id: &str, status: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE workflows SET status = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') \
         WHERE id = ?1",
        params![id, status],
    )
}

pub fn set_workflow_pinned(conn: &Connection, id: &str, pinned: bool) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE workflows SET pinned = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') \
         WHERE id = ?1",
        params![id, pinned as i64],
    )
}

pub fn get_workflow(conn: &Connection, id: &str) -> Result<Workflow, String> {
    query_one(
        conn,
        &format!("SELECT {WF_COLS} FROM workflows WHERE id = ?1"),
        [id],
        row_to_workflow,
    )
}

/// Resolve a name-or-id to a workflow (exact id first, then exact name, then a
/// case-insensitive name fragment — the agent passes names, the UI passes ids).
pub fn find_workflow(conn: &Connection, name_or_id: &str) -> Result<Workflow, String> {
    if let Ok(w) = get_workflow(conn, name_or_id) {
        return Ok(w);
    }
    let like = format!("%{}%", name_or_id.to_lowercase());
    query_one(
        conn,
        &format!(
            "SELECT {WF_COLS} FROM workflows \
             WHERE lower(name) = lower(?1) OR lower(name) LIKE ?2 \
             ORDER BY (lower(name) = lower(?1)) DESC, updated_at DESC LIMIT 1"
        ),
        params![name_or_id, like],
        row_to_workflow,
    )
    .map_err(|_| format!("No workflow named \"{name_or_id}\" was found."))
}

pub fn list_workflows(conn: &Connection) -> Result<Vec<Workflow>, String> {
    query_rows(
        conn,
        &format!("SELECT {WF_COLS} FROM workflows ORDER BY updated_at DESC"),
        [],
        row_to_workflow,
    )
}

pub fn delete_workflow(conn: &Connection, id: &str) -> Result<(), String> {
    // schedules + workflow_runs cascade via their FK (foreign_keys=ON).
    execute_one(conn, "DELETE FROM workflows WHERE id = ?1", [id])
}

// ------------------------------------------------------------------ runs

const RUN_COLS: &str = "id, workflow_id, job_id, trigger, status, error, input_file_id, \
     started_at, finished_at";

fn row_to_run(r: &rusqlite::Row) -> rusqlite::Result<WorkflowRun> {
    Ok(WorkflowRun {
        id: r.get(0)?,
        workflow_id: r.get(1)?,
        job_id: r.get(2)?,
        trigger: r.get(3)?,
        status: r.get(4)?,
        error: r.get(5)?,
        input_file_id: r.get(6)?,
        started_at: r.get(7)?,
        finished_at: r.get(8)?,
    })
}

/// Open a run row when a workflow starts. Returns the run id.
pub fn create_workflow_run(
    conn: &Connection,
    workflow_id: &str,
    job_id: &str,
    trigger: &str,
    input_file_id: Option<&str>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    execute_one(
        conn,
        "INSERT INTO workflow_runs(id, workflow_id, job_id, trigger, status, input_file_id) \
         VALUES(?1, ?2, ?3, ?4, 'running', ?5)",
        params![id, workflow_id, job_id, trigger, input_file_id],
    )?;
    Ok(id)
}

/// Close a run by its driving job id — the terminal epilogue knows the job id,
/// not the run id.
pub fn finish_workflow_run_by_job(
    conn: &Connection,
    job_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE workflow_runs SET status = ?2, error = ?3, \
         finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') \
         WHERE job_id = ?1 AND finished_at IS NULL",
        params![job_id, status, error],
    )
}

pub fn list_workflow_runs(conn: &Connection, workflow_id: &str) -> Result<Vec<WorkflowRun>, String> {
    query_rows(
        conn,
        &format!(
            "SELECT {RUN_COLS} FROM workflow_runs WHERE workflow_id = ?1 \
             ORDER BY started_at DESC LIMIT 50"
        ),
        [workflow_id],
        row_to_run,
    )
}

// ------------------------------------------------------------------ schedules

const SCHED_COLS: &str = "id, workflow_id, kind, param, enabled, catch_up, next_run_at, \
     last_run_at, last_job_id";

fn row_to_schedule(r: &rusqlite::Row) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        id: r.get(0)?,
        workflow_id: r.get(1)?,
        kind: r.get(2)?,
        param: r.get(3)?,
        enabled: r.get::<_, i64>(4)? != 0,
        catch_up: r.get::<_, i64>(5)? != 0,
        next_run_at: r.get(6)?,
        last_run_at: r.get(7)?,
        last_job_id: r.get(8)?,
    })
}

/// One schedule per workflow — insert or replace it. Passing `kind == ""` clears
/// the schedule (delete). `next_run_at` is computed by the caller.
#[allow(clippy::too_many_arguments)]
pub fn upsert_schedule(
    conn: &Connection,
    workflow_id: &str,
    kind: &str,
    param: &str,
    enabled: bool,
    catch_up: bool,
    next_run_at: Option<&str>,
) -> Result<(), String> {
    if kind.is_empty() {
        return execute_one(
            conn,
            "DELETE FROM schedules WHERE workflow_id = ?1",
            [workflow_id],
        );
    }
    // Preserve the existing row id (and last_run_at) if there is one.
    let existing: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT id, last_run_at FROM schedules WHERE workflow_id = ?1",
            [workflow_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    match existing {
        Some((id, _)) => execute_one(
            conn,
            "UPDATE schedules SET kind = ?2, param = ?3, enabled = ?4, catch_up = ?5, \
             next_run_at = ?6 WHERE id = ?1",
            params![id, kind, param, enabled as i64, catch_up as i64, next_run_at],
        ),
        None => {
            let id = Uuid::new_v4().to_string();
            execute_one(
                conn,
                "INSERT INTO schedules(id, workflow_id, kind, param, enabled, catch_up, next_run_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, workflow_id, kind, param, enabled as i64, catch_up as i64, next_run_at],
            )
        }
    }
}

pub fn get_schedule(conn: &Connection, workflow_id: &str) -> Result<Option<Schedule>, String> {
    super::query_opt(
        conn,
        &format!("SELECT {SCHED_COLS} FROM schedules WHERE workflow_id = ?1"),
        [workflow_id],
        row_to_schedule,
    )
}

pub fn list_schedules(conn: &Connection) -> Result<Vec<Schedule>, String> {
    query_rows(
        conn,
        &format!("SELECT {SCHED_COLS} FROM schedules"),
        [],
        row_to_schedule,
    )
}

/// The scheduler's read: every ENABLED schedule of an ACTIVE workflow whose
/// `next_run_at` is due (NULL never fires — it means "compute a next run first").
/// Returns (schedule, workflow) pairs so the tick can compile without a second
/// query. `now` is an ISO8601 string; string comparison is valid because
/// timestamps are stored zero-padded.
pub fn due_schedules(conn: &Connection, now: &str) -> Result<Vec<(Schedule, Workflow)>, String> {
    let sched_cols = SCHED_COLS
        .split(", ")
        .map(|c| format!("s.{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    let rows = query_rows(
        conn,
        &format!(
            "SELECT {sched_cols}, {} FROM schedules s \
             JOIN workflows w ON w.id = s.workflow_id \
             WHERE s.enabled = 1 AND w.status = 'active' \
               AND s.next_run_at IS NOT NULL AND s.next_run_at <= ?1",
            WF_COLS.split(", ").map(|c| format!("w.{c}")).collect::<Vec<_>>().join(", ")
        ),
        [now],
        |r| {
            let sched = row_to_schedule(r)?;
            // Workflow columns begin at index 9 (after the 9 schedule columns).
            let definition: String = r.get(13)?;
            let binding: String = r.get(16)?;
            let wf = Workflow {
                id: r.get(9)?,
                name: r.get(10)?,
                description: r.get(11)?,
                emoji: r.get(12)?,
                definition: serde_json::from_str(&definition).unwrap_or(serde_json::Value::Null),
                status: r.get(14)?,
                created_by: r.get(15)?,
                binding: serde_json::from_str(&binding)
                    .unwrap_or_else(|_| serde_json::json!({"scope": "general"})),
                pinned: r.get::<_, i64>(17)? != 0,
                created_at: r.get(18)?,
                updated_at: r.get(19)?,
            };
            Ok((sched, wf))
        },
    )?;
    Ok(rows)
}

/// Advance a schedule's `next_run_at` WITHOUT recording a run (the catch-up
/// skip path: a missed run whose workflow opted out of catch-up).
pub fn set_schedule_next_run(
    conn: &Connection,
    schedule_id: &str,
    next_run_at: Option<&str>,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE schedules SET next_run_at = ?2 WHERE id = ?1",
        params![schedule_id, next_run_at],
    )
}

/// After firing (or catching up), record the run and advance `next_run_at`.
pub fn mark_schedule_run(
    conn: &Connection,
    schedule_id: &str,
    job_id: &str,
    next_run_at: Option<&str>,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE schedules SET last_run_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), \
         last_job_id = ?2, next_run_at = ?3 WHERE id = ?1",
        params![schedule_id, job_id, next_run_at],
    )
}

#[cfg(test)]
mod tests {
    use super::super::mem;
    use super::*;

    fn def() -> serde_json::Value {
        serde_json::json!({"version": 1, "nodes": [], "edges": []})
    }

    #[test]
    fn workflow_crud_roundtrip_and_cascade() {
        let conn = mem();
        let id = create_workflow(
            &conn,
            "Morning digest",
            "a daily digest",
            "🌅",
            &def(),
            "user",
            &serde_json::json!({"scope": "general"}),
        )
        .unwrap();
        let w = get_workflow(&conn, &id).unwrap();
        assert_eq!(w.name, "Morning digest");
        assert_eq!(w.status, "draft");
        assert_eq!(w.created_by, "user");
        assert!(!w.pinned);
        assert_eq!(w.binding["scope"], "general");

        set_workflow_status(&conn, &id, "active").unwrap();
        set_workflow_pinned(&conn, &id, true).unwrap();
        let w = get_workflow(&conn, &id).unwrap();
        assert_eq!(w.status, "active");
        assert!(w.pinned);

        // find_workflow resolves by id, exact name and fragment.
        assert_eq!(find_workflow(&conn, &id).unwrap().id, id);
        assert_eq!(find_workflow(&conn, "Morning digest").unwrap().id, id);
        assert_eq!(find_workflow(&conn, "morning").unwrap().id, id);
        assert!(find_workflow(&conn, "nope").is_err());

        // A run + schedule cascade-delete with the workflow.
        let run = create_workflow_run(&conn, &id, "job1", "manual", Some("file1")).unwrap();
        upsert_schedule(&conn, &id, "daily", "08:00", true, true, Some("2026-07-19T08:00:00Z"))
            .unwrap();
        assert_eq!(list_workflow_runs(&conn, &id).unwrap().len(), 1);
        assert!(get_schedule(&conn, &id).unwrap().is_some());

        finish_workflow_run_by_job(&conn, "job1", "done", None).unwrap();
        let runs = list_workflow_runs(&conn, &id).unwrap();
        assert_eq!(runs[0].id, run);
        assert_eq!(runs[0].status, "done");
        assert!(runs[0].finished_at.is_some());
        assert_eq!(runs[0].input_file_id.as_deref(), Some("file1"));

        delete_workflow(&conn, &id).unwrap();
        assert!(get_workflow(&conn, &id).is_err());
        assert!(list_workflow_runs(&conn, &id).unwrap().is_empty());
        assert!(get_schedule(&conn, &id).unwrap().is_none());
    }

    #[test]
    fn schedule_upsert_replaces_and_due_reads_only_active_enabled() {
        let conn = mem();
        let id = create_workflow(&conn, "wf", "", "", &def(), "user",
            &serde_json::json!({"scope": "general"})).unwrap();

        // A draft workflow's due schedule is NOT returned.
        upsert_schedule(&conn, &id, "interval", "30", true, false, Some("2000-01-01T00:00:00Z"))
            .unwrap();
        assert!(due_schedules(&conn, "2030-01-01T00:00:00Z").unwrap().is_empty());

        // Activate it → now due.
        set_workflow_status(&conn, &id, "active").unwrap();
        let due = due_schedules(&conn, "2030-01-01T00:00:00Z").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0.kind, "interval");
        assert_eq!(due[0].1.id, id);

        // upsert REPLACES (one schedule per workflow), and disabling hides it.
        upsert_schedule(&conn, &id, "daily", "09:00", false, true, Some("2000-01-01T00:00:00Z"))
            .unwrap();
        assert_eq!(list_schedules(&conn).unwrap().len(), 1);
        assert!(due_schedules(&conn, "2030-01-01T00:00:00Z").unwrap().is_empty());

        // A future next_run_at is not yet due.
        upsert_schedule(&conn, &id, "daily", "09:00", true, true, Some("2999-01-01T00:00:00Z"))
            .unwrap();
        assert!(due_schedules(&conn, "2030-01-01T00:00:00Z").unwrap().is_empty());

        // mark_schedule_run advances next_run_at and records the job.
        mark_schedule_run(&conn, &get_schedule(&conn, &id).unwrap().unwrap().id, "jobX",
            Some("3000-01-01T00:00:00Z")).unwrap();
        let s = get_schedule(&conn, &id).unwrap().unwrap();
        assert_eq!(s.last_job_id.as_deref(), Some("jobX"));
        assert_eq!(s.next_run_at.as_deref(), Some("3000-01-01T00:00:00Z"));

        // Clearing (kind = "") deletes.
        upsert_schedule(&conn, &id, "", "", true, true, None).unwrap();
        assert!(get_schedule(&conn, &id).unwrap().is_none());
    }

    #[test]
    fn migration_adds_workflow_tables_and_columns_to_a_pre_wave_room() {
        // Start from the full current schema, then strip exactly the Wave 4a
        // artifacts (the three tables + jobs.parent_job_id) to simulate a room
        // that predates this wave — migrate() must recreate them all.
        use super::super::{column_exists, table_exists};
        let conn = mem();
        conn.execute_batch(
            "DROP TABLE workflows; DROP TABLE workflow_runs; DROP TABLE schedules;
             DROP TABLE jobs;
             CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               plan TEXT NOT NULL, state TEXT NOT NULL DEFAULT '{}', cursor INTEGER NOT NULL DEFAULT 0,
               total INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued', error TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));",
        )
        .unwrap();
        assert!(!table_exists(&conn, "workflows").unwrap());
        assert!(!column_exists(&conn, "jobs", "parent_job_id").unwrap());

        super::super::migrate(&conn).unwrap();

        assert!(table_exists(&conn, "workflows").unwrap());
        assert!(table_exists(&conn, "workflow_runs").unwrap());
        assert!(table_exists(&conn, "schedules").unwrap());
        assert!(column_exists(&conn, "jobs", "parent_job_id").unwrap());
        assert!(column_exists(&conn, "workflows", "binding").unwrap());
        assert!(column_exists(&conn, "workflows", "pinned").unwrap());
        assert!(column_exists(&conn, "workflow_runs", "input_file_id").unwrap());
        // A workflow round-trips on the migrated room.
        let id = create_workflow(&conn, "wf", "", "", &def(), "user",
            &serde_json::json!({"scope": "general"})).unwrap();
        assert_eq!(get_workflow(&conn, &id).unwrap().name, "wf");
        // Idempotent second migrate().
        super::super::migrate(&conn).unwrap();
    }
}
