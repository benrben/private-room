//! The Create page's story surface: a room's cast, and its shot lists.
//!
//! Thin by design — these commands move rows, and every judgement about what a
//! model can do lives in `create.rs` and `media_limits.rs`. The one piece of
//! real thinking here is `shot_prompt`, which turns a shot plus its cast into
//! the words a picture model is actually sent.

use super::*;
use crate::db;

/// Everything the Story tab draws itself from, in one round trip.
///
/// One command rather than three, because the tab is useless with a partial
/// answer: a shot naming two heroes cannot be drawn without the cast, and a
/// cast with no list has nothing to appear in.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoryBoard {
    pub cast: Vec<db::CastMember>,
    pub lists: Vec<db::StoryList>,
    /// The shots of `selected`, or empty when no list is chosen.
    pub shots: Vec<db::StoryShot>,
    pub selected: Option<String>,
}

/// How many characters may ride along in one generation.
///
/// A ceiling of our own, under every published one (the most generous image
/// model in the live catalogue takes 16; several take 4). References are
/// billed on some models and diluting a prompt with a dozen faces makes a
/// worse picture, not a fuller one.
pub(crate) const MAX_SHOT_CAST: usize = 4;

/// The words one shot is drawn from.
///
/// The cast is named and described here even though their portraits are also
/// attached, and that is deliberate: the picture holds the FACE together, the
/// text says what they are DOING. A reference with no words gets a portrait
/// back rather than a scene.
pub(crate) fn shot_prompt(action: &str, cast: &[db::CastMember], logline: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !logline.trim().is_empty() {
        parts.push(logline.trim().to_string());
    }
    for member in cast {
        let described = member.description.trim();
        if described.is_empty() {
            parts.push(member.name.trim().to_string());
        } else {
            parts.push(format!("{} — {described}", member.name.trim()));
        }
    }
    let action = action.trim();
    if !action.is_empty() {
        parts.push(action.to_string());
    }
    parts.retain(|p| !p.is_empty());
    parts.join(". ")
}

fn board(conn: &rusqlite::Connection, selected: Option<String>) -> Result<StoryBoard, String> {
    let lists = db::list_story_lists(conn)?;
    // Fall back to the most recently touched list rather than showing an empty
    // tab: the common case is one story per room, and asking the user to pick
    // it every time is a step that never earns itself.
    let selected = selected
        .filter(|id| lists.iter().any(|l| &l.id == id))
        .or_else(|| lists.first().map(|l| l.id.clone()));
    let shots = match &selected {
        Some(id) => db::list_shots(conn, id)?,
        None => Vec::new(),
    };
    Ok(StoryBoard {
        cast: db::list_cast(conn)?,
        lists,
        shots,
        selected,
    })
}

#[tauri::command]
pub fn story_board(state: State<'_, AppState>, list_id: Option<String>) -> Result<StoryBoard, String> {
    state.with_room(|room| board(&room.conn, list_id))
}

/// One room picture, small enough to draw a hundred of.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomPicture {
    pub file_id: String,
    pub name: String,
    /// A downscaled JPEG, base64. Around 4 KB against the several megabytes
    /// the original weighs.
    pub thumb_b64: String,
}

/// The longest edge of a preview. Big enough to recognize a face, small
/// enough that a hundred of them cost less than one real picture.
const THUMB_EDGE: u32 = 192;

/// How many pictures the picker offers. A cap rather than the whole room: the
/// list is for choosing a face or a starting frame, and decoding a thousand
/// images to fill a scroll nobody reaches is a page that takes seconds to open.
/// Newest first, because a picture just generated is the one being reached for.
const PICKER_LIMIT: usize = 150;

fn thumb_cache() -> &'static std::sync::RwLock<std::collections::HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<
        std::sync::RwLock<std::collections::HashMap<String, String>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Every picture in this room, as thumbnails to choose from.
///
/// Thumbnails rather than the real bytes, and this is the whole reason the
/// command exists: the picker shows every picture at once, and streaming a
/// hundred full-size images through the media scheme to draw them 100 pixels
/// wide would cost hundreds of megabytes to display a few kilobytes of
/// information. Cached by file id, since a picture's bytes never change —
/// an edit writes a new file.
#[tauri::command]
pub fn story_pictures(state: State<'_, AppState>) -> Result<Vec<RoomPicture>, String> {
    let files = state.with_room(|room| db::list_files(&room.conn))?;
    let pictures: Vec<crate::commands::FileMeta> = files
        .into_iter()
        .filter(|f| f.mime_type.starts_with("image/"))
        .take(PICKER_LIMIT)
        .collect();

    let mut out = Vec::with_capacity(pictures.len());
    for meta in pictures {
        if let Some(cached) = thumb_cache().read().ok().and_then(|c| c.get(&meta.id).cloned()) {
            out.push(RoomPicture {
                file_id: meta.id,
                name: meta.name,
                thumb_b64: cached,
            });
            continue;
        }
        let bytes = match state.with_room(|room| db::get_file_bytes(&room.conn, &meta.id)) {
            Ok(Some(bytes)) => bytes,
            _ => continue,
        };
        // A picture that will not decode is skipped, not fatal. One corrupt
        // file must not empty the whole picker.
        let Some(thumb) = shrink(&bytes) else { continue };
        if let Ok(mut cache) = thumb_cache().write() {
            cache.insert(meta.id.clone(), thumb.clone());
        }
        out.push(RoomPicture {
            file_id: meta.id,
            name: meta.name,
            thumb_b64: thumb,
        });
    }
    Ok(out)
}

/// Decode, downscale, re-encode as JPEG. `None` for anything unreadable.
fn shrink(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    let decoded = image::load_from_memory(bytes).ok()?;
    let small = decoded.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut buffer = std::io::Cursor::new(Vec::new());
    // RGB8, because a JPEG encoder given an alpha channel errors out — and
    // a PNG with transparency is exactly what this room generates.
    small
        .to_rgb8()
        .write_to(&mut buffer, image::ImageFormat::Jpeg)
        .ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(buffer.into_inner()))
}

#[tauri::command]
pub fn story_add_cast(
    state: State<'_, AppState>,
    name: String,
    description: String,
    story: String,
) -> Result<db::CastMember, String> {
    if name.trim().is_empty() {
        return Err("Give them a name first.".into());
    }
    state.with_room(|room| db::add_cast_member(&room.conn, &name, &description, &story))
}

#[tauri::command]
pub fn story_update_cast(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: String,
    story: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Give them a name first.".into());
    }
    state.with_room(|room| db::update_cast_member(&room.conn, &id, &name, &description, &story))
}

/// Pin a room picture as someone's face — or clear it with `None`.
///
/// The file is checked to be a picture here rather than at generation time.
/// A PDF pinned as a face fails only when the user presses Make it, minutes
/// and one paid call later, with an error from a provider that has no idea
/// who this person is.
#[tauri::command]
pub fn story_set_face(
    state: State<'_, AppState>,
    id: String,
    file_id: Option<String>,
) -> Result<(), String> {
    state.with_room(|room| {
        if let Some(file) = file_id.as_deref() {
            let meta = db::get_file_meta(&room.conn, file)?;
            if !meta.mime_type.starts_with("image/") {
                return Err(format!(
                    "“{}” is not a picture, so it cannot be a face.",
                    meta.name
                ));
            }
        }
        db::set_cast_face(&room.conn, &id, file_id.as_deref())
    })
}

#[tauri::command]
pub fn story_remove_cast(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::remove_cast_member(&room.conn, &id))
}

#[tauri::command]
pub fn story_create_list(
    state: State<'_, AppState>,
    title: String,
    logline: String,
) -> Result<String, String> {
    state.with_room(|room| db::create_story_list(&room.conn, &title, &logline))
}

#[tauri::command]
pub fn story_update_list(
    state: State<'_, AppState>,
    id: String,
    title: String,
    logline: String,
) -> Result<(), String> {
    state.with_room(|room| db::update_story_list(&room.conn, &id, &title, &logline))
}

/// The frame shape and output size for a whole list.
///
/// Nothing is validated against a model here on purpose. Which sizes are legal
/// depends on the model each shot happens to be pointing at, and those change
/// after this is set — so the check belongs at the one place that knows the
/// model for certain, `check_media_shape`, which drops a size the model does
/// not publish rather than refusing the generation over it.
#[tauri::command]
pub fn story_set_shape(
    state: State<'_, AppState>,
    id: String,
    aspect_ratio: String,
    still_resolution: String,
    clip_resolution: String,
) -> Result<(), String> {
    state.with_room(|room| {
        db::set_story_shape(
            &room.conn,
            &id,
            &aspect_ratio,
            &still_resolution,
            &clip_resolution,
        )
    })
}

#[tauri::command]
pub fn story_delete_list(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::delete_story_list(&room.conn, &id))
}

#[tauri::command]
pub fn story_add_shot(
    state: State<'_, AppState>,
    list_id: String,
    action: String,
) -> Result<db::StoryShot, String> {
    state.with_room(|room| db::add_shot(&room.conn, &list_id, &action))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn story_update_shot(
    state: State<'_, AppState>,
    id: String,
    action: String,
    cast_ids: Vec<String>,
    seconds: Option<u32>,
    image_model: String,
    video_model: String,
) -> Result<(), String> {
    // Truncated rather than refused: the user dragged a fifth face onto a shot,
    // which is a preference, not an error worth stopping their work for.
    let cast_ids: Vec<String> = cast_ids.into_iter().take(MAX_SHOT_CAST).collect();
    state.with_room(|room| {
        db::update_shot(
            &room.conn,
            &id,
            &action,
            &cast_ids,
            seconds,
            &image_model,
            &video_model,
        )
    })
}

#[tauri::command]
pub fn story_remove_shot(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.with_room(|room| db::remove_shot(&room.conn, &id))
}

/// One room file that has readable text in it.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomDocument {
    pub file_id: String,
    pub name: String,
    /// Roughly how much is in it, so a 200-word note and a 40-page script are
    /// told apart before either is opened.
    pub words: usize,
    /// The opening line or two, so the right file is recognisable without
    /// having to open three of them.
    pub snippet: String,
}

/// How many documents the picker offers. Newest first, because a script just
/// imported is the one being reached for.
const DOC_LIMIT: usize = 200;

/// Every room file with text in it — the ones a script or a cast can come from.
///
/// This is the whole answer to "why am I retyping something I already have".
/// Files with no extracted text are left out rather than listed and then found
/// to be empty: a picture or a zip has nothing to offer here, and offering it
/// costs a click and a puzzled moment.
#[tauri::command]
pub fn story_documents(state: State<'_, AppState>) -> Result<Vec<RoomDocument>, String> {
    state.with_room(|room| {
        let mut stmt = room
            .conn
            .prepare(
                "SELECT id, name, substr(extracted_text, 1, 240),
                        length(extracted_text)
                   FROM files
                  WHERE trashed_at IS NULL
                    AND extracted_text IS NOT NULL
                    AND trim(extracted_text) <> ''
                  ORDER BY created_at DESC
                  LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![DOC_LIMIT as i64], |r| {
                let snippet: String = r.get(2)?;
                let chars: i64 = r.get(3)?;
                Ok(RoomDocument {
                    file_id: r.get(0)?,
                    name: r.get(1)?,
                    // A word estimate off the character count. Counting for
                    // real would mean loading every document to draw a list.
                    words: (chars.max(0) as usize) / 6,
                    snippet: snippet.split_whitespace().collect::<Vec<_>>().join(" "),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
}

/// The whole text of one room file, for the script box.
///
/// Whole, not clamped. A clamp here would be the `#minutes` bug again — that
/// one capped every file at 6 KB and turned an hour of transcript into its
/// first five minutes, silently. A five-minute script is about 4 KB, and the
/// user pasting it by hand would have pasted all of it.
#[tauri::command]
pub fn story_text_from_file(state: State<'_, AppState>, file_id: String) -> Result<String, String> {
    state.with_room(|room| {
        let (name, _mime, _bytes, text) = db::get_file_full(&room.conn, &file_id)?;
        let text = text.unwrap_or_default();
        if text.trim().is_empty() {
            return Err(format!(
                "“{name}” has no readable text in this room. If it is a PDF or a \
                 scan, open it once so the room can read it."
            ));
        }
        Ok(text)
    })
}

/// Who a document describes — read, shown, and only then kept.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CastFromFile {
    pub name: String,
    pub found: Vec<crate::commands::castparse::ParsedMember>,
    /// WHICH reader produced this — the room's model, or the pattern reader.
    /// On screen, because the two are not equally trustworthy on a messy file
    /// and "why did it split this wrong" is unanswerable without it.
    pub read_by: String,
    /// Set when the model was meant to read it and could not, so the fallback
    /// result is never passed off as the model's work.
    pub fell_back: Option<String>,
}

/// Read a character sheet the room already holds.
///
/// **The room's own model reads it.** The first version of this matched
/// headings and labels in Rust, and the reasoning for that was sound —
/// a pattern reader is free, instant, offline, and structurally incapable of
/// inventing a hero. It also broke on the first real document it met. Real
/// character sheets have nested lists, tables, numbered entries, appearances
/// split across bullets under a sub-heading; the shapes a pattern reader
/// handles are the shapes of a *tidy* sheet, which is not the same thing as a
/// real one.
///
/// The invention risk that argued for patterns is answered a better way: this
/// writes NOTHING. Every person comes back to be looked at and edited, and the
/// preview is what makes a model safe here — see `CastFromFileReview`.
///
/// The pattern reader stays as the fallback for a room with no model, or a
/// model that is down, and the answer says which one read the file.
#[tauri::command]
pub async fn story_read_cast_file(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<CastFromFile, String> {
    // Read out of the room and let the lock go BEFORE the model call: holding
    // it across a generation blocks every other reader for its duration.
    let (name, text, model) = state.with_room(|room| {
        let (name, _mime, _bytes, text) = db::get_file_full(&room.conn, &file_id)?;
        let text = text.unwrap_or_default();
        if text.trim().is_empty() {
            return Err(format!("“{name}” has no readable text in this room."));
        }
        Ok((
            name,
            text,
            crate::commands::model_setting(&room.conn).unwrap_or_default(),
        ))
    })?;

    if model.trim().is_empty() {
        return Ok(CastFromFile {
            found: crate::commands::castparse::parse_cast(&text),
            name,
            read_by: PATTERN_READER.into(),
            fell_back: Some(
                "This room has no AI model set, so the file was read by pattern \
                 matching — headings, bold names and `Name:` lines. Set a model \
                 in Settings for a messy sheet."
                    .into(),
            ),
        });
    }

    let request = serde_json::json!({
        // `sidecar_json` attaches the room's privacy policy AND mints the
        // provider key off the back of this field — a body without it would be
        // an outbound seam the door never sees.
        "model": model,
        "base_url": crate::ollama::resolved_base_url(),
        "mode": "cast",
        "document": text,
        "temperature": 0.0,
        "keep_alive": crate::commands::KEEP_ALIVE_WARM,
    });
    match crate::sidecar::sidecar_json("/knowledge_extract", &request).await {
        Ok(reply) => {
            let found: Vec<crate::commands::castparse::ParsedMember> =
                serde_json::from_value(reply["cast"].clone()).unwrap_or_default();
            Ok(CastFromFile {
                found,
                name,
                read_by: model,
                fell_back: None,
            })
        }
        // The model was asked and could not answer. Falling back silently would
        // present pattern-matched rows as the model's reading, and the user
        // would judge the model by them.
        Err(e) => Ok(CastFromFile {
            found: crate::commands::castparse::parse_cast(&text),
            name,
            read_by: PATTERN_READER.into(),
            fell_back: Some(format!(
                "{} could not read it ({}), so this is pattern matching instead — \
                 headings, bold names and `Name:` lines. Check it closely.",
                model,
                e.error.trim_end_matches('.')
            )),
        }),
    }
}

/// What the fallback reader is called on screen.
const PATTERN_READER: &str = "pattern matching";

/// Keep the people that survived the preview.
///
/// A face is not set here — a hero's picture is a separate, deliberate choice
/// from the room's own pictures, and guessing one from a filename would put
/// the wrong person's portrait into every shot they appear in.
#[tauri::command]
pub fn story_add_cast_many(
    state: State<'_, AppState>,
    members: Vec<crate::commands::castparse::ParsedMember>,
) -> Result<usize, String> {
    let members: Vec<_> = members
        .into_iter()
        .filter(|m| !m.name.trim().is_empty())
        .take(crate::commands::castparse::MAX_FOUND)
        .collect();
    if members.is_empty() {
        return Err("Nobody to add.".into());
    }
    state.with_room(|room| {
        let mut added = 0usize;
        for member in &members {
            db::add_cast_member(&room.conn, &member.name, &member.description, &member.story)?;
            added += 1;
        }
        Ok(added)
    })
}

/// One shot a split would produce.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlannedShot {
    pub action: String,
    /// This shot's own length. Per shot, not one number for all of them: a
    /// real script has a ten-second beat in it, and flattening that to
    /// fifteen changes the author's pacing without saying so.
    pub seconds: u32,
}

/// What a split would produce, before anything is written.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShotPlan {
    pub parts: usize,
    pub total_seconds: u32,
    /// Each shot, so the page can show the split before it is committed. A
    /// five-minute script becoming twenty rows is a big edit to perform
    /// without a preview.
    pub shots: Vec<PlannedShot>,
    /// True when the SCRIPT declared its own chunks and they were used, rather
    /// than the room cutting it by length. Worth saying on screen: the two
    /// produce very different results and the user should know which happened.
    pub from_script: bool,
}

/// Cut a script into shots of a fixed length — the whole point of the feature.
///
/// No model is asked. See `shotsplit.rs`: it is free, it is instant, nothing
/// leaves the Mac, and — the part that matters — no word can go missing, which
/// is not a promise a model can make about a five-minute script.
#[tauri::command]
pub fn story_plan_split(
    script: String,
    minutes: f64,
    seconds_each: u32,
) -> Result<ShotPlan, String> {
    use crate::commands::shotsplit;

    // THE SCRIPT'S OWN CHUNKS WIN. A script written as `**00:00–00:15** — …`
    // has already been broken into shots by its author, with the lengths they
    // chose. Re-cutting that by character count puts boundaries in the middle
    // of their beats and silently reflows their pacing — so the room only
    // decides where the cuts go when nobody has decided already.
    if let Some(chunks) = shotsplit::script_chunks(&script) {
        let shots: Vec<PlannedShot> = chunks
            .into_iter()
            .take(shotsplit::MAX_PARTS)
            .map(|c| PlannedShot { action: c.action, seconds: c.seconds })
            .collect();
        return Ok(ShotPlan {
            parts: shots.len(),
            total_seconds: shots.iter().map(|s| s.seconds).sum(),
            shots,
            from_script: true,
        });
    }

    let seconds_each = seconds_each.clamp(1, 60);
    // The runtime the user asked for, not one derived from the script's
    // length: how long the words take to say is a judgement only they can
    // make, and guessing it would silently change the shape of their episode.
    //
    // A runtime of ZERO is not a request for one shot — it is an empty or
    // half-typed field, and answering it with a single 15-second shot for a
    // five-minute script is the failure this `max` exists to prevent.
    let asked = (minutes.max(0.0) * 60.0).round() as u32;
    let total = if asked == 0 { seconds_each } else { asked.max(seconds_each) };
    let parts = shotsplit::parts_for(total, seconds_each);
    let shots: Vec<PlannedShot> = shotsplit::split_script(&script, parts)
        .into_iter()
        .map(|action| PlannedShot { action, seconds: seconds_each })
        .collect();
    Ok(ShotPlan {
        parts: shots.len(),
        total_seconds: shots.iter().map(|s| s.seconds).sum(),
        shots,
        from_script: false,
    })
}

/// The nearest length this model will actually film.
///
/// A script's own timings are the author's, not the provider's: a 10-second
/// beat is perfectly reasonable and Veo will only make 4, 6 or 8. Snapping to
/// the nearest legal value keeps the pacing as close as the model allows,
/// where sending 10 would simply be refused after the wait.
fn snap_seconds(seconds: u32, model: &str) -> u32 {
    let slug = model.split("::").nth(1).unwrap_or(model);
    let Some(limits) = crate::commands::media_limits::limits_for(slug) else {
        return seconds;
    };
    if limits.durations.is_empty() || limits.allows_seconds(seconds) {
        return seconds;
    }
    limits
        .durations
        .iter()
        .copied()
        .min_by_key(|d| d.abs_diff(seconds))
        .unwrap_or(seconds)
}

/// Write a planned split into a list as real shots.
///
/// APPENDS rather than replaces. A split is a big edit, and silently deleting
/// shots the user has already drawn pictures for — which are paid work — is
/// not something a button labelled "break into shots" is allowed to do.
#[tauri::command]
pub fn story_apply_split(
    state: State<'_, AppState>,
    list_id: String,
    shots: Vec<PlannedShot>,
    image_model: String,
    video_model: String,
) -> Result<usize, String> {
    if shots.len() > crate::commands::shotsplit::MAX_PARTS {
        return Err(format!(
            "That is {} shots. This room writes at most {} in one go — each one \
             is a paid generation.",
            shots.len(),
            crate::commands::shotsplit::MAX_PARTS
        ));
    }
    state.with_room(|room| {
        // WHO IS IN EACH SHOT. This used to write `&[]` — nobody — for every
        // shot a split produced, and that one empty slice is the whole reason
        // a five-minute episode came back with a different lead in every
        // scene: with no cast on a shot, no portrait is attached, so the
        // model gets words alone and re-imagines the person on every call.
        // The tab's own copy says a character is a picture, not a
        // description; the split was quietly sending the description.
        let cast = db::list_cast(&room.conn)?;
        let assigned = assign_cast(&shots, &cast);
        let mut written = 0usize;
        for (index, planned) in shots.iter().enumerate() {
            let seconds = snap_seconds(planned.seconds.clamp(1, 60), &video_model);
            let shot = db::add_shot(&room.conn, &list_id, &planned.action)?;
            db::update_shot(
                &room.conn,
                &shot.id,
                &planned.action,
                assigned.get(index).map(Vec::as_slice).unwrap_or(&[]),
                Some(seconds),
                image_model.trim(),
                video_model.trim(),
            )?;
            written += 1;
        }
        Ok(written)
    })
}

/// Work out who is in each shot, from the shot's own words.
///
/// Two rules, and the second is the one that matters on a real script:
///
/// 1. **A name in the text puts that person in the shot.** Matched on the full
///    name and on the first name alone, because a cast sheet says "Mira
///    Halloran" and the script says "Mira". Whole words only — otherwise "Noa"
///    is found inside "Noah" and inside "no answer".
///
/// 2. **A shot that names nobody inherits the shot before it.** Screenplays
///    name a character once and then write "she" for the next four beats, so
///    literal matching alone would attach a face to a fifth of the shots and
///    leave the rest to be re-imagined from scratch. Inheriting is the
///    convention the writing already assumes: the scene is still going, the
///    same people are still in it.
///
/// Nothing is guessed beyond that. A shot before ANY name has appeared gets
/// nobody rather than the whole cast, because the opening of an episode is
/// usually a place, and pinning four faces to an establishing shot is worse
/// than pinning none.
pub(crate) fn assign_cast(
    shots: &[PlannedShot],
    cast: &[db::CastMember],
) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::with_capacity(shots.len());
    let mut carried: Vec<String> = Vec::new();
    for shot in shots {
        let haystack = shot.action.to_lowercase();
        let mut here: Vec<String> = Vec::new();
        for member in cast {
            if here.len() >= MAX_SHOT_CAST {
                break;
            }
            let full = member.name.trim().to_lowercase();
            if full.is_empty() {
                continue;
            }
            let first = full.split_whitespace().next().unwrap_or(&full).to_string();
            if names_appear(&haystack, &full) || names_appear(&haystack, &first) {
                here.push(member.id.clone());
            }
        }
        if here.is_empty() {
            here = carried.clone();
        } else {
            carried = here.clone();
        }
        out.push(here);
    }
    out
}

/// Is `needle` in `haystack` as a whole word?
///
/// Without the boundary test, a cast member called "Noa" is found inside
/// "Noah", inside "no answer" and inside "announce" — and every shot in the
/// episode gets her face whether she is in it or not.
fn names_appear(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let mut from = 0usize;
    while let Some(at) = haystack[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let before_ok = start == 0
            || !(bytes[start - 1] as char).is_alphanumeric();
        let after_ok = end >= bytes.len()
            || !(bytes[end] as char).is_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        from = start + needle.len().max(1);
        if from >= haystack.len() {
            break;
        }
    }
    false
}

#[tauri::command]
pub fn story_reorder_shots(
    state: State<'_, AppState>,
    list_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    state.with_room(|room| db::reorder_shots(&room.conn, &list_id, &ids))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planned(action: &str) -> PlannedShot {
        PlannedShot { action: action.into(), seconds: 15 }
    }

    #[test]
    fn a_split_puts_the_people_the_shot_names_into_it() {
        // THE BUG THIS PINS: `story_apply_split` wrote `&[]` for every shot, so
        // a 21-shot episode had nobody in any of it — no portrait attached, so
        // the model got words alone and drew a different lead in every scene.
        let cast = vec![member("Mira Halloran", "grey coat"), member("Doran", "broad")];
        let shots = [
            planned("Mira walks the length of the quay."),
            planned("Doran watches from the window."),
        ];
        let assigned = assign_cast(&shots, &cast);
        // Matched on the FIRST name too: the sheet says "Mira Halloran", the
        // script says "Mira".
        assert_eq!(assigned[0], vec!["Mira Halloran"]);
        assert_eq!(assigned[1], vec!["Doran"]);
    }

    #[test]
    fn a_shot_that_says_she_keeps_the_person_from_the_shot_before() {
        // A screenplay names someone once and then writes "she" for four
        // beats. Literal matching alone would put a face on a fifth of the
        // shots and re-imagine the rest from scratch.
        let cast = vec![member("Noa", "small, ink-stained hands")];
        let shots = [
            planned("Noa weaves through the market stalls."),
            planned("She stops. The noise drops away."),
            planned("Her hand closes on empty air."),
        ];
        let assigned = assign_cast(&shots, &cast);
        assert_eq!(assigned[0], vec!["Noa"]);
        assert_eq!(assigned[1], vec!["Noa"], "the scene is still going");
        assert_eq!(assigned[2], vec!["Noa"]);
    }

    #[test]
    fn an_opening_shot_before_anyone_is_named_gets_nobody() {
        // An establishing shot is a PLACE. Pinning four faces to it is worse
        // than pinning none — the model would put the whole cast in a shot of
        // an empty harbour.
        let cast = vec![member("Noa", "")];
        let shots = [planned("The market at first light. Empty."), planned("Noa arrives.")];
        let assigned = assign_cast(&shots, &cast);
        assert!(assigned[0].is_empty());
        assert_eq!(assigned[1], vec!["Noa"]);
    }

    #[test]
    fn a_name_inside_another_word_is_not_a_person() {
        // Without a whole-word test, "Noa" matches "Noah", "no answer" and
        // "announce" — and then every shot in the episode carries her face.
        let cast = vec![member("Noa", "")];
        let shots = [
            planned("Noah shuts the door. There is no answer."),
            planned("They announce the tide."),
        ];
        let assigned = assign_cast(&shots, &cast);
        assert!(assigned[0].is_empty(), "Noah and 'no answer' are not Noa");
        assert!(assigned[1].is_empty(), "nor is 'announce'");
    }

    #[test]
    fn a_crowd_scene_stops_at_the_per_shot_ceiling() {
        let cast: Vec<_> = ["Ada", "Bo", "Cai", "Dev", "Eli"]
            .iter()
            .map(|n| member(n, ""))
            .collect();
        let shots = [planned("Ada, Bo, Cai, Dev and Eli all arrive at once.")];
        assert_eq!(assign_cast(&shots, &cast)[0].len(), MAX_SHOT_CAST);
    }

    fn member(name: &str, description: &str) -> db::CastMember {
        db::CastMember {
            id: name.into(),
            name: name.into(),
            description: description.into(),
            story: String::new(),
            face_file_id: None,
            ord: 0,
        }
    }

    #[test]
    fn a_shot_prompt_says_who_is_there_and_what_they_do() {
        // The portraits hold the faces together; these words say what is
        // happening. A reference with no action returns a portrait, not a scene.
        let prompt = shot_prompt(
            "she cuts the mooring rope as the tide turns",
            &[member("Mira", "tall, grey coat"), member("Doran", "broad, scarred")],
            "one night on the harbour",
        );
        assert_eq!(
            prompt,
            "one night on the harbour. Mira — tall, grey coat. Doran — broad, scarred. \
             she cuts the mooring rope as the tide turns"
        );
    }

    #[test]
    fn a_character_with_no_description_still_gets_named() {
        // Their face is doing the work; an empty description must not produce
        // a dangling "Mira — " with nothing after it.
        assert_eq!(shot_prompt("waits", &[member("Mira", "")], ""), "Mira. waits");
        assert_eq!(shot_prompt("waits", &[member("Mira", "   ")], ""), "Mira. waits");
    }

    #[test]
    fn an_empty_shot_makes_an_empty_prompt_rather_than_punctuation() {
        // Which is what lets the job layer say "say what happens first"
        // instead of paying for a generation from a lone full stop.
        assert_eq!(shot_prompt("", &[], ""), "");
        assert_eq!(shot_prompt("   ", &[], "  "), "");
    }
}
