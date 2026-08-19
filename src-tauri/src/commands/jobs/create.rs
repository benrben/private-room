//! The "create" job kind — the Create page's picture and video generation.
//!
//! One prompt, one model, one file in the room. Structurally a sibling of
//! `download`: a SINGLE atomic unit with no mid-work checkpoint, so a Stop or a
//! crash parks the job and resuming starts the generation over. `total` is 100
//! so the existing job card draws a percentage.
//!
//! Unlike a download, the work is billed. That shapes two decisions here:
//!
//!   * nothing is retried — a silent second attempt spends the user's money
//!     twice, so a failed generation stays failed and says why;
//!   * the model is checked against the live catalog BEFORE the call, because
//!     "this model cannot draw" is knowable for free and discovering it from a
//!     paid round trip is the expensive way to learn it.
//!
//! Each variation is its own call to the provider, so the bar advances per
//! finished picture rather than sitting at zero and then jumping to done.

use super::*;
use crate::commands::capabilities::{capabilities_for, Capability, Support};
use crate::commands::media_limits::limits_for;

/// What one generation may be asked to produce.
pub(crate) const CREATE_KIND_IMAGE: &str = "image";
pub(crate) const CREATE_KIND_VIDEO: &str = "video";

/// How often a submitted clip is asked whether it is done.
///
/// Five seconds against generations that run one to five minutes: often
/// enough that the bar is alive and a Stop lands promptly, rare enough that a
/// four-minute clip costs fifty status calls rather than a thousand.
const POLL_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// When to give up on a clip that never resolves.
///
/// The provider is still billing whether or not we are listening, so this is
/// not a cost control — it is a promise that a job cannot sit in Activity for
/// ever. Twenty minutes is well past the slowest model in the catalogue.
const VIDEO_CEILING: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// A picture on its way OUT of the room, ready to be attached to a call.
struct Attachment {
    b64: String,
    mime: String,
}

/// Read one room file as an attachment, refusing anything that is not a picture.
///
/// The refusal is the point. A model handed a PDF labelled as a frame does not
/// say so — it ignores it and returns a clip of something else, and the user
/// reads that as the model disobeying them rather than as a file they picked
/// by mistake.
fn attachment(conn: &rusqlite::Connection, file_id: &str) -> Result<Attachment, String> {
    let meta = db::get_file_meta(conn, file_id)?;
    if !meta.mime_type.starts_with("image/") {
        return Err(format!(
            "“{}” is not a picture, so it cannot be sent as one.",
            meta.name
        ));
    }
    let bytes = db::get_file_bytes(conn, file_id)?
        .ok_or_else(|| format!("“{}” has no content left in this room.", meta.name))?;
    Ok(Attachment {
        b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: meta.mime_type,
    })
}

/// How many variations one job may ask for. The bench offers 1/2/4; the cap is
/// here so a hand-built call (or the agent) cannot queue fifty paid generations
/// behind a single click.
pub(crate) const MAX_VARIATIONS: usize = 4;

/// A short honest job title — the first few words of the prompt, which is what
/// the user will recognize the card by.
fn create_title(prompt: &str, kind: &str) -> String {
    let words: Vec<&str> = prompt.split_whitespace().take(6).collect();
    let verb = if kind == CREATE_KIND_VIDEO { "Filming" } else { "Painting" };
    if words.is_empty() {
        return verb.to_string();
    }
    let short = words.join(" ");
    let ellipsis = if prompt.split_whitespace().count() > 6 { "…" } else { "" };
    format!("{verb} “{short}{ellipsis}”")
}

/// The filename a finished generation lands under. Kept free of the prompt's
/// own punctuation — a prompt is a sentence, and a sentence makes a poor
/// filename — but still recognizable in a file list.
fn artwork_name(prompt: &str, index: usize, total: usize, ext: &str) -> String {
    let stem: String = prompt
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .take(5)
        .collect::<Vec<_>>()
        .join(" ");
    let stem = if stem.is_empty() { "Generated".to_string() } else { stem };
    if total > 1 {
        format!("{stem} {}.{ext}", index + 1)
    } else {
        format!("{stem}.{ext}")
    }
}

/// Refuse a model the catalog does not vouch for, before any call is billed.
///
/// `Support::Unknown` is refused as firmly as `No`: it means the catalog said
/// nothing about output modalities, and "we do not know" is not a good enough
/// reason to spend the user's money finding out.
pub(crate) async fn check_can_generate(model: &str, kind: &str) -> Result<(), String> {
    let want = if kind == CREATE_KIND_VIDEO {
        Capability::VideoGeneration
    } else {
        Capability::ImageGeneration
    };
    let caps = capabilities_for(model).await;
    match caps.supports(want) {
        Support::Yes => Ok(()),
        Support::No => Err(format!(
            "{} cannot {} — it reads and writes text. Pick one of the models on \
             the Create page, which are the ones this room's providers list as \
             making pictures.",
            caps.label,
            want.phrase()
        )),
        Support::Unknown => Err(format!(
            "This room cannot tell whether {} can {}, so it will not spend a \
             call finding out. Reconnect the provider so its catalog loads, or \
             pick a model the Create page already lists.",
            caps.label,
            want.phrase()
        )),
    }
}

/// Everything one generation needs, and the job's stored plan verbatim.
///
/// A struct rather than loose arguments because the plan is written on submit
/// and read back on resume: two hand-rolled shapes drift, and a field the
/// resume path forgets to read is silently lost — a clip that was to be made
/// from the user's picture quietly becoming one made from words.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct CreatePlan {
    pub prompt: String,
    pub model: String,
    pub kind: String,
    pub variations: usize,
    /// Clip length. Validated against the model's own published list before
    /// anything is billed.
    pub seconds: Option<u32>,
    pub resolution: String,
    pub aspect_ratio: String,
    /// Room files attached as guiding pictures — a hero, a place, a look.
    /// These are what hold a character's face together across shots.
    pub reference_file_ids: Vec<String>,
    /// A room file pinned as the clip's FIRST FRAME. Different in kind from a
    /// reference: the clip literally begins on this picture.
    pub frame_file_id: Option<String>,
    /// A room file pinned as the clip's LAST frame.
    ///
    /// This is what makes an episode possible. No model will make more than
    /// 20 seconds, so five minutes is twenty clips — and twenty clips that
    /// merely follow each other in a list are twenty unrelated clips. Ending
    /// shot N on exactly the picture shot N+1 begins on makes the join exact
    /// rather than approximate: the same frame closes one and opens the next.
    /// Twelve of the 21 video models accept this slot.
    pub last_frame_file_id: Option<String>,
    /// Continuous mode: when THIS clip finishes, capture the frame it really
    /// ends on and hand it to the next shot's queued job as its first frame.
    ///
    /// This is the second half of the join, and the half that makes it true.
    /// `last_frame_file_id` above asks the model to END somewhere — and models
    /// treat that as a target to drift toward, not a guarantee, which is why
    /// "scene 2 does not start where scene 1 ended" was reported against a
    /// chain that looked correct on paper. The captured frame is not a target;
    /// it is the first frame of the next clip, by construction.
    pub chained: bool,
    /// The user was shown these pictures and pressed a button saying they
    /// would be sent. Only this opens the privacy door — see `videogen.guard`.
    pub references_ack: bool,
    /// The shot this generation belongs to, when it was started from a list,
    /// so the result files can be recorded against it.
    pub shot_id: Option<String>,
}

impl CreatePlan {
    fn is_video(&self) -> bool {
        self.kind == CREATE_KIND_VIDEO
    }
}

/// Create + submit a generation job.
///
/// `bulk` waives the queue-depth cap. See `start_shot_list_job` for the whole
/// argument; briefly, the cap exists to stop a runaway *scheduler* piling up
/// unbounded work, and a shot list is neither runaway nor unbounded — it is a
/// counted set the user read on a review sheet and pressed a button naming.
pub(crate) async fn start_create_job_inner(
    window: &tauri::Window,
    state: &AppState,
    plan: CreatePlan,
) -> Result<String, String> {
    start_create_job_bulk(window, state, plan, false).await
}

async fn start_create_job_bulk(
    window: &tauri::Window,
    state: &AppState,
    mut plan: CreatePlan,
    bulk: bool,
) -> Result<String, String> {
    if !matches!(plan.kind.as_str(), CREATE_KIND_IMAGE | CREATE_KIND_VIDEO) {
        return Err("Unknown thing to make.".into());
    }
    plan.prompt = plan.prompt.trim().to_string();
    // A clip may legitimately be made from a picture alone — several models
    // animate a still with no words at all, and the API marks `prompt`
    // optional for exactly that. A still cannot: there is nothing to draw.
    if plan.prompt.is_empty() && !(plan.is_video() && plan.frame_file_id.is_some()) {
        return Err("Say what to make first.".into());
    }
    plan.variations = plan.variations.clamp(1, MAX_VARIATIONS);

    // Every generation model in the catalog today is a trip off this Mac, so
    // the room's own internet switch decides before anything is queued —
    // rather than a job whose only possible outcome is a reach the switch
    // forbids. (`speech_cmds.rs` documents the seam that once missed this.)
    crate::commands::require_web_access(state)?;
    check_can_generate(&plan.model, &plan.kind).await?;
    check_media_shape(&mut plan)?;

    let plan_json = serde_json::to_value(&plan).map_err(|e| e.to_string())?;
    let title = create_title(&plan.prompt, &plan.kind);
    let (job_id, room_path) = state.with_room(|room| {
        if !bulk && queue::at_capacity(&room.conn) {
            return Err(queue::QUEUE_FULL.into());
        }
        let id = db::create_job(&room.conn, "create", &title, &plan_json, 100)?;
        Ok((id, room.path.clone()))
    })?;
    if queue::try_reserve(state, &job_id) {
        let cancel = Arc::new(AtomicBool::new(false));
        state.job_cancels.lock().unwrap().insert(job_id.clone(), cancel.clone());
        spawn_create(window.clone(), job_id.clone(), room_path, plan, cancel);
    }
    Ok(job_id)
}

/// Check what the model itself says it will accept, before anything is billed.
///
/// An illegal duration does not produce a shorter clip — it produces a refusal
/// after the user has waited, and on the models with a per-generation floor
/// (Runway Aleph 2 charges 56 cents however short the clip) it can produce a
/// charge for nothing. The limits are free to read, so a guess is never worth
/// making. An unpublished list is treated as "the provider declined to say",
/// which means send nothing and let its own default stand — refusing a legal
/// request on the strength of a table we never received would be worse.
fn check_media_shape(plan: &mut CreatePlan) -> Result<(), String> {
    let slug = plan.model.split("::").nth(1).unwrap_or(&plan.model).to_string();
    let limits = limits_for(&slug);

    // HOW MANY FACES THIS MODEL WILL TAKE. Published as `input_references.max`
    // and, until now, consulted only by the bench's attach button — so a shot
    // list handed four cast portraits to a model that publishes two, showed all
    // four on the review sheet as "looks like" evidence, and collected a
    // provider refusal per shot. Dropped rather than refused, like resolution
    // and aspect ratio: a picture with two of the four faces guided is the
    // picture that was asked for, drawn with less help.
    cap_references(&mut plan.reference_file_ids, limits.as_ref().and_then(|l| l.max_references));

    if !plan.is_video() {
        // Stills take no length, and a stray one would be sent to an endpoint
        // that has no such parameter.
        plan.seconds = None;
        // Size and shape are checked for stills too. They were not, and the
        // reason is worth remembering: the two fields were being sent to an
        // endpoint that quietly ignored them, so nothing ever complained and
        // the page appeared to work. A control that is dropped in silence is
        // indistinguishable from a model that ignores you.
        if let Some(limits) = limits {
            drop_unpublished(&mut plan.resolution, &limits.resolutions);
            drop_unpublished(&mut plan.aspect_ratio, &limits.aspect_ratios);
        }
        return Ok(());
    }
    let Some(limits) = limits else {
        return Ok(());
    };

    // An EMPTY frame list is a published answer, not a missing one: every
    // video model that accepts a starting picture lists its slots, and the two
    // that do not (Runway Aleph 2, Sora 2 Pro) publish
    // `supported_frame_images: null`. So an entry with no slots means no —
    // and sending a frame anyway would be paying for a clip that ignores it.
    // Mirrors `takesFirstFrame` in the UI; the two must not disagree.
    // A last frame the model will not take is DROPPED rather than refused.
    // It is an enhancement to a clip that works perfectly well without it —
    // refusing the whole generation over it would turn "your episode joins
    // less neatly on this model" into "your episode does not get made".
    if plan.last_frame_file_id.is_some()
        && !limits.frame_images.iter().any(|f| f == "last_frame")
    {
        plan.last_frame_file_id = None;
    }
    if plan.frame_file_id.is_some() && !limits.takes_first_frame() {
        return Err(format!(
            "{slug} cannot start from a picture — it makes a clip from words \
             alone. Pick a model that takes a first frame, or clear the picture."
        ));
    }
    if let Some(seconds) = plan.seconds {
        if !limits.allows_seconds(seconds) {
            let legal: Vec<String> = limits.durations.iter().map(|d| d.to_string()).collect();
            return Err(format!(
                "{slug} does not make {seconds}-second clips. It takes {}.",
                legal.join(", ")
            ));
        }
    } else {
        // The cheapest legal length, rather than letting the provider pick —
        // several default to their longest, which is also their dearest.
        plan.seconds = limits.default_seconds();
    }
    drop_unpublished(&mut plan.resolution, &limits.resolutions);
    drop_unpublished(&mut plan.aspect_ratio, &limits.aspect_ratios);
    Ok(())
}

/// Keep only as many guiding pictures as the model says it will look at.
///
/// An unpublished ceiling (`None`) is the provider declining to say, and every
/// other reader here treats that as "send what was asked for" — inventing a cap
/// would drop a face the model would happily have taken.
fn cap_references(ids: &mut Vec<String>, max: Option<u32>) {
    if let Some(max) = max {
        ids.truncate(max as usize);
    }
}

/// Clear a size or shape this model does not publish.
///
/// Dropped rather than refused, unlike an illegal duration. The difference is
/// what each one costs to get wrong: a clip made at the model's own default
/// size is the clip the user asked for, in the wrong size; a clip made at an
/// illegal DURATION is a 400 and, on the models billed with a floor, a charge
/// for nothing. An empty published list means the provider declined to say,
/// so whatever was asked for is passed through untouched.
fn drop_unpublished(value: &mut String, published: &[String]) {
    if !value.is_empty() && !published.is_empty() && !published.iter().any(|p| p == value) {
        value.clear();
    }
}

/// Queue-pump entry: rebuild a create job from its plan and spawn the runner.
pub(crate) fn start_create_row(
    window: &tauri::Window,
    _state: &AppState,
    job: &db::Job,
    room_path: &str,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    // One deserialize of the whole plan, so a field cannot be read on submit
    // and forgotten on resume. Older rows predate several of these fields;
    // `#[serde(default)]` on the struct is what lets them still run.
    let mut plan: CreatePlan =
        serde_json::from_value(job.plan.clone()).map_err(|_| "This job's plan is unreadable.")?;
    if plan.model.trim().is_empty() {
        return Err("This job's plan is unreadable.".into());
    }
    if plan.kind.is_empty() {
        plan.kind = CREATE_KIND_IMAGE.into();
    }
    plan.variations = plan.variations.clamp(1, MAX_VARIATIONS);
    spawn_create(
        window.clone(),
        job.id.clone(),
        room_path.to_string(),
        plan,
        cancel,
    );
    Ok(())
}

/// The runner: generate, file each result, report truthfully, free the slot.
fn spawn_create(
    window: tauri::Window,
    job_id: String,
    room_path: String,
    plan: CreatePlan,
    cancel: Arc<AtomicBool>,
) {
    use tauri::Manager;
    let app = window.app_handle().clone();
    let (runner_window, runner_job, runner_room) =
        (window.clone(), job_id.clone(), room_path.clone());
    super::spawn_job_runner(runner_window, runner_job, runner_room, async move {
        let state = app.state::<AppState>();
        let kind = plan.kind.clone();
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let _ = db::set_job_status(&r.conn, &job_id, "running", None);
            }
        }
        emit_progress(&window, &job_id, opening_label(&kind), 0, 100);

        // Ok(files) = made; Err(None) = paused (Stop); Err(Some(e)) = error.
        //
        // A CHAIN WAIT maps to paused-with-a-reason. It is not an error —
        // nothing failed — and it is not billed; the job simply may not run
        // yet, because its opening frame is the end of a clip that does not
        // exist. It un-pauses ITSELF when that clip lands (see the completion
        // hook), so the pause is a promise deferred, not abandoned.
        let mut chain_wait: Option<String> = None;
        let outcome: Result<CreateRun, Option<String>> = {
            let run = run_create(&state, &window, &job_id, &room_path, &plan, &cancel).await;
            match run {
                Ok(made) => Ok(made),
                Err(RunStop::ChainWait(reason)) => {
                    chain_wait = Some(reason);
                    Err(None)
                }
                Err(_) if cancel.load(Ordering::SeqCst) => Err(None),
                Err(RunStop::Failed(e)) => Err(Some(e)),
            }
        };

        // How many others were abandoned because this failure will repeat for
        // them too. Read out of the lock so the message below can say it.
        let mut also_stopped = 0usize;
        // How many chain-parked shots were let go because this clip will never
        // exist for them to open on. Read out of the lock for the same reason.
        let mut released = 0usize;
        {
            let guard = state.room.lock().unwrap();
            if let Some(r) = guard.as_ref().filter(|r| r.path == room_path) {
                let (status, err) = match &outcome {
                    // A partial run is FINISHED — the files it made are real —
                    // and it still records why the rest are missing. History
                    // already reads `error` on a done row as "not all of it
                    // went through" (`allSucceeded` in AiPane.tsx).
                    Ok(run) => ("done", run.partial.as_deref()),
                    Err(None) => ("paused", None),
                    Err(Some(e)) => ("error", Some(e.as_str())),
                };
                let _ = db::set_job_status(&r.conn, &job_id, status, err);
                // The reason this pause is not the user's Stop: it names the
                // clip it waits for, and marks the row for the automatic
                // un-pause when that clip lands.
                if let Some(reason) = &chain_wait {
                    let _ = db::set_parked_reason(&r.conn, &job_id, reason);
                }
                // A twenty-one-part episode against an account with no credit
                // left is twenty-one identical failures, each one a wait and a
                // red card. The first answer already settled it for all of
                // them, so the rest are stopped with that same reason rather
                // than queued up to rediscover it one at a time.
                if let Err(Some(e)) = &outcome {
                    also_stopped = abandon_doomed_queue(&r.conn, e, &plan.model);
                    // This clip will not exist, so the shot after it is waiting
                    // for nothing. Whatever `abandon_doomed_queue` did not
                    // already settle is put back in the queue to open on its
                    // drawn still — the answer `decide_chain` gives once a
                    // predecessor has neither a clip nor a live job.
                    released = release_chain_waiters(&r.conn);
                }
            }
        }
        state.job_cancels.lock().unwrap().remove(&job_id);

        use tauri::Emitter;
        // The join is what a chain-parked shot was waiting for, and it is what
        // it loses when this clip fails — said on the card rather than left for
        // the finished video to reveal.
        let released_note = if released > 0 {
            format!(
                " {released} shot(s) waiting on this clip start on their own \
                 picture instead."
            )
        } else {
            String::new()
        };
        let payload = match outcome {
            Ok(run) => {
                let noun = made_noun(&kind, run.made.len());
                // The count alone would be a green card for a run that lost
                // half of what was asked for, in the provider's own words —
                // which are the only thing that says whether trying again is
                // worth paying for.
                let label = match &run.partial {
                    Some(why) => format!("{noun} ready — the rest could not be made: {why}"),
                    None => format!("{noun} ready in this room"),
                };
                serde_json::json!({
                    "jobId": job_id,
                    "label": label,
                    "done": 100, "total": 100, "finished": true,
                    // The FIRST file, so the terminal event opens one picture
                    // rather than four fighting over the viewer.
                    "fileId": run.made.first().map(|f| f.id.clone()),
                })
            }
            Err(None) => serde_json::json!({
                "jobId": job_id,
                "label": chain_wait.as_deref().unwrap_or("Paused"),
                "done": 0, "total": 100, "paused": true,
            }),
            Err(Some(e)) => serde_json::json!({
                "jobId": job_id,
                "label": if also_stopped > 0 {
                    format!(
                        "Nothing was made — {e}. The other {also_stopped} waiting \
                         were stopped too, for the same reason.{released_note}"
                    )
                } else {
                    format!("Nothing was made — {e}{released_note}")
                },
                "done": 0, "total": 100, "failed": true,
            }),
        };
        let _ = window.emit("job-progress", payload);
        let _ = window.emit("room-files-changed", ());
        queue::finish_and_pump(&app, &window, &job_id).await;
    });
}

/// Which failures have already been settled for every other waiting job.
///
/// Two different scopes, and conflating them would be wrong in an expensive
/// direction. An empty balance or a missing key is an ACCOUNT fact: nothing
/// queued can succeed, so everything queued stops. "No endpoint found" is a
/// MODEL fact — the provider does not serve that slug on the media endpoints —
/// so it stops only the jobs pointing at the same model, and a list that mixes
/// models keeps making the parts that can still be made.
///
/// Everything else is left alone. A refusal, a timeout, a bad frame: those are
/// about one generation, and cancelling nineteen good ones over a single
/// unlucky call would be its own kind of damage.
enum Doomed {
    /// Nothing queued can succeed.
    Everything,
    /// Only the jobs using this model.
    ThisModel,
    /// This one call's problem. Leave the queue alone.
    JustThisOne,
}

fn doomed_scope(error: &str) -> Doomed {
    let e = error.to_lowercase();
    if e.contains("insufficient credits")
        || e.contains("no api key is connected")
        || e.contains("add one in settings")
        || e.contains("quota")
    {
        return Doomed::Everything;
    }
    if e.contains("no endpoint found") {
        return Doomed::ThisModel;
    }
    Doomed::JustThisOne
}

/// Stop the queued generations this failure has already answered for.
/// Returns how many were stopped, so the message can say so.
fn abandon_doomed_queue(conn: &rusqlite::Connection, error: &str, model: &str) -> usize {
    let scope = match doomed_scope(error) {
        Doomed::JustThisOne => return 0,
        other => other,
    };
    let Ok(jobs) = db::unfinished_jobs(conn) else {
        return 0;
    };
    let reason = format!("{error} — stopped without being sent, after the one before it failed the same way");
    let mut stopped = 0usize;
    // Chain-parked rows count as waiting. They are not queued — they are
    // holding for a clip — but the answer this failure gave settles them
    // exactly as it settles the queue, and leaving them parked would leave a
    // card promising an automatic start that can no longer come.
    for job in jobs
        .iter()
        .filter(|j| j.kind == "create" && (j.status == "queued" || is_chain_parked(j)))
    {
        if matches!(scope, Doomed::ThisModel) {
            // Only the ones pointing at the same model. An unreadable plan is
            // left alone rather than guessed at.
            let same = serde_json::from_value::<CreatePlan>(job.plan.clone())
                .map(|p| p.model == model)
                .unwrap_or(false);
            if !same {
                continue;
            }
        }
        if db::set_job_status(conn, &job.id, "error", Some(&reason)).is_ok() {
            stopped += 1;
        }
    }
    stopped
}

fn opening_label(kind: &str) -> &'static str {
    if kind == CREATE_KIND_VIDEO {
        "Filming…"
    } else {
        "Painting…"
    }
}

fn made_noun(kind: &str, count: usize) -> String {
    let one = if kind == CREATE_KIND_VIDEO { "clip" } else { "picture" };
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {one}s")
    }
}

/// Run every variation, filing each as it lands.
///
/// A partial result is kept, not discarded: if the third of four calls fails,
/// the two already paid for are in the room and the job says so. Throwing them
/// away would mean charging the user for pictures they never received.
async fn run_create(
    state: &State<'_, AppState>,
    window: &tauri::Window,
    job_id: &str,
    room_path: &str,
    plan: &CreatePlan,
    cancel: &Arc<AtomicBool>,
) -> Result<CreateRun, RunStop> {
    let mut made: Vec<FileMeta> = Vec::new();
    let mut last_error: Option<String> = None;

    // Every attached picture is read ONCE, before the first call — not per
    // variation, and not inside the loop where a room lock would be taken
    // while a network call is in flight.
    let (frame, tail, references) = {
        let guard = state.room.lock().unwrap();
        let room = guard
            .as_ref()
            .filter(|r| r.path == room_path)
            .ok_or("The room was closed before this generation could start.")?;
        let frame = match plan.frame_file_id.as_deref() {
            Some(id) => Some(attachment(&room.conn, id)?),
            None => None,
        };
        let tail = match plan.last_frame_file_id.as_deref() {
            Some(id) => Some(attachment(&room.conn, id)?),
            None => None,
        };
        let mut references = Vec::new();
        for id in &plan.reference_file_ids {
            references.push(attachment(&room.conn, id)?);
        }
        (frame, tail, references)
    };

    // THE JOIN, decided at the only moment it can be decided honestly: when
    // this clip is about to start. Everything before this point — plan time,
    // queue time, the review sheet — is a forecast; between then and now the
    // predecessor may have finished, failed, been stopped, or been re-ordered
    // past us by a pause. Looking left at start time is self-healing across
    // every one of those paths, and needs no plan rewriting at all.
    let mut frame = frame;
    if plan.is_video() && plan.chained {
        if let Some(shot_id) = plan.shot_id.as_deref() {
            match chain_gate(state, room_path, shot_id, &plan.model) {
                ChainGate::Proceed => {}
                ChainGate::Wait(reason) => return Err(RunStop::ChainWait(reason)),
                ChainGate::CaptureFrom(clip_id) => {
                    emit_progress(window, job_id, "Reading the end of the previous clip…", 0, 100);
                    match opening_from_prev_clip(state, room_path, &clip_id, &plan.prompt).await
                    {
                        Some(opening) => frame = Some(opening),
                        None => {
                            // The one honest degradation: the previous clip's
                            // container could not be read (a WebM, say). Said
                            // on the bar rather than only to stderr — the cut
                            // will be approximate and the user should know
                            // which one and why.
                            emit_progress(
                                window,
                                job_id,
                                "Could not read the previous clip's end — starting from the drawn picture instead",
                                0,
                                100,
                            );
                        }
                    }
                }
            }
        }
    }
    let frame = frame;

    let variations = plan.variations.max(1);
    for index in 0..variations {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let done = (index * 100) / variations;
        let step = if variations > 1 {
            format!(
                "{} {} of {variations}…",
                opening_label(&plan.kind).trim_end_matches('…'),
                index + 1
            )
        } else {
            opening_label(&plan.kind).to_string()
        };
        emit_progress(window, job_id, &step, done, 100);

        let outcome = if plan.is_video() {
            run_one_video(
                window,
                job_id,
                plan,
                frame.as_ref(),
                tail.as_ref(),
                &references,
                cancel,
                done,
            )
            .await
        } else {
            run_one_image(plan, &references).await
        };
        let reply = match outcome {
            Ok(value) => value,
            Err(e) => {
                last_error = Some(e);
                break;
            }
        };

        let artwork = reply.get("artwork_b64").and_then(|v| v.as_str()).unwrap_or_default();
        let mime = reply.get("mime").and_then(|v| v.as_str()).unwrap_or("image/png");
        let ext = reply.get("ext").and_then(|v| v.as_str()).unwrap_or("png");
        if artwork.is_empty() {
            last_error = Some("the model returned nothing to save".into());
            break;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(artwork.as_bytes())
            .map_err(|e| format!("the generated file could not be read: {e}"))?;

        // The last gate before a write: a Stop during the round trip must not
        // still land a file in the room.
        crate::cancel::guard_commit(cancel, "this generation")?;

        let name = artwork_name(&plan.prompt, index, variations, ext);
        // The prompt is stored as the file's own text so the room can search
        // for a picture by what was asked for, not just by its filename.
        let narration = reply.get("text").and_then(|v| v.as_str()).unwrap_or_default();
        let described = if narration.is_empty() {
            plan.prompt.clone()
        } else {
            format!("{}\n\n{narration}", plan.prompt)
        };

        let meta = {
            let guard = state.room.lock().unwrap();
            let room = guard
                .as_ref()
                .filter(|r| r.path == room_path)
                .ok_or("The room was closed before the picture could be saved.")?;
            let meta =
                db::insert_file(&room.conn, &name, mime, &bytes, Some(&described), "generated")?;
            // Section-only: a finished picture or clip belongs to Creations, and
            // reaches Home when the person who made it chooses "Add to Library".
            // It is the same room file either way — this only decides which
            // lists show it.
            db::mark_section_only(&room.conn, &meta.id, "create");
            // Record it against the shot it belongs to, so the list shows the
            // frame and the clip beside the line that asked for them. Only the
            // FIRST variation is filed: a shot has one still and one clip, and
            // silently overwriting with the fourth would discard the choice.
            if let (Some(shot), 0) = (plan.shot_id.as_deref(), index) {
                let (still, clip) = if plan.is_video() {
                    (None, Some(meta.id.as_str()))
                } else {
                    (Some(meta.id.as_str()), None)
                };
                let _ = db::set_shot_result(&room.conn, shot, still, clip);
            }
            meta
        };
        made.push(meta);
        let _ = window.emit_to_all_windows_room_changed();

        // This clip exists now, so a successor that parked itself waiting
        // for it may run. Wake it — it captures this clip's end frame itself,
        // at its own start, from the file just written.
        if plan.chained && plan.is_video() && index == 0 {
            if let Some(shot_id) = plan.shot_id.as_deref() {
                wake_chain_waiter(state, room_path, shot_id);
            }
        }
    }

    if made.is_empty() {
        return Err(RunStop::Failed(
            last_error.unwrap_or_else(|| "nothing came back".into()),
        ));
    }
    // Some landed and some did not. `last_error` travels with them: a run that
    // kept two of four pictures and dropped the provider's reason for the other
    // two reports as a plain success, and the user is left comparing a count
    // they never see against a number they asked for.
    Ok(CreateRun { made, partial: last_error })
}

/// What one create job produced, and — when it made SOME of what was asked
/// for — what stopped it short. A Stop is not a shortfall: the loop breaks on
/// `cancel` without recording a reason, so `partial` stays empty there.
struct CreateRun {
    made: Vec<FileMeta>,
    partial: Option<String>,
}

/// One still, through the dedicated images endpoint.
async fn run_one_image(
    plan: &CreatePlan,
    references: &[Attachment],
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        // `sidecar_json` reads this field to attach the room's privacy
        // policy AND to mint the provider key from Keychain. A body
        // without it would be an un-modelled outbound seam.
        "model": plan.model,
        "prompt": plan.prompt,
        "kind": plan.kind,
        "reference_b64": references.iter().map(|a| &a.b64).collect::<Vec<_>>(),
        "reference_mime": references.iter().map(|a| &a.mime).collect::<Vec<_>>(),
        "references_ack": plan.references_ack,
        "aspect_ratio": plan.aspect_ratio,
        "resolution": plan.resolution,
    });
    crate::sidecar::sidecar_json("/image_generate", &body)
        .await
        .map_err(|e| e.error)
}

/// One clip: submit, wait, download.
///
/// The three calls are the whole reason this is not shaped like the image
/// path. A clip takes minutes, so the provider hands back a job id rather than
/// a video and expects to be asked. Polling from here — rather than blocking
/// inside the sidecar — is what makes Stop real and keeps the bar moving on
/// work the user is being charged for.
#[allow(clippy::too_many_arguments)]
async fn run_one_video(
    window: &tauri::Window,
    job_id: &str,
    plan: &CreatePlan,
    frame: Option<&Attachment>,
    tail: Option<&Attachment>,
    references: &[Attachment],
    cancel: &Arc<AtomicBool>,
    base_done: usize,
) -> Result<serde_json::Value, String> {
    // Both ends of the clip, when both are pinned. This is what joins one
    // shot to the next: shot N ends on exactly the picture shot N+1 opens on.
    let mut frames: Vec<serde_json::Value> = Vec::new();
    if let Some(a) = frame {
        frames.push(serde_json::json!({
            "b64": a.b64, "mime": a.mime, "frame_type": "first_frame"
        }));
    }
    if let Some(a) = tail {
        frames.push(serde_json::json!({
            "b64": a.b64, "mime": a.mime, "frame_type": "last_frame"
        }));
    }
    let body = serde_json::json!({
        "model": plan.model,
        "prompt": plan.prompt,
        "seconds": plan.seconds,
        "resolution": plan.resolution,
        "aspect_ratio": plan.aspect_ratio,
        "frames": frames,
        "references": references
            .iter()
            .map(|a| serde_json::json!({"b64": a.b64, "mime": a.mime}))
            .collect::<Vec<_>>(),
        "references_ack": plan.references_ack,
    });
    let started = crate::sidecar::sidecar_json("/video_start", &body)
        .await
        .map_err(|e| e.error)?;
    let video_id = started
        .get("video_id")
        .and_then(|v| v.as_str())
        .ok_or("the provider accepted the job but named no id for it")?
        .to_string();

    let job_body = serde_json::json!({"model": plan.model, "video_id": video_id});
    let deadline = std::time::Instant::now() + VIDEO_CEILING;
    loop {
        // Checked before the sleep as well as after, so a Stop pressed during
        // the round trip is honoured within one poll rather than one call.
        if cancel.load(Ordering::SeqCst) {
            return Err("stopped".into());
        }
        tokio::time::sleep(POLL_EVERY).await;
        if cancel.load(Ordering::SeqCst) {
            return Err("stopped".into());
        }
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "the clip was still not ready after {} minutes. The provider may \
                 still finish it — this room stopped waiting.",
                VIDEO_CEILING.as_secs() / 60
            ));
        }

        let state = crate::sidecar::sidecar_json("/video_status", &job_body)
            .await
            .map_err(|e| e.error)?;
        if state.get("failed").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Err(state
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("the provider could not make this clip")
                .to_string());
        }
        // The provider's own percentage when it publishes one, otherwise just
        // the status word — never a number this room made up, which would
        // crawl toward 99% and stay there.
        let label = match state.get("progress").and_then(|v| v.as_u64()) {
            Some(pct) => format!("Filming… {pct}%"),
            None => match state.get("status").and_then(|v| v.as_str()) {
                Some("in_progress") | Some("processing") | Some("running") => {
                    "Filming…".to_string()
                }
                Some(other) => format!("Filming… ({other})"),
                None => "Filming…".to_string(),
            },
        };
        emit_progress(window, job_id, &label, base_done, 100);

        if state.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
            break;
        }
    }

    emit_progress(window, job_id, "Downloading the clip…", base_done, 100);
    crate::sidecar::sidecar_json_timeout(
        "/video_fetch",
        &job_body,
        // A finished clip can be tens of megabytes; the shared sidecar timeout
        // is sized for a chat turn.
        std::time::Duration::from_secs(600),
    )
    .await
    .map_err(|e| e.error)
}

/// A tiny extension so the runner can announce new files without dragging the
/// whole `Emitter` import into every call site.
trait RoomChanged {
    fn emit_to_all_windows_room_changed(&self);
}
impl RoomChanged for tauri::Window {
    fn emit_to_all_windows_room_changed(&self) {
        use tauri::Emitter;
        let _ = self.emit("room-files-changed", ());
    }
}

/// Why a run stopped without making everything it was asked for.
enum RunStop {
    /// A real failure, in the provider's own words where possible.
    Failed(String),
    /// Not failure and not Stop: this clip may not START yet, because it is
    /// chained to a predecessor whose clip does not exist. The job parks
    /// itself with this reason and is re-queued automatically when the
    /// predecessor's clip lands.
    ChainWait(String),
}

impl From<String> for RunStop {
    fn from(e: String) -> Self {
        RunStop::Failed(e)
    }
}

impl From<&str> for RunStop {
    fn from(e: &str) -> Self {
        RunStop::Failed(e.to_string())
    }
}

/// The pause reason a chain-waiting job carries. Also the marker the
/// completion hook looks for when deciding what to wake — matched on the
/// PREFIX, so the tail can name the actual shot.
const CHAIN_WAIT_REASON: &str = "Waiting for the shot before it";

/// What a chained clip may do right now, given its predecessor's state.
enum ChainGate {
    /// No predecessor, or the predecessor will never film — open on the
    /// drawn still, exactly as an unchained clip would.
    Proceed,
    /// The predecessor's clip exists: capture its real final frame and open
    /// on that.
    CaptureFrom(String),
    /// The predecessor is queued/paused/running: filming now would spend
    /// money on a join that can no longer be made. Park until it lands.
    Wait(String),
}

/// The gate decision, pure so the ordering rules are testable without a room:
/// `prev` is (clip_file_id, video_model, has_unfinished_create_job).
fn decide_chain(prev: Option<(&Option<String>, &str, bool)>) -> ChainGate {
    match prev {
        // The first shot of a list waits for nobody.
        None => ChainGate::Proceed,
        Some((Some(clip), _, _)) => ChainGate::CaptureFrom(clip.clone()),
        // No clip yet, but a job for it is still alive — queued behind us
        // after a Stop re-ordered things, paused by a lock, or running right
        // now. THE BUG THIS CLOSES: the pump skips paused rows, so after a
        // Stop on clip N the queue happily started clip N+1 first, billed it,
        // and the join was silently lost. Waiting is the only honest move.
        Some((None, model, true)) if !model.trim().is_empty() => {
            ChainGate::Wait(format!(
                "{CHAIN_WAIT_REASON} — its clip must land first so this one can \
                 start on its final frame. It starts by itself when that clip \
                 is ready."
            ))
        }
        // No clip and no live job: the predecessor was never filmed, errored,
        // or has no model. Nothing to wait for — an approximate opening is
        // better than a clip that never gets made.
        Some((None, _, _)) => ChainGate::Proceed,
    }
}

/// Ask the room what this shot's predecessor is up to.
///
/// `model` is THIS clip's model: a model that takes no first frame cannot
/// receive a captured one, so for it the gate always answers Proceed —
/// capturing would be wasted work, and waiting would be waiting for a frame
/// it cannot use.
fn chain_gate(state: &AppState, room_path: &str, shot_id: &str, model: &str) -> ChainGate {
    let slug = model.split("::").nth(1).unwrap_or(model);
    if let Some(limits) = limits_for(slug) {
        if !limits.takes_first_frame() {
            return ChainGate::Proceed;
        }
    }
    let guard = state.room.lock().unwrap();
    let Some(room) = guard.as_ref().filter(|r| r.path == room_path) else {
        return ChainGate::Proceed;
    };
    let Ok(Some(prev)) = db::prev_shot(&room.conn, shot_id) else {
        return ChainGate::Proceed;
    };
    let busy = prev.clip_file_id.is_none() && filming_job_exists(&room.conn, &prev.id);
    decide_chain(Some((&prev.clip_file_id, &prev.video_model, busy)))
}

/// Is a clip for this shot still coming?
///
/// Only a VIDEO job counts. An image job (its still being drawn) never produces
/// the clip whose end frame a successor needs, and waking happens only on clip
/// completion — waiting on one would park a shot with nothing coming to wake
/// it. One reader for both sides of the promise: the gate that parks a job, and
/// the release that lets it go when the predecessor stops being a prospect.
fn filming_job_exists(conn: &rusqlite::Connection, shot_id: &str) -> bool {
    db::unfinished_jobs(conn)
        .ok()
        .into_iter()
        .flatten()
        .filter(|j| j.kind == "create")
        .any(|j| {
            serde_json::from_value::<CreatePlan>(j.plan.clone())
                .ok()
                .filter(|p| p.kind == CREATE_KIND_VIDEO)
                .and_then(|p| p.shot_id)
                .as_deref()
                == Some(shot_id)
        })
}

/// A job parked by `ChainGate::Wait`, and not by the user's own Stop. Matched
/// on the reason's PREFIX, exactly as `wake_chain_waiter` does — a pause the
/// user asked for must never be resumed or cancelled behind their back.
fn is_chain_parked(job: &db::Job) -> bool {
    job.kind == "create"
        && job.status == "paused"
        && job
            .parked_reason
            .as_deref()
            .is_some_and(|r| r.starts_with(CHAIN_WAIT_REASON))
}

/// Let go the chain-parked jobs whose predecessor will never film.
///
/// `wake_chain_waiter` is the promise kept: the clip landed, so the waiter may
/// open on it. This is the promise that CANNOT be kept — the shot before it
/// errored, or was abandoned with the queue — where nothing is coming to wake
/// the waiter and its card goes on saying "It starts by itself when that clip
/// is ready". Re-queued rather than rewritten, because that is the answer the
/// gate itself now gives: no clip and no live job means proceed on the drawn
/// still. Returns how many were let go.
fn release_chain_waiters(conn: &rusqlite::Connection) -> usize {
    let Ok(jobs) = db::unfinished_jobs(conn) else {
        return 0;
    };
    let mut freed = 0usize;
    for job in jobs.iter().filter(|j| is_chain_parked(j)) {
        let shot_id = serde_json::from_value::<CreatePlan>(job.plan.clone())
            .ok()
            .and_then(|p| p.shot_id);
        let Some(shot_id) = shot_id else { continue };
        let Ok(Some(prev)) = db::prev_shot(conn, &shot_id) else { continue };
        // A predecessor that HAS its clip is `wake_chain_waiter`'s business,
        // and one still queued or running is a wait that is still honest.
        if prev.clip_file_id.is_some() || filming_job_exists(conn, &prev.id) {
            continue;
        }
        if db::set_job_status(conn, &job.id, "queued", None).is_ok() {
            freed += 1;
        }
    }
    freed
}

/// Capture the predecessor clip's real final frame, file it in the room, and
/// hand back the attachment the video call should open on.
///
/// `None` degrades to the drawn still — an approximate cut, never a lost
/// clip. AVFoundation reads mp4 and mov; a WebM clip lands here.
async fn opening_from_prev_clip(
    state: &AppState,
    room_path: &str,
    clip_file_id: &str,
    shot_action: &str,
) -> Option<Attachment> {
    let (bytes, ext) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().filter(|r| r.path == room_path)?;
        let meta = db::get_file_meta(&room.conn, clip_file_id).ok()?;
        let bytes = db::get_file_bytes(&room.conn, clip_file_id).ok()??;
        (bytes, clip_ext(&meta.mime_type, &meta.name))
    };
    let png = tauri::async_runtime::spawn_blocking(move || {
        crate::media_probe::last_frame_png(&bytes, &ext)
    })
    .await
    .ok()??;

    // Filed in the room so the seam between two shots is a picture a person
    // can open and check — not an invisible intermediate.
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    {
        let guard = state.room.lock().unwrap();
        // Pinned to the SAME room the clip came from. The capture above
        // awaited; an open-over-open can have swapped rooms underneath us,
        // and writing this frame into whichever room happens to be open now
        // would leak one room's picture into another.
        if let Some(room) = guard.as_ref().filter(|r| r.path == room_path) {
            let stem: String = shot_action.split_whitespace().take(5).collect::<Vec<_>>().join(" ");
            let stem = if stem.is_empty() { "Shot".to_string() } else { stem };
            if let Ok(name) =
                db::available_name(&room.conn, &format!("{stem} — end frame.png"))
            {
                // Section-only like every other Create output — and this one
                // most of all: an end frame is continuity machinery for the
                // next shot, not a picture anyone asked Home to list.
                if let Ok(meta) = db::insert_file(
                    &room.conn,
                    &name,
                    "image/png",
                    &png,
                    Some("The exact frame the previous shot's clip ends on. This shot's clip starts on this picture, which is what joins the two."),
                    "generated",
                ) {
                    db::mark_section_only(&room.conn, &meta.id, "create");
                }
            }
        }
    }
    Some(Attachment { b64, mime: "image/png".into() })
}

/// Wake the next shot's chain-parked job, now that this shot's clip exists.
///
/// The counterpart of `ChainGate::Wait`: a job that parked itself waiting for
/// THIS clip is flipped back to queued, and the pump picks it up in FIFO
/// order. Matched on the parked reason's prefix so a user's own pause — which
/// must stay paused — is never resumed behind their back.
fn wake_chain_waiter(state: &AppState, room_path: &str, shot_id: &str) {
    let guard = state.room.lock().unwrap();
    let Some(room) = guard.as_ref().filter(|r| r.path == room_path) else { return };
    let Ok(Some(next_shot)) = db::next_shot_id(&room.conn, shot_id) else { return };
    let Ok(jobs) = db::unfinished_jobs(&room.conn) else { return };
    for job in jobs {
        if !is_chain_parked(&job) {
            continue;
        }
        let is_next = serde_json::from_value::<CreatePlan>(job.plan.clone())
            .ok()
            .and_then(|p| p.shot_id)
            .as_deref()
            == Some(next_shot.as_str());
        if is_next {
            // 'queued' clears parked_reason (see set_job_status), so a woken
            // job carries no stale claim about what it was waiting for.
            let _ = db::set_job_status(&room.conn, &job.id, "queued", None);
            break;
        }
    }
}

/// The container extension AVFoundation should dispatch on.
fn clip_ext(mime: &str, name: &str) -> String {
    match mime {
        "video/mp4" => "mp4".into(),
        "video/quicktime" => "mov".into(),
        "video/webm" => "webm".into(),
        _ => std::path::Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4")
            .to_string(),
    }
}

/// The Create page's entry point.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_create_job(
    window: tauri::Window,
    state: State<'_, AppState>,
    prompt: String,
    model: String,
    kind: String,
    variations: Option<usize>,
    seconds: Option<u32>,
    resolution: Option<String>,
    aspect_ratio: Option<String>,
    reference_file_ids: Option<Vec<String>>,
    frame_file_id: Option<String>,
    last_frame_file_id: Option<String>,
    references_ack: Option<bool>,
    shot_id: Option<String>,
) -> Result<String, String> {
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    start_create_job_inner(
        &window,
        state.inner(),
        CreatePlan {
            prompt,
            model: model.trim().to_string(),
            kind: kind.trim().to_string(),
            variations: variations.unwrap_or(1),
            seconds,
            resolution: resolution.unwrap_or_default(),
            aspect_ratio: aspect_ratio.unwrap_or_default(),
            reference_file_ids: reference_file_ids.unwrap_or_default(),
            frame_file_id: frame_file_id.filter(|id| !id.trim().is_empty()),
            last_frame_file_id: last_frame_file_id.filter(|id| !id.trim().is_empty()),
            // The bench makes ONE clip; there is no next shot to hand a
            // frame to. Chaining is the shot list's business.
            chained: false,
            references_ack: references_ack.unwrap_or(false),
            shot_id: shot_id.filter(|id| !id.trim().is_empty()),
        },
    )
    .await
}

/// The most generations one press may queue.
///
/// A ceiling on a single click, not on the room: a twenty-minute episode is
/// eighty clips, which is the longest thing this feature is meant for. Above
/// that, something has gone wrong with the list rather than with the ambition.
pub(crate) const MAX_SHOT_RUN: usize = 80;

/// One shot exactly as it will be sent — or the reason it will not be.
///
/// This is the review sheet's row, and it is built from the SAME code that
/// runs, deliberately. A preview assembled separately from the thing it
/// previews is a preview that drifts, and the failure mode is the worst
/// available: a screen that says one thing above a button that pays for
/// another.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShotPreview {
    pub shot_id: String,
    /// Its place in the list, 1-based, as the row is labelled on screen.
    pub n: usize,
    pub action: String,
    /// The words that will be sent, verbatim — logline, cast, action, joined
    /// exactly as `shot_prompt` will join them. Not a summary of them.
    pub prompt: String,
    /// The length after the model's own list has had its say.
    pub seconds: Option<u32>,
    pub model: String,
    /// The picture this clip opens on, and the one it closes on. The second is
    /// the next shot's opening picture — that is what joins them.
    pub start_file_id: Option<String>,
    pub end_file_id: Option<String>,
    /// The portraits that ride along as guidance. Shown on the sheet for the
    /// same reason the frames are: "Mira is in this shot" is a claim, and the
    /// picture that will actually be sent is the evidence for it. A hero with
    /// no face contributes nothing here, which is worth seeing before paying.
    pub reference_file_ids: Vec<String>,
    /// Whose faces ride along, by name.
    pub cast: Vec<String>,
    /// Cast in this shot who have NO picture. They are the difference between
    /// a person who looks like themselves in every scene and one who is
    /// re-imagined from words on every call — which is what "a different
    /// person in each scene" actually is, and it is invisible until it has
    /// been paid for twenty times.
    pub faceless: Vec<String>,
    /// Set when a join was asked for on this shot and the model will not take
    /// an ending picture, so it was dropped. Named per shot because a list can
    /// mix models.
    pub join_dropped: Option<String>,
    /// True when this clip will OPEN on the frame the previous clip really
    /// ends on — captured from the finished video, not aimed at. This is the
    /// join stated as a promise the run can actually keep.
    pub starts_on_previous: bool,
    /// Why this shot is not being sent. `None` means it is.
    pub skip: Option<String>,
}

/// What pressing the button would actually do, before it is pressed.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FilmPlan {
    pub kind: String,
    /// Every shot in the list, sent or not — a row missing from the review is
    /// a row nobody can ask about.
    pub shots: Vec<ShotPreview>,
    pub sending: usize,
    pub skipped: usize,
    pub total_seconds: u32,
    /// How many will really be joined to the next one. Not the same as how
    /// many were asked to be: a model that takes no last frame has it dropped,
    /// and the sheet should not promise a join that will not happen.
    pub joined: usize,
    /// True when the run is longer than one press may queue.
    pub over_cap: bool,
    /// The model that will not take an ending picture, when a join was asked
    /// for and dropped. THE reason "clip one ends on a frame clip two does not
    /// start with" — the clips are made either way, so without this the
    /// failure is only discoverable by watching twenty finished videos.
    pub join_blocked_by: Option<String>,
    /// Everyone in this run who has no portrait. Words alone are re-imagined
    /// on every call, so these are the people who will not look like
    /// themselves twice.
    pub faceless: Vec<String>,
}

/// Build every shot's plan once, for both the preview and the run.
/// One shot's plan, its preview row, and what its continuity depends on.
pub(crate) struct PlannedRow {
    pub plan: Option<CreatePlan>,
    pub preview: ShotPreview,
}

fn plan_shot_list(
    conn: &rusqlite::Connection,
    list_id: &str,
    kind: &str,
    chain: bool,
) -> Result<Vec<PlannedRow>, String> {
    let video = kind == CREATE_KIND_VIDEO;
    let shots = db::list_shots(conn, list_id)?;
    let cast = db::list_cast(conn)?;
    // Shots ALREADY being made, per medium. Without this, pressing "Film
    // them" twice queued the whole list twice — nothing marked a shot as
    // in-flight, so the second press saw twenty shots with no clip and
    // billed all twenty again.
    let in_flight: std::collections::HashSet<String> = db::unfinished_jobs(conn)?
        .into_iter()
        .filter(|j| j.kind == "create")
        .filter_map(|j| serde_json::from_value::<CreatePlan>(j.plan).ok())
        .filter(|p| p.kind == kind)
        .filter_map(|p| p.shot_id)
        .collect();
    let list = db::list_story_lists(conn)?
        .into_iter()
        .find(|l| l.id == list_id);
    let logline = list.as_ref().map(|l| l.logline.clone()).unwrap_or_default();
    // The shape and size chosen for the whole list. One aspect ratio for every
    // shot is the point: a still drawn 1:1 and pinned as a 16:9 clip's first
    // frame is pinned to a frame of the wrong shape.
    let aspect_ratio = list.as_ref().map(|l| l.aspect_ratio.clone()).unwrap_or_default();
    let resolution = list
        .as_ref()
        .map(|l| {
            if video { l.clip_resolution.clone() } else { l.still_resolution.clone() }
        })
        .unwrap_or_default();

    // Which shot follows which, so a clip can end on the picture the next one
    // begins with. Collected before the loop because a shot needs to see its
    // SUCCESSOR, which it has no way to reach from its own row.
    let next_still: Vec<Option<String>> = shots
        .iter()
        .skip(1)
        .map(|s| s.still_file_id.clone())
        .chain(std::iter::once(None))
        .collect();

    let mut out = Vec::new();
    for (index, shot) in shots.iter().enumerate() {
        let members: Vec<db::CastMember> = shot
            .cast_ids
            .iter()
            .filter_map(|id| cast.iter().find(|c| &c.id == id).cloned())
            .collect();
        let prompt = crate::commands::story::shot_prompt(&shot.action, &members, &logline);
        let model = if video { &shot.video_model } else { &shot.image_model };
        let mut preview = ShotPreview {
            shot_id: shot.id.clone(),
            n: index + 1,
            action: shot.action.clone(),
            prompt: prompt.clone(),
            seconds: shot.seconds,
            model: model.split("::").nth(1).unwrap_or(model).to_string(),
            start_file_id: None,
            end_file_id: None,
            reference_file_ids: Vec::new(),
            starts_on_previous: false,
            cast: members.iter().map(|m| m.name.clone()).collect(),
            faceless: members
                .iter()
                .filter(|m| m.face_file_id.is_none())
                .map(|m| m.name.clone())
                .collect(),
            join_dropped: None,
            skip: None,
        };

        if in_flight.contains(&shot.id) {
            preview.skip = Some(if video {
                "already being filmed — a job for it is queued or running".into()
            } else {
                "already being drawn — a job for it is queued or running".into()
            });
            out.push(PlannedRow { plan: None, preview });
            continue;
        }
        // Already made — skipped rather than charged for twice. Re-making one
        // shot is a per-shot action, deliberately not part of "make all".
        let already = if video { &shot.clip_file_id } else { &shot.still_file_id };
        if already.is_some() {
            preview.skip = Some(if video {
                "already filmed".into()
            } else {
                "already drawn".into()
            });
            out.push(PlannedRow { plan: None, preview });
            continue;
        }
        if model.trim().is_empty() {
            preview.skip = Some(if video {
                "no clip model chosen".into()
            } else {
                "no picture model chosen".into()
            });
            out.push(PlannedRow { plan: None, preview });
            continue;
        }

        let faces = db::cast_faces(conn, &shot.cast_ids)?;
        let mut plan = CreatePlan {
            prompt,
            model: model.trim().to_string(),
            kind: kind.to_string(),
            variations: 1,
            seconds: shot.seconds,
            resolution: resolution.clone(),
            aspect_ratio: aspect_ratio.clone(),
            // A clip animates the still this shot already has; only a still
            // needs the faces as guidance. Sending both to a video model would
            // pay to describe a face that is already on screen.
            reference_file_ids: if video { Vec::new() } else { faces },
            frame_file_id: if video { shot.still_file_id.clone() } else { None },
            // THE JOIN. Ending this clip on the next shot's opening picture is
            // what turns twenty separate clips into one continuous five
            // minutes — the same frame closes this shot and opens the next, so
            // the cut is exact rather than a guess. Only when the next shot
            // HAS a picture; there is nothing to aim at otherwise.
            last_frame_file_id: if video && chain {
                next_still.get(index).cloned().flatten()
            } else {
                None
            },
            // The half of the join that cannot drift: on completion, capture
            // the frame this clip really ends on and hand it to the next
            // shot's queued job as its first frame.
            chained: video && chain,
            references_ack: true,
            shot_id: Some(shot.id.clone()),
        };

        // Run the real check here, so the sheet shows the length that will
        // actually be sent — including a `last_frame` this model will not take,
        // which is dropped rather than refused. A refusal becomes a skip with
        // the reason on the row instead of an exception that hides the other
        // nineteen shots behind one bad one.
        // What the join WOULD have been, before the model's own limits are
        // applied — so a dropped one can be reported rather than just missing.
        let wanted_join = plan.last_frame_file_id.clone();
        // Continuity comes from the shot BEFORE this one. Its clip may
        // already exist, be filming right now (an earlier run's job), or be
        // queued ahead of this shot in this very run — all three end with a
        // clip whose final frame this shot can open on. What does NOT count
        // is a predecessor whose own plan was refused above: a shot that
        // films nothing hands nothing forward, and the first version of this
        // read the predecessor's RAW row and promised joins its refusal had
        // already made impossible.
        let prev = index.checked_sub(1).map(|i| &shots[i]);
        let prev_clip = prev.and_then(|s| s.clip_file_id.clone());
        let prev_will_film = out
            .last()
            .is_some_and(|row: &PlannedRow| row.plan.is_some() && video)
            || prev.is_some_and(|s| in_flight.contains(&s.id));
        // And the join needs a RECEIVER: a model with no first-frame slot
        // cannot open on anything, however available the frame is.
        let receiver_ok = limits_for(&preview.model)
            .map(|l| l.takes_first_frame())
            .unwrap_or(true);
        match check_media_shape(&mut plan) {
            Ok(()) => {
                if wanted_join.is_some() && plan.last_frame_file_id.is_none() {
                    preview.join_dropped = Some(preview.model.clone());
                }
                preview.seconds = plan.seconds;
                preview.start_file_id = plan.frame_file_id.clone();
                preview.end_file_id = plan.last_frame_file_id.clone();
                preview.reference_file_ids = plan.reference_file_ids.clone();
                // The promise the sheet can make: this clip will open on the
                // frame the previous clip REALLY ends on — captured, not
                // aimed at. True when the previous shot's clip either exists
                // already or is being filmed earlier in this same run.
                preview.starts_on_previous = video
                    && chain
                    && receiver_ok
                    && (prev_clip.is_some() || prev_will_film);
                out.push(PlannedRow { plan: Some(plan), preview });
            }
            Err(why) => {
                preview.skip = Some(why);
                out.push(PlannedRow { plan: None, preview });
            }
        }
    }
    Ok(out)
}

/// What "Draw them" / "Film them" would do, itemised, before any money moves.
///
/// A generation is billed and a list is twenty of them, so the sheet this
/// feeds is not a courtesy — it is the last point at which the whole run can
/// be read. It shows each part's exact prompt, its length, and both ends of
/// its clip.
#[tauri::command]
pub fn story_film_plan(
    state: State<'_, AppState>,
    list_id: String,
    kind: String,
    continuous: Option<bool>,
) -> Result<FilmPlan, String> {
    let kind = kind.trim().to_string();
    let chain = continuous.unwrap_or(true);
    let rows = state.with_room(|room| plan_shot_list(&room.conn, &list_id, &kind, chain))?;

    let sending = rows.iter().filter(|r| r.plan.is_some()).count();
    // The joins that will really hold: clips OPENING on the captured end of
    // the one before. `last_frame` targeting is not counted as a join any
    // more — it is aim, not contact, and the sheet must not promise contact
    // it cannot deliver (that gap is the reported bug this replaces).
    let joined = rows.iter().filter(|r| r.preview.starts_on_previous).count();
    let total_seconds = rows
        .iter()
        .filter_map(|r| r.plan.as_ref().and_then(|p| p.seconds))
        .sum();
    let join_blocked_by = rows
        .iter()
        .find_map(|r| r.preview.join_dropped.clone());
    // Deduplicated, in the order they appear — a name repeated across twenty
    // shots is one problem, not twenty.
    let mut faceless: Vec<String> = Vec::new();
    for row in rows.iter().filter(|r| r.plan.is_some()) {
        for name in &row.preview.faceless {
            if !faceless.contains(name) {
                faceless.push(name.clone());
            }
        }
    }
    Ok(FilmPlan {
        kind,
        join_blocked_by,
        faceless,
        skipped: rows.len() - sending,
        sending,
        joined,
        total_seconds,
        over_cap: sending > MAX_SHOT_RUN,
        shots: rows.into_iter().map(|r| r.preview).collect(),
    })
}

/// Start every unmade shot in a list, in order.
///
/// One command rather than the page firing N of them, so a list of twenty is
/// one decision with one outcome rather than twenty races.
///
/// **The queue cap is waived here, and that is the fix for a real bug.** The
/// generic cap is ten queued jobs, so a twenty-one-shot episode used to queue
/// eleven and then hit `Err(_) => break`, which discarded the remaining ten
/// silently: the toast counted what was started, so the page cheerfully
/// reported "Filming 11 shots" for a list of 21 and nothing anywhere mentioned
/// the missing half. The cap is there to stop a runaway *scheduler* piling up
/// unbounded work; this is a counted set the user read on a review sheet and
/// pressed a button naming, so `MAX_SHOT_RUN` bounds it instead.
///
/// They still run ONE AT A TIME — the job queue has a single running slot —
/// which is what "one after another" means here, and is why the last clip of
/// an episode lands a long while after the first.
#[tauri::command]
pub async fn start_shot_list_job(
    window: tauri::Window,
    state: State<'_, AppState>,
    list_id: String,
    kind: String,
    // `continuous`: join each clip to the next by ending it on the following
    // shot's opening picture. Off means twenty independent clips.
    continuous: Option<bool>,
) -> Result<ShotRunStarted, String> {
    if state.rolling_back() {
        return Err(ROLLBACK_BUSY.into());
    }
    let kind = kind.trim().to_string();
    let video = kind == CREATE_KIND_VIDEO;
    let chain = continuous.unwrap_or(true);

    // Assembled from the room in ONE borrow, before any awaiting: holding the
    // room lock across a network call would block every other reader for the
    // length of a generation. The room's PATH rides along so the queueing
    // loop below — which awaits between inserts — can notice a room swap and
    // stop, rather than queue the tail of one room's episode into another.
    let (rows, planned_room) =
        state.with_room(|room| Ok((plan_shot_list(&room.conn, &list_id, &kind, chain)?, room.path.clone())))?;

    // No frame is captured here, deliberately. The runner captures its own
    // opening at START time (`chain_gate` → `opening_from_prev_clip`), which
    // is the only moment the predecessor's clip is a settled fact — at queue
    // time it may not exist yet, and between queue and run the world moves:
    // a Stop re-orders things, a lock parks them, the app restarts. Queue-time
    // capture was tried and adversarially reviewed away: it also crashed the
    // whole queueing loop when a no-first-frame model met the injected frame.
    let planned: Vec<CreatePlan> = rows.into_iter().filter_map(|r| r.plan).collect();

    if planned.is_empty() {
        return Err(if video {
            "Nothing to film — every shot either has a clip already or has no \
             video model chosen."
                .into()
        } else {
            "Nothing to draw — every shot either has a picture already or has \
             no picture model chosen."
                .into()
        });
    }
    if planned.len() > MAX_SHOT_RUN {
        return Err(format!(
            "That is {} generations in one go, and this room will queue {MAX_SHOT_RUN} \
             at a time. Split the list, or make the first {MAX_SHOT_RUN} and come back.",
            planned.len()
        ));
    }

    let asked = planned.len();
    let mut job_ids = Vec::new();
    let mut failure: Option<String> = None;
    for plan in planned {
        // Awaits separate these inserts; if the user swapped rooms mid-loop,
        // the remaining jobs must not land in the new room.
        let same_room = state
            .with_room(|room| Ok(room.path == planned_room))
            .unwrap_or(false);
        if !same_room {
            failure = Some("the room changed while these were being queued".into());
            break;
        }
        match start_create_job_bulk(&window, state.inner(), plan, true).await {
            Ok(id) => job_ids.push(id),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    if job_ids.is_empty() {
        return Err(failure.unwrap_or_else(|| "nothing could be started".into()));
    }
    // A short run is REPORTED, and still returns its jobs. Returning an error
    // for a partial start would be the old bug wearing a different coat: the
    // shots that did queue are real work the user is being charged for, and a
    // caller that treats the whole call as failed loses track of them.
    let shortfall = (job_ids.len() < asked).then(|| {
        format!(
            "Only {} of {asked} could be started — {}",
            job_ids.len(),
            failure.unwrap_or_else(|| "the room stopped accepting them".into())
        )
    });
    Ok(ShotRunStarted { job_ids, asked, shortfall })
}

/// The outcome of one press of "Draw them" / "Film them".
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShotRunStarted {
    pub job_ids: Vec<String>,
    /// How many were meant to start, so a short run is visible as a shortfall
    /// rather than as a smaller number nobody had anything to compare against.
    pub asked: usize,
    pub shortfall: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_card_is_titled_by_the_first_few_words_of_the_prompt() {
        assert_eq!(
            create_title("A lighthouse at dusk", CREATE_KIND_IMAGE),
            "Painting “A lighthouse at dusk”"
        );
        // Long prompts are cut, and say they were cut.
        assert_eq!(
            create_title(
                "A lighthouse at dusk with the storm still an hour out",
                CREATE_KIND_IMAGE
            ),
            "Painting “A lighthouse at dusk with the…”"
        );
        // The verb follows the medium, so two cards are told apart at a glance.
        assert_eq!(
            create_title("A harbour pan", CREATE_KIND_VIDEO),
            "Filming “A harbour pan”"
        );
        assert_eq!(create_title("   ", CREATE_KIND_IMAGE), "Painting");
    }

    #[test]
    fn a_filename_survives_a_prompt_full_of_punctuation() {
        // A prompt is a sentence; a filename is not. Punctuation that would
        // break a path (slashes, quotes, colons) must not reach one.
        let name = artwork_name("A lighthouse: dusk/storm, \"thick\" oils", 0, 1, "png");
        assert_eq!(name, "A lighthouse dusk storm thick.png");
        assert!(!name.contains('/'));

        // Numbered only when there is more than one to tell apart.
        assert_eq!(
            artwork_name("A lighthouse", 2, 4, "png"),
            "A lighthouse 3.png"
        );
        // A prompt with nothing filename-able still yields a usable name.
        assert_eq!(artwork_name("!!! ???", 0, 1, "webp"), "Generated.webp");
    }

    #[test]
    fn variation_counts_are_clamped_rather_than_trusted() {
        assert_eq!(0_usize.clamp(1, MAX_VARIATIONS), 1);
        assert_eq!(99_usize.clamp(1, MAX_VARIATIONS), MAX_VARIATIONS);
    }

    #[test]
    fn a_size_the_model_never_published_is_dropped_not_sent() {
        // Dropped rather than refused, because the cost of getting it wrong is
        // asymmetric: the wrong SIZE still yields the clip that was asked for.
        let mut value = "4K".to_string();
        drop_unpublished(&mut value, &["720p".into(), "1080p".into()]);
        assert_eq!(value, "", "a size not on the list is not sent");

        let mut kept = "1080p".to_string();
        drop_unpublished(&mut kept, &["720p".into(), "1080p".into()]);
        assert_eq!(kept, "1080p");

        // An EMPTY published list is the provider declining to say, not a ban.
        // Clearing here would make the control dead on every model whose
        // catalogue entry happens to omit the field.
        let mut untold = "1080p".to_string();
        drop_unpublished(&mut untold, &[]);
        assert_eq!(untold, "1080p", "unpublished means untold, not forbidden");
    }

    #[test]
    fn a_still_is_shape_checked_too_and_never_carries_a_length() {
        // The regression this pins: `check_media_shape` used to return early
        // for stills, so the two fields went out unvalidated — to an endpoint
        // that then ignored them, which is why nothing ever complained.
        let mut plan = CreatePlan {
            model: "openrouter::qwen/qwen-image-3-pro".into(),
            kind: CREATE_KIND_IMAGE.into(),
            seconds: Some(15),
            ..Default::default()
        };
        plan.prompt = "a lighthouse".into();
        check_media_shape(&mut plan).expect("a still is never refused for its shape");
        assert_eq!(plan.seconds, None, "a picture has no length");
    }

    #[test]
    fn a_failure_that_dooms_the_whole_run_is_told_apart_from_one_bad_call() {
        // Both of these were reported live, minutes apart, and they need
        // opposite handling — which is the entire reason this function exists.
        assert!(matches!(
            doomed_scope("Insufficient credits. Add more using https://openrouter.ai/…"),
            Doomed::Everything
        ));
        assert!(matches!(
            doomed_scope("No API key is connected for this model. Add one in Settings"),
            Doomed::Everything
        ));
        // A model fact, not an account fact: a list mixing models keeps making
        // the parts that can still be made.
        assert!(matches!(
            doomed_scope("No endpoint found for model \"openrouter/auto\""),
            Doomed::ThisModel
        ));
        // Everything else is one generation's problem. Cancelling nineteen
        // good shots over a single unlucky call would be its own damage.
        assert!(matches!(
            doomed_scope("the model returned nothing to save"),
            Doomed::JustThisOne
        ));
        assert!(matches!(
            doomed_scope("the clip was still not ready after 20 minutes"),
            Doomed::JustThisOne
        ));
    }

    fn room() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        conn.execute_batch(crate::db::SCHEMA).expect("schema");
        conn
    }

    /// A room file, so a shot can have a still to open on.
    fn picture(conn: &rusqlite::Connection, id: &str) {
        conn.execute(
            "INSERT INTO files (id, name, mime_type, original_bytes, source) \
             VALUES (?1, ?1, 'image/png', x'00', 'generated')",
            rusqlite::params![id],
        )
        .unwrap();
    }

    #[test]
    fn the_review_and_the_run_are_built_from_one_list_of_plans() {
        // THE POINT OF THE WHOLE FUNCTION. The sheet a person reads and the
        // work that gets paid for come out of the same call, so they cannot
        // disagree — a preview assembled separately is one edit away from
        // putting a claim on screen above a button that buys something else.
        let conn = room();
        let list = db::create_story_list(&conn, "Episode 1", "a cold harbour").unwrap();
        for id in ["still-1", "still-2"] {
            picture(&conn, id);
        }
        let first = db::add_shot(&conn, &list, "the boat pulls away").unwrap();
        let second = db::add_shot(&conn, &list, "the lamp goes out").unwrap();
        let third = db::add_shot(&conn, &list, "nobody chose a model for this").unwrap();
        for (id, model) in [(&first.id, "openrouter::kling/v3"), (&second.id, "openrouter::kling/v3")] {
            db::update_shot(&conn, id, "", &[], Some(10), "", model).unwrap();
        }
        // Actions are re-set by update_shot above, so put them back.
        db::update_shot(&conn, &first.id, "the boat pulls away", &[], Some(10), "", "openrouter::kling/v3").unwrap();
        db::update_shot(&conn, &second.id, "the lamp goes out", &[], Some(10), "", "openrouter::kling/v3").unwrap();
        db::set_shot_result(&conn, &first.id, Some("still-1"), None).unwrap();
        db::set_shot_result(&conn, &second.id, Some("still-2"), None).unwrap();

        let rows = plan_shot_list(&conn, &list, CREATE_KIND_VIDEO, true).unwrap();
        assert_eq!(rows.len(), 3, "every shot appears, sent or not");

        // The two with a model are sent; the third says why it is not.
        assert_eq!(rows.iter().filter(|r| r.plan.is_some()).count(), 2);
        let skipped = rows.iter().find(|r| r.preview.shot_id == third.id).unwrap();
        assert_eq!(skipped.preview.skip.as_deref(), Some("no clip model chosen"));

        // THE JOIN, both halves. Shot one AIMS at shot two's opening picture
        // (last_frame), and shot two OPENS on the frame shot one's clip
        // really ends on — the second is the promise, the first only helps.
        let one = rows.iter().find(|r| r.preview.shot_id == first.id).unwrap();
        let plan_one = one.plan.as_ref().unwrap();
        assert_eq!(plan_one.frame_file_id.as_deref(), Some("still-1"));
        assert_eq!(plan_one.last_frame_file_id.as_deref(), Some("still-2"));
        assert!(plan_one.chained, "finishing must hand its end frame forward");
        assert_eq!(one.preview.start_file_id.as_deref(), Some("still-1"));
        assert_eq!(one.preview.end_file_id.as_deref(), Some("still-2"));
        assert!(
            !one.preview.starts_on_previous,
            "the FIRST shot has nothing before it to start on"
        );

        let two = rows.iter().find(|r| r.preview.shot_id == second.id).unwrap();
        assert_eq!(two.preview.end_file_id, None, "nothing after it to aim at");
        assert!(
            two.preview.starts_on_previous,
            "shot two opens on shot one's captured end frame"
        );
        // Shot one has no clip YET, so nothing is captured at plan time: the
        // row promises the join and the gate decides it at shot two's start.
        // What the gate then answers is pinned by its own test, not re-asserted
        // here with hand-made arguments this list never produced.
        let plan_two = two.plan.as_ref().unwrap();
        assert!(plan_two.chained, "the promise rides on the plan");
        assert_eq!(
            plan_two.frame_file_id.as_deref(),
            Some("still-2"),
            "the queued opening is shot two's OWN drawn still — the real end frame \
             is captured at its start, from a clip that does not exist yet"
        );

        // The prompt shown is the prompt sent, logline and all — not the row.
        assert_eq!(one.preview.prompt, plan_one.prompt);
        assert!(one.preview.prompt.starts_with("a cold harbour"));
        assert!(one.preview.prompt.contains("the boat pulls away"));
    }

    #[test]
    fn a_shot_after_an_already_filmed_one_chains_from_that_clip() {
        // The resume path — and the exact state the reported credit failure
        // leaves a room in: shot 1 filmed, the rest stopped. On the next run
        // shot 2 must open on shot 1's REAL end frame, captured from the clip
        // that already exists, or the first cut of every resumed episode is
        // the broken one.
        let conn = room();
        let list = db::create_story_list(&conn, "Episode 1", "").unwrap();
        for id in ["still-1", "still-2", "clip-1"] {
            picture(&conn, id);
        }
        let first = db::add_shot(&conn, &list, "one").unwrap();
        let second = db::add_shot(&conn, &list, "two").unwrap();
        db::update_shot(&conn, &first.id, "one", &[], None, "", "openrouter::kling/v3").unwrap();
        db::update_shot(&conn, &second.id, "two", &[], None, "", "openrouter::kling/v3").unwrap();
        db::set_shot_result(&conn, &first.id, Some("still-1"), None).unwrap();
        db::set_shot_result(&conn, &second.id, Some("still-2"), None).unwrap();
        // Shot one was filmed in a previous run.
        db::set_shot_result(&conn, &first.id, None, Some("clip-1")).unwrap();

        let rows = plan_shot_list(&conn, &list, CREATE_KIND_VIDEO, true).unwrap();
        let one = rows.iter().find(|r| r.preview.shot_id == first.id).unwrap();
        assert!(one.plan.is_none(), "not paid for twice");

        let two = rows.iter().find(|r| r.preview.shot_id == second.id).unwrap();
        assert!(two.plan.is_some());
        assert!(two.preview.starts_on_previous);
        // …and the capture itself is the gate's, at shot two's start. The row
        // carries no copy of shot one's clip: it queues shot two's own drawn
        // still and the promise, and the run looks left when it begins. (What
        // the gate then answers is pinned by the gate's own test.)
        let plan_two = two.plan.as_ref().unwrap();
        assert!(plan_two.chained);
        assert_eq!(plan_two.frame_file_id.as_deref(), Some("still-2"));

        // With the chain OFF, the existing clip is nobody's business.
        let rows = plan_shot_list(&conn, &list, CREATE_KIND_VIDEO, false).unwrap();
        let two = rows.iter().find(|r| r.preview.shot_id == second.id).unwrap();
        assert!(!two.preview.starts_on_previous);
        assert!(two.plan.as_ref().is_some_and(|p| !p.chained));
    }

    #[test]
    fn the_chain_gate_waits_captures_or_proceeds_for_the_right_reasons() {
        // The whole ordering bug lives in this decision, so it is pure and
        // pinned. Wait fires ONLY when the predecessor has no clip but a live
        // job — the state a Stop, a lock or a quit leaves behind, where the
        // old code cheerfully filmed the successor first and lost the join.
        let clip = Some("clip-1".to_string());
        let none: Option<String> = None;

        assert!(matches!(decide_chain(None), ChainGate::Proceed), "shot one waits for nobody");
        assert!(matches!(
            decide_chain(Some((&clip, "kling", false))),
            ChainGate::CaptureFrom(id) if id == "clip-1"
        ));
        assert!(matches!(
            decide_chain(Some((&none, "kling", true))),
            ChainGate::Wait(_)
        ));
        // No clip and no live job: errored, stopped-for-credit, or never
        // filmed. Nothing is coming to wake a waiter, so waiting would be a
        // job parked forever — proceed on the drawn still instead.
        assert!(matches!(
            decide_chain(Some((&none, "kling", false))),
            ChainGate::Proceed
        ));
        // A predecessor with NO model never films, live job or not.
        assert!(matches!(
            decide_chain(Some((&none, "", true))),
            ChainGate::Proceed
        ));
    }

    /// `input_references.max` was read in exactly one place — the bench's
    /// attach button — so a shot list handed four cast faces to a model that
    /// publishes two and collected a refusal per shot, after the review sheet
    /// had already shown those four as "looks like" evidence.
    #[test]
    fn a_models_published_reference_ceiling_is_applied_to_what_is_sent() {
        let four = || {
            vec!["a".to_string(), "b".to_string(), "c".to_string(), "d".to_string()]
        };
        let mut ids = four();
        cap_references(&mut ids, Some(2));
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()], "the first two are sent");

        // Unpublished: the provider declined to say, so nothing is dropped.
        let mut ids = four();
        cap_references(&mut ids, None);
        assert_eq!(ids.len(), 4);

        // Exactly at the ceiling, and one under it: nothing goes.
        let mut ids = four();
        cap_references(&mut ids, Some(4));
        assert_eq!(ids.len(), 4);
        let mut ids = four();
        cap_references(&mut ids, Some(5));
        assert_eq!(ids.len(), 4);

        // A model that takes none, and a plan that has none.
        let mut ids = four();
        cap_references(&mut ids, Some(0));
        assert!(ids.is_empty());
        let mut ids: Vec<String> = Vec::new();
        cap_references(&mut ids, Some(2));
        assert!(ids.is_empty());
    }

    /// A chain-parked job is woken by its predecessor's SUCCESS. When the
    /// predecessor fails instead, nothing used to move it: it sat 'paused'
    /// forever with a card saying "It starts by itself when that clip is
    /// ready", which by then was untrue.
    #[test]
    fn a_shot_parked_on_a_clip_that_will_never_exist_is_let_go() {
        let conn = room();
        let list = db::create_story_list(&conn, "Episode 1", "").unwrap();
        let first = db::add_shot(&conn, &list, "one").unwrap();
        let second = db::add_shot(&conn, &list, "two").unwrap();
        let park = |shot: &str| {
            let plan = serde_json::json!({
                "prompt": "two", "model": "openrouter::kling/v3",
                "kind": CREATE_KIND_VIDEO, "shotId": shot,
            });
            let id = db::create_job(&conn, "create", "Filming", &plan, 100).unwrap();
            db::set_job_status(&conn, &id, "paused", None).unwrap();
            db::set_parked_reason(&conn, &id, CHAIN_WAIT_REASON).unwrap();
            id
        };
        let waiter = park(&second.id);

        // Shot one is still being filmed: the wait is honest, so nothing moves.
        let live = serde_json::json!({
            "prompt": "one", "model": "openrouter::kling/v3",
            "kind": CREATE_KIND_VIDEO, "shotId": first.id,
        });
        let running = db::create_job(&conn, "create", "Filming", &live, 100).unwrap();
        assert_eq!(release_chain_waiters(&conn), 0);
        let still = db::unfinished_jobs(&conn)
            .unwrap()
            .into_iter()
            .find(|j| j.id == waiter)
            .expect("still waiting");
        assert_eq!(still.status, "paused");

        // Shot one fails. Nothing is coming, so shot two goes back in the queue
        // and will open on its own drawn still.
        db::set_job_status(&conn, &running, "error", Some("insufficient credits")).unwrap();
        assert_eq!(release_chain_waiters(&conn), 1);
        let freed = db::unfinished_jobs(&conn)
            .unwrap()
            .into_iter()
            .find(|j| j.id == waiter)
            .expect("queued again");
        assert_eq!(freed.status, "queued");
        assert_eq!(freed.parked_reason, None, "and it stops promising the join");
    }

    /// The user's own pause is not a chain wait, and must never be re-queued
    /// behind their back.
    #[test]
    fn a_pause_the_user_asked_for_is_left_alone() {
        let conn = room();
        let list = db::create_story_list(&conn, "Episode 1", "").unwrap();
        let _first = db::add_shot(&conn, &list, "one").unwrap();
        let second = db::add_shot(&conn, &list, "two").unwrap();
        let plan = serde_json::json!({
            "prompt": "two", "model": "openrouter::kling/v3",
            "kind": CREATE_KIND_VIDEO, "shotId": second.id,
        });
        let id = db::create_job(&conn, "create", "Filming", &plan, 100).unwrap();
        db::set_job_status(&conn, &id, "paused", None).unwrap();

        assert_eq!(release_chain_waiters(&conn), 0);
        assert_eq!(abandon_doomed_queue(&conn, "insufficient credits", "openrouter::kling/v3"), 0);
        let job = db::unfinished_jobs(&conn).unwrap().remove(0);
        assert_eq!(job.status, "paused");
    }

    #[test]
    fn a_parked_reason_lands_only_on_a_paused_job() {
        let conn = room();
        let plan = serde_json::json!({"prompt": "one", "model": "m", "kind": "video"});
        let id = db::create_job(&conn, "create", "Filming", &plan, 100).unwrap();

        db::set_job_status(&conn, &id, "paused", None).unwrap();
        db::set_parked_reason(&conn, &id, CHAIN_WAIT_REASON).unwrap();
        let job = db::unfinished_jobs(&conn).unwrap().remove(0);
        assert_eq!(job.parked_reason.as_deref(), Some(CHAIN_WAIT_REASON));

        // Re-queueing clears it — a woken job must not keep explaining a wait
        // it is no longer in.
        db::set_job_status(&conn, &id, "queued", None).unwrap();
        let job = db::unfinished_jobs(&conn).unwrap().remove(0);
        assert_eq!(job.parked_reason, None);
    }

    #[test]
    fn a_shot_already_being_made_is_not_queued_a_second_time() {
        // Pressing "Film them" twice used to bill the whole list twice:
        // nothing marked a shot as in-flight, so the second press saw twenty
        // shots with no clip and queued twenty more paid jobs.
        let conn = room();
        let list = db::create_story_list(&conn, "Episode 1", "").unwrap();
        let shot = db::add_shot(&conn, &list, "one").unwrap();
        db::update_shot(&conn, &shot.id, "one", &[], None, "", "openrouter::kling/v3").unwrap();

        let plan = serde_json::json!({
            "prompt": "one", "model": "openrouter::kling/v3",
            "kind": "video", "shotId": shot.id,
        });
        db::create_job(&conn, "create", "Filming", &plan, 100).unwrap();

        let rows = plan_shot_list(&conn, &list, CREATE_KIND_VIDEO, true).unwrap();
        assert!(rows[0].plan.is_none(), "not billed a second time");
        assert!(rows[0].preview.skip.as_deref().unwrap().contains("already being filmed"));

        // The guard is PER MEDIUM: the queued video job must not block the
        // picture pass for the same shot.
        db::update_shot(&conn, &shot.id, "one", &[], None, "openrouter::qwen/qwen-image-3-pro", "openrouter::kling/v3").unwrap();
        let stills = plan_shot_list(&conn, &list, CREATE_KIND_IMAGE, true).unwrap();
        assert!(stills[0].plan.is_some(), "drawing is separate work");
    }

    #[test]
    fn a_skipped_predecessor_promises_no_join() {
        // The predecessor has NO model, so it films nothing and hands nothing
        // forward. The sheet used to read the raw row and promise the join
        // anyway, directly under the predecessor's own "not being sent".
        let conn = room();
        let list = db::create_story_list(&conn, "Episode 1", "").unwrap();
        let first = db::add_shot(&conn, &list, "one").unwrap();
        let second = db::add_shot(&conn, &list, "two").unwrap();
        // first: no video model at all.
        db::update_shot(&conn, &first.id, "one", &[], None, "", "").unwrap();
        db::update_shot(&conn, &second.id, "two", &[], None, "", "openrouter::kling/v3").unwrap();

        let rows = plan_shot_list(&conn, &list, CREATE_KIND_VIDEO, true).unwrap();
        let two = rows.iter().find(|r| r.preview.shot_id == second.id).unwrap();
        assert!(two.plan.is_some(), "shot two still films");
        assert!(
            !two.preview.starts_on_previous,
            "no clip is coming from a shot with no model — promising the join would be false"
        );
    }

    #[test]
    fn one_press_will_not_queue_more_than_a_long_episode() {
        // Twenty minutes at fifteen seconds a clip is eighty — the longest
        // thing this feature is for. Above that, the list is wrong.
        assert_eq!(MAX_SHOT_RUN, 80);
        assert!(MAX_SHOT_RUN > 21, "a five-minute episode must fit in one press");
    }
}
