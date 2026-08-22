// BROWSE-1: where the agent's page script lives.
//
// The Node analogue of Rust's `include_str!("browser/page.js")` — and, unlike
// it, a real file path as well as a string, because Electron's preload
// registration takes an absolute PATH, not a source blob.
//
// Kept as a sibling `.js` resource read at call time, the same way
// db-host/open.ts's `schemaSql()` reads `schema.sql` — this workspace's
// established convention for a non-TypeScript asset that belongs next to the
// module that owns it. Named `page.js` (matching the Rust file) rather than
// `pageScript.js`, which is this module's own compiled-output name: a real
// same-named `.js` beside a `.ts` is a module-resolution collision waiting to
// happen.
//
// PACKAGING NOTE, the same one `schema.sql` carries: `import.meta.url` resolves
// beside the module at runtime, so whatever eventually packages this app must
// copy `page.js` next to the built `pageScript.js`, exactly as it must copy
// `schema.sql`.

// A PATH is all this module exports, deliberately. Electron loads the preload
// from disk itself, and a live probe confirmed it lands in every frame before
// the page's own first script — so nothing here needs the SOURCE at runtime,
// and an exported `pageScriptSource()` with no production caller would be an
// injection backstop for a race that does not exist. Tests that want the text
// read this path themselves.

import { fileURLToPath } from "node:url";
import path from "node:path";

/** Absolute path to the page script, for
 *  `session.registerPreloadScript({ filePath })`. */
export const PAGE_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "page.js",
);
