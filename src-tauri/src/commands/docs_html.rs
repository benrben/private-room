use super::*;

mod minutes;
pub(crate) use minutes::*;

/// The mime a generated file gets from its name. `create_note` and
/// `save_and_open` must agree on it, so it lives in one place.
pub(crate) fn note_mime(name: &str) -> String {
    mime_guess::from_path(name)
        .first_or(mime_guess::mime::TEXT_PLAIN)
        .essence_str()
        .to_string()
}

/// Save a generated text file into the room (Markdown by default). Reused by
/// several commands. Emits nothing — the caller decides what to open/announce.
///
/// ART-1: this goes through the staging funnel like every other generated write,
/// so a note that is regenerated becomes a new VERSION of itself rather than a
/// second indistinguishable row, and an interrupted generation leaves nothing
/// behind. Callers that know their provenance (or hold a cancel flag) build the
/// [`Artifact`] themselves and commit it; this is the plain case.
pub(crate) fn create_note(conn: &Connection, name: &str, content: &str) -> Result<FileMeta, String> {
    Artifact::note(name, content).commit(conn).map(|w| w.meta)
}

// ---- Wave 1b (idea 10): the canonical shared scratch pad -------------------

/// The one canonical, per-room working-notes file — a convention layer over
/// ordinary `files` rows (versioning, editing, and the agent's write tools all
/// apply unchanged). Follows the `SUMMARY_FILE_NAME` pattern (summarize.rs).
pub(crate) const SCRATCH_PAD_NAME: &str = "Scratch pad.md";
/// Body a fresh pad starts with.
pub(crate) const SCRATCH_PAD_TEMPLATE: &str = "# Scratch pad\n\nShared working notes. \
    You or the AI can rewrite this file at any time; every change is kept in History.\n";

/// True when an agent-supplied file name means THE scratch pad: the exact stem
/// (any case), bare or with `.md`. Other extensions stay ordinary files, so a
/// deliberate "Scratch pad.html" is never hijacked.
pub(crate) fn is_scratch_pad_name(name: &str) -> bool {
    let ext = extraction::extension_of(name);
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    };
    stem.trim().eq_ignore_ascii_case("scratch pad") && (ext.is_empty() || ext == "md")
}

/// Get-or-create the room's scratch pad. Exact-name lookup first — newest
/// match, ANY source, so a user-made pad is adopted rather than duplicated —
/// else a fresh pad is created from the template.
pub(crate) fn ensure_scratch_pad(conn: &Connection) -> Result<FileMeta, String> {
    if let Some(meta) = db::file_by_exact_name(conn, SCRATCH_PAD_NAME)? {
        return Ok(meta);
    }
    create_note(conn, SCRATCH_PAD_NAME, SCRATCH_PAD_TEMPLATE)
}

/// Wave 1b (idea 10): the sidebar chip's entry point. Returns the pad's meta
/// only — the frontend opens it in the viewer itself.
#[tauri::command]
pub fn open_scratch_pad(state: State<'_, AppState>) -> Result<FileMeta, String> {
    state.with_room(|room| ensure_scratch_pad(&room.conn))
}

/// Save a file a generator just produced and put it in front of the user: insert
/// it, tell the Files list to reload, then tell the viewer to open it. Every
/// generator (studios, AI actions, #add-file, #extract) ends this way, and the
/// two events must both fire — the file appears in the sidebar AND jumps into
/// the viewer. Taking the room lock only for the insert keeps it off the await
/// paths the callers run on.
/// ART-1: `art` carries the write itself — name, mime, body, provenance and the
/// run's cancel flag. Generated output is named after its SOURCE, so a second
/// run produces the same name as the first; two files called "Flashcards -
/// clean-code.html" with different decks in them cannot be told apart in the
/// library (live QA 2026-08-03). The funnel answers that by making the re-run a
/// new VERSION of the same file — the earlier deck stays reachable in History
/// instead of becoming an indistinguishable twin. `db::available_name` still
/// covers the other case: a generated name that collides with a file a PERSON
/// put in the room, which must never be versioned over.
pub(crate) fn save_and_open(
    window: &tauri::Window,
    state: &State<'_, AppState>,
    art: Artifact<'_>,
) -> Result<Written, String> {
    use tauri::Emitter;
    let written = state.with_room(|room| art.commit(&room.conn))?;
    let _ = window.emit("room-files-changed", ());
    let _ = window.emit("agent-open-file", serde_json::json!({ "id": written.meta.id }));
    Ok(written)
}

// ---- HTML-first output (the app defaults generated documents to HTML) ----

/// Escape text for safe literal inclusion in HTML.
pub(crate) fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// True if the model already returned a whole HTML page, so we don't double-wrap.
pub(crate) fn is_full_html_doc(s: &str) -> bool {
    let low = s.trim_start().to_lowercase();
    low.starts_with("<!doctype") || low.starts_with("<html")
}

/// Wrap body markup in a clean, self-contained HTML document with inline styling.
/// It renders in the app's sandboxed, network-blocked HtmlView, so it is safe to
/// store and open. The one `<style>` element holds [`NOTEBOOK_CSS`] (the palette,
/// paper and type, inlined from tokens.css) and then [`DOC_STYLE`] (the document
/// components), so bare model-authored markup (h2/p/ul/table…) looks as polished
/// as the built-in templates. If `body` is already a full page, it is returned
/// unchanged.
pub(crate) fn html_document(title: &str, body: &str) -> String {
    if is_full_html_doc(body) {
        return body.to_string();
    }
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n<style>\n{}\n{}\n</style>\n</head>\n<body>\n<main class=\"doc\">\n{}\n</main>\n\
         <footer class=\"doc-foot\">Arcelle · generated on this Mac</footer>\n\
         </body>\n</html>\n",
        html_escape(title),
        NOTEBOOK_CSS,
        DOC_STYLE,
        body.trim()
    )
}

/// THE NOTEBOOK, INLINED — the one duplicated copy of the app's design tokens.
///
/// SOURCE OF TRUTH: `src/styles/tokens.css`. **A change there must be mirrored
/// here.** Nothing else will catch the drift: there is no build step, no test
/// and no type that ties these two files together, so this comment and the
/// matching one inside the stylesheet are the whole defence.
///
/// The duplication is forced, not lazy. Every page these templates produce is
/// STANDALONE: it is served from `roomdoc://`, an opaque origin with a
/// `default-src 'none'` CSP, so it cannot read a custom property, a stylesheet
/// or a font file off the app. Values have to be literals.
///
/// Shared by `html_document`'s `DOC_STYLE` and by all three Studio templates
/// (flashcards, mind map, podcast script), which splice it in through their
/// `__NOTEBOOK__` slot. Four copies of a palette drift; one does not.
///
/// THEME: light is `:root` and dark is opt-in on `html[data-theme="dark"]`,
/// which `withFrameTheme` (src/viewers/frameTheme.ts) stamps into the markup on
/// the way into the frame. NEVER a `prefers-color-scheme` media query: that
/// tracks the MAC's setting, so Arcelle in light on a dark Mac rendered every
/// generated document as a dark page inside a light window. The helper only
/// ever stamps `"dark"`, which is why light has to stay the default here.
pub(crate) const NOTEBOOK_CSS: &str = r####"
/* ===========================================================================
   THE NOTEBOOK — inlined from src/styles/tokens.css.
   src/styles/tokens.css IS THE SOURCE OF TRUTH. If a value changes there, it
   must be changed here too; this page cannot var() anything in from the app.
   Light is :root, dark is html[data-theme="dark"] — never a media query,
   which would follow the Mac rather than the room.
   =========================================================================== */
:root{
  /* The document is its own origin and cannot inherit the app's color-scheme,
     so it declares one. Without it the UA paints scrollbars and form controls
     light on a charcoal page in a dark room. */
  color-scheme:light;

  /* paper: warm ivory */
  --page:#f4f1e8; --surface:#faf8f1; --raised:#ffffff; --hover:#ebe7da;
  /* the dotted rule, alpha baked in — deliberately NOT a color-mix with a
     calc() percentage, which WebKit (what this app ships on) rejects */
  --grid-dot:rgba(200,198,186,.45); --grid-gap:22px;

  /* ink: charcoal. Three tiers, each solved against --hover, the DARKEST
     ground in light mode: 12.96 / 5.43 / 4.52. */
  --ink:#20221f; --ink-strong:#14150e; --ink-2:#5a5d54; --ink-muted:#666960;

  /* drawn strokes. --rule is a pencil (decorative separators only);
     --rule-strong is the 3:1 edge anything interactive must carry. */
  --sketch:#292b27; --rule:#b8b7ac; --rule-strong:#847f6f; --line-soft:#e0dccf;

  /* markers, FILL track: translucent, absorbed, NOT legible as text */
  --mk-berry:#e7a4e9; --mk-yellow:#edc169; --mk-green:#9fc59d;
  --mk-blue:#8eb8d2; --mk-red:#dc8179;
  /* markers, INK track: contrast-checked, these can carry a word. EQUAL to
     tokens.css, value for value — this file's grounds are the same four, so a
     second solve would only be a second chance to be wrong, and was: the ink
     track here had drifted, with the dark greens copied from the FILL row
     outright. `visualRegister.test.mjs` compares the two now. */
  --mk-berry-ink:#a82fad; --mk-yellow-ink:#83601c; --mk-green-ink:#447142;
  --mk-blue-ink:#366b8d; --mk-red-ink:#b53c32;

  /* primary "button": filled ink. Light fills with charcoal — 14.19:1. */
  --btn-ink:#20221f; --btn-ink-text:#f4f1e8;

  --shadow:rgba(74,66,48,.14); --shadow-lift:rgba(74,66,48,.10);
}
html[data-theme="dark"]{
  color-scheme:dark;
  --page:#151716; --surface:#202321; --raised:#292c29; --hover:#2e322e;
  --grid-dot:rgba(80,84,79,.42);
  --ink:#f0eee5; --ink-strong:#fbfaf4; --ink-2:#a9ada3; --ink-muted:#959a92;
  --sketch:#d8d8cc; --rule:#555a54; --rule-strong:#787e77; --line-soft:#343834;
  --mk-berry:#c47ac7; --mk-yellow:#c99e48; --mk-green:#719c75;
  --mk-blue:#6896b2; --mk-red:#bb6661;
  --mk-berry-ink:#cc7ecf; --mk-yellow-ink:#bb9444; --mk-green-ink:#79a47d;
  --mk-blue-ink:#73a0bc; --mk-red-ink:#cf8883;
  --btn-ink:#f0eee5; --btn-ink-text:#151716;
  --shadow:rgba(0,0,0,.46); --shadow-lift:rgba(0,0,0,.34);
}
:root{
  /* MARKER MEANINGS — product-wide, not per-page. These are aliases only, so
     one definition serves both themes: a custom property resolves where it is
     USED, and the hues above are already themed. Reach for the semantic name
     whenever a colour is saying something. Per the spec these always ride with
     a word or a glyph — colour is never the only signal. */
  --sem-saved:var(--mk-berry-ink);     --sem-saved-fill:var(--mk-berry);
  --sem-pending:var(--mk-yellow-ink); --sem-pending-fill:var(--mk-yellow);
  --sem-done:var(--mk-green-ink);     --sem-done-fill:var(--mk-green);
  --sem-linked:var(--mk-blue-ink);    --sem-linked-fill:var(--mk-blue);
  --sem-urgent:var(--mk-red-ink);     --sem-urgent-fill:var(--mk-red);
  /* the pink pen */
  --accent:var(--mk-berry-ink); --accent-fill:var(--mk-berry);
  --accent-soft:color-mix(in srgb,var(--mk-berry) 18%,transparent);
  --ok:var(--sem-done);

  /* THE FACES, DEGRADED HONESTLY.
     The app bundles Figtree, Space Grotesk, Kalam and IBM Plex Mono
     (src/styles/fonts.css) and this page can reach NONE of them: the roomdoc://
     sandbox serves it with `default-src 'none'`, so a @font-face url() is
     blocked, a path to the app's own woff2 does not resolve from an opaque
     origin, and a remote font would break the promise of a local room. So each
     face names the nearest thing macOS already has — Arcelle is Mac-only — and
     the document is a system-font rendering of the notebook rather than a page
     pretending to fonts it cannot load. Never add a url() to these.

     Three roles, not the app's four: --display exists in tokens.css to set
     titles in Space Grotesk against Figtree, and with both degraded to the
     same system stack the distinction would be a token that resolves to --sans
     and reads as a promise the page cannot keep. Titles here separate by size
     and weight, which survive the degrade. */
  --sans:-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;
  --hand:"Bradley Hand","Noteworthy","Chalkboard SE",cursive;
  --mono:ui-monospace,SFMono-Regular,Menlo,"IBM Plex Mono",monospace;

  /* Type scale: tokens.css's rungs, except --fs-lead/--fs-body, which sit one
     rung up (18/16 rather than 16/14) because a document is a READING surface,
     not a control surface — and these pages get printed. --fs-hand is up a
     little too: the fallback hand is thinner on the page than bundled Kalam. */
  --fs-page:44px; --fs-section:26px; --fs-lead:18px; --fs-card:16px;
  --fs-body:16px; --fs-meta:13px; --fs-micro:12px;
  --fs-hand:17px; --fs-hand-lg:24px;
  --lh-hand:1.45; --lh-body:1.55;

  /* Drawn, not computed: asymmetric radii give any box a hand-made outline for
     free, and they are fixed values so a box draws identically every render. */
  /* Symmetric, and 1px: an exported document follows the app's register.
     See tokens.css for why — 1.5px lands on a half pixel at 2x, and 225 wobbly
     corners read as a rendering fault rather than as a drawn edge. The drawn
     MARKS below (the hero rule, the circled counts, the timeline dots) keep
     their asymmetry: that is the notebook, and it survived the pass. */
  --radius-xs:6px;
  --radius-sm:8px;
  --radius:10px;
  --radius-lg:12px;
  --stroke-w:1px;

  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-6:24px; --sp-8:32px;

  --dur-fast:160ms; --dur:200ms; --dur-slow:260ms;
  --ease-pen:cubic-bezier(.32,.72,.3,1);
}

*{box-sizing:border-box}
/* ONE SHEET: the dotted grid runs edge to edge and everything above is drawn
   onto it. `html` carries the ground colour so the sandboxed viewer's white
   iframe backdrop never shows through as white-on-white in a dark room. */
html{background:var(--page);-webkit-text-size-adjust:100%}
body{
  margin:0;min-height:100vh;color:var(--ink);
  font-family:var(--sans);font-size:var(--fs-body);line-height:var(--lh-body);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  background-color:var(--page);
  background-image:radial-gradient(circle at 1px 1px,
    var(--grid-dot) 1.1px,
    transparent 1.2px);
  background-size:var(--grid-gap) var(--grid-gap);
}
::selection{background:var(--accent-soft)}
/* Keyboard focus is visible on every focusable thing, including the ones a
   template adds later — :focus-visible so a mouse click never draws a ring. */
a:focus-visible,button:focus-visible,summary:focus-visible,
label:focus-visible,[tabindex]:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px;
}

/* PRINT. These documents get saved, exported to PDF and handed to people, so
   the printed sheet is a real target rather than an afterthought. Force the
   light palette whatever the frame was themed to — a charcoal ground reads as
   a photograph of a screen and eats a cartridge — drop the dotted grid, which
   is printer noise rather than paper, and flatten the lifts, which only exist
   to suggest depth on glass. Written as ONE override of the same tokens, so
   there is still only a single set of values to keep in step with tokens.css.
   The `html[data-theme="dark"]` half of the selector is load-bearing: a bare
   `html` here is less specific than the dark block above and would lose. */
@media print{
  html,html[data-theme="dark"]{
    color-scheme:light;
    --page:#ffffff; --surface:#ffffff; --raised:#ffffff; --hover:#f2f0e9;
    --grid-dot:transparent;
    --ink:#111111; --ink-strong:#000000; --ink-2:#3a3a36; --ink-muted:#44443f;
    --sketch:#222222; --rule:#9a988e; --rule-strong:#6b6a60; --line-soft:#d8d5cb;
    --mk-berry-ink:#9c27a0; --mk-yellow-ink:#6a501c; --mk-green-ink:#3b6339;
    --mk-blue-ink:#2f5f7d; --mk-red-ink:#a03328;
    --btn-ink:#111111; --btn-ink-text:#ffffff;
    --shadow:transparent; --shadow-lift:transparent;
  }
  body{background-image:none;background-color:#ffffff;min-height:0}
  h1,h2,h3{break-after:avoid;page-break-after:avoid}
}

@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"####;

/// The document rules `html_document` emits after [`NOTEBOOK_CSS`]: the shared
/// component set every generated document and template draws from — hero,
/// chips, file list, numbered asks, timeline, checklist, tables, prose — so a
/// generated page reads as a sheet torn out of the room rather than as a
/// foreign document.
///
/// It is the RULES only, with no `<style>` wrapper and no palette of its own:
/// `html_document` writes one `<style>` element holding `NOTEBOOK_CSS` and
/// then this. Rust cannot concatenate two `const`s, which is the only reason
/// these are two names rather than one.
///
/// The cards here are transparent and DRAWN, not opaque boxes: the dotted
/// sheet runs underneath the whole document and the frames sit on it. Only
/// something that genuinely floats over other content earns an opaque fill,
/// and nothing in a single-column document does.
pub(crate) const DOC_STYLE: &str = r####"
.doc{max-width:52rem;margin:0 auto;padding:3.25rem 1.5rem 1rem}
h1,h2,h3{color:var(--ink-strong);line-height:1.2}
/* The title is set in the SANS, not a serif. The app has exactly three faces
   and a fourth here would be this document system quietly drifting away from
   the first one — which is the whole failure mode these files are prone to. */
h1{font-family:var(--sans);font-weight:700;font-size:var(--fs-page);letter-spacing:-.022em;margin:.1em 0 .3em}
h2{font-size:var(--fs-section);font-weight:650;letter-spacing:-.012em;margin:2.5rem 0 .9rem;padding-bottom:.5rem;border-bottom:1px solid var(--rule)}
h2 .count{font-family:var(--sans);font-size:var(--fs-micro);font-weight:600;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:0;text-transform:none;color:var(--ink-2);background:transparent;border:var(--stroke-w) solid var(--rule-strong);border-radius:58% 62% 55% 60% / 60% 55% 62% 58%;padding:.24rem .52rem;vertical-align:.2em;margin-left:.55rem}
h3{font-size:1.06rem;font-weight:650;margin:1.6rem 0 .5rem}
p{margin:.7rem 0}
/* A link keeps a permanent underline. It used to be colour-only until hover,
   which makes the pen the ONLY thing marking a link — the exact failure the
   colour rule is about, and worse in a saved article where links sit inside
   running prose. Drawn faint and offset so it still reads as ink rather than
   as a browser default. */
a{color:var(--accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--accent) 45%,transparent);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{text-decoration-color:var(--accent)}
strong{font-weight:650}
hr{border:0;height:1px;background:linear-gradient(90deg,transparent,var(--rule) 6%,var(--rule) 92%,transparent);margin:2rem 0}
.note{color:var(--ink-2);font-size:var(--fs-meta);margin-top:.6rem}
.hero{margin:0 0 2.2rem}
.eyebrow{display:inline-block;font-size:var(--fs-micro);font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:.55rem}
.hero h1{margin:.05rem 0 .35rem}
/* The standfirst keeps its marker swipe but NOT the hand: both real callers
   put a date in it (minutes.rs's "meeting date - N attendees",
   summarize.rs's "Generated on ..."), and a date is a timestamp. */
.hero .sub{color:var(--ink-2);font-family:var(--sans);font-variant-numeric:tabular-nums;font-size:var(--fs-lead);margin:.15rem 0 0;display:inline-block;position:relative;padding-bottom:3px}
.hero .sub::after{content:"";position:absolute;left:-3px;right:-6px;bottom:0;height:2.5px;border-radius:2px 4px 2px 3px / 3px 2px 4px 2px;background:linear-gradient(91deg,var(--sem-pending-fill) 2%,color-mix(in srgb,var(--mk-yellow) 62%,transparent) 76%,transparent 100%)}
.hero .rule{height:3px;width:66px;border-radius:3px 2px 4px 2px / 2px 4px 2px 3px;background:linear-gradient(90deg,var(--accent-fill),color-mix(in srgb,var(--mk-berry) 30%,transparent));margin-top:1.15rem}
/* The one washed panel in the document: the room's purpose, highlighted. */
.lead-wrap{background:color-mix(in srgb,var(--mk-yellow) 16%,transparent);border:var(--stroke-w) solid var(--sketch);border-left:3px solid var(--sem-pending-fill);border-radius:var(--radius-lg);padding:1.05rem 1.25rem;margin:.4rem 0 0}
.lead{font-size:var(--fs-lead);line-height:1.62;margin:0}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.5rem 0 0}
.chip{display:inline-flex;align-items:center;gap:.4rem;background:transparent;border:1px solid var(--rule-strong);border-radius:999px 999px 999px 999px / 14px 12px 14px 12px;padding:.22rem .72rem;font-size:var(--fs-meta)}
.chip::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--accent-fill)}
/* Rows are FRAMES DRAWN ON THE SHEET — transparent, so the dotted grid runs
   under them, with the pen as their outline. A shadow here would claim they
   float; nothing in a document does. */
.files{list-style:none;margin:.4rem 0 0;padding:0;display:grid;gap:.5rem}
.files li{display:flex;gap:.75rem;align-items:flex-start;background:transparent;border:var(--stroke-w) solid var(--sketch);border-radius:var(--radius-lg);padding:.7rem .85rem}
.files .ic{flex:none;width:2rem;height:2rem;border-radius:var(--radius);background:color-mix(in srgb,var(--mk-berry) 20%,transparent);display:grid;place-items:center;font-size:1.05rem;line-height:1}
.files .nm{font-weight:600}
.files .ds{color:var(--ink-2);font-size:var(--fs-meta);margin-top:.12rem}
.asks{list-style:none;counter-reset:a;display:grid;gap:.55rem;margin:.4rem 0 0;padding:0}
.asks li{position:relative;background:transparent;border:var(--stroke-w) solid var(--sketch);border-radius:var(--radius-lg);padding:.78rem .95rem .78rem 3rem}
/* Circled by hand, numbered in the sans. The DRAWN part is the ring — the
   numeral itself is the only thing carrying the item's ordinal, and the
   fallback hand sets numerals too thin to trust with that job. */
.asks li::before{counter-increment:a;content:counter(a);position:absolute;left:.85rem;top:.72rem;width:1.55rem;height:1.55rem;border-radius:58% 62% 55% 60% / 60% 55% 62% 58%;border:var(--stroke-w) solid var(--accent);color:var(--accent);font-family:var(--sans);font-variant-numeric:tabular-nums;font-size:var(--fs-meta);font-weight:700;display:grid;place-items:center}
.tl{list-style:none;padding:0;margin:1rem 0 0;position:relative}
/* The spine is a pencil rule, the beads are pen. */
.tl::before{content:'';position:absolute;left:8px;top:8px;bottom:14px;width:2px;background:var(--rule)}
.tl li{position:relative;padding:0 0 1.6rem 2.15rem}
.tl li:last-child{padding-bottom:.2rem}
.tl li::before{content:'';position:absolute;left:2px;top:5px;width:14px;height:14px;border-radius:56% 60% 54% 58% / 58% 54% 60% 56%;background:var(--accent-fill);box-shadow:0 0 0 4px var(--page)}
/* A timestamp is data, not an annotation — sans, with tabular figures so a
   column of times lines up. It carries the eyebrow treatment instead of the
   hand, which the brief bars on timestamps and which in this frame would
   render as Bradley Hand anyway: Kalam is bundled with the APP and an
   opaque roomdoc:// origin cannot reach it. */
.tl .time{font-family:var(--sans);font-variant-numeric:tabular-nums;font-size:var(--fs-micro);font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.tl .topic{font-weight:650;font-size:var(--fs-lead);margin:.12rem 0 .18rem}
.tl .summary{margin:0;color:var(--ink-2)}
/* A decision is DONE: green ink, and the tick carries it so the colour is
   never the only signal. */
.checks{list-style:none;padding:0;margin:.4rem 0 0;display:grid;gap:.45rem}
.checks li{position:relative;background:transparent;border:var(--stroke-w) solid var(--sketch);border-left:3px solid var(--sem-done-fill);border-radius:var(--radius);padding:.6rem .85rem .6rem 2.2rem}
.checks li::before{content:'\2713';position:absolute;left:.8rem;top:.58rem;color:var(--sem-done);font-weight:800}
table{border-collapse:separate;border-spacing:0;width:100%;margin:.6rem 0 0;border:var(--stroke-w) solid var(--sketch);border-radius:var(--radius-lg);overflow:hidden}
th,td{padding:.6rem .82rem;text-align:left;border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
tr:first-child th,thead th{background:color-mix(in srgb,var(--ink) 6%,transparent);font-size:var(--fs-micro);letter-spacing:.05em;text-transform:uppercase;color:var(--ink-2);font-weight:700}
table tr:last-child td{border-bottom:0}
table tr:nth-child(even) td{background:color-mix(in srgb,var(--ink) 3%,transparent)}
.actions td:first-child{white-space:nowrap;color:var(--ink-2);font-weight:600;width:1%}
code{background:color-mix(in srgb,var(--ink) 7%,transparent);border-radius:var(--radius-sm);padding:.1em .36em;font-size:.9em;font-family:var(--mono)}
pre{background:color-mix(in srgb,var(--ink) 5%,transparent);border:1px solid var(--rule);border-radius:var(--radius-lg);padding:1rem;overflow-x:auto}
pre code{background:none;padding:0}
blockquote{margin:1rem 0;padding:.4rem 0 .4rem 1.1rem;border-left:3px solid var(--sem-pending-fill);color:var(--ink-2)}
ul,ol{padding-left:1.3rem}
li{margin:.28rem 0}
img{max-width:100%;border-radius:var(--radius)}
/* The one run of handwriting in the document: a signature under the page.
   It is an annotation, which is the only job the hand has here. */
.doc-foot{max-width:52rem;margin:0 auto;padding:2rem 1.5rem 3rem;color:var(--ink-2);font-family:var(--hand);font-size:var(--fs-hand);line-height:var(--lh-hand)}
@media print{
  .doc,.doc-foot{max-width:none;padding-left:0;padding-right:0}
  .files li,.asks li,.checks li,table,pre{break-inside:avoid;page-break-inside:avoid}
}
"####;

/// A polished document header: an uppercase accent eyebrow, a large serif title,
/// an optional muted subline, and an accent rule. `sub_html` is inserted as-is,
/// so callers pass already-escaped content.
pub(crate) fn doc_hero(eyebrow: &str, title: &str, sub_html: &str) -> String {
    let mut h = String::from("<header class=\"hero\">\n");
    if !eyebrow.is_empty() {
        h.push_str(&format!("<div class=\"eyebrow\">{}</div>\n", html_escape(eyebrow)));
    }
    h.push_str(&format!("<h1>{}</h1>\n", html_escape(title)));
    if !sub_html.trim().is_empty() {
        h.push_str(&format!("<p class=\"sub\">{sub_html}</p>\n"));
    }
    h.push_str("<div class=\"rule\"></div>\n</header>\n");
    h
}

/// An emoji glyph for a file, chosen by extension, so each row of the summary's
/// file list reads at a glance.
pub(crate) fn file_glyph(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "pdf" => "📕",
        "csv" | "tsv" | "xls" | "xlsx" | "numbers" => "📊",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "heic" | "tiff" => "🖼️",
        "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg" | "aiff" => "🎧",
        "mp4" | "mov" | "mkv" | "webm" | "avi" => "🎬",
        "html" | "htm" => "🌐",
        "md" | "markdown" | "txt" | "rtf" => "📝",
        "json" | "yaml" | "yml" | "toml" | "xml" => "🗂️",
        "zip" | "tar" | "gz" | "7z" => "🗜️",
        "doc" | "docx" | "pages" => "📘",
        "ppt" | "pptx" | "key" => "📽️",
        _ => "📄",
    }
}

/// The display title for a generated document, derived from its file name with
/// the extension dropped: "Q3 report.html" -> "Q3 report".
pub(crate) fn title_from_name(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name.to_string(),
    }
}

/// Wrap a model-authored document body into a full page, giving it a serif title
/// header derived from `title` — unless the model already returned a whole HTML
/// page, in which case it passes through untouched (no double header/wrap).
pub(crate) fn html_titled_doc(name: &str, title: &str, body: &str) -> String {
    if is_full_html_doc(body) {
        html_document(name, body)
    } else {
        html_document(name, &format!("{}{}", doc_hero("", title, ""), body))
    }
}

/// Pinned files as (name, full text) pairs — for commands that process each
/// @file on its own. No truncation and no file skipped: the caller decides how
/// to fit a long file into model calls (see `cmd_windows`), because deciding it
/// here can only mean throwing text away.
pub(crate) fn refs_files(conn: &Connection, refs: &[String]) -> Vec<(String, String)> {
    refs.iter()
        .filter_map(|id| db::get_file_full(conn, id).ok())
        .map(|(name, _mime, _bytes, text)| (name, text.unwrap_or_default()))
        .collect()
}

/// Pinned-file text as one context blob, plus the file names — the WHOLE text of
/// every @file, in order.
///
/// This used to clamp each file to 6000 bytes and silently drop any file once a
/// shared budget ran out, which is what made `#minutes` on an hour-long meeting
/// cover only its first ~5 minutes: ~6 KB of transcript is about 1000 words. A
/// command that can't fit this in one call now windows it and runs a pass per
/// window instead of losing the tail.
pub(crate) fn refs_context(conn: &Connection, refs: &[String]) -> (String, Vec<String>) {
    let files = refs_files(conn, refs);
    let names = files.iter().map(|(n, _)| n.clone()).collect();
    let mut ctx = String::new();
    for (name, text) in &files {
        if !text.trim().is_empty() {
            ctx.push_str(&format!("[file: {name}]\n{text}\n\n"));
        }
    }
    (ctx, names)
}

/// Derive a filename from a topic — first few words, path-safe, .md.
pub(crate) fn name_from_topic(topic: &str) -> String {
    let words: Vec<&str> = topic.split_whitespace().take(8).collect();
    let base: String = words
        .join(" ")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { ' ' })
        .collect();
    let base = base.split_whitespace().collect::<Vec<_>>().join(" ");
    let base = if base.is_empty() { "Note".to_string() } else { base };
    format!("{base}.md")
}

/// ADD-22: a topic-derived file name with an `.html` extension (generated
/// documents default to HTML).
pub(crate) fn html_note_name(topic: &str) -> String {
    let md = name_from_topic(topic);
    format!("{}.html", md.strip_suffix(".md").unwrap_or(&md))
}

// MIGRATION Phase 3: `parse_string_list` (the JSON-array-or-prose list parser used
// by #add-file's enumeration) moved into the sidecar's /knowledge_extract mode:list,
// which returns the finished `items`. It's gone from Rust.

/// Extract the LAST markdown table in `text` as rows of cells (header first).
/// "Last" so #to-sheet, scanning conversation history, picks the most recent
/// answer's table. Returns None when there is no `|`-delimited table with data.
pub(crate) fn extract_md_table(text: &str) -> Option<Vec<Vec<String>>> {
    let mut last: Option<Vec<Vec<String>>> = None;
    let mut cur: Vec<Vec<String>> = Vec::new();
    let flush = |cur: &mut Vec<Vec<String>>, last: &mut Option<Vec<Vec<String>>>| {
        if cur.len() >= 2 {
            *last = Some(std::mem::take(cur));
        } else {
            cur.clear();
        }
    };
    for line in text.lines() {
        let t = line.trim();
        if !t.contains('|') {
            flush(&mut cur, &mut last);
            continue;
        }
        // A separator row like |---|---| carries no data.
        if t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
            continue;
        }
        let cells: Vec<String> = t
            .trim_matches('|')
            .split('|')
            .map(|c| c.trim().to_string())
            .collect();
        cur.push(cells);
    }
    flush(&mut cur, &mut last);
    last
}

// ADD-22 (HTML-first): generated documents default to HTML. MIGRATION Phase 3: the
// DOC_SYS system prompt moved with #add-file's body generation into the sidecar's
// /generate_doc, which owns the prompt now, so it no longer lives here.

// ---- individual commands ----


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_generated_page_defines_the_tokens_it_reads() {
        // A generated page is standalone behind `default-src 'none'`, so an
        // undefined custom property has nowhere to resolve from. It does not
        // fall back to the app's value or to the property's initial value
        // either — the whole declaration is thrown out at computed-value time,
        // so the element loses the property entirely and the page renders a
        // gap where the mark was. Nothing raises, nothing logs; you only find
        // it by opening an export and noticing something missing.
        //
        // These four pages splice NOTEBOOK_CSS in and then write their own
        // rules on top, which is exactly the seam a rename slips through: the
        // tokens move in one file and the rules that read them live in four
        // others. Renaming --mk-pink to --mk-berry did precisely this and took
        // the hero divider off three Studio exports.
        let pages = [
            ("html_document", format!("{NOTEBOOK_CSS}\n{DOC_STYLE}")),
            (
                "flashcards",
                crate::commands::FLASHCARDS_TEMPLATE.replace("__NOTEBOOK__", NOTEBOOK_CSS),
            ),
            (
                "mindmap",
                crate::commands::MINDMAP_TEMPLATE.replace("__NOTEBOOK__", NOTEBOOK_CSS),
            ),
            (
                "podcast",
                crate::commands::PODCAST_TEMPLATE.replace("__NOTEBOOK__", NOTEBOOK_CSS),
            ),
        ];

        let mut undefined: Vec<String> = Vec::new();
        for (name, css) in &pages {
            let defined: std::collections::HashSet<&str> = css
                .match_indices("--")
                .filter_map(|(i, _)| {
                    let rest = &css[i..];
                    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))?;
                    // A definition is `--name:`; a reference is `var(--name)`.
                    rest[end..].starts_with(':').then(|| &rest[..end])
                })
                .collect();
            for (i, _) in css.match_indices("var(--") {
                let rest = &css[i + 4..];
                let Some(end) = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
                else {
                    continue;
                };
                // `var(--x, fallback)` survives an undefined token by design.
                if rest[end..].starts_with(',') {
                    continue;
                }
                let token = &rest[..end];
                if !defined.contains(token) {
                    undefined.push(format!("{name}: {token}"));
                }
            }
        }
        undefined.sort();
        undefined.dedup();
        assert!(
            undefined.is_empty(),
            "these pages read custom properties nothing defines: {undefined:#?}"
        );
    }

    #[test]
    fn extract_md_table_parses_and_skips_separator() {
        let md = "intro\n\n| Name | Age |\n|------|-----|\n| Ann | 30 |\n| Bob | 25 |\n\nafter";
        let rows = extract_md_table(md).unwrap();
        assert_eq!(rows.len(), 3); // header + 2 data rows (separator dropped)
        assert_eq!(rows[0], vec!["Name", "Age"]);
        assert_eq!(rows[2], vec!["Bob", "25"]);
        // No table → None.
        assert!(extract_md_table("just prose, no pipes").is_none());
        // With two tables, the LAST one wins (most recent answer).
        let two = "| A |\n|---|\n| 1 |\n\ntext\n\n| Z |\n|---|\n| 9 |";
        let last = extract_md_table(two).unwrap();
        assert_eq!(last[0], vec!["Z"]);
    }

    #[test]
    fn refs_context_keeps_every_file_whole() {
        // The regression this replaces: each file was clamped to 6000 bytes and
        // any file past a shared budget was dropped entirely — which is what made
        // #minutes cover only the opening minutes of a long meeting.
        let conn = db::mem();
        let big = "x".repeat(40_000);
        let a = db::add_file(&conn, "meeting.txt", &big);
        let b = db::add_file(&conn, "notes.md", "the last word");
        let (ctx, names) = refs_context(&conn, &[a, b]);
        assert_eq!(names, vec!["meeting.txt", "notes.md"]);
        assert!(ctx.contains(&big), "the whole file is present, not a 6000-byte prefix");
        assert!(ctx.contains("the last word"), "a later file is never dropped");
    }

    #[test]
    fn name_from_topic_is_path_safe() {
        assert_eq!(name_from_topic("Q3 revenue: AAPL/MSFT!"), "Q3 revenue AAPL MSFT.md");
        assert_eq!(name_from_topic(""), "Note.md");
    }

    #[test]
    fn html_document_wraps_and_escapes() {
        let doc = html_document("Report", "<h2>Hi</h2>");
        assert!(doc.starts_with("<!doctype html>"));
        assert!(doc.contains("<title>Report</title>"));
        assert!(doc.contains("<h2>Hi</h2>"));
        // A full page passes through unchanged (no double-wrap).
        let full = "<!doctype html><html><body>x</body></html>";
        assert_eq!(html_document("t", full), full);
        assert_eq!(html_escape("a<b>&\"c"), "a&lt;b&gt;&amp;&quot;c");
    }

    #[test]
    fn html_note_name_defaults_to_html() {
        assert_eq!(html_note_name("Q3 report"), "Q3 report.html");
        assert_eq!(html_note_name(""), "Note.html");
    }

    #[test]
    fn doc_helpers_render() {
        assert_eq!(title_from_name("Q3 report.html"), "Q3 report");
        assert_eq!(title_from_name("notes"), "notes");
        assert_eq!(file_glyph("chart.pdf"), "📕");
        assert_eq!(file_glyph("clip.m4a"), "🎧");
        assert_eq!(file_glyph("mystery.zzz"), "📄");
        // A model body gets a serif title header prepended…
        let doc = html_titled_doc("Apple.html", "Apple", "<p>Hi</p>");
        assert!(doc.contains("<h1>Apple</h1>") && doc.contains("<p>Hi</p>"));
        // …but a full page the model already returned passes through untouched.
        let full = "<!doctype html><html><body>x</body></html>";
        assert_eq!(html_titled_doc("f.html", "F", full), full);
        // Hero with an eyebrow and a subline.
        let h = doc_hero("Room summary", "My Room", "Generated on 2026-07-06");
        assert!(h.contains("class=\"eyebrow\"") && h.contains("My Room"));
        assert!(h.contains("class=\"rule\""));
    }

    // ---- Section D: pure command tests --------------------------------------

    #[test]
    fn scratch_pad_get_or_create_is_idempotent() {
        let conn = db::mem();
        let first = ensure_scratch_pad(&conn).unwrap();
        assert_eq!(first.name, SCRATCH_PAD_NAME);
        let second = ensure_scratch_pad(&conn).unwrap();
        assert_eq!(first.id, second.id, "two calls must resolve to ONE pad");
        // Exactly one pad row exists.
        let pads = db::list_files(&conn)
            .unwrap()
            .into_iter()
            .filter(|f| f.name == SCRATCH_PAD_NAME)
            .count();
        assert_eq!(pads, 1);
    }

    #[test]
    fn scratch_pad_adopts_user_file() {
        let conn = db::mem();
        // A user-uploaded pad (any source) is adopted, never duplicated.
        let user = db::insert_file(
            &conn,
            SCRATCH_PAD_NAME,
            "text/markdown",
            b"my own notes",
            Some("my own notes"),
            "upload",
        )
        .unwrap();
        let got = ensure_scratch_pad(&conn).unwrap();
        assert_eq!(got.id, user.id);
    }

    #[test]
    fn scratch_pad_name_matcher_covers_variants_only() {
        // The create_file redirect fires for the pad's stem, bare or .md…
        assert!(is_scratch_pad_name("Scratch pad.md"));
        assert!(is_scratch_pad_name("scratch pad"));
        assert!(is_scratch_pad_name("SCRATCH PAD.MD"));
        // …but never for other extensions or other names.
        assert!(!is_scratch_pad_name("Scratch pad.html"));
        assert!(!is_scratch_pad_name("Scratch pads.md"));
        assert!(!is_scratch_pad_name("notes.md"));
    }
}
