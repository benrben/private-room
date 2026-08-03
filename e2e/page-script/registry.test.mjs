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
