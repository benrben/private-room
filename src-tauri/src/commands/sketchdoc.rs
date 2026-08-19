//! The sketch document: model, script language, renderer and layout checker.
//!
//! One module owns the format so the page and the agent can never disagree
//! about what a drawing IS. The editor reads and writes `Sketch` as JSON; the
//! agent reads and writes the SAME drawing as a line-based SCRIPT, and both
//! land in the same `apply_script` code path.
//!
//! Three decisions here are load-bearing, and each one exists because of a
//! measured failure mode rather than a preference:
//!
//! 1. **The agent never writes SVG path data.** Published evaluations of
//!    model-authored SVG (SVGenius, SVGEditBench v2) put `<path d="…">` at the
//!    centre of the failure distribution — undefined commands, wrong argument
//!    counts — and the error rate climbs with scene complexity, which is
//!    exactly the direction a drawing grows. So the model emits `rect 250 400
//!    320 130 blue "Login form"` and THIS module emits the geometry. SVG is an
//!    output of the format, never an input to it.
//!
//! 2. **Coordinates are integers on a fixed page.** Sub-pixel precision buys a
//!    drawing nothing and costs tokens on every round trip, and a float that
//!    round-trips through a model comes back as `399.99999`. Everything is
//!    clamped to whole units inside a bounded canvas.
//!
//! 3. **Colour is one of five marker names, never a hex value.** A model asked
//!    for a hex colour will happily pick `#1a1a1a`, which is invisible on this
//!    app's dark paper. Naming the five pens makes every drawing theme-correct
//!    by construction and costs one token instead of four.
//!
//! The script is parsed FORGIVINGLY on purpose (see `Tokens`): a 4B model
//! writes `rect x=250 y=400 …` about as often as it writes the positional
//! form, and refusing one of the two spellings turns a working drawing into a
//! retry loop. What is NOT forgiving is validation: a script with any bad line
//! applies NOTHING and reports every problem at once, so the model repairs the
//! whole script in one pass instead of discovering its mistakes one call at a
//! time.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as _;

/// The page every drawing starts on. Bounded rather than infinite: a model
/// placing a box on an unbounded plane has no frame of reference for "middle"
/// or "to the right of", and produces coordinates that scatter off-screen.
pub(crate) const CANVAS_W: i32 = 1600;
pub(crate) const CANVAS_H: i32 = 1000;

/// How far outside the page an element may sit before the layout checker calls
/// it out. Some overhang is legitimate (a stroke that runs off the edge).
const OFF_PAGE_SLACK: i32 = 40;

/// Ceilings. None of these is a design limit the user should ever meet; they
/// exist so a model that loses its place in a loop cannot write a 40 MB file.
const MAX_ELEMENTS: usize = 400;
const MAX_POINTS: usize = 2_000;
const MAX_LABEL_CHARS: usize = 200;
const MAX_SCRIPT_LINES: usize = 600;
/// Reported errors per script. Past this the list stops being feedback and
/// starts being a wall of text that crowds out the model's own context.
const MAX_REPORTED_ERRORS: usize = 12;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/// The five pens. Named, not hexed — see the module doc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Ink {
    Pink,
    Yellow,
    Green,
    Blue,
    Red,
}

impl Ink {
    /// Ink for the drawn line. These are the light-theme values from
    /// `tokens.css`, because a rendered sketch is drawn on paper (see
    /// `PAPER`) whichever theme the app itself is wearing — an exported file
    /// opened in Preview, or a raster handed to a vision model, has no theme.
    fn hex(self) -> &'static str {
        match self {
            Ink::Pink => "#b23a78",
            Ink::Yellow => "#8a6d0b",
            Ink::Green => "#2e7d4f",
            Ink::Blue => "#2563b0",
            Ink::Red => "#b3362b",
        }
    }

    /// The translucent wash behind a filled shape. Kept well below the ink so
    /// a label on top of a fill still clears contrast.
    fn fill_hex(self) -> &'static str {
        match self {
            Ink::Pink => "#f2dbe8",
            Ink::Yellow => "#f0e6c4",
            Ink::Green => "#d7ecdf",
            Ink::Blue => "#d8e5f5",
            Ink::Red => "#f5dcd8",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Ink::Pink => "pink",
            Ink::Yellow => "yellow",
            Ink::Green => "green",
            Ink::Blue => "blue",
            Ink::Red => "red",
        }
    }

    /// Parse a colour word. The five names, plus the handful of near-misses a
    /// model actually reaches for. Anything else is an error rather than a
    /// silent substitution: a drawing whose colours were quietly reassigned is
    /// worse than one that refused and said why.
    fn parse(word: &str) -> Option<Ink> {
        match word.trim().to_ascii_lowercase().as_str() {
            "pink" | "magenta" | "purple" | "violet" => Some(Ink::Pink),
            "yellow" | "orange" | "amber" | "gold" => Some(Ink::Yellow),
            "green" | "teal" | "emerald" | "lime" => Some(Ink::Green),
            "blue" | "cyan" | "navy" | "indigo" => Some(Ink::Blue),
            "red" | "crimson" | "scarlet" | "maroon" => Some(Ink::Red),
            _ => None,
        }
    }
}

impl Default for Ink {
    fn default() -> Self {
        Ink::Blue
    }
}

/// The geometry half of an element. Internally tagged and flattened into the
/// element object, so the JSON a human or a model reads is one flat map —
/// `{"id":"e1","type":"rect","x":250,…}` — rather than a nested shape object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum Shape {
    Rect { x: i32, y: i32, w: i32, h: i32 },
    Ellipse { x: i32, y: i32, w: i32, h: i32 },
    /// `y` is the text BASELINE, matching SVG's own `<text y=…>`.
    Text { x: i32, y: i32, text: String, size: i32 },
    Arrow { points: Vec<[i32; 2]> },
    Line { points: Vec<[i32; 2]> },
    Pen { points: Vec<[i32; 2]> },
}

impl Shape {
    fn kind(&self) -> &'static str {
        match self {
            Shape::Rect { .. } => "rect",
            Shape::Ellipse { .. } => "ellipse",
            Shape::Text { .. } => "text",
            Shape::Arrow { .. } => "arrow",
            Shape::Line { .. } => "line",
            Shape::Pen { .. } => "pen",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Element {
    pub(crate) id: String,
    #[serde(flatten)]
    pub(crate) shape: Shape,
    #[serde(default)]
    pub(crate) ink: Ink,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) fill: bool,
    /// The word this element carries. This is what makes a drawing legible to
    /// a text-only model, so the tool descriptions push hard for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    /// THE TWO ENDS OF A CONNECTOR.
    ///
    /// `link` used to compute two points and forget which shapes they came
    /// from, so the arrow was a picture of a relationship rather than the
    /// relationship itself: the next `move` left it pointing at where a box
    /// had been. Recording the ends is what lets [`reflow`] keep the diagram
    /// true — for the agent's own edits and for the editor's, which routes by
    /// the same rule (`src/viewers/sketch/model.ts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) to: Option<String>,
    /// Held in place: not pickable, draggable or erasable in the editor.
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) locked: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl Element {
    /// The parts of an element that are nothing in particular — no
    /// attachment, not locked. Every construction site fills the fields it
    /// means and takes these, so adding a field later cannot silently give
    /// one call site a different default from its neighbour.
    pub(crate) fn plain() -> Self {
        Element {
            id: String::new(),
            shape: Shape::Rect { x: 0, y: 0, w: 0, h: 0 },
            ink: Ink::default(),
            fill: false,
            label: None,
            from: None,
            to: None,
            locked: false,
        }
    }
}

/// A rectangle in canvas units. Used for layout checks and arrow routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) w: i32,
    pub(crate) h: i32,
}

impl Rect {
    fn right(self) -> i32 {
        self.x + self.w
    }
    fn bottom(self) -> i32 {
        self.y + self.h
    }
    fn cx(self) -> f64 {
        self.x as f64 + self.w as f64 / 2.0
    }
    fn cy(self) -> f64 {
        self.y as f64 + self.h as f64 / 2.0
    }
    fn overlap(self, other: Rect) -> Option<(i32, i32)> {
        let ox = self.right().min(other.right()) - self.x.max(other.x);
        let oy = self.bottom().min(other.bottom()) - self.y.max(other.y);
        (ox > 0 && oy > 0).then_some((ox, oy))
    }
    fn contains(self, px: i32, py: i32) -> bool {
        px >= self.x && px <= self.right() && py >= self.y && py <= self.bottom()
    }
}

impl Element {
    /// The element's bounding box. Text is measured from its baseline with a
    /// per-character estimate — exact metrics would need the font, and every
    /// consumer here (overlap warnings, arrow routing) wants an approximation
    /// that is stable across platforms rather than one that is precise on one.
    pub(crate) fn bbox(&self) -> Rect {
        match &self.shape {
            Shape::Rect { x, y, w, h } | Shape::Ellipse { x, y, w, h } => {
                Rect { x: *x, y: *y, w: *w, h: *h }
            }
            Shape::Text { x, y, text, size } => {
                let chars = text.chars().count().max(1) as f64;
                Rect {
                    x: *x,
                    y: *y - *size,
                    w: (chars * *size as f64 * 0.52).round() as i32,
                    h: (*size as f64 * 1.25).round() as i32,
                }
            }
            Shape::Arrow { points } | Shape::Line { points } | Shape::Pen { points } => {
                bbox_of_points(points)
            }
        }
    }

    /// What the element says, for the index and for a text-only reader.
    fn words(&self) -> Option<&str> {
        match &self.shape {
            Shape::Text { text, .. } => Some(text.as_str()),
            _ => self.label.as_deref(),
        }
    }

    /// Shapes that enclose an area, and so can meaningfully overlap or be
    /// pointed at. A stroke crossing a box is drawing, not a layout mistake.
    fn is_solid(&self) -> bool {
        matches!(self.shape, Shape::Rect { .. } | Shape::Ellipse { .. })
    }
}

fn bbox_of_points(points: &[[i32; 2]]) -> Rect {
    if points.is_empty() {
        return Rect { x: 0, y: 0, w: 0, h: 0 };
    }
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for p in points {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Sketch {
    pub(crate) version: u32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    /// The id counter. Persisted so ids stay unique across sessions even after
    /// elements are deleted — a reused id would silently retarget an `edit`
    /// the model wrote against the older drawing.
    pub(crate) seq: u32,
    pub(crate) elements: Vec<Element>,
}

impl Default for Sketch {
    fn default() -> Self {
        Sketch { version: 1, width: CANVAS_W, height: CANVAS_H, seq: 0, elements: Vec::new() }
    }
}

impl Sketch {
    pub(crate) fn from_json(raw: &str) -> Result<Sketch, String> {
        if raw.trim().is_empty() {
            return Ok(Sketch::default());
        }
        let mut doc: Sketch = serde_json::from_str(raw)
            .map_err(|e| format!("This sketch file could not be read ({e})."))?;
        if doc.width <= 0 || doc.height <= 0 {
            doc.width = CANVAS_W;
            doc.height = CANVAS_H;
        }
        // A CONNECTOR NEEDS TWO ENDS. An arrow or line carrying one point (a
        // hand-edited file, an import, a half-written stroke) reads as an
        // element everywhere else in this module, and three readers — the SVG
        // renderer, `to_script` and the layout checker — index `points[1]`
        // directly. Dropped on the way in, the way the editor's own `isElement`
        // refuses it, so a bad file opens as a drawing missing one mark rather
        // than panicking whichever command touched it first.
        // Pen rides along because the editor drops it on the same rule: a file
        // that opens as two different drawings depending on which side read it
        // is the one thing this module exists to prevent.
        // BEFORE the counter recovery below, again to match: `parseSketch`
        // filters and then reduces over what survived, so both sides recover
        // the same `seq` from the same list. (A dropped element's id is
        // therefore free to be minted again — it is no longer on the page, so
        // nothing can collide with it.)
        doc.elements.retain(|e| match &e.shape {
            Shape::Arrow { points } | Shape::Line { points } | Shape::Pen { points } => {
                points.len() >= 2
            }
            _ => true,
        });
        // A file hand-edited to reuse an id, or written by an older build that
        // did not persist `seq`, would otherwise mint a duplicate on the next
        // add. Recover the counter from the ids actually present.
        let high = doc
            .elements
            .iter()
            .filter_map(|e| e.id.strip_prefix('e').and_then(|n| n.parse::<u32>().ok()))
            .max()
            .unwrap_or(0);
        doc.seq = doc.seq.max(high);
        Ok(doc)
    }

    pub(crate) fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into())
    }

    fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("e{}", self.seq)
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.elements.iter().position(|e| e.id == id)
    }

    /// The searchable text for this drawing: its labels and notes, one per
    /// line. Deliberately NOT the JSON — indexing the document source would
    /// put coordinates into search results and into the model's context, which
    /// is the same mistake `extract_svg` exists to avoid for `.svg` files.
    pub(crate) fn extracted_text(&self) -> String {
        let mut out = String::new();
        for e in &self.elements {
            if let Some(w) = e.words() {
                let w = w.trim();
                if !w.is_empty() {
                    out.push_str(w);
                    out.push('\n');
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// The script language
// ---------------------------------------------------------------------------

/// One line's worth of tokens, sorted by what they LOOK like rather than by
/// where they sit.
///
/// This is the forgiving half of the parser, and it is deliberate. A small
/// model writes all of these for the same intent:
///
/// ```text
/// rect 250 400 320 130 blue "Login form"
/// rect x=250 y=400 w=320 h=130 blue "Login form"
/// rect 250 400 320 130 "Login form" blue
/// ```
///
/// Sorting tokens by shape instead of position accepts all three, because the
/// alternative — one canonical spelling — spends the model's turns on syntax
/// repair rather than on the drawing.
#[derive(Debug, Default)]
struct Tokens {
    nums: Vec<i64>,
    named: HashMap<String, String>,
    words: Vec<String>,
    refs: Vec<String>,
    quoted: Vec<String>,
}

impl Tokens {
    /// A named value if present, else the next positional number.
    fn num(&self, keys: &[&str], pos: usize) -> Option<i64> {
        for k in keys {
            if let Some(v) = self.named.get(*k) {
                if let Some(n) = parse_num(v) {
                    return Some(n);
                }
            }
        }
        self.nums.get(pos).copied()
    }

    fn ink(&self) -> Option<Ink> {
        self.named
            .get("ink")
            .or_else(|| self.named.get("color"))
            .or_else(|| self.named.get("colour"))
            .and_then(|v| Ink::parse(v))
            .or_else(|| self.words.iter().find_map(|w| Ink::parse(w)))
    }

    fn has_flag(&self, flag: &str) -> bool {
        self.words.iter().any(|w| w.eq_ignore_ascii_case(flag))
            || self
                .named
                .get(flag)
                .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "1"))
    }

    fn label(&self) -> Option<String> {
        self.quoted
            .first()
            .cloned()
            .or_else(|| self.named.get("label").cloned())
            .or_else(|| self.named.get("text").cloned())
            .map(|s| clamp_label(&s))
            .filter(|s| !s.is_empty())
    }

    /// Words that were neither a colour nor a known flag. Reported rather than
    /// ignored: a silently dropped token is how `rect 10 10 100 100 bleu` ends
    /// up a different colour than the model believes it drew.
    fn strays(&self, flags: &[&str]) -> Vec<String> {
        self.words
            .iter()
            .filter(|w| Ink::parse(w).is_none() && !flags.iter().any(|f| w.eq_ignore_ascii_case(f)))
            .cloned()
            .collect()
    }
}

fn parse_num(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Ok(n) = s.parse::<i64>() {
        return Some(n);
    }
    // A model asked for integers still produces `320.0` often enough that
    // rejecting it would be pedantry rather than safety.
    s.parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| f.round() as i64)
}

fn clamp_label(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= MAX_LABEL_CHARS {
        return t.to_string();
    }
    t.chars().take(MAX_LABEL_CHARS).collect::<String>().trim_end().to_string()
}

fn is_ref(tok: &str) -> bool {
    if let Some(n) = tok.strip_prefix('#') {
        return !n.is_empty() && n.chars().all(|c| c.is_ascii_digit());
    }
    if let Some(n) = tok.strip_prefix('e') {
        return !n.is_empty() && n.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// Split one line into tokens, honouring quotes.
///
/// `#` is both a comment marker and the prefix of a back-reference (`#2`), so
/// the digit test decides which. Getting this wrong in either direction is
/// silent: a comment parsed as a reference retargets an edit, and a reference
/// parsed as a comment drops the rest of the line.
fn tokenize(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            // A backslash escapes the next character inside quotes, so a label
            // may contain the quote mark that delimits it. Without this a
            // perfectly reasonable `"the \"login\" box"` split into three
            // tokens and the line was refused for words it never meant.
            Some(_) if c == '\\' => {
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
            }
            Some(q) if c == q => {
                out.push(std::mem::take(&mut cur));
                quote = None;
            }
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                quote = Some(c);
                cur.push('\u{0}'); // sentinel: this token came from quotes
            }
            None if c == '#' => {
                // A comment unless the very next character is a digit.
                if chars.peek().is_some_and(|n| n.is_ascii_digit()) {
                    cur.push(c);
                } else {
                    break;
                }
            }
            None if c.is_whitespace() || c == ',' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn sort_tokens(raw: Vec<String>) -> Tokens {
    let mut t = Tokens::default();
    for tok in raw {
        if let Some(rest) = tok.strip_prefix('\u{0}') {
            t.quoted.push(rest.to_string());
            continue;
        }
        if let Some((k, v)) = tok.split_once('=') {
            if !k.is_empty() {
                t.named.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                continue;
            }
        }
        if is_ref(&tok) {
            t.refs.push(tok);
            continue;
        }
        if let Some(n) = parse_num(&tok) {
            t.nums.push(n);
            continue;
        }
        t.words.push(tok);
    }
    t
}

/// Canonical verb for a written one. The synonyms are the words models reach
/// for unprompted; accepting them costs one match arm and saves a round trip.
fn canon_verb(w: &str) -> &str {
    match w.to_ascii_lowercase().as_str() {
        "rect" | "rectangle" | "box" | "square" => "rect",
        "ellipse" | "circle" | "oval" | "round" => "ellipse",
        "text" | "note" | "label_at" | "write" => "text",
        "arrow" => "arrow",
        "line" => "line",
        "pen" | "stroke" | "draw" | "path" => "pen",
        "link" | "connect" | "join" => "link",
        "move" | "nudge" | "shift" => "move",
        "label" | "rename" | "retitle" => "label",
        "ink" | "color" | "colour" | "recolor" | "recolour" => "ink",
        "delete" | "remove" | "erase" | "del" => "delete",
        "clear" | "reset" => "clear",
        "canvas" | "page" | "size" => "canvas",
        other => {
            // Borrowing the input's lifetime is not possible through the
            // lowercase temporary, so map only known words; unknown verbs are
            // reported with the ORIGINAL spelling by the caller.
            let _ = other;
            ""
        }
    }
}

/// What a script did, so the tool result can be specific about it. "Drew 6
/// things" is not a receipt; "added e12…e17, moved e3" is.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ScriptOutcome {
    pub(crate) added: Vec<String>,
    pub(crate) changed: Vec<String>,
    pub(crate) removed: Vec<String>,
    pub(crate) cleared: bool,
    /// The page size this script set, when it set one. A `canvas` line changes
    /// no element, so without it recorded here a script that ONLY resizes read
    /// as "nothing changed": the editor was handed the wider page and the file
    /// on disk kept the old one.
    pub(crate) resized: Option<(i32, i32)>,
    /// One line per statement, in order, describing what it did. This is the
    /// step-by-step trace the editor animates; it is emitted with the
    /// `sketch-drawn` event and goes nowhere near the tool result.
    pub(crate) steps: Vec<String>,
    /// Lines this deliberately did not carry out, in words the model can act
    /// on. `summary()` is the WHOLE of what `tool_draw` hands back, so a
    /// refusal recorded only in `steps` is one the model never hears — and it
    /// sends the same line again on the next turn.
    pub(crate) refused: Vec<String>,
}

impl ScriptOutcome {
    pub(crate) fn is_empty(&self) -> bool {
        self.added.is_empty()
            && self.changed.is_empty()
            && self.removed.is_empty()
            && !self.cleared
            && self.resized.is_none()
    }

    /// A one-line receipt naming real ids.
    pub(crate) fn summary(&self) -> String {
        let mut parts = Vec::new();
        if self.cleared {
            parts.push("cleared the page".to_string());
        }
        if let Some((w, h)) = self.resized {
            parts.push(format!("set the page to {w}×{h}"));
        }
        if !self.added.is_empty() {
            parts.push(format!("added {}", id_list(&self.added)));
        }
        if !self.changed.is_empty() {
            parts.push(format!("changed {}", id_list(&self.changed)));
        }
        if !self.removed.is_empty() {
            parts.push(format!("deleted {}", id_list(&self.removed)));
        }
        // Last, and never suppressed by a change on another line: a script
        // whose fourth line was refused must not read as a script that did
        // everything it was asked.
        parts.extend(self.refused.iter().cloned());
        if parts.is_empty() {
            return "nothing changed".into();
        }
        parts.join(", ")
    }
}

fn id_list(ids: &[String]) -> String {
    if ids.len() <= 4 {
        return ids.join(", ");
    }
    format!("{}, {} and {} more", ids[0], ids[1], ids.len() - 2)
}

/// Apply a script to a drawing.
///
/// Two-pass by design: every statement is parsed and checked BEFORE any of
/// them is applied. A half-applied script leaves the model reasoning about a
/// drawing that does not exist — it believes 9 of its 10 boxes landed and has
/// no way to tell which — so a script with any bad line changes nothing and
/// reports every problem it found.
pub(crate) fn apply_script(doc: &mut Sketch, script: &str) -> Result<ScriptOutcome, String> {
    let lines: Vec<(usize, &str)> = script
        .lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l.trim()))
        .filter(|(_, l)| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"))
        .collect();

    if lines.is_empty() {
        return Err(format!(
            "That script had no drawing commands in it. One command per line, for example:\n\
             {EXAMPLE_SCRIPT}"
        ));
    }
    if lines.len() > MAX_SCRIPT_LINES {
        return Err(format!(
            "That script has {} lines; {MAX_SCRIPT_LINES} is the most a single call may carry. \
             Split it across calls.",
            lines.len()
        ));
    }

    // Pass 1: parse every line into a statement, collecting errors.
    let mut stmts: Vec<(usize, Stmt)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    // Ids that WILL exist once this script applies, so a later line may refer
    // to something an earlier line created.
    let mut created: Vec<String> = Vec::new();
    let mut live: Vec<String> = doc.elements.iter().map(|e| e.id.clone()).collect();
    let mut projected_seq = doc.seq;
    // The page each line is placed on. A `canvas` line takes effect for the
    // lines BELOW it — the same order pass 2 applies them in — because every
    // coordinate is clamped at parse time: read against the default 1600×1000
    // instead, `canvas 2400 1200` grew the page and then piled everything the
    // script drew in it against the old right-hand edge.
    let mut page = (doc.width, doc.height);

    for (lineno, line) in &lines {
        match parse_stmt(line, &live, &created, page) {
            Ok(stmt) => {
                if let Stmt::Canvas { w, h } = &stmt {
                    page = (*w, *h);
                }
                if stmt.creates() {
                    projected_seq += 1;
                    let id = format!("e{projected_seq}");
                    created.push(id.clone());
                    live.push(id);
                }
                if let Stmt::Delete { target } = &stmt {
                    live.retain(|id| id != target);
                }
                if matches!(stmt, Stmt::Clear) {
                    live.clear();
                    created.clear();
                }
                stmts.push((*lineno, stmt));
            }
            Err(e) => {
                if errors.len() < MAX_REPORTED_ERRORS {
                    errors.push(format!("line {lineno} (`{line}`): {e}"));
                }
            }
        }
    }

    if !errors.is_empty() {
        let more = lines.len().saturating_sub(MAX_REPORTED_ERRORS);
        let tail = if errors.len() >= MAX_REPORTED_ERRORS && more > 0 {
            "\n(more lines may also be wrong — these are the first few.)"
        } else {
            ""
        };
        return Err(format!(
            "Nothing was drawn — {} line(s) could not be read, so the whole script was refused:\n{}{}\n\n{}",
            errors.len(),
            errors.join("\n"),
            tail,
            SCRIPT_HELP
        ));
    }

    // What the page will actually hold: `live` is the projected id list pass 1
    // has been keeping all along, so it already counts this script's deletions
    // and its `clear`. Summing only the creations refused `clear` + a full
    // redraw with a number the script would never reach.
    let projected = live.len();
    if projected > MAX_ELEMENTS {
        return Err(format!(
            "That would put {projected} things on the page; {MAX_ELEMENTS} is the limit. \
             Draw fewer, or start a new sketch."
        ));
    }

    // Pass 2: apply. Every statement here has already been validated against
    // the drawing's projected state, so this pass cannot fail.
    let mut out = ScriptOutcome::default();
    let mut back: Vec<String> = Vec::new(); // ids created by this script, in order
    for (_, stmt) in stmts {
        apply_stmt(doc, stmt, &mut back, &mut out);
    }
    // Once, at the end, rather than after each statement: a script that moves
    // three boxes and then deletes a fourth should route its arrows against
    // where everything finally landed, not against each intermediate step. It
    // is also idempotent, so running it over a script that moved nothing costs
    // one pass and changes nothing.
    reflow(doc);
    Ok(out)
}

/// A reference to an element: an existing id, or `#n` for the nth element this
/// script creates.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Ref {
    Id(String),
    Back(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Stmt {
    Add { shape: Shape, ink: Ink, fill: bool, label: Option<String> },
    Link { from: Ref, to: Ref, ink: Ink, label: Option<String> },
    Move { target: String, dx: i32, dy: i32 },
    Label { target: String, label: String },
    Ink { target: String, ink: Ink },
    Delete { target: String },
    Clear,
    Canvas { w: i32, h: i32 },
}

impl Stmt {
    fn creates(&self) -> bool {
        matches!(self, Stmt::Add { .. } | Stmt::Link { .. })
    }
}

const EXAMPLE_SCRIPT: &str = "rect 250 400 320 130 blue \"Login form\"\n\
     rect 930 400 330 130 green \"Auth service\"\n\
     link #1 #2 blue \"credentials\"";

const SCRIPT_HELP: &str = "Commands (one per line, whole numbers, colours are \
     pink/yellow/green/blue/red):\n\
     rect X Y W H [colour] [fill] \"label\"\n\
     ellipse X Y W H [colour] [fill] \"label\"\n\
     text X Y [colour] [size] \"words\"\n\
     arrow X1 Y1 X2 Y2 [colour] \"label\"\n\
     line X1 Y1 X2 Y2 [colour]\n\
     pen [colour] X1 Y1 X2 Y2 …\n\
     link FROM TO [colour] \"label\"   — routes an arrow between two shapes\n\
     move ID DX DY · label ID \"new\" · ink ID colour · delete ID · clear\n\
     FROM/TO/ID is an existing id like e7, or #1 for the first shape THIS \
     script creates.";

/// `page` is the document's size as of this line — see `apply_script`. Every
/// coordinate below is clamped against it rather than against the default
/// canvas, so a script that widens the page can then draw in the new space.
fn parse_stmt(
    line: &str,
    live: &[String],
    created: &[String],
    page: (i32, i32),
) -> Result<Stmt, String> {
    let raw = tokenize(line);
    if raw.is_empty() {
        return Err("nothing on the line".into());
    }
    // The verb is the first token that is not quoted; a leading quote means the
    // model wrote a bare label with no command.
    let head = raw[0].clone();
    if head.starts_with('\u{0}') {
        return Err("this line starts with a label but no command — put the command first, \
                    e.g. `text 200 300 \"…\"`"
            .into());
    }
    let verb = canon_verb(&head);
    if verb.is_empty() {
        return Err(format!("`{head}` is not a command"));
    }
    let t = sort_tokens(raw.into_iter().skip(1).collect());

    let resolve = |r: &str| -> Result<Ref, String> {
        if let Some(n) = r.strip_prefix('#') {
            let n: usize = n.parse().map_err(|_| format!("`{r}` is not a reference"))?;
            if n == 0 || n > created.len() {
                return Err(format!(
                    "`{r}` points at the {} shape this script creates, but it only creates {}",
                    ordinal(n),
                    created.len()
                ));
            }
            return Ok(Ref::Back(n - 1));
        }
        if live.iter().any(|id| id == r) {
            return Ok(Ref::Id(r.to_string()));
        }
        Err(format!("there is no `{r}` on this page"))
    };
    // Mutating verbs need a target that already exists at this point in the
    // script; `#n` back-references are resolved to a concrete id at apply time.
    let target_of = |t: &Tokens| -> Result<String, String> {
        let r = t.refs.first().ok_or(
            "this command needs the id of something on the page (like e3), or #1 for the \
             first shape this script creates",
        )?;
        match resolve(r)? {
            Ref::Id(id) => Ok(id),
            Ref::Back(i) => Ok(created[i].clone()),
        }
    };

    let ink = t.ink().unwrap_or_default();

    match verb {
        "rect" | "ellipse" => {
            let strays = t.strays(&["fill", "filled", "solid"]);
            if !strays.is_empty() {
                return Err(unknown_words(&strays));
            }
            let (x, y, w, h) = four(&t, ["x", "y", "w", "h"], ["", "", "width", "height"])?;
            if w <= 0 || h <= 0 {
                return Err(format!(
                    "width and height must be positive (got {w}×{h}); the numbers are X Y WIDTH \
                     HEIGHT, not two corners"
                ));
            }
            let (x, y, w, h) = clamp_box(x, y, w, h, page);
            let shape = if verb == "rect" {
                Shape::Rect { x, y, w, h }
            } else {
                Shape::Ellipse { x, y, w, h }
            };
            Ok(Stmt::Add {
                shape,
                ink,
                fill: t.has_flag("fill") || t.has_flag("filled") || t.has_flag("solid"),
                label: t.label(),
            })
        }
        "text" => {
            let strays = t.strays(&[]);
            if !strays.is_empty() {
                return Err(unknown_words(&strays));
            }
            let x = t.num(&["x"], 0).ok_or("needs an X position")? as i32;
            let y = t.num(&["y"], 1).ok_or("needs a Y position")? as i32;
            let text = t.label().ok_or(
                "needs the words to write, in quotes — e.g. `text 200 300 \"retry three times\"`",
            )?;
            let size = t.num(&["size"], 2).unwrap_or(30).clamp(10, 160) as i32;
            Ok(Stmt::Add {
                shape: Shape::Text {
                    x: x.clamp(0, page.0),
                    y: y.clamp(0, page.1),
                    text,
                    size,
                },
                ink,
                fill: false,
                label: None,
            })
        }
        "arrow" | "line" => {
            let strays = t.strays(&[]);
            if !strays.is_empty() {
                return Err(unknown_words(&strays));
            }
            let (x1, y1, x2, y2) =
                four(&t, ["x1", "y1", "x2", "y2"], ["from_x", "from_y", "to_x", "to_y"])?;
            let p = vec![
                [x1.clamp(0, page.0), y1.clamp(0, page.1)],
                [x2.clamp(0, page.0), y2.clamp(0, page.1)],
            ];
            if p[0] == p[1] {
                return Err("start and end are the same point".into());
            }
            let shape =
                if verb == "arrow" { Shape::Arrow { points: p } } else { Shape::Line { points: p } };
            Ok(Stmt::Add { shape, ink, fill: false, label: t.label() })
        }
        "pen" => {
            let strays = t.strays(&[]);
            if !strays.is_empty() {
                return Err(unknown_words(&strays));
            }
            if t.nums.len() < 4 || t.nums.len() % 2 != 0 {
                return Err(format!(
                    "needs an even list of at least two X Y pairs (got {} number(s))",
                    t.nums.len()
                ));
            }
            let points: Vec<[i32; 2]> = t
                .nums
                .chunks(2)
                .take(MAX_POINTS)
                .map(|c| [(c[0] as i32).clamp(0, page.0), (c[1] as i32).clamp(0, page.1)])
                .collect();
            Ok(Stmt::Add { shape: Shape::Pen { points }, ink, fill: false, label: t.label() })
        }
        "link" => {
            let strays = t.strays(&[]);
            if !strays.is_empty() {
                return Err(unknown_words(&strays));
            }
            if t.refs.len() < 2 {
                return Err(
                    "needs two things to connect — e.g. `link e3 e5 \"sends token\"`, or \
                     `link #1 #2` for shapes this script just drew"
                        .into(),
                );
            }
            let from = resolve(&t.refs[0])?;
            let to = resolve(&t.refs[1])?;
            if from == to {
                return Err("cannot connect something to itself".into());
            }
            Ok(Stmt::Link { from, to, ink, label: t.label() })
        }
        "move" => {
            let target = target_of(&t)?;
            let dx = t.num(&["dx"], 0).ok_or("needs how far to move across (DX)")? as i32;
            let dy = t.num(&["dy"], 1).ok_or("needs how far to move down (DY)")? as i32;
            Ok(Stmt::Move { target, dx, dy })
        }
        "label" => {
            let target = target_of(&t)?;
            let label = t.label().ok_or("needs the new label in quotes")?;
            Ok(Stmt::Label { target, label })
        }
        "ink" => {
            let target = target_of(&t)?;
            let ink = t.ink().ok_or(
                "needs a colour: pink, yellow, green, blue or red",
            )?;
            Ok(Stmt::Ink { target, ink })
        }
        "delete" => Ok(Stmt::Delete { target: target_of(&t)? }),
        "clear" => Ok(Stmt::Clear),
        "canvas" => {
            let w = t.num(&["w", "width"], 0).unwrap_or(CANVAS_W as i64) as i32;
            let h = t.num(&["h", "height"], 1).unwrap_or(CANVAS_H as i64) as i32;
            Ok(Stmt::Canvas { w: w.clamp(200, 8000), h: h.clamp(200, 8000) })
        }
        _ => Err(format!("`{head}` is not a command")),
    }
}

fn ordinal(n: usize) -> String {
    match n {
        1 => "1st".into(),
        2 => "2nd".into(),
        3 => "3rd".into(),
        _ => format!("{n}th"),
    }
}

fn unknown_words(strays: &[String]) -> String {
    format!(
        "did not understand {} — colours are pink/yellow/green/blue/red, and any words to \
         show must be in \"quotes\"",
        strays.iter().map(|s| format!("`{s}`")).collect::<Vec<_>>().join(", ")
    )
}

fn four(
    t: &Tokens,
    keys: [&str; 4],
    alt: [&str; 4],
) -> Result<(i32, i32, i32, i32), String> {
    let mut got = [0i64; 4];
    for i in 0..4 {
        let names: Vec<&str> =
            [keys[i], alt[i]].into_iter().filter(|s| !s.is_empty()).collect();
        got[i] = t.num(&names, i).ok_or_else(|| {
            format!("needs four numbers ({}); got {}", keys.join(" "), t.nums.len())
        })?;
    }
    Ok((got[0] as i32, got[1] as i32, got[2] as i32, got[3] as i32))
}

/// Keep a shape on the page. Clamping rather than refusing: a model that put a
/// box at x=1700 meant it to be near the right edge, and moving it there is a
/// better answer than a syntax error — the layout report tells it what moved.
///
/// `page` is the document's OWN size, which `canvas` may have just changed.
fn clamp_box(x: i32, y: i32, w: i32, h: i32, (pw, ph): (i32, i32)) -> (i32, i32, i32, i32) {
    let w = w.clamp(1, pw);
    let h = h.clamp(1, ph);
    let x = x.clamp(0, pw - w);
    let y = y.clamp(0, ph - h);
    (x, y, w, h)
}

fn apply_stmt(doc: &mut Sketch, stmt: Stmt, back: &mut Vec<String>, out: &mut ScriptOutcome) {
    match stmt {
        Stmt::Add { shape, ink, fill, label } => {
            let id = doc.next_id();
            let kind = shape.kind();
            let what = label.clone().unwrap_or_else(|| match &shape {
                Shape::Text { text, .. } => text.clone(),
                _ => String::new(),
            });
            doc.elements.push(Element {
                id: id.clone(),
                shape,
                ink,
                fill,
                label,
                ..Element::plain()
            });
            back.push(id.clone());
            out.steps.push(if what.is_empty() {
                format!("drew {kind} {id}")
            } else {
                format!("drew {kind} {id} \"{what}\"")
            });
            out.added.push(id);
        }
        Stmt::Link { from, to, ink, label } => {
            let a = resolve_back(&from, back);
            let b = resolve_back(&to, back);
            let (p, q) = match (doc.index_of(&a), doc.index_of(&b)) {
                (Some(i), Some(j)) => (doc.elements[i].bbox(), doc.elements[j].bbox()),
                _ => {
                    // Both ends were checked in pass 1; this arm is only
                    // reachable if a later `delete` removed one, which pass 1
                    // also tracks. Skip rather than draw a nonsense arrow.
                    out.steps.push("skipped a link whose ends went away".into());
                    return;
                }
            };
            let (start, end) = route(p, q);
            let id = doc.next_id();
            doc.elements.push(Element {
                id: id.clone(),
                shape: Shape::Arrow { points: vec![start, end] },
                ink,
                fill: false,
                label: label.clone(),
                // What makes this a LINK and not an arrow that happens to be
                // in the right place. `reflow` reads these after every edit.
                from: Some(a.clone()),
                to: Some(b.clone()),
                locked: false,
            });
            back.push(id.clone());
            out.steps.push(match &label {
                Some(l) => format!("linked {a} → {b} as {id} \"{l}\""),
                None => format!("linked {a} → {b} as {id}"),
            });
            out.added.push(id);
        }
        Stmt::Move { target, dx, dy } => {
            if let Some(i) = doc.index_of(&target) {
                // A connector's points are `reflow`'s to write: it re-routes
                // both ends against its shapes at the end of every script, so
                // moving one here would be reported as done and then discarded
                // in the same call — and the model, reading the drawing back
                // unchanged, moves it again, and again.
                if let Some((from, to)) = attached_ends(doc, i) {
                    // One sentence, both carriers: the editor's trace and the
                    // tool result have to say the same thing, and writing it
                    // twice is how they stop agreeing.
                    let why = format!(
                        "left {target} where it is (a connector between {from} and {to} — \
                         move {from} or {to} instead)"
                    );
                    out.steps.push(why.clone());
                    out.refused.push(why);
                    return;
                }
                let page = (doc.width, doc.height);
                translate(&mut doc.elements[i].shape, dx, dy, page);
                out.steps.push(format!("moved {target} by {dx},{dy}"));
                note_changed(out, target);
            }
        }
        Stmt::Label { target, label } => {
            if let Some(i) = doc.index_of(&target) {
                let e = &mut doc.elements[i];
                if let Shape::Text { text, .. } = &mut e.shape {
                    *text = label.clone();
                } else {
                    e.label = Some(label.clone());
                }
                out.steps.push(format!("relabelled {target} to \"{label}\""));
                note_changed(out, target);
            }
        }
        Stmt::Ink { target, ink } => {
            if let Some(i) = doc.index_of(&target) {
                doc.elements[i].ink = ink;
                out.steps.push(format!("recoloured {target} {}", ink.name()));
                note_changed(out, target);
            }
        }
        Stmt::Delete { target } => {
            if let Some(i) = doc.index_of(&target) {
                doc.elements.remove(i);
                out.steps.push(format!("deleted {target}"));
                out.removed.push(target);
            }
        }
        Stmt::Clear => {
            let n = doc.elements.len();
            doc.elements.clear();
            back.clear();
            out.cleared = true;
            out.steps.push(format!("cleared the page ({n} removed)"));
        }
        Stmt::Canvas { w, h } => {
            // Only a real change counts. `to_script` opens every reading with
            // the drawing's own `canvas` line, so a script the agent edited and
            // sent back would otherwise re-save the file on every round trip
            // and claim a change nobody made.
            if (doc.width, doc.height) != (w, h) {
                out.resized = Some((w, h));
            }
            doc.width = w;
            doc.height = h;
            out.steps.push(format!("set the page to {w}×{h}"));
        }
    }
}

/// The two shapes a connector is attached to, when both are still on the page.
///
/// Both, deliberately: `reflow` re-routes only a connector whose ends it can
/// BOTH find, and drops the attachment otherwise — so an arrow with one end
/// missing is an ordinary arrow again and moves like one.
fn attached_ends(doc: &Sketch, index: usize) -> Option<(String, String)> {
    let e = &doc.elements[index];
    if !matches!(e.shape, Shape::Arrow { .. } | Shape::Line { .. }) {
        return None;
    }
    let from = e.from.as_deref()?;
    let to = e.to.as_deref()?;
    if doc.index_of(from).is_none() || doc.index_of(to).is_none() {
        return None;
    }
    Some((from.to_string(), to.to_string()))
}

fn note_changed(out: &mut ScriptOutcome, id: String) {
    if !out.changed.contains(&id) {
        out.changed.push(id);
    }
}

fn resolve_back(r: &Ref, back: &[String]) -> String {
    match r {
        Ref::Id(id) => id.clone(),
        Ref::Back(i) => back.get(*i).cloned().unwrap_or_default(),
    }
}

fn translate(shape: &mut Shape, dx: i32, dy: i32, (pw, ph): (i32, i32)) {
    match shape {
        Shape::Rect { x, y, w, h } | Shape::Ellipse { x, y, w, h } => {
            // `.max(0)`: a shape can be WIDER than the page it sits on — a
            // `canvas` line may shrink the page under it, and a hand-edited
            // file can hold anything — and an inverted clamp range panics.
            *x = (*x + dx).clamp(0, (pw - *w).max(0));
            *y = (*y + dy).clamp(0, (ph - *h).max(0));
        }
        Shape::Text { x, y, .. } => {
            *x = (*x + dx).clamp(0, pw);
            *y = (*y + dy).clamp(0, ph);
        }
        Shape::Arrow { points } | Shape::Line { points } | Shape::Pen { points } => {
            for p in points {
                p[0] = (p[0] + dx).clamp(0, pw);
                p[1] = (p[1] + dy).clamp(0, ph);
            }
        }
    }
}

/// Route an arrow between two boxes: centre to centre, trimmed to each box's
/// edge with a small gap.
///
/// Re-route every attached connector against where its ends are NOW.
///
/// The other half of recording `from`/`to`. Without it a link is only correct
/// until the first `move`: the agent would tidy a diagram and leave every
/// arrow pointing at the empty space a box used to occupy — and, worse, keep
/// reporting the connection in `layout_report`, so it would believe the
/// picture was still right.
///
/// An end whose element is gone drops the attachment and keeps the last
/// points, exactly as the editor does (`model.ts` `reflow`). The two sides
/// must agree: one document, one picture, whoever drew it.
pub(crate) fn reflow(doc: &mut Sketch) {
    let boxes: std::collections::HashMap<String, Rect> = doc
        .elements
        .iter()
        .map(|e| (e.id.clone(), e.bbox()))
        .collect();
    for e in &mut doc.elements {
        if e.from.is_none() && e.to.is_none() {
            continue;
        }
        if !matches!(e.shape, Shape::Arrow { .. } | Shape::Line { .. }) {
            continue;
        }
        let a = e.from.as_ref().and_then(|id| boxes.get(id)).copied();
        let b = e.to.as_ref().and_then(|id| boxes.get(id)).copied();
        match (a, b) {
            (Some(a), Some(b)) => {
                let (start, end) = route(a, b);
                match &mut e.shape {
                    Shape::Arrow { points } | Shape::Line { points } => {
                        *points = vec![start, end];
                    }
                    _ => {}
                }
            }
            _ => {
                e.from = None;
                e.to = None;
            }
        }
    }
}

/// This exists so the model never does arrow arithmetic. Asked to connect two
/// boxes it will confidently emit endpoints that start inside one shape and
/// stop short of the other, and that error is invisible in text — it only
/// shows up in the picture, which the model usually cannot see.
///
/// An endpoint belongs to the SHAPE it touches, not to the page. Nothing is
/// clamped here — `routeBetween` clamps nothing either, and the two must agree
/// to the unit or every alternation between the agent and the editor rewrites
/// the same connector. Clamping to the canvas was how `layout_graph`'s fifth
/// column lost its arrows; clamping to the page instead only moved the line,
/// and a shape CAN sit past the page edge (a page shrunk under it, a file
/// written by hand) with a connector that must still reach it.
fn route(a: Rect, b: Rect) -> ([i32; 2], [i32; 2]) {
    let (ax, ay, bx, by) = (a.cx(), a.cy(), b.cx(), b.cy());
    let (dx, dy) = (bx - ax, by - ay);
    let len = (dx * dx + dy * dy).sqrt();
    // Two shapes sharing a centre have no direction between them. Both ends
    // land on the centres — the same answer `routeBetween` gives — rather than
    // dividing by a fabricated length of 1, which sent the ray to infinity and
    // wrote [0,0] into the file as `NaN as i32`.
    if len == 0.0 {
        return (
            [ax.round() as i32, ay.round() as i32],
            [bx.round() as i32, by.round() as i32],
        );
    }
    let (ux, uy) = (dx / len, dy / len);
    (edge_point(a, ux, uy, CONNECT_GAP), edge_point(b, -ux, -uy, CONNECT_GAP))
}

/// How far a connector stops short of the shape it points at. The editor's
/// `CONNECT_GAP` (`src/viewers/sketch/model.ts`) is the same number, and it has
/// to be: the two sides route the SAME connector, so a difference of two units
/// meant every alternation between the agent and the editor rewrote the file.
const CONNECT_GAP: f64 = 8.0;

/// Walk from a box's centre along a unit vector until leaving the box, plus a
/// gap. Uses the slab method so it is exact for any direction.
///
/// The gap grows the box rather than extending the ray, which is what
/// `edgePoint` does — on a diagonal the two are several units apart.
fn edge_point(r: Rect, ux: f64, uy: f64, gap: f64) -> [i32; 2] {
    let hw = r.w as f64 / 2.0 + gap;
    let hh = r.h as f64 / 2.0 + gap;
    let tx = if ux == 0.0 { f64::INFINITY } else { (hw / ux).abs() };
    let ty = if uy == 0.0 { f64::INFINITY } else { (hh / uy).abs() };
    let t = tx.min(ty);
    // Neither axis was crossed: the direction is the zero vector, so there is
    // no edge to walk to. The centre is the honest answer.
    if !t.is_finite() {
        return [r.cx().round() as i32, r.cy().round() as i32];
    }
    [(r.cx() + ux * t).round() as i32, (r.cy() + uy * t).round() as i32]
}

// ---------------------------------------------------------------------------
// Reading a drawing back out as script
// ---------------------------------------------------------------------------

/// The drawing as the same language that writes it.
///
/// Read and write share one vocabulary on purpose: a model that has just been
/// shown `e3 rect 250 400 320 130 blue "Login form"` does not have to translate
/// anything to edit it, and the round trip is testable in one property.
pub(crate) fn to_script(doc: &Sketch) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "canvas {} {}", doc.width, doc.height);
    for e in &doc.elements {
        let ink = e.ink.name();
        let label = match e.label.as_deref() {
            Some(l) if !l.is_empty() => format!(" {}", quote(l)),
            _ => String::new(),
        };
        let line = match &e.shape {
            Shape::Rect { x, y, w, h } => format!(
                "{} rect {x} {y} {w} {h} {ink}{}{label}",
                e.id,
                if e.fill { " fill" } else { "" }
            ),
            Shape::Ellipse { x, y, w, h } => format!(
                "{} ellipse {x} {y} {w} {h} {ink}{}{label}",
                e.id,
                if e.fill { " fill" } else { "" }
            ),
            Shape::Text { x, y, text, size } => {
                format!("{} text {x} {y} {ink} {size} {}", e.id, quote(text))
            }
            // Both ends or nothing: an arrow with one point has no line to
            // describe, and reading it back as script is what an agent does
            // with a file it did not write.
            Shape::Arrow { points } | Shape::Line { points }
                if points.len() < 2 =>
            {
                continue
            }
            Shape::Arrow { points } => format!(
                "{} arrow {} {} {} {} {ink}{label}",
                e.id, points[0][0], points[0][1], points[1][0], points[1][1]
            ),
            Shape::Line { points } => format!(
                "{} line {} {} {} {} {ink}",
                e.id, points[0][0], points[0][1], points[1][0], points[1][1]
            ),
            // A freehand stroke's point list is neither useful nor editable to
            // a model — it is a hundred numbers describing a squiggle. Show
            // where it is and how big, and nothing else.
            Shape::Pen { points } => {
                let b = bbox_of_points(points);
                format!(
                    "{} pen {ink} — freehand, {} points around {} {} ({}×{}){label}",
                    e.id,
                    points.len(),
                    b.x,
                    b.y,
                    b.w,
                    b.h
                )
            }
        };
        let _ = writeln!(out, "{line}");
    }
    out
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "'"))
}

// ---------------------------------------------------------------------------
// The layout checker
// ---------------------------------------------------------------------------

/// Problems a drawing can have that are visible at a glance but invisible in
/// text.
///
/// This is the other half of "let the agent see its work". A rendered picture
/// only helps a model that can read pictures well, and the small local models
/// this app is built around cannot. Every check here is geometric, exact, and
/// phrased as an instruction the model can act on directly.
pub(crate) fn layout_report(doc: &Sketch) -> Vec<String> {
    let mut notes = Vec::new();

    // Overlapping shapes: the single most common way a generated diagram comes
    // out unreadable, because the model places boxes on a grid it is imagining
    // and never checks the arithmetic.
    let solids: Vec<&Element> = doc.elements.iter().filter(|e| e.is_solid()).collect();
    for (i, a) in solids.iter().enumerate() {
        for b in solids.iter().skip(i + 1) {
            if let Some((ox, oy)) = a.bbox().overlap(b.bbox()) {
                notes.push(format!(
                    "{} and {} overlap by {}×{} — move one of them apart.",
                    a.id, b.id, ox, oy
                ));
            }
        }
    }

    // Off the page.
    for e in &doc.elements {
        let b = e.bbox();
        if b.x < -OFF_PAGE_SLACK
            || b.y < -OFF_PAGE_SLACK
            || b.right() > doc.width + OFF_PAGE_SLACK
            || b.bottom() > doc.height + OFF_PAGE_SLACK
        {
            notes.push(format!(
                "{} sits outside the {}×{} page (at {} {}, {}×{}) — move it back on.",
                e.id, doc.width, doc.height, b.x, b.y, b.w, b.h
            ));
        }
    }

    // Unlabelled shapes: a box with no word in it is invisible to every
    // text-only reader of this drawing, including the agent's own next turn.
    for e in &doc.elements {
        if e.is_solid() && e.label.as_deref().unwrap_or("").trim().is_empty() {
            notes.push(format!("{} has no label — give it one so it can be read.", e.id));
        }
    }

    // Arrows that point at nothing. Checked against solid shapes only: a
    // free-floating arrow is legitimate, but one whose ends MISS boxes that
    // sit nearby is almost always intended to connect them.
    for e in &doc.elements {
        let Shape::Arrow { points } = &e.shape else { continue };
        // `from_json` drops a one-point arrow, but a document built in memory
        // does not pass through it, and this loop reads both ends.
        let (Some(&s), Some(&t)) = (points.first(), points.get(1)) else { continue };
        let touches = |p: [i32; 2]| {
            solids.iter().any(|o| grow(o.bbox(), 14).contains(p[0], p[1]))
        };
        let near = |p: [i32; 2]| solids.iter().any(|o| grow(o.bbox(), 90).contains(p[0], p[1]));
        let (st, tt) = (touches(s), touches(t));
        if (!st && near(s)) || (!tt && near(t)) {
            notes.push(format!(
                "{} nearly touches a shape but stops short — use `link` to connect two shapes \
                 instead of placing arrow ends by hand.",
                e.id
            ));
        }
    }

    // Text sitting on top of a shape it does not belong to. A label belongs
    // INSIDE its own box; a separate note landing there reads as that box's
    // caption and says the wrong thing.
    for e in &doc.elements {
        let Shape::Text { .. } = &e.shape else { continue };
        for s in &solids {
            if let Some((ox, oy)) = e.bbox().overlap(s.bbox()) {
                if ox > 8 && oy > 8 {
                    notes.push(format!(
                        "the note {} lies on top of {} — move it clear, or make it {}'s label.",
                        e.id, s.id, s.id
                    ));
                }
            }
        }
    }

    // Duplicate labels: two boxes saying the same thing is usually a repeated
    // add, not a deliberate choice.
    //
    // Boxes only. Arrows repeat their labels legitimately and constantly — a
    // flow chart is full of "then", "yes" and "no" — and reporting those sent
    // the agent off deleting the connections that made the diagram readable.
    let mut seen: HashMap<String, &str> = HashMap::new();
    for e in &doc.elements {
        if !e.is_solid() && !matches!(e.shape, Shape::Text { .. }) {
            continue;
        }
        let Some(w) = e.words() else { continue };
        let key = w.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        if let Some(prev) = seen.insert(key, &e.id) {
            notes.push(format!(
                "{} and {} both say \"{}\" — delete one if it is a duplicate.",
                prev,
                e.id,
                w.trim()
            ));
        }
    }

    notes.sort();
    notes.dedup();
    notes
}

fn grow(r: Rect, by: i32) -> Rect {
    Rect { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Paper. An explicit background means an exported file and a rasterised
/// screenshot are both legible wherever they are opened, rather than depending
/// on the viewer's own backdrop.
const PAPER: &str = "#f4f1e8";

/// A tiny deterministic PRNG, seeded from the element id.
///
/// The wobble that makes these drawings look hand-drawn MUST be a function of
/// the id and nothing else. Randomising per render would make a sketch redraw
/// differently every time it is opened, and would break the one property the
/// tests lean on hardest: the same document always produces the same bytes.
fn seeded(id: &str) -> impl FnMut() -> f64 {
    let mut h: u32 = 2166136261;
    for b in id.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(16777619);
    }
    move || {
        h ^= h << 13;
        h ^= h >> 17;
        h ^= h << 5;
        (h % 100_000) as f64 / 100_000.0
    }
}

fn wobbly_segment(r: &mut impl FnMut() -> f64, x1: f64, y1: f64, x2: f64, y2: f64, a: f64) -> String {
    let j = |r: &mut dyn FnMut() -> f64, amp: f64| (r() * 2.0 - 1.0) * amp;
    let mx = (x1 + x2) / 2.0 + j(r, a * 1.8);
    let my = (y1 + y2) / 2.0 + j(r, a * 1.8);
    format!(
        "M{:.1} {:.1}Q{:.1} {:.1} {:.1} {:.1}",
        x1 + j(r, a),
        y1 + j(r, a),
        mx,
        my,
        x2 + j(r, a),
        y2 + j(r, a)
    )
}

/// The drawing as a standalone SVG document.
///
/// One renderer serves both the exported `.svg` room file and the raster the
/// agent looks at, so what the agent inspects is what the user has.
pub(crate) fn to_svg(doc: &Sketch) -> String {
    let (w, h) = (doc.width, doc.height);
    let mut s = String::with_capacity(1024 + doc.elements.len() * 200);
    let _ = write!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">"#
    );
    let _ = write!(s, r#"<rect width="{w}" height="{h}" fill="{PAPER}"/>"#);
    for e in &doc.elements {
        let mut r = seeded(&e.id);
        let ink = e.ink.hex();
        match &e.shape {
            Shape::Rect { x, y, w: bw, h: bh } => {
                let (x, y, bw, bh) = (*x as f64, *y as f64, *bw as f64, *bh as f64);
                if e.fill {
                    let _ = write!(
                        s,
                        r#"<rect x="{x}" y="{y}" width="{bw}" height="{bh}" rx="8" fill="{}"/>"#,
                        e.ink.fill_hex()
                    );
                }
                let mut d = String::new();
                for _ in 0..2 {
                    d.push_str(&wobbly_segment(&mut r, x, y, x + bw, y, 2.2));
                    d.push_str(&wobbly_segment(&mut r, x + bw, y, x + bw, y + bh, 2.2));
                    d.push_str(&wobbly_segment(&mut r, x + bw, y + bh, x, y + bh, 2.2));
                    d.push_str(&wobbly_segment(&mut r, x, y + bh, x, y, 2.2));
                }
                let _ = write!(
                    s,
                    r#"<path d="{d}" fill="none" stroke="{ink}" stroke-width="3" stroke-linecap="round"/>"#
                );
                write_label(&mut s, e, x + bw / 2.0, y + bh / 2.0 + 9.0, ink);
            }
            Shape::Ellipse { x, y, w: bw, h: bh } => {
                let (cx, cy) = (*x as f64 + *bw as f64 / 2.0, *y as f64 + *bh as f64 / 2.0);
                let (rx, ry) = (*bw as f64 / 2.0, *bh as f64 / 2.0);
                if e.fill {
                    let _ = write!(
                        s,
                        r#"<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{}"/>"#,
                        e.ink.fill_hex()
                    );
                }
                let mut d = String::new();
                for _ in 0..2 {
                    let n = 16;
                    let wob = (rx.min(ry) * 0.04 + 1.5).min(4.0);
                    let pts: Vec<(f64, f64)> = (0..n)
                        .map(|i| {
                            let t = i as f64 / n as f64 * std::f64::consts::TAU;
                            let jr = (r() * 2.0 - 1.0) * wob;
                            (cx + t.cos() * (rx + jr), cy + t.sin() * (ry + jr))
                        })
                        .collect();
                    let mid = |a: (f64, f64), b: (f64, f64)| ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
                    let start = mid(pts[0], pts[1 % n]);
                    let _ = write!(d, "M{:.1} {:.1}", start.0, start.1);
                    for k in 1..=n {
                        let a = pts[k % n];
                        let b = pts[(k + 1) % n];
                        let m = mid(a, b);
                        let _ =
                            write!(d, "Q{:.1} {:.1} {:.1} {:.1}", a.0, a.1, m.0, m.1);
                    }
                    d.push('Z');
                }
                let _ = write!(
                    s,
                    r#"<path d="{d}" fill="none" stroke="{ink}" stroke-width="3" stroke-linecap="round"/>"#
                );
                write_label(&mut s, e, cx, cy + 9.0, ink);
            }
            Shape::Text { x, y, text, size } => {
                let _ = write!(
                    s,
                    r#"<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" fill="{ink}">{}</text>"#,
                    xml_escape(text)
                );
            }
            // One point is not a line, so there is nothing to stroke. Drawn as
            // nothing rather than indexed into: this renderer serves the
            // exported file and the raster the agent inspects, and neither may
            // panic on a document somebody else wrote.
            Shape::Line { points } | Shape::Arrow { points } if points.len() < 2 => {}
            Shape::Line { points } => {
                let d = wobbly_segment(
                    &mut r,
                    points[0][0] as f64,
                    points[0][1] as f64,
                    points[1][0] as f64,
                    points[1][1] as f64,
                    2.5,
                );
                let _ = write!(
                    s,
                    r#"<path d="{d}" fill="none" stroke="{ink}" stroke-width="3" stroke-linecap="round"/>"#
                );
            }
            Shape::Arrow { points } => {
                let (x1, y1) = (points[0][0] as f64, points[0][1] as f64);
                let (x2, y2) = (points[1][0] as f64, points[1][1] as f64);
                let d = wobbly_segment(&mut r, x1, y1, x2, y2, 2.5);
                let _ = write!(
                    s,
                    r#"<path d="{d}" fill="none" stroke="{ink}" stroke-width="3" stroke-linecap="round"/>"#
                );
                let ang = (y2 - y1).atan2(x2 - x1);
                let hl = 20.0;
                for a in [ang + 2.6, ang - 2.6] {
                    let _ = write!(
                        s,
                        r#"<path d="M{x2:.1} {y2:.1}L{:.1} {:.1}" stroke="{ink}" stroke-width="3" fill="none" stroke-linecap="round"/>"#,
                        x2 + a.cos() * hl,
                        y2 + a.sin() * hl
                    );
                }
                if let Some(l) = e.label.as_deref().filter(|l| !l.is_empty()) {
                    let _ = write!(
                        s,
                        r#"<text x="{:.0}" y="{:.0}" font-family="{FONT}" font-size="24" fill="{ink}" text-anchor="middle">{}</text>"#,
                        (x1 + x2) / 2.0,
                        (y1 + y2) / 2.0 - 12.0,
                        xml_escape(l)
                    );
                }
            }
            Shape::Pen { points } => {
                let mut d = String::new();
                if let Some(first) = points.first() {
                    let _ = write!(d, "M{} {}", first[0], first[1]);
                    for win in points.windows(2) {
                        let (a, b) = (win[0], win[1]);
                        let _ = write!(
                            d,
                            "Q{} {} {} {}",
                            a[0],
                            a[1],
                            (a[0] + b[0]) / 2,
                            (a[1] + b[1]) / 2
                        );
                    }
                    if let Some(last) = points.last() {
                        let _ = write!(d, "L{} {}", last[0], last[1]);
                    }
                }
                let _ = write!(
                    s,
                    r#"<path d="{d}" fill="none" stroke="{ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>"#
                );
            }
        }
    }
    s.push_str("</svg>");
    s
}

/// Fallbacks only — a rasteriser loads whatever the system has, and an
/// exported file opens on machines that have none of these. Ending the stack
/// with a generic family is what keeps text visible rather than absent.
const FONT: &str = "Bradley Hand, Noteworthy, Chalkboard SE, Segoe Print, Comic Sans MS, cursive, sans-serif";

fn write_label(s: &mut String, e: &Element, cx: f64, cy: f64, ink: &str) {
    let Some(l) = e.label.as_deref().filter(|l| !l.trim().is_empty()) else { return };
    let _ = write!(
        s,
        r#"<text x="{cx:.0}" y="{cy:.0}" font-family="{FONT}" font-size="26" fill="{ink}" text-anchor="middle">{}</text>"#,
        xml_escape(l)
    );
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// ---------------------------------------------------------------------------
// Laying a described graph out
// ---------------------------------------------------------------------------

/// One thing in a described diagram.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GraphNode {
    pub(crate) id: String,
    pub(crate) label: String,
    /// One short line of explanation, drawn under the box.
    #[serde(default)]
    pub(crate) note: Option<String>,
    /// `start`, `end` or anything else (a plain step).
    #[serde(default)]
    pub(crate) kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GraphEdge {
    pub(crate) from: String,
    pub(crate) to: String,
    #[serde(default)]
    pub(crate) label: Option<String>,
}

/// Turn a DESCRIBED graph into a drawing.
///
/// This is the part `#sketch` exists for, and it is deliberately not the
/// model's job. Asked for a diagram, a model can reliably say what the boxes
/// are and which ones connect; it cannot reliably say where they go — that is
/// arithmetic over a canvas it cannot see, and it is where generated diagrams
/// come out overlapping and mis-wired.
///
/// So the model supplies meaning and this supplies geometry: nodes are layered
/// by how far they sit from a starting point, laid out in columns, and every
/// edge is routed edge-to-edge by the same code the `link` command uses. The
/// result cannot overlap and cannot have a dangling arrow, which is why
/// `#sketch` needs no correction pass.
pub(crate) fn layout_graph(nodes: &[GraphNode], edges: &[GraphEdge]) -> Sketch {
    let mut doc = Sketch::default();
    if nodes.is_empty() {
        return doc;
    }
    let nodes: Vec<&GraphNode> = nodes.iter().take(MAX_ELEMENTS / 4).collect();
    let index: HashMap<&str, usize> =
        nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    // Only edges whose ends both exist. A model that invents an endpoint would
    // otherwise produce an arrow from nowhere.
    let live: Vec<(usize, usize, Option<&str>)> = edges
        .iter()
        .filter_map(|e| {
            let a = *index.get(e.from.as_str())?;
            let b = *index.get(e.to.as_str())?;
            (a != b).then_some((a, b, e.label.as_deref()))
        })
        .collect();

    let layer = layer_nodes(nodes.len(), &live);
    let layers = layer.iter().max().copied().unwrap_or(0) + 1;

    // Columns across, rows down. The canvas grows taller when a layer is
    // crowded rather than squeezing boxes until their labels stop fitting.
    let mut per_layer: Vec<Vec<usize>> = vec![Vec::new(); layers];
    for (i, l) in layer.iter().enumerate() {
        per_layer[*l].push(i);
    }
    let tallest = per_layer.iter().map(Vec::len).max().unwrap_or(1);
    const BOX_W: i32 = 300;
    const BOX_H: i32 = 130;
    const GAP_X: i32 = 130;
    const GAP_Y: i32 = 90;
    const MARGIN: i32 = 80;

    doc.width = (MARGIN * 2 + layers as i32 * BOX_W + (layers as i32 - 1).max(0) * GAP_X)
        .max(CANVAS_W);
    doc.height = (MARGIN * 2 + tallest as i32 * BOX_H + (tallest as i32 - 1).max(0) * GAP_Y)
        .max(CANVAS_H);

    // Ink by column, so the eye can follow the stages of a flow. The five pens
    // cycle; a diagram deeper than five layers repeats, which reads as a
    // rhythm rather than as five arbitrary colours.
    const WHEEL: [Ink; 5] = [Ink::Blue, Ink::Green, Ink::Yellow, Ink::Pink, Ink::Red];

    let mut ids: Vec<String> = vec![String::new(); nodes.len()];
    for (l, column) in per_layer.iter().enumerate() {
        let x = MARGIN + l as i32 * (BOX_W + GAP_X);
        let block = column.len() as i32 * BOX_H + (column.len() as i32 - 1).max(0) * GAP_Y;
        let top = ((doc.height - block) / 2).max(MARGIN);
        for (row, &n) in column.iter().enumerate() {
            let y = top + row as i32 * (BOX_H + GAP_Y);
            let node = nodes[n];
            let terminal = matches!(
                node.kind.as_deref().map(str::to_ascii_lowercase).as_deref(),
                Some("start") | Some("end") | Some("terminal")
            );
            let ink = WHEEL[l % WHEEL.len()];
            let id = doc.next_id();
            doc.elements.push(Element {
                id: id.clone(),
                shape: if terminal {
                    Shape::Ellipse { x, y, w: BOX_W, h: BOX_H }
                } else {
                    Shape::Rect { x, y, w: BOX_W, h: BOX_H }
                },
                ink,
                fill: terminal,
                label: Some(clamp_label(&node.label)),
                ..Element::plain()
            });
            ids[n] = id;
            // The explanation, under its box. Short by construction: a
            // paragraph here would collide with the next row, and the reply
            // text is where the long version belongs.
            if let Some(note) = node.note.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let note = clamp_words(note, 60);
                let text_id = doc.next_id();
                doc.elements.push(Element {
                    id: text_id,
                    shape: Shape::Text {
                        x,
                        y: y + BOX_H + 34,
                        text: note,
                        size: 22,
                    },
                    ink,
                    fill: false,
                    label: None,
                    ..Element::plain()
                });
            }
        }
    }

    for (a, b, label) in live {
        let (ra, rb) = (
            doc.elements[doc.index_of(&ids[a]).unwrap()].bbox(),
            doc.elements[doc.index_of(&ids[b]).unwrap()].bbox(),
        );
        let (start, end) = route(ra, rb);
        let id = doc.next_id();
        doc.elements.push(Element {
            id,
            shape: Shape::Arrow { points: vec![start, end] },
            ink: Ink::Blue,
            fill: false,
            label: label.map(clamp_label).filter(|s| !s.is_empty()),
            // A generated graph is a diagram, so its arrows are links: moving
            // a box later must not leave the picture lying about what joins
            // what.
            from: Some(ids[a].clone()),
            to: Some(ids[b].clone()),
            locked: false,
        });
    }
    doc
}

/// Longest-path layering, cycle-safe.
///
/// A described process is very often circular ("…and back to review"), and a
/// naive depth walk on one of those never terminates. Relaxing a bounded
/// number of times settles every acyclic part correctly and simply stops on
/// the rest, which draws a cycle as a back-arrow — the right picture anyway.
fn layer_nodes(n: usize, edges: &[(usize, usize, Option<&str>)]) -> Vec<usize> {
    let mut layer = vec![0usize; n];
    let has_incoming: Vec<bool> = (0..n).map(|i| edges.iter().any(|(_, b, _)| *b == i)).collect();
    // Anything nothing points at starts the diagram. A graph where everything
    // has an incoming edge (a pure cycle) leaves them all at zero, which lays
    // out as one column — honest for a diagram with no beginning.
    for _ in 0..n.min(64) {
        let mut moved = false;
        for (a, b, _) in edges {
            if has_incoming[*b] && layer[*b] < layer[*a] + 1 {
                layer[*b] = layer[*a] + 1;
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    // A runaway from a cycle would otherwise put one node 60 columns out.
    let cap = n.min(8);
    for l in &mut layer {
        *l = (*l).min(cap);
    }
    layer
}

fn clamp_words(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let cut: String = t.chars().take(max).collect();
    match cut.rsplit_once(' ') {
        Some((head, _)) if head.len() > max / 2 => format!("{head}…"),
        _ => format!("{cut}…"),
    }
}

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

/// Widest raster handed to a model. A drawing is line art on flat paper, so
/// there is nothing above this width for a vision model to resolve — and the
/// image rides in the context window, where every extra pixel is paid for.
const RASTER_MAX_W: u32 = 1024;

/// System fonts, loaded once.
///
/// `load_system_fonts()` walks the font directories and costs well over a
/// tenth of a second. Doing that inside a tool call the agent may make several
/// times in one turn would show up as the drawing tools being mysteriously
/// slow, so the database is built on first use and shared thereafter.
fn font_db() -> &'static std::sync::Arc<resvg::usvg::fontdb::Database> {
    static DB: std::sync::OnceLock<std::sync::Arc<resvg::usvg::fontdb::Database>> =
        std::sync::OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_system_fonts();
        std::sync::Arc::new(db)
    })
}

/// Render the drawing to a PNG.
///
/// This is what makes "look at what you drew and fix it" real rather than a
/// promise: the agent's own output, rasterised the same way the page draws it,
/// with no dependency on the editor being open or even on a window existing.
pub(crate) fn to_png(doc: &Sketch) -> Result<Vec<u8>, String> {
    let svg = to_svg(doc);
    let mut opt = resvg::usvg::Options { fontdb: font_db().clone(), ..Default::default() };
    // A drawing carries no external references by construction, so nothing
    // here should ever resolve a URL. Emptying the resolvers makes that a
    // property of the renderer rather than a property of our own output.
    opt.image_href_resolver = resvg::usvg::ImageHrefResolver {
        resolve_data: Box::new(|_, _, _| None),
        resolve_string: Box::new(|_, _| None),
    };
    let tree = resvg::usvg::Tree::from_str(&svg, &opt)
        .map_err(|e| format!("The drawing could not be rendered ({e})."))?;

    let scale = (RASTER_MAX_W as f32 / doc.width.max(1) as f32).min(1.0);
    let w = ((doc.width as f32 * scale).round() as u32).max(1);
    let h = ((doc.height as f32 * scale).round() as u32).max(1);
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w, h)
        .ok_or("The drawing is too large to render as a picture.")?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    pixmap.encode_png().map_err(|e| format!("The picture could not be encoded ({e})."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draw(script: &str) -> Sketch {
        let mut d = Sketch::default();
        apply_script(&mut d, script).expect("script should apply");
        d
    }

    #[test]
    fn the_positional_and_named_spellings_of_a_box_mean_the_same_thing() {
        let a = draw("rect 250 400 320 130 blue \"Login form\"");
        let b = draw("rect x=250 y=400 w=320 h=130 ink=blue \"Login form\"");
        assert_eq!(a.elements[0].shape, b.elements[0].shape);
        assert_eq!(a.elements[0].ink, Ink::Blue);
        assert_eq!(a.elements[0].label.as_deref(), Some("Login form"));
    }

    #[test]
    fn the_label_may_come_before_or_after_the_colour() {
        let a = draw("rect 10 10 100 80 green \"Done\"");
        let b = draw("rect 10 10 100 80 \"Done\" green");
        assert_eq!(a.elements[0], b.elements[0]);
    }

    #[test]
    fn a_hash_followed_by_a_digit_is_a_reference_and_anything_else_is_a_comment() {
        let d = draw(
            "rect 100 100 200 100 blue \"A\"\n\
             rect 600 100 200 100 blue \"B\"\n\
             link #1 #2 green \"talks to\"   # this trailing note is not a reference",
        );
        assert_eq!(d.elements.len(), 3);
        let Shape::Arrow { points } = &d.elements[2].shape else { panic!("expected an arrow") };
        // Routed edge-to-edge: it starts to the RIGHT of A and ends LEFT of B.
        assert!(points[0][0] > 300, "arrow should start past A's right edge");
        assert!(points[1][0] < 600, "arrow should stop before B's left edge");
        assert_eq!(d.elements[2].label.as_deref(), Some("talks to"));
    }

    #[test]
    fn one_bad_line_refuses_the_whole_script_and_names_every_problem() {
        let mut d = Sketch::default();
        let err = apply_script(
            &mut d,
            "rect 100 100 200 100 blue \"Fine\"\n\
             rect 300 300 blue \"Too few numbers\"\n\
             sqaure 10 10 20 20",
        )
        .unwrap_err();
        assert!(d.elements.is_empty(), "a refused script must change nothing");
        assert!(err.contains("line 2"), "should name the bad line: {err}");
        assert!(err.contains("line 3"), "should name every bad line: {err}");
        assert!(err.contains("sqaure"), "should quote what it did not understand: {err}");
    }

    #[test]
    fn an_unknown_colour_word_is_refused_rather_than_silently_substituted() {
        let mut d = Sketch::default();
        let err = apply_script(&mut d, "rect 10 10 100 100 bleu \"Oops\"").unwrap_err();
        assert!(err.contains("bleu"), "{err}");
        assert!(d.elements.is_empty());
    }

    #[test]
    fn a_back_reference_past_the_end_is_refused_before_anything_is_drawn() {
        let mut d = Sketch::default();
        let err = apply_script(&mut d, "rect 10 10 100 100 blue \"A\"\nlink #1 #9").unwrap_err();
        assert!(err.contains("#9"), "{err}");
        assert!(d.elements.is_empty(), "nothing should have been drawn");
    }

    #[test]
    fn ids_keep_climbing_after_a_delete_so_an_old_edit_cannot_hit_a_new_shape() {
        let mut d = draw("rect 10 10 100 100 blue \"A\"");
        apply_script(&mut d, "delete e1").unwrap();
        apply_script(&mut d, "rect 10 10 100 100 blue \"B\"").unwrap();
        assert_eq!(d.elements[0].id, "e2", "a deleted id must never be reused");
    }

    #[test]
    fn a_reloaded_file_recovers_its_counter_from_the_ids_it_holds() {
        // A document written by hand, or by an older build, with no seq.
        let raw = r#"{"version":1,"width":1600,"height":1000,"seq":0,
            "elements":[{"id":"e7","type":"rect","x":0,"y":0,"w":10,"h":10,"ink":"blue"}]}"#;
        let mut d = Sketch::from_json(raw).unwrap();
        apply_script(&mut d, "rect 20 20 50 50 blue \"next\"").unwrap();
        assert_eq!(d.elements[1].id, "e8");
    }

    #[test]
    fn a_box_placed_off_the_page_is_pulled_back_on() {
        let d = draw("rect 1700 900 400 400 blue \"Off\"");
        let b = d.elements[0].bbox();
        assert!(b.right() <= CANVAS_W && b.bottom() <= CANVAS_H, "{b:?}");
    }

    #[test]
    fn a_script_round_trips_through_the_text_form_it_is_read_back_as() {
        let first = draw(
            "rect 100 200 300 120 blue \"Login form\"\n\
             ellipse 800 200 240 140 green fill \"Auth\"\n\
             text 200 600 red 28 \"retry three times\"\n\
             arrow 400 260 800 260 pink \"credentials\"",
        );
        let script = to_script(&first);
        // Reading a drawing back gives lines prefixed with their id; the parser
        // is fed the same lines with the id stripped, exactly as a model would
        // when it copies a shape it has just been shown.
        let replay: String = script
            .lines()
            .filter(|l| !l.starts_with("canvas"))
            .map(|l| l.splitn(2, ' ').nth(1).unwrap_or(l).to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let second = draw(&replay);
        assert_eq!(first.elements.len(), second.elements.len());
        for (a, b) in first.elements.iter().zip(second.elements.iter()) {
            assert_eq!(a.shape, b.shape, "geometry must survive the round trip");
            assert_eq!(a.ink, b.ink);
            assert_eq!(a.fill, b.fill);
            assert_eq!(a.label, b.label);
        }
    }

    #[test]
    fn the_layout_report_catches_the_mistakes_a_text_only_model_cannot_see() {
        let d = draw(
            "rect 100 100 300 200 blue \"One\"\n\
             rect 200 150 300 200 green \"One\"\n\
             rect 900 100 200 100 red",
        );
        let notes = layout_report(&d).join("\n");
        assert!(notes.contains("overlap"), "overlap not reported: {notes}");
        assert!(notes.contains("no label"), "missing label not reported: {notes}");
        assert!(notes.contains("both say"), "duplicate label not reported: {notes}");
    }

    #[test]
    fn a_tidy_drawing_has_nothing_to_report() {
        let d = draw(
            "rect 100 100 300 150 blue \"One\"\n\
             rect 900 100 300 150 green \"Two\"\n\
             link e1 e2 blue \"flows to\"",
        );
        assert!(layout_report(&d).is_empty(), "{:?}", layout_report(&d));
    }

    #[test]
    fn a_linked_arrow_never_reads_as_dangling() {
        // The same two boxes joined by hand-placed endpoints DO get flagged,
        // which is the whole reason `link` exists.
        let byhand = draw(
            "rect 100 100 300 150 blue \"One\"\n\
             rect 900 100 300 150 green \"Two\"\n\
             arrow 460 175 840 175 blue",
        );
        assert!(
            layout_report(&byhand).iter().any(|n| n.contains("stops short")),
            "{:?}",
            layout_report(&byhand)
        );
    }

    #[test]
    fn the_same_document_always_renders_the_same_bytes() {
        let d = draw("rect 100 100 300 150 blue \"Stable\"\nellipse 700 300 200 200 red \"Round\"");
        assert_eq!(to_svg(&d), to_svg(&d));
        // And a second document built from the same script renders identically,
        // because the wobble is seeded from the element id and nothing else.
        let e = draw("rect 100 100 300 150 blue \"Stable\"\nellipse 700 300 200 200 red \"Round\"");
        assert_eq!(to_svg(&d), to_svg(&e));
    }

    #[test]
    fn rendering_escapes_a_label_that_would_otherwise_break_the_document() {
        // The script itself carries an escaped quote inside the label, which
        // is the case that used to split the line into unreadable words.
        let d = draw(r#"rect 10 10 200 100 blue "a < b & \"c\"""#);
        assert_eq!(d.elements[0].label.as_deref(), Some(r#"a < b & "c""#));
        let svg = to_svg(&d);
        assert!(svg.contains("&lt;") && svg.contains("&amp;") && svg.contains("&quot;"), "{svg}");
        // The raw characters must not survive into the document, or the label
        // would close the <text> element and the rest of the drawing with it.
        let label_start = svg.find("a &lt;").expect("label should be rendered");
        assert!(!svg[label_start..].starts_with("a < b"), "{svg}");
    }

    #[test]
    fn the_index_gets_the_words_and_never_the_coordinates() {
        let d = draw(
            "rect 100 100 300 150 blue \"Login form\"\ntext 50 50 red 30 \"a loose note\"",
        );
        let text = d.extracted_text();
        assert!(text.contains("Login form") && text.contains("a loose note"));
        assert!(!text.contains("100"), "coordinates must not reach the index: {text}");
    }

    #[test]
    fn a_freehand_stroke_is_summarised_rather_than_dumped_at_the_model() {
        let mut d = Sketch::default();
        let pts: String =
            (0..60).map(|i| format!(" {} {}", 100 + i * 5, 300 + (i % 7) * 3)).collect();
        apply_script(&mut d, &format!("pen blue{pts}")).unwrap();
        let script = to_script(&d);
        assert!(script.contains("freehand, 60 points"), "{script}");
        assert!(!script.contains("100 300 105"), "raw point data must not reach the model: {script}");
    }

    #[test]
    fn a_runaway_script_is_stopped_before_it_writes_a_giant_file() {
        let mut d = Sketch::default();
        let many: String =
            (0..MAX_ELEMENTS + 10).map(|i| format!("rect {} 10 20 20 blue \"x\"\n", i % 1500)).collect();
        let err = apply_script(&mut d, &many).unwrap_err();
        assert!(err.contains("limit"), "{err}");
        assert!(d.elements.is_empty());
    }

    #[test]
    fn clear_then_draw_leaves_only_the_new_work() {
        let mut d = draw("rect 10 10 100 100 blue \"old\"");
        let out = apply_script(&mut d, "clear\nrect 20 20 100 100 red \"new\"").unwrap();
        assert_eq!(d.elements.len(), 1);
        assert_eq!(d.elements[0].label.as_deref(), Some("new"));
        assert!(out.cleared);
        assert_eq!(out.added.len(), 1);
    }

    #[test]
    fn the_receipt_names_the_ids_that_actually_changed() {
        let mut d = draw("rect 10 10 100 100 blue \"a\"");
        let out =
            apply_script(&mut d, "rect 300 10 100 100 red \"b\"\nlabel e1 \"renamed\"\ndelete e1")
                .unwrap();
        assert_eq!(out.added, vec!["e2".to_string()]);
        assert_eq!(out.changed, vec!["e1".to_string()]);
        assert_eq!(out.removed, vec!["e1".to_string()]);
        let s = out.summary();
        assert!(s.contains("e2") && s.contains("e1"), "{s}");
    }

    #[test]
    fn every_statement_leaves_a_step_so_the_page_can_replay_them_in_order() {
        let mut d = Sketch::default();
        let out = apply_script(
            &mut d,
            "rect 100 100 200 100 blue \"A\"\nrect 600 100 200 100 blue \"B\"\nlink #1 #2 green",
        )
        .unwrap();
        assert_eq!(out.steps.len(), 3);
        assert!(out.steps[0].contains("drew rect e1"), "{:?}", out.steps);
        assert!(out.steps[2].contains("linked e1 → e2"), "{:?}", out.steps);
    }

    #[test]
    fn an_empty_script_says_what_a_command_looks_like() {
        let mut d = Sketch::default();
        let err = apply_script(&mut d, "   \n# just a comment\n").unwrap_err();
        assert!(err.contains("rect"), "the refusal should show an example: {err}");
    }

    #[test]
    fn editing_a_shape_that_is_not_there_is_refused_with_its_id() {
        let mut d = draw("rect 10 10 100 100 blue \"a\"");
        let err = apply_script(&mut d, "move e9 10 10").unwrap_err();
        assert!(err.contains("e9"), "{err}");
    }

    #[test]
    fn a_json_document_survives_a_save_and_load() {
        let d = draw(
            "rect 100 200 300 120 blue fill \"Login form\"\n\
             text 200 600 red 28 \"note\"\n\
             pen green 10 10 20 20 30 15",
        );
        let round = Sketch::from_json(&d.to_json()).unwrap();
        assert_eq!(d, round);
    }

    fn node(id: &str, label: &str) -> GraphNode {
        GraphNode { id: id.into(), label: label.into(), note: None, kind: None }
    }
    fn edge(a: &str, b: &str) -> GraphEdge {
        GraphEdge { from: a.into(), to: b.into(), label: Some("then".into()) }
    }

    #[test]
    fn a_described_flow_lays_out_left_to_right_with_nothing_overlapping() {
        // The whole promise of #sketch: the model says what connects to what,
        // and the geometry is never its problem.
        let nodes = [node("a", "Draft"), node("b", "Review"), node("c", "Published")];
        let edges = [edge("a", "b"), edge("b", "c")];
        let doc = layout_graph(&nodes, &edges);
        assert!(layout_report(&doc).is_empty(), "{:#?}", layout_report(&doc));
        let boxes: Vec<&Element> = doc.elements.iter().filter(|e| e.is_solid()).collect();
        assert_eq!(boxes.len(), 3);
        assert!(
            boxes[0].bbox().x < boxes[1].bbox().x && boxes[1].bbox().x < boxes[2].bbox().x,
            "a chain should read left to right"
        );
    }

    #[test]
    fn a_circular_process_lays_out_instead_of_looping_forever() {
        let nodes = [node("a", "Open"), node("b", "Doing"), node("c", "Done")];
        let edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
        let doc = layout_graph(&nodes, &edges);
        assert_eq!(doc.elements.iter().filter(|e| e.is_solid()).count(), 3);
        assert_eq!(doc.elements.iter().filter(|e| matches!(e.shape, Shape::Arrow { .. })).count(), 3);
    }

    #[test]
    fn an_edge_naming_a_box_that_does_not_exist_is_dropped_not_drawn() {
        let doc = layout_graph(&[node("a", "Only")], &[edge("a", "ghost")]);
        assert_eq!(doc.elements.iter().filter(|e| matches!(e.shape, Shape::Arrow { .. })).count(), 0);
    }

    #[test]
    fn branches_stack_in_a_column_without_touching() {
        let nodes = [node("a", "Order"), node("b", "Pay"), node("c", "Ship"), node("d", "Email")];
        let edges = [edge("a", "b"), edge("a", "c"), edge("a", "d")];
        let doc = layout_graph(&nodes, &edges);
        assert!(layout_report(&doc).is_empty(), "{:#?}", layout_report(&doc));
        let col: Vec<Rect> = doc
            .elements
            .iter()
            .filter(|e| e.is_solid() && e.label.as_deref() != Some("Order"))
            .map(|e| e.bbox())
            .collect();
        assert_eq!(col.len(), 3);
        assert!(col.iter().all(|r| r.x == col[0].x), "the three branches share a column");
    }

    #[test]
    fn an_explanation_is_drawn_under_its_box_and_never_swallows_the_page() {
        let nodes = [GraphNode {
            id: "a".into(),
            label: "Auth".into(),
            note: Some("This step ".repeat(40)),
            kind: None,
        }];
        let doc = layout_graph(&nodes, &[]);
        let note = doc
            .elements
            .iter()
            .find_map(|e| match &e.shape {
                Shape::Text { text, y, .. } => Some((text.clone(), *y)),
                _ => None,
            })
            .expect("the note should be drawn");
        assert!(note.0.chars().count() <= 61, "the note must be clamped: {}", note.0.len());
        assert!(note.1 > doc.elements[0].bbox().y, "it belongs under the box");
    }

    #[test]
    fn a_start_and_end_are_drawn_round_so_a_flow_reads_at_a_glance() {
        let nodes = [
            GraphNode { id: "s".into(), label: "Start".into(), note: None, kind: Some("start".into()) },
            node("m", "Work"),
        ];
        let doc = layout_graph(&nodes, &[edge("s", "m")]);
        assert!(matches!(doc.elements[0].shape, Shape::Ellipse { .. }));
        assert!(matches!(doc.elements[1].shape, Shape::Rect { .. }));
    }

    #[test]
    fn nothing_described_draws_nothing_rather_than_an_empty_frame() {
        assert!(layout_graph(&[], &[]).elements.is_empty());
    }

    #[test]
    fn a_flow_deeper_than_the_default_canvas_keeps_its_arrows_on_the_boxes() {
        // Five columns grow the page past 1600 wide, and every connector out
        // there has to land on the shape it names — not on the old page edge.
        let nodes = [
            node("a", "Draft"),
            node("b", "Review"),
            node("c", "Legal"),
            node("d", "Sign"),
            node("e", "Publish"),
        ];
        let edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")];
        let doc = layout_graph(&nodes, &edges);
        assert!(doc.width > CANVAS_W, "five columns should widen the page: {}", doc.width);

        let boxes: HashMap<&str, Rect> =
            doc.elements.iter().map(|e| (e.id.as_str(), e.bbox())).collect();
        let mut checked = 0;
        for el in &doc.elements {
            let Shape::Arrow { points } = &el.shape else { continue };
            let (Some(from), Some(to)) = (el.from.as_deref(), el.to.as_deref()) else { continue };
            let (a, b) = (boxes[from], boxes[to]);
            assert!(
                grow(a, 14).contains(points[0][0], points[0][1]),
                "{} starts at {:?}, off its box {a:?}",
                el.id,
                points[0]
            );
            assert!(
                grow(b, 14).contains(points[1][0], points[1][1]),
                "{} ends at {:?}, off its box {b:?}",
                el.id,
                points[1]
            );
            checked += 1;
        }
        assert_eq!(checked, 4, "every described link should have been drawn");
    }

    #[test]
    fn a_page_narrower_than_the_default_still_reaches_a_box_placed_past_its_edge() {
        // A shape CAN sit off the page — the editor may resize the page under
        // one, and a file can be written by hand — so routing must not pull a
        // connector back to the new edge and off the box it names. (A script
        // cannot produce this any more: `canvas` takes effect for the lines
        // below it, so anything it draws lands on the page it just set.)
        //
        // The far box sits past the DEFAULT canvas as well as past this page:
        // a clamp to whichever of the two is larger passes a box at 1500 and
        // still detaches this one, which is the case that has to hold.
        let raw = r#"{"version":1,"width":800,"height":600,"seq":2,"elements":[
            {"id":"e1","type":"rect","x":100,"y":200,"w":200,"h":100,"ink":"blue","label":"Here"},
            {"id":"e2","type":"rect","x":1900,"y":200,"w":200,"h":100,"ink":"green","label":"Far"}
        ]}"#;
        let mut d = Sketch::from_json(raw).expect("parses");
        apply_script(&mut d, "link e1 e2").expect("script");
        let far = d.elements[1].bbox();
        let Shape::Arrow { points } = &d.elements[2].shape else { panic!("expected an arrow") };
        assert!(
            grow(far, 14).contains(points[1][0], points[1][1]),
            "arrow ends at {:?}, off {far:?}",
            points[1]
        );
    }

    #[test]
    fn the_drawing_rasterises_to_a_real_picture_with_ink_on_it() {
        let d = draw(
            "rect 100 100 400 200 blue \"Login form\"\n\
             ellipse 900 100 300 200 red fill \"Auth\"",
        );
        let png = to_png(&d).expect("should rasterise");
        assert_eq!(&png[1..4], b"PNG", "not a PNG: {:?}", &png[..8.min(png.len())]);
        // A renderer that silently drew nothing still emits a valid PNG, so
        // check the pixels: the paper is one flat colour, and anything drawn on
        // it has to introduce others.
        let img = image::load_from_memory(&png).expect("should decode").to_rgb8();
        let mut colours = std::collections::HashSet::new();
        for p in img.pixels() {
            colours.insert((p[0], p[1], p[2]));
        }
        assert!(
            colours.len() > 8,
            "the raster looks blank — only {} distinct colours",
            colours.len()
        );
        assert!(img.width() <= RASTER_MAX_W, "raster should be capped: {}", img.width());
    }

    /// Dev tool, not a gate: writes a sample sheet so a human can look at what
    /// the agent will be looking at. Pixel assertions can only prove that
    /// SOMETHING was drawn; whether it reads as a diagram is a judgement.
    ///
    /// `cargo test --lib sketchdoc -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn dump_a_sample_sheet_for_eyeballing() {
        let d = draw(
            "rect 120 120 380 170 blue \"Login form\"\n\
             rect 1050 120 400 170 green \"Auth service\"\n\
             ellipse 1060 560 380 200 yellow fill \"Session store\"\n\
             link #1 #2 blue \"credentials\"\n\
             link #2 #3 green \"issue token\"\n\
             text 150 420 red 30 \"retry with backoff x3\"\n\
             pen pink 120 450 300 445 480 455 640 448",
        );
        let path = std::env::var("SKETCH_DUMP").unwrap_or_else(|_| "/tmp/sketch-sample.png".into());
        std::fs::write(&path, to_png(&d).unwrap()).unwrap();
        println!("wrote {path}");
        println!("--- what the agent reads ---\n{}", to_script(&d));
        println!("--- layout report ---\n{:#?}", layout_report(&d));
    }

    #[test]
    fn an_empty_drawing_still_rasterises_rather_than_failing() {
        // The agent's first `see_drawing` on a fresh page must return paper,
        // not an error it then reports as a broken tool.
        let png = to_png(&Sketch::default()).expect("an empty page is still a page");
        assert!(png.len() > 100);
    }

    #[test]
    fn the_json_shape_of_an_element_is_one_flat_map() {
        let d = draw("rect 250 400 320 130 blue \"Login form\"");
        let v: serde_json::Value = serde_json::from_str(&d.to_json()).unwrap();
        let e = &v["elements"][0];
        assert_eq!(e["type"], "rect");
        assert_eq!(e["x"], 250);
        assert_eq!(e["ink"], "blue");
        assert_eq!(e["label"], "Login form");
        assert!(e.get("shape").is_none(), "geometry must not be nested: {e}");
    }

    /// A link is a RELATIONSHIP, not two points that happen to be in the right
    /// place. Before this, `link` computed the arrow once and forgot where it
    /// came from — so the very next `move` left the diagram lying about what
    /// joined what, while `layout_report` went on reporting the connection.
    #[test]
    fn a_link_follows_the_box_it_is_attached_to() {
        let mut doc = Sketch::default();
        apply_script(&mut doc, "box e1 100 100 200 100 \"A\"\nbox e2 700 100 200 100 \"B\"\nlink e1 e2")
            .expect("script");
        let before = match &doc.elements[2].shape {
            Shape::Arrow { points } => points.clone(),
            other => panic!("expected an arrow, got {other:?}"),
        };
        apply_script(&mut doc, "move e2 0 500").expect("move");
        let after = match &doc.elements[2].shape {
            Shape::Arrow { points } => points.clone(),
            other => panic!("expected an arrow, got {other:?}"),
        };
        assert_ne!(before, after, "the arrow must follow the box");
        assert!(
            after[1][1] > before[1][1],
            "…downwards, where the box actually went: {after:?}"
        );
    }

    /// Deleting one end must not leave an arrow claiming to join something the
    /// page no longer has — nor make it vanish or spring to the corner. It
    /// stays where it was drawn and stops calling itself a link.
    #[test]
    fn a_link_whose_end_is_deleted_stays_put_and_forgets_it() {
        let mut doc = Sketch::default();
        apply_script(&mut doc, "box e1 100 100 200 100\nbox e2 700 100 200 100\nlink e1 e2")
            .expect("script");
        let drawn = match &doc.elements[2].shape {
            Shape::Arrow { points } => points.clone(),
            other => panic!("expected an arrow, got {other:?}"),
        };
        apply_script(&mut doc, "delete e2").expect("delete");
        let arrow = doc.elements.iter().find(|e| e.id == "e3").expect("the arrow survives");
        assert_eq!(arrow.from, None);
        assert_eq!(arrow.to, None);
        match &arrow.shape {
            Shape::Arrow { points } => assert_eq!(points, &drawn, "it stays where it was drawn"),
            other => panic!("expected an arrow, got {other:?}"),
        }
    }

    /// The endpoints the editor's `routeBetween` produces for the same boxes.
    ///
    /// Not a re-derivation of the formula — that would pass whatever the
    /// formula did. These are the numbers the TS port yields (gap 8, grown box,
    /// `Math.round`), so a change on either side that pulls the two apart shows
    /// up here as a wrong endpoint. The two routers used to differ by two units
    /// on a horizontal pair and more on a diagonal, which meant every
    /// alternation between the agent and the editor rewrote the same connector.
    const ROUTER_FIXTURES: &[(Rect, Rect, [i32; 2], [i32; 2])] = &[
        // Side by side, 200×100 boxes: the gap is the whole difference.
        (
            Rect { x: 100, y: 100, w: 200, h: 100 },
            Rect { x: 700, y: 100, w: 200, h: 100 },
            [308, 150],
            [692, 150],
        ),
        // One above the other.
        (
            Rect { x: 100, y: 100, w: 200, h: 100 },
            Rect { x: 100, y: 500, w: 200, h: 100 },
            [200, 208],
            [200, 492],
        ),
        // Diagonal: the leg the ray crosses first decides, and growing the box
        // by the gap is not the same as extending the ray by it.
        (
            Rect { x: 0, y: 0, w: 200, h: 200 },
            Rect { x: 400, y: 400, w: 200, h: 200 },
            [208, 208],
            [392, 392],
        ),
        // Concentric: no direction at all.
        (
            Rect { x: 100, y: 100, w: 200, h: 100 },
            Rect { x: 150, y: 125, w: 100, h: 50 },
            [200, 150],
            [200, 150],
        ),
    ];

    #[test]
    fn the_router_agrees_with_the_editors_port() {
        for (a, b, start, end) in ROUTER_FIXTURES {
            let got = route(*a, *b);
            assert_eq!(
                (got.0, got.1),
                (*start, *end),
                "routing {a:?} → {b:?} must match the editor"
            );
        }
    }

    /// Two shapes sharing a centre used to route to the page corner: `len` was
    /// forced to 1, the unit vector stayed (0,0), and `NaN as i32` is 0.
    #[test]
    fn a_connector_between_concentric_shapes_is_not_the_page_origin() {
        let mut doc = Sketch::default();
        apply_script(
            &mut doc,
            "rect 100 100 200 100 blue \"outer\"\nellipse 150 125 100 50 green \"inner\"\nlink e1 e2",
        )
        .expect("script");
        match &doc.elements[2].shape {
            Shape::Arrow { points } => {
                assert_ne!(points[0], [0, 0], "an arrow must not spring to the corner");
                assert_eq!(points[0], [200, 150]);
                assert_eq!(points[1], [200, 150]);
            }
            other => panic!("expected an arrow, got {other:?}"),
        }
    }

    /// `canvas` used to be applied in pass 2 only, so every coordinate on the
    /// lines below it was still clamped to the DEFAULT page: a script that
    /// widened the page and then drew in the new space had everything piled
    /// against x=1600, and `read_drawing` reported coordinates nobody wrote.
    #[test]
    fn a_script_that_widens_the_page_may_draw_in_the_space_it_just_made() {
        let d = draw("canvas 2400 1200\nrect 1800 200 300 120 blue \"Right\"");
        assert_eq!((d.width, d.height), (2400, 1200));
        assert_eq!(
            d.elements[0].bbox(),
            Rect { x: 1800, y: 200, w: 300, h: 120 },
            "the box belongs where the widened page has room for it"
        );
        // …and a `move` in the same call is bounded by the new page too.
        let mut d = d;
        apply_script(&mut d, "move e1 400 0").expect("move");
        assert_eq!(d.elements[0].bbox().x, 2100, "clamped to 2400, not to 1600");
    }

    /// A script that ONLY resizes still changes the drawing, and the caller
    /// saves on `is_empty()`. It read as "nothing changed", so the editor was
    /// handed the wider page and the file kept the old one.
    #[test]
    fn resizing_the_page_is_a_change_worth_saving() {
        let mut d = Sketch::default();
        let out = apply_script(&mut d, "canvas 2400 1200").expect("script");
        assert!(!out.is_empty(), "a resize is a change: {out:?}");
        assert_eq!(out.resized, Some((2400, 1200)));
        assert!(out.summary().contains("2400×1200"), "{}", out.summary());

        // …and re-sending the page it already has is not a change. Every
        // reading of a drawing starts with its own `canvas` line, so counting
        // that as an edit would re-save the file on every round trip.
        let again = apply_script(&mut d, "canvas 2400 1200").expect("script");
        assert!(again.is_empty(), "nothing moved: {again:?}");
    }

    /// The ceiling counted a script's additions and ignored its deletions, so
    /// redrawing a busy page from scratch in one call was refused with a number
    /// the script would never reach.
    #[test]
    fn clearing_the_page_first_makes_room_for_the_redraw() {
        let mut d = Sketch::default();
        for i in 0..100 {
            apply_script(&mut d, &format!("rect {} 10 40 30 blue \"b{i}\"", i * 5)).unwrap();
        }
        let mut script = String::from("clear\n");
        for i in 0..350 {
            let _ = writeln!(script, "rect {} 10 40 30 blue \"n{i}\"", i * 4);
        }
        let out = apply_script(&mut d, &script).expect("clear + 350 is 350, not 450");
        assert!(out.cleared);
        assert_eq!(d.elements.len(), 350);
        // …and the ceiling still holds for a script that really would exceed it.
        let mut over = String::new();
        for i in 0..60 {
            let _ = writeln!(over, "rect {} 100 40 30 blue \"x{i}\"", i * 4);
        }
        let err = apply_script(&mut d, &over).expect_err("410 is past the limit");
        assert!(err.contains("410"), "{err}");
    }

    /// A connector's points belong to `reflow`. Moving one was reported as done
    /// and then thrown away in the same call, so the model moved it again, and
    /// again — the arrow never budged and the receipt never said so.
    #[test]
    fn moving_a_connector_says_it_follows_its_shapes_instead_of_claiming_a_move() {
        let mut d = Sketch::default();
        apply_script(&mut d, "rect 100 100 200 100 blue \"A\"\nrect 700 100 200 100 blue \"B\"\nlink e1 e2")
            .expect("script");
        let before = d.elements[2].shape.clone();
        let out = apply_script(&mut d, "move e3 40 0").expect("script");
        assert_eq!(d.elements[2].shape, before, "reflow would have undone it anyway");
        assert!(out.is_empty(), "nothing changed, so nothing is saved: {out:?}");
        assert!(
            out.steps[0].contains("connector") && out.steps[0].contains("e1"),
            "the step must say what to move instead: {:?}",
            out.steps
        );
        // …and the MODEL has to hear it. `steps` rides the editor's event and
        // never reaches the tool result; a summary reading "nothing changed"
        // is what sends the same `move` again on the next turn.
        let said = out.summary();
        assert!(
            said.contains("connector") && said.contains("e1") && said.contains("e3"),
            "the tool result must carry the reason: {said}"
        );
        // A loose arrow — one whose ends were never attached — still moves.
        apply_script(&mut d, "arrow 100 500 300 500 red").expect("script");
        let out = apply_script(&mut d, "move e4 0 40").expect("script");
        assert_eq!(out.changed, vec!["e4".to_string()]);
    }

    /// A hand-edited or imported file can carry an arrow with one point. Three
    /// readers here index `points[1]`, so it used to panic whichever command
    /// touched the file first — export, read, or draw.
    #[test]
    fn an_arrow_with_one_point_is_dropped_on_the_way_in_rather_than_panicking() {
        let raw = r#"{"version":1,"width":1600,"height":1000,"seq":2,"elements":[
            {"id":"e1","type":"rect","x":100,"y":100,"w":200,"h":100,"ink":"blue","label":"A"},
            {"id":"e2","type":"line","points":[[10,10]],"ink":"red"}
        ]}"#;
        let d = Sketch::from_json(raw).expect("a bad element is not a bad file");
        assert_eq!(d.elements.len(), 1, "the half-drawn line is dropped");
        assert_eq!(d.elements[0].id, "e1");
        // The file's own counter survives the drop — recovery only ever raises
        // it — so a drawing whose seq was written down does not rewind.
        assert_eq!(d.seq, 2);

        // And the three readers survive a document built in memory anyway.
        let mut broken = Sketch::default();
        broken.elements.push(Element {
            id: "e9".into(),
            shape: Shape::Arrow { points: vec![[10, 10]] },
            ink: Ink::Red,
            fill: false,
            label: None,
            ..Element::plain()
        });
        assert!(!to_svg(&broken).is_empty());
        assert!(!to_script(&broken).contains("arrow"), "{}", to_script(&broken));
        let _ = layout_report(&broken);
    }

    /// An old file has none of these fields, and must read back as a drawing
    /// with no links rather than failing to parse.
    #[test]
    fn a_sketch_written_before_links_existed_still_opens() {
        let raw = r#"{"version":1,"width":1600,"height":1000,"seq":1,
            "elements":[{"id":"e1","type":"rect","x":0,"y":0,"w":10,"h":10,"ink":"blue"}]}"#;
        let doc: Sketch = serde_json::from_str(raw).expect("parses");
        assert_eq!(doc.elements[0].from, None);
        assert!(!doc.elements[0].locked);
        // …and writing it back must not add noise to a file that has no links.
        let out = serde_json::to_string(&doc).expect("serialises");
        assert!(!out.contains("\"from\""), "absent fields stay absent: {out}");
        assert!(!out.contains("\"locked\""));
    }

}
