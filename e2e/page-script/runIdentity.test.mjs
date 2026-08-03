/* Run/chat identity — whose events a conversation is allowed to paint.
 *
 * Owner replacement #4 (2026-08-03). These pin the two live-QA symptoms that
 * shared one cause — an answer streaming into the wrong conversation, and a
 * brand-new chat showing 30,034 tokens — against the REAL
 * `src/workspace/runIdentity.ts`. It is type-stripped with the `typescript`
 * dev dependency and imported from memory, the same trick agentNodes and
 * address use, because state.ts imports React and plain Node cannot load it.
 *
 * Every assertion below FAILS on the pre-fix code by construction: there was no
 * per-chat map at all, so "chat A's delta while chat B is on screen" had
 * exactly one place to land.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "../../src/workspace/runIdentity.ts"),
  "utf8",
);
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  startRun,
  finishRun,
  applyEvent,
  liveTurn,
  isAsking,
  runIdOf,
  ownerOf,
  usageOf,
  NO_LIVE_TURN,
} = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

/** The delta listener, exactly as effects.ts applies it. */
const delta = (runs, chatId, runId, text) =>
  applyEvent(runs, chatId, runId, (t) => ({ ...t, text: t.text + text }));

test("one chat's answer never streams into another chat", () => {
  // Chat A is answering. The user opens chat B and A keeps streaming.
  let runs = startRun({}, "chat-a", "run-1");
  runs = delta(runs, "chat-a", "run-1", "half an ");
  runs = delta(runs, "chat-a", "run-1", "answer");

  // What chat B shows while A runs: nothing. Before the fix this read chat A's
  // text, because there was one `streamText` for the whole window.
  assert.equal(liveTurn(runs, "chat-b").text, "");
  assert.equal(isAsking(runs, "chat-b"), false);
  // …and A's own answer is intact, whichever chat is on screen.
  assert.equal(liveTurn(runs, "chat-a").text, "half an answer");
  assert.equal(isAsking(runs, "chat-a"), true);
});

test("two chats answer at once without either one seeing the other", () => {
  let runs = startRun(startRun({}, "chat-a", "run-1"), "chat-b", "run-2");
  runs = delta(runs, "chat-a", "run-1", "about the lease");
  runs = delta(runs, "chat-b", "run-2", "about the invoice");
  assert.equal(liveTurn(runs, "chat-a").text, "about the lease");
  assert.equal(liveTurn(runs, "chat-b").text, "about the invoice");
  assert.equal(runIdOf(runs, "chat-a"), "run-1");
  assert.equal(runIdOf(runs, "chat-b"), "run-2");
});

test("a straggler from a finished turn lands nowhere", () => {
  // The turn ends, the user asks again, and a late event from the OLD run
  // arrives. It names a run this chat is no longer on, so it is dropped —
  // this is the class that put another turn's reading on a fresh question.
  let runs = startRun({}, "chat-a", "run-1");
  runs = finishRun(runs, "chat-a");
  const idle = delta(runs, "chat-a", "run-1", "too late");
  assert.equal(idle, runs, "an event for an idle chat must not revive it");
  assert.equal(isAsking(idle, "chat-a"), false);

  runs = startRun(runs, "chat-a", "run-2");
  const stale = delta(runs, "chat-a", "run-1", "from the old run");
  assert.equal(stale, runs, "an event naming another run must change nothing");
  assert.equal(liveTurn(stale, "chat-a").text, "");
});

test("the ids survive a tool call round trip", () => {
  // A tool call leaves the host, executes over the MCP bridge and reports back
  // as an `ask-step` emitted from inside `exec_tool` — the same run and chat as
  // the deltas either side of it. The step must file under the same node work
  // the sidecar's own steps do, in the same chat.
  const step = (runs, chatId, runId, label, node) =>
    applyEvent(runs, chatId, runId, (t) => ({
      ...t,
      steps: [...t.steps, { label, ok: true }],
      agentSteps: node
        ? { ...t.agentSteps, [node]: [...(t.agentSteps[node] ?? []), { label, ok: true }] }
        : t.agentSteps,
    }));
  let runs = startRun({}, "chat-a", "run-1");
  runs = delta(runs, "chat-a", "run-1", "looking it up");
  runs = step(runs, "chat-a", "run-1", "Searching the web (leaves this Mac)", "web#0");
  runs = delta(runs, "chat-a", "run-1", " — found it");
  const live = liveTurn(runs, "chat-a");
  assert.equal(live.text, "looking it up — found it");
  assert.deepEqual(live.steps, [
    { label: "Searching the web (leaves this Mac)", ok: true },
  ]);
  assert.equal(live.agentSteps["web#0"].length, 1);
  // And a step stamped with a DIFFERENT run — a background/headless turn's
  // tool, or another chat's — never joins this turn's chips.
  const foreign = step(runs, "chat-a", "run-9", "Downloading something", null);
  assert.equal(foreign, runs);
});

test("an event that names no conversation is offered to the chat on screen", () => {
  // The AI-actions menu runs from the file header and belongs to no chat, so
  // the host emits it with null ids rather than borrowing one. It may only be
  // shown where the user is looking — and only if that chat is itself running.
  assert.equal(ownerOf({ runId: null, chatId: null }, "chat-b"), "chat-b");
  assert.equal(ownerOf({ runId: null, chatId: null }, null), null);
  // An event that DOES name its chat owns itself, wherever the user is.
  assert.equal(ownerOf({ runId: "run-1", chatId: "chat-a" }, "chat-b"), "chat-a");

  // "Offered" is not "accepted": with nothing running on screen it is dropped.
  const idle = {};
  assert.equal(applyEvent(idle, "chat-b", null, (t) => t), idle);
});

test("a fresh chat's token bar reads zero because it has no run", () => {
  // Live QA saw an identical "30,034 / 1,000,000" on a brand-new chat with an
  // empty history. The history WAS empty; only the global readout was stale.
  const usage = { total_tokens: 30034, max_context: 1_000_000, estimated: false };
  const byChat = { "chat-a": usage };
  assert.equal(usageOf(byChat, "chat-a"), usage);
  assert.equal(usageOf(byChat, "chat-new"), null, "a chat that never ran reads nothing");
  assert.equal(usageOf(byChat, null), null);
  // Switching away and back is not a reset either — the reading belongs to the
  // conversation, so it is still there when the user returns.
  assert.equal(usageOf(byChat, "chat-a"), usage);
});

test("an idle chat hands back one stable empty overlay", () => {
  // ChatPane memoises the agent diagram on these identities; a fresh object per
  // render would rebuild it forever.
  assert.equal(liveTurn({}, "chat-a"), NO_LIVE_TURN);
  assert.equal(liveTurn({}, null), NO_LIVE_TURN);
  assert.equal(liveTurn({}, "chat-a"), liveTurn({}, "chat-b"));
});
