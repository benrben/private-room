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
    // A Studio button in the UI: its own root, nobody's child.
    run_studio(&window, &state, flashcards_spec(), scope, instructions, refs, op_id, None).await
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
    fill_template(
        FLASHCARDS_TEMPLATE,
        &[
            ("__TITLE__", &html_escape(title)),
            ("__COUNT__", &count),
            ("__CARDS__", &cards_html),
        ],
    )
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
/* `min(15rem,100%)`, not a bare 15rem: an auto-fill floor wider than the deck
   still lays out ONE 15rem column, which then runs past the right edge instead
   of collapsing to a single readable column. The deck is read inside the
   viewer's iframe, which in a split pane is routinely narrower than that. */
.deck{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(15rem,100%),1fr));gap:1rem}
.card{display:block;height:12rem;perspective:1200px;cursor:pointer}
.card .inner{position:relative;display:block;width:100%;height:100%;transition:transform .5s;transform-style:preserve-3d}
.card input:checked + .inner{transform:rotateY(180deg)}
/* `overflow-wrap:anywhere`: a card can hold a URL, a formula or a German
   compound, and an unbreakable run wider than the card used to push straight
   out of it — the face scrolls sideways rather than wrapping, and on the back
   of a flipped card that text is simply lost. */
.face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:0 12px 30px rgba(24,24,60,.08);padding:1.3rem;display:flex;flex-direction:column;justify-content:flex-start;text-align:center;overflow:auto;overflow-wrap:anywhere}
/* Centred with auto margins rather than by centring `justify-content`. A
   centred flex column puts half of any overflow ABOVE the scroll origin, where no
   scrollbar reaches it: the opening lines of a long answer were clipped and
   unrecoverable. Auto margins resolve to 0 as soon as the text outgrows the
   card, so it starts at the top and scrolls the whole way. */
.face>:first-child{margin-top:auto}
.face>:last-child{margin-bottom:auto}
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

    #[test]
    fn a_long_card_wraps_inside_its_card_instead_of_escaping_it() {
        // The three layout rules a deck of real study material depends on. The
        // deck is a static page with no script and no external stylesheet, so
        // the only place this can be pinned is the markup it ships.
        let cards = vec![StudioCard {
            q: "Explain https://example.com/a/very/long/unbreakable/path?with=query".into(),
            a: "A long answer, several lines of it, more than a 12rem card can show at once."
                .into(),
            hint: String::new(),
        }];
        let html = render_flashcards_html("Deck", &cards);

        // 1. The column floor must collapse below the page width — a bare
        //    `minmax(15rem,1fr)` lays out a 15rem column inside a narrower
        //    pane and the cards run off the right edge.
        assert!(
            html.contains("minmax(min(15rem,100%),1fr)"),
            "the deck's track floor must not exceed the page width"
        );

        // 2. Overflow inside a CENTRED flex column starts above the scroll
        //    origin and cannot be scrolled back to, so the first lines of a
        //    long answer were unreachable. Auto margins centre without that.
        assert!(
            !html.contains("justify-content:center"),
            "a centred flex column clips the top of its own overflow"
        );
        assert!(html.contains(".face>:first-child{margin-top:auto}"));
        assert!(html.contains(".face>:last-child{margin-bottom:auto}"));

        // 3. An unbreakable run (URL, formula) must wrap rather than push the
        //    text out of the card.
        assert!(html.contains("overflow-wrap:anywhere"));
    }

    #[test]
    fn a_file_named_after_a_template_slot_does_not_corrupt_the_page() {
        // The title is substituted first; chained `.replace()` then filled the
        // slot the title itself spelled, dumping the whole deck into <title>.
        let cards = vec![StudioCard { q: "Q".into(), a: "A".into(), hint: String::new() }];
        let html = render_flashcards_html("__CARDS__", &cards);
        assert!(html.contains("<title>__CARDS__ — Flashcards</title>"), "title stays literal");
        let head = html.split("</title>").next().unwrap();
        assert!(!head.contains("<label"), "the deck must not be spliced into the title");
        // The deck lands in the deck, exactly once.
        assert_eq!(html.matches("class=\"card\"").count(), 1);
    }
}
