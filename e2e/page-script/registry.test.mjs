/* THE DRIFT TEST for the format registry.
 *
 * What a file IS is decided in `src-tauri/src/formats.rs`; what that kind
 * LOOKS like is decided in `src/viewers/registry.tsx`. Those two tables are
 * the whole routing layer now, and the only way they can go wrong is by
 * disagreeing — a kind added on the Rust side with no viewer here lands on the
 * "no preview available" card, silently, for exactly the formats someone just
 * did the work to support.
 *
 * So this test reads BOTH sources and asserts they name the same kinds. It
 * parses the Rust table with a regex rather than running cargo: the point is
 * to fail in `npm run test:page`, in a second, next to the frontend it guards.
 *
 * The registry itself is TSX and imports React components, so it can't be
 * imported here. `coveredKinds()` is derived from the `FORMATS` object literal
 * by the same textual read — which is fine, because a key that exists in the
 * literal is a key that exists at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const RUST = readFileSync(join(root, "src-tauri/src/formats.rs"), "utf8");
const TSX = readFileSync(join(root, "src/viewers/registry.tsx"), "utf8");
const TYPES = readFileSync(join(root, "src/apiTypes.ts"), "utf8");
const SPREADSHEET = readFileSync(
  join(root, "src-tauri/src/commands/spreadsheet.rs"),
  "utf8",
);
const PANE = readFileSync(join(root, "src/workspace/ViewerPane.tsx"), "utf8");
const SHELL = readFileSync(join(root, "src/workspace/ReaderShell.tsx"), "utf8");
const QUOTE = readFileSync(join(root, "src/workspace/quoteSelection.ts"), "utf8");

/** Every `kind: "…"` in the Rust table, plus the fallback rows and the media
 * kinds `all_kinds()` adds. */
function rustKinds() {
  const kinds = new Set();
  for (const m of RUST.matchAll(/\bkind:\s*"([a-z]+)"/g)) kinds.add(m[1]);
  // The fallback FileView consts are written as `kind: "image"` etc. too, so
  // they are already covered. The media kinds are appended in code:
  for (const m of RUST.matchAll(/kinds\.extend\(\[([^\]]*)\]\)/g)) {
    for (const lit of m[1].matchAll(/"([a-z]+)"/g)) kinds.add(lit[1]);
  }
  // `IMAGE.kind` style entries in that same extend() are the consts above.
  return [...kinds].sort();
}

/** Every top-level key of the `FORMATS` record in registry.tsx. */
function tsxKinds() {
  const start = TSX.indexOf("export const FORMATS");
  assert.ok(start >= 0, "FORMATS table not found in registry.tsx");
  const body = TSX.slice(start);
  const kinds = new Set();
  // Keys sit at exactly two-space indentation inside the record literal.
  for (const m of body.matchAll(/^ {2}([a-z]+):\s*\{$/gm)) kinds.add(m[1]);
  return [...kinds].sort();
}

/** Every member of the ViewerKind union in apiTypes.ts. */
function unionKinds() {
  const start = TYPES.indexOf("export type ViewerKind =");
  assert.ok(start >= 0, "ViewerKind union not found in apiTypes.ts");
  const end = TYPES.indexOf(";", start);
  const kinds = new Set();
  for (const m of TYPES.slice(start, end).matchAll(/"([a-z]+)"/g)) kinds.add(m[1]);
  return [...kinds].sort();
}

test("the Rust format table and the viewer registry name the same kinds", () => {
  const rust = rustKinds();
  const tsx = tsxKinds();
  const missing = rust.filter((k) => !tsx.includes(k));
  const extra = tsx.filter((k) => !rust.includes(k));
  assert.deepEqual(
    missing,
    [],
    `formats.rs can produce ${missing.join(", ")} but registry.tsx has no viewer for it — ` +
      `those files would open on the "no preview available" card`,
  );
  assert.deepEqual(
    extra,
    [],
    `registry.tsx has viewers for ${extra.join(", ")}, which formats.rs never produces — ` +
      `dead code, or a kind that was renamed on one side only`,
  );
});

test("the ViewerKind union matches the registry exactly", () => {
  // TypeScript already enforces Record<ViewerKind, …> in one direction; this
  // catches the other one, where a kind is added to the union and the record
  // is left incomplete in a way a spread or an `as` would hide.
  assert.deepEqual(unionKinds(), tsxKinds());
});

test("every kind the Rust table can produce is reachable", () => {
  // A row whose kind never appears in a `Row {}` literal would be unreachable
  // dead configuration.
  const rust = rustKinds();
  for (const expected of [
    "pdf",
    "docx",
    "sheet",
    "csv",
    "slides",
    "book",
    "archive",
    "markdown",
    "html",
    "svg",
    "notebook",
    "json",
    "subtitle",
    "email",
    "prose",
    "log",
    "code",
    "text",
    "image",
    "audio",
    "video",
    "recording",
    "binary",
  ]) {
    assert.ok(rust.includes(expected), `formats.rs lost the "${expected}" kind`);
  }
});

/** The kinds named inside a `NAME … = new Set<ViewerKind>([…])` literal. */
function setKinds(src, name, file) {
  const m = src.match(
    new RegExp(`${name}[^=]*= new Set<ViewerKind>\\(\\[([\\s\\S]*?)\\]\\)`),
  );
  assert.ok(m, `${name} is no longer a Set literal in ${file}`);
  const kinds = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  assert.ok(kinds.length > 0, `${name} named no kinds — this parse is wrong`);
  return kinds;
}

test("the viewer-behaviour sets name only kinds the registry still has", () => {
  // Three sets decide how a format behaves once it is open — whether it fills
  // the pane, whether it gets a reading stroke, whether its words can be
  // quoted — and TypeScript checks each entry against the ViewerKind union,
  // never against FORMATS. So a kind renamed in registry.tsx and the union
  // together leaves these sets holding a name that matches nothing, and the
  // only symptom is a viewer that quietly stops filling, or stops being
  // quotable, with every suite green.
  //
  // This catches the rename direction only. Nothing here can tell that a NEW
  // kind was never considered for these sets: absence is how a kind opts out,
  // and the sets carry no record of a decision not to include one.
  const kinds = tsxKinds();
  for (const [label, list] of [
    ["FILL_HEIGHT_KINDS (ViewerPane.tsx)", setKinds(PANE, "FILL_HEIGHT_KINDS", "ViewerPane.tsx")],
    ["READER_KINDS (ReaderShell.tsx)", setKinds(SHELL, "READER_KINDS", "ReaderShell.tsx")],
    ["QUOTABLE_KINDS (quoteSelection.ts)", setKinds(QUOTE, "QUOTABLE_KINDS", "quoteSelection.ts")],
  ]) {
    const stale = list.filter((k) => !kinds.includes(k));
    assert.deepEqual(
      stale,
      [],
      `${label} still names ${stale.join(", ")}, which registry.tsx no longer has`,
    );
  }
});

/** The extensions `set_cell_in_bytes` can actually WRITE, read out of the match
 * arms in the Rust source rather than restated here. */
function writableSheetExts() {
  const start = SPREADSHEET.indexOf("pub(crate) fn set_cell_in_bytes");
  assert.ok(start >= 0, "set_cell_in_bytes not found in spreadsheet.rs");
  const body = SPREADSHEET.slice(start, SPREADSHEET.indexOf("\n}\n", start));
  const exts = new Set();
  for (const m of body.matchAll(/^\s+("[a-z]+"(?:\s*\|\s*"[a-z]+")*)\s*=>/gm)) {
    for (const lit of m[1].matchAll(/"([a-z]+)"/g)) exts.add(lit[1]);
  }
  return exts;
}

/** The extensions the Rust table routes to the `sheet` viewer. */
function sheetExts() {
  const m = RUST.match(/Row \{ exts: &\[([^\]]*)\], kind: "sheet"/);
  assert.ok(m, 'the "sheet" row is no longer in formats.rs');
  return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
}

/** Does registry.tsx keep this workbook out of the editable grid? Its guard is
 * a list of regex literals, so run the real ones against a real name. */
function refusedByRegistry(name) {
  const start = TSX.indexOf("const readOnlySheetReason");
  assert.ok(start >= 0, "registry.tsx has no readOnlySheetReason guard any more");
  const body = TSX.slice(start, TSX.indexOf("\n};", start));
  const patterns = [...body.matchAll(/\/(\\\.[^/]+)\/i/g)].map(
    (m) => new RegExp(m[1], "i"),
  );
  assert.ok(patterns.length > 0, "the guard no longer tests any extension");
  return patterns.some((re) => re.test(name));
}

test("only workbooks the cell writer can write are offered the editable grid", () => {
  // The grid's Edit button and `set_cell_in_bytes` are two tables that have to
  // agree. When they didn't, an .ods got a live grid that painted every change
  // and raised a changed-cell receipt while the backend refused every write.
  const writable = writableSheetExts();
  assert.ok(writable.has("xlsx"), "set_cell_in_bytes no longer writes .xlsx");
  for (const ext of sheetExts()) {
    const name = `book.${ext}`;
    if (writable.has(ext)) {
      assert.ok(
        !refusedByRegistry(name),
        `${name} can be written, but registry.tsx marks it read-only`,
      );
    } else {
      assert.ok(
        refusedByRegistry(name),
        `${name} is offered the editable grid, but set_cell_in_bytes refuses every write to it`,
      );
    }
  }
});

test("no format row carries a byte ceiling it is not allowed to have", () => {
  // Streaming exists to remove the 50 MB cliff. A streamed row with a
  // max_bytes would quietly reinstate it, and the Rust test that guards this
  // only runs under cargo — this is the fast check.
  for (const m of RUST.matchAll(/Row \{[^}]*\}/g)) {
    const row = m[0];
    if (!row.includes("delivery: Stream")) continue;
    assert.ok(
      /max_bytes:\s*Option::None/.test(row),
      `a streamed row still has a size ceiling: ${row}`,
    );
  }
});
