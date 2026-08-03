/* The agent diagram's roster model — what a turn's nodes are, live and after.
 *
 * Runs under `npm run test:page` (node --test) next to the address-bar tests,
 * and exercises the REAL `src/workspace/agentNodes.ts`: the source is
 * type-stripped with the `typescript` dev dependency and imported from memory,
 * so there is no compiled output to keep in sync. (AgentGraph.tsx itself
 * imports React, which plain Node cannot resolve — that is why the rules worth
 * pinning live in their own module.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "../../src/workspace/agentNodes.ts"),
  "utf8",
);
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { toNodes, toBands, chipClass, MAIN_KEY } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

/** The shape the sidecar emits at the END of a delegated turn: every child
 *  terminal, and the hub re-marked active because it resumed to compose the
 *  answer. No terminal "everything is done" roster ever follows it. */
const finishedDelegatedTurn = [
  {
    agent: "files.read",
    label: "Files",
    instruction: "find the contract",
    status: "done",
    batch: 0,
    key: "files.read#0",
  },
  {
    agent: "chat.web",
    label: "Web",
    instruction: "check the filing date",
    status: "done",
    batch: 0,
    key: "chat.web#1",
  },
  {
    agent: "chat.answer",
    label: "Main agent",
    instruction: "answer the user from the specialists' reports",
    status: "running",
    batch: null,
    key: MAIN_KEY,
  },
];

test("a live turn draws the roster exactly as sent", () => {
  const nodes = toNodes(finishedDelegatedTurn, null, true);
  assert.deepEqual(
    nodes.map((n) => n.status),
    ["done", "done", "running"],
  );
});

test("an archived turn never leaves the Main agent spinning", () => {
  // The bug: `live={false}` only stopped the clock, so every finished
  // delegated answer kept a perpetually animating hub next to a header that
  // already said "2/2 done".
  const nodes = toNodes(finishedDelegatedTurn, null, false);
  assert.equal(nodes[nodes.length - 1].status, "done");
  assert.equal(
    nodes.some((n) => n.status === "running"),
    false,
  );
});

test("an archived child caught mid-flight did not finish, and does not claim to", () => {
  // Stop pressed while a child was still working: the sidecar marks that child
  // failed but the run is torn down before it can emit, so the last snapshot
  // the UI holds still says "running". Calling that "done" would claim a
  // report that was never made.
  const stopped = [
    { ...finishedDelegatedTurn[0], status: "running" },
    finishedDelegatedTurn[1],
    finishedDelegatedTurn[2],
  ];
  const nodes = toNodes(stopped, null, false);
  assert.equal(nodes[0].status, "failed");
  assert.equal(nodes[2].status, "done");
});

test("pending and failed survive the archive untouched", () => {
  const roster = [
    { ...finishedDelegatedTurn[0], status: "failed" },
    { ...finishedDelegatedTurn[1], status: "pending" },
    finishedDelegatedTurn[2],
  ];
  const nodes = toNodes(roster, null, false);
  assert.deepEqual(
    nodes.map((n) => n.status),
    ["failed", "pending", "done"],
  );
});

test("a roster with no statuses still reads truthfully from the active marker", () => {
  // A frontend newer than the bundled sidecar gets no per-entry status.
  const bare = finishedDelegatedTurn.map(({ status: _s, ...rest }) => rest);
  const nodes = toNodes(bare, { step: 2, active_steps: [2] }, true);
  assert.deepEqual(
    nodes.map((n) => n.status),
    ["done", "running", "pending"],
  );
});

test("keys fall back to agent#index, and the hub is always MAIN_KEY", () => {
  const bare = finishedDelegatedTurn.map(({ key: _k, ...rest }) => rest);
  assert.deepEqual(
    toNodes(bare, null, true).map((n) => n.key),
    ["files.read#0", "chat.web#1", MAIN_KEY],
  );
});

test("consecutive children sharing a batch band together", () => {
  const children = toNodes(finishedDelegatedTurn, null, true).slice(0, -1);
  assert.deepEqual(toBands(children).map((b) => b.length), [2]);
  const twoRounds = toBands([
    { ...children[0], batch: 0 },
    { ...children[1], batch: 1 },
  ]);
  assert.deepEqual(twoRounds.map((b) => b.length), [1, 1]);
});

/* ------------------------------------------------------------------------- */
/* the `*` tag: ONE specialist is the whole turn                              */
/* ------------------------------------------------------------------------- */

/** What the sidecar emits for a tagged turn (graph.py `_run_tagged`): a single
 *  entry in the ROOT slot, carrying a specialist rather than the Main agent. */
const taggedTurn = [
  {
    agent: "files.read",
    label: "File agent",
    instruction: "what notice does the lease need",
    status: "running",
    batch: null,
    key: MAIN_KEY,
  },
];

test("a tagged turn's root is the specialist, not a Main agent that never ran", () => {
  const nodes = toNodes(taggedTurn, null, true);
  assert.deepEqual(nodes.map((n) => n.agent), ["files.read"]);
  assert.equal(nodes[0].label, "File agent");
});

test("an archived tagged turn caught mid-run did not finish, and does not claim to", () => {
  // `settled` may only settle a still-running ROOT to "done" for the hub, whose
  // argument is "it composed the answer this diagram hangs under". A specialist
  // in the root slot has no such argument: it is a worker, and one still marked
  // running is one the turn was stopped on top of. Keyed on the position alone
  // this read "done" — a finished File agent that never came back.
  const nodes = toNodes(taggedTurn, null, false);
  assert.equal(nodes[0].status, "failed");
});

test("an archived ordinary turn still settles its hub optimistically", () => {
  // The control: the change above must not turn every replayed answer red.
  const hubOnly = [{ ...taggedTurn[0], agent: "chat.answer", label: "Main agent" }];
  assert.equal(toNodes(hubOnly, null, false)[0].status, "done");
});

test("the flat chip shows a failed one-node turn as failed", () => {
  // The flat strip is what a one-node turn draws instead of a diagram. It used
  // to map everything that was not "running" to "done", which was safe only
  // while a one-node turn always meant the Main agent — and the Main agent does
  // not fail. A tagged specialist does, and a green chip over
  // `_fallback_answer`'s "nothing usable came back" is exactly the claim the
  // four-case fallback exists to prevent.
  assert.equal(chipClass("failed"), "failed");
  assert.equal(chipClass("running"), "active");
  assert.equal(chipClass("done"), "done");
  assert.equal(chipClass(undefined), "done");
});
