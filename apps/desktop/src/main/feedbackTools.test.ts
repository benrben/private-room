/**
 * Vitest port of `src-tauri/src/commands/feedback.rs`'s own `#[cfg(test)] mod
 * tests` (`diag_has_the_basics`,
 * `a_draft_in_an_unreadable_shape_says_so_instead_of_coming_back_blank`), plus
 * the coverage this port adds for {@link feedbackDraft} itself — the
 * empty-text guard, model resolution (against a real fixture room/db, the
 * `db-host` convention this directory already uses), and the sidecar
 * POST/error-mapping integration, none of which the Rust suite can exercise
 * without a live `AppState`/Tokio runtime.
 *
 * REAL FIXTURE ROOMS: every test that touches the database opens a real
 * `.roomai` through `createRoom` and drives the real `db-host/settings.ts`
 * reader/writer, matching `autoIndex.test.ts`'s established convention.
 */

import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { resetBaseUrlOverrideForTests } from "./engineRouting.js";
import { setSetting } from "./db-host/settings.js";
import { createRoom } from "./db-host/open.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import type { SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import { appDiag, FEEDBACK_REPO, feedbackDraft, readDraft, type FeedbackDraftDeps } from "./feedbackTools.js";

let tmpDir: string;

beforeEach(() => {
  resetBaseUrlOverrideForTests();
});

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "feedback-tools-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function fakeRooms(handle: RoomHandle | null): RoomSource {
  return { current: () => handle };
}

const noRoom: RoomSource = fakeRooms(null);

/** A `post` double that never touches the network — records the body it was
 * called with (for assertions on the RESOLVED model) and resolves whatever
 * `outcome` says. */
function fakePost(outcome: SidecarPostOutcome): {
  post: NonNullable<FeedbackDraftDeps["post"]>;
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  const post: NonNullable<FeedbackDraftDeps["post"]> = async (p, body) => {
    calls.push({ path: p, body });
    return outcome;
  };
  return { post, calls };
}

// ============================================================================
// FEEDBACK_REPO — ported from `diag_has_the_basics`
// ============================================================================

describe("FEEDBACK_REPO", () => {
  it("names an owner/repo pair", () => {
    expect(FEEDBACK_REPO).not.toBe("");
    expect(FEEDBACK_REPO).toContain("/");
  });
});

// ============================================================================
// appDiag
// ============================================================================

describe("appDiag", () => {
  it("reports the injected version/os, the real process arch, and the feedback repo", () => {
    const diag = appDiag({ appVersion: () => "1.2.3", osVersion: () => "macOS 14.5" });
    expect(diag).toEqual({
      version: "1.2.3",
      os: "macOS 14.5",
      arch: process.arch,
      repo: FEEDBACK_REPO,
    });
  });
});

// ============================================================================
// readDraft — ported verbatim from
// `a_draft_in_an_unreadable_shape_says_so_instead_of_coming_back_blank`
// ============================================================================

describe("readDraft", () => {
  it("reads a well-formed draft", () => {
    const good = { title: "Recording stops at 3 h", body: "## What happened" };
    expect(readDraft(good)).toEqual({ title: "Recording stops at 3 h", body: "## What happened" });
  });

  it("a renamed shape says so instead of coming back blank, naming the missing field", () => {
    // A rename on the sidecar side used to arrive as two empty strings: the
    // modal wrote them straight into its boxes, showed no error, and left
    // Open-issue disabled with nothing saying why.
    expect(() => readDraft({ issue_title: "x", issue_body: "y" })).toThrowError(/title/);
  });

  it("half a contract is still a broken one", () => {
    expect(() => readDraft({ title: "x" })).toThrow();
  });

  it("a field that is present but not text is rejected too", () => {
    expect(() => readDraft({ title: "x", body: ["y"] })).toThrow();
  });

  it("a non-object value is rejected, not crashed on", () => {
    expect(() => readDraft(null)).toThrow();
    expect(() => readDraft("a string")).toThrow();
  });

  // ADVERSARIAL. Rust reads `v["title"]` on a `serde_json::Value`, which
  // resolves against the reply's OWN map and answers `Null` for anything else
  // — it cannot return a field the sidecar never sent. A plain `obj[key]`
  // could, and this app has shipped `Object.prototype` pollution twice
  // (mcpConfig.ts, privacyRedact.ts). This failed before `readDraft` switched
  // to an own-property read: a `null` reply came back as a COMPLETE draft of
  // two sentences no model wrote, and the "this version cannot read it"
  // refusal the function exists for never fired.
  describe("a polluted Object.prototype never stands in for a missing field", () => {
    const polluted: string[] = [];
    function pollute(key: string, value: unknown): void {
      Object.defineProperty(Object.prototype, key, {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
      });
      polluted.push(key);
    }

    afterEach(() => {
      for (const key of polluted.splice(0)) {
        Reflect.deleteProperty(Object.prototype, key);
      }
    });

    it("still refuses a null reply", () => {
      pollute("title", "FABRICATED TITLE");
      pollute("body", "FABRICATED BODY");
      expect(() => readDraft(null)).toThrowError(/title/);
    });

    it("still refuses a reply that carries neither field of its own", () => {
      pollute("title", "FABRICATED TITLE");
      pollute("body", "FABRICATED BODY");
      expect(() => readDraft({ issue_title: "x" })).toThrowError(/title/);
      // A reply with its OWN title but no body is still half a contract.
      expect(() => readDraft({ title: "real" })).toThrowError(/body/);
      // …and a complete, genuine reply is untouched by the guard.
      expect(readDraft({ title: "real t", body: "real b" })).toEqual({ title: "real t", body: "real b" });
    });
  });
});

// ============================================================================
// feedbackDraft
// ============================================================================

describe("feedbackDraft", () => {
  it("refuses empty text before ever touching a model", async () => {
    const listModels = vi.fn<() => Promise<string[]>>();
    await expect(
      feedbackDraft({ rooms: noRoom, listModels }, "   ")
    ).rejects.toThrow("Write a few words about what happened first.");
    expect(listModels).not.toHaveBeenCalled();
  });

  it("a listModels failure reads as the Ollama-isn't-running sentence (FIDELITY: the real, already-ported engineRouting.ts listModels never throws — see this module's own FIDELITY NOTE — so this path is exercised only via an injected double, exactly as Rust's genuine ollama::list_models Err would)", async () => {
    const listModels = async (): Promise<string[]> => {
      throw new Error("ECONNREFUSED");
    };
    await expect(feedbackDraft({ rooms: noRoom, listModels }, "it crashed")).rejects.toThrow(
      "The local AI (Ollama) isn't running — you can still write the issue yourself."
    );
  });

  it("maps even a synchronous injected model-list failure to the unavailable-model sentence", async () => {
    const listModels = (() => {
      throw new Error("immediate test double failure");
    }) as unknown as NonNullable<FeedbackDraftDeps["listModels"]>;
    await expect(feedbackDraft({ rooms: noRoom, listModels }, "it crashed")).rejects.toThrow(
      "The local AI (Ollama) isn't running — you can still write the issue yourself."
    );
  });

  it("no installed models reads as the no-model-installed sentence", async () => {
    await expect(
      feedbackDraft({ rooms: noRoom, listModels: async () => [] }, "it crashed")
    ).rejects.toThrow("No local AI model is installed — you can still write the issue yourself.");
  });

  it("no room open picks the installed local default — the ACTUAL installed tag, not the bare canonical name", async () => {
    const { post, calls } = fakePost({ kind: "value", value: { title: "t", body: "b" } });
    const draft = await feedbackDraft(
      { rooms: noRoom, listModels: async () => ["qwen3.5:4b-mlx"], post },
      "the app crashed on launch"
    );
    expect(draft).toEqual({ title: "t", body: "b" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/feedback_draft");
    expect((calls[0]?.body as { model: string }).model).toBe("qwen3.5:4b-mlx");
  });

  it("skips embedding and external tags when the tuned default is not installed", async () => {
    const { post, calls } = fakePost({ kind: "value", value: { title: "t", body: "b" } });
    await feedbackDraft(
      { rooms: noRoom, listModels: async () => ["nomic-embed-text", "claude-cli", "llama3.2:3b"], post },
      "the app crashed on launch"
    );
    expect((calls[0]?.body as { model: string }).model).toBe("llama3.2:3b");
  });

  it("sends the trimmed text, plus the resolved base_url, on the wire body", async () => {
    const { post, calls } = fakePost({ kind: "value", value: { title: "t", body: "b" } });
    await feedbackDraft(
      { rooms: noRoom, listModels: async () => ["qwen3.5:4b"], post },
      "  leading and trailing space  "
    );
    const body = calls[0]?.body as { text: string; base_url: string };
    expect(body.text).toBe("leading and trailing space");
    expect(body.base_url).toBeTruthy();
  });

  it("an open room's chosen model wins when it runs on this Mac", async () => {
    const db = freshRoom();
    setSetting(db, "model", "qwen3.5:4b");
    const { post, calls } = fakePost({ kind: "value", value: { title: "t", body: "b" } });
    await feedbackDraft(
      { rooms: fakeRooms({ db, path: "x.roomai" }), listModels: async () => ["qwen3.5:4b"], post },
      "a bug"
    );
    expect((calls[0]?.body as { model: string }).model).toBe("qwen3.5:4b");
    db.close();
  });

  it("a room's chosen model is overridden when it does NOT run on this Mac — a cloud-model room never sends the report's raw text off-device", async () => {
    const db = freshRoom();
    setSetting(db, "model", "claude-cli");
    const { post, calls } = fakePost({ kind: "value", value: { title: "t", body: "b" } });
    await feedbackDraft(
      {
        rooms: fakeRooms({ db, path: "x.roomai" }),
        listModels: async () => ["qwen3.5:4b-q4_K_M"],
        post,
      },
      "a bug"
    );
    expect((calls[0]?.body as { model: string }).model).toBe("qwen3.5:4b-q4_K_M");
    db.close();
  });

  it("a room with no explicit model setting falls back to the installed local default, same as no room open", async () => {
    const db = freshRoom();
    const { post, calls } = fakePost({ kind: "value", value: { title: "t", body: "b" } });
    await feedbackDraft(
      { rooms: fakeRooms({ db, path: "x.roomai" }), listModels: async () => ["qwen3.5:4b"], post },
      "a bug"
    );
    expect((calls[0]?.body as { model: string }).model).toBe("qwen3.5:4b");
    db.close();
  });

  // ADVERSARIAL: an EMPTY `model` row is not the same as an unset one.
  // Rust's `model_setting` is `db::get_setting(conn, "model")`, which answers
  // `Some("")` for a row holding the empty string — so `unwrap_or_else` never
  // fires, and `runs_on_this_mac("")` is true (`engine_id_of("")` falls back
  // to the Ollama record, which is `local`). Rust therefore posts `model: ""`
  // and lets the sidecar name what is wrong. Pinned here so a future
  // "tidy-up" that folds `""` into the `??` fallback is caught as the
  // behavior change it would be.
  it("an EMPTY model row is honored as Rust's Some(\"\"), not folded into the unset fallback", async () => {
    const db = freshRoom();
    setSetting(db, "model", "");
    const { post, calls } = fakePost({ kind: "value", value: { title: "t", body: "b" } });
    await feedbackDraft(
      { rooms: fakeRooms({ db, path: "x.roomai" }), listModels: async () => ["qwen3.5:4b"], post },
      "a bug"
    );
    expect((calls[0]?.body as { model: string }).model).toBe("");
    db.close();
  });

  it("a classified sidecar error is mapped through sidecarErrorSentinel, naming the FINAL resolved model", async () => {
    const { post } = fakePost({
      kind: "error",
      error: { code: "MODEL_MISSING", error: "not pulled", status: 404 },
    });
    await expect(
      feedbackDraft({ rooms: noRoom, listModels: async () => ["qwen3.5:4b"], post }, "a bug")
    ).rejects.toThrow("MODEL_MISSING:qwen3.5:4b");
  });

  it("a malformed value from the sidecar surfaces readDraft's own error, not a blank success", async () => {
    const { post } = fakePost({ kind: "value", value: { issue_title: "x", issue_body: "y" } });
    await expect(
      feedbackDraft({ rooms: noRoom, listModels: async () => ["qwen3.5:4b"], post }, "a bug")
    ).rejects.toThrow(/title/);
  });

  it("a 'stopped' outcome fails loudly instead of silently resolving — defensive only, since this call never cancels", async () => {
    const { post } = fakePost({ kind: "stopped" });
    await expect(
      feedbackDraft({ rooms: noRoom, listModels: async () => ["qwen3.5:4b"], post }, "a bug")
    ).rejects.toThrow(/never happen/);
  });

  it("gives each sidecar call a fresh, unset cancellation flag", async () => {
    const flags: import("./cancel.js").CancelFlag[] = [];
    const post: NonNullable<FeedbackDraftDeps["post"]> = async (_path, _body, cancel) => {
      flags.push(cancel);
      expect(cancel.load()).toBe(false);
      return { kind: "value", value: { title: "t", body: "b" } };
    };
    const deps = { rooms: noRoom, listModels: async () => ["qwen3.5:4b"], post };
    await feedbackDraft(deps, "first");
    await feedbackDraft(deps, "second");
    expect(flags).toHaveLength(2);
    expect(flags[0]).not.toBe(flags[1]);
  });

  // ------------------------------------------------------------- real wire
  //
  // Exercises the REAL default `post` (sidecarJsonCancellable, undriven by any
  // fake) against a genuine local HTTP server — `ensureUp` is mocked to point
  // at it rather than going through the real spawn lifecycle, the same
  // convention `sidecarJsonCancellable.test.ts` establishes for wire-level
  // coverage of that shared helper.
  describe("against a real sidecar POST", () => {
    it("a successful /feedback_draft response round-trips through readDraft", async () => {
      vi.resetModules();
      vi.doMock("./sidecar.js", async (importOriginal) => {
        const actual = await importOriginal<typeof import("./sidecar.js")>();
        return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
      });
      const { ensureUp } = await import("./sidecar.js");
      const { feedbackDraft: feedbackDraftFresh } = await import("./feedbackTools.js");

      const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          const parsed = JSON.parse(raw) as { text: string };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ title: `Bug: ${parsed.text}`, body: "## What happened\nSomething broke." }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
      try {
        const draft = await feedbackDraftFresh(
          { rooms: noRoom, listModels: async () => ["qwen3.5:4b"] },
          "the recorder stopped after 3 hours"
        );
        expect(draft).toEqual({
          title: "Bug: the recorder stopped after 3 hours",
          body: "## What happened\nSomething broke.",
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        vi.doUnmock("./sidecar.js");
        vi.resetModules();
      }
    });
  });
});
