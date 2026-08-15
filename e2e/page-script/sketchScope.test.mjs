/* WHAT THE ASSISTANT ANSWERS FROM WHILE A DRAWING IS OPEN.
 *
 * The reported defect was silent in the worst way: asked "what is missing
 * here?" over a full diagram, the chat searched the whole room, found nothing
 * about the drawing, and answered anyway. Nothing on screen said it had not
 * looked. Every promise below fails the same way if it breaks — plausibly, and
 * without a stack trace — so each one is checked as a value rather than left to
 * a reading of the render.
 *
 * The real modules are transpiled and imported (same harness as
 * browserScope.test.mjs), so these are the shipped functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const load = async (source) => {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};

const scope = await load(read("src/workspace/browserScope.ts"));
const focusSrc = read("src/workspace/sketchFocus.ts");
const focus = await load(focusSrc);

const AI_PANE = read("src/workspace/AiPane.tsx");
const CHAT_ACTIONS = read("src/workspace/chatActions.ts");
const SKETCH_VIEW = read("src/viewers/SketchView.tsx");

const MAP = {
  fileId: "f-map",
  name: "Portfolio map",
  selection: [],
};
const at = (over = {}) => ({
  area: "sketch",
  page: null,
  hasSelection: false,
  sketch: MAP,
  attachments: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("a drawing on screen is what the chat answers from, not the whole room", () => {
  const view = scope.chatScope(at(), null);
  assert.equal(view.scope, "sketch");
  assert.deepEqual(view.available, ["sketch", "room"]);
  // Named. "This drawing" beside a list of nine is not an answer to which one.
  assert.match(view.label, /Portfolio map/);
});

test("the drawing rides in as a source, so the room really does read it", () => {
  const view = scope.chatScope(at(), null);
  assert.deepEqual(view.fileIds, ["f-map"]);
  // It is a room file, already indexed — there is no page text to fetch, and
  // claiming there were would send the turn down the browser's failure path.
  assert.equal(view.sendsPageText, false);
  assert.equal(view.preamble, "");
});

test("selecting objects offers a narrower scope without stealing the default", () => {
  const sketch = { ...MAP, selection: ["Box “Research”, at 120, 88"] };
  const view = scope.chatScope(at({ sketch }), null);
  assert.deepEqual(view.available, ["sketch", "objects", "room"]);
  // Same rule the page selection follows: pointing at one shape to ask about
  // it is not a statement that the rest of the drawing stopped mattering.
  assert.equal(view.scope, "sketch");
});

test("the selected objects go into the turn as text, because the index has no idea which they are", () => {
  const sketch = {
    ...MAP,
    selection: ["Box “Research”, at 120, 88", "Connector, at 200, 140"],
  };
  const view = scope.chatScope(at({ sketch }), "objects");
  assert.equal(view.scope, "objects");
  assert.equal(view.label, "the 2 selected objects");
  assert.match(view.preamble, /Portfolio map/);
  assert.match(view.preamble, /- Box “Research”, at 120, 88/);
  assert.match(view.preamble, /- Connector, at 200, 140/);
  // Carried by the preamble, so nothing else may also claim to carry it.
  assert.deepEqual(view.fileIds, []);
  assert.equal(view.sendsPageText, false);
});

test("one selected object is one object, not “the 1 selected objects”", () => {
  const sketch = { ...MAP, selection: ["Note “todo”, at 10, 10"] };
  assert.equal(
    scope.scopeLabel("objects", at({ sketch })),
    "the selected object",
  );
});

test("pinned sources are not hidden by picking the drawing", () => {
  // They are not dropped at send either (see the attachmentIds check below), so
  // a label naming only the drawing would understate what the turn carries.
  const view = scope.chatScope(at({ attachments: 2 }), null);
  assert.match(view.label, /Portfolio map/);
  assert.match(view.label, /2 attached/);
});

test("closing the drawing puts the strip back exactly as it was", () => {
  const view = scope.chatScope(at({ sketch: null }), "sketch");
  assert.deepEqual(view.available, ["room"]);
  assert.equal(view.scope, "room");
  assert.equal(view.label, "the whole room");
  assert.equal(view.placeholder, "Ask anything about this room…");
  assert.deepEqual(view.fileIds, []);
  assert.equal(view.preamble, "");
});

test("the resting value of the store still describes a room and nothing else", () => {
  assert.equal(scope.ROOM_ONLY.scope, "room");
  assert.deepEqual(scope.ROOM_ONLY.fileIds, []);
  assert.equal(scope.ROOM_ONLY.preamble, "");
});

test("the composer echoes the drawing it will actually ask about", () => {
  assert.equal(
    scope.chatScope(at(), null).placeholder,
    "Ask about “Portfolio map”…",
  );
});

test("a preamble is only ever added when there is one", () => {
  assert.equal(scope.withPreamble("why?", ""), "why?");
  assert.equal(scope.withPreamble("why?", "Selected:\n- Box"), "Selected:\n- Box\n\nwhy?");
});

// ---------------------------------------------------------------------------
// The store between the canvas and the chat
// ---------------------------------------------------------------------------

test("the same selection twice does not wake the chat a second time", () => {
  // The canvas republishes on every render, several a second while dragging.
  // Identity, not value, is what useSyncExternalStore re-renders on.
  let woken = 0;
  const stop = focus.subscribeSketchFocus(() => woken++);
  focus.setSketchFocus({ fileId: "f-map", selection: ["Box, at 1, 1"] });
  focus.setSketchFocus({ fileId: "f-map", selection: ["Box, at 1, 1"] });
  assert.equal(woken, 1);
  focus.setSketchFocus({ fileId: "f-map", selection: ["Box, at 1, 2"] });
  assert.equal(woken, 2);
  stop();
});

test("closing the drawing clears the store", () => {
  focus.setSketchFocus({ fileId: "f-map", selection: ["Box, at 1, 1"] });
  focus.setSketchFocus(null);
  assert.equal(focus.currentSketchFocus(), null);
});

test("unsubscribing really stops the notifications", () => {
  let woken = 0;
  const stop = focus.subscribeSketchFocus(() => woken++);
  stop();
  focus.setSketchFocus({ fileId: "f-other", selection: [] });
  assert.equal(woken, 0);
  focus.setSketchFocus(null);
});

// ---------------------------------------------------------------------------
// The wiring, which no pure function can prove
// ---------------------------------------------------------------------------

test("the canvas publishes its selection, and retires it on the way out", () => {
  assert.match(SKETCH_VIEW, /setSketchFocus\(\{/);
  assert.match(SKETCH_VIEW, /\.map\(describeElement\)/);
  // A cleanup with no dependencies — the value effect's cleanup would not run
  // when the file id changes to another drawing.
  assert.match(SKETCH_VIEW, /useEffect\(\(\) => \(\) => setSketchFocus\(null\), \[\]\)/);
});

test("the chat only trusts a selection published by the file it has open", () => {
  // A viewer swapped for another file can leave its last selection behind for
  // a moment; a scope built from that would name one drawing and answer from
  // another.
  assert.match(AI_PANE, /focus\?\.fileId === openFile\.id \? focus\.selection : \[\]/);
});

test("the scope's files are added to the pinned ones on every send path", () => {
  // Two paths reach the engine — the send, and the retry that re-asks the last
  // question. The retry carried less evidence than the turn it was retrying:
  // the saved text holds any prepended block, but never the file it named.
  const blocks = CHAT_ACTIONS.split("const attachmentIds").slice(1);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    const set = block.slice(0, block.indexOf("];"));
    assert.match(set, /s\.attachments\.map\(\(f\) => f\.id\)/);
    assert.match(set, /fileIds/);
  }
});

test("the preamble is applied on the path the page text does not take", () => {
  // Both in one branch would send a page block AND a selection block, or drop
  // one of them silently — the two scopes are mutually exclusive by construction.
  assert.match(CHAT_ACTIONS, /if \(!parsed\.command && scope\.sendsPageText\) \{/);
  assert.match(CHAT_ACTIONS, /\} else if \(!parsed\.command\) \{\s*\n[\s\S]{0,400}?withPreamble\(outgoing, scope\.preamble\)/);
});

test("a #command is exempt from both, as it always was", () => {
  // A command picks its own sources and carries its own arguments; a block
  // prepended to it rides along in something that never reads it.
  const send = CHAT_ACTIONS.slice(
    CHAT_ACTIONS.lastIndexOf("const scope = currentTurnScope()"),
  );
  const guarded = send.slice(0, send.indexOf("const optimistic"));
  assert.equal((guarded.match(/!parsed\.command/g) ?? []).length, 2);
});
