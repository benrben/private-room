/* The sketch document model, tested without a DOM.
 *
 * `src/viewers/sketch/model.ts` is the frontend half of a format Rust also
 * owns, so the things worth pinning here are the ones where the two halves
 * could quietly disagree, and the ones the React component leans on but cannot
 * be tested through: hit-testing, the undo stack, stroke simplification, and
 * the merge that runs when the agent draws on a page the user has open.
 *
 * The module is TypeScript, so it is transpiled on the fly the same way the
 * other page-script tests handle their subjects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const SRC = join(root, "src/viewers/sketch/model.ts");

const js = transformSync(readFileSync(SRC, "utf8"), {
  loader: "ts",
  format: "esm",
  target: "es2022",
}).code;
const M = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

const RUST = readFileSync(join(root, "src-tauri/src/commands/sketchdoc.rs"), "utf8");
const SRC_TEXT = readFileSync(SRC, "utf8");
const VIEW = readFileSync(join(root, "src/viewers/SketchView.tsx"), "utf8");

// --------------------------------------------------------------- the format

test("the page size matches the one Rust clamps to", () => {
  // A frontend that thought the page was bigger would let the user draw where
  // the agent can never place anything, and every such shape would come back
  // from a Rust round trip moved.
  const w = RUST.match(/CANVAS_W: i32 = (\d+)/)[1];
  const h = RUST.match(/CANVAS_H: i32 = (\d+)/)[1];
  assert.equal(M.CANVAS_W, Number(w));
  assert.equal(M.CANVAS_H, Number(h));
});

test("the five pens are the five Rust will accept", () => {
  // Rust refuses an unknown colour outright, so a sixth pen here would be a
  // swatch that draws shapes the agent can never recolour or reproduce.
  const arm = RUST.slice(RUST.indexOf("enum Ink"), RUST.indexOf("impl Ink"));
  const rustInks = [...arm.matchAll(/^\s{4}(\w+),$/gm)].map((m) => m[1].toLowerCase());
  assert.deepEqual([...M.INKS].sort(), rustInks.sort());
});

test("a drawing that will not parse opens as an empty page instead of nothing", () => {
  const { doc, error } = M.parseSketch("{ this is not json");
  assert.ok(error, "the failure must be reported");
  assert.deepEqual(doc.elements, [], "and the page must still open");
});

test("an empty file is a blank page, not an error", () => {
  const { doc, error } = M.parseSketch("");
  assert.equal(error, null);
  assert.equal(doc.elements.length, 0);
});

test("junk elements are dropped and real ones survive", () => {
  const { doc } = M.parseSketch(
    JSON.stringify({
      version: 1,
      width: 1600,
      height: 1000,
      seq: 2,
      elements: [
        { id: "e1", type: "rect", x: 10, y: 10, w: 100, h: 50, ink: "blue" },
        { id: "e2", type: "rect", x: "nope", y: 10, w: 100, h: 50, ink: "blue" },
        { id: "e3", type: "unicorn", x: 1, y: 1 },
      ],
    }),
  );
  assert.deepEqual(
    doc.elements.map((e) => e.id),
    ["e1"],
  );
});

test("the id counter recovers from the ids on the page", () => {
  // The same rule Rust applies. Without it, a file whose seq was lost mints an
  // id that already exists and a later edit retargets the wrong shape.
  const { doc } = M.parseSketch(
    JSON.stringify({
      version: 1,
      width: 1600,
      height: 1000,
      seq: 0,
      elements: [{ id: "e9", type: "rect", x: 0, y: 0, w: 10, h: 10, ink: "blue" }],
    }),
  );
  assert.equal(M.nextId(doc).id, "e10");
});

// ------------------------------------------------------------- hit-testing

const rect = (id, x, y, w, h) => ({ id, type: "rect", x, y, w, h, ink: "blue" });

test("clicking picks the shape on TOP, not the one underneath", () => {
  const doc = { ...M.emptySketch(), elements: [rect("under", 0, 0, 400, 400), rect("over", 100, 100, 100, 100)] };
  assert.equal(M.hitTest(doc, 150, 150).id, "over");
});

test("a diagonal arrow is only hit near the line, not across its whole box", () => {
  // The bounding box of a long diagonal covers a large empty area the user is
  // usually trying to click through to something behind it.
  const doc = {
    ...M.emptySketch(),
    elements: [{ id: "a", type: "arrow", points: [[0, 0], [1000, 1000]], ink: "blue" }],
  };
  assert.equal(M.hitTest(doc, 500, 505)?.id, "a", "on the line");
  assert.equal(M.hitTest(doc, 900, 100), null, "inside the box but far from the line");
});

test("a note is measured from its baseline", () => {
  const box = M.bboxOf({ id: "t", type: "text", x: 100, y: 200, text: "hello", size: 30, ink: "red" });
  assert.equal(box.x, 100);
  assert.ok(box.y < 200, "the box must sit above the baseline");
  assert.ok(box.w > 0 && box.h > 0);
});

test("moving a shape keeps it on the page", () => {
  const moved = M.translate(rect("e1", 1500, 900, 200, 200), 500, 500);
  assert.ok(moved.x + moved.w <= M.CANVAS_W);
  assert.ok(moved.y + moved.h <= M.CANVAS_H);
});

// -------------------------------------------------------------- freehand

test("simplification drops the points that carry no shape", () => {
  const straight = Array.from({ length: 50 }, (_, i) => [i * 10, 300]);
  assert.equal(M.simplify(straight).length, 2, "a straight line needs two points");
});

test("simplification keeps a corner", () => {
  const bent = [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]];
  const out = M.simplify(bent);
  assert.ok(
    out.some(([x, y]) => x === 100 && y === 0),
    `the corner was smoothed away: ${JSON.stringify(out)}`,
  );
});

test("a very long scribble cannot grow the file without bound", () => {
  // Zig-zag so simplification cannot collapse it — the cap is what has to hold.
  const huge = Array.from({ length: 9000 }, (_, i) => [i % 1500, 300 + (i % 2) * 40]);
  assert.ok(M.strokeFromTrail(huge).length <= M.MAX_STROKE_POINTS);
});

test("a stroke's points are whole numbers inside the page", () => {
  const out = M.strokeFromTrail([[-40.6, 10.2], [800.4, 1200.9]]);
  for (const [x, y] of out) {
    assert.equal(x, Math.round(x));
    assert.ok(x >= 0 && x <= M.CANVAS_W && y >= 0 && y <= M.CANVAS_H, `${x},${y} off the page`);
  }
});

// ------------------------------------------------------- drawn geometry

test("the same element always draws the same path", () => {
  // The wobble is seeded from the id and nothing else, so a re-render cannot
  // make a box jitter — and the editor agrees with the exported file.
  const a = M.rectPath(M.seeded("e7"), 10, 10, 100, 50);
  const b = M.rectPath(M.seeded("e7"), 10, 10, 100, 50);
  assert.equal(a, b);
  assert.notEqual(a, M.rectPath(M.seeded("e8"), 10, 10, 100, 50));
});

test("every generated path is valid path data", () => {
  const paths = [
    M.rectPath(M.seeded("e1"), 10, 10, 100, 50),
    M.ellipsePath(M.seeded("e2"), 100, 100, 50, 30),
    M.strokePath([[0, 0], [10, 10], [20, 5]]),
  ];
  for (const d of paths) {
    assert.match(d, /^M[-\d.]/, `does not start with a move: ${d.slice(0, 30)}`);
    assert.ok(!/NaN|Infinity|undefined/.test(d), `non-finite number in path: ${d.slice(0, 60)}`);
  }
});

// ------------------------------------------------------------------ undo

test("undo and redo walk the same history", () => {
  const a = M.emptySketch();
  const b = { ...a, elements: [rect("e1", 0, 0, 10, 10)] };
  let h = M.pushHistory(M.emptyHistory(), a);
  const back = M.undo(h, b);
  assert.deepEqual(back.doc, a);
  const forward = M.redo(back.history, back.doc);
  assert.deepEqual(forward.doc, b);
});

test("undo on a fresh page does nothing rather than throwing", () => {
  assert.equal(M.undo(M.emptyHistory(), M.emptySketch()), null);
  assert.equal(M.redo(M.emptyHistory(), M.emptySketch()), null);
});

test("the undo stack is capped", () => {
  let h = M.emptyHistory();
  for (let i = 0; i < M.UNDO_DEPTH + 25; i++) h = M.pushHistory(h, M.emptySketch());
  assert.equal(h.past.length, M.UNDO_DEPTH);
});

test("a new edit clears the redo branch", () => {
  const a = M.emptySketch();
  const b = { ...a, elements: [rect("e1", 0, 0, 10, 10)] };
  const back = M.undo(M.pushHistory(M.emptyHistory(), a), b);
  assert.equal(back.history.future.length, 1);
  assert.equal(M.pushHistory(back.history, a).future.length, 0);
});

// --------------------------------------------- the agent drawing underneath

test("a stroke the user has not saved yet survives the agent drawing", () => {
  // The worst failure this page can have. The agent's document was built from
  // the file on DISK, so anything drawn since the last autosave is missing
  // from it and would be wiped by a naive replace.
  const mine = {
    ...M.emptySketch(),
    seq: 5,
    elements: [rect("e1", 0, 0, 10, 10), rect("e5", 500, 500, 10, 10)],
  };
  const theirs = { ...M.emptySketch(), seq: 3, elements: [rect("e1", 0, 0, 10, 10), rect("e2", 200, 0, 10, 10)] };
  const { doc, unsavedKept } = M.mergeAgentDoc(mine, theirs, []);
  assert.deepEqual(unsavedKept, ["e5"]);
  assert.deepEqual(doc.elements.map((e) => e.id).sort(), ["e1", "e2", "e5"]);
  assert.equal(doc.seq, 5, "the counter must not go backwards or ids get reused");
});

test("a shape the agent deleted stays deleted", () => {
  // Without the `removed` list, a delete looks exactly like an element the
  // agent has not seen — and the merge would helpfully put it back.
  const mine = { ...M.emptySketch(), seq: 2, elements: [rect("e1", 0, 0, 10, 10), rect("e2", 20, 0, 10, 10)] };
  const theirs = { ...M.emptySketch(), seq: 2, elements: [rect("e1", 0, 0, 10, 10)] };
  const { doc } = M.mergeAgentDoc(mine, theirs, ["e2"]);
  assert.deepEqual(doc.elements.map((e) => e.id), ["e1"]);
});

test("the agent's version of a shape wins over the stale local copy", () => {
  const mine = { ...M.emptySketch(), seq: 1, elements: [rect("e1", 0, 0, 10, 10)] };
  const theirs = { ...M.emptySketch(), seq: 1, elements: [{ ...rect("e1", 0, 0, 10, 10), label: "renamed" }] };
  const { doc } = M.mergeAgentDoc(mine, theirs, []);
  assert.equal(doc.elements.length, 1);
  assert.equal(doc.elements[0].label, "renamed");
});

// ------------------------------------------------------------ round trip

test("a document survives being saved and read back", () => {
  const doc = {
    version: 1,
    width: 1600,
    height: 1000,
    seq: 3,
    elements: [
      { id: "e1", type: "rect", x: 10, y: 20, w: 300, h: 120, ink: "blue", fill: true, label: "A" },
      { id: "e2", type: "text", x: 40, y: 400, text: "note", size: 30, ink: "red" },
      { id: "e3", type: "pen", points: [[0, 0], [10, 10]], ink: "green" },
    ],
  };
  assert.deepEqual(M.parseSketch(M.serializeSketch(doc)).doc, doc);
});

// ------------------------------------------------------- the editor's wiring

test("the pointer is captured on the canvas ROOT, never on what was clicked", () => {
  // Live QA 2026-08-13: "when I erase it's stuck the app". Clicking a shape
  // targets the `<path>` inside it; the eraser then deletes that node, WebKit
  // keeps the capture on the removed element, and every later pointer event
  // goes to something no longer in the document — the canvas stops responding
  // and the page reads as frozen. The root is never removed.
  assert.ok(
    /svgRef\.current\?\.setPointerCapture/.test(VIEW),
    "capture must be taken on the svg root",
  );
  assert.ok(
    !/\(ev\.target as Element\)\.setPointerCapture/.test(VIEW),
    "capture must NOT be taken on the event target — that is the freeze",
  );
  assert.ok(
    /releasePointerCapture/.test(VIEW),
    "a captured pointer must be released when the gesture ends",
  );
});

test("a gesture reads the document through the ref it also advances", () => {
  // Several pointer events arrive between two renders. Anything that builds
  // the next document from `docRef.current` has to write the result back to it
  // synchronously, or the next event of the same swipe works from a stale copy
  // — an erased shape returns, a drag loses ground.
  const advances = VIEW.match(/advance\(next\)/g) ?? [];
  assert.ok(advances.length >= 2, "erase and drag both have to advance the ref");
  assert.ok(
    /docRef\.current = next;/.test(VIEW),
    "advance() must write the ref, not only React state",
  );
});

/* =====================================================================
 * EDITING FUNDAMENTALS
 *
 * The audit's finding was that this was a drawing surface rather than an
 * editor: a shape could be made and moved and nothing else. Everything below
 * is the geometry that turns it into one, and all of it is pure — the React
 * component holds none of these rules, so this is where they are argued with.
 * ===================================================================== */

const box = (id, x, y, w, h, extra = {}) => ({
  id,
  type: "rect",
  x,
  y,
  w,
  h,
  ink: "blue",
  ...extra,
});
const docOf = (...elements) => ({
  version: 1,
  width: M.CANVAS_W,
  height: M.CANVAS_H,
  seq: elements.length,
  elements,
});

/* ---------- resize ---------- */

test("a corner grip moves its own corner and leaves the opposite one still", () => {
  const r = M.resizedBox({ x: 100, y: 100, w: 200, h: 100 }, "se", 40, 20);
  assert.deepEqual(r, { x: 100, y: 100, w: 240, h: 120 });
  const nw = M.resizedBox({ x: 100, y: 100, w: 200, h: 100 }, "nw", 40, 20);
  assert.deepEqual(nw, { x: 140, y: 120, w: 160, h: 80 });
});

test("an edge grip moves one side only", () => {
  const e = M.resizedBox({ x: 100, y: 100, w: 200, h: 100 }, "e", 50, 999);
  assert.deepEqual(e, { x: 100, y: 100, w: 250, h: 100 }, "a side drag is one axis");
  const n = M.resizedBox({ x: 100, y: 100, w: 200, h: 100 }, "n", 999, -30);
  assert.deepEqual(n, { x: 100, y: 70, w: 200, h: 130 });
});

test("dragging a side past its opposite flips instead of inverting", () => {
  // A negative width is not a shape anyone can see or grab back.
  const r = M.resizedBox({ x: 100, y: 100, w: 200, h: 100 }, "e", -400);
  assert.ok(r.w >= M.MIN_SIZE, "width stays positive");
  assert.ok(r.x < 100, "the box moved to the other side of the anchor");
});

test("a shape cannot be crushed to nothing", () => {
  const r = M.resizedBox({ x: 0, y: 0, w: 50, h: 50 }, "se", -49, -49);
  assert.equal(r.w, M.MIN_SIZE);
  assert.equal(r.h, M.MIN_SIZE);
});

test("Shift keeps the proportions a corner drag started with", () => {
  const r = M.resizedBox({ x: 0, y: 0, w: 200, h: 100 }, "se", 100, 0, true);
  assert.equal(r.w / r.h, 2, "2:1 in, 2:1 out");
});

test("resizing a mixed selection scales every kind by the same box", () => {
  const from = { x: 0, y: 0, w: 100, h: 100 };
  const to = { x: 0, y: 0, w: 200, h: 200 };
  const rect = M.fitToBox(box("a", 0, 0, 50, 50), from, to);
  assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [0, 0, 100, 100]);
  const pen = M.fitToBox(
    { id: "p", type: "pen", points: [[0, 0], [50, 50]], ink: "blue" },
    from,
    to,
  );
  assert.deepEqual(pen.points, [[0, 0], [100, 100]], "a stroke scales with its box");
});

test("text scales by size and is never stretched", () => {
  const t = M.fitToBox(
    { id: "t", type: "text", x: 0, y: 40, text: "hi", size: 30, ink: "blue" },
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 0, y: 0, w: 400, h: 100 },
  );
  // The box got 4x wider and no taller; a stretched glyph is the one outcome
  // nobody wants, so the smaller factor wins and the size is unchanged.
  assert.equal(t.size, 30);
  assert.equal(typeof t.text, "string");
});

/* ---------- connectors ---------- */

test("a connector leaves the edge of its shape, not the middle", () => {
  const [a, b] = M.routeBetween({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 0, w: 100, h: 100 });
  assert.ok(a[0] > 100, "it starts outside the left box");
  assert.ok(b[0] < 300, "and stops before the right one");
  assert.equal(a[1], 50, "level shapes get a level connector");
  assert.equal(b[1], 50);
});

test("moving a shape re-routes the connector attached to it", () => {
  const doc = docOf(
    box("a", 0, 0, 100, 100),
    box("b", 300, 0, 100, 100),
    { id: "c", type: "arrow", points: [[0, 0], [0, 0]], ink: "blue", from: "a", to: "b" },
  );
  const routed = M.reflow(doc);
  const before = routed.elements[2].points;
  const moved = M.reflow({
    ...routed,
    elements: routed.elements.map((e) => (e.id === "b" ? M.translate(e, 0, 400) : e)),
  });
  const after = moved.elements[2].points;
  assert.notDeepEqual(after, before, "the arrow followed the box");
  assert.ok(after[1][1] > before[1][1], "…downwards, where the box went");
});

test("a connector whose shape was deleted stays put and forgets the attachment", () => {
  // Springing to the page corner, or vanishing, are both worse than an arrow
  // the user can see and delete themselves.
  const doc = docOf(
    box("a", 0, 0, 100, 100),
    { id: "c", type: "arrow", points: [[120, 50], [280, 50]], ink: "blue", from: "a", to: "gone" },
  );
  const out = M.reflow(doc);
  const c = out.elements.find((e) => e.id === "c");
  assert.deepEqual(c.points, [[120, 50], [280, 50]]);
  assert.equal(c.to, undefined, "the dead attachment is dropped");
});

test("reflow leaves an unattached arrow completely alone", () => {
  const doc = docOf({ id: "c", type: "arrow", points: [[0, 0], [10, 10]], ink: "blue" });
  assert.equal(M.reflow(doc), doc, "same object — a hand-drawn arrow is not a connector");
});

test("a connector can only hang off a real shape", () => {
  assert.equal(M.canConnect(box("a", 0, 0, 10, 10)), true);
  assert.equal(
    M.canConnect({ id: "c", type: "arrow", points: [[0, 0], [1, 1]], ink: "blue" }),
    false,
    "a chain of connectors has no shape at the end of it",
  );
  assert.equal(M.canConnect(null), false);
});

test("the editor and Rust route connectors by the same rule", () => {
  // Two implementations of one connector's geometry disagree the first time
  // either is touched, and the file would then draw differently from the page.
  assert.ok(/fn edge_point/.test(RUST), "Rust owns edge_point");
  assert.ok(/export function edgePoint/.test(SRC_TEXT), "and the editor ports it");
});

/* ---------- arrangement ---------- */

test("align moves one axis and never the other", () => {
  const out = M.align([box("a", 0, 0, 50, 50), box("b", 100, 200, 50, 50)], "left");
  assert.equal(out[1].x, 0, "b came to the left edge");
  assert.equal(out[1].y, 200, "and stayed at its own height");
});

test("aligning one thing to itself changes nothing", () => {
  const one = [box("a", 33, 44, 50, 50)];
  assert.deepEqual(M.align(one, "left"), one);
});

test("distribute leaves equal GAPS, not equal centres", () => {
  // Shapes of different widths are the whole point: equal centres would leave
  // visibly uneven space between edges.
  const out = M.distribute(
    [box("a", 0, 0, 100, 20), box("b", 150, 0, 20, 20), box("c", 400, 0, 100, 20)],
    "x",
  );
  const at = (id) => out.find((e) => e.id === id);
  const gap1 = at("b").x - (at("a").x + at("a").w);
  const gap2 = at("c").x - (at("b").x + at("b").w);
  assert.ok(Math.abs(gap1 - gap2) <= 1, `gaps ${gap1} and ${gap2} must match`);
  assert.equal(at("a").x, 0, "the outermost two anchor the span");
  assert.equal(at("c").x, 400);
});

test("distribute keeps the document's own order, which is its z-order", () => {
  const els = [box("c", 400, 0, 20, 20), box("a", 0, 0, 20, 20), box("b", 150, 0, 20, 20)];
  assert.deepEqual(
    M.distribute(els, "x").map((e) => e.id),
    ["c", "a", "b"],
    "tidying the spacing must not restack the drawing",
  );
});

/* ---------- z-order ---------- */

test("front and back move a block without shuffling it", () => {
  const doc = docOf(box("a", 0, 0, 10, 10), box("b", 0, 0, 10, 10), box("c", 0, 0, 10, 10));
  assert.deepEqual(
    M.reorder(doc, ["a", "b"], "front").elements.map((e) => e.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    M.reorder(doc, ["b", "c"], "back").elements.map((e) => e.id),
    ["b", "c", "a"],
  );
});

test("one step forward moves a run as a block", () => {
  const doc = docOf(box("a", 0, 0, 1, 1), box("b", 0, 0, 1, 1), box("c", 0, 0, 1, 1));
  assert.deepEqual(
    M.reorder(doc, ["a", "b"], "forward").elements.map((e) => e.id),
    ["c", "a", "b"],
    "both moved past c, keeping a before b",
  );
});

/* ---------- duplicate ---------- */

test("a duplicated diagram is wired to its own copies", () => {
  // Otherwise the second diagram's arrow points back into the first, and
  // moving the copy drags a connector across the page.
  const doc = docOf(
    box("e1", 0, 0, 100, 100),
    box("e2", 300, 0, 100, 100),
    { id: "e3", type: "arrow", points: [[0, 0], [1, 1]], ink: "blue", from: "e1", to: "e2" },
  );
  const { doc: out, ids } = M.duplicate(doc, ["e1", "e2", "e3"]);
  const copyArrow = out.elements.find((e) => e.id === ids[2]);
  assert.equal(copyArrow.from, ids[0]);
  assert.equal(copyArrow.to, ids[1]);
  assert.ok(!ids.includes("e1"), "copies get fresh ids");
});

test("duplicating does not disturb the originals", () => {
  const doc = docOf(box("e1", 10, 10, 50, 50));
  const { doc: out } = M.duplicate(doc, ["e1"]);
  assert.deepEqual(out.elements[0], doc.elements[0]);
  assert.equal(out.elements.length, 2);
});

/* ---------- snapping ---------- */

test("a box within tolerance is pulled onto its neighbour's edge", () => {
  const { dx, guides } = M.guidesFor({ x: 103, y: 0, w: 50, h: 50 }, [
    { x: 100, y: 300, w: 50, h: 50 },
  ]);
  assert.equal(dx, -3, "left edges line up");
  assert.ok(guides.some((g) => g.axis === "x" && g.at === 100));
});

test("a box nowhere near anything is left where it is", () => {
  const { dx, dy, guides } = M.guidesFor({ x: 500, y: 500, w: 50, h: 50 }, [
    { x: 0, y: 0, w: 50, h: 50 },
  ]);
  assert.equal(dx, 0);
  assert.equal(dy, 0);
  assert.equal(guides.length, 0, "no guide may be drawn for a line nothing landed on");
});

test("centres snap to centres, not only edges to edges", () => {
  // The pairing that makes "put this under that, in the middle" work.
  const { dx } = M.guidesFor({ x: 122, y: 200, w: 100, h: 50 }, [
    { x: 100, y: 0, w: 150, h: 50 },
  ]);
  assert.equal(dx, 3, "125 centre to 175 centre… nearest catch wins");
});

test("the nearest candidate wins, so a box between two does not jitter", () => {
  // Every edge and centre of the moving box is tested against every edge and
  // centre of both neighbours — nine pairings each. The smallest pull of all
  // of them is the one that acts: here the moving left edge (100) against the
  // first neighbour's centre (101). A rule that took the first catch instead
  // would hand the box to whichever neighbour happened to be earlier in the
  // list, and it would swap as soon as the drawing was reordered.
  const { dx } = M.guidesFor({ x: 100, y: 0, w: 10, h: 10 }, [
    { x: 96, y: 50, w: 10, h: 10 },
    { x: 102, y: 90, w: 10, h: 10 },
  ]);
  assert.equal(dx, 1, "the 1-unit pull beats every other candidate");
});

test("the grid the snap uses is the paper the user can see", () => {
  assert.equal(M.GRID, 22, "matches --grid-gap and the canvas dot pattern");
  assert.equal(M.snapTo(30), 22);
  assert.equal(M.snapTo(34), 44);
});

/* ---------- multi-selection ---------- */

test("a selection box is the union of what is in it", () => {
  const b = M.bboxOfMany([box("a", 0, 0, 50, 50), box("b", 100, 200, 50, 50)]);
  assert.deepEqual(b, { x: 0, y: 0, w: 150, h: 250 });
  assert.equal(M.bboxOfMany([]), null, "nothing selected is not a box of zero size");
});

test("handles sit on the corners and the middles of the sides", () => {
  const b = { x: 0, y: 0, w: 100, h: 200 };
  assert.deepEqual(M.handleAt(b, "nw"), [0, 0]);
  assert.deepEqual(M.handleAt(b, "se"), [100, 200]);
  assert.deepEqual(M.handleAt(b, "n"), [50, 0]);
  assert.deepEqual(M.handleAt(b, "w"), [0, 100]);
  assert.equal(M.HANDLES.length, 8);
});

/* ---------- the editor's own promises ---------- */

const VIEW2 = readFileSync(join(root, "src/viewers/SketchView.tsx"), "utf8");

test("a sketch opens in Select, never in a mode that changes it", () => {
  // Every sketch used to open with the pen armed, so panning around someone
  // else's diagram left marks on it. This is the whole P0.
  assert.match(VIEW2, /useState<Tool>\("select"\)/);
});

test("making one thing returns to Select unless the tool was armed to stay", () => {
  assert.match(VIEW2, /if \(!sticky\) setTool\("select"\);/);
  assert.match(VIEW2, /onDoubleClick=\{\(\) => \{\s*setTool\(tl\.key\);\s*setSticky/);
});

test("Escape is claimed before the shell can close the file", () => {
  // THE P0. The shell closes the open file on Escape and both handlers sit on
  // `window`; the shell's is registered first, so in the bubble phase it
  // always won — pressing Escape to dismiss the Arrange menu closed the whole
  // drawing. Capture is the only phase that gets there first.
  const esc = VIEW2.slice(VIEW2.indexOf("const onEscape = (e: KeyboardEvent)"));
  const body = esc.slice(0, esc.indexOf("window.addEventListener"));
  assert.match(VIEW2, /addEventListener\("keydown", onEscape, \{ capture: true \}\)/);
  assert.match(VIEW2, /removeEventListener\("keydown", onEscape, \{ capture: true \}\)/);
  // …and it stops the event ONLY for the layers it actually handles, or
  // Escape-closes-the-file would break everywhere else in the app.
  const stops = body.match(/e\.stopPropagation\(\)/g) ?? [];
  assert.equal(stops.length, 2, "one for the menu layer, one for the selection layer");
  assert.match(body, /if \(menuRef\.current\)/, "the topmost thing goes first");
  assert.match(body, /setSelected\(\[\]\)/);
  assert.match(body, /setTool\("select"\)/);
});

test("a text field keeps its own Escape", () => {
  const esc = VIEW2.slice(VIEW2.indexOf("const onEscape = (e: KeyboardEvent)"));
  assert.match(
    esc.slice(0, 700),
    /tagName === "INPUT" \|\| el\.tagName === "TEXTAREA"/,
    "cancelling a label edit must not be stolen by the canvas",
  );
});

test("every edit that can move a shape re-routes the connectors", () => {
  // A move, a resize, an align, a distribute and a delete each change where a
  // box is. Any one of them that skipped reflow would leave the diagram lying
  // about what joins what — silently, and only until someone looked.
  const calls = VIEW2.match(/reflow\(\{/g) ?? [];
  assert.ok(calls.length >= 5, `only ${calls.length} edits reflow`);
});

test("a locked element cannot be picked, dragged or lassoed", () => {
  assert.match(VIEW2, /if \(hit\?\.locked\)/, "a click on it starts a marquee instead");
  assert.match(VIEW2, /\.filter\(\(e\) => !e\.locked\)/, "and a lasso passes over it");
});

test("the canvas is more than a count of anonymous images", () => {
  // The audit's accessibility finding: objects reached the accessibility tree
  // only as unnamed `image` children, so there was no way to learn what was on
  // the page or to reach any of it.
  assert.match(VIEW2, /role="listbox"/);
  assert.match(VIEW2, /aria-label="Objects on this page"/);
  assert.match(VIEW2, /aria-selected=\{selected\.includes/);
  // The naming moved into the model, where the chat's scope block reads the
  // same sentences — the two describing one selection differently would be a
  // quieter bug than either of them being wrong.
  assert.equal(typeof M.describeElement, "function");
  assert.match(VIEW2, /describeElement\(e\)/);
});

test("the empty state cannot swallow the first click on the canvas", () => {
  const css = readFileSync(join(root, "src/viewers/sketch.css"), "utf8");
  const block = css.slice(css.indexOf(".sk-empty {"), css.indexOf(".sk-empty-cards"));
  assert.match(block, /pointer-events: none/);
  assert.match(css.slice(css.indexOf(".sk-empty-card {")), /pointer-events: auto/);
});

test("the canvas toolbar has no export control at all", () => {
  // There were two buttons named Export a few pixels apart, doing different
  // things: this one wrote a flattened copy INTO the room, the file header's
  // writes a copy OUT of it, and neither said which. File-level acts belong to
  // the file header, so both formats moved there.
  assert.doesNotMatch(VIEW2, />\s*Export SVG\s*</);
  assert.doesNotMatch(VIEW2, /aria-label="Export"/);
  assert.doesNotMatch(VIEW2, /exportAs\(/, "the canvas no longer owns the act");
});

test("a drawing's two flat formats live in the file header, once each", () => {
  const viewer = readFileSync(join(root, "src/workspace/ViewerPane.tsx"), "utf8");
  assert.match(viewer, /exportSketchAs\(openFile\.id, "png"\)/);
  assert.match(viewer, /exportSketchAs\(openFile\.id, "svg"\)/);
  // Worded so the two acts cannot be confused: one writes into this room, the
  // Export button beside it writes out of it.
  assert.match(viewer, /Save a picture \(PNG\) in this room/);
  assert.match(viewer, /Save a drawing \(SVG\) in this room/);
});

test("the toolbar gives way instead of wrapping onto a second row", () => {
  const css = readFileSync(join(root, "src/viewers/sketch.css"), "utf8");
  assert.match(css, /\.sk-tools \{[^}]*flex-wrap: nowrap/s);
});

// ------------------------------------------------- the object strip

test("a chip says what a thing is and what it says, not where it sits", () => {
  // The strip put the whole description on every chip. Coordinates nobody
  // reads took the widest part of each one and pushed the rest of the drawing
  // off the end of a row that does not wrap.
  const box = { id: "a", type: "rect", x: 120, y: 88, w: 60, h: 40, label: "Research" };
  assert.equal(M.chipLabel(box), "Box “Research”");
  assert.doesNotMatch(M.chipLabel(box), /120/);
  assert.equal(M.chipLabel({ ...box, label: "" }), "Box");
});

test("a long label is cut on the chip and whole in the description", () => {
  const box = {
    id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10,
    label: "Everything we learned in the second quarter",
  };
  const chip = M.chipLabel(box);
  assert.ok(chip.length < 30, chip);
  assert.match(chip, /…”$/);
  assert.match(M.describeElement(box), /Everything we learned in the second quarter/);
});

test("the description names the object, its words, where it is and whether it is locked", () => {
  const box = { id: "a", type: "rect", x: 120.4, y: 88.6, w: 60, h: 40, label: "Research", locked: true };
  assert.equal(M.describeElement(box), "Box, “Research”, at 120, 89, locked");
  assert.equal(
    M.describeElement({ ...box, locked: false, label: "" }),
    "Box, at 120, 89",
  );
});

test("an attached arrow is called a connector, because it behaves like one", () => {
  const base = { id: "x", type: "arrow", points: [[0, 0], [10, 10]] };
  assert.equal(M.kindOf(base), "Arrow");
  assert.equal(M.kindOf({ ...base, from: "a", to: "b" }), "Connector");
  // Half-attached is not attached — it does not follow anything.
  assert.equal(M.kindOf({ ...base, from: "a" }), "Arrow");
});

test("the strip follows the selection instead of leaving it off the end", () => {
  // One row that scrolls sideways: without this it shows a row of unselected
  // chips while claiming to be the list of what is selected.
  assert.match(VIEW2, /chipRefs\.current\.get\(first\)\?\.scrollIntoView/);
  assert.match(VIEW2, /\}, \[selected\]\);/);
});

test("every chip states its place in the set and carries the full sentence", () => {
  const strip = VIEW2.slice(VIEW2.indexOf('className="sk-objects-row"'));
  assert.match(strip, /aria-posinset=\{i \+ 1\}/);
  assert.match(strip, /aria-setsize=\{doc\.elements\.length\}/);
  assert.match(strip, /aria-label=\{describeElement\(e\)\}/);
  assert.match(strip, /\{chipLabel\(e\)\}/);
});

test("the count opens the whole set, and says it is a disclosure", () => {
  assert.match(VIEW2, /className="sk-objects-toggle"/);
  assert.match(VIEW2, /aria-expanded=\{stripOpen\}/);
  const css = readFileSync(join(root, "src/viewers/sketch.css"), "utf8");
  // Closed it is one scrolling row; open it wraps, bounded so listing the
  // drawing never costs more of the window than the drawing.
  assert.match(css, /\.sk-objects-row \{[^}]*overflow-x: auto/s);
  assert.match(css, /\.sk-objects-open \.sk-objects-row \{[^}]*flex-wrap: wrap/s);
  assert.match(css, /\.sk-objects-open \.sk-objects-row \{[^}]*max-height/s);
});

// ------------------------------------------------- which undo is which

test("the toolbar's undo names the history it owns while a field owns the keyboard", () => {
  // Two histories, one of them not the toolbar's: typing, pressing ⌘Z, then
  // seeing a greyed-out Undo reads as a broken history when both are working.
  const typing = M.historyHint({ verb: "Undo", shortcut: "⌘Z", depth: 3, typing: true });
  assert.match(typing, /drawing/);
  assert.match(typing, /text field/);
  // The shortcut is NOT offered as this button's, because right then it is not.
  assert.doesNotMatch(typing, /Undo · ⌘Z/);
});

test("an empty history says it is empty rather than nothing at all", () => {
  assert.equal(
    M.historyHint({ verb: "Redo", shortcut: "⇧⌘Z", depth: 0, typing: false }),
    "Nothing to redo on this drawing yet",
  );
  assert.equal(
    M.historyHint({ verb: "Undo", shortcut: "⌘Z", depth: 2, typing: false }),
    "Undo · ⌘Z",
  );
});

test("the buttons say which undo they are, and the footer says it in words", () => {
  assert.match(VIEW2, /aria-label="Undo drawing change"/);
  assert.match(VIEW2, /aria-label="Redo drawing change"/);
  // Said in the footer because a disabled button cannot say it.
  assert.match(VIEW2, /⌘Z undoes your typing here/);
  assert.match(VIEW2, /toolbar’s undo covers the drawing/);
});

test("⌘Z inside a text field is still left alone", () => {
  // The fix is what the page SAYS, not what it does: the field's own undo was
  // always correct, and taking ⌘Z back would break the half that worked.
  const keys = VIEW2.slice(VIEW2.indexOf("const onKey = (e: KeyboardEvent)"));
  assert.match(
    keys.slice(0, 400),
    /el\.tagName === "INPUT" \|\| el\.tagName === "TEXTAREA"\)\) return;/,
  );
});
