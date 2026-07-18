//! ADD-30: persistence for durable background jobs. A job is a step DAG
//! (`plan`) plus accumulating `state`; the runner checkpoints after every step
//! so a job resumes from `cursor` across app restarts. Pure DB plumbing — the
//! scheduler and step semantics live in `commands::jobs`.

use super::{execute_one, query_one, query_rows};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A job row as the UI and runner see it. `plan` and `state` are opaque JSON
/// here; the runner owns their shape.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub plan: serde_json::Value,
    pub state: serde_json::Value,
    pub cursor: i64,
    pub total: i64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_job(r: &rusqlite::Row) -> rusqlite::Result<Job> {
    let plan: String = r.get(3)?;
    let state: String = r.get(4)?;
    Ok(Job {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        plan: serde_json::from_str(&plan).unwrap_or(serde_json::Value::Null),
        state: serde_json::from_str(&state).unwrap_or(serde_json::Value::Null),
        cursor: r.get(5)?,
        total: r.get(6)?,
        status: r.get(7)?,
        error: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

const COLS: &str =
    "id, kind, title, plan, state, cursor, total, status, error, created_at, updated_at";

/// Insert a queued job with its immutable plan. Returns the new id.
pub fn create_job(
    conn: &Connection,
    kind: &str,
    title: &str,
    plan: &serde_json::Value,
    total: i64,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    execute_one(
        conn,
        "INSERT INTO jobs(id, kind, title, plan, total, status) \
         VALUES(?1, ?2, ?3, ?4, ?5, 'queued')",
        params![id, kind, title, plan.to_string(), total],
    )?;
    Ok(id)
}

/// Checkpoint after a step: advance the cursor and overwrite the state blob.
/// One small write, so a crash between steps loses at most the in-flight step.
pub fn checkpoint_job(
    conn: &Connection,
    id: &str,
    cursor: i64,
    state: &serde_json::Value,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE jobs SET cursor = ?2, state = ?3, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
        params![id, cursor, state.to_string()],
    )
}

/// Move a job to a terminal or paused status. `error` is set only for 'error'.
pub fn set_job_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE jobs SET status = ?2, error = ?3, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
        params![id, status, error],
    )
}

pub fn get_job(conn: &Connection, id: &str) -> Result<Job, String> {
    query_one(
        conn,
        &format!("SELECT {COLS} FROM jobs WHERE id = ?1"),
        [id],
        row_to_job,
    )
}

/// All jobs, newest first — for the jobs panel.
pub fn list_jobs(conn: &Connection) -> Result<Vec<Job>, String> {
    query_rows(
        conn,
        &format!("SELECT {COLS} FROM jobs ORDER BY created_at DESC"),
        [],
        row_to_job,
    )
}

/// Jobs that were mid-flight — 'running' or 'queued' or 'paused'. On app start
/// any 'running' row is really stale (the process that ran it is gone), so the
/// caller marks those 'paused' and offers Resume.
pub fn unfinished_jobs(conn: &Connection) -> Result<Vec<Job>, String> {
    query_rows(
        conn,
        &format!(
            "SELECT {COLS} FROM jobs \
             WHERE status IN ('running','queued','paused') ORDER BY created_at ASC"
        ),
        [],
        row_to_job,
    )
}

pub fn delete_job(conn: &Connection, id: &str) -> Result<(), String> {
    execute_one(conn, "DELETE FROM job_artifacts WHERE job_id = ?1", [id])?;
    execute_one(conn, "DELETE FROM jobs WHERE id = ?1", [id])
}

// ---------------------------------------------------------------- artifacts

/// ADD-32: save one step's output. INSERT OR REPLACE so a step re-run after a
/// crash (artifact written, cursor not yet advanced) is idempotent.
pub fn put_job_artifact(
    conn: &Connection,
    job_id: &str,
    step_id: usize,
    content: &str,
) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) VALUES(?1, ?2, ?3)",
        params![job_id, step_id as i64, content],
    )
}

pub fn get_job_artifact(conn: &Connection, job_id: &str, step_id: usize) -> Option<String> {
    conn.query_row(
        "SELECT content FROM job_artifacts WHERE job_id = ?1 AND step_id = ?2",
        params![job_id, step_id as i64],
        |r| r.get(0),
    )
    .ok()
}

/// Fetch several steps' artifacts at once, returned in `step_ids` order.
/// Missing steps come back as None so the caller can name exactly what's lost.
pub fn get_job_artifacts(
    conn: &Connection,
    job_id: &str,
    step_ids: &[usize],
) -> Vec<Option<String>> {
    step_ids
        .iter()
        .map(|&s| get_job_artifact(conn, job_id, s))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE jobs (
               id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
               plan TEXT NOT NULL, state TEXT NOT NULL DEFAULT '{}',
               cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
               status TEXT NOT NULL DEFAULT 'queued', error TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );
             CREATE TABLE job_artifacts (
               job_id TEXT NOT NULL,
               step_id INTEGER NOT NULL,
               content TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
               PRIMARY KEY (job_id, step_id)
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn artifacts_roundtrip_and_die_with_the_job() {
        let conn = mem();
        let id = create_job(&conn, "file_pass", "big.pdf", &serde_json::json!({}), 3).unwrap();
        put_job_artifact(&conn, &id, 0, "notes for window 0").unwrap();
        put_job_artifact(&conn, &id, 1, "notes for window 1").unwrap();
        // Re-run after a crash overwrites, never duplicates.
        put_job_artifact(&conn, &id, 1, "notes for window 1 (rerun)").unwrap();
        assert_eq!(
            get_job_artifact(&conn, &id, 1).as_deref(),
            Some("notes for window 1 (rerun)")
        );
        // Batch fetch preserves order and marks the missing step.
        let got = get_job_artifacts(&conn, &id, &[0, 2, 1]);
        assert_eq!(got[0].as_deref(), Some("notes for window 0"));
        assert!(got[1].is_none());
        assert!(got[2].is_some());
        // Deleting the job removes its artifacts.
        delete_job(&conn, &id).unwrap();
        assert!(get_job_artifact(&conn, &id, 0).is_none());
    }

    #[test]
    fn create_checkpoint_resume_roundtrip() {
        let conn = mem();
        let plan = serde_json::json!({"steps": [1, 2, 3]});
        let id = create_job(&conn, "deep_summary", "big.pdf", &plan, 3).unwrap();

        // Fresh job: queued, cursor 0.
        let j = get_job(&conn, &id).unwrap();
        assert_eq!(j.status, "queued");
        assert_eq!(j.cursor, 0);
        assert_eq!(j.total, 3);
        assert_eq!(j.plan, plan);

        // Run two steps, checkpointing state each time.
        set_job_status(&conn, &id, "running", None).unwrap();
        checkpoint_job(&conn, &id, 1, &serde_json::json!({"points": ["a"]})).unwrap();
        checkpoint_job(&conn, &id, 2, &serde_json::json!({"points": ["a", "b"]})).unwrap();

        // Simulate a crash: the row is still 'running'. unfinished_jobs sees it.
        let unfinished = unfinished_jobs(&conn).unwrap();
        assert_eq!(unfinished.len(), 1);
        let j = &unfinished[0];
        assert_eq!(j.cursor, 2); // resume from step 2
        assert_eq!(j.state["points"], serde_json::json!(["a", "b"]));

        // Finish it.
        checkpoint_job(&conn, &id, 3, &j.state).unwrap();
        set_job_status(&conn, &id, "done", None).unwrap();
        assert!(unfinished_jobs(&conn).unwrap().is_empty());
        assert_eq!(get_job(&conn, &id).unwrap().status, "done");
    }

    #[test]
    fn auto_flags_roundtrip_through_the_plan_json() {
        // Wave 1b (idea 8): resume_job re-reads `auto`/`reduce` from the stored
        // plan — they must survive create_job/get_job byte-exactly.
        let conn = mem();
        let plan = serde_json::json!({ "steps": [], "auto": true, "reduce": false });
        let id = create_job(&conn, "deep_summary", "Indexing new files", &plan, 7).unwrap();
        let j = get_job(&conn, &id).unwrap();
        assert_eq!(j.title, "Indexing new files");
        assert_eq!(j.plan.get("auto").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(j.plan.get("reduce").and_then(|v| v.as_bool()), Some(false));
        // A manual job's plan simply lacks the flags — read as false/absent.
        let manual = create_job(&conn, "deep_summary", "Room summary",
                                &serde_json::json!({ "steps": [] }), 3).unwrap();
        let m = get_job(&conn, &manual).unwrap();
        assert!(m.plan.get("auto").is_none());
    }

    #[test]
    fn error_status_carries_a_message() {
        let conn = mem();
        let id = create_job(&conn, "deep_summary", "x", &serde_json::json!({}), 1).unwrap();
        set_job_status(&conn, &id, "error", Some("OLLAMA_DOWN")).unwrap();
        let j = get_job(&conn, &id).unwrap();
        assert_eq!(j.status, "error");
        assert_eq!(j.error.as_deref(), Some("OLLAMA_DOWN"));
    }
}
