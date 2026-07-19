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
                    PassArtifact { result: String::new(), thread, skipped: true }
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
                db::insert_file(
                    &room.conn,
                    &name,
                    "text/markdown",
                    body.as_bytes(),
                    Some(&body),
                    "generated",
                )?
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
                db::insert_file(
                    &room.conn,
                    &name,
                    "text/html",
                    content.as_bytes(),
                    Some(&content),
                    "generated",
                )?
            };
            if let Some(w) = app.get_webview_window("main") {
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
