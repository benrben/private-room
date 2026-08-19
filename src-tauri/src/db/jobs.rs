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
    /// Wave 4a: set on a child job a workflow drives INLINE (a file_pass node).
    /// pump/resume/quiesce and the Sidebar skip children — the parent holds the
    /// lane slot and re-drives the child on its own resume.
    pub parent_job_id: Option<String>,
    /// Why this job stopped when nobody chose to stop it — the room was locked,
    /// or the app closed, while it was still running. `None` means the pause was
    /// the user's own (Stop), which is a different sentence in the UI. Cleared
    /// by `set_job_status` on every status that isn't 'paused', so a resumed or
    /// finished job never keeps explaining an interruption it recovered from.
    pub parked_reason: Option<String>,
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
        parent_job_id: r.get(9)?,
        parked_reason: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

const COLS: &str = "id, kind, title, plan, state, cursor, total, status, error, \
     parent_job_id, parked_reason, created_at, updated_at";

/// Insert a queued job with its immutable plan. Returns the new id.
pub fn create_job(
    conn: &Connection,
    kind: &str,
    title: &str,
    plan: &serde_json::Value,
    total: i64,
) -> Result<String, String> {
    create_job_inner(conn, kind, title, plan, total, None)
}

/// Wave 4a: insert a CHILD job (a workflow's inline file_pass) tagged with its
/// parent so pump/resume/quiesce and the Sidebar skip it — the parent workflow
/// job owns its lifecycle.
pub fn create_child_job(
    conn: &Connection,
    kind: &str,
    title: &str,
    plan: &serde_json::Value,
    total: i64,
    parent_job_id: &str,
) -> Result<String, String> {
    create_job_inner(conn, kind, title, plan, total, Some(parent_job_id))
}

fn create_job_inner(
    conn: &Connection,
    kind: &str,
    title: &str,
    plan: &serde_json::Value,
    total: i64,
    parent_job_id: Option<&str>,
) -> Result<String, String> {
    // Enforce the one-parked-entry-per-unit-of-work rule at the single insert
    // funnel: a parked row this new job is about to redo is a stale attempt, not
    // a second thing the user is waiting on. Children are exempt — they are
    // owned by their parent, never listed, and never resumed on their own.
    if parent_job_id.is_none() {
        retire_superseded_parked(conn, kind, title, plan)?;
    }
    let id = Uuid::new_v4().to_string();
    execute_one(
        conn,
        "INSERT INTO jobs(id, kind, title, plan, total, status, parent_job_id) \
         VALUES(?1, ?2, ?3, ?4, ?5, 'queued', ?6)",
        params![id, kind, title, plan.to_string(), total, parent_job_id],
    )?;
    Ok(id)
}

// ------------------------------------------------------- duplicate Activity rows

/// The identity two job rows share when they are the SAME unit of work, so a
/// second parked copy is a pile-up rather than a second thing to resume.
///
/// Derived from the paths that could mint one. A workflow's in-flight guard
/// only counts `running`/`queued` rows, so every trigger that met a parked
/// attempt added another row for the same workflow — and its plan is NOT
/// identical (`trigger` and `prev_run_at` move between runs), so only the
/// workflow id identifies them. Everything else (file passes, studio jobs,
/// downloads) is identified by kind + title + the immutable plan: the plan is
/// the whole definition of what a resume would do, so two rows carrying the same
/// one cannot be told apart by running them.
///
/// The plan is compared as re-serialized JSON, never as raw stored text, so
/// formatting differences between writers can't read as "distinct work".
fn work_identity(kind: &str, title: &str, plan: &serde_json::Value) -> String {
    if kind == "workflow" {
        if let Some(wf) = plan.get("workflow_id").and_then(|v| v.as_str()) {
            if !wf.is_empty() {
                return format!("workflow\u{1f}{wf}");
            }
        }
    }
    // The auto-index job is the second pile-up source, and plan equality would
    // miss it exactly the way it misses workflows: the plan carries the
    // missing-file set that run snapshotted, so no two are ever identical. They
    // are still ONE unit of work ("describe whatever still has no
    // description"), and the scheduler already says so — `auto_index`'s
    // StartJob branch deletes every unfinished auto job before starting a fresh
    // one because the newer missing-set plan strictly supersedes it. That branch
    // reads `unfinished_jobs`, which is running/queued/paused only, so an auto
    // job that ended in ERROR is invisible to it and stacks another
    // "Indexing new files" card on every failure. A manual "Room summary"
    // (`auto: false`) is deliberately NOT folded in here — it is a thing the
    // user asked for by name, and the composer already resumes an existing one
    // instead of starting a second.
    if kind == "deep_summary" && plan.get("auto").and_then(|v| v.as_bool()) == Some(true) {
        return "deep_summary\u{1f}auto".to_string();
    }
    format!("{kind}\u{1f}{title}\u{1f}{plan}")
}

/// Every PARKED top-level job row, oldest first, paired with its identity.
/// Parked = the Activity group with nothing driving it, where the only offer is
/// Resume/Retry; `done` is deliberately outside it — a finished row is the
/// Activity HISTORY section's evidence that the work happened, and collapsing
/// two of those would quietly edit the record. Rows whose plan is
/// unreadable are skipped rather than lumped together — an unparseable plan is
/// not evidence of sameness.
fn parked_identities(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, title, plan FROM jobs \
             WHERE parent_job_id IS NULL AND status IN ('paused','error') \
             ORDER BY created_at ASC, rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, kind, title, plan)| {
            let plan: serde_json::Value = serde_json::from_str(&plan).ok()?;
            Some((id, work_identity(&kind, &title, &plan)))
        })
        .collect())
}

/// Delete a job and the children it owns. A child exists only to serve its
/// parent (the parent re-drives it on resume), so leaving one behind would
/// strand a row nothing lists, resumes or cleans up.
fn delete_job_tree(conn: &Connection, id: &str) -> Result<(), String> {
    let kids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM jobs WHERE parent_job_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for kid in kids {
        delete_job(conn, &kid)?;
    }
    delete_job(conn, id)
}

/// Drop the parked rows a job about to be created would redo. Called from the
/// insert funnel, so the rule that the repair applies to old rooms is the same
/// rule the write path keeps true from here on.
///
/// A UNIQUE index would be the wrong tool: jobs legitimately repeat (a workflow
/// runs every morning, a file gets a second pass), and a partial index over the
/// parked statuses would turn `set_job_status(.., "paused")` into an ERROR the
/// moment a matching parked row existed — losing the checkpoint of a job the
/// user just stopped. The constraint belongs where a NEW row is minted, which is
/// the only moment we know the older one is superseded.
fn retire_superseded_parked(
    conn: &Connection,
    kind: &str,
    title: &str,
    plan: &serde_json::Value,
) -> Result<(), String> {
    let want = work_identity(kind, title, plan);
    for (id, identity) in parked_identities(conn)? {
        if identity == want {
            delete_job_tree(conn, &id)?;
        }
    }
    Ok(())
}

/// One-time repair, run on every room open: collapse Activity rows that already
/// piled up before the write path enforced the rule above.
///
/// Live QA 2026-08-03 found several indistinguishable paused copies of one
/// workflow stacked in Activity. Preventing new ones left the existing pile
/// sitting in the room, so this sweeps it: for each `work_identity` with more
/// than one parked row, the NEWEST survives and the older attempts go.
///
/// Newest — not furthest-along — because that is the same answer the insert
/// funnel gives (a new job supersedes the parked attempt it repeats), and its
/// plan is the one that matches the room as it is now. The cost is real: an
/// older copy's checkpoint is discarded. That is why only PARKED, top-level,
/// same-identity rows are eligible — a running or queued job, a job with a
/// different plan, and a workflow's child are all left exactly as they are.
///
/// Returns how many PARKED ENTRIES were retired — not how many rows the
/// database lost, which is larger whenever a retired parent owned children — so
/// a caller can report the truth rather than assume a clean sweep. Idempotent: a
/// second call over the result finds one row per identity and removes nothing.
pub fn dedupe_parked_jobs(conn: &Connection) -> Result<usize, String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Newest first, so the first row of each identity is the keeper.
    let mut rows = parked_identities(conn)?;
    rows.reverse();
    let mut removed = 0usize;
    for (id, identity) in rows {
        if seen.insert(identity) {
            continue;
        }
        delete_job_tree(conn, &id)?;
        removed += 1;
    }
    Ok(removed)
}

/// How many FINISHED runs of one unit of work the room keeps.
const JOB_HISTORY_KEEP: usize = 50;

/// How many closed `workflow_runs` rows the room keeps per workflow. The same
/// number `list_workflow_runs` already caps its read at, so nothing this sweep
/// removes could still have been DRAWN.
const RUN_HISTORY_KEEP: usize = 50;

/// Roll the finished job history off the back, oldest first. Run on every room
/// open, the way `prune_web_cache` runs on every web-cache write.
///
/// Nothing ever removed a finished job, its artifacts or a closed run row, so a
/// workflow on a 30-minute schedule grew the encrypted room file forever — and
/// `list_jobs` deserialized every one of those rows' plans (for a workflow, the
/// whole definition plus its compiled step list) on every Activity refresh.
///
/// Only 'done', top-level rows are eligible, and only past the newest
/// [`JOB_HISTORY_KEEP`] of their own `work_identity`:
///  * an 'error' or 'paused' row is the Retry/Resume the user has not answered
///    yet, and `dedupe_parked_jobs` already keeps those to one per identity;
///  * a row still named by a surviving `workflow_runs` row is that run's
///    evidence — deleting it would take the run's artifacts out from under a
///    history line that stays on screen.
///
/// Deletion goes through `delete_job_tree`, so a swept parent takes its children
/// and every one of their artifacts with it. Returns how many TOP-LEVEL job rows
/// were removed — not the row count, which is larger wherever a parent owned
/// children.
pub fn prune_job_history(conn: &Connection) -> Result<usize, String> {
    prune_workflow_runs(conn)?;

    let rows: Vec<(String, String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, title, plan FROM jobs \
                 WHERE parent_job_id IS NULL AND status = 'done' \
                   AND id NOT IN (SELECT job_id FROM workflow_runs WHERE job_id IS NOT NULL) \
                 ORDER BY created_at DESC, rowid DESC",
            )
            .map_err(|e| e.to_string())?;
        let out = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        out
    };

    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut removed = 0usize;
    for (id, kind, title, plan) in rows {
        // An unreadable plan is not evidence of sameness — same rule as
        // `parked_identities`. Such a row is left alone rather than counted
        // against some other identity's allowance.
        let Ok(plan) = serde_json::from_str::<serde_json::Value>(&plan) else {
            continue;
        };
        let identity = work_identity(&kind, &title, &plan);
        let n = seen.entry(identity).or_insert(0);
        *n += 1;
        if *n > JOB_HISTORY_KEEP {
            delete_job_tree(conn, &id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// The `workflow_runs` half of [`prune_job_history`]: closed runs past the
/// newest [`RUN_HISTORY_KEEP`] of their workflow. An OPEN run (no `finished_at`)
/// is never touched — it is either live or the phantom the callers close.
fn prune_workflow_runs(conn: &Connection) -> Result<(), String> {
    let rows: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, workflow_id FROM workflow_runs WHERE finished_at IS NOT NULL \
                 ORDER BY started_at DESC, rowid DESC",
            )
            .map_err(|e| e.to_string())?;
        let out = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        out
    };
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (id, workflow_id) in rows {
        let n = seen.entry(workflow_id).or_insert(0);
        *n += 1;
        if *n > RUN_HISTORY_KEEP {
            execute_one(conn, "DELETE FROM workflow_runs WHERE id = ?1", [&id])?;
        }
    }
    Ok(())
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

/// Stamp WHY a job paused itself, after `set_job_status` has parked it.
///
/// One caller: a chained clip that may not start because its predecessor's
/// clip does not exist yet. The reason is shown on the job card, and its
/// prefix is the marker `wake_chain_waiter` matches on — a user's own pause
/// carries no such reason and is never resumed behind their back.
pub fn set_parked_reason(conn: &Connection, id: &str, reason: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE jobs SET parked_reason = ?2 WHERE id = ?1 AND status = 'paused'",
        params![id, reason],
    )
    .map(|_| ())
}

/// Move a job to a terminal or paused status. `error` is set only for 'error'.
///
/// Any status but 'paused' also clears `parked_reason`: a job that was stamped
/// "the room was locked while this was running" and then RESUMED (→ 'queued' →
/// 'running'), FINISHED (→ 'done') or hit a real failure (→ 'error') is no
/// longer describable by that interruption, and leaving the sentence behind
/// would make a recovered job keep reporting the crash it survived. 'paused' is
/// the one status that must preserve it — the epilogue of a job cancelled BY the
/// lock lands here, after `mark_jobs_parking` has already stamped why.
pub fn set_job_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let wrote = if status == "paused" {
        execute_one(
            conn,
            "UPDATE jobs SET status = ?2, error = ?3, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
            params![id, status, error],
        )
    } else {
        execute_one(
            conn,
            "UPDATE jobs SET status = ?2, error = ?3, parked_reason = NULL, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
            params![id, status, error],
        )
    };
    // Owner replacement #1: every job transition a RUNNER makes goes through
    // here, so recording it is most of the history of a run — the thing that
    // makes "it just stopped" answerable. `park_job` below is the one other
    // writer of `jobs.status`, and it records its own transition for the same
    // reason; between them the history is complete.
    //
    // `conn.changes()`, not just `wrote.is_ok()`: an UPDATE matching no row is a
    // successful statement that moved nothing, and a log line saying a job went
    // to 'done' when no such job exists is the same lie in miniature that the
    // whole anti-fabrication doctrine is about. (The return value is left as it
    // was — callers' handling of a vanished row is not this packet's business.)
    if wrote.is_ok() && conn.changes() > 0 {
        crate::obs::job_status(id, status, error);
    }
    wrote
}

/// Stamp WHY a job is about to stop, without touching its status.
///
/// Called while the room is still open and the runner is still alive, so
/// whichever way the runner lands afterwards the row can already say what
/// interrupted it: a runner that observes the cancel in time writes 'paused'
/// (which preserves this), one still inside a model call is forced to 'paused'
/// by `park_job`, and one that actually FINISHES writes 'done' (which clears
/// it). Only rows still reading as live are stamped — a job already parked or
/// finished is not being interrupted by anything.
pub fn mark_job_parking(conn: &Connection, id: &str, reason: &str) -> Result<(), String> {
    execute_one(
        conn,
        "UPDATE jobs SET parked_reason = ?2 \
         WHERE id = ?1 AND status IN ('running','queued')",
        params![id, reason],
    )
}

/// Park a job the app itself stopped: 'paused' plus the sentence saying why.
///
/// Deliberately NOT a new status value. Every selector in the app already knows
/// the five statuses ('queued'/'running'/'paused'/'error'/'done'), and a sixth
/// would have to be threaded through `unfinished_jobs`, the queue pump, the
/// dedupe sweep and `retire_parked_jobs` — the exact places where treating a
/// parked run as in-flight once left a workflow stuck for good. A parked job is
/// a PAUSED job that explains itself, so Resume, dedupe and the queue keep
/// working unchanged.
pub fn park_job(conn: &Connection, id: &str, reason: &str) -> Result<(), String> {
    let wrote = execute_one(
        conn,
        "UPDATE jobs SET status = 'paused', parked_reason = ?2, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
        params![id, reason],
    );
    // This is a status transition too, and it is the one that most needs the
    // record: a job the APP stopped (the room was locked, the app is quitting)
    // is precisely the "it just stopped and nothing says why" case. It does not
    // go through `set_job_status` — it writes 'paused' directly, to preserve
    // `parked_reason` — so without this line the whole parking path was the one
    // job transition the host log could not see.
    //
    // `reason` itself does NOT travel: it is a user-facing sentence, so the
    // event says a job was parked and the row keeps the wording.
    if wrote.is_ok() && conn.changes() > 0 {
        crate::obs::job_status(id, "paused", None);
    }
    wrote
}

pub fn get_job(conn: &Connection, id: &str) -> Result<Job, String> {
    query_one(
        conn,
        &format!("SELECT {COLS} FROM jobs WHERE id = ?1"),
        [id],
        row_to_job,
    )
}

/// All jobs, newest first — for the jobs panel. Wave 4a: children (a workflow's
/// inline file_pass) are hidden; their progress shows through the parent
/// workflow's animated pipeline, never a second sidebar card.
pub fn list_jobs(conn: &Connection) -> Result<Vec<Job>, String> {
    query_rows(
        conn,
        &format!("SELECT {COLS} FROM jobs WHERE parent_job_id IS NULL ORDER BY created_at DESC"),
        [],
        row_to_job,
    )
}

/// Jobs that were mid-flight — 'running' or 'queued' or 'paused'. On app start
/// any 'running' row is really stale (the process that ran it is gone), so the
/// caller marks those 'paused' and offers Resume. Wave 4a: children are excluded
/// — they must never be pumped/resumed/quiesced independently of their parent.
///
/// `created_at` has one-second resolution, so a scheduled run colliding with a
/// manual one leaves the FIFO order to whatever the sorter happens to do; the
/// `rowid` tiebreak states it instead, the same way `parked_identities` does.
/// Deliberately untested: SQLite already returns rowid order for a small tied
/// set, so any test of it would pass without the tiebreak too.
pub fn unfinished_jobs(conn: &Connection) -> Result<Vec<Job>, String> {
    query_rows(
        conn,
        &format!(
            "SELECT {COLS} FROM jobs \
             WHERE status IN ('running','queued','paused') AND parent_job_id IS NULL \
             ORDER BY created_at ASC, rowid ASC"
        ),
        [],
        row_to_job,
    )
}

pub fn delete_job(conn: &Connection, id: &str) -> Result<(), String> {
    // A workflow job also drives a `workflow_runs` row, and nothing but the
    // runner's own epilogue ever closed one. Deleting the job left that row
    // open forever: the library card kept its green "Running" badge and Run
    // history printed a live run with no `finished_at` for work whose job no
    // longer exists. Closing it as 'paused' is what the card already reads as
    // "Stopped". A no-op for every other job kind — they have no run row.
    let _ = crate::db::finish_workflow_run_by_job(conn, id, "paused", None);
    execute_one(conn, "DELETE FROM job_artifacts WHERE job_id = ?1", [id])?;
    execute_one(conn, "DELETE FROM jobs WHERE id = ?1", [id])
}

// ---------------------------------------------------------------- artifacts

/// ADD-32: save one step's output. INSERT OR REPLACE so a step re-run after a
/// crash (artifact written, cursor not yet advanced) is idempotent.
///
/// The `WHERE EXISTS` clause is load-bearing: a job deleted mid-run (Delete on a
/// running workflow) keeps going for one more step, and without the guard that
/// step's artifact would be written under a job id that no longer exists —
/// invisible rows nothing ever cleans up. A dropped write is exactly right:
/// there is no longer a job to read it.
pub fn put_job_artifact(
    conn: &Connection,
    job_id: &str,
    step_id: usize,
    content: &str,
) -> Result<(), String> {
    execute_one(
        conn,
        "INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) \
         SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?1)",
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
               status TEXT NOT NULL DEFAULT 'queued', error TEXT, parent_job_id TEXT,
               parked_reason TEXT,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             );
             CREATE TABLE job_artifacts (
               job_id TEXT NOT NULL,
               step_id INTEGER NOT NULL,
               content TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
               PRIMARY KEY (job_id, step_id)
             );
             CREATE TABLE workflow_runs (
               id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, job_id TEXT,
               trigger TEXT NOT NULL DEFAULT 'manual',
               status TEXT NOT NULL DEFAULT 'running', error TEXT, input_file_id TEXT,
               started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
               finished_at TEXT
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn every_job_transition_is_recorded_and_carries_no_content() {
        // Owner replacement #1: `set_job_status` is the one choke point every
        // status change goes through, so the host log's record of it IS the
        // job's history. The title/error a job carries are room content, so the
        // event must be able to name the transition without naming them.
        let conn = mem();
        let id = create_job(&conn, "file_pass", "Full pass — Divorce settlement.docx",
            &serde_json::json!({}), 3).unwrap();
        let (_, log) = crate::obs::capture(|| {
            set_job_status(&conn, &id, "running", None).unwrap();
            set_job_status(&conn, &id, "paused", None).unwrap();
            set_job_status(&conn, &id, "error",
                Some("No such file or directory: /Users/ben/Divorce settlement.docx")).unwrap();
        });
        assert_eq!(log.matches("job.status").count(), 3, "{log:?}");
        assert!(log.contains(&format!("job={id} to=running")), "{log:?}");
        assert!(log.contains(&format!("job={id} to=paused")), "{log:?}");
        assert!(log.contains(&format!("job={id} to=error err=not_found")), "{log:?}");
        assert!(!log.contains("Divorce"), "the job's own words leaked: {log:?}");
        assert!(!log.contains("settlement"), "the job's own words leaked: {log:?}");
    }

    #[test]
    fn a_transition_that_did_not_happen_is_not_logged_as_if_it_had() {
        // Anti-fabrication, applied to our own log. An UPDATE matching no row is
        // a perfectly successful statement (`execute_one` reports Ok, which is
        // long-standing behaviour and not this packet's to change), so "the
        // write succeeded" is NOT evidence that a job moved. The log has to be
        // gated on rows actually changed, or a 'done' would be recorded for a
        // job that does not exist.
        let conn = mem();
        let (res, log) = crate::obs::capture(|| set_job_status(&conn, "no-such-job", "done", None));
        assert!(res.is_ok(), "pre-existing behaviour: a no-op UPDATE is not an error");
        assert!(!log.contains("job.status"), "a phantom transition was logged: {log:?}");
    }

    #[test]
    fn a_job_the_app_parked_is_recorded_like_any_other_transition() {
        // The gap the first pass left: `park_job` writes 'paused' DIRECTLY (it
        // has to, to preserve `parked_reason`), so it never reaches
        // `set_job_status` — and a job the app itself stopped is the single case
        // most likely to be reported as "it just stopped and nothing said why".
        //
        // The parking REASON is a user-facing sentence and must not travel; the
        // transition must.
        let conn = mem();
        let id = create_job(
            &conn,
            "file_pass",
            "Full pass — Divorce settlement.docx",
            &serde_json::json!({}),
            3,
        )
        .unwrap();
        set_job_status(&conn, &id, "running", None).unwrap();
        let (_, log) = crate::obs::capture(|| {
            park_job(&conn, &id, "The room was locked while this was still running.").unwrap()
        });
        assert!(log.contains(&format!("job={id} to=paused")), "{log:?}");
        for word in ["locked", "room", "Divorce", "settlement"] {
            assert!(!log.contains(word), "{word} leaked into {log:?}");
        }

        // …and the same anti-fabrication rule: parking a job that is not there
        // moved nothing, so it must not be recorded as if it had.
        let (_, log) = crate::obs::capture(|| park_job(&conn, "no-such-job", "whatever"));
        assert!(!log.contains("job.status"), "a phantom parking was logged: {log:?}");
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
        // A step that never ran has nothing stored.
        assert!(get_job_artifact(&conn, &id, 2).is_none());
        // Deleting the job removes its artifacts.
        delete_job(&conn, &id).unwrap();
        assert!(get_job_artifact(&conn, &id, 0).is_none());
    }

    #[test]
    fn an_artifact_for_a_deleted_job_is_never_written() {
        // Delete on a RUNNING workflow removes the row while the job keeps
        // going for one more step. Whatever that step stores must not land as
        // an orphan row under a job that no longer exists — nothing would ever
        // read it, list it, or clean it up.
        let conn = mem();
        let id = create_job(&conn, "workflow", "Digest", &serde_json::json!({}), 2).unwrap();
        put_job_artifact(&conn, &id, 0, "step 0").unwrap();
        delete_job(&conn, &id).unwrap();

        // The in-flight step's write is accepted (no error surfaces to the
        // runner) but stores nothing.
        put_job_artifact(&conn, &id, 1, "step 1 finished after the delete").unwrap();
        assert!(get_job_artifact(&conn, &id, 1).is_none());
        let left: i64 = conn
            .query_row("SELECT count(*) FROM job_artifacts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "no leftover rows in the room file");
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
    fn child_jobs_are_hidden_from_lists_and_the_pump() {
        // Wave 4a [MAJOR]: a workflow's inline file_pass child must be invisible
        // to list_jobs (no phantom sidebar card) and to unfinished_jobs (never
        // pumped/quiesced/resumed on its own) — the parent owns its lifecycle.
        let conn = mem();
        let parent = create_job(&conn, "workflow", "Morning digest",
            &serde_json::json!({}), 3).unwrap();
        let child = create_child_job(&conn, "file_pass", "Full pass — book.pdf",
            &serde_json::json!({}), 5, &parent).unwrap();
        set_job_status(&conn, &parent, "running", None).unwrap();
        set_job_status(&conn, &child, "running", None).unwrap();

        let listed = list_jobs(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, parent);

        let unfinished = unfinished_jobs(&conn).unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].id, parent);

        // The child is still fetchable directly (its artifacts back the parent's
        // pipeline node), and carries its parent pointer.
        let c = get_job(&conn, &child).unwrap();
        assert_eq!(c.parent_job_id.as_deref(), Some(parent.as_str()));
    }

    /// Insert a job row directly, bypassing `create_job`'s supersede guard, so a
    /// test can build the pile-up an old room actually holds.
    fn legacy_job(
        conn: &Connection,
        id: &str,
        kind: &str,
        title: &str,
        plan: &serde_json::Value,
        status: &str,
        created_at: &str,
    ) {
        conn.execute(
            "INSERT INTO jobs(id, kind, title, plan, total, status, created_at) \
             VALUES(?1, ?2, ?3, ?4, 3, ?5, ?6)",
            params![id, kind, title, plan.to_string(), status, created_at],
        )
        .unwrap();
    }

    fn ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT id FROM jobs ORDER BY id").unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    }

    #[test]
    fn repair_keeps_one_parked_row_per_unit_of_work() {
        // The reported defect: Activity accumulated indistinguishable rows. Three
        // parked attempts at ONE workflow (their plans differ by `trigger` and
        // `prev_run_at`, so only the workflow id identifies them) collapse to the
        // newest; everything genuinely distinct survives untouched.
        let conn = mem();
        let wf = |trigger: &str, prev: &str| {
            serde_json::json!({ "workflow_id": "wf-1", "trigger": trigger, "prev_run_at": prev })
        };
        legacy_job(&conn, "old", "workflow", "Workflow — Digest",
            &wf("schedule", "t1"), "paused", "2026-08-01T09:00:00Z");
        legacy_job(&conn, "mid", "workflow", "Workflow — Digest",
            &wf("schedule", "t2"), "error", "2026-08-02T09:00:00Z");
        legacy_job(&conn, "new", "workflow", "Workflow — Digest",
            &wf("manual", "t3"), "paused", "2026-08-03T09:00:00Z");
        // A DIFFERENT workflow, same shape of title — never collapsed together.
        legacy_job(&conn, "other-wf", "workflow", "Workflow — Weekly",
            &serde_json::json!({ "workflow_id": "wf-2" }), "paused", "2026-08-01T10:00:00Z");
        // Two full passes over the same file with DIFFERENT instructions: same
        // kind, same title, different plan → two real, distinguishable jobs.
        legacy_job(&conn, "pass-a", "file_pass", "Full pass — book.txt",
            &serde_json::json!({ "instruction": "summarize" }), "paused", "2026-08-01T11:00:00Z");
        legacy_job(&conn, "pass-b", "file_pass", "Full pass — book.txt",
            &serde_json::json!({ "instruction": "translate" }), "paused", "2026-08-01T12:00:00Z");
        // Same plan twice — nothing tells these apart, so the older one goes.
        legacy_job(&conn, "index-old", "deep_summary", "Indexing new files",
            &serde_json::json!({ "auto": true }), "paused", "2026-08-01T13:00:00Z");
        legacy_job(&conn, "index-new", "deep_summary", "Indexing new files",
            &serde_json::json!({ "auto": true }), "error", "2026-08-02T13:00:00Z");
        // Still live, and finished history: both out of scope for the repair.
        legacy_job(&conn, "running", "workflow", "Workflow — Digest",
            &wf("manual", "t4"), "running", "2026-08-03T10:00:00Z");
        legacy_job(&conn, "queued", "workflow", "Workflow — Digest",
            &wf("manual", "t5"), "queued", "2026-08-03T11:00:00Z");
        legacy_job(&conn, "done-1", "workflow", "Workflow — Digest",
            &wf("manual", "t6"), "done", "2026-07-30T09:00:00Z");
        legacy_job(&conn, "done-2", "workflow", "Workflow — Digest",
            &wf("manual", "t7"), "done", "2026-07-31T09:00:00Z");
        // A parked parent's child rides along when the parent is dropped — a
        // child is never listed or resumed on its own, so leaving it would
        // strand a row nothing ever cleans up.
        legacy_job(&conn, "child-of-old", "file_pass", "Full pass — book.txt",
            &serde_json::json!({ "instruction": "translate" }), "paused",
            "2026-08-01T09:30:00Z");
        conn.execute(
            "UPDATE jobs SET parent_job_id = 'old' WHERE id = 'child-of-old'",
            [],
        )
        .unwrap();

        put_job_artifact(&conn, "old", 0, "work from the stale attempt").unwrap();
        put_job_artifact(&conn, "new", 0, "work from the live attempt").unwrap();

        let removed = dedupe_parked_jobs(&conn).unwrap();
        assert_eq!(removed, 3, "old + mid workflow attempts, and index-old");
        assert_eq!(
            ids(&conn),
            vec![
                "done-1", "done-2", "index-new", "new", "other-wf", "pass-a", "pass-b", "queued",
                "running",
            ]
        );
        // The dropped parent took its child and its artifacts with it; the
        // survivor kept everything.
        assert!(get_job_artifact(&conn, "old", 0).is_none());
        assert_eq!(
            get_job_artifact(&conn, "new", 0).as_deref(),
            Some("work from the live attempt")
        );
    }

    #[test]
    fn repair_is_a_no_op_on_a_clean_table() {
        // Safe to run on every room open: a table with nothing duplicated loses
        // nothing, and a second pass over an already-repaired table is silent.
        let conn = mem();
        legacy_job(&conn, "a", "workflow", "Workflow — Digest",
            &serde_json::json!({ "workflow_id": "wf-1" }), "paused", "2026-08-01T09:00:00Z");
        legacy_job(&conn, "b", "deep_summary", "Room summary",
            &serde_json::json!({ "steps": [1, 2] }), "error", "2026-08-01T10:00:00Z");
        legacy_job(&conn, "c", "file_pass", "Full pass — book.txt",
            &serde_json::json!({ "instruction": "summarize" }), "paused", "2026-08-01T11:00:00Z");
        let before = ids(&conn);

        assert_eq!(dedupe_parked_jobs(&conn).unwrap(), 0);
        assert_eq!(ids(&conn), before);
        // Idempotent: repeating the sweep over its own result removes nothing.
        assert_eq!(dedupe_parked_jobs(&conn).unwrap(), 0);
        assert_eq!(ids(&conn), before);
    }

    #[test]
    fn failed_auto_index_attempts_collapse_but_named_summaries_do_not() {
        // The second pile-up source. `auto_index`'s StartJob branch already
        // deletes every UNFINISHED auto job before starting a fresh one — but it
        // reads `unfinished_jobs` (running/queued/paused), so an auto job that
        // ended in ERROR survives it, and each failure leaves another
        // "Indexing new files" card. Their plans can never match (each carries
        // the missing-file set it snapshotted), so plan equality alone misses
        // them entirely.
        let conn = mem();
        let auto = |n: usize| serde_json::json!({ "auto": true, "reduce": false, "steps": vec![0; n] });
        legacy_job(&conn, "auto-1", "deep_summary", "Indexing new files", &auto(3), "error",
            "2026-08-01T09:00:00Z");
        legacy_job(&conn, "auto-2", "deep_summary", "Indexing new files", &auto(5), "error",
            "2026-08-02T09:00:00Z");
        legacy_job(&conn, "auto-3", "deep_summary", "Indexing new files", &auto(1), "paused",
            "2026-08-03T09:00:00Z");
        // A summary the user asked for BY NAME is not the same unit of work, and
        // two of them with different plans stay two rows.
        let named = |n: usize| serde_json::json!({ "auto": false, "reduce": true, "steps": vec![0; n] });
        legacy_job(&conn, "named-a", "deep_summary", "Room summary", &named(2), "paused",
            "2026-08-01T10:00:00Z");
        legacy_job(&conn, "named-b", "deep_summary", "Room summary", &named(4), "error",
            "2026-08-02T10:00:00Z");

        assert_eq!(dedupe_parked_jobs(&conn).unwrap(), 2, "the two stale auto attempts");
        assert_eq!(ids(&conn), vec!["auto-3", "named-a", "named-b"]);
        assert_eq!(dedupe_parked_jobs(&conn).unwrap(), 0, "idempotent");

        // And the write path keeps it true: a fresh auto run retires the parked
        // one it supersedes without touching the named summaries.
        let fresh = create_job(&conn, "deep_summary", "Indexing new files", &auto(7), 7).unwrap();
        let mut want = vec!["named-a".to_string(), "named-b".to_string(), fresh];
        want.sort();
        assert_eq!(ids(&conn), want);
    }

    #[test]
    fn creating_a_job_retires_only_the_parked_attempt_it_repeats() {
        // The rule the repair applies to old rooms is kept true going forward at
        // the insert funnel — without it the pile-up simply starts over.
        let conn = mem();
        let plan = serde_json::json!({ "workflow_id": "wf-1", "trigger": "schedule" });
        legacy_job(&conn, "parked", "workflow", "Workflow — Digest", &plan, "paused",
            "2026-08-01T09:00:00Z");
        legacy_job(&conn, "elsewhere", "workflow", "Workflow — Weekly",
            &serde_json::json!({ "workflow_id": "wf-2" }), "paused", "2026-08-01T10:00:00Z");

        let fresh = create_job(&conn, "workflow", "Workflow — Digest",
            &serde_json::json!({ "workflow_id": "wf-1", "trigger": "manual" }), 2).unwrap();
        let mut expected = vec!["elsewhere".to_string(), fresh.clone()];
        expected.sort();
        assert_eq!(ids(&conn), expected, "only the same workflow's parked row goes");

        // A child never triggers the guard and is never taken by it.
        let child = create_child_job(&conn, "file_pass", "Full pass — book.txt",
            &serde_json::json!({}), 3, &fresh).unwrap();
        set_job_status(&conn, &child, "paused", None).unwrap();
        let sibling = create_job(&conn, "file_pass", "Full pass — book.txt",
            &serde_json::json!({}), 3).unwrap();
        assert!(get_job(&conn, &child).is_ok(), "the parent still owns its child");
        assert!(get_job(&conn, &sibling).is_ok());
    }

    #[test]
    fn the_parking_reason_survives_a_pause_and_nothing_else() {
        // The whole load-bearing rule of the column, in one place. 'paused' is
        // where a parked job LANDS, so it must keep the sentence; every other
        // status contradicts it (running/queued = it recovered, done = it
        // finished anyway, error = a real failure has its own message), so
        // keeping it there would leave a job explaining an interruption it is no
        // longer in.
        let conn = mem();
        let id = create_job(&conn, "file_pass", "book.pdf", &serde_json::json!({}), 3).unwrap();
        let reason = |c: &Connection| get_job(c, &id).unwrap().parked_reason;

        // A fresh job has nothing to explain.
        assert_eq!(reason(&conn), None);

        set_job_status(&conn, &id, "running", None).unwrap();
        mark_job_parking(&conn, &id, "the room was locked").unwrap();
        assert_eq!(reason(&conn).as_deref(), Some("the room was locked"));
        set_job_status(&conn, &id, "paused", None).unwrap();
        assert_eq!(reason(&conn).as_deref(), Some("the room was locked"));

        for status in ["queued", "running", "done", "error"] {
            park_job(&conn, &id, "the room was locked").unwrap();
            assert_eq!(reason(&conn).as_deref(), Some("the room was locked"));
            set_job_status(&conn, &id, status, None).unwrap();
            assert_eq!(reason(&conn), None, "{status} must not keep explaining a park");
        }

        // And a job that is already parked or finished is not being interrupted
        // by anything — the stamp only reaches rows that still read as live.
        set_job_status(&conn, &id, "paused", None).unwrap();
        mark_job_parking(&conn, &id, "the room was locked").unwrap();
        assert_eq!(reason(&conn), None);
        set_job_status(&conn, &id, "done", None).unwrap();
        mark_job_parking(&conn, &id, "the room was locked").unwrap();
        assert_eq!(reason(&conn), None);
    }

    #[test]
    fn park_job_leaves_the_row_resumable_by_every_existing_selector() {
        // A parked job is a PAUSED job that explains itself — deliberately not a
        // sixth status. `unfinished_jobs`, the queue pump and the duplicate sweep
        // all key off the five they already know, and teaching them a new one is
        // how a parked run once got treated as in-flight and left a workflow
        // stuck for good.
        let conn = mem();
        let plan = serde_json::json!({ "workflow_id": "wf-1" });
        let id = create_job(&conn, "workflow", "Workflow — Digest", &plan, 3).unwrap();
        set_job_status(&conn, &id, "running", None).unwrap();
        checkpoint_job(&conn, &id, 1, &serde_json::json!({ "done": [0] })).unwrap();
        park_job(&conn, &id, "the room was locked").unwrap();

        // Still listed, still counted as unfinished, still holding its progress.
        assert_eq!(unfinished_jobs(&conn).unwrap().len(), 1);
        assert_eq!(list_jobs(&conn).unwrap().len(), 1);
        let j = get_job(&conn, &id).unwrap();
        assert_eq!(j.cursor, 1);
        assert_eq!(j.state["done"], serde_json::json!([0]));
        // And it is parked as far as the duplicate sweep is concerned: a fresh
        // run of the same workflow retires it rather than stacking beside it.
        let fresh = create_job(&conn, "workflow", "Workflow — Digest", &plan, 3).unwrap();
        assert_eq!(ids(&conn), vec![fresh]);
    }

    #[test]
    fn deleting_a_workflow_job_closes_its_run_row() {
        // Only the runner's epilogue ever closed a run row, so Remove on a
        // workflow left a run reading 'running' with a NULL finished_at
        // forever — a permanent green badge for work that is gone.
        let conn = mem();
        let plan = serde_json::json!({ "workflow_id": "wf-1" });
        let id = create_job(&conn, "workflow", "Workflow — Digest", &plan, 2).unwrap();
        conn.execute(
            "INSERT INTO workflow_runs(id, workflow_id, job_id, status) VALUES ('r1','wf-1',?1,'running')",
            [&id],
        )
        .unwrap();
        delete_job(&conn, &id).unwrap();
        let (status, finished): (String, Option<String>) = conn
            .query_row("SELECT status, finished_at FROM workflow_runs WHERE id = 'r1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(status, "paused");
        assert!(finished.is_some(), "the run row must be closed, not left open");
    }

    #[test]
    fn finished_history_rolls_off_but_live_and_evidenced_rows_stay() {
        let conn = mem();
        let plan = serde_json::json!({ "file_id": "f1" });
        // One identity, more finished runs than the room keeps.
        let mut done = Vec::new();
        for _ in 0..(JOB_HISTORY_KEEP + 3) {
            let id = create_job(&conn, "file_pass", "big.pdf", &plan, 1).unwrap();
            put_job_artifact(&conn, &id, 0, "notes").unwrap();
            set_job_status(&conn, &id, "done", None).unwrap();
            done.push(id);
        }
        // A stopped row of the same identity — the Retry the user hasn't answered.
        let parked = create_job(&conn, "file_pass", "big.pdf", &plan, 1).unwrap();
        set_job_status(&conn, &parked, "error", Some("OLLAMA_DOWN")).unwrap();
        // A finished workflow job whose run row still names it.
        let wf_plan = serde_json::json!({ "workflow_id": "wf-1" });
        let wf = create_job(&conn, "workflow", "Workflow — Digest", &wf_plan, 1).unwrap();
        set_job_status(&conn, &wf, "done", None).unwrap();
        conn.execute(
            "INSERT INTO workflow_runs(id, workflow_id, job_id, status, finished_at) \
             VALUES ('r1','wf-1',?1,'done','2026-08-18T09:00:00Z')",
            [&wf],
        )
        .unwrap();

        assert_eq!(prune_job_history(&conn).unwrap(), 3);
        let left: std::collections::HashSet<String> =
            list_jobs(&conn).unwrap().into_iter().map(|j| j.id).collect();
        // The three oldest 'done' rows went, with their artifacts.
        for id in &done[..3] {
            assert!(!left.contains(id), "an over-the-limit finished row survived");
            assert!(get_job_artifact(&conn, id, 0).is_none());
        }
        assert!(left.contains(&done[3]));
        assert!(left.contains(&parked), "a stopped row is a pending Retry, not history");
        assert!(left.contains(&wf), "a row a run history still names must stay");
        // Idempotent: a second sweep over the result removes nothing.
        assert_eq!(prune_job_history(&conn).unwrap(), 0);
    }

    #[test]
    fn closed_run_rows_roll_off_per_workflow_and_open_ones_never_do() {
        let conn = mem();
        for i in 0..(RUN_HISTORY_KEEP + 2) {
            conn.execute(
                "INSERT INTO workflow_runs(id, workflow_id, status, started_at, finished_at) \
                 VALUES (?1,'wf-1','done',?2,?2)",
                params![format!("r{i}"), format!("2026-08-{:02}T09:00:00Z", i % 28 + 1)],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO workflow_runs(id, workflow_id, status, started_at) \
             VALUES ('live','wf-1','running','2026-01-01T09:00:00Z')",
            [],
        )
        .unwrap();
        // A second workflow with one run keeps it — the limit is per workflow.
        conn.execute(
            "INSERT INTO workflow_runs(id, workflow_id, status, started_at, finished_at) \
             VALUES ('other','wf-2','done','2026-01-01T09:00:00Z','2026-01-01T09:00:00Z')",
            [],
        )
        .unwrap();
        prune_job_history(&conn).unwrap();
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM workflow_runs WHERE workflow_id = 'wf-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept as usize, RUN_HISTORY_KEEP + 1, "the open run is never swept");
        let live: i64 = conn
            .query_row("SELECT count(*) FROM workflow_runs WHERE id = 'live'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(live, 1);
        let other: i64 = conn
            .query_row("SELECT count(*) FROM workflow_runs WHERE id = 'other'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(other, 1);
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
