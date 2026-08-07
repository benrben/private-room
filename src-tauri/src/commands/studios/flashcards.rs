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
        // HTML-authoring stays primary here: this artifact is a PAGE, and
        // nothing downstream needs to read its parts back as data.
        structured_first: false,
        after_save: None,
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
            // The checkbox is off-screen but NOT `hidden`. `hidden` is
            // display:none, which takes it out of the tab order as well as off
            // the screen — the deck was mouse-only, with no way to flip a card
            // from the keyboard and nothing for a screen reader to operate. It
            // is the same CSS-only flip either way; only its reachability
            // changes. The label wraps both faces, so the control's accessible
            // name still reads the whole card, which is what a static page
            // with no script can honestly offer: nothing here was ever hidden
            // from assistive technology, only rotated away from the eye.
            out.push_str(&format!(
                "<label class=\"card\"><input type=\"checkbox\" class=\"flip\">\
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
            // The notebook's palette, type and paper, spliced in from the one
            // copy in docs_html.rs rather than restated here — see NOTEBOOK_CSS
            // for why a standalone page has to inline it at all.
            ("__NOTEBOOK__", NOTEBOOK_CSS),
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
__NOTEBOOK__
/* ---- the deck: index cards laid on the sheet ------------------------------
   Everything above comes from NOTEBOOK_CSS (docs_html.rs), which is the one
   inlined copy of src/styles/tokens.css. Nothing below may restate a colour;
   if a value is missing there, add it there. */
.wrap{max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.eyebrow{display:inline-block;font-size:var(--fs-micro);font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:.4rem}
h1{font-family:var(--sans);font-weight:700;font-size:var(--fs-page);line-height:1.15;letter-spacing:-.022em;color:var(--ink-strong);margin:.05rem 0 .3rem}
/* The standfirst carries the deck's only instruction, so it is set at reading
   size rather than at the metadata rung — an instruction is never set small. */
.sub{color:var(--ink-2);font-size:var(--fs-body);margin:0}
.rule{height:3px;width:66px;border-radius:3px 2px 4px 2px / 2px 4px 2px 3px;background:linear-gradient(90deg,var(--accent-fill),color-mix(in srgb,var(--mk-pink) 30%,transparent));margin:1rem 0 1.9rem}
/* `min(15rem,100%)`, not a bare 15rem: an auto-fill floor wider than the deck
   still lays out ONE 15rem column, which then runs past the right edge instead
   of collapsing to a single readable column. The deck is read inside the
   viewer's iframe, which in a split pane is routinely narrower than that. */
.deck{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(15rem,100%),1fr));gap:1rem}
.card{position:relative;display:block;height:12rem;perspective:1200px;cursor:pointer;transition:transform var(--dur) var(--ease-pen)}
.card:hover{transform:translateY(-2px)}
.card:active{transform:translateY(1px)}
/* The flip control, off-screen but reachable. `hidden` (display:none) took it
   out of the tab order, so the deck could only be used with a mouse; opacity
   leaves it focusable. The ring is drawn on the CARD, which is the thing the
   user is actually aiming at, and pointer-events stay off it so a click still
   lands on the label. */
.card .flip{position:absolute;top:0;left:0;width:1px;height:1px;margin:0;padding:0;opacity:0;pointer-events:none}
.card:focus-within{transform:translateY(-2px)}
.card:focus-within .face{outline:2px solid var(--accent);outline-offset:2px}
.card .inner{position:relative;display:block;width:100%;height:100%;transition:transform var(--dur-slow) var(--ease-pen);transform-style:preserve-3d}
.card input:checked + .inner{transform:rotateY(180deg)}
/* An index card is a physical object laid on the sheet, and it is the one
   thing in this document system that earns an opaque fill and a lift: a
   transparent front would show its own mirrored back through it mid-flip.
   `overflow-wrap:anywhere`: a card can hold a URL, a formula or a German
   compound, and an unbreakable run wider than the card used to push straight
   out of it — the face scrolls sideways rather than wrapping, and on the back
   of a flipped card that text is simply lost. */
.face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:var(--stroke-w) solid var(--sketch);border-radius:var(--radius-lg);background:var(--surface);box-shadow:0 2px 10px var(--shadow-lift);padding:1.25rem;display:flex;flex-direction:column;text-align:center;overflow:auto;overflow-wrap:anywhere}
/* Centred with auto margins rather than by centring `justify-content`. A
   centred flex column puts half of any overflow ABOVE the scroll origin, where no
   scrollbar reaches it: the opening lines of a long answer were clipped and
   unrecoverable. Auto margins resolve to 0 as soon as the text outgrows the
   card, so it starts at the top and scrolls the whole way. */
.face>:first-child{margin-top:auto}
.face>:last-child{margin-bottom:auto}
/* The index-card tab: yellow is PENDING (a question you have not answered
   yet), green is DONE (the answer). The words "Q1" and "Answer" carry the
   same distinction, so the marker is never the only signal. */
.front{border-top:3px solid var(--sem-pending-fill)}
.back{transform:rotateY(180deg);border-top:3px solid var(--sem-done-fill)}
.tag{font-family:var(--sans);font-size:var(--fs-micro);font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-variant-numeric:tabular-nums;margin-bottom:.5rem}
.front .tag{color:var(--sem-pending)}
.back .tag{color:var(--sem-done)}
.txt{font-size:var(--fs-card);line-height:1.5}
.hint{margin:.6rem 0 0;font-size:var(--fs-meta);color:var(--ink-2)}
.tip{text-align:center;color:var(--ink-2);font-family:var(--hand);font-size:var(--fs-hand);line-height:var(--lh-hand);margin:1.7rem 0 0}
.empty{text-align:center;color:var(--ink-2);padding:3rem 0}
@media print{
  /* A printed card cannot be flipped, so print BOTH faces stacked: the deck
     becomes a study sheet instead of a page of unanswered questions. */
  .card{height:auto;perspective:none;transform:none;cursor:auto;break-inside:avoid;page-break-inside:avoid}
  .card .inner{transform:none!important;transform-style:flat}
  .face{position:static;transform:none!important;backface-visibility:visible;-webkit-backface-visibility:visible;box-shadow:none;overflow:visible}
  .back{margin-top:.4rem}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Flashcards</div>
  <h1>__TITLE__</h1>
  <p class="sub">__COUNT__ · click a card, or tab to it and press Space, to flip it</p>
  <div class="rule"></div>
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
