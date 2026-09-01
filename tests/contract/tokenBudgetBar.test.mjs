/* The token-budget bar on a conversation reopened from disk.
 *
 * The live `ask-token-usage` event only exists while the app is running, so a
 * chat selected after a restart had no reading in `usageByChat` and the whole
 * row — meter AND the "Hand off" compaction button — rendered as nothing,
 * precisely on the long conversations that need both. The snapshot is on the
 * assistant row all along (`effects.usage`), so this renders the REAL
 * `TokenBudgetBar` out of the real .tsx with only a persisted snapshot and
 * asserts the row comes back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { loadTypescriptModule } from "../support/source-modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../apps/desktop/src/renderer");

/* ---------- loading real TSX under plain node (same trick as activityPane) ---------- */

const BARE = {
  react: import.meta.resolve("react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
};

// The bar's neighbours are not what this test is about: the icon set, the
// markdown view the handoff marker uses, and the two state/actions modules
// that only supply types here.
const STUBS = new Map(
  ["icons.tsx", "viewers/MarkdownView.tsx", "workspace/state.ts", "workspace/actions.ts"].map((p) =>
    [join(SRC, p), {}],
  ),
);
const TokenBudgetBar = (
  await import(
    loadTypescriptModule(join(SRC, "workspace/TokenBudgetBar.tsx"), {
      bare: BARE,
      stubs: STUBS,
    }),
  )
).default;

/* ---------- fixtures ---------- */

/** A snapshot of the shape agent.rs persists into `effects.usage`. */
const snapshot = (total, max) => ({
  total_tokens: total,
  max_context: max,
  estimated: false,
  breakdown: {
    system: { tokens: Math.round(total * 0.1), estimated: true },
    history: { tokens: Math.round(total * 0.6), estimated: true },
    tools: { tokens: Math.round(total * 0.1), estimated: true },
    skills: { tokens: 0, estimated: true },
    files: { tokens: Math.round(total * 0.2), estimated: true },
  },
});

const msg = (id, role, effects = null) => ({
  id,
  role,
  content: "…",
  sources: [],
  createdAt: "2026-08-16T10:00:00.000Z",
  effects,
});

const render = (s) =>
  renderToStaticMarkup(
    createElement(TokenBudgetBar, {
      s: { tokenUsage: null, messages: [], handoffStarting: false, asking: false, ...s },
      a: { handoffContext: () => {} },
    }),
  );

/* ---------- the row a reopened chat gets ---------- */

test("a reopened chat reads its meter off the persisted snapshot", () => {
  // 880k of a 1M window: past the 70% gate, so the meter earns its place.
  const html = render({
    messages: [
      msg("u1", "user"),
      msg("a1", "assistant", { usage: snapshot(880_000, 1_000_000) }),
    ],
  });
  assert.ok(html.includes("token-bar-track"), "the meter must come back with the transcript");
  assert.ok(html.includes("880,000"), "and read the persisted total, not zero");
  assert.ok(html.includes("Hand off"), "compaction is offered on the very chat that needs it");
});

test("the newest snapshot wins over an older one", () => {
  const html = render({
    messages: [
      msg("a1", "assistant", { usage: snapshot(750_000, 1_000_000) }),
      msg("u2", "user"),
      msg("a2", "assistant", { usage: snapshot(910_000, 1_000_000) }),
    ],
  });
  assert.ok(html.includes("910,000"), "the last turn is the current reading");
  assert.ok(!html.includes("750,000"), "an earlier turn's reading is history, not the state");
});

test("a live snapshot still takes precedence over the transcript", () => {
  const html = render({
    tokenUsage: snapshot(950_000, 1_000_000),
    messages: [msg("a1", "assistant", { usage: snapshot(800_000, 1_000_000) })],
  });
  assert.ok(html.includes("950,000"), "the turn that just finished is the newest reading");
});

test("a chat with turns but no snapshot anywhere still offers Hand off", () => {
  // Rows written before the usage column existed carry no snapshot; the
  // compaction action is not a consequence of the meter being visible.
  const html = render({ messages: [msg("u1", "user"), msg("a1", "assistant")] });
  assert.ok(html.includes("Hand off"), "Hand off does not depend on a reading");
  assert.ok(!html.includes("token-bar-track"), "but an unknown budget draws no meter");
});

test("an empty conversation renders nothing at all", () => {
  assert.equal(render({}), "", "there is nothing to meter and nothing to hand off");
});

test("a low reading keeps the meter away and the button present", () => {
  const html = render({
    messages: [msg("a1", "assistant", { usage: snapshot(20_000, 1_000_000) })],
  });
  assert.ok(!html.includes("token-bar-track"), "2% used is not something to watch");
  assert.ok(html.includes("Hand off"));
});
