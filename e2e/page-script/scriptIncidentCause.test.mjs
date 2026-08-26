/* The Scripts incident card names the CAUSE, not the advice.
 *
 * `script_run.rs` writes a failure as two paragraphs: "The script failed
 * (exit N):" + the stderr tail, then — when a package could not be
 * auto-installed — a blank line and a paragraph of guidance. The card took the
 * LAST line of the whole thing, so under the title "This script failed 3 times
 * in a row — same error" the cause read "…Declare it explicitly in a
 * dependencies line, or ask the assistant to." The exception itself was only
 * in the hover tooltip.
 *
 * This renders the REAL `ScriptRow` out of the real .tsx (same type-stripping
 * trick as activityPane.test.mjs) with a failure written the way the runner
 * writes it, and asserts which paragraph landed in the cause line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../src");

/* ---------- loading real TSX under plain node (same trick as activityPane) ---------- */

const BARE = {
  react: import.meta.resolve("react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
};

const asData = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const FROM_RE = /(?:import|export)\s+([\s\S]*?)\s+from\s+"([^"]+)";/g;

function bindingsOf(clause) {
  const names = [];
  const braced = clause.match(/\{([\s\S]*)\}/);
  if (braced) {
    for (const raw of braced[1].split(",")) {
      const n = raw.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.push(n);
    }
  }
  const head = clause.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
  return { names, hasDefault: Boolean(head) };
}

function stubModule(clause) {
  const { names, hasDefault } = bindingsOf(clause);
  const body = [
    "const inert = () => null;",
    ...names.map((n) => `export const ${n} = inert;`),
    hasDefault ? "export default inert;" : "",
  ].join("\n");
  return asData(body);
}

function loadReal(absPath, stubbed, cache = new Map()) {
  const hit = cache.get(absPath);
  if (hit) return hit;
  const jsx = absPath.endsWith(".tsx");
  let js = ts.transpileModule(readFileSync(absPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;

  js = js.replace(FROM_RE, (whole, clause, spec) => {
    const swap = (url) => whole.replace(`"${spec}"`, JSON.stringify(url));
    if (BARE[spec]) return swap(BARE[spec]);
    if (spec.startsWith("@tauri-apps/")) return swap(stubModule(clause));
    if (spec.startsWith(".")) {
      const base = resolve(dirname(absPath), spec);
      const target = [".ts", ".tsx", "/index.ts"].map((ext) => base + ext).find(existsSync);
      assert.ok(target, `cannot resolve ${spec} from ${absPath}`);
      if (stubbed.has(target)) return swap(stubModule(clause));
      return swap(loadReal(target, stubbed, cache));
    }
    return swap(stubModule(clause));
  });

  // `GUIDANCE_OPENERS` is private to ScriptRow.tsx and should stay that way —
  // nothing else in the app reads the runner's wording. Re-exporting it here
  // keeps the drift check pointed at the shipped list rather than a copy.
  if (absPath.endsWith("ScriptRow.tsx")) js += "\nexport { GUIDANCE_OPENERS };\n";

  const url = asData(js);
  cache.set(absPath, url);
  return url;
}

// The row's neighbours are not what this test is about: the icon set, the
// schedule popover and the run-history panel.
const STUBS = new Set(
  ["icons.tsx", "workspace/workflows/SchedulePopover.tsx", "workspace/workflows/RunHistory.tsx"].map(
    (p) => join(SRC, p),
  ),
);
const { ScriptRow, GUIDANCE_OPENERS } = await import(
  loadReal(join(SRC, "workspace/scripts/ScriptRow.tsx"), STUBS)
);

/** Word-for-word what `script_run.rs` stores for a package it could not
 *  auto-install: the executor's header + the stderr tail, a blank line, then
 *  the guidance paragraph. */
const RUNNER_ERROR =
  "The script failed (exit 1):\n" +
  'Traceback (most recent call last):\n  File "/tmp/x/script.py", line 1, in <module>\n    import cv2\n' +
  "ModuleNotFoundError: No module named cv2\n\n" +
  "Couldn't auto-install 'cv2' — its package name on PyPI probably differs from the " +
  "import name (e.g. PIL → Pillow, cv2 → opencv-python). Declare it explicitly in a " +
  "dependencies line, or ask the assistant to.";

const SCRIPT = {
  fileId: "f1",
  name: "frames.py",
  lang: "python",
  approved: true,
  changedSinceApproval: false,
  consecutiveFailures: 3,
  lastError: RUNNER_ERROR,
  lastRun: { jobId: null, status: "error", finishedAt: null },
  workflowId: null,
  deps: [],
  inputs: [],
  outputs: [],
  shortcut: "none",
  schedule: null,
};

const render = (sc) =>
  renderToStaticMarkup(createElement(ScriptRow, { sc, s: { jobProgress: {} }, a: {} }));

/** The text inside the cause element, tags and entities removed. */
function causeText(markup) {
  const m = markup.match(/class="script-incident-cause"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(m, "no .script-incident-cause element in the rendered row");
  return m[1]
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

test("the incident cause is the exception, not the advice that follows it", () => {
  const cause = causeText(render(SCRIPT));
  assert.match(cause, /ModuleNotFoundError: No module named cv2/);
  assert.doesNotMatch(cause, /ask the assistant/);
  assert.doesNotMatch(cause, /Declare it explicitly/);
});

test("the guidance is still shown — as the recovery line under the cause", () => {
  const markup = render(SCRIPT);
  assert.match(markup, /opencv-python/, "the runner's guidance vanished from the card");
  // …and below the cause, not above it: the card reads cause-then-what-to-do.
  assert.ok(
    markup.indexOf("ModuleNotFoundError") < markup.indexOf("opencv-python"),
    "the guidance is rendered before the cause",
  );
});

test("a one-paragraph failure still shows its last stderr line", () => {
  const cause = causeText(
    render({ ...SCRIPT, lastError: "The script failed (exit 2):\nValueError: bad shape" }),
  );
  assert.equal(cause.trim(), "ValueError: bad shape");
});

/** A CHAINED traceback, exactly as CPython prints one: `raise` inside an
 *  `except` block puts a blank line either side of "During handling…", and
 *  Python does that for every re-raise. Nothing here is guidance — the whole
 *  thing is stderr, and the failure is the LAST exception. */
const CHAINED_ERROR =
  "The script failed (exit 1):\n" +
  'Traceback (most recent call last):\n  File "/tmp/x/report.py", line 3, in <module>\n    rows["date"]\n' +
  "KeyError: 'date'\n\n" +
  "During handling of the above exception, another exception occurred:\n\n" +
  'Traceback (most recent call last):\n  File "/tmp/x/report.py", line 5, in <module>\n    raise ValueError(...)\n' +
  "ValueError: the sheet has no date column";

test("a chained traceback's cause is the exception that ended the run", () => {
  const cause = causeText(render({ ...SCRIPT, lastError: CHAINED_ERROR }));
  assert.equal(cause.trim(), "ValueError: the sheet has no date column");
});

test("a chained traceback has no advice, so the card offers none", () => {
  const markup = render({ ...SCRIPT, lastError: CHAINED_ERROR });
  // The blank lines in a traceback are Python's, not the runner's: presenting
  // what follows one as a recovery line tells the user to do something nobody
  // suggested.
  assert.doesNotMatch(
    markup.replace(/title="[\s\S]*?"/g, ""),
    /During handling of the above exception/,
    "part of the traceback was rendered as the recovery line",
  );
});

test("the guidance openers are the words the runner actually writes", () => {
  const host = readFileSync(
    join(here, "../../electron-migration/electron-app/electron/main/scriptRun.ts"),
    "utf8",
  );
  assert.ok(GUIDANCE_OPENERS.length >= 2, "the openers list did not load");
  for (const opener of GUIDANCE_OPENERS) {
    assert.ok(
      host.includes(opener),
      `ScriptRow no longer recognises the runner's guidance: scriptRun.ts writes nothing starting "${opener}"`,
    );
  }
});

test("a failure with nothing but a header does not blank the cause", () => {
  const cause = causeText(render({ ...SCRIPT, lastError: "The script exited with code 3." }));
  assert.equal(cause.trim(), "The script exited with code 3.");
});
