/* THE PER-ANSWER "UNDO EDIT" CHIP MUST UNDO THAT ANSWER — NOT WHATEVER IS NEWEST.
 *
 * The chip records file IDS only, so `undoEdits` has to work out which saved
 * version each file goes back to. Restoring `versions[0]` — the newest row,
 * whatever cut it — was wrong in both directions:
 *
 *   • ONE ANSWER, TWO WRITES to the same file cut two version rows. Restoring
 *     the newest put the file back to the state BETWEEN them: the first write
 *     stayed applied, the chip removed itself, and the toast said "Change
 *     undone".
 *   • A LATER SAVE BY THE USER cut a row of its own, holding the AI's text.
 *     Restoring that row replaced the user's own paragraph with the AI's
 *     wording — data loss, under a toast claiming the AI's change was undone.
 *
 * `undoEdits` closes over React state that cannot be imported, so it is SLICED
 * out of its source and run against a fake workspace, the way unsavedGuard and
 * contextualNav drive their handlers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FILEACTIONS = readFileSync(join(root, "apps/desktop/src/renderer/workspace/fileActions.ts"), "utf8");

/** A whole function declaration, by brace matching from its signature. */
function fnSource(src, signature) {
  const at = src.indexOf(signature);
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

const MODULE = [
  "export function makeUndo(s, api, displayName) {",
  fnSource(FILEACTIONS, "async function undoEdits("),
  "  return undoEdits;",
  "}",
].join("\n");

const JS = ts.transpileModule(MODULE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { makeUndo } = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

/* The turn under test: the question at :00, the answer row written at :30. */
const ASKED = "2026-08-16T10:00:00Z";
const ANSWERED = "2026-08-16T10:00:30Z";

function fakeState(versionsByFile) {
  return {
    undoByMsg: { m1: [...Object.keys(versionsByFile)] },
    messages: [
      { id: "m0", role: "user", createdAt: ASKED },
      { id: "m1", role: "assistant", createdAt: ANSWERED },
    ],
    files: [
      { id: "notes", name: "notes.md" },
      { id: "report", name: "report.md" },
    ],
    toasts: [],
    undoCleared: false,
    openFileRef: { current: null },
    setUndoByMsg: (f) => {
      f({ m1: ["notes"] });
    },
    setFiles: () => {},
    setOpenFile: () => {},
    setViewerRev: () => {},
    pushToast: function (kind, text) {
      this.toasts.push({ kind, text });
    },
  };
}

function fakeApi(versionsByFile) {
  const restored = [];
  return {
    restored,
    api: {
      listFileVersions: async (id) => versionsByFile[id],
      restoreFileVersion: async (versionId) => {
        restored.push(versionId);
      },
      listFiles: async () => [],
      getFileContent: async () => ({ name: "x", text: "" }),
    },
  };
}

test("one answer that wrote the same file twice is undone all the way back", async () => {
  // Two writes in one turn cut two rows: `pre-first` holds the text as it was
  // before the answer touched it at all, `pre-second` the half-edited state.
  const versions = {
    report: [
      { id: "pre-second", savedAt: "2026-08-16T10:00:20Z", cause: "AI edit" },
      { id: "pre-first", savedAt: "2026-08-16T10:00:10Z", cause: "AI edit" },
      { id: "older", savedAt: "2026-08-15T09:00:00Z", cause: "You saved" },
    ],
  };
  const s = fakeState(versions);
  const { api, restored } = fakeApi(versions);

  await makeUndo(s, api, (n) => n)("m1");

  assert.deepEqual(restored, ["pre-first"], "the first of the two writes was left applied");
  assert.deepEqual(
    s.toasts.map((t) => t.kind),
    ["success"],
  );
  assert.equal(s.toasts[0].text, "Change undone.");
});

test("a file the user has saved since is left alone, and said so", async () => {
  // The user's own save cut a row holding the AI's text. Restoring it would put
  // the AI's wording back over their paragraph.
  const versions = {
    notes: [
      { id: "your-save", savedAt: "2026-08-16T10:05:00Z", cause: "You saved" },
      { id: "pre-ai", savedAt: "2026-08-16T10:00:10Z", cause: "AI edit" },
    ],
  };
  const s = fakeState(versions);
  const { api, restored } = fakeApi(versions);

  await makeUndo(s, api, (n) => n)("m1");

  assert.deepEqual(restored, [], "the user's own later save was rolled back");
  assert.deepEqual(
    s.toasts.map((t) => t.kind),
    ["info"],
    "nothing was undone, so nothing may claim it was",
  );
  assert.match(s.toasts[0].text, /notes\.md/);
  assert.match(s.toasts[0].text, /saved again/);
});

test("the ordinary single write still goes back one step", async () => {
  const versions = {
    notes: [{ id: "pre-ai", savedAt: "2026-08-16T10:00:10Z", cause: "AI edit" }],
  };
  const s = fakeState(versions);
  const { api, restored } = fakeApi(versions);

  await makeUndo(s, api, (n) => n)("m1");

  assert.deepEqual(restored, ["pre-ai"]);
  assert.equal(s.toasts[0].text, "Change undone.");
});

test("a file with no saved versions at all is skipped, not crashed on", async () => {
  const versions = { notes: [] };
  const s = fakeState(versions);
  const { api, restored } = fakeApi(versions);

  await makeUndo(s, api, (n) => n)("m1");

  assert.deepEqual(restored, []);
  assert.deepEqual(s.toasts, [], "there is nothing truthful to report about a file with no history");
});
