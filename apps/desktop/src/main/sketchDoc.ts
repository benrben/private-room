/**
 * Ported from `src-tauri/src/commands/sketchdoc.rs` (2,811 lines, read in
 * full) — the `.sketch` document format's model, script language, arrow
 * router, layout checker, SVG renderer and described-graph layout engine.
 * The PNG rasteriser (`to_png`), the one piece with a native dependency,
 * lives in `sketchRaster.ts`; the command/tool layer (`sketch.rs`) lives in
 * `sketchCommands.ts`.
 *
 * Everything here is pure, synchronous and deterministic: the same document
 * always produces the same bytes, which is the property the whole format
 * leans on (the hand-drawn "wobble" is seeded from an element's id and
 * nothing else, so a drawing does not redraw differently every time it is
 * opened).
 *
 * Three decisions carried over verbatim from the Rust module doc, each of
 * them a response to a measured failure rather than a preference:
 *
 * 1. THE AGENT NEVER WRITES SVG PATH DATA. Published evaluations of
 *    model-authored SVG put `<path d="…">` at the centre of the failure
 *    distribution, and the error rate climbs with scene complexity. So the
 *    model emits `rect 250 400 320 130 blue "Login form"` and THIS module
 *    emits the geometry. SVG is an output of the format, never an input.
 * 2. COORDINATES ARE INTEGERS ON A FIXED PAGE, clamped rather than refused —
 *    a model that put a box at x=1700 meant it near the right edge, and the
 *    layout report names what moved.
 * 3. COLOUR IS ONE OF FIVE MARKER NAMES, never a hex value, so every drawing
 *    is theme-correct by construction.
 *
 * The script parser is FORGIVING on purpose ({@link sortTokens} sorts tokens
 * by what they LOOK like, not by position, so all three of `rect 250 400 320
 * 130 blue "x"`, `rect x=250 y=400 w=320 h=130 ink=blue "x"` and
 * `rect 250 400 320 130 "x" blue` mean the same thing). VALIDATION is not
 * forgiving: {@link applyScript} is two-pass, so a script with any bad line
 * changes NOTHING and reports every problem at once.
 *
 * ERROR CONVENTION. {@link sketchFromJson} THROWS (Rust's
 * `Result<Sketch, String>`, this port's db-host convention). {@link
 * applyScript} and {@link parseStmt} instead keep a DISCRIMINATED-UNION
 * return, exactly as `editMatch.ts`'s module doc prescribes for a
 * `Result<_, String>` whose failure is a routine, expected outcome: a
 * blanket `catch` around a parser with a dozen internal failure branches
 * would silently swallow an unrelated bug and report it as "line 4 is
 * wrong".
 *
 * ARITHMETIC FIDELITY (verified against a compiled-`rustc` oracle built from
 * this exact Rust source, not derived from the formulae):
 *
 *  - `f64::round()` rounds ties AWAY FROM ZERO (-227.5 → -228); JS's
 *    `Math.round` rounds ties towards +∞ (-227.5 → -227). Every `.round() as
 *    i32` site goes through {@link roundTiesAwayFromZero}. This is reachable:
 *    routing a connector to a box at negative coordinates (a hand-edited
 *    file, or a page resized out from under a shape) hits an exact .5 tie.
 *  - Rust's `{:.N}` float formatting rounds ties to EVEN (`{:.0}` of 250.5 is
 *    "250", of 251.5 is "252"); JS's `toFixed` rounds ties away from zero.
 *    {@link fixed} implements Rust's rule. Reachable on every odd-width box:
 *    a 301-wide rect centred at 250.5 writes its label at x="250" in Rust and
 *    x="251" under a naive `toFixed`.
 *  - Rust `to_ascii_lowercase`/`eq_ignore_ascii_case` leave non-ASCII alone
 *    ("CAFÉ" → "cafÉ"); JS `toLowerCase()` does not ("café"). {@link
 *    asciiLower} is used at every site whose Rust original is the ASCII one —
 *    most visibly {@link layoutReport}'s duplicate-label key, where the
 *    difference is a spurious "both say" note on two differently-cased
 *    accented labels.
 *  - Rust sorts `String` by UTF-8 BYTES; JS sorts by UTF-16 code units, and
 *    the two disagree above the BMP (an emoji label sorts before a fullwidth
 *    one in JS, after it in Rust). {@link compareUtf8} keeps
 *    {@link layoutReport}'s note order identical.
 *  - `clamp_words`'s `head.len() > max / 2` is a BYTE length against a CHAR
 *    count — a deliberate-looking mismatch in the Rust source that decides
 *    real cases (a 25-character Hebrew head is 50 bytes, so it passes the
 *    test its UTF-16 length would fail).
 *
 * SECURITY. Every map keyed by a room- or model-controlled string —
 * `Tokens.named` (a `x=250`-style script token), {@link reflow}'s box
 * lookup, {@link layoutReport}'s duplicate-label key, {@link layoutGraph}'s
 * node-id index — is a `Map`, never a plain `{}`; and every read out of a
 * `JSON.parse`d element object is `hasOwnProperty`-guarded. A `"__proto__"`
 * id, label or key therefore cannot reach `Object.prototype`.
 *
 * JSON SHAPE. Rust's `Element` is `#[serde(flatten)] shape: Shape` over a
 * `#[serde(tag = "type")]` enum, i.e. ONE FLAT MAP per element —
 * `{"id":"e1","type":"rect","x":250,…}`, never a nested `"shape"` key — with
 * `fill`/`label`/`from`/`to`/`locked` omitted at their defaults. Neither
 * `JSON.stringify` nor `JSON.parse` can express that, so
 * {@link elementToJsonValue}/{@link elementFromJsonValue} hand-roll it.
 * READING IS STRICT, matching serde: a document missing `version`/`width`/
 * `height`/`seq`/`elements`, or carrying an element with an unknown `type`
 * or a non-integer coordinate, fails the WHOLE read rather than being
 * partially adopted — because `writeSketch` parses before it writes, and a
 * lenient reader there would let a malformed document quietly become the
 * file and open as a different drawing on the Rust side.
 */

export { CANVAS_W, CANVAS_H, MAX_ELEMENTS, MAX_SCRIPT_LINES, roundTiesAwayFromZero, fixed, asI32, asciiLower, compareUtf8, rustTrim, type Ink, inkHex, inkFillHex, inkParse, type Point, type Shape, type Element, plainElement, type Rect, elementBbox, elementIsSolid, type Sketch, defaultSketch, sketchNextId, sketchIndexOf, sketchExtractedText } from "./sketchDocModel.js";
export { sketchFromJson, sketchToJson } from "./sketchDocJson.js";
export { type ScriptOutcome, scriptOutcomeIsEmpty, scriptOutcomeSummary } from "./sketchDocTokens.js";
export { applyScript } from "./sketchDocApply.js";
export { route, reflow, toScript } from "./sketchDocRouting.js";
export { layoutReport } from "./sketchDocLayout.js";
export { PAPER, FONT, xmlEscape, toSvg } from "./sketchDocSvg.js";
export { type GraphNode, type GraphEdge, layoutGraph } from "./sketchDocGraphLayout.js";
