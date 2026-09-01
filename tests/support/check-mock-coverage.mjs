/* Does the fake backend still match the real one?
 *
 * `tests/support/qa-mock.js` hand-writes the names of the Tauri commands it answers. That
 * list drifts: this app has renamed commands before (`save_page` → `browse_save`
 * is the documented one), and when a name drifts the mock keeps answering the
 * OLD name while the app calls the NEW one — the browser harness stays green
 * and only the shipped build breaks. Nothing compared the two lists until now.
 *
 *   node tests/support/check-mock-coverage.mjs           # summary; exits 1 on real drift
 *   node tests/support/check-mock-coverage.mjs --list    # also name every uncovered command
 *   node tests/support/check-mock-coverage.mjs --bridge=electron   # the same fixture table,
 *                                             # measured against the Electron
 *                                             # migration's own command contract
 *
 * TWO BRIDGES, ONE FIXTURE TABLE. `tests/support/qa-mock.js` now installs both
 * `window.__TAURI_INTERNALS__` and the Electron preload's `window.arcelle`,
 * and answers a command through the same `commands` table either way. So this
 * checker asks the same question of two different "what the host registers"
 * lists: `src-tauri/src/lib.rs`'s `generate_handler!` (the default), and
 * `apps/desktop/src/shared/ipc-contract.ts`'s `Commands` facade and the domain
 * interfaces it extends (`--bridge=electron`). What it must NEVER do is invent
 * a third list of its own.
 *
 * FAILS (exit 1) on drift, which is always a genuine defect:
 *   - the frontend invokes a command the Rust host does not register
 *   - the mock fakes a command the Rust host no longer has
 *   - the host registers a command NOTHING reaches: no caller in src/, no
 *     mention in the agent's tool catalog, and not on the written allow-list
 *     below. This is the direction nothing checked, which is how a feature can
 *     be deleted from the UI while its wrapper, its handler and all their tests
 *     stay green — see KNOWN_ORPHANS.
 * REPORTS (exit 0) the fixture gap: commands the app invokes that the mock does
 * not fake. Those return a bare `[]`/null at runtime, which is why the mock also
 * records them live on `window.__qaUnhandled`. It is reported in two figures,
 * because the two halves are not worth the same: an unfaked MUTATION is a
 * control the harness never presses, which is the gap this repo accepts; an
 * unfaked READ is a pane drawing from nothing while looking perfectly healthy,
 * which is the only half that can turn a screen check green on an empty screen.
 * Neither is a build break yet — the read list is short but not empty, and a
 * gate that is red the day it lands is a gate someone switches off. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo, unless a test points this at a fixture tree. A drift checker that
// has no way to be run against a KNOWN-drifting tree cannot be proven to still
// fire, and this one is now a build gate — see tests/contract/mockCoverage.test.mjs.
const root = process.env.MOCK_COVERAGE_ROOT
  ? path.resolve(process.env.MOCK_COVERAGE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIST = process.argv.includes("--list");

// Which bridge's command list to measure qa-mock.js's fixture table against.
// The default, "tauri", is everything below this block, byte-for-byte as it
// was before the flag existed: a caller that passes no `--bridge` — the build
// gate, tests/contract/mock-coverage.test.mjs, every existing habit — sees
// identical output and the identical exit code.
const BRIDGE = (process.argv.find((a) => a.startsWith("--bridge=")) ?? "--bridge=tauri").slice(
  "--bridge=".length,
);
if (BRIDGE !== "tauri" && BRIDGE !== "electron") {
  console.error(`Unknown --bridge=${BRIDGE} (expected "tauri" or "electron")`);
  process.exit(1);
}

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
  if (open < 0) throw new Error("no `const commands = {` in tests/support/qa-mock.js");
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

/** One exported interface body, by the same brace matching
 * `handlerBody`/`mockBody` use. The opening brace may follow an `extends`
 * clause, as it does in the split Electron command-contract facade. */
function interfaceBody(src, interfaceName, sourceName) {
  const declaration = src.indexOf(`export interface ${interfaceName}`);
  if (declaration < 0) {
    throw new Error(`no \`export interface ${interfaceName}\` in ${sourceName}`);
  }
  const open = src.indexOf("{", declaration);
  if (open < 0) throw new Error(`no opening brace for ${interfaceName} in ${sourceName}`);
  let i = open + 1;
  const start = i;
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      if (depth === 0) return src.slice(start, i);
      depth--;
    }
  }
  throw new Error(`unterminated ${interfaceName} interface in ${sourceName}`);
}

/** Resolve `Commands` through the facade's actual `extends` imports. This
 * keeps ipc-contract.ts authoritative without copying its domain list here. */
function electronCommands(contract) {
  const contractSrc = fs.readFileSync(contract, "utf8");
  const sourceName = path.relative(root, contract);
  const declaration = contractSrc.match(
    /export\s+interface\s+Commands(?:\s+extends\s+([^{]+))?\s*\{/,
  );
  if (!declaration) throw new Error(`no \`export interface Commands\` in ${sourceName}`);

  const imports = new Map();
  for (const match of contractSrc.matchAll(
    /import\s+type\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\s+from\s+["']([^"']+)["']/g,
  )) {
    imports.set(match[1], match[2]);
  }

  const commandBodies = [interfaceBody(contractSrc, "Commands", sourceName)];
  const parents = (declaration[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const parent of parents) {
    const specifier = imports.get(parent);
    if (!specifier) {
      throw new Error(`${sourceName} extends ${parent}, but does not import that interface`);
    }
    const sourcePath = path.resolve(
      path.dirname(contract),
      specifier.replace(/\.js$/, ".ts"),
    );
    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `${sourceName} imports ${parent} from missing ${path.relative(root, sourcePath)}`,
      );
    }
    const parentSourceName = path.relative(root, sourcePath);
    commandBodies.push(
      interfaceBody(fs.readFileSync(sourcePath, "utf8"), parent, parentSourceName),
    );
  }

  return new Set(
    commandBodies.flatMap((body) =>
      [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((match) => match[1]),
    ),
  );
}

/** Every command name qa-mock.js answers, however it was reached. Shared by
 * both bridges because the mock shares it: `commands` and the `ask` streaming
 * branch both sit behind qa-mock.js's one `dispatchCommand`, which is what
 * `window.__TAURI_INTERNALS__.invoke` AND `window.arcelle.invoke` call. If a
 * future change gives either bridge its own fixture table, this function is
 * the place that has to learn about it — and the figures below would be the
 * first thing to go quietly wrong if it did not. */
function mockedCommands(mockSrc) {
  const mocked = new Set(
    [...mockBody(mockSrc).matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]),
  );
  // `ask` and `run_command` are answered by the streaming branch, not by an
  // entry in the table.
  for (const extra of ["ask", "run_command"]) {
    if (mockSrc.includes(`cmd === "${extra}"`)) mocked.add(extra);
  }
  return mocked;
}

// Loaders whose NAME does not say so, so the fixture report can separate the
// half that fakes a screen full of content from the half that only skips a
// button. Hand-written for the same reason EXTRA_READS is, and silent in the
// same way when it rots: a loader added to the app and not added here counts as
// a mutation, which makes the read figure look better than it is.
const READ_LIKE = new Set([
  "office_html",
  "slide_preview",
  "stage_preview_html",
  "mcp_runtime_for_command",
  "suggest_file_meta",
]);
const isRead = (c) => /^(list|get|read|load|fetch)_/.test(c) || READ_LIKE.has(c);

/* ============================================================================
 * --bridge=electron
 * ============================================================================
 * `src/shared/ipc-contract.ts`'s `Commands` facade is the migration's
 * authoritative renderer/host command list. Runtime registration completeness
 * is enforced by the Electron registry tests; this report answers the separate
 * QA question: which commands does qa-mock.js have a fixture for?
 *
 * Report-only, exit 0, deliberately. The Tauri DRIFT checks below compare two
 * lists that are written down INDEPENDENTLY (Rust's `generate_handler!` and
 * the frontend's invoke calls), which is what makes a mismatch mean something.
 * The renderer now calls this bridge in production. Missing fixtures remain
 * informational because not every command needs a visual QA state; registry
 * and allowlist tests provide the hard command-drift gates.
 *
 * Runs BEFORE the Tauri-only file reads below on purpose: it must keep working
 * in a tree where `src-tauri/` has been deleted, which is where the migration
 * is going. */
function electronReport() {
  const contract = path.join(root, "apps/desktop/src/shared/ipc-contract.ts");
  if (!fs.existsSync(contract)) {
    console.error(
      `--bridge=electron needs the Electron command contract, and\n  ${path.relative(root, contract)}\n` +
        "does not exist under this root. This checker never invents command names to compare " +
        "against — run it against a tree containing apps/desktop.",
    );
    process.exit(1);
  }
  const registered = electronCommands(contract);
  const mocked = mockedCommands(fs.readFileSync(path.join(root, "tests/support/qa-mock.js"), "utf8"));
  const sorted = (set) => [...set].sort();
  const uncovered = sorted(registered).filter((c) => !mocked.has(c));
  const uncoveredReads = uncovered.filter(isRead);
  const uncoveredWrites = uncovered.filter((c) => !isRead(c));
  // NOT drift: a name qa-mock.js fakes that the contract lacks is still a real
  // command on the Tauri side, answered by the same shared table. Said out
  // loud under --list only, so the two bridges' figures stay legible together.
  const notInContract = sorted(mocked).filter((c) => !registered.has(c));

  const pct = registered.size ? ((registered.size - uncovered.length) / registered.size) * 100 : 100;
  console.log(`ipc-contract.ts commands : ${registered.size}`);
  console.log(`faked by qa-mock.js      : ${registered.size - uncovered.length} (${pct.toFixed(0)}%)`);
  console.log(`no fixture, reads        : ${uncoveredReads.length}`);
  console.log(`no fixture, mutations    : ${uncoveredWrites.length}`);
  if (uncoveredReads.length) {
    console.log(
      `\nReads with no fixture (the pane draws from nothing):\n  ${uncoveredReads.join("\n  ")}`,
    );
  }
  if (LIST && uncoveredWrites.length) {
    console.log(`\nMutations with no fixture:\n  ${uncoveredWrites.join("\n  ")}`);
  }
  if (LIST && notInContract.length) {
    console.log(
      `\nFaked here, not in ipc-contract.ts's Commands (not drift — see the note ` +
        `above):\n  ${notInContract.join("\n  ")}`,
    );
  }
  console.log(
    "\nElectron QA fixture coverage is informational; registry and allowlist tests enforce command drift.",
  );
}

if (BRIDGE === "electron") {
  electronReport();
  process.exit(0);
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

// Bridge-agnostic by construction, not by luck: there is no `^` or word
// boundary before "invoke(", so this matches today's bare `invoke("cmd")`
// (@tauri-apps/api/core, imported by src/api.ts) and an eventual
// `arcelle.invoke("cmd", …)` identically, as a substring. Do not "fix" it into
// something anchored: src/ calls the Tauri surface exclusively today, so an
// anchor that excluded the Electron form would go unnoticed until the day this
// file is finally wrong.
const rendererRoot = path.join(root, "apps/desktop/src/renderer");
const rendererApi = path.join(rendererRoot, "api.ts");
const frontend = new Set();
for (const file of walk(rendererRoot)) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) frontend.add(m[1]);
}

const mockSrc = fs.readFileSync(path.join(root, "tests/support/qa-mock.js"), "utf8");
// The same reading `--bridge=electron` uses: one fixture table, both bridges.
// The `plugin:*` commands qa-mock.js now fakes (dialog, window, opener,
// updater, process, app) are correctly invisible here on either side — they
// are the Tauri framework's own wire protocol, never in `generate_handler!`
// and never in ipc-contract.ts, so there is no coverage question to ask.
const mocked = mockedCommands(mockSrc);

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

// Registered commands nothing in the app reaches TODAY, each with the reason it
// is tolerated. Every one of them was found by the 2026-08-16 audit, and the
// honest reason is the same for all of them: the command, its wrapper and its
// handler are alive and tested, and no screen calls them. A wrapper whose UI was
// never built reads exactly like one whose UI was deleted, so this list records
// the fact and nothing more — it is not a verdict that any of them should stay.
const KNOWN_ORPHANS = {
  browser_close: "the browser UI closes tabs (browser_close_tab); nothing closes the browser itself",
  engine_capabilities: "wrapper engineCapabilities; qa-mock fakes it, no screen asks",
  get_script_manifest: "no wrapper in api.ts",
  get_workflow: "no wrapper in api.ts (get_workflow_schedule / get_workflow_runs are separate commands)",
  import_youtube_video: "no wrapper in api.ts",
  rec_chapter_set: "wrapper recChapterSet; no caller renames a chapter",
  rec_note_set: "wrapper recNoteSet; no caller edits a note",
  restore_memory: "no wrapper in api.ts; forgetting a memory has no undo on screen",
  story_delete_list: "wrapper storyDeleteList; no caller deletes a shot list",
  story_reorder_shots: "wrapper storyReorderShots; no caller reorders shots",
  transcribe_audio: "no wrapper in api.ts; the recorder streams instead",
};

/** Every command name quoted in the agent's own tool surface. A command the
 * assistant calls is live even though no screen invokes it — that is a caller,
 * just not a React one. */
const agentSide = ["src-tauri/src/room_mcp.rs", "src-tauri/src/commands/agent.rs"]
  .map((p) => fs.readFileSync(path.join(root, p), "utf8"))
  .join("\n");

// api.ts wraps nearly every command, so "is it invoked from src/" is answered
// INSIDE api.ts even for a command whose last real caller was deleted. Attribute
// each invoke to the declaration it sits under — `export const x = () =>` or an
// `x:` member — so the question can be asked of the wrapper instead.
//
// A member only counts as a wrapper if what follows the colon OPENS A FUNCTION.
// Half these wrappers take a multi-line options object, so `name:` alone also
// matched its LAST PARAMETER FIELD — `startStudioJob` was read as `kind`,
// `recStart` as `systemAudio` — and since a word like `kind` or `enabled` is
// everywhere in src/, those 21 commands were reachable no matter what called
// them. The gate was silently blind for exactly the commands with the biggest
// argument lists.
const wrapperOf = new Map();
{
  const apiSrc = fs.readFileSync(rendererApi, "utf8");
  const decls = [
    ...apiSrc.matchAll(
      /export\s+(?:const|function)\s+(\w+)|^[ \t]*(\w+)\s*:\s*(?:async\s*)?(?:\(|function\b|<)/gm,
    ),
  ].map((m) => ({ at: m.index, name: m[1] ?? m[2] }));
  for (const m of apiSrc.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) {
    let name = null;
    for (const d of decls) {
      if (d.at > m.index) break;
      name = d.name;
    }
    if (name && !wrapperOf.has(m[1])) wrapperOf.set(m[1], name);
  }
}

// What the rest of the app says, with comments removed: a wrapper named only in
// prose is not a caller, and this checker's whole point is that a name surviving
// somewhere is not the same as a feature surviving.
const outsideApi = walk(rendererRoot)
  .filter((f) => f !== rendererApi)
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ");

const reachable = new Set();
for (const m of outsideApi.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) reachable.add(m[1]);
for (const [command, wrapper] of wrapperOf) {
  if (new RegExp(`\\b${wrapper}\\b`).test(outsideApi)) reachable.add(command);
}

const orphans = [...rust]
  .filter((c) => !reachable.has(c) && !agentSide.includes(`"${c}"`))
  .sort();
const newOrphans = orphans.filter((c) => !(c in KNOWN_ORPHANS));
const healedOrphans = Object.keys(KNOWN_ORPHANS)
  .filter((c) => !orphans.includes(c))
  .sort();

const sorted = (set) => [...set].sort();
const missingInRust = sorted(frontend).filter((c) => !rust.has(c));
const staleInMock = sorted(mocked).filter((c) => !rust.has(c));
// A read-rule name must be a real command AND one the app actually calls: a
// registered-but-uncalled name is just as dead a rule as an invented one.
const staleReadRule = sorted(extraReads).filter((c) => !rust.has(c) || !frontend.has(c));
const uncovered = sorted(frontend).filter((c) => !mocked.has(c));
const uncoveredReads = uncovered.filter(isRead);
const uncoveredWrites = uncovered.filter((c) => !isRead(c));

const pct = ((frontend.size - uncovered.length) / frontend.size) * 100;
console.log(`Rust commands registered : ${rust.size}`);
console.log(`invoked by the frontend  : ${frontend.size}`);
console.log(`faked by qa-mock.js      : ${frontend.size - uncovered.length} (${pct.toFixed(0)}%)`);
console.log(`no fixture, reads        : ${uncoveredReads.length}`);
console.log(`no fixture, mutations    : ${uncoveredWrites.length}`);
console.log(`reached by nothing       : ${orphans.length} (allow-listed: ${orphans.length - newOrphans.length})`);
// Reads are named without --list. There are few enough to act on, and a figure
// nobody can act on is how this number went decorative in the first place.
if (uncoveredReads.length) {
  console.log(
    `\nReads with no fixture (the pane draws from nothing):\n  ${uncoveredReads.join("\n  ")}`,
  );
}
if (LIST && uncoveredWrites.length) {
  console.log(`\nMutations with no fixture:\n  ${uncoveredWrites.join("\n  ")}`);
}
if (LIST && orphans.length) {
  console.log(
    `\nReached by nothing:\n  ${orphans
      .map((c) => `${c} — ${KNOWN_ORPHANS[c] ?? "NOT allow-listed"}`)
      .join("\n  ")}`,
  );
}

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
if (newOrphans.length) {
  failed = true;
  console.error(
    `\nDRIFT — the host registers ${newOrphans.length} command(s) nothing reaches: no caller ` +
      `outside src/api.ts, no mention in the agent's tools, not on KNOWN_ORPHANS:\n  ${newOrphans.join("\n  ")}\n` +
      `Either wire it up, delete it, or add it to KNOWN_ORPHANS in this file with the reason.`,
  );
}
// Not a failure: an allow-listed name that has been wired up, or taken out of
// the host altogether, is the debt being paid. It still has to be said, or the
// list rots into cover for the next orphan.
if (healedOrphans.length) {
  console.log(
    `\nKNOWN_ORPHANS is stale — ${healedOrphans.length} entr(y/ies) are no longer orphans ` +
      `(reached again, or no longer registered); drop them from the list:\n  ${healedOrphans.join("\n  ")}`,
  );
}
if (failed) process.exit(1);
console.log(
  `\nNo drift: every invoked command exists, every fixture names a real command, ` +
    `all ${extraReads.size} EXTRA_READS rules can fire, and the ${orphans.length} command(s) ` +
    `nothing reaches are all written down.`,
);
