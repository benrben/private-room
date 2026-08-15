use super::*;

#[derive(Serialize, Deserialize, Clone)]
pub struct PodcastTurn {
    pub speaker: String,
    pub line: String,
}

/// D12: generate a two-host podcast SCRIPT as a self-contained HTML transcript
/// saved into the room — and, since the structured-first inversion, as DATA in
/// the `podcasts` table, so its hosts can be cast and the episode rendered to
/// audio without asking the model again. Same graceful-degradation contract as
/// the studios above.
#[tauri::command]
pub async fn generate_podcast_script(
    window: tauri::Window,
    state: State<'_, AppState>,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
    op_id: Option<String>,
) -> Result<FileMeta, String> {
    // A Studio button in the UI: its own root, nobody's child.
    run_studio(&window, &state, podcast_spec(), scope, instructions, refs, op_id, None).await
}

/// The podcast-script artifact spec for the shared `run_studio` pipeline.
///
/// STRUCTURED-FIRST, unlike its two siblings — see `StudioSpec::structured_first`.
/// The other studios produce a page and are done; this one produces a SCRIPT
/// that voices are later assigned to and audio rendered from, and turns that
/// only exist as markup cannot be spoken. Under the HTML-first pipeline the
/// structured shape appeared only on the fallback path, so most episodes came
/// out unrecordable.
pub(crate) fn podcast_spec() -> StudioSpec {
    StudioSpec {
        default_prompt: STUDIO_PODCAST_PROMPT,
        // Never used now (`structured_first` skips HTML authoring), and kept
        // rather than blanked so the field's meaning stays uniform across the
        // three specs and a future artifact copying this one is not shown an
        // empty page_role as if that were normal.
        page_role: "You are a front-end developer building a podcast transcript page for a warm, \
            two-host conversation that explains the material. Lay every turn out as its speaker's \
            name beside what they said, keep the two voices easy to tell apart by name. Base every \
            line only on the provided material.",
        working_label: "Writing the conversation",
        fallback_step: None,
        fallback_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                // The CAST, named explicitly rather than inferred from the
                // turns. A model that writes "Ada" in turn 1 and "Ada
                // Lovelace" in turn 7 produces two hosts, one of which has no
                // voice — asking for the roster up front is what makes the
                // speaker field a reliable join key.
                "hosts": {
                    "type": "array",
                    "description": "The two recurring hosts, exactly as they are named in every turn",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "persona": {"type": "string"}
                        },
                        "required": ["name"]
                    }
                },
                "turns": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "speaker": {"type": "string", "description": "Which host is talking — the name only"},
                            // Said out loud by a voice, so the NAME MUST NOT BE
                            // IN IT. `speaker` already carries it; repeating it
                            // here makes the host announce themselves before
                            // every line. Stripped defensively on the way in
                            // regardless — models format dialogue this way by
                            // habit — but asking correctly costs nothing.
                            "line": {"type": "string", "description": "Only the words this host speaks. Do NOT prefix it with their name — no \"Ada:\""}
                        },
                        "required": ["speaker", "line"]
                    }
                }
            },
            "required": ["title", "hosts", "turns"]
        }),
        fallback_system: "You write a short two-host podcast script that explains material in a warm, \
             conversational back-and-forth. Name the two hosts in `hosts`, then use those EXACT \
             names as the speaker of every turn — never a variation, a nickname or a title. Each \
             turn is what one host actually says out loud, so write it to be READ ALOUD: no stage \
             directions, no markdown, no bracketed asides, and NEVER begin a line with the \
             speaker's own name — `line` holds only the spoken words, never \"Ada:\". Keep each turn to a couple of sentences \
             and alternate between the hosts. Base everything on the provided text.",
        fallback_intro: "Base it only on this material about",
        fallback_temp: 0.5,
        render: fallback_podcast,
        filename_prefix: "Podcast script",
        structured_first: true,
        after_save: Some(store_podcast),
    }
}

/// Persist the script as data once its page is saved: the turns, the cast, and
/// the voice each host will read in.
///
/// Runs on the studio's `after_save` hook, so a failure here costs the extras
/// (voices, audio) and never the page. The cast is seeded with DISTINCT voices
/// from the room's last-known catalog — assigning the same voice twice would
/// make a two-host script sound like one narrator reading a dialogue, which is
/// the thing this whole feature exists to stop.
fn store_podcast(conn: &Connection, file_id: &str, raw: &str) -> Result<(), String> {
    let title = json_str_field(raw, "title")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Podcast".to_string());
    let mut turns: Vec<db::PodcastTurn> = json_array(raw, "turns")
        .iter()
        .filter_map(|t| {
            let speaker = value_str(t, "speaker");
            let speaker = if speaker.is_empty() { "Host".to_string() } else { speaker };
            // The model states the name twice — as the field and again inside
            // the text. Strip it here, or the host reads their own name aloud.
            let line = db::strip_speaker_label(&value_str(t, "line"), &speaker);
            (!line.is_empty()).then_some(db::PodcastTurn { speaker, line })
        })
        .collect();
    if turns.is_empty() {
        return Err("the script had no usable turns".into());
    }
    // The model's own `hosts` roster leads, because it is the one place the
    // cast is stated rather than inferred; the turns fill in anyone it forgot
    // to list but did give lines to.
    let declared: Vec<db::PodcastTurn> = json_array(raw, "hosts")
        .iter()
        .filter_map(|h| {
            let name = value_str(h, "name");
            (!name.is_empty()).then_some(db::PodcastTurn { speaker: name, line: String::new() })
        })
        .collect();
    let ordered: Vec<db::PodcastTurn> = declared.into_iter().chain(turns.iter().cloned()).collect();
    let cast = db::cast_from_turns(&ordered, &default_voice_ids(conn));
    // Fold every line's speaker onto the cast's spelling BEFORE storing, so the
    // voice lookup, the audio transcript and the panel all join on one string.
    db::normalize_turn_speakers(&mut turns, &cast);
    db::save_podcast(conn, file_id, &title, &turns, &cast)
}

/// Distinct voices to open a new cast with, best-first.
///
/// Read from the room's cached catalog rather than fetched: this runs inside
/// the room lock at the end of a build, and a network call there would hold
/// every other room operation behind a service round-trip. An empty list is
/// fine and common (a room that has never opened Settings → Spoken voice):
/// `cast_from_turns` then leaves the ids blank, which everywhere else means
/// "the product default", and the user picks real voices in the panel.
///
/// The room's OWN chosen voice leads the list, so the first host sounds like
/// the voice the user already decided they like.
fn default_voice_ids(conn: &Connection) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(chosen) = db::get_setting(conn, "voice_neural_id").filter(|v| !v.is_empty()) {
        ids.push(chosen);
    }
    for v in crate::commands::speech_cmds::cached_voice_ids(conn) {
        if !ids.contains(&v) {
            ids.push(v);
        }
    }
    ids
}

/// Fallback: parse structured turns and render the built-in podcast template.
/// The title defaults to the scope label when the model omits it.
fn fallback_podcast(raw: &str, label: &str) -> Result<String, String> {
    let title = json_str_field(raw, "title")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| label.trim().to_string());
    let turns: Vec<PodcastTurn> = json_array(raw, "turns")
        .iter()
        .filter_map(|t| {
            let speaker = value_str(t, "speaker");
            let speaker = if speaker.is_empty() { "Host".to_string() } else { speaker };
            // Same strip as the structured path: the page prints the speaker in
            // its own margin column, so a name left inside the line prints twice.
            let line = db::strip_speaker_label(&value_str(t, "line"), &speaker);
            (!line.is_empty()).then_some(PodcastTurn { speaker, line })
        })
        .collect();
    if turns.is_empty() {
        return Err("The model didn't return a usable script — try a different file.".into());
    }
    Ok(render_podcast_html(&title, &turns))
}

/// D12: render a two-host podcast script as a self-contained HTML transcript,
/// with the visible "audio is coming later" note. Turns are escaped in Rust and
/// built into static markup (no script needed).
pub(crate) fn render_podcast_html(title: &str, turns: &[PodcastTurn]) -> String {
    let mut rows = String::new();
    let mut speakers: Vec<String> = Vec::new();
    for t in turns {
        if !speakers.contains(&t.speaker) {
            speakers.push(t.speaker.clone());
        }
        let side = if speakers.first() == Some(&t.speaker) { "a" } else { "b" };
        rows.push_str(&format!(
            "<div class=\"turn {side}\"><div class=\"who\">{}</div><div class=\"line\">{}</div></div>\n",
            html_escape(&t.speaker),
            html_escape(&t.line)
        ));
    }
    fill_template(
        PODCAST_TEMPLATE,
        &[
            // One inlined copy of the notebook for every generated page — see
            // NOTEBOOK_CSS in docs_html.rs.
            ("__NOTEBOOK__", NOTEBOOK_CSS),
            ("__TITLE__", &html_escape(title)),
            ("__ROWS__", &rows),
        ],
    )
}

pub(crate) const PODCAST_TEMPLATE: &str = r####"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Podcast script</title>
<style>
__NOTEBOOK__
/* ---- the script: a ruled two-voice transcript -----------------------------
   Everything above comes from NOTEBOOK_CSS (docs_html.rs), the one inlined
   copy of src/styles/tokens.css. Nothing below restates a colour. */
.wrap{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.eyebrow{display:inline-block;font-size:var(--fs-micro);font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:.4rem}
h1{font-family:var(--sans);font-weight:700;font-size:var(--fs-page);line-height:1.15;letter-spacing:-.022em;color:var(--ink-strong);margin:.05rem 0 0}
.rule{height:3px;width:66px;border-radius:3px 2px 4px 2px / 2px 4px 2px 3px;background:linear-gradient(90deg,var(--accent-fill),color-mix(in srgb,var(--mk-berry) 30%,transparent));margin:1rem 0 1.6rem}
/* An INSTRUCTION — where to go to hear this — so it is set at reading size and
   in the "linked" blue rather than the pending yellow this note used to carry
   while audio was still unbuilt. Audio is a button now, and the note's only
   job is to say where that button is. */
.note{background:color-mix(in srgb,var(--mk-blue) 14%,transparent);border:var(--stroke-w) solid var(--sketch);border-left:3px solid var(--sem-linked-fill);border-radius:var(--radius);padding:.75rem .95rem;color:var(--ink);font-size:var(--fs-body);margin:0 0 2rem}
/* A ruled sheet: one pencil rule per turn, drawn across the page, with the
   transcript sitting on it rather than in a stack of bubbles. */
.script{counter-reset:cue;border-top:var(--stroke-w) solid var(--sketch)}
.turn{display:grid;grid-template-columns:2.6rem 7rem 1fr;column-gap:.9rem;padding:.9rem 0;border-bottom:1px solid var(--rule);counter-increment:cue}
/* The cue column is a pure CSS counter: deterministic, inert, and out of the
   accessibility tree, per the decoration rule. It is a TURN NUMBER and not a
   timecode — the model returns speakers and lines and no clock, so a printed
   timestamp would be a number this page invented. Mono with tabular figures,
   so the column rules straight down the sheet. */
.turn::before{content:counter(cue,decimal-leading-zero);font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:var(--fs-micro);color:var(--ink-muted);text-align:right;padding-top:.5rem;-webkit-user-select:none;user-select:none}
/* The speaker label is the one run of handwriting on the page: a name written
   in the margin is exactly the annotation the hand is for. Two voices are told
   apart by NAME first — it is always written out — so the hue is identity, the
   way tokens.css already gives each search engine a fixed marker ink, and
   never the only thing distinguishing them. */
.turn .who{font-family:var(--hand);font-size:var(--fs-hand);line-height:var(--lh-hand);text-align:right;padding-top:.15rem;overflow-wrap:anywhere}
.turn.a .who{color:var(--sem-saved)}
.turn.b .who{color:var(--sem-linked)}
/* `min-width:0`: a 1fr track floors at its content's min size, so one long
   unbreakable run in a line would widen the whole transcript rather than
   wrapping inside its column. */
.turn .line{padding-top:.15rem;min-width:0;overflow-wrap:anywhere}
/* Narrow frame (the viewer in a split pane): the margin column folds away and
   the name sits above its line rather than squeezing the transcript. */
@media (max-width:38rem){
  .turn{grid-template-columns:2.6rem 1fr;row-gap:.1rem}
  .turn .who{grid-column:2;text-align:left}
  .turn .line{grid-column:2}
}
@media print{
  .turn{break-inside:avoid;page-break-inside:avoid}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Podcast script</div>
  <h1>__TITLE__</h1>
  <div class="rule"></div>
  <div class="note">Open this file in Arcelle and use <b>Voices</b> to cast each host and record the episode as audio.</div>
  <div class="script">
__ROWS__
  </div>
</main>
</body>
</html>
"####;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn podcast_html_points_at_the_voices_panel_and_names_its_speakers() {
        // The page used to promise "audio narration is coming in a later
        // version". It has arrived, so the note now says where the button is —
        // a generated page that keeps advertising a missing feature is a lie
        // the app prints for the user itself.
        let turns = vec![
            PodcastTurn { speaker: "Ada".into(), line: "Welcome in.".into() },
            PodcastTurn { speaker: "Bo".into(), line: "Glad to be here.".into() },
        ];
        let html = render_podcast_html("Episode 1", &turns);
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("Voices"), "the note names the panel that records it");
        assert!(
            !html.contains("later version"),
            "the page must not still promise audio as a future feature",
        );
        assert!(html.contains("Ada") && html.contains("Bo"));
        // Second distinct speaker lands on the "b" side.
        assert!(html.contains("turn b"));
    }

    #[test]
    fn the_page_prints_each_speaker_once_not_twice() {
        // The page has a margin column for the speaker, so a name left inside
        // the line prints it twice — "Alex" beside "Alex: welcome in". This is
        // the same defect as the host reading their own name aloud, on the
        // surface the user sees first.
        let raw = r#"{"title":"Ep","hosts":[{"name":"Alex"},{"name":"Jordan"}],
            "turns":[{"speaker":"Alex","line":"Alex: welcome in"},
                     {"speaker":"Jordan","line":"Jordan: glad to be here"}]}"#;
        let html = fallback_podcast(raw, "Ep").unwrap();
        assert!(
            !html.contains("Alex: welcome in"),
            "the speaker label must not survive into the line",
        );
        assert!(html.contains(">welcome in<"), "the spoken words remain");
        assert!(html.contains(">Alex<"), "…and the name still labels the turn");
        // Ordinary prose keeps its colon.
        let prose = r#"{"title":"Ep","hosts":[{"name":"Alex"}],
            "turns":[{"speaker":"Alex","line":"Here's the thing: it works"}]}"#;
        assert!(fallback_podcast(prose, "Ep").unwrap().contains("Here's the thing: it works"));
    }

    #[test]
    fn the_podcast_studio_is_the_only_structured_first_artifact() {
        // The inversion is the podcast's alone: its turns must survive as data
        // because voices are assigned per speaker. Flashcards and mind maps are
        // pages, and nothing reads their parts back.
        assert!(podcast_spec().structured_first);
        assert!(podcast_spec().after_save.is_some());
        assert!(!super::super::flashcards_spec().structured_first);
        assert!(!super::super::mindmap_spec().structured_first);
        // The schema asks for the cast explicitly — the join key every voice
        // lookup depends on.
        let props = &podcast_spec().fallback_schema["properties"];
        assert!(props.get("hosts").is_some(), "the schema must ask for a roster");
    }
}
