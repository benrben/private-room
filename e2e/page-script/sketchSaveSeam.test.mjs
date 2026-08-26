/* The drawing page's save seam and its locked/label edges.
 *
 * `src/viewers/SketchView.tsx` is a React component with two writers — the
 * person drawing and the room's agent — and no Save button between them, so
 * the moments worth pinning are the ones where one writer's work can be
 * written out from under the other's. None of it can be driven without a DOM,
 * so this reads the source the way `sketch.test.mjs` reads the editor's other
 * promises; every needle is split with a concatenation so the assertion text
 * can never satisfy itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const VIEW = readFileSync(join(root, "src/viewers/SketchView.tsx"), "utf8");
const API = readFileSync(join(root, "src/api.ts"), "utf8");

/** The body of a `const <name> = ...` declaration, up to the next one. */
function block(name, chars = 1400) {
  const at = VIEW.indexOf(`const ${name} = `);
  assert.notEqual(at, -1, `${name} moved — re-pin this test`);
  return VIEW.slice(at, at + chars);
}

test("the agent's drawing always schedules its own save", () => {
  // A move creates no element, so a drag arms a save for the PRE-merge
  // document. The agent's shapes then landed, no new save was scheduled
  // because every id of the user's was already in the agent's document, and
  // the armed timer wrote the diagram straight back out of the file.
  const apply = block("applyAgent", 1200);
  assert.match(apply, /schedule[S]ave\(merged\);/);
  assert.doesNotMatch(
    apply,
    /if \(unsavedKept\.length\)/,
    "the save must not be conditional on the merge having carried something over",
  );
});

test("the agent's drawing is one step of the undo history, not a hole in it", () => {
  // One ⌘Z after a diagram landed used to step over the user's last stroke and
  // THROUGH the agent's work, taking the whole diagram with it — and autosaving
  // the deletion.
  const apply = block("applyAgent", 1200);
  const push = apply.indexOf(concat("push", "History(h, before)"));
  const set = apply.indexOf(concat("advance", "(merged)"));
  assert.ok(push > -1, "the pre-merge document must be pushed as the undo step");
  assert.ok(set > -1, "and the merge must advance the live document");
  assert.ok(push < set, "the history entry belongs BEFORE the document moves");
});

test("a committed shape reaches the live document before the agent merge reads it", () => {
  // `endGesture` commits the shape the user just finished and then folds in an
  // agent drawing that was held for the pointer-up. A commit that only queued
  // `setDoc` left `docRef.current` one document behind, so the merge could not
  // see the new shape and `setDoc(merged)` — queued after it — won.
  const commit = block("commit", 700);
  assert.match(commit, /advance\(next\);/);
  assert.doesNotMatch(commit, /set[D]oc\(next\);/);
});

test("a save that lands after a newer edit does not call the page clean", () => {
  const flush = block("flush", 1600);
  assert.match(flush, /const wrote = docVersion\.current;/);
  assert.match(
    flush,
    /if \(docVersion\.current === wrote\) \{\s*dirty\.current = false;/,
    "clearing the dirty flag for a document that is no longer on screen loses the newer edit at unmount",
  );
  assert.match(block("scheduleSave", 800), /docVersion\.current \+= 1;/);
});

test("workspace sketch writes and the close flush are serialized", () => {
  // Debouncing prevents two idle timers from coexisting, but it does not stop
  // the next timer from firing while an earlier IPC write is still flushing.
  // Workspace writes use optimistic hashes, so concurrent saves can conflict
  // or land out of order. Both the normal flush and the unmount flush must go
  // through one promise chain.
  const persist = block("persist", 900);
  assert.match(persist, /saveChain\.current\s*\n?\s*\.catch\(\(\) => undefined\)/);
  assert.match(persist, /api\.saveSketch\(/);
  assert.match(persist, /saveChain\.current = write;/);
  assert.match(block("flush", 1600), /await persist\(next\);/);
  const cleanup = VIEW.slice(VIEW.indexOf("// A drawing has no Save button"), VIEW.indexOf("// ------------------------------------------------- the agent drawing here"));
  assert.match(cleanup, /void persist\(docRef\.current\)\.catch\(\(\) => undefined\);/);
  assert.doesNotMatch(cleanup, /void api\.saveSketch\(/);
});

test("an external file refresh invalidates every stale canvas write", () => {
  // `file-updated` makes the shell re-read and remount asynchronously. Until
  // that finishes, the old canvas still owns its debounce, retry and unmount
  // flush. It must cancel all three rather than relying on a late conflict to
  // rescue bytes the external writer has already committed.
  const external = VIEW.slice(
    VIEW.indexOf("// A file-specific refresh means another writer"),
    VIEW.indexOf("// A drawing has no Save button"),
  );
  assert.match(external, /api\.onFileUpdated/);
  assert.match(external, /externalRevision\.current \+= 1;/);
  assert.match(external, /dirty\.current = false;/);
  assert.match(external, /clearTimeout\(saveTimer\.current\)/);
  assert.match(external, /clearTimeout\(retryTimer\.current\)/);
  const persist = block("persist", 1200);
  assert.match(persist, /basedOnExternalRevision = externalRevision\.current/);
  assert.match(persist, /externalRevision\.current !== basedOnExternalRevision/);
  const flush = block("flush", 2000);
  assert.match(flush, /externalRevision\.current !== basedOnExternalRevision/);
});

test("a sketch save carries the exact document it was based on", () => {
  // The workspace database may already have reconciled a Finder edit by the
  // time autosave runs. Looking up the latest database hash inside the save
  // would approve overwriting that external edit. The canvas must carry its
  // own last-known normal-file JSON and advance it only after a real write or
  // after an agent event whose write has already committed.
  const persist = block("persist", 1200);
  assert.match(persist, /persistedDoc\.current/);
  assert.match(persist, /api\.saveSketch\([\s\S]*persistedDoc\.current/);
  assert.match(persist, /persistedDoc\.current = serialized;/);
  assert.match(API, /save_sketch[\s\S]*editorAutosave: true/);
  const drawn = VIEW.slice(VIEW.indexOf(".onSketchDrawn"), VIEW.indexOf(".onSketchDrawn") + 1800);
  assert.match(drawn, /persistedDoc\.current = e\.doc;/);
});

test("a failed save asks again instead of sitting there saying it failed", () => {
  // A canvas has no Save button, so nothing else can force the write.
  const flush = block("flush", 2200);
  const caught = flush.slice(flush.indexOf("} catch {"));
  assert.match(caught, /retryTimer\.current = window\.setTimeout\(/);
  assert.match(caught, /retryIn\.current/, "and it backs off rather than spinning");
  assert.match(VIEW, /SAVE_RETRY_MAX_MS = \d+/, "with a ceiling");
  // …but a SUPERSEDED write failing says nothing about the document on screen:
  // announcing it said "Couldn't save" over a page the newer write had already
  // put on disk, and armed a retry to write it a second time.
  assert.match(caught, /if \(docVersion\.current !== wrote\) return;/);
});

test("locked really is locked: the eraser passes over it, and so do the arrows and the grips", () => {
  const erase = block("eraseAt", 900);
  assert.match(
    erase,
    /elements: docRef\.current\.elements\.filter\(\(e\) => !e\.locked\)/,
    "one eraser swipe used to delete a locked backdrop",
  );
  // The object strip is the ONE way a locked shape can enter a selection —
  // `toggleLock` drops the selection as it locks, and the canvas, the lasso and
  // Select all all pass over locked shapes — so it stays selectable, or the
  // popover's Unlock can never be reached again. What had to close is the other
  // end: the two paths that MOVED it once it was selected.
  const nudge = block("nudge", 800);
  assert.match(nudge, /picked\.has\(e\.id\) && !e\.locked \? translate\(/);
  // `gripUnder` answers from the selection box, not from the grips that were
  // drawn, so withholding the grips in the markup does not withhold the resize.
  const down = VIEW.slice(VIEW.indexOf("const grip = gripUnder(p);"));
  const els = down.slice(0, down.indexOf("const box = bboxOfMany(els);"));
  assert.match(els, /selected\.includes\(e\.id\) && !e\.locked/);
});

test("a locked shape can still be reached to unlock it", () => {
  // Every other way in is closed by design; if the strip closed too, "Lock in
  // place" would be a one-way door with the Unlock item permanently unreachable.
  const chip = VIEW.slice(VIEW.indexOf('role="option"'), VIEW.indexOf('role="option"') + 1800);
  assert.doesNotMatch(chip, /if \(e\.locked\) return;/, "the chip must still select it");
  assert.doesNotMatch(chip, /aria-disabled=\{e\.locked/, "…and must not say otherwise");
  assert.match(VIEW, new RegExp(concat("toggle", "Lock\\(\\);")), "…so Unlock stays callable");
});

test("the note field is placed where the click was, at any zoom", () => {
  // It was positioned as a percentage of the DOCUMENT, which is only ever
  // right at 100% with the page exactly filling its box.
  const pos = block("stagePosition", 900);
  assert.match(pos, /getScreenCTM\(\)/);
  assert.match(pos, /getBoundingClientRect\(\)/);
  assert.match(pos, /px`/, "the answer is in pixels relative to the stage");
  assert.match(VIEW, /style=\{stagePosition\(textAt\)\}/, "…and the field uses it");
});

test("renaming a shape costs one undo entry, not one per character", () => {
  const relabel = block("relabel", 700);
  assert.match(relabel, /\{ undoable: false \}/);
  // Keyed by the element: React fires no blur when the field UNMOUNTS, so a
  // doc parked under one shape and banked under the next would push a document
  // from before that removal — one ⌘Z jumping FORWARD over the work between.
  assert.match(relabel, /labelBefore\.current\?\.id !== id/);
  assert.match(relabel, /labelBefore\.current = \{ id, doc: docRef\.current \}/);
  const end = block("endRelabel", 500);
  assert.match(end, new RegExp(concat("push", "History\\(h, parked\\.doc\\)")));
  assert.match(VIEW, /onBlur=\{endRelabel\}/, "the entry is banked when the field lets go");
});

test("a line's label is drawn on the line, not in the corner of the page", () => {
  // `draw` accepts `line 200 200 600 600 blue "boundary"` and the word landed
  // at 0,0 — the top-left of the whole sheet.
  assert.ok(
    !VIEW.includes(concat('<text className="sk-shape-label" x={0} ', "y={0}>")),
    "the origin-placed label must be gone",
  );
  const arm = VIEW.slice(VIEW.indexOf('case "line": {'), VIEW.indexOf('case "line": {') + 900);
  assert.match(arm, /x=\{\(a\[0\] \+ b\[0\]\) \/ 2\}/);
  assert.match(arm, /y=\{\(a\[1\] \+ b\[1\]\) \/ 2 - 12\}/);
});

/** Join a needle from parts, so this file's own text cannot match it. */
function concat(...parts) {
  return parts.join("");
}
