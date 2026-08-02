//! ADD-32: the whole-file pass — an exhaustive, durable map/fold/reduce job
//! that guarantees EVERY character of a file passes through the model, no
//! matter how large the file is. The chat agent and the deep summary sample;
//! this covers.
//!
//! Shape (all control flow is deterministic code — the model only fills the
//! fuzzy nodes):
//!   1. `partition_windows` splits the filtered text into N consecutive
//!      windows (plan-time, pure).
//!   2. N chained `map` steps walk the file IN ORDER, each receiving its
//!      window plus a short `thread` carried from the previous step — the
//!      long, monotonic read. Each writes an artifact row.
//!   3. Merge mode: `compose` steps each write ONE ordered HTML section from a
//!      group of `PASS_SECTION_WINDOWS` consecutive windows' notes — no global
//!      fold, so no single call must hold the whole file (a small model
//!      collapsed the old whole-file merge). Stitch mode has no compose — its
//!      deliverable is the ordered concatenation of the map outputs.
//!   4. A `publish` step (no model) writes the result into the room: merge mode
//!      concatenates the section HTML in order; stitch joins the map outputs.
//!      Both carry an honest coverage line.
//!
//! Every step is checkpointed via the ADD-30 job runner, so a pass survives
//! Stop, app quit, and crashes, and resumes from its cursor. The plan (the
//! window list) is IMMUTABLE in the jobs row — artifacts align with step ids,
//! so a resume must never re-derive different windows.

use super::*;

/// One window of file text per map call (~10K tokens). A 44-document,
/// 116-run sweep across window sizes 16K–64K found 32K the sweet spot: it
/// roughly HALVES the window count (so ~40 % less map-phase time) for only ~4 %
/// recall loss, and stays well inside the Job num_ctx. Smaller (16K) is slower
/// for no real quality gain; bigger (48K+) stops helping and starts dropping
/// real detail (64K ≈ −7 % recall). Still small vs num_ctx, so Stop stays
/// responsive and crash recovery cheap.
pub(crate) const PASS_WINDOW_CHARS: usize = 32_000;
/// Carried back from the previous window so nothing straddling a cut is lost.
pub(crate) const PASS_WINDOW_OVERLAP: usize = 400;
/// Windows composed per section (merge mode). Each section is written from just
/// these windows' notes and the sections are concatenated in order — so no single
/// model call ever holds the whole file. A global fold DID (map→merge tree→one
/// compose), and a small local model collapsed the big folds (an 850 KB book's
/// merge came back empty), losing most chapters. Six windows (~2–3 chapters) is
/// well within reach and was the size validated on the real book.
pub(crate) const PASS_SECTION_WINDOWS: usize = 6;
// MIGRATION Phase 3: the per-window/thread/merge/compose byte caps moved with the
// prompts into the sidecar's /file_pass_* endpoints, which apply them before
// returning the artifact — so they no longer live here.

/// The immutable plan stored on the jobs row. `windows` are byte spans into
/// the `smart_filter`ed text; `text_len` and `text_sha256` let a resume detect
/// that the file changed underneath the plan instead of silently mis-slicing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassPlan {
    pub file_id: String,
    pub file_name: String,
    pub instruction: String,
    /// "merge" (notes → composed per-section → concatenated document) or "stitch"
    /// (each window transformed; outputs concatenated in order — translation,
    /// rewriting).
    pub mode: String,
    pub text_len: usize,
    /// SHA-256 (hex) of the filtered text — catches a same-length content
    /// swap that `text_len` misses. Optional so plans persisted before the
    /// digest existed still deserialize (those keep the length check only).
    #[serde(default)]
    pub text_sha256: Option<String>,
    pub windows: Vec<(usize, usize)>,
}

/// Build the full step DAG for a pass — pure and deterministic, so start and
/// resume derive the identical plan from the same inputs. Ids are topological
/// (every dependency has a lower id), which is what makes the job runner's
/// `0..cursor` resume seeding valid.
pub fn build_pass_steps(n_windows: usize, mode: &str, model_lane: Lane) -> Vec<Step> {
    let mut steps: Vec<Step> = (0..n_windows)
        .map(|i| Step {
            id: i,
            lane: model_lane,
            kind: "map".into(),
            params: serde_json::json!({ "window": i }),
            // The chain: window i waits for i-1, receiving its thread — the
            // monotonic read that walks the whole file in order.
            depends_on: if i == 0 { vec![] } else { vec![i - 1] },
        })
        .collect();
    let mut next_id = n_windows;
    if mode == "stitch" {
        // The chain already orders everything; publish rides on the last map.
        steps.push(Step {
            id: next_id,
            lane: Lane::Cpu,
            kind: "publish".into(),
            params: serde_json::json!({ "inputs": (0..n_windows).collect::<Vec<usize>>() }),
            depends_on: vec![n_windows - 1],
        });
        return steps;
    }
    // Sectioned compose: group consecutive windows into sections of
    // PASS_SECTION_WINDOWS, compose EACH section's HTML from just its windows'
    // notes, and let publish concatenate the sections in order. No global fold —
    // every compose sees at most PASS_SECTION_WINDOWS windows, which a small local
    // model can hold, so a big file stays complete instead of collapsing in a
    // whole-file merge.
    let total_sections = n_windows.div_ceil(PASS_SECTION_WINDOWS);
    let mut section_ids: Vec<usize> = Vec::with_capacity(total_sections);
    for sec in 0..total_sections {
        let start = sec * PASS_SECTION_WINDOWS;
        let end = (start + PASS_SECTION_WINDOWS).min(n_windows);
        steps.push(Step {
            id: next_id,
            lane: model_lane,
            kind: "compose".into(),
            params: serde_json::json!({
                "windows": (start..end).collect::<Vec<usize>>(),
                "section": sec,
                "total": total_sections,
            }),
            depends_on: (start..end).collect(),
        });
        section_ids.push(next_id);
        next_id += 1;
    }
    steps.push(Step {
        id: next_id,
        lane: Lane::Cpu,
        kind: "publish".into(),
        params: serde_json::json!({ "sections": section_ids }),
        depends_on: section_ids,
    });
    steps
}

/// The artifact one step leaves for later steps: the window's output plus the
/// thread handed to the next window. `skipped` marks a window the model could
/// not process (after a retry) — publish counts these honestly.
#[derive(Debug, Default, Serialize, Deserialize)]
struct PassArtifact {
    #[serde(default)]
    result: String,
    #[serde(default)]
    thread: String,
    #[serde(default)]
    skipped: bool,
    /// publish only: the deliverable it wrote. Makes the step idempotent — a
    /// crash between the write and the checkpoint replays publish, and without
    /// this the replay left a SECOND identical "Full pass — …" file behind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file_id: Option<String>,
}

fn load_artifact(conn: &Connection, job_id: &str, step_id: usize) -> Option<PassArtifact> {
    db::get_job_artifact(conn, job_id, step_id)
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn store_artifact(
    conn: &Connection,
    job_id: &str,
    step_id: usize,
    artifact: &PassArtifact,
) -> Result<(), String> {
    db::put_job_artifact(
        conn,
        job_id,
        step_id,
        &serde_json::to_string(artifact).map_err(|e| e.to_string())?,
    )
}

/// A hard engine failure parks the job for Resume; anything else is a one-off
/// the pass survives (the window is marked skipped, coverage stays honest).
fn is_fatal(e: &str) -> bool {
    e == "OLLAMA_DOWN" || e.starts_with("MODEL_MISSING")
}

/// Execute one pass step. `filtered` is the smart-filtered file text the plan's
/// windows index into, fetched once per run and shared across steps. Generic
/// over the runtime so the mock-app harness can drive the real thing in tests
/// (the same pattern as `recording::start_engine`). `room_path` pins the step
/// to the room the pass was started in: every room access re-checks the
/// CURRENT room against it and errs on a mismatch, so a room closed or swapped
/// mid-run parks the job instead of receiving another room's artifacts.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_pass_step<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    room_path: &str,
    plan: &PassPlan,
    model: &str,
    filtered: &str,
    step: &Step,
    cancel: &Arc<AtomicBool>,
    published: &std::sync::Mutex<Option<FileMeta>>,
) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let n = plan.windows.len();
    match step.kind.as_str() {
        "map" => {
            let i = step.params["window"].as_u64().unwrap_or(0) as usize;
            let (start, end) = *plan
                .windows
                .get(i)
                .ok_or_else(|| format!("window {i} is not in the plan"))?;
            let window_text = filtered
                .get(start..end)
                .ok_or("the file's text no longer matches this pass — start a new pass")?;
            // The thread from the previous window keeps the read continuous.
            let thread = if i == 0 {
                String::new()
            } else {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                load_artifact(&room.conn, job_id, i - 1)
                    .map(|a| a.thread)
                    .unwrap_or_default()
            };
            // MIGRATION Phase 3: the prompts (merge vs stitch system + the part
            // user message), the result-key/cap choice, the schema, the retrying
            // model call and the clamps all live in the sidecar's /file_pass_map;
            // it returns the full `{result, thread, skipped}` artifact, having
            // absorbed a transient failure into a skipped window itself. Rust keeps
            // the plan, the window slice and the thread it loaded from the prior
            // artifact. Cancellation is Rust-side (the POST is blocking): Stop drops
            // the in-flight request and we return the STOPPED sentinel.
            let body = serde_json::json!({
                "model": model,
                "base_url": ollama::resolved_base_url(),
                "mode": plan.mode,
                "file_name": plan.file_name,
                "instruction": plan.instruction,
                "part": i,
                "total": n,
                "start": start,
                "end": end,
                "text_len": plan.text_len,
                "thread": thread.clone(),
                "window_text": window_text,
                "keep_alive": KEEP_ALIVE_WARM,
            });
            let artifact = match crate::sidecar::sidecar_json_cancellable("/file_pass_map", &body, cancel).await {
                Ok(Some(v)) => serde_json::from_value(v).unwrap_or_default(),
                Ok(None) => return Err("STOPPED".into()),
                Err(e) => {
                    // A FATAL engine failure parks the job for Resume (is_fatal);
                    // any other transient client error degrades this window like
                    // the old double-failure — keep the thread flowing, mark skipped.
                    let s = e.sentinel(Some(model));
                    if is_fatal(&s) {
                        return Err(s);
                    }
                    PassArtifact { result: String::new(), thread, skipped: true, file_id: None }
                }
            };
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room this job belongs to is no longer open.")?;
            store_artifact(&room.conn, job_id, step.id, &artifact)
        }
        "compose" => {
            // Sectioned compose: gather this section-group's window notes (in
            // order, skipping empties) and write ONE ordered HTML section from
            // them. Publish concatenates the sections, so — unlike the old global
            // fold — no single call holds the whole file, which is what keeps a
            // big file complete instead of collapsing in the merge.
            let windows: Vec<usize> = step.params["windows"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as usize).collect())
                .unwrap_or_default();
            let section = step.params["section"].as_u64().unwrap_or(0) as usize;
            let total = step.params["total"].as_u64().unwrap_or(1) as usize;
            let (sections, missing) = {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                let mut sections: Vec<String> = Vec::new();
                let mut missing = 0usize;
                for &w in &windows {
                    match load_artifact(&room.conn, job_id, w) {
                        Some(a) if !a.skipped && !a.result.trim().is_empty() => {
                            sections.push(a.result)
                        }
                        _ => missing += 1,
                    }
                }
                (sections, missing)
            };
            if sections.is_empty() {
                // The whole group was unreadable — a skipped section. Publish
                // marks it in place, and coverage still counts the skipped windows.
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                return store_artifact(
                    &room.conn,
                    job_id,
                    step.id,
                    &PassArtifact { skipped: true, ..Default::default() },
                );
            }
            // The section prompt, schema, retrying call, the clamp AND the
            // empty/double-failure fallback (publish the group's raw notes) live in
            // the sidecar's /file_pass_section. Rust gathers this section's windows'
            // notes + the missing count and stores the returned HTML artifact.
            let body = serde_json::json!({
                "model": model,
                "base_url": ollama::resolved_base_url(),
                "instruction": plan.instruction,
                "file_name": plan.file_name,
                "section": section,
                "total": total,
                "sections": sections,
                "missing": missing,
                "keep_alive": KEEP_ALIVE_WARM,
            });
            let artifact = match crate::sidecar::sidecar_json_cancellable("/file_pass_section", &body, cancel).await {
                Ok(Some(v)) => serde_json::from_value(v).unwrap_or_default(),
                Ok(None) => return Err("STOPPED".into()),
                Err(e) => {
                    let s = e.sentinel(Some(model));
                    if is_fatal(&s) {
                        return Err(s);
                    }
                    // Transient client failure: keep the reading by publishing the
                    // group's raw notes rather than dropping the section.
                    PassArtifact {
                        result: sections.join("\n\n"),
                        thread: String::new(),
                        skipped: false,
                        file_id: None,
                    }
                }
            };
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room this job belongs to is no longer open.")?;
            store_artifact(&room.conn, job_id, step.id, &artifact)
        }
        "publish" => {
            use tauri::Emitter;
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room this job belongs to is no longer open.")?;
            // Honest coverage: count skipped map windows straight from the rows.
            let skipped: usize = (0..n)
                .filter(|&i| load_artifact(&room.conn, job_id, i).is_none_or(|a| a.skipped))
                .count();
            let coverage = if skipped == 0 {
                format!(
                    "Read all {} parts of “{}” — {} characters, complete coverage.",
                    n, plan.file_name, plan.text_len
                )
            } else {
                format!(
                    "Read {} of {} parts of “{}” ({} characters); {} part(s) could not be \
                     processed and are marked in place.",
                    n - skipped,
                    n,
                    plan.file_name,
                    plan.text_len,
                    skipped
                )
            };
            // Idempotent publish: this step re-runs whenever the app died in
            // the split second between writing the deliverable and saving the
            // checkpoint. Reuse the file it already wrote (a versioned
            // overwrite, undoable) instead of minting a second identical one.
            let prior = load_artifact(&room.conn, job_id, step.id).and_then(|a| a.file_id);
            let write_deliverable = |name: &str, mime: &str, content: &str| {
                if let Some(prev) = prior.as_deref() {
                    if db::get_file_meta(&room.conn, prev).is_ok() {
                        store_file_bytes(
                            &room.conn,
                            prev,
                            content.as_bytes(),
                            Some(content),
                            &format!("Full pass re-run — {}", plan.file_name),
                        )?;
                        return db::get_file_meta(&room.conn, prev);
                    }
                }
                db::insert_file(
                    &room.conn,
                    name,
                    mime,
                    content.as_bytes(),
                    Some(content),
                    "generated",
                )
            };
            let meta = if plan.mode == "stitch" {
                let inputs: Vec<usize> = step.params["inputs"]
                    .as_array()
                    .map(|a| {
                        a.iter().filter_map(|v| v.as_u64()).map(|v| v as usize).collect()
                    })
                    .unwrap_or_else(|| (0..n).collect());
                let mut body = String::new();
                for &i in &inputs {
                    match load_artifact(&room.conn, job_id, i) {
                        Some(a) if !a.skipped && !a.result.trim().is_empty() => {
                            body.push_str(a.result.trim());
                            body.push_str("\n\n");
                        }
                        _ => body.push_str(&format!("[part {} could not be processed]\n\n", i + 1)),
                    }
                }
                body.push_str(&format!("---\n\n_{coverage}_\n"));
                let name = format!("Full pass — {}.md", plan.file_name);
                write_deliverable(&name, "text/markdown", &body)?
            } else {
                // Sectioned: concatenate each section's composed HTML in order.
                let section_ids: Vec<usize> = step.params["sections"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as usize).collect())
                    .unwrap_or_default();
                let mut html_body = String::new();
                for &sid in &section_ids {
                    match load_artifact(&room.conn, job_id, sid) {
                        Some(a) if !a.skipped && !a.result.trim().is_empty() => {
                            html_body.push_str(a.result.trim());
                            html_body.push('\n');
                        }
                        _ => html_body
                            .push_str("<p><em>[a section could not be composed]</em></p>\n"),
                    }
                }
                if html_body.trim().is_empty() {
                    return Err("the pass produced no readable sections to publish".into());
                }
                let name = format!("Full pass — {}.html", plan.file_name);
                let body = format!(
                    "{html_body}\n<hr/>\n<p><em>{coverage}</em></p>"
                );
                let content = html_document(&name, &body);
                write_deliverable(&name, "text/html", &content)?
            };
            // Record what was written BEFORE the runner's checkpoint, so a
            // replay from any later crash finds it.
            store_artifact(
                &room.conn,
                job_id,
                step.id,
                &PassArtifact {
                    result: coverage.clone(),
                    file_id: Some(meta.id.clone()),
                    ..Default::default()
                },
            )?;
            if let Some(w) = crate::main_window(app) {
                let _ = w.emit("room-files-changed", ());
            }
            *published.lock().unwrap() = Some(meta);
            Ok(())
        }
        other => Err(format!("unknown pass step kind: {other}")),
    }
}

/// Wave 4a: drive a whole-file pass INLINE as a workflow node's child job.
/// Generic over the runtime so the workflow executor (and its mock e2e harness)
/// can drive it. Creates a CHILD job row (parent-tagged, so pump/resume/quiesce
/// skip it — the parent workflow holds the lane slot and re-drives this node on
/// its own resume), runs the pass on the PARENT's cancel flag, and returns the
/// published file plus an honest coverage line. Returns `Err("STOPPED")` when the
/// parent was cancelled mid-pass, so the workflow parks and resumes cleanly.
pub(crate) async fn drive_file_pass<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    parent_job_id: &str,
    room_path: &str,
    file_id: &str,
    file_name: &str,
    instruction: &str,
    mode: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(String, Option<FileMeta>), String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let mode = if mode == "stitch" { "stitch" } else { "merge" };
    let instruction = {
        let t = instruction.trim();
        if t.is_empty() {
            "Summarize this file completely and thoroughly.".to_string()
        } else {
            t.to_string()
        }
    };
    let filtered = {
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this job belongs to is no longer open.")?;
        let text = db::get_file_extracted_text(&room.conn, file_id)
            .ok_or_else(|| format!("\"{file_name}\" has no readable text for a pass."))?;
        extraction::smart_filter(&text)
    };
    let windows =
        extraction::partition_windows(&filtered, PASS_WINDOW_CHARS, PASS_WINDOW_OVERLAP);
    if windows.is_empty() {
        return Err(format!("\"{file_name}\" has no readable text after filtering."));
    }
    let (chat_model, lane) = resolve_pass_engine(&state).await;
    let steps = build_pass_steps(windows.len(), mode, lane);
    let plan = PassPlan {
        file_id: file_id.to_string(),
        file_name: file_name.to_string(),
        instruction,
        mode: mode.into(),
        text_len: filtered.len(),
        text_sha256: Some(text_digest(&filtered)),
        windows,
    };
    let plan_json = serde_json::to_value(&plan).map_err(|e| e.to_string())?;
    let title = format!("Full pass — {file_name}");
    let child_id = {
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room this job belongs to is no longer open.")?;
        db::create_child_job(&room.conn, "file_pass", &title, &plan_json,
            steps.len() as i64, parent_job_id)?
    };
    {
        let guard = state.room.lock().unwrap();
        if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
            let _ = db::set_job_status(&r.conn, &child_id, "running", None);
        }
    }
    let filtered = Arc::new(filtered);
    let published: std::sync::Mutex<Option<FileMeta>> = std::sync::Mutex::new(None);
    let outcome = run_plan(
        &steps,
        std::collections::HashSet::new(),
        cancel.clone(),
        |s| {
            let app = app.clone();
            let child_id = child_id.clone();
            let room_path = room_path.to_string();
            let plan = plan.clone();
            let model = chat_model.clone();
            let cancel = cancel.clone();
            let filtered = filtered.clone();
            let published = &published;
            async move {
                execute_pass_step(
                    &app, &child_id, &room_path, &plan, &model, &filtered, &s, &cancel,
                    published,
                )
                .await
            }
        },
        |done| {
            let cursor = dense_prefix(done) as i64;
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let _ = db::checkpoint_job(&r.conn, &child_id, cursor, &serde_json::json!({}));
            }
        },
        |_, _| {},
    )
    .await;
    let (status, err): (&str, Option<String>) = match &outcome {
        RunOutcome::Done => ("done", None),
        RunOutcome::Paused => ("paused", None),
        RunOutcome::Error(e) => ("error", Some(e.clone())),
    };
    {
        let guard = state.room.lock().unwrap();
        if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
            let _ = db::set_job_status(&r.conn, &child_id, status, err.as_deref());
        }
    }
    match outcome {
        RunOutcome::Done => {
            let meta = published.lock().unwrap().take();
            let name = meta.as_ref().map(|m| m.name.clone()).unwrap_or_default();
            Ok((format!("Saved a full pass of \"{file_name}\" as \"{name}\"."), meta))
        }
        // The parent's cancel tripped — surface STOPPED so the workflow parks and
        // re-drives this node on resume.
        RunOutcome::Paused => Err("STOPPED".into()),
        RunOutcome::Error(e) => Err(e),
    }
}

/// The human label for the progress card at `done` finished steps — names the
/// exact part being read (with its character span) so the pass is watchable.
pub(crate) fn pass_progress_label(plan: &PassPlan, steps: &[Step], done: usize) -> String {
    let n = plan.windows.len();
    if done < n {
        let (start, end) = plan.windows[done];
        format!(
            "Reading part {} of {} — characters {}–{}",
            done + 1,
            n,
            start,
            end
        )
    } else if done < steps.len() {
        let step = &steps[done];
        match step.kind.as_str() {
            "compose" => {
                let sec = step.params["section"].as_u64().unwrap_or(0) as usize;
                let total = step.params["total"].as_u64().unwrap_or(1) as usize;
                format!("Writing section {} of {}…", sec + 1, total)
            }
            _ => "Saving the result into the room…".to_string(),
        }
    } else {
        "Finishing…".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stitch_plan_is_a_chain_plus_publish() {
        let steps = build_pass_steps(4, "stitch", Lane::LocalLlm);
        assert_eq!(steps.len(), 5);
        // Maps chain: 1←0, 2←1, 3←2.
        assert!(steps[0].depends_on.is_empty());
        assert_eq!(steps[2].depends_on, vec![1]);
        // Publish is CPU work riding on the last map.
        let publish = steps.last().unwrap();
        assert_eq!(publish.kind, "publish");
        assert_eq!(publish.lane, Lane::Cpu);
        assert_eq!(publish.depends_on, vec![3]);
    }

    #[test]
    fn merge_plan_is_maps_then_ordered_sections_then_publish() {
        // 50 windows, sections of PASS_SECTION_WINDOWS(6) → 9 section composes
        // (the last covers the tail of 2), then one publish.
        let n = 50;
        let steps = build_pass_steps(n, "merge", Lane::LocalLlm);
        let sections = n.div_ceil(PASS_SECTION_WINDOWS);
        assert_eq!(sections, 9);
        let composes: Vec<&Step> = steps.iter().filter(|s| s.kind == "compose").collect();
        assert_eq!(composes.len(), sections);
        // Section 0 composes windows 0..6, and knows its index + the total.
        assert_eq!(composes[0].depends_on, (0..PASS_SECTION_WINDOWS).collect::<Vec<_>>());
        assert_eq!(composes[0].params["section"], 0);
        assert_eq!(composes[0].params["total"], sections);
        assert_eq!(composes[0].lane, Lane::LocalLlm);
        // The last section covers only the tail windows (48, 49).
        let last_start = (sections - 1) * PASS_SECTION_WINDOWS;
        assert_eq!(composes.last().unwrap().depends_on, (last_start..n).collect::<Vec<_>>());
        // Publish is CPU work depending on every section, in order.
        let publish = steps.last().unwrap();
        assert_eq!(publish.kind, "publish");
        assert_eq!(publish.lane, Lane::Cpu);
        let section_ids: Vec<usize> = composes.iter().map(|s| s.id).collect();
        assert_eq!(publish.depends_on, section_ids);
        // No fold steps remain.
        assert!(steps.iter().all(|s| s.kind != "merge"));
        // Topological ids: every dependency is lower than its step (this is
        // what makes cursor-based resume valid).
        for s in &steps {
            for d in &s.depends_on {
                assert!(*d < s.id, "step {} depends on later step {}", s.id, d);
            }
        }
        // Ids are dense and ordered.
        for (i, s) in steps.iter().enumerate() {
            assert_eq!(s.id, i);
        }
    }

    #[test]
    fn merge_plan_sections_cover_every_window_once() {
        // 1 window → a single section over [0], then publish.
        let steps = build_pass_steps(1, "merge", Lane::Cloud);
        let kinds: Vec<&str> = steps.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(kinds, vec!["map", "compose", "publish"]);
        assert_eq!(steps[1].depends_on, vec![0]);
        assert_eq!(steps[1].params["total"], 1);

        // 7 windows → 2 sections ([0..6], [6..7]); together they cover 0..7 once.
        let steps = build_pass_steps(7, "merge", Lane::Cloud);
        let composes: Vec<&Step> = steps.iter().filter(|s| s.kind == "compose").collect();
        assert_eq!(composes.len(), 2);
        assert_eq!(composes[0].depends_on, (0..6).collect::<Vec<_>>());
        assert_eq!(composes[1].depends_on, vec![6]);
        let covered: Vec<usize> =
            composes.iter().flat_map(|s| s.depends_on.clone()).collect();
        assert_eq!(covered, (0..7).collect::<Vec<_>>());
    }

    #[test]
    fn plan_without_digest_still_deserializes() {
        // Plans persisted before `textSha256` existed must keep loading — a
        // paused pass from an older build resumes on the length check alone.
        let v = serde_json::json!({
            "fileId": "f", "fileName": "book.txt", "instruction": "summarize",
            "mode": "merge", "textLen": 10, "windows": [[0, 10]]
        });
        let plan: PassPlan = serde_json::from_value(v).unwrap();
        assert!(plan.text_sha256.is_none());
    }

    // ---------------------------------------------------------------------
    // MIGRATION BASELINE (Rust → Python/LangGraph). Everything below pins
    // behaviour the pure-plan tests above never touch: the `Step.kind`
    // dispatch, the publish side effect, the coverage arithmetic, and the
    // resume contract. These must pass IDENTICALLY before and after the move.
    // They are hermetic — no sidecar, no model, no room file on disk.
    // ---------------------------------------------------------------------

    /// A mock Tauri app whose managed `AppState` holds ONE in-memory room —
    /// the same shape `file_pass_end_to_end_with_real_model` builds, minus the
    /// encrypted file on disk (these tests never call the model, so the plain
    /// in-memory schema is enough and keeps them fast and hermetic).
    fn mock_room(path: &str) -> tauri::AppHandle<tauri::test::MockRuntime> {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = AppState::default();
        *state.room.lock().unwrap() = Some(Room {
            conn: db::mem(),
            path: path.to_string(),
            name: "t".into(),
            password: "pw".into(),
        });
        app.manage(state);
        app.handle().clone()
    }

    /// Borrow the room's connection. NEVER hold this across an `execute_pass_step`
    /// await — the step takes the same lock.
    fn with_conn<T>(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        f: impl FnOnce(&Connection) -> T,
    ) -> T {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        f(&guard.as_ref().unwrap().conn)
    }

    fn plan_for(mode: &str, windows: Vec<(usize, usize)>, text_len: usize) -> PassPlan {
        PassPlan {
            file_id: "file-1".into(),
            file_name: "book.txt".into(),
            instruction: "summarize".into(),
            mode: mode.into(),
            text_len,
            text_sha256: None,
            windows,
        }
    }

    fn art(result: &str, skipped: bool) -> PassArtifact {
        PassArtifact { result: result.into(), thread: String::new(), skipped, file_id: None }
    }

    /// Drive one step against the mock room, returning its result and whatever
    /// it recorded in the `published` slot.
    async fn run_step(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        job_id: &str,
        room_path: &str,
        plan: &PassPlan,
        filtered: &str,
        step: &Step,
        cancel: &Arc<AtomicBool>,
    ) -> (Result<(), String>, Option<FileMeta>) {
        let published: std::sync::Mutex<Option<FileMeta>> = std::sync::Mutex::new(None);
        let r = execute_pass_step(
            app, job_id, room_path, plan, "test-model", filtered, step, cancel, &published,
        )
        .await;
        let meta = published.lock().unwrap().take();
        (r, meta)
    }

    #[test]
    fn step_kind_is_a_live_dispatch_discriminant_not_a_constant() {
        // file_pass is the ONLY job kind whose steps carry three different
        // `kind` values; the workflow compiler emits the constant
        // "workflow_node" and deep_summary the constant "summarize_file". A
        // migration that models `kind` as a per-job constant silently breaks
        // this kind, so pin the exact strings and their positions.
        let merge = build_pass_steps(13, "merge", Lane::LocalLlm);
        let kinds: Vec<&str> = merge.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(&kinds[..13], &["map"; 13]);
        assert_eq!(&kinds[13..], &["compose", "compose", "compose", "publish"]);
        let stitch = build_pass_steps(3, "stitch", Lane::LocalLlm);
        assert_eq!(
            stitch.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(),
            vec!["map", "map", "map", "publish"]
        );
        // Stitch has NO compose step at all — its deliverable is the ordered
        // concatenation of the map outputs.
        assert!(stitch.iter().all(|s| s.kind != "compose"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_step_kind_is_a_hard_error() {
        // The `other =>` arm. This is what a migration that stamped every step
        // with a constant kind (or renamed "map" → "node") would hit — and it
        // is a step ERROR, so the job parks instead of skipping the step.
        let app = mock_room("/tmp/r1.roomai");
        let plan = plan_for("merge", vec![(0, 4)], 4);
        let step = Step {
            id: 0,
            lane: Lane::Cpu,
            kind: "workflow_node".into(),
            params: serde_json::Value::Null,
            depends_on: vec![],
        };
        let (r, _) = run_step(
            &app, "job", "/tmp/r1.roomai", &plan, "text", &step,
            &Arc::new(AtomicBool::new(false)),
        )
        .await;
        assert_eq!(r, Err("unknown pass step kind: workflow_node".into()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn publish_replays_onto_the_same_file_instead_of_duplicating_it() {
        // `db::insert_file` mints a fresh uuid, so publish used to leave a
        // SECOND identical "Full pass — …" file (and a second copy of its search
        // chunks) whenever it re-ran — a crash between the write and
        // `checkpoint_job`, or a resume from a reset cursor. It now records the
        // file it wrote in its own artifact and overwrites that file on a
        // replay, which is versioned, so the previous deliverable is still
        // recoverable through Time Machine.
        //
        // UPDATED (this wave): the old test asserted the duplicate as the
        // pinned behaviour.
        let room = "/tmp/r2.roomai";
        let app = mock_room(room);
        let plan = plan_for("merge", vec![(0, 4)], 4);
        let steps = build_pass_steps(1, "merge", Lane::LocalLlm);
        let job = with_conn(&app, |c| {
            let id = db::create_job(c, "file_pass", "Full pass — book.txt",
                &serde_json::to_value(&plan).unwrap(), steps.len() as i64).unwrap();
            store_artifact(c, &id, 0, &art("notes", false)).unwrap();
            store_artifact(c, &id, 1, &art("<h2>Section</h2>", false)).unwrap();
            id
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let publish = steps.last().unwrap();

        let (r1, m1) = run_step(&app, &job, room, &plan, "text", publish, &cancel).await;
        assert!(r1.is_ok());
        let (r2, m2) = run_step(&app, &job, room, &plan, "text", publish, &cancel).await;
        assert!(r2.is_ok());

        let m1 = m1.expect("publish records the file it wrote");
        let m2 = m2.expect("the replay records the SAME file");
        assert_eq!(m1.name, "Full pass — book.txt.html");
        assert_eq!(m2.id, m1.id, "a replay must not mint a second deliverable");
        let same_name = with_conn(&app, |c| {
            db::list_files(c).unwrap().into_iter().filter(|f| f.name == m1.name).count()
        });
        assert_eq!(same_name, 1, "two runs of publish leave ONE file in the room");
        // The overwrite is snapshotted, so the first deliverable is recoverable.
        let versions = with_conn(&app, |c| db::list_file_versions(c, &m1.id).unwrap().len());
        assert_eq!(versions, 1, "the replay's overwrite is undoable");
        // The publish step's own artifact carries the file id that makes it so.
        let recorded = with_conn(&app, |c| load_artifact(c, &job, publish.id).unwrap().file_id);
        assert_eq!(recorded.as_deref(), Some(m1.id.as_str()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stitch_publish_body_is_byte_exact() {
        // The stitch deliverable is pure string assembly — no model — so it is
        // fully pinnable: markdown, the missing-part placeholder (1-BASED), the
        // "---" rule and the italicised coverage line, and the .md name/mime.
        let room = "/tmp/r3.roomai";
        let app = mock_room(room);
        let plan = plan_for("stitch", vec![(0, 10), (9, 20), (19, 30)], 30);
        let steps = build_pass_steps(3, "stitch", Lane::LocalLlm);
        let job = with_conn(&app, |c| {
            let id = db::create_job(c, "file_pass", "t",
                &serde_json::to_value(&plan).unwrap(), steps.len() as i64).unwrap();
            store_artifact(c, &id, 0, &art("  part one  ", false)).unwrap();
            store_artifact(c, &id, 1, &art("", true)).unwrap(); // the model gave up here
            store_artifact(c, &id, 2, &art("part three", false)).unwrap();
            id
        });
        let (r, meta) = run_step(&app, &job, room, &plan, "text", steps.last().unwrap(),
            &Arc::new(AtomicBool::new(false))).await;
        assert!(r.is_ok());
        let meta = meta.unwrap();
        assert_eq!(meta.name, "Full pass — book.txt.md");
        assert_eq!(meta.mime_type, "text/markdown");
        assert_eq!(meta.source, "generated");
        let body = with_conn(&app, |c| db::get_file_extracted_text(c, &meta.id).unwrap());
        assert_eq!(
            body,
            "part one\n\n[part 2 could not be processed]\n\npart three\n\n---\n\n\
             _Read 2 of 3 parts of “book.txt” (30 characters); 1 part(s) could not be \
             processed and are marked in place._\n"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn merge_publish_coverage_counts_map_rows_and_over_claims_empty_windows() {
        // Coverage is computed from the MAP artifacts (0..n), never from the
        // sections. Two rules that differ and must both survive the migration:
        //   * a MISSING map row counts as skipped (is_none_or);
        //   * an artifact with skipped=false but an EMPTY result counts as
        //     COVERED here, while `compose` counts that same row as `missing`.
        // So a malformed sidecar reply (deserialized via unwrap_or_default →
        // skipped=false, result="") makes the published coverage line
        // OVER-CLAIM. Pinned as-is: it is today's behaviour, and a migration
        // that "fixes" it changes user-visible output.
        let room = "/tmp/r4.roomai";
        let app = mock_room(room);
        let plan = plan_for("merge", vec![(0, 10), (9, 20), (19, 30)], 30);
        let steps = build_pass_steps(3, "merge", Lane::LocalLlm); // 3 maps, 1 compose, publish
        let job = with_conn(&app, |c| {
            let id = db::create_job(c, "file_pass", "t",
                &serde_json::to_value(&plan).unwrap(), steps.len() as i64).unwrap();
            store_artifact(c, &id, 0, &art("real notes", false)).unwrap();
            store_artifact(c, &id, 1, &art("", false)).unwrap(); // empty, NOT flagged
            // window 2 has NO row at all
            store_artifact(c, &id, 3, &art("<h2>S</h2>", false)).unwrap();
            id
        });
        let (r, meta) = run_step(&app, &job, room, &plan, "text", steps.last().unwrap(),
            &Arc::new(AtomicBool::new(false))).await;
        assert!(r.is_ok());
        let doc = with_conn(&app, |c| {
            db::get_file_extracted_text(c, &meta.unwrap().id).unwrap()
        });
        // 1 skipped (the missing row) — the empty-but-unflagged window 1 is
        // counted as READ even though compose treated it as missing.
        assert!(
            doc.contains(
                "Read 2 of 3 parts of “book.txt” (30 characters); 1 part(s) could not be \
                 processed and are marked in place."
            ),
            "coverage line changed: {doc}"
        );
        assert!(doc.starts_with("<!doctype html>"));
        assert!(doc.contains("<hr/>"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn merge_publish_full_coverage_line_and_missing_section_placeholder() {
        let room = "/tmp/r5.roomai";
        let app = mock_room(room);
        let plan = plan_for("merge", vec![(0, 10), (9, 20)], 20);
        // Force TWO sections by hand (the real grouping needs >6 windows).
        let publish = Step {
            id: 4,
            lane: Lane::Cpu,
            kind: "publish".into(),
            params: serde_json::json!({ "sections": [2, 3] }),
            depends_on: vec![2, 3],
        };
        let job = with_conn(&app, |c| {
            let id = db::create_job(c, "file_pass", "t",
                &serde_json::to_value(&plan).unwrap(), 5).unwrap();
            store_artifact(c, &id, 0, &art("a", false)).unwrap();
            store_artifact(c, &id, 1, &art("b", false)).unwrap();
            store_artifact(c, &id, 2, &art("<h2>One</h2>", false)).unwrap();
            store_artifact(c, &id, 3, &art("", true)).unwrap(); // section 2 collapsed
            id
        });
        let (r, meta) = run_step(&app, &job, room, &plan, "text", &publish,
            &Arc::new(AtomicBool::new(false))).await;
        assert!(r.is_ok());
        let doc = with_conn(&app, |c| {
            db::get_file_extracted_text(c, &meta.unwrap().id).unwrap()
        });
        // Every map row is present and unflagged → the "complete coverage" line.
        assert!(
            doc.contains("Read all 2 parts of “book.txt” — 20 characters, complete coverage."),
            "coverage line changed: {doc}"
        );
        // A collapsed section is marked IN PLACE, keeping the document ordered.
        assert!(doc.contains("<h2>One</h2>"));
        assert!(doc.contains("<p><em>[a section could not be composed]</em></p>"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_wholly_collapsed_merge_pass_still_publishes_a_placeholder_document() {
        // The "no readable sections" guard is all but DEAD: an unusable section
        // pushes a placeholder into html_body, so html_body is never blank once
        // the step has at least one section id — a pass whose every section
        // collapsed still writes a file containing nothing but placeholders and
        // a coverage line. Pinned because it is the behaviour a resumed/replayed
        // pass produces, and because a migration "tidying" the empty check would
        // change whether the job ends done or error.
        let room = "/tmp/r6.roomai";
        let app = mock_room(room);
        let plan = plan_for("merge", vec![(0, 10)], 10);
        let steps = build_pass_steps(1, "merge", Lane::LocalLlm);
        let job = with_conn(&app, |c| {
            let id = db::create_job(c, "file_pass", "t",
                &serde_json::to_value(&plan).unwrap(), steps.len() as i64).unwrap();
            store_artifact(c, &id, 0, &art("notes", false)).unwrap();
            store_artifact(c, &id, 1, &art("   ", false)).unwrap(); // whitespace only
            id
        });
        let (r, meta) = run_step(&app, &job, room, &plan, "text", steps.last().unwrap(),
            &Arc::new(AtomicBool::new(false))).await;
        assert!(r.is_ok(), "a collapsed section publishes anyway: {r:?}");
        let doc = with_conn(&app, |c| {
            db::get_file_extracted_text(c, &meta.unwrap().id).unwrap()
        });
        assert!(doc.contains("<p><em>[a section could not be composed]</em></p>"));
        // …and the coverage line still calls it COMPLETE, because coverage reads
        // the MAP rows and map 0 succeeded. Empty document, "complete coverage".
        assert!(doc.contains("Read all 1 parts of “book.txt” — 10 characters, complete coverage."));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn publish_only_errors_when_the_step_carries_no_sections_at_all() {
        // The reachable half of that guard: a publish step whose `sections`
        // param is missing/misshapen (the exact failure a re-derived or ported
        // plan would produce). Nothing is written, so THIS error is safely
        // replayable — unlike a successful publish.
        let room = "/tmp/r6b.roomai";
        let app = mock_room(room);
        let plan = plan_for("merge", vec![(0, 10)], 10);
        let job = with_conn(&app, |c| {
            db::create_job(c, "file_pass", "t",
                &serde_json::to_value(&plan).unwrap(), 3).unwrap()
        });
        let publish = Step {
            id: 2,
            lane: Lane::Cpu,
            kind: "publish".into(),
            params: serde_json::json!({ "inputs": [0] }), // stitch-shaped params
            depends_on: vec![1],
        };
        let before = with_conn(&app, |c| db::list_files(c).unwrap().len());
        let (r, meta) = run_step(&app, &job, room, &plan, "text", &publish,
            &Arc::new(AtomicBool::new(false))).await;
        assert_eq!(r, Err("the pass produced no readable sections to publish".into()));
        assert!(meta.is_none());
        assert_eq!(with_conn(&app, |c| db::list_files(c).unwrap().len()), before);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn compose_stores_a_skipped_section_without_calling_the_model() {
        // The early return at the top of the compose arm: when NO window in the
        // group yields usable notes, compose writes a skipped artifact and
        // never touches the sidecar. Note the "usable" test — `skipped=false`
        // AND a non-blank result — is STRICTER than publish's skip count.
        let room = "/tmp/r7.roomai";
        let app = mock_room(room);
        let plan = plan_for("merge", vec![(0, 10), (9, 20)], 20);
        let steps = build_pass_steps(2, "merge", Lane::LocalLlm);
        let job = with_conn(&app, |c| {
            let id = db::create_job(c, "file_pass", "t",
                &serde_json::to_value(&plan).unwrap(), steps.len() as i64).unwrap();
            store_artifact(c, &id, 0, &art("", false)).unwrap();  // empty, unflagged
            store_artifact(c, &id, 1, &art("x", true)).unwrap();  // flagged skipped
            id
        });
        let compose = &steps[2];
        assert_eq!(compose.kind, "compose");
        let (r, _) = run_step(&app, &job, room, &plan, "text", compose,
            &Arc::new(AtomicBool::new(false))).await;
        assert!(r.is_ok(), "compose must degrade, not fail: {r:?}");
        let stored = with_conn(&app, |c| load_artifact(c, &job, compose.id).unwrap());
        assert!(stored.skipped);
        assert_eq!(stored.result, "");
        assert_eq!(stored.thread, "");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_map_step_stops_before_the_model_and_leaves_no_artifact() {
        // Stop is checked INSIDE `sidecar_json_cancellable` before the request,
        // so a cancelled map returns the STOPPED sentinel and writes nothing.
        // `spawn_file_pass` normalizes that step error to Paused; the wave
        // never checkpoints, so this step re-runs on resume.
        let room = "/tmp/r8.roomai";
        let app = mock_room(room);
        let plan = plan_for("merge", vec![(0, 4), (3, 8)], 8);
        let steps = build_pass_steps(2, "merge", Lane::LocalLlm);
        let job = with_conn(&app, |c| {
            let id = db::create_job(c, "file_pass", "t",
                &serde_json::to_value(&plan).unwrap(), steps.len() as i64).unwrap();
            store_artifact(c, &id, 0, &art("prior notes", false)).unwrap();
            id
        });
        let cancel = Arc::new(AtomicBool::new(true));
        let (r, _) = run_step(&app, &job, room, &plan, "abcdefgh", &steps[1], &cancel).await;
        assert_eq!(r, Err("STOPPED".into()));
        assert!(with_conn(&app, |c| load_artifact(c, &job, 1)).is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn map_guards_reject_a_stale_plan_before_any_model_call() {
        let room = "/tmp/r9.roomai";
        let app = mock_room(room);
        let plan = plan_for("merge", vec![(0, 4)], 4);
        let cancel = Arc::new(AtomicBool::new(false));
        // A window id the plan doesn't have (a re-derived plan that shrank).
        let bad_id = Step {
            id: 0, lane: Lane::LocalLlm, kind: "map".into(),
            params: serde_json::json!({ "window": 7 }), depends_on: vec![],
        };
        let (r, _) = run_step(&app, "j", room, &plan, "abcd", &bad_id, &cancel).await;
        assert_eq!(r, Err("window 7 is not in the plan".into()));
        // A span the CURRENT text can't satisfy — the second line of defence
        // behind the resume-time text_len/text_sha256 check.
        let ok_id = Step {
            id: 0, lane: Lane::LocalLlm, kind: "map".into(),
            params: serde_json::json!({ "window": 0 }), depends_on: vec![],
        };
        let (r, _) = run_step(&app, "j", room, &plan, "ab", &ok_id, &cancel).await;
        assert_eq!(
            r,
            Err("the file's text no longer matches this pass — start a new pass".into())
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_room_touching_step_parks_when_the_room_swapped() {
        // room_path pins each step to the room the pass started in.
        let app = mock_room("/tmp/open.roomai");
        let gone = "/tmp/closed.roomai";
        let plan = plan_for("merge", vec![(0, 4), (3, 8)], 8);
        let steps = build_pass_steps(2, "merge", Lane::LocalLlm);
        let cancel = Arc::new(AtomicBool::new(false));
        let msg = Err::<(), String>("The room this job belongs to is no longer open.".into());
        // map 1 reads the previous window's thread from the room first.
        assert_eq!(run_step(&app, "j", gone, &plan, "abcdefgh", &steps[1], &cancel).await.0, msg);
        // compose gathers its group's notes from the room.
        assert_eq!(run_step(&app, "j", gone, &plan, "abcdefgh", &steps[2], &cancel).await.0, msg);
        // publish writes into the room.
        assert_eq!(run_step(&app, "j", gone, &plan, "abcdefgh", &steps[3], &cancel).await.0, msg);
    }

    #[test]
    fn pass_artifact_wire_format_is_the_migration_contract() {
        // A Python step writing job_artifacts must emit exactly these three
        // keys. All are `#[serde(default)]`, so partial rows load, and the
        // `unwrap_or_default()` in the map/compose arms turns a MALFORMED
        // sidecar reply into an empty artifact with skipped = FALSE — which
        // publish then counts as covered (see the over-claim test above).
        let a: PassArtifact = serde_json::from_value(
            serde_json::json!({ "result": "r", "thread": "t", "skipped": true }),
        )
        .unwrap();
        assert_eq!((a.result.as_str(), a.thread.as_str(), a.skipped), ("r", "t", true));
        let json = serde_json::to_value(&art("r", false)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "result": "r", "thread": "", "skipped": false })
        );
        // Partial + unknown-field tolerance.
        let p: PassArtifact =
            serde_json::from_value(serde_json::json!({ "result": "only" })).unwrap();
        assert!(!p.skipped && p.thread.is_empty());
        // The malformed-reply fallback the map arm actually uses.
        let fallback: PassArtifact =
            serde_json::from_value(serde_json::json!({ "skipped": "yes" })).unwrap_or_default();
        assert!(!fallback.skipped);
        assert_eq!(fallback.result, "");
    }

    #[test]
    fn only_engine_death_parks_the_pass() {
        // is_fatal decides durability: fatal → the job parks resumable; anything
        // else degrades THIS window to skipped and the pass keeps going with an
        // honest coverage line. Getting this wrong in either direction either
        // burns a whole book on a dead engine or parks on a hiccup.
        assert!(is_fatal("OLLAMA_DOWN"));
        assert!(is_fatal("MODEL_MISSING"));
        assert!(is_fatal("MODEL_MISSING:qwen3:4b"));
        assert!(!is_fatal("STOPPED"));
        assert!(!is_fatal("Local AI error (500): boom"));
        assert!(!is_fatal("ollama_down")); // exact match only
        assert!(!is_fatal("The AI model returned nothing. If this room uses a cloud model…"));
    }

    #[test]
    fn resume_rederives_the_steps_and_the_lane_follows_the_current_engine() {
        // What "file_pass re-derives its plan on resume" actually means
        // (queue.rs::start_file_pass_row): the jobs row stores a PassPlan, NOT
        // a step DAG, so the steps are rebuilt with `build_pass_steps` from the
        // plan's (windows.len(), mode) — stable — plus a lane resolved from the
        // room's CURRENT model setting — NOT stable. Ids/kinds/deps/params must
        // be identical across engines (artifacts align with step ids), and ONLY
        // the lane may differ.
        let n = 20;
        let local = build_pass_steps(n, "merge", Lane::LocalLlm);
        let cloud = build_pass_steps(n, "merge", Lane::Cloud);
        assert_eq!(local.len(), cloud.len());
        for (l, c) in local.iter().zip(&cloud) {
            assert_eq!(l.id, c.id);
            assert_eq!(l.kind, c.kind);
            assert_eq!(l.params, c.params);
            assert_eq!(l.depends_on, c.depends_on);
        }
        // Only the model steps move lane; publish stays CPU either way.
        assert_eq!(local[0].lane, Lane::LocalLlm);
        assert_eq!(cloud[0].lane, Lane::Cloud);
        assert_eq!(local.last().unwrap().lane, Lane::Cpu);
        assert_eq!(cloud.last().unwrap().lane, Lane::Cpu);
        // And that lane change is OBSERVABLE: with every map done, the local
        // lane composes one section at a time while the cloud lane fans out.
        let done: std::collections::HashSet<usize> = (0..n).collect();
        let empty = std::collections::HashSet::new();
        assert_eq!(plan_dispatch(&local, &done, &empty).len(), 1);
        assert_eq!(plan_dispatch(&cloud, &done, &empty).len(), 4);
    }

    #[test]
    fn the_section_constant_is_an_unstored_part_of_the_plan() {
        // TRIPWIRE. `windows` and `mode` are persisted; PASS_SECTION_WINDOWS is
        // NOT — yet it decides how many compose steps exist and therefore every
        // step id above the maps. Changing it re-derives a DIFFERENT DAG for an
        // already-paused pass: the stored `total` stops matching, and the stored
        // cursor seeds `0..cursor` as done over steps that are no longer the
        // same steps, so artifacts misalign silently. Bumping this constant (or
        // porting it to Python with a different value) requires a plan version
        // + migration, not just an edit.
        assert_eq!(PASS_SECTION_WINDOWS, 6);
        for n in [1usize, 5, 6, 7, 12, 13, 50] {
            let steps = build_pass_steps(n, "merge", Lane::LocalLlm);
            assert_eq!(steps.len(), n + n.div_ceil(PASS_SECTION_WINDOWS) + 1);
        }
        for n in [1usize, 4, 50] {
            assert_eq!(build_pass_steps(n, "stitch", Lane::LocalLlm).len(), n + 1);
        }
        // Window geometry is persisted, so these only pin what a FRESH plan gets.
        assert_eq!(PASS_WINDOW_CHARS, 32_000);
        assert_eq!(PASS_WINDOW_OVERLAP, 400);
    }

    #[test]
    fn progress_labels_cover_the_stitch_publish_arm() {
        // The second `Step.kind` match (`pass_progress_label`): anything that is
        // not "compose" falls into the save label — including stitch, which has
        // no compose step at all.
        let plan = plan_for("stitch", vec![(0, 10), (9, 20)], 20);
        let steps = build_pass_steps(2, "stitch", Lane::LocalLlm);
        assert_eq!(
            pass_progress_label(&plan, &steps, 0),
            "Reading part 1 of 2 — characters 0–10"
        );
        assert_eq!(pass_progress_label(&plan, &steps, 2), "Saving the result into the room…");
        // Past the end of the plan (a resumed job whose cursor is already total).
        assert_eq!(pass_progress_label(&plan, &steps, 3), "Finishing…");
    }

    /// REAL end-to-end: a temp encrypted room, a multi-window document, and the
    /// actual local Ollama model running the full map → section-compose →
    /// publish pipeline — including a mid-run Stop and a resume from the
    /// checkpoint. Gated behind --ignored because it needs a running Ollama.
    /// Run: cargo test --lib file_pass_end_to_end -- --ignored --nocapture
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a running Ollama with a local model"]
    async fn file_pass_end_to_end_with_real_model() {
        use tauri::Manager;
        let models = ollama::list_models().await.unwrap_or_default();
        let Some(model) = models
            .iter()
            .find(|m| {
                !is_external_engine(m) && !is_cloud_model(m) && !m.contains("embed")
            })
            .cloned()
        else {
            eprintln!("SKIP: no local Ollama model available");
            return;
        };
        eprintln!("using model {model}");

        // A three-act document with one distinctive fact per act, long enough
        // to need several windows at the small test target.
        let mut text = String::new();
        text.push_str(&format!(
            "EXPEDITION LOG — OPENING.\nThe ship is called the Peregrine Moth.\n{}\n\n",
            "The northern route was chosen for its calm currents. ".repeat(60)
        ));
        text.push_str(&format!(
            "MIDDLE PASSAGE.\nThe navigator's name is Ilya Baruch.\n{}\n\n",
            "Supplies were counted twice each morning without fail. ".repeat(60)
        ));
        text.push_str(&format!(
            "FINAL SECTION.\nThe voyage ended at the lighthouse of Cape Venn.\n{}\n",
            "The crew kept a shared journal of small kindnesses. ".repeat(60)
        ));

        let dir = std::env::temp_dir().join(format!("pass-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let room_path = dir.join("pass.roomai").to_string_lossy().into_owned();
        let conn = db::create_room(&room_path, "pw", "pass-e2e").unwrap();
        let file = db::insert_file(
            &conn,
            "expedition.txt",
            "text/plain",
            text.as_bytes(),
            Some(&text),
            "upload",
        )
        .unwrap();

        // Small windows so the test runs in minutes, not hours; the plan
        // carries explicit spans, so any target is a valid plan.
        let filtered = extraction::smart_filter(&text);
        let windows = extraction::partition_windows(&filtered, 4_000, 200);
        assert!(windows.len() >= 3, "want a multi-window doc, got {}", windows.len());
        let plan = PassPlan {
            file_id: file.id.clone(),
            file_name: file.name.clone(),
            instruction: "Summarize this expedition log thoroughly — every named person, \
                          place and practice."
                .into(),
            mode: "merge".into(),
            text_len: filtered.len(),
            text_sha256: None,
            windows,
        };
        let n = plan.windows.len();
        let steps = build_pass_steps(n, &plan.mode, Lane::LocalLlm);

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = AppState::default();
        *state.room.lock().unwrap() = Some(Room {
            conn,
            path: room_path.clone(),
            name: "pass-e2e".into(),
            password: "pw".into(),
        });
        app.manage(state);
        let handle = app.handle().clone();

        let job_id = {
            let state = handle.state::<AppState>();
            let guard = state.room.lock().unwrap();
            db::create_job(
                &guard.as_ref().unwrap().conn,
                "file_pass",
                "Full pass — expedition.txt",
                &serde_json::to_value(&plan).unwrap(),
                steps.len() as i64,
            )
            .unwrap()
        };
        let filtered = Arc::new(filtered);
        let published: Arc<std::sync::Mutex<Option<FileMeta>>> =
            Arc::new(std::sync::Mutex::new(None));
        let cursor_store = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        // Leg 1: trip Stop after the first completed step — the pass must
        // checkpoint and pause exactly like a user pressing Stop.
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome = {
            let handle = handle.clone();
            let plan = plan.clone();
            let model = model.clone();
            let job_id = job_id.clone();
            let room_path = room_path.clone();
            let cancel_in = cancel.clone();
            let filtered = filtered.clone();
            let published = published.clone();
            let cs = cursor_store.clone();
            run_plan(
                &steps,
                std::collections::HashSet::new(),
                cancel.clone(),
                move |s| {
                    let handle = handle.clone();
                    let plan = plan.clone();
                    let model = model.clone();
                    let job_id = job_id.clone();
                    let room_path = room_path.clone();
                    let cancel = cancel_in.clone();
                    let filtered = filtered.clone();
                    let published = published.clone();
                    async move {
                        let r = execute_pass_step(
                            &handle, &job_id, &room_path, &plan, &model, &filtered, &s,
                            &cancel, &published,
                        )
                        .await;
                        cancel.store(true, Ordering::SeqCst); // Stop after one step
                        r
                    }
                },
                |done| cs.store(dense_prefix(done), Ordering::SeqCst),
                |done, total| eprintln!("leg1 {done}/{total}"),
            )
            .await
        };
        assert_eq!(outcome, RunOutcome::Paused, "Stop must pause, not error");
        let resume_from = cursor_store.load(Ordering::SeqCst);
        assert!(resume_from >= 1, "at least one step must have checkpointed");
        eprintln!("paused at cursor {resume_from}; resuming…");

        // Leg 2: resume from the checkpoint and run to completion.
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome = {
            let handle = handle.clone();
            let plan = plan.clone();
            let model = model.clone();
            let job_id = job_id.clone();
            let room_path = room_path.clone();
            let cancel_in = cancel.clone();
            let filtered = filtered.clone();
            let published = published.clone();
            let cs = cursor_store.clone();
            let label_plan = plan.clone();
            let label_steps = steps.clone();
            run_plan(
                &steps,
                (0..resume_from).collect(),
                cancel.clone(),
                move |s| {
                    let handle = handle.clone();
                    let plan = plan.clone();
                    let model = model.clone();
                    let job_id = job_id.clone();
                    let room_path = room_path.clone();
                    let cancel = cancel_in.clone();
                    let filtered = filtered.clone();
                    let published = published.clone();
                    async move {
                        execute_pass_step(
                            &handle, &job_id, &room_path, &plan, &model, &filtered, &s,
                            &cancel, &published,
                        )
                        .await
                    }
                },
                |done| cs.store(dense_prefix(done), Ordering::SeqCst),
                move |done, total| {
                    eprintln!(
                        "leg2 {done}/{total} — {}",
                        pass_progress_label(&label_plan, &label_steps, done)
                    )
                },
            )
            .await
        };
        assert_eq!(outcome, RunOutcome::Done, "the resumed pass must finish");

        // Every window was read (no skips), and the result landed in the room
        // with an honest full-coverage line.
        let state = handle.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let conn = &guard.as_ref().unwrap().conn;
        for i in 0..n {
            let a = load_artifact(conn, &job_id, i).expect("map artifact must exist");
            assert!(!a.skipped, "window {i} must not be skipped");
            assert!(!a.result.trim().is_empty(), "window {i} notes must be non-empty");
        }
        let meta = published.lock().unwrap().take().expect("publish must record the file");
        assert_eq!(meta.name, "Full pass — expedition.txt.html");
        let doc = db::get_file_extracted_text(conn, &meta.id).expect("published file has text");
        assert!(
            doc.contains(&format!("Read all {n} parts")),
            "coverage line must confirm completeness"
        );
        eprintln!("\n===== published document =====\n{doc}\n==============================");
    }

    #[test]
    fn progress_labels_name_the_exact_window() {
        let plan = PassPlan {
            file_id: "f".into(),
            file_name: "book.txt".into(),
            instruction: "summarize".into(),
            mode: "merge".into(),
            text_len: 40_000,
            text_sha256: None,
            windows: vec![(0, 16_000), (15_600, 31_600), (31_200, 40_000)],
        };
        let steps = build_pass_steps(3, "merge", Lane::LocalLlm);
        assert_eq!(
            pass_progress_label(&plan, &steps, 0),
            "Reading part 1 of 3 — characters 0–16000"
        );
        assert_eq!(
            pass_progress_label(&plan, &steps, 2),
            "Reading part 3 of 3 — characters 31200–40000"
        );
        // After the maps: 3 windows fit in one section, then the save. (Step 3 is
        // the lone section compose; step 4 is publish.)
        assert_eq!(pass_progress_label(&plan, &steps, 3), "Writing section 1 of 1…");
        assert!(pass_progress_label(&plan, &steps, 4).contains("Saving"));
    }
}
