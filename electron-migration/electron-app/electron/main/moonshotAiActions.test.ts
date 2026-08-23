/**
 * Tests for `moonshotAiActions.ts`, ported from
 * `src-tauri/src/commands/moonshot/ai_actions.rs`'s own `#[cfg(test)] mod
 * tests` (`ai_action_prompts_lists_the_fourteen_actions_with_right_scope`,
 * `generate_ui_text_degrades_to_ok_none_when_the_sidecar_is_unreachable`)
 * PLUS direct coverage of everything else in the file against REAL FIXTURE
 * ROOMS (`db-host/open.ts`'s `createRoom`, this directory's established
 * convention — `storyTools.test.ts`/`moonshotCmds.test.ts`).
 *
 * Two testing styles, matching this port's own established mix:
 *   - Most of `aiAction`/`memorySuggestion`/`suggestFileMeta`/`generateUiText`
 *     coverage injects `deps.post` directly — fast, deterministic, and the
 *     seam those functions were explicitly built with an injectable default
 *     for.
 *   - ONE end-to-end test per network-touching command drives the REAL
 *     `sidecarJsonCancellable` against a real local `node:http` server with
 *     only `sidecar.ts`'s `ensureUp` mocked to point at it — the exact
 *     convention `storyTools.test.ts`'s own module doc names, proving the
 *     real wiring (URL, body shape, auth headers, JSON parse) actually works
 *     and not just the injected-fake branches.
 */

import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRoom } from "./db-host/open.js";
import { insertFile, listFiles } from "./db-host/files.js";
import { insertMessage } from "./db-host/messages.js";
import { setSetting } from "./db-host/settings.js";
import { CancelFlag, createCancelState, type CancelState } from "./cancel.js";
import type { SidecarError, SidecarPostOutcome } from "./sidecarJsonCancellable.js";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { ensureUp } from "./sidecar.js";
import {
  aiAction,
  aiActionPrompts,
  gatherFilesText,
  gatherScopeText,
  generateUiText,
  memorySuggestion,
  registerMoonshotAiActionsIpc,
  safeScopeName,
  studioInstruction,
  suggestFileMeta,
  type AiActionDeps,
  type AiSidecarDeps,
  type RoomHandle,
  type RoomSource,
} from "./moonshotAiActions.js";

// ============================================================================
// fixtures
// ============================================================================

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshRoom(name = "Test Room"): RoomHandle {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonshot-ai-actions-"));
  tmpDirs.push(dir);
  const roomPath = path.join(dir, `t-${randomUUID()}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", name);
  return { db, path: roomPath, name };
}

function fakeRooms(room: RoomHandle | null, rollingBack = false): RoomSource {
  return { currentRoom: () => room, rollingBack: () => rollingBack };
}

function recordingSender(): { send: (event: string, payload: unknown) => void; events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  return { send: (event, payload) => events.push([event, payload]), events };
}

/** A `post` fake that never touches the network — the standard seam for the
 * majority of tests in this file. */
function fakePost(
  outcome: SidecarPostOutcome | ((path: string, body: unknown) => SidecarPostOutcome)
): AiSidecarDeps["post"] {
  return async (path: string, body: unknown, _cancel: CancelFlag) =>
    typeof outcome === "function" ? outcome(path, body) : outcome;
}

function valueOutcome(value: unknown): SidecarPostOutcome {
  return { kind: "value", value };
}

function errorOutcome(code: string, error: string, status = 500): SidecarPostOutcome {
  return { kind: "error", error: { code, error, status } as SidecarError };
}

function baseDeps(overrides: Partial<AiActionDeps> & { rooms: RoomSource }): AiActionDeps {
  return {
    cancelState: createCancelState(),
    send: () => {},
    listModels: async () => ["qwen3.5:4b"],
    ...overrides,
  };
}

// ============================================================================
// aiActionPrompts — ported from
// `ai_action_prompts_lists_the_fourteen_actions_with_right_scope`
// ============================================================================

describe("aiActionPrompts", () => {
  it("lists the fourteen actions with the right scope, in menu order", () => {
    const defs = aiActionPrompts();
    expect(defs.map((d) => d.id)).toEqual([
      "summarize",
      "analyze",
      "explain",
      "extract",
      "outline",
      "rewrite",
      "qa_pack",
      "fact_check",
      "translate",
      "research",
      "compare",
      "timeline",
      "themes",
      "gaps",
    ]);
    expect(defs).toHaveLength(14);
    for (const d of defs.slice(0, 9)) {
      expect(d.scope, `${d.id} should be file scope`).toBe("file");
    }
    for (const d of defs.slice(9)) {
      expect(d.scope, `${d.id} should be room scope`).toBe("room");
    }
    for (const d of defs) {
      expect(d.needsLanguage, `${d.id} needsLanguage`).toBe(d.id === "translate");
      expect(d.needsQuestion, `${d.id} needsQuestion`).toBe(d.id === "research");
      expect(d.defaultPrompt.trim(), `${d.id} needs a default prompt`).not.toBe("");
    }
  });

  it("returns a fresh array every call — a caller cannot mutate the shared roster", () => {
    const first = aiActionPrompts();
    first.pop();
    expect(aiActionPrompts()).toHaveLength(14);
  });
});

// ============================================================================
// safeScopeName / studioInstruction — pure helpers ported from studios.rs
// ============================================================================

describe("safeScopeName", () => {
  it("folds path/reserved characters to spaces and collapses whitespace", () => {
    expect(safeScopeName('a/b\\c:d*e?f"g<h>i|j\nk\rl\tm')).toBe("a b c d e f g h i j k l m");
  });

  it("caps at 60 Unicode scalar values, never splitting an astral character", () => {
    const label = "x".repeat(58) + "🎉🎉"; // 60 scalar values total, 2 astral
    expect(safeScopeName(label)).toBe(label);
    // One scalar value over the cap is dropped whole — `.length` (UTF-16 code
    // units) would read 62 here since both emoji are astral; the cap counts
    // scalar values, matching Rust's `chars().take(60)`.
    expect([...safeScopeName(label + "y")]).toHaveLength(60);
    expect(safeScopeName(label + "y")).toBe(label);
  });

  it("falls back to 'room' for an empty or all-forbidden label", () => {
    expect(safeScopeName("")).toBe("room");
    expect(safeScopeName("   ")).toBe("room");
    expect(safeScopeName("///")).toBe("room");
  });
});

describe("studioInstruction", () => {
  it("uses the supplied instruction, trimmed, when non-empty", () => {
    expect(studioInstruction("  Do the thing.  ", "Default.")).toBe("Do the thing.");
  });

  it("falls back to the default when supplied is null, empty, or whitespace-only", () => {
    expect(studioInstruction(null, "Default.")).toBe("Default.");
    expect(studioInstruction("", "Default.")).toBe("Default.");
    expect(studioInstruction("   ", "Default.")).toBe("Default.");
  });
});

// ============================================================================
// gatherScopeText / gatherFilesText — ported from studios.rs
// ============================================================================

describe("gatherScopeText", () => {
  it("a single file scope returns its title and clamped text", () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Notes.md", "text/markdown", Buffer.from("x"), "Body text here.", "user");
    const [label, text] = gatherScopeText(room.db, file.id, room.name);
    // `titleFromName` drops the extension — `docs_html.rs::title_from_name`.
    expect(label).toBe("Notes");
    expect(text).toBe("Body text here.");
  });

  it("refuses a file scope with no readable text", () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Empty.md", "text/markdown", Buffer.from("x"), "   ", "user");
    expect(() => gatherScopeText(room.db, file.id, room.name)).toThrow(
      '"Empty.md" has no readable text to work with.'
    );
  });

  it("a null scope gathers the whole room, excluding the app's own generated summary", () => {
    const room = freshRoom("My Room");
    insertFile(room.db, "One.md", "text/markdown", Buffer.from("x"), "First file body.", "user");
    insertFile(room.db, "Two.md", "text/markdown", Buffer.from("x"), "Second file body.", "user");
    insertFile(
      room.db,
      "Room summary.html",
      "text/html",
      Buffer.from("x"),
      "The room's own generated summary.",
      "generated"
    );
    const [label, text] = gatherScopeText(room.db, null, room.name);
    expect(label).toBe("My Room");
    expect(text).toContain("## One.md");
    expect(text).toContain("First file body.");
    expect(text).toContain("## Two.md");
    expect(text).not.toContain("Room summary");
  });

  it("a user file that merely shares the summary's name is NOT excluded", () => {
    const room = freshRoom("My Room");
    insertFile(room.db, "Room summary.html", "text/html", Buffer.from("x"), "A person's own file.", "user");
    const [, text] = gatherScopeText(room.db, null, room.name);
    expect(text).toContain("A person's own file.");
  });

  it("refuses a room with no readable text yet", () => {
    const room = freshRoom();
    expect(() => gatherScopeText(room.db, null, room.name)).toThrow(
      "This room has no readable text to work with yet."
    );
  });
});

describe("gatherFilesText", () => {
  it("concatenates the named files under per-file headers, single-name label", () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Report.md", "text/markdown", Buffer.from("x"), "The report body.", "user");
    const [label, text] = gatherFilesText(room.db, [file.id]);
    expect(label).toBe("Report");
    expect(text).toBe("## Report.md\nThe report body.\n\n");
  });

  it("labels multiple files as 'N files'", () => {
    const room = freshRoom();
    const a = insertFile(room.db, "A.md", "text/markdown", Buffer.from("x"), "a body", "user");
    const b = insertFile(room.db, "B.md", "text/markdown", Buffer.from("x"), "b body", "user");
    const [label] = gatherFilesText(room.db, [a.id, b.id]);
    expect(label).toBe("2 files");
  });

  it("skips a missing id and an empty-text file rather than failing", () => {
    const room = freshRoom();
    const real = insertFile(room.db, "Real.md", "text/markdown", Buffer.from("x"), "real body", "user");
    const empty = insertFile(room.db, "Empty.md", "text/markdown", Buffer.from("x"), "   ", "user");
    const [label, text] = gatherFilesText(room.db, ["not-a-real-id", empty.id, real.id]);
    expect(label).toBe("Real");
    expect(text).toContain("real body");
  });

  it("refuses when the mentioned files have no readable text at all", () => {
    const room = freshRoom();
    expect(() => gatherFilesText(room.db, ["nope"])).toThrow(
      "The files you mentioned have no readable text to work with."
    );
  });
});

// ============================================================================
// aiAction
// ============================================================================

describe("aiAction", () => {
  it('rejects an unknown action id verbatim: `"{action}" isn\'t a known AI action.`', async () => {
    const room = freshRoom();
    const deps = baseDeps({ rooms: fakeRooms(room) });
    await expect(aiAction(deps, "not_a_real_action", null, null, null, null, null)).rejects.toThrow(
      '"not_a_real_action" isn\'t a known AI action.'
    );
  });

  it("refuses while a rollback is in flight, before touching the room", async () => {
    const deps = baseDeps({ rooms: fakeRooms(null, true) });
    await expect(aiAction(deps, "summarize", null, null, null, null, null)).rejects.toThrow(
      "The room is rolling back — try again in a moment."
    );
  });

  it("throws 'No room is open.' when there is none", async () => {
    const deps = baseDeps({ rooms: fakeRooms(null) });
    await expect(aiAction(deps, "summarize", null, null, null, null, null)).rejects.toThrow(
      "No room is open."
    );
  });

  it("throws the local-AI-down message when no model resolves", async () => {
    const room = freshRoom();
    insertFile(room.db, "A.md", "text/markdown", Buffer.from("x"), "some body text", "user");
    const deps = baseDeps({ rooms: fakeRooms(room), listModels: async () => [] });
    await expect(aiAction(deps, "summarize", null, null, null, null, null)).rejects.toThrow(
      "The local AI (Ollama) isn't running — start it and try again."
    );
  });

  it("refs win over scope when refs is non-empty", async () => {
    const room = freshRoom();
    const scoped = insertFile(room.db, "Scoped.md", "text/markdown", Buffer.from("x"), "scoped body", "user");
    const referenced = insertFile(room.db, "Ref.md", "text/markdown", Buffer.from("x"), "ref body", "user");
    let sentText: string | undefined;
    const deps = baseDeps({
      rooms: fakeRooms(room),
      post: fakePost((_p, body) => {
        sentText = (body as { text: string }).text;
        return valueOutcome({ markdown: "# ok" });
      }),
    });
    await aiAction(deps, "summarize", scoped.id, [referenced.id], null, null, null);
    expect(sentText).toContain("ref body");
    expect(sentText).not.toContain("scoped body");
  });

  it("an empty refs array falls through to scope, not an error about empty refs", async () => {
    const room = freshRoom();
    const scoped = insertFile(room.db, "Scoped.md", "text/markdown", Buffer.from("x"), "scoped body", "user");
    let sentText: string | undefined;
    const deps = baseDeps({
      rooms: fakeRooms(room),
      post: fakePost((_p, body) => {
        sentText = (body as { text: string }).text;
        return valueOutcome({ markdown: "# ok" });
      }),
    });
    await aiAction(deps, "summarize", scoped.id, [], null, null, null);
    expect(sentText).toContain("scoped body");
  });

  it("saves the sidecar's markdown as a new file and emits room-files-changed + agent-open-file", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const sender = recordingSender();
    const deps = baseDeps({
      rooms: fakeRooms(room),
      send: sender.send,
      post: fakePost(valueOutcome({ markdown: "# The summary" })),
    });
    const meta = await aiAction(deps, "summarize", file.id, null, null, null, null);
    expect(meta.name).toBe("Summarize - Src.md");
    expect(meta.mimeType).toBe("text/markdown");
    const events = sender.events.map(([e]) => e);
    expect(events).toContain("ask-step");
    expect(events).toContain("room-files-changed");
    expect(events).toContain("agent-open-file");
    const opened = sender.events.find(([e]) => e === "agent-open-file")!;
    expect((opened[1] as { id: string }).id).toBe(meta.id);
  });

  it("names the local-model step chip with the action title alone", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const sender = recordingSender();
    const deps = baseDeps({
      rooms: fakeRooms(room),
      send: sender.send,
      listModels: async () => ["qwen3.5:4b"],
      post: fakePost(valueOutcome({ markdown: "# ok" })),
    });
    await aiAction(deps, "summarize", file.id, null, null, null, null);
    const step = sender.events.find(([e]) => e === "ask-step")!;
    // `emitUnowned` wraps the payload in the shared `{runId, chatId, v}`
    // envelope with null ids — an AI action belongs to no conversation.
    expect(step[1]).toEqual({ runId: null, chatId: null, v: "Summarize" });
  });

  it("names the cloud-model step chip with the 'leaves this Mac' wording", async () => {
    const room = freshRoom();
    setSetting(room.db, "model", "claude-cli");
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const sender = recordingSender();
    const deps = baseDeps({
      rooms: fakeRooms(room),
      send: sender.send,
      post: fakePost(valueOutcome({ markdown: "# ok" })),
    });
    await aiAction(deps, "summarize", file.id, null, null, null, null);
    const step = sender.events.find(([e]) => e === "ask-step")!;
    expect(step[1]).toEqual({
      runId: null,
      chatId: null,
      v: "Summarize — your cloud AI is working (content leaves this Mac)…",
    });
  });

  it("uses the resolved model and instructions in the sidecar body, question passed through", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    let body: Record<string, unknown> | undefined;
    const deps = baseDeps({
      rooms: fakeRooms(room),
      post: fakePost((_p, b) => {
        body = b as Record<string, unknown>;
        return valueOutcome({ markdown: "# ok" });
      }),
    });
    await aiAction(deps, "research", null, [file.id], "Look for X", "What is X?", null);
    expect(body?.model).toBe("qwen3.5:4b");
    expect(body?.action).toBe("research");
    expect(body?.instructions).toBe("Look for X");
    expect(body?.question).toBe("What is X?");
    expect(body?.base_url).toEqual(expect.any(String));
  });

  it("surfaces UNKNOWN_ACTION / NEEDS_LANGUAGE / EMPTY_RESULT verbatim, not through the sentinel", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    for (const code of ["UNKNOWN_ACTION", "NEEDS_LANGUAGE", "EMPTY_RESULT"]) {
      const deps = baseDeps({
        rooms: fakeRooms(room),
        post: fakePost(errorOutcome(code, `${code} says so`)),
      });
      await expect(aiAction(deps, "translate", file.id, null, null, null, null)).rejects.toThrow(
        `${code} says so`
      );
    }
  });

  it("maps any other sidecar error through the sentinel (OLLAMA_DOWN)", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const deps = baseDeps({
      rooms: fakeRooms(room),
      post: fakePost(errorOutcome("OLLAMA_DOWN", "connection refused")),
    });
    await expect(aiAction(deps, "summarize", file.id, null, null, null, null)).rejects.toThrow(
      "OLLAMA_DOWN"
    );
  });

  it("maps a MODEL_MISSING error to the model-tagged sentinel", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const deps = baseDeps({
      rooms: fakeRooms(room),
      post: fakePost(errorOutcome("MODEL_MISSING", "no such model")),
    });
    await expect(aiAction(deps, "summarize", file.id, null, null, null, null)).rejects.toThrow(
      "MODEL_MISSING:qwen3.5:4b"
    );
  });

  it("a stopped sidecar call reports the result as not saved", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const deps = baseDeps({
      rooms: fakeRooms(room),
      post: fakePost({ kind: "stopped" }),
    });
    await expect(aiAction(deps, "summarize", file.id, null, null, null, null)).rejects.toThrow(
      "Stopped — the Summarize result was not saved."
    );
  });

  it("a Stop that lands between the answer arriving and the save writes nothing", async () => {
    // The whole point of `guardCommit`'s post-value check: the cancel flag
    // flips WHILE the network call is in flight (simulated here by the fake
    // `post` flipping the SAME flag it was handed), so by the time the value
    // comes back the write must be refused even though the sidecar answered.
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const deps = baseDeps({
      rooms: fakeRooms(room),
      post: async (_path: string, _body: unknown, cancel: CancelFlag) => {
        cancel.store(true);
        return valueOutcome({ markdown: "# should not be saved" });
      },
    });
    await expect(aiAction(deps, "summarize", file.id, null, null, null, null)).rejects.toThrow(
      "Stopped — the Summarize result was not saved."
    );
    const { listFiles } = await import("./db-host/files.js");
    const names = listFiles(room.db).map((f) => f.name);
    expect(names).not.toContain("Summarize - Src.md");
  });

  it("an empty markdown field is refused at the write funnel, not silently saved", async () => {
    // `db-host/artifacts.ts::stageArtifact` refuses zero-byte content —
    // ported verbatim from `db/artifacts.rs`'s own guard ("an empty file
    // would look like finished work") — so a `{markdown: ""}` reply from the
    // sidecar must surface that refusal rather than create an empty file.
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const deps = baseDeps({ rooms: fakeRooms(room), post: fakePost(valueOutcome({})) });
    await expect(aiAction(deps, "summarize", file.id, null, null, null, null)).rejects.toThrow(
      "Nothing was generated"
    );
    const { listFiles } = await import("./db-host/files.js");
    expect(listFiles(room.db).map((f) => f.name)).not.toContain("Summarize - Src.md");
  });

  it("registers opId in the cancel registry during the run and forgets it on every exit path", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const cancelState: CancelState = createCancelState();
    let sawRegistered = false;
    const deps = baseDeps({
      rooms: fakeRooms(room),
      cancelState,
      post: fakePost((_p, _b) => {
        sawRegistered = cancelState.cancels.has("op-1") && cancelState.cancelTree.has("op-1");
        return valueOutcome({ markdown: "# ok" });
      }),
    });
    await aiAction(deps, "summarize", file.id, null, null, null, "op-1");
    expect(sawRegistered).toBe(true);
    expect(cancelState.cancels.has("op-1")).toBe(false);
    expect(cancelState.cancelTree.has("op-1")).toBe(false);
  });

  it("forgets opId even when the run throws", async () => {
    const room = freshRoom();
    const cancelState: CancelState = createCancelState();
    const deps = baseDeps({ rooms: fakeRooms(room), cancelState });
    await expect(aiAction(deps, "not_real", null, null, null, null, "op-2")).rejects.toThrow();
    expect(cancelState.cancels.has("op-2")).toBe(false);
    expect(cancelState.cancelTree.has("op-2")).toBe(false);
  });

  it("a null opId never touches either cancel registry", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const cancelState: CancelState = createCancelState();
    const sizeBefore = cancelState.cancels.size;
    const deps = baseDeps({
      rooms: fakeRooms(room),
      cancelState,
      post: fakePost(valueOutcome({ markdown: "# ok" })),
    });
    await aiAction(deps, "summarize", file.id, null, null, null, null);
    expect(cancelState.cancels.size).toBe(sizeBefore);
  });

  it("cancelling the run's own opId from the outside stops the in-flight sidecar call", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");
    const cancelState: CancelState = createCancelState();
    const deps = baseDeps({
      rooms: fakeRooms(room),
      cancelState,
      post: async (_path: string, _body: unknown, cancel: CancelFlag) => {
        // Simulate a Stop button pressed against this run's registered flag
        // while the network call is "in flight".
        cancelState.cancels.get("op-3")!.store(true);
        return { kind: "stopped" as const };
      },
    });
    await expect(aiAction(deps, "summarize", file.id, null, null, null, "op-3")).rejects.toThrow(
      "Stopped — the Summarize result was not saved."
    );
  });

  it("real network: POSTs to /ai_action and saves the returned markdown", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "source body", "user");

    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        expect(req.url).toBe("/ai_action");
        const parsed = JSON.parse(raw);
        expect(parsed.action).toBe("summarize");
        expect(parsed.text).toContain("source body");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ markdown: "# Real network summary" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      const deps = baseDeps({ rooms: fakeRooms(room) });
      const meta = await aiAction(deps, "summarize", file.id, null, null, null, null);
      expect(meta.name).toBe("Summarize - Src.md");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ============================================================================
// memorySuggestion
// ============================================================================

describe("memorySuggestion", () => {
  it("not worth remembering when the chat has no messages at all", async () => {
    const room = freshRoom();
    const deps: AiSidecarDeps = { rooms: fakeRooms(room) };
    const result = await memorySuggestion(deps, "chat-1");
    expect(result).toEqual({ worth: false, fact: "" });
  });

  it("not worth remembering when there is no assistant reply yet", async () => {
    const room = freshRoom();
    insertMessage(room.db, "chat-1", "user", "Hello", [], null);
    const result = await memorySuggestion({ rooms: fakeRooms(room) }, "chat-1");
    expect(result).toEqual({ worth: false, fact: "" });
  });

  it("not worth remembering when the assistant's reply is one of the app's own failure notices", async () => {
    const room = freshRoom();
    insertMessage(room.db, "chat-1", "user", "What is our revenue?", [], null);
    insertMessage(
      room.db,
      "chat-1",
      "assistant",
      "*(The agent hit an error and stopped mid-run: timeout. Any change shown here was already applied.)*",
      [],
      null
    );
    const post = vi.fn();
    const result = await memorySuggestion({ rooms: fakeRooms(room), post }, "chat-1");
    expect(result).toEqual({ worth: false, fact: "" });
    expect(post).not.toHaveBeenCalled();
  });

  it("degrades to not-worth when no model resolves", async () => {
    const room = freshRoom();
    insertMessage(room.db, "chat-1", "user", "Q", [], null);
    insertMessage(room.db, "chat-1", "assistant", "A", [], null);
    const result = await memorySuggestion(
      { rooms: fakeRooms(room), listModels: async () => [] },
      "chat-1"
    );
    expect(result).toEqual({ worth: false, fact: "" });
  });

  it("returns the sidecar's worth/fact on success, using the LAST user/assistant pair", async () => {
    const room = freshRoom();
    insertMessage(room.db, "chat-1", "user", "old question", [], null);
    insertMessage(room.db, "chat-1", "assistant", "old answer", [], null);
    insertMessage(room.db, "chat-1", "user", "The deploy runs every Tuesday at 9am.", [], null);
    insertMessage(room.db, "chat-1", "assistant", "Got it, noted.", [], null);
    let sentUser: string | undefined;
    let sentAssistant: string | undefined;
    const deps: AiSidecarDeps = {
      rooms: fakeRooms(room),
      listModels: async () => ["qwen3.5:4b"],
      post: fakePost((_p, b) => {
        const body = b as { user_text: string; assistant_text: string };
        sentUser = body.user_text;
        sentAssistant = body.assistant_text;
        return valueOutcome({ worth: true, fact: "The deploy runs every Tuesday at 9am." });
      }),
    };
    const result = await memorySuggestion(deps, "chat-1");
    expect(result).toEqual({ worth: true, fact: "The deploy runs every Tuesday at 9am." });
    expect(sentUser).toBe("The deploy runs every Tuesday at 9am.");
    expect(sentAssistant).toBe("Got it, noted.");
  });

  it("strips viewer markup blocks before sending", async () => {
    const room = freshRoom();
    insertMessage(room.db, "chat-1", "user", "draw a box\n```boxes\n[1,2,3]\n```", [], null);
    insertMessage(room.db, "chat-1", "assistant", "Done.\n```annotation\n{}\n```", [], null);
    let sentUser: string | undefined;
    const deps: AiSidecarDeps = {
      rooms: fakeRooms(room),
      listModels: async () => ["qwen3.5:4b"],
      post: fakePost((_p, b) => {
        sentUser = (b as { user_text: string }).user_text;
        return valueOutcome({ worth: false, fact: "" });
      }),
    };
    await memorySuggestion(deps, "chat-1");
    expect(sentUser).toBe("draw a box");
  });

  it("degrades to not-worth on any sidecar failure", async () => {
    const room = freshRoom();
    insertMessage(room.db, "chat-1", "user", "Q", [], null);
    insertMessage(room.db, "chat-1", "assistant", "A", [], null);
    const post = vi.fn(fakePost(errorOutcome("ENGINE_ERROR", "boom")));
    const deps: AiSidecarDeps = { rooms: fakeRooms(room), listModels: async () => ["qwen3.5:4b"], post };
    const result = await memorySuggestion(deps, "chat-1");
    expect(result).toEqual({ worth: false, fact: "" });
    expect(post).toHaveBeenCalled();
  });
});

// ============================================================================
// suggestFileMeta
// ============================================================================

describe("suggestFileMeta", () => {
  it("echoes the current name when the text is under 80 characters", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "quarterly-report-final.md", "text/markdown", Buffer.from("x"), "too short", "user");
    const result = await suggestFileMeta({ rooms: fakeRooms(room) }, file.id);
    expect(result).toEqual({ title: "quarterly-report-final", folder: "", tags: [] });
  });

  it("echoes when no model resolves", async () => {
    const room = freshRoom();
    const file = insertFile(
      room.db,
      "notes.md",
      "text/markdown",
      Buffer.from("x"),
      "x".repeat(200),
      "user"
    );
    const result = await suggestFileMeta({ rooms: fakeRooms(room), listModels: async () => [] }, file.id);
    expect(result).toEqual({ title: "notes", folder: "", tags: [] });
  });

  it("returns the sidecar's title/folder/tags on success", async () => {
    const room = freshRoom();
    const file = insertFile(
      room.db,
      "untitled.md",
      "text/markdown",
      Buffer.from("x"),
      "x".repeat(200),
      "user"
    );
    const deps: AiSidecarDeps = {
      rooms: fakeRooms(room),
      listModels: async () => ["qwen3.5:4b"],
      post: fakePost(
        valueOutcome({ title: "Q3 Revenue Report", folder: "Finance", tags: ["q3", "revenue", 42, null] })
      ),
    };
    const result = await suggestFileMeta(deps, file.id);
    expect(result).toEqual({ title: "Q3 Revenue Report", folder: "Finance", tags: ["q3", "revenue"] });
  });

  it("echoes on any sidecar failure", async () => {
    const room = freshRoom();
    const file = insertFile(
      room.db,
      "untitled.md",
      "text/markdown",
      Buffer.from("x"),
      "x".repeat(200),
      "user"
    );
    const post = vi.fn(fakePost({ kind: "stopped" }));
    const deps: AiSidecarDeps = { rooms: fakeRooms(room), listModels: async () => ["qwen3.5:4b"], post };
    const result = await suggestFileMeta(deps, file.id);
    expect(result).toEqual({ title: "untitled", folder: "", tags: [] });
    expect(post).toHaveBeenCalled();
  });
});

// ============================================================================
// generateUiText
// ============================================================================

describe("generateUiText", () => {
  it("degrades to null when no model resolves — no room needed at all", async () => {
    const deps: AiSidecarDeps = { rooms: fakeRooms(null), listModels: async () => [] };
    const result = await generateUiText(deps, "dek", "Write one sentence.", { count: 3 }, 20);
    expect(result).toBeNull();
  });

  it("returns the sidecar's text on success", async () => {
    const deps: AiSidecarDeps = {
      rooms: fakeRooms(null),
      listModels: async () => ["qwen3.5:4b"],
      post: fakePost(valueOutcome({ text: "Three new files this week." })),
    };
    const result = await generateUiText(deps, "dek", "Write one sentence.", { count: 3 }, 20);
    expect(result).toBe("Three new files this week.");
  });

  it("returns null when the sidecar's own validation rejected the result (text: null)", async () => {
    const deps: AiSidecarDeps = {
      rooms: fakeRooms(null),
      listModels: async () => ["qwen3.5:4b"],
      post: fakePost(valueOutcome({ text: null })),
    };
    const result = await generateUiText(deps, "dek", "Write one sentence.", {}, 20);
    expect(result).toBeNull();
  });

  it("degrades to null on any sidecar failure, never throwing", async () => {
    const post = vi.fn(fakePost(errorOutcome("ENGINE_ERROR", "boom")));
    const deps: AiSidecarDeps = { rooms: fakeRooms(null), listModels: async () => ["qwen3.5:4b"], post };
    const result = await generateUiText(deps, "dek", "Write one sentence.", {}, 20);
    expect(result).toBeNull();
    expect(post).toHaveBeenCalled();
  });

  it("real network: an unreachable sidecar degrades to null, never an error", async () => {
    // Mirrors the Rust suite's own
    // `generate_ui_text_degrades_to_ok_none_when_the_sidecar_is_unreachable`:
    // a `cargo test` run has no bundled sidecar; here, `ensureUp` rejecting
    // is the equivalent "AI helper never started" case.
    vi.mocked(ensureUp).mockRejectedValue(new Error("no bundled binary in Resources/."));
    const deps: AiSidecarDeps = { rooms: fakeRooms(null) };
    const result = await generateUiText(deps, "dek", "Write one sentence, max 20 words.", { count: 3 }, 20);
    expect(result).toBeNull();
  });
});

// ============================================================================
// registerMoonshotAiActionsIpc — declared, not wired (rule 4)
// ============================================================================

describe("registerMoonshotAiActionsIpc", () => {
  function fakeIpcMain(): { handle: ReturnType<typeof vi.fn>; handlers: Map<string, (...a: unknown[]) => unknown> } {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const handle = vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    });
    return { handle, handlers };
  }

  it("registers exactly the five channels this file owns", () => {
    const room = freshRoom();
    const { handle, handlers } = fakeIpcMain();
    registerMoonshotAiActionsIpc({ handle }, baseDeps({ rooms: fakeRooms(room) }));
    expect([...handlers.keys()].sort()).toEqual(
      ["ai_action", "ai_action_prompts", "generate_ui_text", "memory_suggestion", "suggest_file_meta"].sort()
    );
  });

  it("ai_action_prompts forwards to the real catalog", async () => {
    const room = freshRoom();
    const { handle, handlers } = fakeIpcMain();
    registerMoonshotAiActionsIpc({ handle }, baseDeps({ rooms: fakeRooms(room) }));
    const result = await handlers.get("ai_action_prompts")!({}, {});
    expect(Array.isArray(result) ? result : []).toHaveLength(14);
  });

  it("ai_action forwards every field in the args object positionally", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "Src.md", "text/markdown", Buffer.from("x"), "body text", "user");
    const { handle, handlers } = fakeIpcMain();
    registerMoonshotAiActionsIpc(
      { handle },
      baseDeps({ rooms: fakeRooms(room), post: fakePost(valueOutcome({ markdown: "# ok" })) })
    );
    const meta = (await handlers.get("ai_action")!({}, {
      action: "summarize",
      scope: file.id,
      refs: null,
      instructions: null,
      question: null,
      opId: null,
    })) as { name: string };
    expect(meta.name).toBe("Summarize - Src.md");
  });

  it("memory_suggestion / suggest_file_meta / generate_ui_text forward their args", async () => {
    const room = freshRoom();
    insertMessage(room.db, "chat-1", "user", "Q", [], null);
    insertMessage(room.db, "chat-1", "assistant", "A", [], null);
    const file = insertFile(room.db, "F.md", "text/markdown", Buffer.from("x"), "short", "user");
    const { handle, handlers } = fakeIpcMain();
    registerMoonshotAiActionsIpc({ handle }, baseDeps({ rooms: fakeRooms(room) }));

    const mem = (await handlers.get("memory_suggestion")!({}, { chatId: "chat-1" })) as {
      worth: boolean;
    };
    expect(mem.worth).toBe(false);

    const meta = (await handlers.get("suggest_file_meta")!({}, { fileId: file.id })) as { title: string };
    expect(meta.title).toBe("F");

    const text = await handlers.get("generate_ui_text")!({}, {
      kind: "dek",
      prompt: "p",
      facts: {},
      maxWords: 20,
    });
    // No `post` override here, and the default sidecar is unreachable in this
    // test process — degrades to `null`, never throws.
    expect(text).toBeNull();
  });
});

// ============================================================================
// ADVERSARIAL — a polluted Object.prototype is NOT an answer from the sidecar
// ============================================================================

describe("sidecar replies are read as own properties only", () => {
  // Rust reads `v["markdown"]` / `v["worth"]` / `v["title"]` off a
  // `serde_json::Value`, which has no prototype chain at all. A bare
  // `v.markdown` on a `JSON.parse` result inherits from `Object.prototype`,
  // and this codebase has found a `"__proto__"`-keyed write polluting it FIVE
  // times. The consequences here are not cosmetic — they are the app
  // asserting, in the room and in the UI, something no model ever said.
  const proto = Object.prototype as unknown as Record<string, unknown>;
  const polluted = ["markdown", "worth", "fact", "title", "folder", "tags", "text"];

  afterEach(() => {
    for (const key of polluted) {
      delete proto[key];
    }
  });

  /** A reply object with NO own properties, exactly what the sidecar returns
   * when its own guards rejected the generation (`{}`). */
  function emptyReply(): unknown {
    return JSON.parse("{}");
  }

  it("ai_action does not SAVE inherited markdown into the room as the model's answer", async () => {
    const room = freshRoom();
    insertFile(room.db, "lease.txt", "text/plain", Buffer.from("x"), "the lease body", "upload");
    proto["markdown"] = "# Fabricated\n\nThe deposit is $9,999.";
    // With `v["markdown"]` read as an OWN property (Rust: a `serde_json::Value`
    // index, which cannot inherit), an empty reply stays empty — and an empty
    // artifact is refused by the same `stage_artifact` guard Rust has
    // (`db/artifacts.rs`: "Nothing was generated … an empty file would look
    // like finished work"). Reading the inherited value instead SAVED the
    // fabricated markdown into the room as the model's answer.
    await expect(
      aiAction(
        baseDeps({ rooms: fakeRooms(room), post: fakePost(valueOutcome(emptyReply())) }),
        "summarize",
        null,
        null,
        null,
        null,
        null
      )
    ).rejects.toThrow(/Nothing was generated/);
    expect(listFiles(room.db).some((f) => f.name.startsWith("Summarize - "))).toBe(false);
  });

  it("memory_suggestion does not offer an inherited fact behind a one-click Save", async () => {
    // The Rust doc comment on this command records the live-QA failure it
    // exists to prevent: a chip offering to save "The room's revenue is 0.",
    // a figure in none of the room's files. Prototype pollution is the same
    // failure by another route.
    const room = freshRoom();
    insertMessage(room.db, "chat-1", "user", "what is the revenue?", [], null);
    insertMessage(room.db, "chat-1", "assistant", "It is in the Q3 deck.", [], null);
    proto["worth"] = true;
    proto["fact"] = "The room's revenue is 0.";
    await expect(
      memorySuggestion(
        { rooms: fakeRooms(room), listModels: async () => ["qwen3.5:4b"], post: fakePost(valueOutcome(emptyReply())) },
        "chat-1"
      )
    ).resolves.toEqual({ worth: false, fact: "" });
  });

  it("suggest_file_meta does not propose an inherited title/folder/tags", async () => {
    const room = freshRoom();
    const f = insertFile(room.db, "note.md", "text/markdown", Buffer.from("x"), "y".repeat(200), "upload");
    proto["title"] = "Confidential payroll";
    proto["folder"] = "HR";
    proto["tags"] = ["salaries"];
    await expect(
      suggestFileMeta(
        { rooms: fakeRooms(room), listModels: async () => ["qwen3.5:4b"], post: fakePost(valueOutcome(emptyReply())) },
        f.id
      )
    ).resolves.toEqual({ title: "", folder: "", tags: [] });
  });

  it("generate_ui_text does not render inherited text as a model-authored line", async () => {
    const room = freshRoom();
    proto["text"] = "Your room is empty.";
    await expect(
      generateUiText(
        { rooms: fakeRooms(room), listModels: async () => ["qwen3.5:4b"], post: fakePost(valueOutcome(emptyReply())) },
        "dek",
        "Write one sentence.",
        {},
        20
      )
    ).resolves.toBeNull();
  });
});
