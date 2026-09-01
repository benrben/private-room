// BROWSE-1: where the agent's page script lives.
//
// The Node analogue of Rust's `include_str!("browser/page.js")` — and, unlike
// it, a real file path as well as a string, because Electron's preload
// registration takes an absolute PATH, not a source blob.
//
// Kept as a sibling `.js` resource read at call time, the same way
// db-host/open.ts's `schemaSql()` reads `schema.sql` — this workspace's
// established convention for a non-TypeScript asset that belongs next to the
// module that owns it. The final fragment stays named `page.js` (matching the
// Rust file); cohesive sibling fragments carry `page*.js` names so none can
// collide with this module's compiled `pageScript.js` output.
//
// PACKAGING NOTE, the same one `schema.sql` carries: `import.meta.url` resolves
// beside the module at runtime, so whatever eventually packages this app must
// copy every `page*.js` fragment next to the built `pageScript.js`, exactly as
// it must copy `schema.sql`.

// Paths are all this module exports, deliberately. Electron loads each preload
// fragment from disk itself, and a live probe confirmed registered preloads land
// in every frame before the page's own first script. Nothing here needs source
// text at runtime; tests that inspect the text read these paths themselves.

import { fileURLToPath } from "node:url";
import path from "node:path";

export const PAGE_SCRIPT_FILES = [
  "pageCore.js",
  "pageSnapshot.js",
  "pageRead.js",
  "pageActions.js",
  "page.js",
] as const;

/** Absolute paths in their required synchronous registration order. */
export const PAGE_SCRIPT_PATHS = PAGE_SCRIPT_FILES.map((file) => path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  file,
));

/** Final bridge-export fragment, retained for diagnostics and compatibility. */
export const PAGE_SCRIPT_PATH = PAGE_SCRIPT_PATHS.at(-1)!;
