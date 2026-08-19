/* THE UNSAVED-EDITS GUARD MUST COVER EVERY EXIT THAT UNMOUNTS THE EDITOR.
 *
 * Monaco holds ONE buffer — the file that is showing — so anything that takes
 * that file off screen takes the edit with it. `guardLeave` exists for exactly
 * that, and the tab strip, ⌘W, ⌘T and the viewer's Close button all go through
 * it. Two doors did not:
 *
 *   • ESCAPE. `effects.ts` closed the open file outright, so type-then-Escape
 *     lost the buffer with no dialog at all.
 *   • OPENING ANOTHER FILE. Every open in the app funnels through `viewFile`,
 *     and it replaced the open document without asking — a Library click, a ⌘K
 *     hit, an agent open, a job toast's "Open" or the recording chip all
 *     discarded in-progress text silently.
 *
 * Neither fails to compile, and neither shows up in a screenshot. So both are
 * driven for real here: the shipped `viewFile`, `guardLeave` and the Escape
 * key handler are SLICED out of their sources (they close over React state
 * that cannot be imported) and run against a fake workspace state — the same
 * technique contextualNav/navRedesign use.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const FILEACTIONS = read("src/workspace/fileActions.ts");
const EFFECTS = read("src/workspace/effects.ts");

/** A whole function declaration, by brace matching from its signature. The
 * opening brace is taken at paren depth zero so a parameter's own type
 * annotation cannot be mistaken for the body. */
function fnSource(src, signature, from = 0) {
  const at = src.indexOf(signature, from);
  assert.notEqual(at, -1, `${signature} is gone from the source`);
  let parens = 0;
  let open = -1;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") parens--;
    else if (src[i] === "{" && parens === 0) {
      open = i;
      break;
    }
  }
  assert.notEqual(open, -1, `no body found for ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

/** Everything `makeFileActions` declares between `viewFile` and the next
 * verb — `viewFile` itself plus any helper it delegates the actual open to. */
function openRegion() {
  const at = FILEACTIONS.indexOf("  async function viewFile(");
  const end = FILEACTIONS.indexOf('  /** "New page": a blank Markdown note');
  assert.ok(at !== -1 && end > at, "viewFile is no longer where this test slices");
  return FILEACTIONS.slice(at, end);
}

/** The latch `openFile` reads to know it has been superseded. It lives at
 * MODULE level in the source on purpose — `makeFileActions` is rebuilt on every
 * render, so a variable inside it would forget which open is the current one
 * between two clicks — which means the slice has to carry it too. */
function moduleState() {
  const at = FILEACTIONS.indexOf("let openIntent");
  assert.notEqual(at, -1, "the open-intent latch is gone from the source");
  return FILEACTIONS.slice(at, FILEACTIONS.indexOf("\n", at) + 1);
}

const MODULE = [
  moduleState(),
  // `uniqueFileName` is imported by fileActions.ts, and the slice has no
  // imports — so the collaborators it reaches for arrive as parameters, the
  // way `displayName` already does. Defaulted, so the call sites that do not
  // exercise naming stay as they are.
  "export function makeFiles(s, api, displayName, uniqueFileName = (n) => n) {",
  fnSource(FILEACTIONS, "function guardLeave("),
  openRegion(),
  fnSource(FILEACTIONS, "async function writeNewNote("),
  fnSource(FILEACTIONS, "async function writeNewScript("),
  "  return { viewFile, guardLeave, writeNewNote, writeNewScript };",
  "}",
  "export function makeEscape(s, a) {",
  fnSource(EFFECTS, "function onKey(e: KeyboardEvent) {"),
  "  return onKey;",
  "}",
].join("\n");

const JS = ts.transpileModule(MODULE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { makeFiles, makeEscape } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A workspace whose editor is showing `open`, in `editMode`, `dirty` or not. */
function fakeState({ open = null, editMode = false, dirty = false } = {}) {
  const s = {
    files: [
      { id: "a", name: "Draft.md" },
      { id: "b", name: "Other.md" },
    ],
    opened: [],
    pendingLeave: null,
    editMode,
    openFileRef: { current: open },
    editModeRef: { current: editMode },
    editorDirtyRef: { current: dirty },
    setPendingLeave: (p) => {
      s.pendingLeave = p;
    },
    setOpenFile: (v) => {
      s.opened.push(v);
      s.openFileRef.current = v;
    },
    setOpeningFileId: () => {},
    setFiles: () => {},
    setEditMode: (v) => {
      s.editMode = v;
    },
    setShowMap: () => {},
    pushToast: () => {},
    forgetToastsAbout: () => {},
    // Only the Escape handler reads these; every one is "nothing else is up".
    ctxMenuRef: { current: null },
    showSearchRef: { current: false },
    showSettingsRef: { current: false },
    showMapRef: { current: false },
    showWorkflowsRef: { current: false },
    showScriptsRef: { current: false },
    setCtxMenu: () => {},
    setShowSearch: () => {},
    setShowWorkflows: () => {},
    setShowScripts: () => {},
    setSearchSel: () => {},
    setShowSettings: () => {},
    setOpenMenu: () => {},
    setShowShortcuts: () => {},
  };
  return s;
}

/** `get_file_content` is a Tauri command behind the room mutex — it costs a
 * real round trip, never a resolved-on-the-spot promise. A fake that settles
 * within the same microtask hides every ordering bug that only shows up while
 * the read is still in flight, so this one takes a tick like the real one. */
function fakeApi() {
  const fetched = [];
  return {
    fetched,
    api: {
      getFileContent: async (id) => {
        fetched.push(id);
        await new Promise((r) => setTimeout(r, 0));
        return { name: `${id}.md`, text: "on disk" };
      },
      saveGeneratedFile: async (name) => ({ id: "new", name }),
      listFiles: async () => [],
    },
  };
}

const DIRTY = { open: { id: "a" }, editMode: true, dirty: true };

/* ---------------- opening another file ---------------- */

test("opening a different file asks before it throws the buffer away", async () => {
  const s = fakeState(DIRTY);
  const { api, fetched } = fakeApi();
  const { viewFile } = makeFiles(s, api, (n) => n);

  await viewFile("b");

  assert.ok(s.pendingLeave, "no unsaved-edits dialog was raised");
  assert.deepEqual(s.opened, [], "the open file was replaced before the user answered");
  assert.deepEqual(fetched, [], "the other file was read before the user answered");

  // Save or Discard replays the interrupted open.
  s.pendingLeave.proceed();
  await settle();
  assert.equal(s.opened.at(-1)?.id, "b", "answering the dialog did not open the file");
});

test("Cancel leaves the edited file exactly where it was", async () => {
  const s = fakeState(DIRTY);
  const { api } = fakeApi();
  const { viewFile } = makeFiles(s, api, (n) => n);

  await viewFile("b");
  s.pendingLeave = null; // what Cancel does
  await settle();

  assert.deepEqual(s.opened, [], "Cancel still replaced the open file");
  assert.equal(s.openFileRef.current.id, "a");
});

test("re-opening the SAME file is a reload, not a leave, and never asks", async () => {
  // The agent rewriting the open file and a finished recording both re-open the
  // id that is already showing. A dialog there would be a false alarm.
  const s = fakeState(DIRTY);
  const { api } = fakeApi();
  const { viewFile } = makeFiles(s, api, (n) => n);

  await viewFile("a");

  assert.equal(s.pendingLeave, null, "a reload of the open file raised the dialog");
  assert.equal(s.opened.at(-1)?.id, "a");
});

test("a saved editor and an empty viewer both open straight through", async () => {
  const clean = fakeState({ open: { id: "a" }, editMode: true, dirty: false });
  const { api } = fakeApi();
  await makeFiles(clean, api, (n) => n).viewFile("b");
  assert.equal(clean.pendingLeave, null);
  assert.equal(clean.opened.at(-1)?.id, "b");

  const empty = fakeState();
  await makeFiles(empty, fakeApi().api, (n) => n).viewFile("b");
  assert.equal(empty.pendingLeave, null);
  assert.equal(empty.opened.at(-1)?.id, "b");
});

/* ---------------- two opens at once ---------------- */

test("a slower earlier open never paints over the file chosen after it", async () => {
  // A big PDF's read is still in flight when the note beside it is clicked —
  // and the job-toast auto-open, the recording reload and the agent's open all
  // land the same way, alongside a click. `get_file_content` calls are separate
  // tasks and the room mutex is not FIFO, so resolution order is not click
  // order: whoever finished LAST used to win the screen.
  const s = fakeState();
  const delay = { big: 20, note: 0 };
  const api = {
    getFileContent: async (id) => {
      await new Promise((r) => setTimeout(r, delay[id]));
      return { name: `${id}.md`, text: "on disk" };
    },
    listFiles: async () => [],
  };
  const { viewFile } = makeFiles(s, api, (n) => n);

  const slow = viewFile("big");
  const quick = viewFile("note");
  await Promise.all([slow, quick]);

  assert.deepEqual(
    s.opened.map((o) => o.id),
    ["note"],
    "the abandoned open painted itself over the file the user actually chose",
  );
  assert.equal(s.openFileRef.current.id, "note");
});

/* ---------------- what "new" opens INTO ---------------- */

/* "New page" and "New script" mean an empty document with the cursor in it.
 * They ask the unsaved-edits question themselves, before they write anything,
 * so the open that follows has nothing left to ask — and it must be AWAITED,
 * because `openFile` ends with `setEditMode(false)` (a freshly opened file is
 * read mode) and the `setEditMode(true)` these two do afterwards is what makes
 * the new note editable. Hand that open to the guard instead and it is replayed
 * unawaited: edit mode is switched on and then off again by the load landing
 * behind it, and the new note opens read-only with no cursor. */

test("a new note opens in edit mode even with another file already showing", async () => {
  const s = fakeState({ open: { id: "a" }, editMode: true, dirty: false });
  const { writeNewNote } = makeFiles(s, fakeApi().api, (n) => n);

  await writeNewNote();
  await settle();

  assert.equal(s.opened.at(-1)?.id, "new", "the new note never opened");
  assert.equal(s.editMode, true, "the new note opened read-only — nothing to type into");
});

test("a new script opens in edit mode even with another file already showing", async () => {
  const s = fakeState({ open: { id: "a" }, editMode: true, dirty: false });
  const { writeNewScript } = makeFiles(s, fakeApi().api, (n) => n);

  await writeNewScript();
  await settle();

  assert.equal(s.opened.at(-1)?.id, "new", "the new script never opened");
  assert.equal(s.editMode, true, "the new script opened read-only — nothing to type into");
});

/* ---------------- Escape ---------------- */

/** An element the way the handler asks about one: a tag, and an ancestor
 * lookup. Real targets always answer `closest`; a stub that did not would let
 * the handler read every field in the app as "not the editor". */
const elem = (tagName, ancestors = []) => ({
  tagName,
  closest: (sel) => (ancestors.includes(sel) ? {} : null),
});

/** Where the caret actually is while you type in a note. Monaco's visible
 * text is painted; the caret lives in a hidden <textarea class="inputarea">
 * inside `.monaco-editor`. */
const MONACO_CARET = elem("TEXTAREA", [".monaco-editor"]);

function escapeKey() {
  let prevented = false;
  return {
    key: "Escape",
    metaKey: false,
    target: elem("DIV"),
    preventDefault: () => {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  };
}

test("Escape on an unsaved file asks instead of discarding it", async () => {
  const s = fakeState(DIRTY);
  const { guardLeave } = makeFiles(s, fakeApi().api, (n) => n);
  const onKey = makeEscape(s, { guardLeave });

  onKey(escapeKey());

  assert.ok(s.pendingLeave, "Escape closed the file with no unsaved-edits dialog");
  assert.deepEqual(s.opened, [], "Escape discarded the buffer");

  s.pendingLeave.proceed();
  assert.deepEqual(s.opened, [null], "answering the dialog did not close the file");
});

test("Escape still closes a file with nothing unsaved", () => {
  const s = fakeState({ open: { id: "a" }, editMode: true, dirty: false });
  const { guardLeave } = makeFiles(s, fakeApi().api, (n) => n);
  const e = escapeKey();

  makeEscape(s, { guardLeave })(e);

  assert.equal(s.pendingLeave, null);
  assert.deepEqual(s.opened, [null]);
  assert.ok(e.prevented);
});

test("Escape while typing in a field is the field's, not the viewer's", () => {
  const s = fakeState({ open: { id: "a" } });
  const { guardLeave } = makeFiles(s, fakeApi().api, (n) => n);

  const e = escapeKey();
  e.target = elem("INPUT");
  makeEscape(s, { guardLeave })(e);

  assert.deepEqual(s.opened, []);
  assert.equal(s.pendingLeave, null);
});

/* THE EDITOR IS NOT "A FIELD", and reading it as one made Escape do NOTHING.
 *
 * The rule above skips INPUT and TEXTAREA so that Escape in the chat composer
 * or a rename box belongs to that box. Monaco's caret sits in a hidden
 * <textarea>, so the tag test caught the note editor too — and Escape on the
 * one surface with a buffer to lose became a key that did not do anything at
 * all: no close, and therefore no unsaved-edits dialog either. Live QA:
 * "Escape does nothing at all — no dialog appears."
 *
 * Monaco's own Escape bindings are not at risk. Its keybinding service calls
 * stopPropagation() on every key it handles, so a shell listener on `window`
 * hears Escape only when the editor had nothing to dismiss — no suggest
 * widget, no find widget, no extra cursors. */
test("Escape with the caret in the note editor is the file's, and it asks first", () => {
  const s = fakeState(DIRTY);
  const { guardLeave } = makeFiles(s, fakeApi().api, (n) => n);

  const e = escapeKey();
  e.target = MONACO_CARET;
  makeEscape(s, { guardLeave })(e);

  assert.ok(
    s.pendingLeave,
    "Escape in the editor did nothing — no close, and so no unsaved-edits dialog",
  );
  assert.deepEqual(s.opened, [], "Escape discarded the buffer");
  s.pendingLeave.proceed();
  assert.deepEqual(s.opened, [null]);
});

test("Escape with the caret in a SAVED note still closes it", () => {
  const s = fakeState({ open: { id: "a" }, editMode: true, dirty: false });
  const { guardLeave } = makeFiles(s, fakeApi().api, (n) => n);

  const e = escapeKey();
  e.target = MONACO_CARET;
  makeEscape(s, { guardLeave })(e);

  assert.equal(s.pendingLeave, null);
  assert.deepEqual(s.opened, [null]);
  assert.ok(e.prevented);
});
