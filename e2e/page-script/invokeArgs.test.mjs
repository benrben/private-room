/* Do the ARGUMENTS the frontend sends still match the handlers that take them?
 *
 * `qa/check-mock-coverage.mjs` compares command NAMES across the seam, and the
 * Rust side type-checks its own signature — so renaming a handler's parameter
 * (`offset` → `start_offset`) builds, type-checks and passes every suite in this
 * repo, and fails only in the user's hands, as an argument-deserialization error
 * from a screen that simply stops working. Nothing was comparing the two.
 *
 * Tauri v2 maps a camelCase key in the invoke payload onto the snake_case
 * parameter, so the check is exact once both sides are read: every key the
 * wrapper passes must be a parameter, and every parameter must be passed
 * (`State`/`Window`/`AppHandle` are injected by the framework, never sent).
 *
 * WHAT IS NOT COVERED, said out loud: wrappers that hand an already-built object
 * straight through (`invoke("start_create_job", opts)`) have no keys to read
 * here, so they are not checked — the payload's shape is only stated by its
 * TypeScript type. The counts below are asserted so that a parser that goes
 * blind fails loudly instead of passing over nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** The text between a balanced pair, `open` being the index of the opener. */
function balanced(src, open, oc, cc) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === oc) depth++;
    else if (src[i] === cc) {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Split on `sep`, ignoring separators inside brackets or generics. */
function topLevelSplit(text, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ---- what the frontend sends ------------------------------------------------

const API = fs.readFileSync(path.join(root, "src/api.ts"), "utf8");
const sent = new Map();
for (const m of API.matchAll(/invoke(?:<[^;]*?>)?\(\s*"([a-z0-9_]+)"\s*,\s*\{/g)) {
  const braceAt = API.indexOf("{", m.index + m[0].length - 1);
  const body = balanced(API, braceAt, "{", "}");
  if (body === null) continue;
  const keys = [];
  let opaque = false;
  for (const part of topLevelSplit(body, ",")) {
    const p = part.trim();
    if (!p) continue;
    // `...spread` and computed keys hide what is being sent; don't pretend to
    // have read them.
    const k = p.startsWith("...") ? null : p.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(:|$)/);
    if (k) keys.push(k[1]);
    else opaque = true;
  }
  if (!opaque) sent.set(m[1], keys);
}

// ---- what the handlers take -------------------------------------------------

function rustFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rustFiles(p, out);
    else if (e.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** Injected by Tauri, never part of the payload. */
const INJECTED = /(^|[^A-Za-z])(State|Window|AppHandle|WebviewWindow|tauri::)/;
const takes = new Map();
for (const file of rustFiles(path.join(root, "src-tauri/src"))) {
  const src = fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const decl =
    /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>(]*>)?\s*\(/g;
  for (const m of src.matchAll(decl)) {
    const paren = src.indexOf("(", m.index + m[0].length - 1);
    const body = balanced(src, paren, "(", ")");
    if (body === null) continue;
    const names = [];
    for (const part of topLevelSplit(body, ",")) {
      const p = part.trim();
      if (!p) continue;
      const at = p.indexOf(":");
      if (at < 0) continue;
      if (INJECTED.test(p.slice(at + 1))) continue;
      names.push(p.slice(0, at).trim().replace(/^mut\s+/, ""));
    }
    takes.set(m[1], { names, file: path.relative(root, file) });
  }
}

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

test("the parsers still see both sides of the seam", () => {
  // A regex that stops matching would turn every assertion below into a
  // no-op — the failure mode this whole file exists to prevent.
  assert.ok(takes.size > 250, `only ${takes.size} #[tauri::command] handlers parsed`);
  assert.ok(sent.size > 150, `only ${sent.size} invoke sites with a readable payload parsed`);
});

test("every argument api.ts sends is a parameter of the handler that receives it", () => {
  const drift = [];
  const unknown = [];
  for (const [cmd, keys] of sent) {
    const handler = takes.get(cmd);
    if (!handler) {
      unknown.push(cmd);
      continue;
    }
    const want = handler.names.map(camel);
    const missing = want.filter((w) => !keys.includes(w));
    const extra = keys.filter((k) => !want.includes(k));
    if (missing.length || extra.length) {
      drift.push(
        `${cmd} (${handler.file}): handler wants [${want}], api.ts sends [${keys}]` +
          `${missing.length ? ` — never sent: ${missing}` : ""}` +
          `${extra.length ? ` — no such parameter: ${extra}` : ""}`,
      );
    }
  }
  assert.deepEqual(
    unknown,
    [],
    "these commands are invoked with arguments but no handler signature was found — " +
      "either the command is gone, or its declaration is in a shape this check cannot read yet",
  );
  assert.deepEqual(
    drift,
    [],
    `the invoke seam has drifted:\n  ${drift.join("\n  ")}`,
  );
});
