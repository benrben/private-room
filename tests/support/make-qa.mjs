// Generates apps/desktop/dist/qa.html — the built app with the bridge mock injected
// BEFORE the bundle, for browser-based visual QA. Run after `npm run build`:
//   node tests/support/make-qa.mjs && npm run preview
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "apps", "desktop", "dist");
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
fs.copyFileSync(path.join(root, "tests", "support", "qa-mock.js"), path.join(dist, "qa-mock.js"));
const out = html.replace(
  /<script type="module"/,
  '<script src="/qa-mock.js"></script>\n    <script type="module"',
);
fs.writeFileSync(path.join(dist, "qa.html"), out);
console.log("wrote dist/qa.html");
