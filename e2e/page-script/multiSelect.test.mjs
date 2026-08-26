/* THE DRIFT TESTS for the Library's multi-selection.
 *
 * Three of the four things below are invariants no compiler and no Rust test
 * can see, because each one is a relationship between two files that both
 * typecheck perfectly while disagreeing:
 *
 *   1. SELECTION IS NOT THE EVIDENCE SET. The library already had checkboxes
 *      before this feature, and they mean something else entirely: which files
 *      ground the next AI answer (`attachments`). Both are "a set of files the
 *      user ticked", so the pressure to collapse them into one slot is
 *      constant — and the result would be that picking three files to move
 *      them silently rewrites what the model reads next. Nothing about that
 *      fails to compile.
 *
 *   2. THE MENU ACTS ON WHAT IT SAYS IT ACTS ON. The context menu takes a
 *      LIST now. A single `.file` left behind on the destructive arm is a menu
 *      that reads "Remove 7 files" and trashes one — or, in the other
 *      direction, a menu that reads "Remove" and trashes seven.
 *
 *   3. THE TWO ENDS OF A DRAG AGREE. FileRow serializes the dragged ids and
 *      Sidebar parses them, in different files, with no shared type. A change
 *      to either separator silently degrades a 40-file drag into a 1-file
 *      drag — with no error, because the first line still parses.
 *
 * Textual on purpose: runs in `npm run test:page`, in a second, against the
 * shipped sources rather than a model of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const STATE = read("src/workspace/state.ts");
const ACTIONS = read("src/workspace/fileActions.ts");
const ROW = read("src/workspace/FileRow.tsx");
const SIDEBAR = read("src/workspace/Sidebar.tsx");
const OVERLAYS = read("src/workspace/Overlays.tsx");
const TRASH = read("src/workspace/TrashPanel.tsx");
const API = read("src/api.ts");
const IPC = read("electron-migration/electron-app/electron/main/fileSurfaceIpc.ts");
const MOCK = read("qa/qa-mock.js");

/** A TS/TSX function body, by brace matching from a signature fragment.
 *
 * The opening brace is found at PAREN DEPTH ZERO, not simply "the next `{`":
 * these signatures destructure their arguments (`clickFile(f, { meta, shift })`),
 * so the naive scan returns the parameter's type annotation and every assertion
 * against it passes or fails for the wrong reason. */
function fnBody(src, signature) {
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
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

test("the selection and the AI evidence set are separate state", () => {
  // Two slots, and they must stay two. `attachments` decides what the model
  // reads; `selectedFileIds` decides what the next click acts on.
  assert.match(STATE, /const \[selectedFileIds, setSelectedFileIds\]/);
  assert.match(STATE, /const \[attachments, setAttachments\]/);
  // The Trash tab keeps its OWN set: one shared set would carry a library
  // selection into "delete for good", the single action with no undo.
  assert.match(STATE, /const \[selectedTrashIds, setSelectedTrashIds\]/);
});

test("picking a file never touches what the AI is allowed to read", () => {
  // `clickFile` is every selection gesture (plain / cmd / shift). If it ever
  // reached setAttachments, selecting rows would rewrite the evidence set.
  const body = fnBody(ACTIONS, "function clickFile(");
  assert.ok(
    !/setAttachments/.test(body),
    "clickFile must not write the attachment set — that is a different question",
  );
  // And the reverse: toggleAttach lives elsewhere and must not write selection.
  assert.ok(
    !/setSelectedFileIds/.test(fnBody(ACTIONS, "function attachFiles(")),
    "attaching files must not silently change the selection",
  );
});

test("a shift-range can only ever cover rows that are on the screen", () => {
  // The range walks `visibleFileOrder`. Built from `s.files` instead, it would
  // select rows the filter has hidden or a collapsed folder is holding — i.e.
  // arm a destructive action against files nobody can review first.
  const body = fnBody(ACTIONS, "function clickFile(");
  assert.match(body, /visibleFileOrder/);
  assert.ok(
    !/\bs\.files\b/.test(body),
    "the range must be taken from the painted order, never the whole room",
  );
  // Collapsed folders contribute nothing to that order.
  assert.match(SIDEBAR, /collapsedFolders\.has\(folder\.id\)\s*\n?\s*\?\s*\[\]/);
});

test("the context menu's destructive arm acts on the whole list it names", () => {
  // The label and the action must read the same source. A `.file.id` here with
  // a `.files.length` in the label is the exact silent mismatch this pins.
  const menu = OVERLAYS.slice(OVERLAYS.indexOf("s.ctxMenu && ("));
  assert.match(menu, /removeFiles\(ids\)/, "many files → the batch verb");
  assert.match(menu, /removeFile\(ids\[0\]\)/, "one file → the single verb");
  assert.match(
    menu,
    /Move \$\{s\.ctxMenu\.files\.length\} files to the trash\?/,
    "the confirm question must state the count it is about to act on",
  );
});

test("both ends of a library drag serialize ids the same way", () => {
  // FileRow writes them, Sidebar reads them, and nothing types the wire.
  assert.match(ROW, /ids\.join\("\\n"\)/, "FileRow joins dragged ids on newlines");
  const parse = fnBody(SIDEBAR, "function dragIds(");
  assert.match(parse, /\.split\("\\n"\)/, "Sidebar splits on the same separator");
  // Every drop site goes through the shared parser rather than reading the
  // transfer directly — a site that called getData() itself would take
  // "id1\nid2" as ONE id and move nothing. Exactly one read exists, and it is
  // the one inside dragIds().
  const reads = SIDEBAR.match(/getData\(/g) || [];
  assert.equal(
    reads.length,
    1,
    "only dragIds() may read the drag payload; found extra direct reads",
  );
  assert.match(parse, /getData\(/, "…and that one read is dragIds' own");
});

test("every batch command is registered, invoked and faked", () => {
  // Three files have to agree or the feature is dead in one of the three
  // worlds it runs in (app, QA harness, coverage report).
  for (const cmd of [
    "trash_files",
    "move_files_to_folder",
    "restore_files",
    "delete_files_permanently",
  ]) {
    assert.match(API, new RegExp(`"${cmd}"`), `${cmd} is not invoked from api.ts`);
    assert.match(
      IPC,
      new RegExp(`handle\\("${cmd}"`),
      `${cmd} is missing from the Electron file IPC surface`,
    );
    assert.match(MOCK, new RegExp(`\\b${cmd}:`), `${cmd} has no qa-mock fixture`);
  }
});

test("a batch receipt is built from the backend's answer, not the input list", () => {
  // The whole reason these commands return a value. `report.ok.length` is what
  // actually happened; `ids.length` is what we asked for, and reporting the
  // second over a partial failure is the lie the BulkReport exists to prevent.
  const body = fnBody(ACTIONS, "function reportBulk(");
  assert.match(body, /report\.ok\.length/);
  assert.match(body, /report\.failed/, "failures are reported, never swallowed");
  assert.match(body, /report\.capped/, "a truncated batch says so");
  assert.ok(
    !/ids\.length/.test(body),
    "the receipt must never count the request instead of the result",
  );
});

test("the trash's bulk destroy keeps its own, harder confirmation", () => {
  // Restore is one click; destroy is armed, and its question says the word the
  // library's Remove deliberately does not.
  assert.match(TRASH, /trash-destroy-selection/);
  assert.match(TRASH, /for good\? This cannot be undone\./);
});
