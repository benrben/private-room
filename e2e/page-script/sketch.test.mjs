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
