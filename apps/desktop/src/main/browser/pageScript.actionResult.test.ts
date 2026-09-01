import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPageScript } from "./pageScriptHarness.js";

type Ticket = { ticket: string };

function beginAct(h: ReturnType<typeof loadPageScript>, actions: unknown[]): Ticket {
  Object.defineProperty(h.document, "readyState", { configurable: true, value: "complete" });
  const started = h.call("begin", { op: "act", args: { actions } }) as { ok: boolean; ticket: string };
  expect(started.ok).toBe(true);
  return started;
}

async function completedTicket(h: ReturnType<typeof loadPageScript>, ticket: string, elapsedMs = 1_500) {
  // `begin` chains the page-script's Promise through its ticket record. Let
  // that chain reach its first scheduled timer before advancing the clock.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(elapsedMs);
  await Promise.resolve();
  return h.call("take", { ticket }) as {
    ok: boolean;
    done: boolean;
    value?: { ok: boolean; results?: Array<{ ok: boolean; did?: string; error?: string }>; stoppedAt?: number };
  };
}

describe("page-script action results", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves a direct action result and stops at the next malformed action", async () => {
    const h = loadPageScript("<main>Fabricated page</main>");
    const { ticket } = beginAct(h, [{ key: "Enter", settle_ms: 1 }, null]);

    await expect(completedTicket(h, ticket)).resolves.toMatchObject({
      ok: true,
      done: true,
      value: {
        ok: false,
        stoppedAt: 1,
        results: [
          { ok: true, did: "pressed Enter" },
          { ok: false, error: "Each action must be an object." },
        ],
      },
    });
  });

  it("converts an action getter failure into the documented action error", async () => {
    const h = loadPageScript("<main>Fabricated page</main>");
    const fabricatedAction: Record<string, unknown> = {};
    Object.defineProperty(fabricatedAction, "scroll", {
      get() {
        throw new Error("fabricated action getter failure");
      },
    });
    const { ticket } = beginAct(h, [fabricatedAction]);

    await expect(completedTicket(h, ticket)).resolves.toMatchObject({
      ok: true,
      done: true,
      value: {
        ok: false,
        results: [{ ok: false, error: "That action failed: fabricated action getter failure" }],
      },
    });
  });

  it("reports both appeared-text and disappeared-ref wait successes", async () => {
    const h = loadPageScript('<button id="remove">Remove</button><main>Ready now</main>');
    Object.defineProperty(h.document.body, "innerText", { configurable: true, value: "Ready now" });
    const snapshot = h.call("snapshot", {}) as { elements: Array<{ ref: string }> };
    h.document.getElementById("remove")?.remove();
    const { ticket } = beginAct(h, [
      { wait_for: { text: "ready", timeout_ms: 1 }, settle_ms: 1 },
      { wait_for: { gone: snapshot.elements[0]?.ref, timeout_ms: 1 }, settle_ms: 1 },
    ]);

    await expect(completedTicket(h, ticket)).resolves.toMatchObject({
      ok: true,
      done: true,
      value: {
        ok: true,
        results: [
          { ok: true, did: "waited until it appeared" },
          { ok: true, did: "waited until it disappeared" },
        ],
      },
    });
  });

  it("keeps an unknown disappeared-ref wait as a structured action failure", async () => {
    const unknown = loadPageScript("<main>Fabricated page</main>");
    const unknownTicket = beginAct(unknown, [{ wait_for: { gone: "e404", timeout_ms: 1 } }]).ticket;
    await expect(completedTicket(unknown, unknownTicket)).resolves.toMatchObject({
      value: {
        ok: false,
        results: [{ ok: false, error: expect.stringContaining("not one of this page's refs") }],
      },
    });
  });

  it("keeps a timed-out appeared-text wait as a structured action failure", async () => {
    const timedOut = loadPageScript("<main>Fabricated page</main>");
    const timedOutTicket = beginAct(timedOut, [{ wait_for: { text: "absent", timeout_ms: 1 } }]).ticket;
    await expect(completedTicket(timedOut, timedOutTicket)).resolves.toMatchObject({
      value: {
        ok: false,
        results: [{ ok: false, did: "waited, but it never appeared" }],
      },
    });
  });
});
