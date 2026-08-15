//! The Sketch page's commands, and the two tools the drawing agent holds.
//!
//! A sketch is an ordinary room file — `.sketch`, holding the JSON document
//! `sketchdoc` defines — and that is the whole storage design. It buys version
//! history on every save, trash and restore, provenance, the tab strip, the
//! Library listing and full-text search of its labels without a line of code
//! here, and it means the agent's drawings and the user's are the same objects.
//!
//! ## Why two tools and not seven
//!
//! The obvious shape for a drawing API is one verb per operation — add a box,
//! move a box, delete a box. That shape is wrong for a model. Each call is a
//! full round trip through the model, so a nine-box diagram costs nine turns,
//! and a small model loses the thread of what it was drawing somewhere around
//! the fourth. The tools here are instead:
//!
//! - `draw` — a WHOLE SCRIPT in one call, however many shapes it holds
//! - `read_drawing` — the page as that same script, what is wrong with its
//!   layout, and the picture itself when the engine can read pictures
//!
//! which is a complete draw → look → fix loop in two round trips instead of
//! thirty, and every argument is a flat string.

use super::sketchdoc::{self, Sketch};
use super::*;
use crate::db;
use crate::extraction;
use rusqlite::Connection;
use tauri::{Emitter, State};

/// The extension that makes a room file a drawing.
pub(crate) const SKETCH_EXT: &str = "sketch";

fn is_sketch(name: &str) -> bool {
    extraction::extension_of(name) == SKETCH_EXT
}

/// Every drawing in the room, NEWEST FIRST — `db::list_files` orders by
/// `created_at DESC`, and `take_empty_sketch` depends on that being true.
fn list_sketches(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    Ok(db::list_files(conn)?
        .into_iter()
        .filter(|f| is_sketch(&f.name))
        .map(|f| (f.id, f.name))
        .collect())
}

/// Find the drawing the model means.
///
/// Exact name, then a fragment, then — if the room holds exactly one drawing —
/// that one. The last rule is what makes `name` effectively optional in
/// practice: the overwhelmingly common case is a room with one sketch open,
/// and making the model repeat its name is a turn spent on bookkeeping.
///
/// Ambiguity is reported rather than guessed. `find_file_like` resolves a
/// fragment to the NEWEST match, which for files the agent itself just created
/// means a typo silently retargets the wrong drawing.
fn resolve(conn: &Connection, name: &str) -> Result<(String, String), String> {
    let all = list_sketches(conn)?;
    if all.is_empty() {
        return Err("This room has no drawings yet. Use `draw` with a new name to start one."
            .to_string());
    }
    let want = name.trim();
    if want.is_empty() {
        if all.len() == 1 {
            return Ok(all.into_iter().next().unwrap());
        }
        return Err(format!(
            "Which drawing? This room has {}: {}.",
            all.len(),
            name_list(&all)
        ));
    }
    let lower = want.to_lowercase();
    let stem = lower.trim_end_matches(".sketch").trim().to_string();
    if let Some(hit) = all.iter().find(|(_, n)| n.to_lowercase() == lower) {
        return Ok(hit.clone());
    }
    if let Some(hit) =
        all.iter().find(|(_, n)| n.to_lowercase().trim_end_matches(".sketch") == stem)
    {
        return Ok(hit.clone());
    }
    let hits: Vec<&(String, String)> =
        all.iter().filter(|(_, n)| n.to_lowercase().contains(&stem)).collect();
    match hits.len() {
        1 => Ok(hits[0].clone()),
        0 => Err(format!(
            "There is no drawing called \"{want}\". This room has: {}.",
            name_list(&all)
        )),
        _ => Err(format!(
            "\"{want}\" matches {} drawings: {}. Use the full name.",
            hits.len(),
            name_list(&hits.iter().map(|h| (*h).clone()).collect::<Vec<_>>())
        )),
    }
}

fn name_list(all: &[(String, String)]) -> String {
    all.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")
}

/// Claim a blank sketch and give it the name the drawing is about.
///
/// Returns the renamed drawing, or `None` when every sketch in the room has
/// something on it. Deliberately picks the NEWEST blank one: it is the one the
/// user most likely just made and is looking at.
fn take_empty_sketch(conn: &Connection, name: &str) -> Result<Option<(String, String)>, String> {
    let blank = list_sketches(conn)?
        .into_iter()
        .find(|(id, _)| load(conn, id).map(|d| d.elements.is_empty()).unwrap_or(false));
    let Some((id, _)) = blank else { return Ok(None) };
    let wanted = db::available_name(conn, &sketch_name(name))?;
    db::rename_file(conn, &id, &wanted)?;
    Ok(Some((id, wanted)))
}

fn load(conn: &Connection, id: &str) -> Result<Sketch, String> {
    let raw = db::get_file_bytes(conn, id)?.unwrap_or_default();
    Sketch::from_json(&String::from_utf8_lossy(&raw))
}

/// Write a drawing back. Goes through `store_file_bytes` like every other
/// content write in the app, so a drawing the agent changed can be recovered
/// from version history exactly like one the user typed over.
fn save(conn: &Connection, id: &str, doc: &Sketch, cause: &str) -> Result<(), String> {
    let json = doc.to_json();
    super::files::store_file_bytes(
        conn,
        id,
        json.as_bytes(),
        Some(&doc.extracted_text()),
        cause,
    )
}

fn sketch_name(name: &str) -> String {
    let n = name.trim();
    let n = if n.is_empty() { "Sketch" } else { n };
    if is_sketch(n) {
        n.to_string()
    } else {
        format!("{n}.{SKETCH_EXT}")
    }
}

/// The MIME a drawing carries. `classify_file` picks the viewer by EXTENSION,
/// so this is only what the Library shows and what an export would carry — but
/// naming it honestly is what stops a `.sketch` being treated as arbitrary
/// JSON by anything that reads the column instead of the name.
const SKETCH_MIME: &str = "application/json";

fn insert_sketch(
    conn: &Connection,
    name: &str,
    doc: &Sketch,
    source: &str,
) -> Result<FileMeta, String> {
    let unique = db::available_name(conn, &sketch_name(name))?;
    let json = doc.to_json();
    db::insert_file(conn, &unique, SKETCH_MIME, json.as_bytes(), Some(&doc.extracted_text()), source)
}

// ---------------------------------------------------------------------------
// Commands the page calls
// ---------------------------------------------------------------------------

/// Start a new drawing. Loading and saving ride the ordinary file commands
/// (`update_file_content` re-extracts the labels on every save), so this is
/// the only command the page needs that does not already exist.
#[tauri::command]
pub fn create_sketch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<FileMeta, String> {
    // Section-only: a new drawing belongs to Sketches, and appears in Home only
    // when the person who made it says so ("Add to Library"). Same encrypted
    // room file either way — see `db::mark_section_only`.
    let meta = state.with_room(|room| {
        let meta = insert_sketch(&room.conn, &name, &Sketch::default(), "upload")?;
        db::mark_section_only(&room.conn, &meta.id, "sketch");
        db::get_file_meta(&room.conn, &meta.id)
    })?;
    let _ = app.emit("room-files-changed", ());
    Ok(meta)
}

/// Save a drawing. The path a person's own drawing takes, several times a
/// minute, for as long as they are drawing.
///
/// This exists because `update_file_content` — right for a document you press
/// Save on — is three expensive things a drawing cannot afford on every
/// stroke:
///
/// 1. it copies the WHOLE file into version history, so two minutes of drawing
///    left a hundred near-identical versions and a hundred blob writes;
/// 2. it rebuilds the search index;
/// 3. it broadcasts `room-files-changed`, which makes the Library, the sketch
///    gallery and the viewer itself all re-read — while the pointer is still
///    down.
///
/// Together those made the canvas stutter and, with a big drawing, stall
/// outright (live QA 2026-08-13: "its saved each change its not good, this is
/// why its stucks"). So the autosave is a plain content write, and history is
/// taken ONCE per editing session — `snapshot` is true on the editor's first
/// save after opening the file. That keeps the meaningful promise ("get back
/// what this looked like before I started today") without paying for it sixty
/// times an hour; fine-grained undo is ⌘Z, which never needed the database.
#[tauri::command]
pub fn save_sketch(
    state: State<'_, AppState>,
    id: String,
    doc: String,
    snapshot: bool,
) -> Result<(), String> {
    state.with_room(|room| write_sketch(&room.conn, &id, &doc, snapshot))
}

/// The body of `save_sketch`, so the rules it enforces are testable without a
/// running app.
fn write_sketch(conn: &Connection, id: &str, doc: &str, snapshot: bool) -> Result<(), String> {
    // Parse BEFORE writing. A save is the one moment a malformed document can
    // become the file itself, and a drawing that will not open is worse than a
    // save that refused.
    let parsed = Sketch::from_json(doc)?;
    if snapshot {
        db::snapshot_file_version(conn, id, "Before you drew")?;
    }
    db::update_file_content(conn, id, doc.as_bytes(), Some(&parsed.extracted_text()))
}

/// Flatten a drawing into a standalone `.svg` room file.
///
/// The SVG kind already exists in this app, with its own viewer, its own
/// source view and label extraction, so an exported drawing is immediately a
/// first-class document rather than a dead end.
#[tauri::command]
pub fn export_sketch_svg(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<FileMeta, String> {
    let meta = state.with_room(|room| {
        let name = db::get_file_name(&room.conn, &id)?;
        let doc = load(&room.conn, &id)?;
        let stem = name.trim_end_matches(&format!(".{SKETCH_EXT}"));
        let svg = sketchdoc::to_svg(&doc);
        let unique = db::available_name(&room.conn, &format!("{stem}.svg"))?;
        let text = extraction::extract_text(&unique, svg.as_bytes());
        db::insert_file(
            &room.conn,
            &unique,
            "image/svg+xml",
            svg.as_bytes(),
            text.as_deref(),
            "generated",
        )
    })?;
    let _ = app.emit("room-files-changed", ());
    Ok(meta)
}

/// Flatten a drawing into a standalone `.png` room file.
///
/// The same rasteriser the agent looks through (`to_png`), so what someone
/// exports and what the model sees are one picture. SVG stays the better
/// export — it is the one that can be reopened and edited — but a PNG is what
/// goes into a message, a document, or anywhere that will not take a vector.
#[tauri::command]
pub fn export_sketch_png(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<FileMeta, String> {
    let meta = state.with_room(|room| {
        let name = db::get_file_name(&room.conn, &id)?;
        let doc = load(&room.conn, &id)?;
        let stem = name.trim_end_matches(&format!(".{SKETCH_EXT}"));
        let png = sketchdoc::to_png(&doc)?;
        let unique = db::available_name(&room.conn, &format!("{stem}.png"))?;
        // The labels, so an exported picture is still searchable in the room
        // it came from — a flat image nobody can find again is a dead end.
        let text = doc.extracted_text();
        db::insert_file(
            &room.conn,
            &unique,
            "image/png",
            &png,
            if text.trim().is_empty() { None } else { Some(text.as_str()) },
            "generated",
        )
    })?;
    let _ = app.emit("room-files-changed", ());
    Ok(meta)
}

// ---------------------------------------------------------------------------
// The agent's tools
// ---------------------------------------------------------------------------

/// The script grammar, written once and shown to the model in the one place it
/// needs it: the description of the argument it must fill.
///
/// Kept deliberately short. A tool description is paid for on every single
/// turn, in every context window, whether or not the tool is used — so this is
/// the grammar and one worked example, and nothing else.
/// Compressed on purpose.
///
/// A tool description is paid for in EVERY context window on EVERY turn,
/// whether or not the tool is used, and the tier catalogs are already close to
/// their token budgets. The full grammar with worked examples lives in the two
/// places that cost nothing until they are needed: the drawing agent's own
/// system prompt, and `sketchdoc::SCRIPT_HELP`, which is returned in full the
/// first time a script fails to parse. A model that guesses wrong is taught
/// immediately; a model that never draws pays nothing for the lesson.
const SCRIPT_ARG_DOC: &str = "Commands, ONE PER LINE. Page 1600x1000, whole numbers, \
colours pink/yellow/green/blue/red.\n\
rect|ellipse X Y W H [colour] [fill] \"label\"\n\
text X Y [colour] [size] \"words\"\n\
arrow|line X1 Y1 X2 Y2 [colour] [\"label\"]\n\
link A B [colour] [\"label\"] = arrow BETWEEN two shapes; prefer over arrow\n\
move ID DX DY | label ID \"new\" | ink ID colour | delete ID | clear\n\
A/B/ID = an id on the page (e3), or #1/#2 = 1st/2nd shape this script draws.";

pub(crate) fn draw_tools_specs() -> Vec<serde_json::Value> {
    serde_json::json!([
        {"type": "function", "function": {"name": "draw",
            "description": "Draw on a room sketch. Put EVERY shape in one call's script — never one \
call per shape. Starts a new sketch if the name is new. Read it first when changing existing \
work, and see_drawing after to check.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Sketch to draw on; a new name starts one"},
                "script": {"type": "string", "description": SCRIPT_ARG_DOC}},
                "required": ["name", "script"]}}},
        {"type": "function", "function": {"name": "read_drawing",
            "description": "Look at a sketch: every shape with its id, position and label in draw's \
own commands, plus measured problems — overlaps, shapes off the page, unlabelled shapes, arrows \
that stop short. Use it before changing existing work, and again after drawing to check yourself.",
            "parameters": {"type": "object", "properties": {
                "name": {"type": "string", "description": "Which sketch; omit if the room has one"}}}}}
    ])
    .as_array()
    .cloned()
    .unwrap_or_default()
}

/// The tool names, for the reserved list and the sidecar's box.
///
/// Two, not three. An earlier cut had a separate `see_drawing` that returned
/// the same text as `read_drawing` with a picture attached — and two tools
/// whose results differ only in whether pixels ride along is exactly the
/// near-duplicate a 4B model picks between wrongly. Reading a drawing and
/// looking at one are now the same act.
pub(crate) const DRAW_TOOL_NAMES: &[&str] = &["draw", "read_drawing"];

/// How a drawing reads to a model: the script, then what is wrong with it.
fn describe(doc: &Sketch, name: &str) -> String {
    let mut out = format!("Drawing \"{name}\":\n{}", sketchdoc::to_script(doc));
    if doc.elements.is_empty() {
        out.push_str("(the page is empty)\n");
    }
    let notes = sketchdoc::layout_report(doc);
    if !notes.is_empty() {
        out.push_str("\nProblems with the layout:\n");
        for n in &notes {
            out.push_str("- ");
            out.push_str(n);
            out.push('\n');
        }
    }
    out
}

/// Look at a drawing.
///
/// Two halves, and the TEXT half carries the weight. A raster only helps a
/// model that reads pictures well, and the small local models this app is
/// built around do not; the measured layout report is exact on every engine,
/// needs no vision model, and names the fix for each problem it finds.
///
/// The picture is attached only when the chat model can already read images —
/// never by loading a separate local vision model to describe it, the way the
/// screen and video tools do. That fallback costs a multi-gigabyte model load
/// on a call the model may make after every edit, and what it returns for a
/// diagram ("a flowchart with several labelled boxes") is strictly less useful
/// than the measurements already above it.
pub(crate) fn tool_read_drawing(
    state: &AppState,
    effects: &mut super::agent::ToolEffects,
    args: &serde_json::Value,
) -> Result<String, String> {
    let name = args["name"].as_str().unwrap_or_default();
    let (real, doc, model) = state.with_room(|room| {
        let (id, real) = resolve(&room.conn, name)?;
        Ok((real, load(&room.conn, &id)?, super::model_setting(&room.conn)))
    })?;

    let mut out = describe(&doc, &real);
    if !doc.elements.is_empty() && sketchdoc::layout_report(&doc).is_empty() {
        out.push_str(
            "\nNothing measures wrong: no overlaps, nothing off the page, every shape labelled.\n",
        );
    }
    if !effects.vision_chat || doc.elements.is_empty() {
        return Ok(out);
    }

    // The pixels are this room's own drawing, so the door that governs them is
    // the one that governs its documents. A cloud model gets the text — which
    // passes the redaction door like any other tool result — and is told
    // plainly that it is not being shown the picture, rather than being handed
    // an image the door will strip and then asked to describe it.
    let local_chat = model.as_deref().is_none_or(super::agent::runs_on_this_mac);
    if !local_chat && crate::commands::privacy::active_policy().is_some() {
        out.push_str(
            "\n(Not showing you the picture: this room's privacy door keeps images on this Mac. \
             The measurements above describe the same drawing.)",
        );
        return Ok(out);
    }

    match sketchdoc::to_png(&doc) {
        Ok(png) => {
            use base64::Engine as _;
            effects.pending_images.push(base64::engine::general_purpose::STANDARD.encode(png));
            out.push_str(
                "\nThe drawing is attached as a picture — look at it before you change anything.",
            );
        }
        // A rendering failure must not lose the report, which is the greater
        // half of the answer and is already built.
        Err(why) => out.push_str(&format!("\n(The picture could not be drawn: {why})")),
    }
    Ok(out)
}

pub(crate) fn tool_draw(
    state: &AppState,
    window: &tauri::Window,
    args: &serde_json::Value,
) -> Result<String, String> {
    let name = args["name"].as_str().unwrap_or_default().trim().to_string();
    let script = args["script"].as_str().unwrap_or_default();
    if name.is_empty() {
        return Err("Say which sketch to draw on — a new name starts a new drawing.".into());
    }

    let (id, real, created, outcome, doc) = state.with_room(|room| {
        // An unknown name is a NEW drawing rather than an error. The result
        // says which of the two happened, because a typo that quietly created
        // "Login flwo" beside the real drawing is otherwise invisible until
        // the user opens the Library.
        let (id, real, created) = match resolve(&room.conn, &name) {
            Ok((id, real)) => (id, real, false),
            // An unknown name is a NEW drawing — but not necessarily a new
            // FILE. The overwhelmingly common way this feature is used is:
            // press "New sketch", look at the blank page, ask for a diagram.
            // Creating a second file there is correct by the letter and wrong
            // by every other measure — the user watches a blank canvas while
            // their diagram lands somewhere they have to go and find, and the
            // page they started is left behind as litter (live QA 2026-08-13).
            //
            // So an EMPTY sketch is claimed and renamed rather than orphaned.
            // Only an empty one: a drawing with anything on it is work, and
            // work is never silently repurposed.
            Err(_) => match take_empty_sketch(&room.conn, &name)? {
                Some((id, real)) => (id, real, false),
                None => {
                    let meta = insert_sketch(&room.conn, &name, &Sketch::default(), "generated")?;
                    // Section-only, exactly like one the user starts. A drawing
                    // is a drawing whoever made it: filing the assistant's in
                    // Home while the user's own stays in Sketches would make
                    // the rule depend on who held the pen, and would put an
                    // object in the Library that nobody asked to put there.
                    db::mark_section_only(&room.conn, &meta.id, "sketch");
                    (meta.id, meta.name, true)
                }
            },
        };
        let mut doc = load(&room.conn, &id)?;
        let outcome = sketchdoc::apply_script(&mut doc, script)?;
        if !outcome.is_empty() {
            save(&room.conn, &id, &doc, "The assistant drew")?;
        }
        Ok((id, real, created, outcome, doc))
    })?;

    // The page listens for this and reveals the new shapes one at a time, so a
    // drawing the agent made appears as it was drawn rather than all at once.
    //
    // The whole document rides along rather than just the ids. The editor
    // would otherwise have to re-read the file to find out what changed, and
    // between the write and that read the user can draw — which is exactly the
    // window in which a reload silently throws their stroke away.
    // Show the user the drawing they asked for.
    //
    // Without this, drawing on a sketch that is not the open one succeeds
    // silently: the model reports a finished diagram, the canvas on screen is
    // still blank, and the only way to find the work is to go looking in the
    // Library. Live QA 2026-08-13 hit exactly that on the very first try — a
    // sketch named "Sketch" was open, the model was asked for "Order flow", a
    // second file was created (correctly) and nothing on screen changed.
    // `open_file` already owns this event; a drawing owes the user the same.
    let _ = window.emit("agent-open-file", serde_json::json!({ "id": id }));
    let _ = window.emit(
        "sketch-drawn",
        serde_json::json!({
            "fileId": id,
            "name": real,
            "added": outcome.added,
            "changed": outcome.changed,
            "removed": outcome.removed,
            "steps": outcome.steps,
            "doc": doc.to_json(),
        }),
    );
    let _ = window.emit("room-files-changed", ());

    let opened = if created { format!("Started \"{real}\" and ") } else { String::new() };
    let mut msg = format!(
        "{opened}{} on \"{real}\". The page now holds {} thing(s).",
        outcome.summary(),
        doc.elements.len()
    );
    let notes = sketchdoc::layout_report(&doc);
    if !notes.is_empty() {
        msg.push_str("\n\nWorth fixing:\n");
        for n in notes.iter().take(8) {
            msg.push_str("- ");
            msg.push_str(n);
            msg.push('\n');
        }
        msg.push_str("Call see_drawing to look at it, then draw again to correct it.");
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live harness: does a REAL small model, given exactly the tool spec
    /// and prompt this app ships, write a script that parses into a sensible
    /// diagram?
    ///
    /// Every design decision in `sketchdoc` is a bet about what a 4B can do —
    /// that a flat positional line is easier than nested JSON, that `link` is
    /// easier than arrow arithmetic, that one bulk call beats nine. None of
    /// that is provable by unit tests, which only ever prove the parser agrees
    /// with itself. This runs the actual model.
    ///
    /// Ignored by default (it needs Ollama serving a model, and it costs real
    /// seconds). Permanent, like `tests/diar_bench.rs` — a harness, not a gate.
    ///
    /// ```text
    /// cargo test --lib sketch -- --ignored --nocapture live_
    /// SKETCH_MODEL=qwen3.5:4b-mlx SKETCH_TASKS=3 cargo test ... live_
    /// ```
    #[tokio::test]
    #[ignore]
    async fn live_a_real_model_draws_something_this_can_read() {
        const TASKS: &[(&str, &str)] = &[
            (
                "login flow",
                "Draw my login flow: a login form sends credentials to an auth service, \
                 and the auth service issues a token to a session store.",
            ),
            (
                "three boxes",
                "Draw three boxes in a row labelled Draft, Review and Published, with \
                 arrows from each one to the next.",
            ),
            (
                "annotate",
                "Draw a big circle labelled Sun in the middle of the page, and write the \
                 note \"about 150 million km away\" under it in red.",
            ),
        ];

        let model =
            std::env::var("SKETCH_MODEL").unwrap_or_else(|_| "qwen3.5:4b-mlx".to_string());
        let want: usize = std::env::var("SKETCH_TASKS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(TASKS.len());
        let spec = draw_tools_specs();
        let draw_spec = spec
            .iter()
            .find(|s| s["function"]["name"] == "draw")
            .expect("the draw tool must exist");

        let mut passed = 0usize;
        let mut notes: Vec<String> = Vec::new();
        for (name, task) in TASKS.iter().take(want) {
            let body = serde_json::json!({
                "model": model,
                "stream": false,
                "options": {"temperature": 0, "num_ctx": 8192},
                "tools": [draw_spec],
                "messages": [
                    {"role": "system",
                     "content": format!(
                        "You are the drawing agent inside a private workspace app.{}",
                        crate::commands::sketch::tests::draw_prompt_for_live()
                     )},
                    {"role": "user", "content": task},
                ],
            });
            let resp = reqwest::Client::new()
                .post("http://127.0.0.1:11434/api/chat")
                .json(&body)
                .send()
                .await
                .expect("Ollama must be running for the live harness");
            let v: serde_json::Value = resp.json().await.expect("Ollama returned no JSON");

            let call = v["message"]["tool_calls"][0]["function"].clone();
            if call["name"].as_str() != Some("draw") {
                notes.push(format!("{name}: the model did not call draw — {}", &v["message"]));
                continue;
            }
            // Ollama hands arguments back as an object; some builds stringify it.
            let args = match &call["arguments"] {
                serde_json::Value::String(s) => {
                    serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
                }
                other => other.clone(),
            };
            let script = args["script"].as_str().unwrap_or_default();
            println!("\n=== {name} ===\n{script}\n");

            let mut doc = Sketch::default();
            match sketchdoc::apply_script(&mut doc, script) {
                Ok(out) => {
                    let report = sketchdoc::layout_report(&doc);
                    println!("applied: {}\nlayout: {report:#?}", out.summary());
                    let png = sketchdoc::to_png(&doc).expect("should rasterise");
                    let path = format!("/tmp/sketch-live-{name}.png").replace(' ', "-");
                    std::fs::write(&path, png).ok();
                    println!("wrote {path}");
                    if doc.elements.is_empty() {
                        notes.push(format!("{name}: parsed but drew nothing"));
                    } else {
                        passed += 1;
                        if !report.is_empty() {
                            notes.push(format!("{name}: drew, with {} layout note(s)", report.len()));
                        }
                    }
                }
                Err(e) => notes.push(format!("{name}: REFUSED — {e}")),
            }
        }

        println!("\n--- live result: {passed}/{} tasks drew something readable ---", want);
        for n in &notes {
            println!("  · {n}");
        }
        assert!(
            passed >= want.div_ceil(2),
            "a real model could not drive these tools: {passed}/{want}\n{}",
            notes.join("\n")
        );
    }

    /// The drawing agent's own paragraph, as the sidecar would prepend it.
    /// Read from the Python source so the harness cannot drift from what ships.
    fn draw_prompt_for_live() -> String {
        let src = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/arcelle_sidecar/prompts.py"),
        )
        .expect("prompts.py should be readable");
        let start = src.find("DRAW_PROMPT = (").expect("DRAW_PROMPT should exist");
        let body = &src[start..];
        let end = body.find("\n)\n").expect("DRAW_PROMPT should be closed");
        // Pull the quoted string pieces out of the Python concatenation.
        let mut out = String::new();
        for line in body[..end].lines().skip(1) {
            let t = line.trim();
            let quoted = t.strip_prefix('"').and_then(|r| r.rfind('"').map(|i| &r[..i]));
            let quoted = quoted.or_else(|| t.strip_prefix('\'').and_then(|r| r.rfind('\'').map(|i| &r[..i])));
            if let Some(q) = quoted {
                out.push_str(&q.replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\"));
            }
        }
        out
    }

    #[test]
    fn a_name_gains_the_extension_but_never_twice() {
        assert_eq!(sketch_name("Login flow"), "Login flow.sketch");
        assert_eq!(sketch_name("Login flow.sketch"), "Login flow.sketch");
        assert_eq!(sketch_name("  "), "Sketch.sketch");
    }

    fn room() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(crate::db::SCHEMA).expect("schema");
        conn
    }

    fn add(conn: &Connection, name: &str) -> String {
        insert_sketch(conn, name, &Sketch::default(), "upload").unwrap().id
    }

    #[test]
    fn the_only_drawing_in_the_room_needs_no_name() {
        let c = room();
        let id = add(&c, "Only one");
        assert_eq!(resolve(&c, "").unwrap().0, id);
    }

    #[test]
    fn asking_for_nothing_with_several_drawings_lists_them_instead_of_guessing() {
        let c = room();
        add(&c, "First");
        add(&c, "Second");
        let err = resolve(&c, "").unwrap_err();
        assert!(err.contains("First") && err.contains("Second"), "{err}");
    }

    #[test]
    fn an_ambiguous_fragment_is_refused_rather_than_resolved_to_the_newest() {
        // `find_file_like` would silently pick the newest of these; for a
        // drawing the agent itself just made, that is a wrong-target write.
        let c = room();
        add(&c, "Login flow");
        add(&c, "Login flow old");
        let err = resolve(&c, "Login").unwrap_err();
        assert!(err.contains("matches 2"), "{err}");
    }

    #[test]
    fn the_extension_is_optional_when_naming_a_drawing() {
        let c = room();
        let id = add(&c, "Login flow");
        assert_eq!(resolve(&c, "Login flow").unwrap().0, id);
        assert_eq!(resolve(&c, "Login flow.sketch").unwrap().0, id);
        assert_eq!(resolve(&c, "login FLOW").unwrap().0, id);
    }

    #[test]
    fn an_empty_room_says_how_to_start_rather_than_that_nothing_matched() {
        let c = room();
        let err = resolve(&c, "anything").unwrap_err();
        assert!(err.contains("no drawings yet"), "{err}");
    }

    #[test]
    fn only_sketch_files_are_candidates() {
        let c = room();
        db::insert_file(&c, "notes.md", "text/markdown", b"hi", Some("hi"), "upload").unwrap();
        let err = resolve(&c, "notes").unwrap_err();
        assert!(err.contains("no drawings yet"), "{err}");
    }

    #[test]
    fn a_saved_drawing_indexes_its_labels_and_not_its_coordinates() {
        let c = room();
        let id = add(&c, "Flow");
        let mut doc = load(&c, &id).unwrap();
        sketchdoc::apply_script(&mut doc, "rect 250 400 320 130 blue \"Login form\"").unwrap();
        save(&c, &id, &doc, "test").unwrap();
        let text = db::get_file_extracted_text(&c, &id).unwrap_or_default();
        assert!(text.contains("Login form"), "{text}");
        assert!(!text.contains("320"), "coordinates reached the index: {text}");
        // And the bytes round-trip as a document.
        assert_eq!(load(&c, &id).unwrap().elements.len(), 1);
    }

    #[test]
    fn a_blank_sketch_is_claimed_rather_than_left_behind_as_litter() {
        // Live QA 2026-08-13: press "New sketch", then ask for a diagram. The
        // blank page stayed blank on screen, the diagram landed in a second
        // file, and the first was orphaned.
        let c = room();
        let blank = add(&c, "Sketch");
        let taken = take_empty_sketch(&c, "Order flow").unwrap().expect("should claim the blank");
        assert_eq!(taken.0, blank, "it must reuse the file, not make another");
        assert_eq!(taken.1, "Order flow.sketch");
        assert_eq!(list_sketches(&c).unwrap().len(), 1, "no second file");
    }

    #[test]
    fn a_drawing_with_work_on_it_is_never_repurposed() {
        let c = room();
        let id = add(&c, "Real work");
        let mut doc = load(&c, &id).unwrap();
        sketchdoc::apply_script(&mut doc, "rect 10 10 100 100 blue \"mine\"").unwrap();
        save(&c, &id, &doc, "test").unwrap();
        assert!(take_empty_sketch(&c, "Something else").unwrap().is_none());
        assert_eq!(db::get_file_name(&c, &id).unwrap(), "Real work.sketch");
    }

    #[test]
    fn the_newest_blank_page_is_the_one_claimed() {
        // The one the user just pressed the button for, and is looking at.
        let c = room();
        add(&c, "Old blank");
        let newest = add(&c, "Just made");
        assert_eq!(take_empty_sketch(&c, "Flow").unwrap().unwrap().0, newest);
    }

    #[test]
    fn drawing_for_a_while_leaves_one_version_not_one_per_stroke() {
        // Live QA 2026-08-13: "its saved each change its not good, this is why
        // its stucks". Every autosave used to copy the whole document into
        // version history — a hundred blob writes in two minutes of drawing.
        let c = room();
        let id = add(&c, "Flow");
        let mut doc = Sketch::default();
        for i in 0..25 {
            sketchdoc::apply_script(&mut doc, &format!("rect {} 10 80 60 blue \"b{i}\"", i * 20))
                .unwrap();
            // Only the first save of the session takes history, exactly as the
            // editor calls it.
            write_sketch(&c, &id, &doc.to_json(), i == 0).unwrap();
        }
        assert_eq!(
            db::list_file_versions(&c, &id).unwrap().len(),
            1,
            "an editing session is one version, not one per stroke"
        );
        assert_eq!(load(&c, &id).unwrap().elements.len(), 25, "and the work is all there");
    }

    #[test]
    fn the_session_snapshot_holds_what_the_page_looked_like_before() {
        let c = room();
        let id = add(&c, "Flow");
        let mut doc = Sketch::default();
        sketchdoc::apply_script(&mut doc, "rect 10 10 80 60 blue \"first\"").unwrap();
        write_sketch(&c, &id, &doc.to_json(), true).unwrap();
        let versions = db::list_file_versions(&c, &id).unwrap();
        assert_eq!(versions.len(), 1, "the blank page it started as");
    }

    #[test]
    fn a_malformed_document_is_refused_instead_of_becoming_the_file() {
        let c = room();
        let id = add(&c, "Flow");
        let mut doc = Sketch::default();
        sketchdoc::apply_script(&mut doc, "rect 10 10 80 60 blue \"keep me\"").unwrap();
        write_sketch(&c, &id, &doc.to_json(), false).unwrap();
        assert!(write_sketch(&c, &id, "{ not json", false).is_err());
        assert_eq!(
            load(&c, &id).unwrap().elements[0].label.as_deref(),
            Some("keep me"),
            "the good drawing must survive a bad save"
        );
    }

    #[test]
    fn saving_indexes_the_labels_and_not_the_document_source() {
        let c = room();
        let id = add(&c, "Flow");
        let mut doc = Sketch::default();
        sketchdoc::apply_script(&mut doc, "rect 250 400 320 130 blue \"Login form\"").unwrap();
        write_sketch(&c, &id, &doc.to_json(), false).unwrap();
        let text = db::get_file_extracted_text(&c, &id).unwrap_or_default();
        assert!(text.contains("Login form"), "{text}");
        assert!(!text.contains("320"), "coordinates reached the index: {text}");
    }

    #[test]
    fn a_second_drawing_with_the_same_name_gets_its_own() {
        let c = room();
        let a = insert_sketch(&c, "Flow", &Sketch::default(), "upload").unwrap();
        let b = insert_sketch(&c, "Flow", &Sketch::default(), "upload").unwrap();
        assert_ne!(a.name, b.name, "a duplicate name must not collide");
    }

    #[test]
    fn the_tool_descriptions_teach_the_one_command_that_prevents_bad_arrows() {
        // `link` is the whole reason generated diagrams connect properly; if it
        // ever stops being described, the model goes back to guessing endpoints.
        let specs = draw_tools_specs();
        let all = serde_json::to_string(&specs).unwrap();
        assert!(all.contains("link A B"), "the grammar must document link");
        assert!(all.contains("prefer over arrow"), "link must be preferred over raw arrows");
        assert!(all.contains("ONE PER LINE"), "the bulk instruction must survive");
        assert!(all.contains("EVERY shape in one call"), "the bulk instruction must survive");
        for name in DRAW_TOOL_NAMES {
            assert!(all.contains(&format!("\"{name}\"")), "{name} is not in the specs");
        }
    }

    #[test]
    fn every_draw_tool_takes_flat_string_arguments_only() {
        // The point of this whole tool surface: no nested objects, no arrays of
        // objects, nothing for a small model to mis-nest.
        for spec in draw_tools_specs() {
            let props = &spec["function"]["parameters"]["properties"];
            for (key, schema) in props.as_object().unwrap() {
                assert_eq!(
                    schema["type"], "string",
                    "{}.{key} is not a plain string",
                    spec["function"]["name"]
                );
            }
        }
    }
}
