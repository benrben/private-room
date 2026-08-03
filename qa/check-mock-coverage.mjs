/* Does the fake backend still match the real one?
 *
 * `qa/qa-mock.js` hand-writes the names of the Tauri commands it answers. That
 * list drifts: this app has renamed commands before (`save_page` → `browse_save`
 * is the documented one), and when a name drifts the mock keeps answering the
 * OLD name while the app calls the NEW one — the browser harness stays green
 * and only the shipped build breaks. Nothing compared the two lists until now.
 *
 *   node qa/check-mock-coverage.mjs           # summary; exits 1 on real drift
 *   node qa/check-mock-coverage.mjs --list    # also name every uncovered command
 *
 * FAILS (exit 1) on drift, which is always a genuine defect:
 *   - the frontend invokes a command the Rust host does not register
 *   - the mock fakes a command the Rust host no longer has
 * REPORTS (exit 0) the fixture gap: commands the app invokes that the mock does
 * not fake. Those return a bare `[]`/null at runtime, which is why the mock also
 * records them live on `window.__qaUnhandled`. The gap is large by design today
 * — most of it is mutations, which QA does not need faked — so it is a number to
 * watch, not a build break. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIST = process.argv.includes("--list");

/** Everything between the outermost brackets of `generate_handler![ … ]`. */
function handlerBody(src) {
  const open = src.indexOf("generate_handler![");
  if (open < 0) throw new Error("no generate_handler! in src-tauri/src/lib.rs");
  let i = open + "generate_handler![".length;
  const start = i;
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      if (depth === 0) return src.slice(start, i);
      depth--;
    }
  }
  throw new Error("unterminated generate_handler!");
}

/** The `commands` object literal in qa-mock.js, by brace matching. */
function mockBody(src) {
  const open = src.indexOf("const commands = {");
  if (open < 0) throw new Error("no `const commands = {` in qa/qa-mock.js");
  let i = open + "const commands = {".length;
  const start = i;
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      if (depth === 0) return src.slice(start, i);
      depth--;
    }
  }
  throw new Error("unterminated commands object");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

// Any `module::name` entry in the handler list, not just `commands::` — the host
// registers commands from other modules too (`obs::reveal_logs`), and hard-coding
// one module reported every one of them as frontend-side drift.
//
// Comments are stripped FIRST, and no trailing comma is required. Requiring one
// would silently drop whichever command happens to be last in the list (Rust
// does not need a trailing comma there), and that is the entry a person adding a
// command is most likely to be touching — a drift checker that goes quiet on the
// newest line is worse than none.
const rust = new Set(
  [
    ...handlerBody(fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8"))
      .replace(/\/\/[^\n]*/g, "")
      .matchAll(/(?:\w+::)+(\w+)/g),
  ].map((m) => m[1]),
);

const frontend = new Set();
for (const file of walk(path.join(root, "src"))) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) frontend.add(m[1]);
}

const mockSrc = fs.readFileSync(path.join(root, "qa/qa-mock.js"), "utf8");
const mocked = new Set(
  [...mockBody(mockSrc).matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]),
);
// `ask` and `run_command` are answered by the streaming branch of `invoke`,
// not by an entry in the table.
for (const extra of ["ask", "run_command"]) {
  if (mockSrc.includes(`cmd === "${extra}"`)) mocked.add(extra);
}

// `EXTRA_READS` in qa-mock.js is the hand-written list of loaders whose NAME
// does not start with `list_`/`get_`/… — it is what makes `?qa_state=` reach
// Home, Settings, the recording pane, Connectors and the Browser. It is a
// second hand-written command list, so it drifts the same way the fixture table
// does, and a stale name there is SILENT: the rule simply never fires and that
// pane's empty/loading/failed looks stop being captured. (The audit found
// exactly one such orphan; nothing was checking.)
const extraReads = new Set(
  [
    ...(mockSrc.match(/const EXTRA_READS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "").matchAll(
      /"([a-z0-9_]+)"/g,
    ),
  ].map((m) => m[1]),
);

const sorted = (set) => [...set].sort();
const missingInRust = sorted(frontend).filter((c) => !rust.has(c));
const staleInMock = sorted(mocked).filter((c) => !rust.has(c));
// A read-rule name must be a real command AND one the app actually calls: a
// registered-but-uncalled name is just as dead a rule as an invented one.
const staleReadRule = sorted(extraReads).filter((c) => !rust.has(c) || !frontend.has(c));
const uncovered = sorted(frontend).filter((c) => !mocked.has(c));

const pct = ((frontend.size - uncovered.length) / frontend.size) * 100;
console.log(`Rust commands registered : ${rust.size}`);
console.log(`invoked by the frontend  : ${frontend.size}`);
console.log(`faked by qa-mock.js      : ${frontend.size - uncovered.length} (${pct.toFixed(0)}%)`);
console.log(`no fixture               : ${uncovered.length}`);
if (LIST && uncovered.length) console.log(`\nNo fixture:\n  ${uncovered.join("\n  ")}`);

let failed = false;
if (missingInRust.length) {
  failed = true;
  console.error(
    `\nDRIFT — the frontend invokes ${missingInRust.length} command(s) the Rust host does not register:\n  ${missingInRust.join("\n  ")}`,
  );
}
if (staleInMock.length) {
  failed = true;
  console.error(
    `\nDRIFT — qa-mock.js fakes ${staleInMock.length} command(s) that no longer exist:\n  ${staleInMock.join("\n  ")}`,
  );
}
if (!extraReads.size) {
  failed = true;
  console.error(
    "\nDRIFT — qa-mock.js has no EXTRA_READS set any more (or it was reshaped): " +
      "`?qa_state=` silently stops reaching Home, Settings, recording, connectors and the browser.",
  );
}
if (staleReadRule.length) {
  failed = true;
  console.error(
    `\nDRIFT — qa-mock.js EXTRA_READS names ${staleReadRule.length} command(s) the app never invokes, so the rule can never fire:\n  ${staleReadRule.join("\n  ")}`,
  );
}
if (failed) process.exit(1);
console.log(
  `\nNo drift: every invoked command exists, every fixture names a real command, ` +
    `all ${extraReads.size} EXTRA_READS rules can fire.`,
);
