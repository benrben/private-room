/* Every edge OUT of a condition or a route must name the outcome it follows.
 *
 * An unlabelled one is live whichever way the branch step went, so the step
 * stops choosing and every handler runs at once — and the save-time validator
 * (`validate_definition` in src-tauri/src/commands/jobs/workflow.rs) now
 * refuses to save one. Three places in the editor mint edges: the canvas's
 * "add a step after this" and "add a parallel branch", and the param sheet's
 * "Runs after (inputs)" checkboxes. The checkbox was the one that never asked,
 * so ticking a condition as an input wrote exactly the definition Save bounces,
 * with no branch control in that sheet to repair it.
 *
 * Runs under `npm run test:page` (node --test) against the REAL
 * `src/workspace/workflows/selectors.ts`, type-stripped in memory — the same
 * trick activity.test.mjs uses, because the sheet itself needs React.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "../../apps/desktop/src/renderer/workspace/workflows/selectors.ts"),
  "utf8",
);
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { branchFor, runDotClass } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

/* The param sheet's fan-in checkbox, run as the REAL function.
 *
 * A hand-written mirror of the fan-in toggle would pass forever after the sheet
 * regressed — the whole defect here was that the sheet disagreed with the rule
 * everything else followed. So the function is lifted verbatim out of
 * NodeParamSheet.tsx (which cannot simply be imported: it needs React) and run
 * with the four values it closes over injected. If someone deletes the
 * `branchFor` call from the sheet, this expression changes with it and the test
 * below fails. */
const SHEET = readFileSync(
  join(here, "../../apps/desktop/src/renderer/workspace/workflows/NodeParamSheet.tsx"),
  "utf8",
);
const SHEET_TREE = ts.createSourceFile(
  "NodeParamSheet.tsx",
  SHEET,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const FAN_IN = SHEET_TREE.statements.find(
  (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "FanInEditor",
);
assert.ok(FAN_IN, "FanInEditor is gone from NodeParamSheet.tsx");
let toggleExpression;
function findToggle(node) {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "toggle" &&
    node.initializer
  ) {
    toggleExpression = node.initializer.getText(SHEET_TREE);
    return;
  }
  ts.forEachChild(node, findToggle);
}
findToggle(FAN_IN);
assert.ok(toggleExpression, "the fan-in toggle is gone from NodeParamSheet.tsx");
const TOGGLE_SRC = ts.transpileModule(`const toggleInput = ${toggleExpression};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function toggleInput(nodes, edges, fromId, toId) {
  let written = edges;
  const make = new Function(
    "branchFor",
    "edges",
    "node",
    "allNodes",
    "onEdgesChange",
    `${TOGGLE_SRC}; return toggleInput;`,
  );
  make(branchFor, edges, { id: toId }, nodes, (next) => {
    written = next;
  })(fromId);
  return written;
}

test("a new edge off a condition names its outcome, and fills then before else", () => {
  const cond = { id: "c", kind: "condition", op: "not_empty" };
  assert.equal(branchFor(cond, []), "then");
  assert.equal(branchFor(cond, [{ from: "c", to: "a", branch: "then" }]), "else");
  // Both taken: reuse rather than mint an unlabelled one — the user retargets it.
  assert.equal(
    branchFor(cond, [
      { from: "c", to: "a", branch: "then" },
      { from: "c", to: "b", branch: "else" },
    ]),
    "then",
  );
});

test("a route's own labels are its outcomes; blanks are not offered", () => {
  const route = { id: "r", kind: "route", labels: ["bug", " ", "feature"] };
  assert.equal(branchFor(route, []), "bug");
  assert.equal(branchFor(route, [{ from: "r", to: "x", branch: "bug" }]), "feature");
  // A route with no usable labels has no outcome to name yet.
  assert.equal(branchFor({ id: "r", kind: "route", labels: [] }, []), undefined);
});

test("an ordinary step's edges stay unlabelled", () => {
  assert.equal(branchFor({ id: "g", kind: "generate" }, []), undefined);
  assert.equal(branchFor(undefined, []), undefined);
});

test('"Runs after" on a condition writes a labelled edge, not one the validator bounces', () => {
  const nodes = [
    { id: "c", kind: "condition", op: "not_empty" },
    { id: "save", kind: "save_file" },
  ];
  // The real body must still consult the shared helper — a bare `{from, to}`
  // push is exactly the edge Save bounces.
  assert.match(TOGGLE_SRC, /branchFor\(/, "the sheet no longer asks for a branch label");
  const after = toggleInput(nodes, [], "c", "save");
  assert.deepEqual(after, [{ from: "c", to: "save", branch: "then" }]);
  // The sheet then shows that checkbox ticked and DISABLED ("via branch"), so
  // the branch editor on the condition owns the edge from here on — which is
  // the same predicate the sheet renders from.
  const viaBranch = after.some((e) => e.from === "c" && e.to === "save" && e.branch != null);
  assert.equal(viaBranch, true);
});

test('"Runs after" on a plain step still writes a plain edge', () => {
  const nodes = [
    { id: "gen", kind: "generate" },
    { id: "save", kind: "save_file" },
  ];
  const after = toggleInput(nodes, [], "gen", "save");
  assert.deepEqual(after, [{ from: "gen", to: "save" }]);
  assert.deepEqual(toggleInput(nodes, after, "gen", "save"), []);
});

test("a parked run is not dressed as a finished one", () => {
  // Stop (or quitting mid-run) parks a run. It reads "paused" rather than the
  // old permanent "running" — but it wore the same green dot as a completed
  // run, which is success styling for work that did not happen.
  assert.equal(runDotClass("done"), "dot-ok");
  assert.equal(runDotClass("error"), "dot-err");
  assert.equal(runDotClass("failed"), "dot-err");
  assert.notEqual(runDotClass("paused"), "dot-ok");
  assert.equal(runDotClass("paused"), "dot-run");
  assert.equal(runDotClass("running"), "dot-run");
  // An unknown status is not a success either. The library card's own status
  // map ended in `?? ["dot-ok", …]`, which made green the DEFAULT for
  // everything it didn't list — paused and queued both included.
  assert.notEqual(runDotClass("queued"), "dot-ok");
  assert.notEqual(runDotClass("something-new"), "dot-ok");
});

test("both places that dot a run status use the one helper", () => {
  // Live QA 2026-08-03 fixed the run-history row and left the LIBRARY CARD
  // wearing the old green dot for a parked run — the same "we fixed the two we
  // were told about" miss this repo has hit before. Neither file may carry its
  // own status→colour table again.
  for (const f of ["RunHistory.tsx", "WorkflowLibrary.tsx"]) {
    const src = readFileSync(join(here, "../../apps/desktop/src/renderer/workspace/workflows/", f), "utf8");
    assert.match(src, /runDotClass\(/, `${f} no longer colours a run through the helper`);
    // The tell-tale of a private copy: a dot class chosen from a RUN's status.
    // (`r.status` / `run.status` — a step badge keyed off `step.skipped` is a
    // different thing and stays local.)
    assert.doesNotMatch(
      src,
      /\b(r|run)\.status\b[^\n]*"dot-|"dot-[^\n]*\b(r|run)\.status\b/,
      `${f} has grown its own run-status colour table again`,
    );
  }
});
