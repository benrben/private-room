// Tests for the agent transport, against a SCRIPTED FAKE `EvalHost`.
//
// This is the "injected minimal interface" pattern menu.ts uses
// (`MainWindowLike`), not a mock of Electron standing in for something that
// could never fail: the point is that a fake can produce a timeout, a dropped
// call or a mid-batch navigation deterministically and on demand, which a real
// renderer cannot be made to do on a schedule inside a test.
//
// Ports `a_readiness_probe_that_timed_out_is_a_busy_page_not_an_undriveable_one`'s
// integration half, and the behaviour `call_async`'s long doc comment
// describes (owner report 2026-07-30).

import { describe, expect, it } from "vitest";
import {
  EVAL_LOST,
  EVAL_TIMED_OUT,
  SCRIPT_REFUSED,
  START_BLANK,
} from "./readiness.js";
import {
  READY_JS,
  buildCallJs,
  callAsync,
  callPage,
  docId,
  evalJson,
  markSuperseded,
  probeReady,
  waitReady,
  type EvalHost,
} from "./evalBridge.js";

const noSleep = () => Promise.resolve();

function opOf(js: string): string {
  if (js.includes("window.__arcelleSuperseded = 1")) return "superseded";
  const m = /\.call\("([a-zA-Z]+)"/.exec(js);
  return m?.[1] ?? "";
}

/** An `EvalHost` driven by a per-test handler keyed on the op the expression
 *  embeds. Answers are given as VALUES and serialized here, because the real
 *  host's contract is raw JSON text. */
function fakeHost(handler: (op: string, js: string) => unknown | Promise<unknown>): EvalHost {
  return {
    async evaluate(_pageId, js) {
      const v = await handler(opOf(js), js);
      return typeof v === "string" ? v : JSON.stringify(v);
    },
  };
}

describe("evalJson", () => {
  it("resolves the parsed JSON on a normal answer", async () => {
    const host = fakeHost(() => ({ ok: true, value: 42 }));
    await expect(evalJson(host, "0", "1+1")).resolves.toEqual({ ok: true, value: 42 });
  });

  it("reports EVAL_TIMED_OUT when the call never comes back within budget", async () => {
    const host: EvalHost = { evaluate: () => new Promise(() => {}) };
    await expect(evalJson(host, "0", "x", { timeoutMs: 5 })).rejects.toThrow(EVAL_TIMED_OUT);
  });

  it("reports EVAL_LOST for any other rejection — a navigation, never a guess about the browser", async () => {
    const host: EvalHost = {
      evaluate: async () => {
        throw new Error("Script failed to execute: context destroyed");
      },
    };
    await expect(evalJson(host, "0", "x")).rejects.toThrow(EVAL_LOST);
  });

  it("reads an empty answer as the script not being present", async () => {
    const host: EvalHost = { evaluate: async () => "" };
    await expect(evalJson(host, "0", "x")).rejects.toThrow(SCRIPT_REFUSED);
  });

  it("reports unreadable JSON honestly rather than crashing", async () => {
    const host: EvalHost = { evaluate: async () => "{not json" };
    await expect(evalJson(host, "0", "x")).rejects.toThrow(/something unreadable/);
  });
});

describe("buildCallJs", () => {
  it("always evaluates to an object, even with no args at all", async () => {
    // A page with no script yet must answer `{ok:false,error:…}` rather than
    // `undefined`, which the wire cannot tell from a dropped call.
    expect(buildCallJs("snapshot", undefined)).toContain("{}");
    expect(buildCallJs("snapshot", undefined)).not.toContain("undefined");
    expect(buildCallJs("act", { actions: [] })).toContain('{"actions":[]}');
  });
});

describe("callPage", () => {
  it("resolves the page's answer on ok:true", async () => {
    const host = fakeHost((op) => (op === "snapshot" ? { ok: true, count: 3 } : { ok: false }));
    await expect(callPage(host, "0", "snapshot", {})).resolves.toEqual({ ok: true, count: 3 });
  });

  it("turns ok:false into a rejection carrying the page's OWN error", async () => {
    const host = fakeHost(() => ({ ok: false, error: "e7 is gone — act on the fresh snapshot below." }));
    await expect(callPage(host, "0", "act", { actions: [] })).rejects.toThrow("e7 is gone");
  });

  it("falls back to a plain refusal when the page gave no reason", async () => {
    const host = fakeHost(() => ({ ok: false }));
    await expect(callPage(host, "0", "act", {})).rejects.toThrow("The page refused that.");
  });
});

describe("markSuperseded", () => {
  it("sets the exact flag READY_JS guards on", async () => {
    let seen = "";
    const host: EvalHost = {
      evaluate: async (_id, js) => {
        seen = js;
        return "1";
      },
    };
    await markSuperseded(host, "0");
    expect(seen).toBe("window.__arcelleSuperseded = 1");
    expect(READY_JS).toContain("!window.__arcelleSuperseded");
  });

  it("is tolerant of a failing evaluate, matching Rust's `let _ = wv.eval(...)`", async () => {
    const host: EvalHost = {
      evaluate: async () => {
        throw new Error("gone");
      },
    };
    await expect(markSuperseded(host, "0")).resolves.toBeUndefined();
  });
});

describe("probeReady", () => {
  it("reads a normal answered page as ready", async () => {
    const host = fakeHost(() => ({ ok: true, url: "https://example.com/" }));
    await expect(probeReady(host, "0", false)).resolves.toBe("ready");
  });

  it("reads a finished document with no script as refused", async () => {
    const host = fakeHost(() => ({ ok: false, refused: true }));
    await expect(probeReady(host, "0", false)).resolves.toBe("refused");
  });

  it("reads a timed-out probe as loading, not refused", async () => {
    const host: EvalHost = { evaluate: () => new Promise(() => {}) };
    await expect(probeReady(host, "0", false, { timeoutMs: 5 })).resolves.toBe("loading");
  });
});

describe("waitReady", () => {
  it("returns as soon as the page answers ready", async () => {
    const host = fakeHost(() => ({ ok: true, url: "https://example.com/" }));
    await expect(waitReady(host, "0", () => false, 5_000, { sleep: noSleep })).resolves.toBeUndefined();
  });

  it("throws SCRIPT_REFUSED immediately once the document says so", async () => {
    // A page that refuses the script does NOT get the full budget: every tool
    // used to wait out 12-25 seconds on a PDF and then blame the load.
    const host = fakeHost(() => ({ ok: false, refused: true }));
    await expect(waitReady(host, "0", () => false, 5_000, { sleep: noSleep })).rejects.toThrow(
      SCRIPT_REFUSED,
    );
  });

  it("gives the truthful 'still loading' wording when it kept looking like it might load", async () => {
    const host = fakeHost(() => ({ ok: false, refused: false }));
    await expect(waitReady(host, "0", () => false, 5, { sleep: noSleep })).rejects.toThrow(
      /did not finish loading/,
    );
  });

  it("reports a document that gave NO sign at all as refused, not slow", async () => {
    // An empty answer is what a document with no script for us looks like, and
    // saying "still loading" after the budget would be a guess.
    const host: EvalHost = { evaluate: async () => "" };
    await expect(waitReady(host, "0", () => false, 5, { sleep: noSleep })).rejects.toThrow(
      SCRIPT_REFUSED,
    );
  });

  it("does not mistake the blank start document for the page that was asked for", async () => {
    const host = fakeHost(() => ({ ok: true, url: START_BLANK }));
    await expect(waitReady(host, "0", () => false, 5, { sleep: noSleep })).rejects.toThrow(
      /did not finish loading/,
    );
    // …but the SAME answer against a genuinely blank tab's own record IS ready.
    await expect(waitReady(host, "0", () => true, 5_000, { sleep: noSleep })).resolves.toBeUndefined();
  });

  it("re-reads isBlank on EVERY poll, not once at the start", async () => {
    // It reads live registry state: a page can become blank (or stop being) in
    // the middle of a wait.
    let polls = 0;
    const host = fakeHost(() => {
      polls += 1;
      return { ok: true, url: START_BLANK };
    });
    // The same blank answer every time: only the record changing its mind can
    // end this wait, which it could not if isBlank were captured once.
    await expect(
      waitReady(host, "0", () => polls >= 3, 5_000, { sleep: noSleep }),
    ).resolves.toBeUndefined();
    expect(polls).toBeGreaterThan(1);
  });
});

describe("docId", () => {
  it("reads the per-document nonce off info()", async () => {
    const host = fakeHost(() => ({ ok: true, doc: "abc.123" }));
    await expect(docId(host, "0")).resolves.toBe("abc.123");
  });

  it("is null when the document cannot be reached at all", async () => {
    const host: EvalHost = {
      evaluate: async () => {
        throw new Error("boom");
      },
    };
    await expect(docId(host, "0")).resolves.toBeNull();
  });
});

describe("callAsync", () => {
  it("returns the ticket's own value once it completes — the Rust result shape", async () => {
    let takes = 0;
    const host = fakeHost((op) => {
      if (op === "begin") return { ok: true, ticket: "t1" };
      if (op === "take") {
        takes += 1;
        return takes < 2 ? { ok: true, done: false } : { ok: true, done: true, value: { clicked: true } };
      }
      return { ok: false };
    });
    await expect(callAsync(host, "0", "act", { actions: [] }, 5_000, () => false, { sleep: noSleep })).resolves.toEqual(
      { clicked: true },
    );
  });

  it("reports a navigation, NOT a failure, when the ticket is lost to a document swap", async () => {
    // THE BUG THIS EXISTS FOR: the click had SUCCEEDED and took the page with
    // it; the model was told it failed and gave up mid-task.
    let doc = "doc-A";
    let took = false;
    const host = fakeHost((op) => {
      if (op === "begin") return { ok: true, ticket: "t1" };
      if (op === "take") {
        if (!took) {
          took = true;
          doc = "doc-B";
        }
        return { ok: false, error: "Unknown ticket t1" };
      }
      if (op === "info") return { ok: true, doc };
      if (op === "ping") return { ok: true, url: "https://after.example/" };
      if (op === "snapshot") return { ok: true, count: 1 };
      return { ok: false };
    });
    await expect(
      callAsync(host, "0", "act", { actions: [] }, 5_000, () => false, {
        sleep: noSleep,
        navBudgetMs: 50,
      }),
    ).resolves.toEqual({ ok: true, navigated: true, snapshot: { ok: true, count: 1 } });
  });

  it("rethrows when the SAME document reports the ticket unknown — a real bug, not a navigation", async () => {
    const host = fakeHost((op) => {
      if (op === "begin") return { ok: true, ticket: "t1" };
      if (op === "take") return { ok: false, error: "Unknown ticket t1" };
      if (op === "info") return { ok: true, doc: "doc-A" };
      if (op === "ping") return { ok: true, url: "https://same.example/" };
      return { ok: false };
    });
    await expect(
      callAsync(host, "0", "act", {}, 5_000, () => false, { sleep: noSleep, navBudgetMs: 30 }),
    ).rejects.toThrow("Unknown ticket t1");
  });

  it("rethrows when the document cannot be reached at all afterwards", async () => {
    // `docAfter === null` is "we cannot tell", and a batch reported as a
    // successful navigation on no evidence would be the fabrication this
    // module exists to prevent.
    const host = fakeHost((op) => {
      if (op === "begin") return { ok: true, ticket: "t1" };
      if (op === "take") return { ok: false, error: "Unknown ticket t1" };
      if (op === "info") return { ok: false };
      if (op === "ping") return { ok: false, refused: true };
      return { ok: false };
    });
    await expect(
      callAsync(host, "0", "act", {}, 5_000, () => false, { sleep: noSleep, navBudgetMs: 30 }),
    ).rejects.toThrow("Unknown ticket t1");
  });

  it("reports a page that never starts the action honestly", async () => {
    const host = fakeHost((op) => (op === "begin" ? { ok: true } : { ok: false }));
    await expect(
      callAsync(host, "0", "act", {}, 5_000, () => false, { sleep: noSleep }),
    ).rejects.toThrow("did not start that action");
  });

  it("times out when the page keeps reporting 'still working'", async () => {
    const host = fakeHost((op) => {
      if (op === "begin") return { ok: true, ticket: "t1" };
      if (op === "take") return { ok: true, done: false };
      return { ok: false };
    });
    await expect(
      callAsync(host, "0", "act", {}, 5, () => false, { sleep: noSleep }),
    ).rejects.toThrow(/still working after/);
  });

  it("addresses ONE page for every hop, never 'whichever page is showing'", async () => {
    // A tab switch mid-batch is not news about the op: against the active view
    // the ticket would belong to a document that never heard of it.
    const seen = new Set<string>();
    const host: EvalHost = {
      async evaluate(pageId, js) {
        seen.add(pageId);
        const op = opOf(js);
        if (op === "begin") return JSON.stringify({ ok: true, ticket: "t1" });
        if (op === "take") return JSON.stringify({ ok: true, done: true, value: 1 });
        return JSON.stringify({ ok: true, doc: "d" });
      },
    };
    await callAsync(host, "page-7", "act", {}, 5_000, () => false, { sleep: noSleep });
    expect([...seen]).toEqual(["page-7"]);
  });
});
