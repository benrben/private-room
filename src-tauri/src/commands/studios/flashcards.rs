use super::*;

#[derive(Serialize, Deserialize, Clone)]
pub struct StudioCard {
    pub q: String,
    pub a: String,
    #[serde(default)]
    pub hint: String,
}

/// D5: generate an interactive flashcard deck (flip cards) as a self-contained
/// HTML file saved into the room, and return its FileMeta. `instructions` is the
/// user-editable prompt (defaults to `STUDIO_FLASHCARDS_PROMPT`). Model down → a
/// clear Err the frontend can toast.
#[tauri::command]
pub async fn studio_flashcards(
    window: tauri::Window,
    state: State<'_, AppState>,
    scope: Option<String>,
    instructions: Option<String>,
    refs: Option<Vec<String>>,
    op_id: Option<String>,
) -> Result<FileMeta, String> {
    run_studio(&window, &state, flashcards_spec(), scope, instructions, refs, op_id).await
}

/// The flashcards artifact spec for the shared `run_studio` pipeline.
pub(crate) fn flashcards_spec() -> StudioSpec {
    StudioSpec {
        default_prompt: STUDIO_FLASHCARDS_PROMPT,
        page_role: "You are a front-end developer building an interactive flashcards study page. \
            Show a deck of cards the reader flips (click, or Space/Enter, or the arrow keys) to reveal \
            the answer, with an optional hint, a card counter, and next/previous controls. Base every \
            card only on the provided material — test real understanding, not formatting trivia.",
        working_label: "Designing your deck",
        fallback_step: Some("Extracting question/answer pairs…"),
        fallback_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "cards": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "q": {"type": "string"},
                            "a": {"type": "string"},
                            "hint": {"type": "string"}
                        },
                        "required": ["q", "a"]
                    }
                }
            },
            "required": ["cards"]
        }),
        fallback_system: "You turn study material into flashcards. Write clear question/answer pairs (and a \
             short optional hint) that test understanding of the material — not trivia about its \
             formatting. Base every card only on the provided text.",
        fallback_intro: "Base every card only on this material about",
        fallback_temp: 0.3,
        render: fallback_flashcards,
        filename_prefix: "Flashcards",
    }
}

/// Fallback: parse extracted cards and render the built-in flashcards template.
fn fallback_flashcards(raw: &str, label: &str) -> Result<String, String> {
    let cards: Vec<StudioCard> = json_array(raw, "cards")
        .iter()
        .filter_map(|c| {
            let (q, a) = (value_str(c, "q"), value_str(c, "a"));
            (!q.is_empty() && !a.is_empty()).then_some(StudioCard {
                q,
                a,
                hint: value_str(c, "hint"),
            })
        })
        .collect();
    if cards.is_empty() {
        return Err("The model didn't return any usable flashcards — try a different file.".into());
    }
    Ok(render_flashcards_html(label, &cards))
}

/// D5: render a flashcard deck as a self-contained HTML page. The cards are
/// built into STATIC markup in Rust (CSS-only flip, no JavaScript) so they
/// render in any sandbox — WKWebView refuses to run inline scripts inside the
/// network-blocked HtmlView iframe, which left a JS-built deck blank.
pub(crate) fn render_flashcards_html(title: &str, cards: &[StudioCard]) -> String {
    let cards_html = if cards.is_empty() {
        "<p class=\"empty\">No cards were generated.</p>".to_string()
    } else {
        let mut out = String::new();
        for (i, c) in cards.iter().enumerate() {
            let hint = if c.hint.trim().is_empty() {
                String::new()
            } else {
                format!("<p class=\"hint\">Hint: {}</p>", html_escape(&c.hint))
            };
            out.push_str(&format!(
                "<label class=\"card\"><input type=\"checkbox\" hidden>\
                 <span class=\"inner\">\
                 <span class=\"face front\"><span class=\"tag\">Q{}</span>\
                 <span class=\"txt\">{}</span>{}</span>\
                 <span class=\"face back\"><span class=\"tag\">Answer</span>\
                 <span class=\"txt\">{}</span></span></span></label>",
                i + 1,
                html_escape(&c.q),
                hint,
                html_escape(&c.a),
            ));
        }
        out
    };
    let count = format!(
        "{} card{}",
        cards.len(),
        if cards.len() == 1 { "" } else { "s" }
    );
    FLASHCARDS_TEMPLATE
        .replace("__TITLE__", &html_escape(title))
        .replace("__COUNT__", &count)
        .replace("__CARDS__", &cards_html)
}

pub(crate) const FLASHCARDS_TEMPLATE: &str = r####"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Flashcards</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--surface-2:#eef0f4;--fg:#191b1f;--muted:#63697a;--accent:#6d5cf0;--accent-2:#8b7cf6;--border:#e6e7ee;--radius:16px}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--surface:#161a22;--surface-2:#1c212c;--fg:#e8eaf0;--muted:#8b93a7;--accent:#8b7cf6;--accent-2:#a99df8;--border:#232a37}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem}
.eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)}
h1{font-size:1.9rem;margin:.25rem 0 .25rem;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:.9rem;margin:0 0 1.5rem}
.deck{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:1rem}
.card{display:block;height:12rem;perspective:1200px;cursor:pointer}
.card .inner{position:relative;display:block;width:100%;height:100%;transition:transform .5s;transform-style:preserve-3d}
.card input:checked + .inner{transform:rotateY(180deg)}
.face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:0 12px 30px rgba(24,24,60,.08);padding:1.3rem;display:flex;flex-direction:column;justify-content:center;text-align:center;overflow:auto}
.back{transform:rotateY(180deg);background:var(--surface-2)}
.tag{font-size:.62rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:.5rem}
.txt{font-size:1.05rem}
.hint{margin:.6rem 0 0;font-size:.8rem;color:var(--muted)}
.tip{text-align:center;color:var(--muted);font-size:.82rem;margin:1.25rem 0 0}
.empty{text-align:center;color:var(--muted);padding:3rem 0}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Flashcards</div>
  <h1>__TITLE__</h1>
  <p class="sub">__COUNT__ · click a card to flip it</p>
  <div class="deck">__CARDS__</div>
  <p class="tip">Every answer is grounded in this room's files.</p>
</main>
</body>
</html>
"####;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flashcards_html_is_static_and_script_safe() {
        // D5: the deck is one self-contained HTML doc built as STATIC markup —
        // no <script> at all (so it renders in WKWebView's sandbox), and any
        // markup in card text is HTML-escaped rather than injected.
        let cards = vec![StudioCard {
            q: "What is <b>this</b>?".into(),
            a: "</script> injected".into(),
            hint: "a hint".into(),
        }];
        let html = render_flashcards_html("My Deck", &cards);
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("<title>My Deck — Flashcards</title>"));
        // No script tag anywhere — the whole point of the static rewrite.
        assert!(!html.contains("<script"));
        // Card text is escaped, never live markup.
        assert!(html.contains("What is &lt;b&gt;this&lt;/b&gt;?"));
        assert!(html.contains("&lt;/script&gt; injected"));
        assert!(!html.contains("</script> injected"));
        assert!(html.contains("Hint: a hint"));
        assert!(html.contains("1 card"));
    }
}
