use super::*;

#[derive(Serialize, Deserialize, Clone)]
pub struct PodcastTurn {
    pub speaker: String,
    pub line: String,
}

/// D12: generate a two-host podcast SCRIPT (no audio) as a self-contained HTML
/// transcript saved into the room. The page carries a visible note that audio
/// narration is a later version. Same graceful-degradation contract as the
/// studios above.
#[tauri::command]
pub async fn generate_podcast_script(
    window: tauri::Window,
    state: State<'_, AppState>,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
    op_id: Option<String>,
) -> Result<FileMeta, String> {
    use tauri::Emitter;
    // ADD-31: cancellable with visible stages (see studio_flashcards).
    let cancel = register_studio_cancel(&state, &op_id);
    let _cancel_guard = op_id.as_ref().map(|id| CancelGuard {
        state: state.inner(),
        ask_id: id.clone(),
    });
    let instr = studio_instruction(instructions, STUDIO_PODCAST_PROMPT);
    let _ = window.emit("studio-step", "Reading the material…");
    let (label, text) = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        match refs.as_ref().filter(|r| !r.is_empty()) {
            Some(ids) => gather_files_text(&room.conn, ids)?,
            None => gather_scope_text(&room.conn, scope.as_deref(), &room.name)?,
        }
    };
    let model = resolve_structured_model(&state)
        .await
        .ok_or("The local AI (Ollama) isn't running — start it and try again.")?;
    let _ = window.emit(
        "studio-step",
        if is_cloud_model(&model) {
            "Writing the conversation — the cloud model is writing…"
        } else {
            "Writing the conversation — a local model can take a few minutes…"
        },
    );
    let page_role = "You are a front-end developer building a podcast transcript page for a warm, \
        two-host conversation that explains the material. Style each speaker's turns distinctly \
        (name + line), keep it readable, and add a small note that spoken audio is coming in a later \
        version. Base every line only on the provided material.";
    let content = match generate_studio_html(&model, page_role, &instr, &label, &text, cancel.clone())
        .await?
    {
        Some(html) if !cancel.load(Ordering::SeqCst) => html,
        _ if cancel.load(Ordering::SeqCst) => return Err("Stopped.".into()),
        _ => {
            // Fallback: structured turns -> built-in template.
            let schema = serde_json::json!({
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "turns": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "speaker": {"type": "string"},
                                "line": {"type": "string"}
                            },
                            "required": ["speaker", "line"]
                        }
                    }
                },
                "required": ["title", "turns"]
            });
            let messages = vec![
                ollama::ChatMessage::new(
                    "system",
                    "You write a short two-host podcast script that explains material in a warm, \
                     conversational back-and-forth. Use two recurring host names as speakers. Keep each \
                     turn to a couple of sentences. Base everything on the provided text.",
                ),
                ollama::ChatMessage::new(
                    "user",
                    format!("{instr}\n\nBase it only on this material about \"{label}\":\n\n{text}"),
                ),
            ];
            let raw = ollama::chat_structured_cancel(
                &model,
                messages,
                Some(0.5),
                KEEP_ALIVE_WARM,
                &schema,
                cancel.clone(),
            )
            .await?;
            if cancel.load(Ordering::SeqCst) {
                return Err("Stopped.".into());
            }
            let parsed = serde_json::from_str::<serde_json::Value>(raw.trim()).ok();
            let title = parsed
                .as_ref()
                .and_then(|v| v.get("title").and_then(|s| s.as_str()))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&label)
                .trim()
                .to_string();
            let turns: Vec<PodcastTurn> = parsed
                .as_ref()
                .and_then(|v| v.get("turns").and_then(|t| t.as_array()).cloned())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| {
                            let speaker =
                                t.get("speaker").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                            let line = t.get("line").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                            (!line.is_empty()).then_some(PodcastTurn {
                                speaker: if speaker.is_empty() { "Host".into() } else { speaker },
                                line,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if turns.is_empty() {
                return Err(
                    "The model didn't return a usable script — try a different file.".into(),
                );
            }
            render_podcast_html(&title, &turns)
        }
    };
    let name = format!("Podcast script - {}.html", safe_scope_name(&label));
    let meta = {
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        db::insert_file(&room.conn, &name, "text/html", content.as_bytes(), Some(&content), "generated")?
    };
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("agent-open-file", serde_json::json!({ "id": meta.id }));
    Ok(meta)
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
    PODCAST_TEMPLATE
        .replace("__TITLE__", &html_escape(title))
        .replace("__ROWS__", &rows)
}

pub(crate) const PODCAST_TEMPLATE: &str = r####"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Podcast script</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--surface-2:#eef0f4;--fg:#191b1f;--muted:#63697a;--accent:#6d5cf0;--accent-2:#8b7cf6;--border:#e6e7ee}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--surface:#161a22;--surface-2:#1c212c;--fg:#e8eaf0;--muted:#8b93a7;--accent:#8b7cf6;--accent-2:#a99df8;--border:#232a37}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem}
.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)}
h1{font-size:1.9rem;margin:.25rem 0 .5rem;letter-spacing:-.02em}
.note{background:var(--surface-2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;padding:.7rem .9rem;color:var(--muted);font-size:.9rem;margin:1rem 0 1.75rem}
.turn{display:flex;gap:.8rem;margin:.9rem 0}
.turn .who{flex:none;width:6.5rem;text-align:right;font-weight:650;color:var(--accent);font-size:.92rem;padding-top:.55rem}
.turn.b .who{color:var(--accent-2)}
.turn .line{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:.55rem .9rem;box-shadow:0 4px 14px rgba(24,24,60,.05)}
.turn.b .line{background:var(--surface-2)}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Podcast script</div>
  <h1>__TITLE__</h1>
  <div class="note">Audio narration is coming in a later version — this is the script.</div>
  __ROWS__
</main>
</body>
</html>
"####;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn podcast_html_carries_audio_note_and_speakers() {
        // D12: script only — the page must say audio is a later version.
        let turns = vec![
            PodcastTurn { speaker: "Ada".into(), line: "Welcome in.".into() },
            PodcastTurn { speaker: "Bo".into(), line: "Glad to be here.".into() },
        ];
        let html = render_podcast_html("Episode 1", &turns);
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("Audio narration is coming in a later version"));
        assert!(html.contains("Ada") && html.contains("Bo"));
        // Second distinct speaker lands on the "b" side.
        assert!(html.contains("turn b"));
    }
}
