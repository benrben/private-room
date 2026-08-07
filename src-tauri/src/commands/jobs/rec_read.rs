//! The reading pass: the room reads a recording and writes what happened in
//! it — chapters, highlights, and notes (decisions, action items, open
//! questions, key points).
//!
//! Runs by itself when a recording is stopped, in the background for
//! recordings the room already had, and from the "Read this recording" button.
//!
//! Shape (a simpler `file_pass`, and the differences are the point):
//!   1. `partition_turns` splits the transcript into consecutive windows of
//!      WHOLE speaker turns (plan-time, pure). A turn is atomic — half a
//!      sentence in each of two windows would be read twice and understood
//!      neither time.
//!   2. N chained `map` steps walk the meeting IN ORDER, each receiving its
//!      turns plus the short `thread` carried from the previous step. Each
//!      writes an artifact.
//!   3. **No compose step.** `file_pass` needs one because a document's
//!      sections have to be written; here the findings are already local to
//!      their window, so the reduce is `merge_findings` — ordinary code. That
//!      is deliberate: `file_pass`'s own header records a whole-file model fold
//!      collapsing on a small local model and losing an 850 KB book's chapters.
//!      Nothing here may reintroduce a global model fold.
//!   4. A `publish` step (no model) resolves turn numbers to times, merges, and
//!      writes into the recording's meta through `edit_rec_meta`.
//!
//! **The model never states a time.** It answers with the turn NUMBER it was
//! shown (`#12`), and `merge_findings` converts that to the exact centisecond
//! of that turn. A number outside the window is dropped. So a hallucinated
//! timestamp cannot exist — the worst case is a finding attached to the wrong
//! real moment, never a mark at a moment that never happened. (The private
//! browser numbers page elements for the same reason.)
//!
//! Every step is checkpointed by the ADD-30 job runner, so a read survives
//! Stop, app quit and crashes, and resumes from its cursor.

use super::*;
use crate::recording::{By, NoteKind, RecChapter, RecHighlight, RecMeta, RecNote, ReadStamp};

/// Transcript characters per model call. Far smaller than `file_pass`'s 32K:
/// that window is sized for "read this prose and take notes", while this one
/// asks for STRUCTURED findings with a number attached to each. A window
/// holding forty minutes of talk invites a small model to return a dozen vague
/// items with drifting numbers; ~12K (roughly ten minutes of speech) keeps
/// every finding close to the words that produced it.
const READ_WINDOW_CHARS: usize = 12_000;

/// Chapters closer together than this are one chapter (30 s). Without a floor
/// a model asked for sections happily returns one per turn, which is not a
/// table of contents — it is the transcript with extra steps.
const MIN_CHAPTER_GAP_CS: i64 = 3_000;

/// The most findings of one kind kept from a single window. A model that
/// starts listing every sentence is not reading, and the tabs must not become
/// a second transcript.
const MAX_PER_WINDOW: usize = 12;

/// One speaker turn as the model is shown it, and as the publish step resolves
/// numbers against. Derived from the recording's segments; never persisted.
#[derive(Clone, Debug)]
pub(crate) struct Turn {
    pub t0: i64,
    pub t1: i64,
    pub who: String,
    pub text: String,
}

/// The immutable plan. Like `PassPlan` it stores the windows and a fingerprint
/// of the source, so a resumed job that finds different words refuses rather
/// than writing findings about a transcript that no longer exists.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReadPlan {
    pub file_id: String,
    pub file_name: String,
    pub stamp: ReadStamp,
    /// Half-open turn-index ranges, consecutive and gapless.
    pub windows: Vec<(usize, usize)>,
}

/// What one window's model call found. Turn NUMBERS, not times — see the module
/// header. Absent/garbage fields default rather than failing the window: a
/// partial answer is worth keeping, and `skipped` is how a lost window is
/// reported honestly.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct ReadArtifact {
    #[serde(default)]
    chapters: Vec<FoundChapter>,
    #[serde(default)]
    highlights: Vec<FoundHighlight>,
    #[serde(default)]
    notes: Vec<FoundNote>,
    #[serde(default)]
    thread: String,
    #[serde(default)]
    skipped: bool,
    /// publish only — makes the step idempotent across a replay.
    #[serde(default)]
    published: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct FoundChapter {
    turn: usize,
    #[serde(default)]
    title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct FoundHighlight {
    turn: usize,
    /// Last turn of the span; treated as `turn` when missing or before it.
    #[serde(default)]
    until: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct FoundNote {
    turn: usize,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    who: Option<String>,
}

/// The turns of a recording, in order, as the model will see them. Deleted
/// words are already gone (`segment_visible_text`), and an empty turn is
/// dropped — it is a silence, not something to read.
pub(crate) fn turns_of(meta: &RecMeta) -> Vec<Turn> {
    meta.segments
        .iter()
        .filter_map(|s| {
            let text = crate::recording::segment_visible_text(s);
            (!text.is_empty()).then(|| Turn {
                t0: s.t0,
                t1: s.t1,
                who: meta.display_speaker(&s.speaker).to_string(),
                text,
            })
        })
        .collect()
}

/// Split turns into consecutive windows of at most `target` characters.
///
/// GUARANTEES, and the tests exist for them: the windows are gapless, in
/// order, and every turn is in exactly one. A turn longer than `target` gets a
/// window to itself rather than being cut — coverage beats tidiness, and this
/// is the exact shape of the `#minutes` bug, where a clamp meant a recording
/// was read for its first five minutes and reported as read.
pub(crate) fn partition_turns(turns: &[Turn], target: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let (mut start, mut chars) = (0usize, 0usize);
    for (i, t) in turns.iter().enumerate() {
        let len = t.text.len() + t.who.len() + 16; // + the "#n [m:ss] who: " frame
        if i > start && chars + len > target {
            out.push((start, i));
            start = i;
            chars = 0;
        }
        chars += len;
    }
    if start < turns.len() {
        out.push((start, turns.len()));
    }
    out
}

/// The window as the model reads it. Numbers are GLOBAL turn indices, so a
/// finding from window 3 resolves the same way as one from window 0 and the
/// publish step never has to know which window an answer came from.
pub(crate) fn window_text(turns: &[Turn], range: (usize, usize)) -> String {
    let mut out = String::new();
    for (i, t) in turns.iter().enumerate().take(range.1).skip(range.0) {
        out.push_str(&format!(
            "#{i} {} {}: {}\n",
            crate::recording::format_stamp(t.t0),
            t.who,
            t.text
        ));
    }
    out
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn note_kind(s: &str) -> Option<NoteKind> {
    match s.trim().to_lowercase().as_str() {
        "decision" => Some(NoteKind::Decision),
        "action" | "action_item" | "task" => Some(NoteKind::Action),
        "question" | "open_question" => Some(NoteKind::Question),
        "point" | "key_point" | "summary" => Some(NoteKind::Point),
        _ => None,
    }
}

/// Turn every window's findings into the recording's annotations: resolve turn
/// numbers to real times, drop what cannot be trusted, dedupe, and sort.
///
/// The whole reduce, and it is ORDINARY CODE — no model call. Rules, each of
/// which exists because the alternative is a confident wrong claim on screen:
///
/// * A turn number outside the transcript is **dropped**. This is what makes a
///   hallucinated time impossible.
/// * An empty title/text is dropped — a blank chapter is worse than none.
/// * `who` is kept only when that name actually speaks in this recording;
///   otherwise the note survives without it. A model must not be able to
///   attribute an action item to a colleague who was never there.
/// * Same-kind notes with the same words are one note. Windows overlap in
///   subject even when they do not overlap in turns.
/// * Chapters within [`MIN_CHAPTER_GAP_CS`] collapse to the first.
/// * Overlapping highlights merge into one span.
fn merge_findings(
    found: &[ReadArtifact],
    turns: &[Turn],
    speakers: &std::collections::HashSet<String>,
) -> (Vec<RecChapter>, Vec<RecHighlight>, Vec<RecNote>) {
    let at = |n: usize| turns.get(n).map(|t| t.t0);

    let mut chapters: Vec<RecChapter> = Vec::new();
    for a in found {
        for c in a.chapters.iter().take(MAX_PER_WINDOW) {
            let (Some(t0), title) = (at(c.turn), c.title.trim()) else { continue };
            if title.is_empty() {
                continue;
            }
            chapters.push(RecChapter {
                id: uuid::Uuid::new_v4().to_string(),
                t0,
                title: title.chars().take(80).collect(),
                by: By::Room,
            });
        }
    }
    chapters.sort_by_key(|c| c.t0);
    let mut spaced: Vec<RecChapter> = Vec::new();
    for c in chapters {
        let crowded = spaced.last().is_some_and(|p| c.t0 - p.t0 < MIN_CHAPTER_GAP_CS);
        let repeat = spaced.iter().any(|p| norm(&p.title) == norm(&c.title));
        if !crowded && !repeat {
            spaced.push(c);
        }
    }

    let mut spans: Vec<(i64, i64)> = Vec::new();
    for a in found {
        for h in a.highlights.iter().take(MAX_PER_WINDOW) {
            let Some(t0) = at(h.turn) else { continue };
            let t1 = turns.get(h.until.max(h.turn)).map_or(t0, |t| t.t1).max(t0);
            spans.push((t0, t1));
        }
    }
    spans.sort();
    let mut highlights: Vec<RecHighlight> = Vec::new();
    for (t0, t1) in spans {
        match highlights.last_mut() {
            Some(prev) if t0 <= prev.t1 => prev.t1 = prev.t1.max(t1),
            _ => highlights.push(RecHighlight {
                id: uuid::Uuid::new_v4().to_string(),
                t0,
                t1,
                by: By::Room,
            }),
        }
    }

    let mut notes: Vec<RecNote> = Vec::new();
    for a in found {
        let mut per_kind: std::collections::HashMap<String, usize> = Default::default();
        for n in &a.notes {
            let (Some(t0), Some(kind)) = (at(n.turn), note_kind(&n.kind)) else { continue };
            let text = n.text.trim();
            if text.is_empty() {
                continue;
            }
            let seen = per_kind.entry(n.kind.to_lowercase()).or_default();
            if *seen >= MAX_PER_WINDOW {
                continue;
            }
            *seen += 1;
            if notes
                .iter()
                .any(|p| p.kind == kind && norm(&p.text) == norm(text))
            {
                continue;
            }
            notes.push(RecNote {
                id: uuid::Uuid::new_v4().to_string(),
                t0,
                kind,
                text: text.chars().take(400).collect(),
                // Only somebody who actually speaks here.
                who: n
                    .who
                    .as_deref()
                    .map(str::trim)
                    .filter(|w| !w.is_empty() && speakers.contains(*w))
                    .map(str::to_string),
                by: By::Room,
            });
        }
    }
    notes.sort_by_key(|n| n.t0);

    (spaced, highlights, notes)
}

/// Replace what the room found last time, keep every item the user owns.
///
/// This is the "Read again" rule, and it is the reason [`By`] exists: editing
/// an item makes it yours, and yours is never overwritten by a later pass.
pub(crate) fn install_findings(
    meta: &mut RecMeta,
    chapters: Vec<RecChapter>,
    highlights: Vec<RecHighlight>,
    notes: Vec<RecNote>,
    stamp: ReadStamp,
) {
    meta.chapters.retain(|c| c.by == By::You);
    meta.chapters.extend(chapters);
    meta.chapters.sort_by_key(|c| c.t0);

    meta.highlights.retain(|h| h.by == By::You);
    meta.highlights.extend(highlights);
    meta.highlights.sort_by_key(|h| h.t0);

    meta.notes.retain(|n| n.by == By::You);
    meta.notes.extend(notes);
    meta.notes.sort_by_key(|n| n.t0);

    meta.read_of = Some(stamp);
}

/// The step DAG: the windows in order (each carrying its thread to the next),
/// then one CPU publish. Pure and deterministic, so start and resume derive an
/// identical plan — the property the runner's `0..cursor` seeding depends on.
pub fn build_read_steps(n_windows: usize, model_lane: Lane) -> Vec<Step> {
    let mut steps: Vec<Step> = (0..n_windows)
        .map(|i| Step {
            id: i,
            lane: model_lane,
            kind: "map".into(),
            params: serde_json::json!({ "window": i }),
            depends_on: if i == 0 { vec![] } else { vec![i - 1] },
        })
        .collect();
    steps.push(Step {
        id: n_windows,
        lane: Lane::Cpu,
        kind: "publish".into(),
        params: serde_json::json!({ "inputs": (0..n_windows).collect::<Vec<usize>>() }),
        depends_on: (0..n_windows).collect(),
    });
    steps
}

fn load_artifact(conn: &Connection, job_id: &str, step_id: usize) -> Option<ReadArtifact> {
    db::get_job_artifact(conn, job_id, step_id).and_then(|s| serde_json::from_str(&s).ok())
}

fn store_artifact(
    conn: &Connection,
    job_id: &str,
    step_id: usize,
    a: &ReadArtifact,
) -> Result<(), String> {
    db::put_job_artifact(
        conn,
        job_id,
        step_id,
        &serde_json::to_string(a).map_err(|e| e.to_string())?,
    )
}

/// A hard engine failure parks the job for Resume; anything else is a one-off
/// the read survives with that window marked skipped.
fn is_fatal(e: &str) -> bool {
    e == "OLLAMA_DOWN" || e.starts_with("MODEL_MISSING")
}

/// Execute one step. `turns` is the whole recording's turn list, shared across
/// steps and re-derived once per run; `room_path` pins every room access to the
/// room the read was started in, so a room closed or swapped mid-run parks the
/// job instead of receiving another room's findings.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_read_step<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job_id: &str,
    room_path: &str,
    plan: &ReadPlan,
    model: &str,
    turns: &[Turn],
    step: &Step,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let n = plan.windows.len();
    match step.kind.as_str() {
        "map" => {
            let i = step.params["window"].as_u64().unwrap_or(0) as usize;
            let range = *plan.windows.get(i).ok_or_else(|| format!("window {i} is not in the plan"))?;
            let thread = if i == 0 {
                String::new()
            } else {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                load_artifact(&room.conn, job_id, i - 1).map(|a| a.thread).unwrap_or_default()
            };
            // `model` in the body is load-bearing beyond choosing an engine: the
            // sidecar gateway injects the room's privacy policy on any non-local
            // model (`commands::inject_policy`), so a cloud engine never sees
            // raw meeting audio transcripts. Prompts, schema, retries and clamps
            // live in the sidecar, exactly as `/file_pass_map` does it.
            let body = serde_json::json!({
                "model": model,
                "base_url": ollama::resolved_base_url(),
                "file_name": plan.file_name,
                "part": i,
                "total": n,
                "thread": thread,
                "turns": window_text(turns, range),
                "keep_alive": KEEP_ALIVE_WARM,
            });
            let artifact: ReadArtifact =
                match crate::sidecar::sidecar_json_cancellable("/rec_read_map", &body, cancel).await
                {
                    Ok(Some(v)) => serde_json::from_value(v).unwrap_or_default(),
                    Ok(None) => return Err("STOPPED".into()),
                    Err(e) => {
                        let msg = e.sentinel(Some(model));
                        if is_fatal(&msg) {
                            return Err(msg);
                        }
                        // One window lost is not a lost read — record it as
                        // skipped so the count stays honest and carry on.
                        ReadArtifact { skipped: true, thread, ..Default::default() }
                    }
                };
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room this job belongs to is no longer open.")?;
            store_artifact(&room.conn, job_id, i, &artifact)
        }
        "publish" => {
            let (found, skipped) = {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                let all: Vec<ReadArtifact> =
                    (0..n).filter_map(|i| load_artifact(&room.conn, job_id, i)).collect();
                let skipped = all.iter().filter(|a| a.skipped).count();
                (all, skipped)
            };
            // Everyone who actually speaks here — the only names an action item
            // may be attributed to.
            let (turn_now, speakers, stamp) = {
                let guard = state.room.lock().unwrap();
                let room = guard
                    .as_ref()
                    .filter(|r| r.path == room_path)
                    .ok_or("The room this job belongs to is no longer open.")?;
                let meta: RecMeta = serde_json::from_str(
                    &db::get_rec_meta(&room.conn, &plan.file_id)
                        .ok_or("That recording is no longer in the room.")?,
                )
                .map_err(|e| e.to_string())?;
                let turns = turns_of(&meta);
                let speakers = turns.iter().map(|t| t.who.clone()).collect();
                (turns, speakers, ReadStamp::of(&meta.segments))
            };
            // The words moved under us (a re-transcribe, a correction) — the
            // findings are about a transcript that no longer exists, so writing
            // them would put marks on the wrong moments.
            if stamp != plan.stamp {
                return Err("That recording's transcript changed while it was being read — read it again.".into());
            }
            let (chapters, highlights, notes) = merge_findings(&found, &turn_now, &speakers);
            let rec = app.state::<crate::commands::RecState>();
            // Idempotent by construction: `install_findings` REPLACES the
            // room's items every time, so a replay after a crash cannot
            // double them.
            crate::commands::edit_rec_meta(&state, &rec, &plan.file_id, move |meta| {
                install_findings(meta, chapters, highlights, notes, stamp);
                Ok(())
            })?;
            if skipped > 0 {
                // Never silent. A read that could not reach part of the meeting
                // must not present itself as having read all of it.
                crate::obs::warn(
                    "rec_read_incomplete",
                    &[
                        ("file", crate::obs::id(&plan.file_name)),
                        ("skipped", crate::obs::count(skipped)),
                        ("parts", crate::obs::count(n)),
                    ],
                );
            }
            Ok(())
        }
        other => Err(format!("unknown read step \"{other}\"")),
    }
}

/// Start a read of one recording: build the plan, create the job row, and
/// drive it. Returns the job id.
///
/// Refuses in the two cases where reading would be dishonest rather than
/// merely unhelpful: a recording with no words yet, and one already being read
/// (a second job would race the first into the same meta).
pub(crate) async fn start_rec_read(
    window: &tauri::Window,
    state: &AppState,
    room_path: &str,
    file_id: &str,
) -> Result<String, String> {
    let (file_name, turns, stamp) = state.with_room(|room| {
        let name = db::get_file_name(&room.conn, file_id)?;
        let meta: RecMeta = serde_json::from_str(
            &db::get_rec_meta(&room.conn, file_id).ok_or("That file is not a recording.")?,
        )
        .map_err(|e| e.to_string())?;
        let stamp = ReadStamp::of(&meta.segments);
        Ok((name, turns_of(&meta), stamp))
    })?;
    if turns.is_empty() {
        return Err("That recording has no transcript to read yet.".into());
    }
    if reading_now(state, file_id)? {
        return Err("That recording is already being read.".into());
    }
    let windows = partition_turns(&turns, READ_WINDOW_CHARS);
    let (chat_model, lane) = resolve_pass_engine(state).await;
    let steps = build_read_steps(windows.len(), lane);
    let plan = ReadPlan {
        file_id: file_id.to_string(),
        file_name: file_name.clone(),
        stamp,
        windows,
    };
    let plan_json = serde_json::to_value(&plan).map_err(|e| e.to_string())?;
    let job_id = state.with_room(|room| {
        if queue::at_capacity(&room.conn) {
            return Err(queue::QUEUE_FULL.into());
        }
        db::create_job(
            &room.conn,
            "rec_read",
            &format!("Reading {file_name}"),
            &plan_json,
            steps.len() as i64,
        )
    })?;
    // Reserve or wait: a busy room leaves the row QUEUED and the pump starts it
    // when a lane frees up. That is what keeps an automatic read of every old
    // recording from competing with the work the user is actually doing.
    if queue::try_reserve(state, &job_id) {
        let cancel = Arc::new(AtomicBool::new(false));
        state.job_cancels.lock().unwrap().insert(job_id.clone(), cancel.clone());
        spawn_rec_read(
            window.clone(),
            job_id.clone(),
            room_path.to_string(),
            plan,
            chat_model,
            steps,
            0,
            cancel,
            Arc::new(turns),
        );
    }
    Ok(job_id)
}

/// Is a read of this recording already queued or running? Two reads writing
/// the same meta would each replace the other's findings.
pub(crate) fn reading_now(state: &AppState, file_id: &str) -> Result<bool, String> {
    state.with_room(|room| {
        Ok(db::list_jobs(&room.conn)?.into_iter().any(|j| {
            j.kind == "rec_read"
                && matches!(j.status.as_str(), "queued" | "running")
                && j.plan.get("file_id").and_then(|v| v.as_str()) == Some(file_id)
        }))
    })
}

/// Resume a `rec_read` row from the queue (app restart, Resume, a pump).
pub(crate) async fn start_rec_read_row(
    window: &tauri::Window,
    state: &AppState,
    job: &db::Job,
    room_path: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let plan: ReadPlan =
        serde_json::from_value(job.plan.clone()).map_err(|_| "This job's plan is unreadable.")?;
    let turns = state.with_room(|room| {
        let meta: RecMeta = serde_json::from_str(
            &db::get_rec_meta(&room.conn, &plan.file_id)
                .ok_or("The recording this read belongs to is no longer in the room.")?,
        )
        .map_err(|e| e.to_string())?;
        // Same guard as `file_pass`: a plan is only valid against the words it
        // was built from. Findings written against a transcript that has since
        // been re-transcribed would land on the wrong moments.
        if ReadStamp::of(&meta.segments) != plan.stamp {
            return Err("That recording's transcript changed — read it again.".to_string());
        }
        Ok(turns_of(&meta))
    })?;
    let (chat_model, lane) = resolve_pass_engine(state).await;
    let steps = build_read_steps(plan.windows.len(), lane);
    let cursor = usize::try_from(job.cursor).unwrap_or(0).min(steps.len());
    spawn_rec_read(
        window.clone(),
        job.id.clone(),
        room_path.to_string(),
        plan,
        chat_model,
        steps,
        cursor,
        cancel,
        Arc::new(turns),
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn spawn_rec_read(
    window: tauri::Window,
    job_id: String,
    room_path: String,
    plan: ReadPlan,
    chat_model: String,
    steps: Vec<Step>,
    start_cursor: usize,
    cancel: Arc<AtomicBool>,
    turns: Arc<Vec<Turn>>,
) {
    use tauri::Manager;
    let app = window.app_handle().clone();
    let (runner_window, runner_job, runner_room) =
        (window.clone(), job_id.clone(), room_path.clone());
    spawn_job_runner(runner_window, runner_job, runner_room, async move {
        let state = app.state::<AppState>();
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let _ = db::set_job_status(&r.conn, &job_id, "running", None);
            }
        }
        let total = steps.len();
        emit_progress(&window, &job_id, &read_progress_label(&plan, start_cursor), start_cursor, total);
        let (exec_app, exec_job, exec_room) =
            (app.clone(), job_id.clone(), room_path.clone());
        let (exec_plan, exec_cancel, exec_turns) =
            (plan.clone(), cancel.clone(), turns.clone());
        let label_plan = plan.clone();
        let outcome = run_plan(
            &steps,
            (0..start_cursor).collect(),
            cancel.clone(),
            |s| {
                let app = exec_app.clone();
                let job_id = exec_job.clone();
                let room_path = exec_room.clone();
                let plan = exec_plan.clone();
                let model = chat_model.clone();
                let cancel = exec_cancel.clone();
                let turns = exec_turns.clone();
                async move {
                    execute_read_step(
                        &app, &job_id, &room_path, &plan, &model, &turns, &s, &cancel,
                    )
                    .await
                }
            },
            |done_set| {
                let cursor = dense_prefix(done_set);
                let state = app.state::<AppState>();
                let guard = state.room.lock().unwrap();
                if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                    let _ =
                        db::checkpoint_job(&r.conn, &job_id, cursor as i64, &serde_json::json!({}));
                }
            },
            |done, total| {
                emit_progress(&window, &job_id, &read_progress_label(&label_plan, done), done, total);
            },
        )
        .await;
        // A Stop pressed mid-model-call surfaces as the call's error, not a
        // clean pause — say Paused, not Stopped.
        let outcome = match outcome {
            RunOutcome::Error(_) if cancel.load(Ordering::SeqCst) => RunOutcome::Paused,
            o => o,
        };
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let (status, err) = match &outcome {
                    RunOutcome::Done => ("done", None),
                    RunOutcome::Paused => ("paused", None),
                    RunOutcome::Error(e) => ("error", Some(e.as_str())),
                };
                let _ = db::set_job_status(&r.conn, &job_id, status, err);
            }
        }
        state.job_cancels.lock().unwrap().remove(&job_id);
        // The viewer reloads the recording so the tabs fill in without a click.
        if matches!(outcome, RunOutcome::Done) {
            use tauri::Emitter;
            let _ = window.emit("rec-read-done", serde_json::json!({ "fileId": plan.file_id }));
        }
    });
}

/// The progress card's line: which part of the meeting is being read now.
pub(crate) fn read_progress_label(plan: &ReadPlan, done: usize) -> String {
    let n = plan.windows.len();
    if done < n {
        format!("Reading part {} of {} of \"{}\"", done + 1, n, plan.file_name)
    } else {
        format!("Writing what it found in \"{}\"", plan.file_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(t0: i64, who: &str, text: &str) -> Turn {
        Turn { t0, t1: t0 + 100, who: who.into(), text: text.into() }
    }

    fn turns(n: usize) -> Vec<Turn> {
        (0..n).map(|i| turn(i as i64 * 100, "Dana", "a sentence of some length here")).collect()
    }

    /// THE property. `#minutes` once read the first five minutes of a recording
    /// and reported the whole thing as read, because of a clamp. Every turn
    /// must land in exactly one window, and the windows must cover the meeting
    /// end to end with no gap.
    #[test]
    fn every_turn_is_read_exactly_once() {
        for n in [1usize, 2, 7, 50, 501] {
            let all = turns(n);
            let windows = partition_turns(&all, 400);
            assert_eq!(windows.first().map(|w| w.0), Some(0), "n={n}");
            assert_eq!(windows.last().map(|w| w.1), Some(n), "n={n}");
            for pair in windows.windows(2) {
                assert_eq!(pair[0].1, pair[1].0, "a gap or an overlap at n={n}");
            }
            let covered: usize = windows.iter().map(|(a, b)| b - a).sum();
            assert_eq!(covered, n, "n={n}");
            assert!(windows.iter().all(|(a, b)| a < b), "an empty window at n={n}");
        }
    }

    /// A single turn longer than the whole budget still gets read. Coverage
    /// beats tidiness — the alternative is silently skipping it.
    #[test]
    fn one_enormous_turn_gets_its_own_window() {
        let all = vec![turn(0, "Dana", &"x".repeat(50_000)), turn(100, "Yossi", "ok")];
        let windows = partition_turns(&all, 12_000);
        assert_eq!(windows, [(0, 1), (1, 2)]);
    }

    /// The model answers with numbers, never times. A number that is not a turn
    /// in this recording is DROPPED — which is what makes a made-up moment
    /// impossible rather than merely unlikely.
    #[test]
    fn a_turn_number_that_does_not_exist_is_thrown_away() {
        let all = turns(3);
        let found = vec![ReadArtifact {
            chapters: vec![
                FoundChapter { turn: 1, title: "Real".into() },
                FoundChapter { turn: 99, title: "Invented".into() },
            ],
            notes: vec![
                FoundNote { turn: 2, kind: "decision".into(), text: "real".into(), who: None },
                FoundNote { turn: 900, kind: "decision".into(), text: "invented".into(), who: None },
            ],
            highlights: vec![FoundHighlight { turn: 42, until: 43 }],
            ..Default::default()
        }];
        let (chapters, highlights, notes) = merge_findings(&found, &all, &Default::default());
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].t0, 100);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].t0, 200);
        assert!(highlights.is_empty(), "a highlight was placed at a moment that does not exist");
    }

    /// An action item may only name somebody who actually spoke here. A model
    /// that invents a colleague must lose the name, not the note.
    #[test]
    fn an_action_cannot_be_pinned_on_someone_who_was_never_there() {
        let all = turns(2);
        let here: std::collections::HashSet<String> = ["Dana".to_string()].into_iter().collect();
        let found = vec![ReadArtifact {
            notes: vec![
                FoundNote {
                    turn: 0,
                    kind: "action".into(),
                    text: "send the notes".into(),
                    who: Some("Dana".into()),
                },
                FoundNote {
                    turn: 1,
                    kind: "action".into(),
                    text: "book the room".into(),
                    who: Some("Someone Invented".into()),
                },
            ],
            ..Default::default()
        }];
        let (_, _, notes) = merge_findings(&found, &all, &here);
        assert_eq!(notes.len(), 2, "the invented name cost us the note");
        assert_eq!(notes[0].who.as_deref(), Some("Dana"));
        assert_eq!(notes[1].who, None, "an action was attributed to a stranger");
    }

    /// Windows repeat themselves, and a chapter per turn is not a table of
    /// contents. Both are collapsed by ordinary code.
    #[test]
    fn repeats_and_crowding_are_collapsed() {
        let all = turns(200);
        let found = vec![ReadArtifact {
            chapters: vec![
                FoundChapter { turn: 0, title: "Opening".into() },
                FoundChapter { turn: 1, title: "Still opening".into() }, // 1 s later
                FoundChapter { turn: 100, title: "Budget".into() },
                FoundChapter { turn: 150, title: "  budget  ".into() }, // same words
            ],
            notes: vec![
                FoundNote { turn: 5, kind: "decision".into(), text: "Ship Thursday".into(), who: None },
                FoundNote { turn: 9, kind: "decision".into(), text: "ship   thursday".into(), who: None },
            ],
            highlights: vec![
                FoundHighlight { turn: 10, until: 12 },
                FoundHighlight { turn: 11, until: 14 }, // overlaps
                FoundHighlight { turn: 60, until: 60 },
            ],
            ..Default::default()
        }];
        let (chapters, highlights, notes) = merge_findings(&found, &all, &Default::default());
        assert_eq!(
            chapters.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            ["Opening", "Budget"]
        );
        assert_eq!(notes.len(), 1, "the same decision was written twice");
        assert_eq!(highlights.len(), 2, "overlapping marks did not merge");
        assert_eq!((highlights[0].t0, highlights[0].t1), (1000, 1500));
    }

    /// The "Read again" rule: a new pass replaces what the ROOM found and never
    /// touches what you wrote or corrected.
    #[test]
    fn reading_again_replaces_the_rooms_findings_and_keeps_yours() {
        let mine = RecNote {
            id: "mine".into(),
            t0: 50,
            kind: NoteKind::Point,
            text: "my own note".into(),
            who: None,
            by: By::You,
        };
        let mut meta = RecMeta {
            notes: vec![
                mine.clone(),
                RecNote { id: "theirs".into(), by: By::Room, ..mine.clone() },
            ],
            chapters: vec![
                RecChapter { id: "c1".into(), t0: 0, title: "mine".into(), by: By::You },
                RecChapter { id: "c2".into(), t0: 10, title: "theirs".into(), by: By::Room },
            ],
            ..Default::default()
        };
        install_findings(
            &mut meta,
            vec![RecChapter { id: "new".into(), t0: 500, title: "fresh".into(), by: By::Room }],
            Vec::new(),
            Vec::new(),
            ReadStamp { turns: 3, chars: 40 },
        );
        assert_eq!(
            meta.notes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            ["mine"],
            "a re-read either kept a stale finding or ate the user's note"
        );
        assert_eq!(
            meta.chapters.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["c1", "new"]
        );
        assert_eq!(meta.read_of, Some(ReadStamp { turns: 3, chars: 40 }));
    }

    /// The step DAG: windows in order, then one publish that waits for all of
    /// them — and no model-driven fold anywhere, which is the mistake
    /// `file_pass` records having made.
    #[test]
    fn the_plan_is_windows_then_one_publish() {
        let steps = build_read_steps(3, Lane::LocalLlm);
        assert_eq!(steps.len(), 4);
        assert_eq!(steps[2].depends_on, vec![1]);
        assert_eq!(steps[3].kind, "publish");
        assert_eq!(steps[3].lane, Lane::Cpu);
        assert_eq!(steps[3].depends_on, vec![0, 1, 2]);
        assert!(steps.iter().all(|s| s.kind == "map" || s.kind == "publish"));
    }
}
