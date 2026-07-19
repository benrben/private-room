// Generates dist/qa.html — the built app with the Tauri IPC mock injected
// BEFORE the bundle, for browser-based visual QA. Run after `npm run build`:
//   node qa/make-qa.mjs && npx vite preview
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
fs.copyFileSync(path.join(root, "qa", "qa-mock.js"), path.join(dist, "qa-mock.js"));
const out = html.replace(
  /<script type="module"/,
  '<script src="/qa-mock.js"></script>\n    <script type="module"',
);
fs.writeFileSync(path.join(dist, "qa.html"), out);
console.log("wrote dist/qa.html");
