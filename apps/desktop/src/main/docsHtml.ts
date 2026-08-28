/**
 * Port of exactly the slice of `src-tauri/src/commands/docs_html.rs` (772
 * lines, read in full) that `agent.rs`'s `create_file` arm (~3902-3993) needs
 * for its non-scratch-pad, HTML-first branch: `SCRATCH_PAD_NAME`,
 * `is_scratch_pad_name`, `note_mime`, `html_escape`, `is_full_html_doc`,
 * `html_document`, and the two CSS constants it inlines
 * (`NOTEBOOK_CSS`/`DOC_STYLE`).
 *
 * STILL NOT PORTED, because `create_file`'s own arm never reaches them:
 * `SCRATCH_PAD_TEMPLATE`/`ensure_scratch_pad`/`open_scratch_pad` (the sidebar
 * chip's get-or-create entry point — `create_file` builds its fresh pad from
 * the MODEL's own content, never the template), `create_note`/`save_and_open`
 * (thin wrappers `agent.rs` itself does not call — `save_and_open` also emits
 * `agent-open-file`, which no arm in this batch does), `file_glyph`
 * (the Studio summary's per-file icon — a different caller),
 * `extract_md_table` (`#to-sheet`, other commands entirely).
 *
 * `NOTEBOOK_CSS`/`DOC_STYLE` are copied CHARACTER-FOR-CHARACTER from the
 * Rust source's two `r####"…"####` raw strings (verified against
 * `docs_html.rs` lines 156-323 and 342-429) — this is inlined CSS with no
 * logic of its own, so a re-derivation would only be a second chance to typo
 * a hex colour the notebook depends on matching `src/styles/tokens.css`
 * exactly. The copy was verified mechanically, not by eye: both raw strings
 * were extracted from `docs_html.rs` and compared byte-for-byte against these
 * two template literals (after un-escaping the backslashes a TS template
 * literal requires), and both matched exactly.
 *
 * `extensionOf`/`MIME_BY_EXT` are ANOTHER local copy of the `extraction.ts`
 * stand-in `organize.ts` and `turnEngine.ts` already carry (see either
 * module's header for why: `extraction::extension_of` and `mime_guess` are
 * external to every Rust file that has needed them so far, and this rewrite
 * has no `extraction.ts` yet for any of them to import instead). `noteMime`
 * mirrors `docs_html.rs`'s `note_mime` — literally
 * `mime_guess::from_path(name).first_or(TEXT_PLAIN).essence_str()` — against
 * that same table, which is also exactly what `create_file`'s own non-pad
 * branch computes inline in Rust.
 *
 * EXTENDED (2026-08, the `chat_commands/knowledge.rs` batch) with the rest of
 * `docs_html.rs`'s pure/DB-read helpers that command needs and this file had
 * previously scoped out by name: {@link refsFiles}/{@link refsContext}
 * (`refs_files`/`refs_context`), {@link nameFromTopic}/{@link htmlNoteName}
 * (`name_from_topic`/`html_note_name`), {@link titleFromName} plus the
 * private `docHero` (`title_from_name`/`doc_hero`), and
 * {@link htmlTitledDoc} (`html_titled_doc`). All five are ported verbatim.
 *
 * NOT ADDED: `create_note`/`save_and_open`/`file_glyph`/`extract_md_table` —
 * still other commands' territory (`#to-sheet`'s table read, the scratch pad,
 * and the Studio summary's per-file icon respectively). `save_and_open` in
 * particular does NOT live here even though `chat_commands/knowledge.rs`'s
 * own `cmd_add_file`/`cmd_extract` call it: `artifactBuilder.ts` (the
 * `chat_commands/generate.rs` batch) already imports THIS file for
 * `noteMime`, so importing `Artifact`/`Written` the other way here would be a
 * cycle. It is ported instead in `chatCommandsKnowledge.ts`, the one file in
 * this batch that may safely depend on both.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { getFileFull } from "./db-host/files.js";

// ---------------------------------------------------------- extension / mime

/** `extraction::extension_of` — a `std::path::Path` extension: none for a
 * dotfile or a name with no dot, lower-cased. Local copy; see module doc. */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

/** A small, honest substitute for the `mime_guess` crate: real for every
 * extension a generated document actually lands under, and defaulting to
 * `text/plain` exactly as `mime_guess::from_path(..).first_or(TEXT_PLAIN)`
 * does for anything it has no entry for either. Kept identical to
 * `organize.ts`'s/`turnEngine.ts`'s tables so the copies collapse cleanly
 * later. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  py: "text/x-python",
  js: "text/javascript",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

/** `docs_html.rs`'s `note_mime` — the mime a generated file gets from its
 * name. `create_file`'s own arm computes this same expression inline for its
 * non-pad branch; exported here so both branches (and any future caller)
 * share one table.
 *
 * OWN-PROPERTY GUARD, not decoration (2026-08 verification pass, proven by
 * `artifactBuilder.test.ts`'s "note() survives a file name whose extension is
 * an Object.prototype key"): the extension is MODEL-CONTROLLED — `#minutes`/
 * `#sketch`/`#to-sheet` hand a generated file name straight to
 * `Artifact.note`, and `create_file` computes this same mime for a name the
 * model chose — so a bare `MIME_BY_EXT[ext] ?? "text/plain"` read the
 * PROTOTYPE for `"constructor"` (the `Object` function), `"__proto__"`
 * (`Object.prototype`), `"toString"`, `"hasOwnProperty"`, … `??` never fires
 * for those, so a non-string mime reached the DB layer and the whole write
 * died with "SQLite3 can only bind numbers, strings, bigints, buffers, and
 * null". `mime_guess::from_path` has no prototype chain to leak and answers
 * `text/plain` for every one of them, which is what this now does. */
export function noteMime(name: string): string {
  const ext = extensionOf(name);
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext)
    ? (MIME_BY_EXT[ext] as string)
    : "text/plain";
}

// -------------------------------------------------- the shared scratch pad

/** Wave 1b (idea 10): the one canonical, per-room working-notes file. Ported
 * verbatim from `docs_html.rs`. */
export const SCRATCH_PAD_NAME = "Scratch pad.md";

/** True when an agent-supplied file name means THE scratch pad: the exact
 * stem (any case), bare or with `.md`. Other extensions stay ordinary files,
 * so a deliberate "Scratch pad.html" is never hijacked. Ported verbatim from
 * `docs_html.rs`'s `is_scratch_pad_name`. */
export function isScratchPadName(name: string): boolean {
  const ext = extensionOf(name);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.trim().toLowerCase() === "scratch pad" && (ext === "" || ext === "md");
}

// ---------------------------------------------- HTML-first generated documents

/** Escape text for safe literal inclusion in HTML. Ported verbatim from
 * `docs_html.rs`'s `html_escape`. */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** True if the model already returned a whole HTML page, so `html_document`
 * does not double-wrap it. Ported verbatim from `docs_html.rs`'s
 * `is_full_html_doc`. */
export function isFullHtmlDoc(s: string): boolean {
  const low = s.trimStart().toLowerCase();
  return low.startsWith("<!doctype") || low.startsWith("<html");
}

/**
 * THE NOTEBOOK, INLINED — the one duplicated copy of the app's design tokens.
 *
 * SOURCE OF TRUTH: `src/styles/tokens.css`. A change there must be mirrored
 * here — nothing enforces the pairing, which is the whole reason
 * `docs_html.rs`'s own comment calls this out as the module's one real risk.
 *
 * Copied character-for-character from `docs_html.rs` lines 156-323 (the
 * `NOTEBOOK_CSS` raw string) — see this module's own header.
 *
 * EXPORTED (2026-08, the `studios/mindmap.rs` batch): `render_mindmap_html`
 * inlines this same raw CSS into its OWN page template rather than going
 * through {@link htmlDocument}'s hero+DOC_STYLE wrapper (a mind map draws its
 * own tree chrome on top of the notebook, not a doc's hero/rule), so
 * `studiosMindmap.ts` needs the bare string. Widening visibility only — every
 * existing caller in this file still reads it as before.
 */
export const NOTEBOOK_CSS = `
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
     outright. \`visualRegister.test.mjs\` compares the two now. */
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
     sandbox serves it with \`default-src 'none'\`, so a @font-face url() is
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
   onto it. \`html\` carries the ground colour so the sandboxed viewer's white
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
   The \`html[data-theme="dark"]\` half of the selector is load-bearing: a bare
   \`html\` here is less specific than the dark block above and would lose. */
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
`;

/**
 * The document rules `htmlDocument` emits after {@link NOTEBOOK_CSS}: hero,
 * chips, file list, numbered asks, timeline, checklist, tables, prose.
 *
 * Copied character-for-character from `docs_html.rs` lines 342-429 (the
 * `DOC_STYLE` raw string) — see this module's own header.
 */
const DOC_STYLE = `
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
.checks li::before{content:'\\2713';position:absolute;left:.8rem;top:.58rem;color:var(--sem-done);font-weight:800}
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
`;

/**
 * Wrap a model-authored document body into a full, self-contained page —
 * unless the model already returned one, in which case it passes through
 * unwrapped. Ported verbatim from `docs_html.rs`'s `html_document`; the one
 * `<style>` element holds {@link NOTEBOOK_CSS} then {@link DOC_STYLE},
 * exactly as the Rust source concatenates its two `const`s (which it cannot
 * do at the constant-definition site, hence two names).
 */
export function htmlDocument(title: string, body: string): string {
  if (isFullHtmlDoc(body)) {
    return body;
  }
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${htmlEscape(title)}</title>\n<style>\n${NOTEBOOK_CSS}\n${DOC_STYLE}\n</style>\n</head>\n<body>\n<main class="doc">\n${body.trim()}\n</main>\n` +
    `<footer class="doc-foot">Arcelle \u00b7 generated on this Mac</footer>\n` +
    `</body>\n</html>\n`
  );
}

// ---- refs / topic-derived names (docs_html.rs, added for chat_commands/knowledge.rs) --

/**
 * Pinned files as (name, full text) pairs \u2014 for commands that process each
 * `@file` on its own. A ref that no longer resolves (the file was removed
 * after being pinned) is SKIPPED rather than an error, matching Rust's
 * `filter_map(|id| db::get_file_full(conn, id).ok())`. No truncation and no
 * file skipped for SIZE: the caller decides how to fit a long file into model
 * calls (`cmdWindows`), because deciding it here can only mean throwing text
 * away. Ported verbatim from `docs_html.rs`'s `refs_files`.
 */
export function refsFiles(db: Database.Database, refs: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const id of refs) {
    try {
      const [name, , , text] = getFileFull(db, id);
      out.push([name, text ?? ""]);
    } catch {
      // Skipped \u2014 matches Rust's `.ok()`.
    }
  }
  return out;
}

/**
 * Pinned-file text as one context blob, plus the file names \u2014 the WHOLE text
 * of every `@file`, in order.
 *
 * This used to clamp each file to 6000 bytes and silently drop any file once
 * a shared budget ran out, which is what made `#minutes` on an hour-long
 * meeting cover only its first ~5 minutes: ~6 KB of transcript is about 1000
 * words. A command that can't fit this in one call now windows it and runs a
 * pass per window instead of losing the tail. Ported verbatim from
 * `docs_html.rs`'s `refs_context`.
 */
export function refsContext(db: Database.Database, refs: readonly string[]): [string, string[]] {
  const files = refsFiles(db, refs);
  const names = files.map(([n]) => n);
  let ctx = "";
  for (const [name, text] of files) {
    if (text.trim() !== "") {
      ctx += `[file: ${name}]\n${text}\n\n`;
    }
  }
  return [ctx, names];
}

/** Derive a filename from a topic \u2014 first few words, path-safe, `.md`. The
 * character class is `\p{Alphabetic}\p{N}`, matching Rust's derived
 * `char::is_alphanumeric()` (see `db-host/retrieval.ts`'s `questionTerms` for
 * the same class, and why it is not `\p{L}`). Ported verbatim from
 * `docs_html.rs`'s `name_from_topic`. */
export function nameFromTopic(topic: string): string {
  const words = topic.split(/\s+/u).filter((w) => w !== "").slice(0, 8);
  const joined = words.join(" ");
  let base = "";
  for (const c of joined) {
    base += /[\p{Alphabetic}\p{N}]/u.test(c) || c === " " || c === "-" ? c : " ";
  }
  base = base
    .split(/\s+/u)
    .filter((w) => w !== "")
    .join(" ");
  if (base === "") {
    base = "Note";
  }
  return `${base}.md`;
}

/** ADD-22: a topic-derived file name with an `.html` extension (generated
 * documents default to HTML). Ported verbatim from `docs_html.rs`'s
 * `html_note_name`. */
export function htmlNoteName(topic: string): string {
  const md = nameFromTopic(topic);
  const stem = md.endsWith(".md") ? md.slice(0, -3) : md;
  return `${stem}.html`;
}

/** The display title for a generated document, derived from its file name
 * with the extension dropped: "Q3 report.html" -> "Q3 report". Ported
 * verbatim from `docs_html.rs`'s `title_from_name`. */
export function titleFromName(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** A polished document header: an uppercase accent eyebrow, a large title, an
 * optional muted subline, and an accent rule. `subHtml` is inserted as-is, so
 * callers pass already-escaped content. Ported verbatim from `docs_html.rs`'s
 * `doc_hero`. Not exported \u2014 `htmlTitledDoc` is the only caller this batch
 * needs (the eyebrow/subline-carrying callers, the Studio summary and
 * `#minutes`, are `commands/summarize.rs`/`minutes.rs`, out of this batch's
 * scope). */
function docHero(eyebrow: string, title: string, subHtml: string): string {
  let h = '<header class="hero">\n';
  if (eyebrow !== "") {
    h += `<div class="eyebrow">${htmlEscape(eyebrow)}</div>\n`;
  }
  h += `<h1>${htmlEscape(title)}</h1>\n`;
  if (subHtml.trim() !== "") {
    h += `<p class="sub">${subHtml}</p>\n`;
  }
  h += '<div class="rule"></div>\n</header>\n';
  return h;
}

/** Wrap a model-authored document body into a full page, giving it a title
 * header derived from `title` \u2014 unless the model already returned a whole
 * HTML page, in which case it passes through untouched (no double
 * header/wrap). Ported verbatim from `docs_html.rs`'s `html_titled_doc`. */
export function htmlTitledDoc(name: string, title: string, body: string): string {
  if (isFullHtmlDoc(body)) {
    return htmlDocument(name, body);
  }
  return htmlDocument(name, docHero("", title, "") + body);
}
