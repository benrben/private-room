/* THE DRIFT TEST for the viewer's encoding strip and the Edit routing.
 *
 * Two tables have to agree for a legacy-encoded text file to behave:
 *
 *   - `formats.rs` says which kinds hold their text AS BYTES (`text: Raw`).
 *     Those are exactly the kinds that HAVE an encoding to argue about, and
 *     `RE_DECODABLE_KINDS` in `src/viewers/TextEncoding.tsx` is the frontend's
 *     copy of that list. If a raw-text kind goes missing from it, that format
 *     silently loses its encoding picker — which looks like nothing at all,
 *     because a wrongly-decoded file renders perfectly happily as mojibake.
 *
 *   - `registry.tsx` says what Edit does per kind. A `.txt` (kind `prose`) has
 *     to reach the in-place editor, not the "save a separate copy" path: live
 *     QA 2026-08-03 opened one and found no way to edit it at all.
 *
 * Read textually, like registry.test.mjs, so it fails in `npm run test:page`
 * rather than only under cargo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const ENCODING = readFileSync(join(root, "apps/desktop/src/renderer/viewers/TextEncoding.tsx"), "utf8");
const REGISTRY = readFileSync(join(root, "apps/desktop/src/renderer/viewers/registry.tsx"), "utf8");
const FILES_HOST = readFileSync(
  join(root, "apps/desktop/src/main/fileRuntimeSurfaceIpc.ts"),
  "utf8",
);

/** Every kind in the Rust table whose text is the file's own bytes, including
 * the fallback `CODE` row (which is chosen by extension, not by the table). */
/* Raw-text kinds that deliberately have NO encoding to argue about.
 *
 * `.sketch` holds a JSON document this app wrote itself, always as UTF-8. It
 * is `text: Raw` because its VIEWER needs the document (the drawing editor
 * parses it), not because its bytes came from somewhere with a charset —
 * offering to re-decode a drawing as windows-1255 would be a control that
 * cannot do anything but corrupt it.
 */
/** The members of `RE_DECODABLE_KINDS` in TextEncoding.tsx. */
function frontendRawKinds() {
  const start = ENCODING.indexOf("RE_DECODABLE_KINDS");
  assert.ok(start >= 0, "RE_DECODABLE_KINDS not found in TextEncoding.tsx");
  const body = ENCODING.slice(start, ENCODING.indexOf("]);", start));
  return [...body.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
}

test("a plain-text file's Edit is the in-place editor, not a separate copy", () => {
  // `prose` is what a .txt classifies as. `editableText` is the row helper that
  // resolves to the CodeEditor/MarkdownEditor path; `copyIfText` is the one
  // that writes a separate Markdown note and leaves the file alone.
  const row = REGISTRY.match(/\n {2}prose: \{[\s\S]*?\n {2}\},/);
  assert.ok(row, "the `prose` row is gone from registry.tsx");
  assert.match(
    row[0],
    /edit: editableText,/,
    "a .txt must reach the in-place editor — live QA found it offering no way to edit at all",
  );
  // The same holds for the other two kinds a plain text file can land on.
  for (const kind of ["log", "code"]) {
    const r = REGISTRY.match(new RegExp(`\\n {2}${kind}: \\{[\\s\\S]*?\\n {2}\\},`));
    assert.ok(r, `the \`${kind}\` row is gone from registry.tsx`);
    assert.match(r[0], /edit: editableText,/, `${kind} must edit in place`);
  }
});

test("Edit is offered on a legacy encoding, and withheld only on a lossy read", () => {
  // The Rust half of the same promise: `editable` used to require valid UTF-8,
  // which is exactly why the Turkish .txt had no Edit button. The rule now is
  // "the format allows it AND the decode was clean".
  assert.match(
    FILES_HOST,
    /editable: !lossy && viewerKind/,
    "the editable rule must be 'the format allows it AND the decode was clean'",
  );
  assert.match(
    FILES_HOST,
    /new TextDecoder\(encoding, \{ fatal: true \}\)/,
    "the viewer payload must come from the same decode the encoding strip re-runs",
  );
});

test("the editor says a save will convert the file, and never claims otherwise", () => {
  // Saving writes UTF-8 — that is all the writer does — so a legacy file is
  // CONVERTED by being saved. Doing that silently is the failure mode this
  // wording exists to prevent.
  assert.match(ENCODING, /rewrites the whole file/);
  assert.match(ENCODING, /as UTF-8/);
  // And the note must not appear for files that are already UTF-8, or it would
  // warn about a conversion that isn't happening.
  assert.match(ENCODING, /d\.encoding === "UTF-8"\) return null;/);
});

const ROUTER = readFileSync(join(root, "apps/desktop/src/renderer/workspace/ViewerRouter.tsx"), "utf8");

test("a re-read is dropped when the file's bytes are replaced under it", () => {
  // The hook caches a decode and the router draws it INSTEAD of the payload.
  // `saveEdit`, `restoreVersion`, `undoEdits` and the `file-changed` listener
  // all swap `openFile.content` without unmounting the viewer, so a cache keyed
  // only on the file id would redraw the PRE-SAVE text over the new one — and
  // hand it back to the next Edit, silently reverting the save. A pick made
  // against the old bytes is equally dead: saving converts the file to UTF-8,
  // so re-applying windows-1254 to it produces mojibake.
  assert.match(
    ENCODING,
    /const payload = content\.text \?\? "";/,
    "the cache has to be keyed on the payload, not just the file id",
  );
  assert.match(
    ENCODING,
    /\}, \[applies, fileId, chosen, payload\]\);/,
    "the re-read must re-run when the file's bytes are replaced",
  );
});

test("every in-place editor warns about the conversion, not just Monaco", () => {
  // A .md is a raw-text kind like any other, so a legacy-encoded one is
  // converted by being saved. It edits in MarkdownEditor, which has the same
  // banner slot — leaving it off is exactly the silent transcode.
  assert.ok(RE_DECODABLE_KINDS_HAS("markdown"), "markdown is a re-decodable kind");
  const md = ROUTER.match(/<MarkdownEditor[\s\S]*?\/>/);
  assert.ok(md, "the MarkdownEditor branch is gone from ViewerRouter");
  assert.match(
    md[0],
    /banner=\{editBanner\(mode, c\.name, encodingSaveNote\(enc\.decoded\)\)\}/,
    "the Markdown editor must say a save will convert the file too",
  );
});

function RE_DECODABLE_KINDS_HAS(kind) {
  return frontendRawKinds().includes(kind);
}
