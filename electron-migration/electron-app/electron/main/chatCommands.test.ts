/**
 * Tests for `chatCommands.ts`: the `CHAT_COMMANDS` catalog, the full-ops
 * window/history helpers, the quiet-step/streaming-idle helpers, the
 * `watchStream` watchdog, `CmdCtx`'s engine-calling methods, and the
 * `runCommand` dispatcher end to end. Reproduces all three of
 * `chat_commands.rs`'s own `#[cfg(test)]` modules
 * (`full_ops_tests`/`quiet_step_tests`/`stream_watchdog_tests`), plus new
 * coverage for the dispatcher itself.
 *
 * Real fixture rooms (`db-host/open.ts`'s `createRoom`), real `cancel.ts`
 * state, real `turn.ts` envelopes — this repo's convention: real behavior
 * over mocks wherever a real dependency is already ported.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CancelFlag, createCancelState, type CancelState } from "./cancel.js";

// `defaultStreamGenerate` reaches `chatCommandsGenerate.ts`'s REAL
// `/generate_stream` client, whose first step is `sidecar.ts`'s `ensureUp()`.
// Only that one export is replaced (`chatCommandsKnowledge.test.ts`'s own
// established convention) so no test in this file can spawn a real sidecar.
vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});
import { ensureUp } from "./sidecar.js";

import {
  CHAT_COMMANDS,
  CMD_WINDOW_CHARS,
  CMD_WINDOW_OVERLAP,
  COMMAND_STREAM_IDLE_CLI_SECS,
  COMMAND_STREAM_IDLE_SECS,
  CmdCtx,
  cmdWindows,
  defaultCommandResult,
  defaultStreamGenerate,
  formatHistory,
  listChatCommands,
  notImplementedChatCommandHandler,
  quietStepText,
  runCommand,
  streamIdleSecs,
  watchStream,
  type CommandResult,
  type RunCommandDeps,
  type StreamGenerateFn,
} from "./chatCommands.js";
import { insertMessage, listMessages } from "./db-host/messages.js";
import { listFiles } from "./db-host/files.js";
import { listMemories } from "./db-host/memories.js";
import { createRoom } from "./db-host/open.js";
import { setSetting } from "./db-host/settings.js";
import {
  chatStructured as chatStructuredReal,
  generate as generateReal,
  type GenerateOpts,
} from "./ollamaGenerate.js";
import { createRoomManagerState, type RoomManagerState } from "./roomManager.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { TurnId } from "./turn.js";
import type { TurnRoomSource } from "./turnEngine.js";

// ------------------------------------------------------------------ fixtures

const tmpDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const PASSWORD = "correct horse battery staple";

/** A real fixture room, opened both as a `TurnRoomSource` (for `deps.room`)
 * and as a `RoomManagerState` (for `deps.checkpointState`) — the SAME
 * underlying connection, matching the module doc's "TWO PARTIAL AppState
 * SHAPES" note. */
function freshRoom(): { db: Database.Database; room: TurnRoomSource; checkpointState: RoomManagerState; path: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chat-commands-"));
  tmpDirs.push(dir);
  const roomPath = path.join(dir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  const db = createRoom(roomPath, PASSWORD, "Test Room");
  const room: TurnRoomSource = {
    roomEpoch: () => 1,
    currentRoomPath: () => roomPath,
    currentRoom: () => ({ db, path: roomPath }),
  };
  const checkpointState = createRoomManagerState();
  checkpointState.room = { conn: db, path: roomPath, name: "Test Room", password: PASSWORD };
  return { db, room, checkpointState, path: roomPath };
}

function recordingSender(): { send: (event: string, payload: unknown) => void; events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  return { send: (event, payload) => events.push([event, payload]), events };
}

function baseDeps(fixture: ReturnType<typeof freshRoom>, overrides: Partial<RunCommandDeps> = {}): RunCommandDeps {
  return {
    room: fixture.room,
    cancelState: createCancelState(),
    send: () => {},
    checkpointState: fixture.checkpointState,
    listModels: async () => ["qwen3.5:4b"],
    ...overrides,
  };
}

// ============================================================================
// CHAT_COMMANDS / listChatCommands
// ============================================================================

describe("CHAT_COMMANDS", () => {
  it("has all thirteen model-invoked commands plus #checkpoint", () => {
    expect(CHAT_COMMANDS).toHaveLength(14);
    const names = CHAT_COMMANDS.map((c) => c.name);
    expect(names).toEqual([
      "add-file",
      "remember",
      "find",
      "highlight",
      "extract",
      "summarize",
      "compare",
      "transcribe",
      "sketch",
      "minutes",
      "to-sheet",
      "translate",
      "research",
      "checkpoint",
    ]);
  });

  it("#checkpoint's summary/usage match the no-model, one-click 'commit'", () => {
    const checkpoint = CHAT_COMMANDS.find((c) => c.name === "checkpoint");
    expect(checkpoint?.summary).toBe("Save a named checkpoint of the whole room (roll back later in Settings)");
    expect(checkpoint?.usage).toBe("#checkpoint   ·   #checkpoint before cleanup");
  });

  it("listChatCommands returns fresh copies the caller cannot mutate the catalog through", () => {
    const first = listChatCommands();
    first[0]!.name = "tampered";
    first.length = 0;
    expect(CHAT_COMMANDS[0]!.name).toBe("add-file");
    expect(listChatCommands()).toHaveLength(14);
  });
});

// ============================================================================
// full_ops_tests — ported verbatim from chat_commands.rs
// ============================================================================

describe("cmdWindows", () => {
  it("a short source is a single window", () => {
    const text = "a short meeting transcript";
    expect(cmdWindows(text)).toEqual([text]);
    expect(cmdWindows("   ")).toEqual([]);
  });

  it("a long source is covered end to end", () => {
    let body = "";
    for (let i = 0; i < 4000; i++) {
      body += `[00:${String(i % 60).padStart(2, "0")}] speaker ${i}: line number ${i}\n`;
    }
    const text = `${body}FINAL LINE: the meeting ended.`;
    const windows = cmdWindows(text);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[windows.length - 1]).toContain("FINAL LINE");
    const joined = windows.join("");
    for (const probe of ["line number 0", "line number 1999", "line number 3999"]) {
      expect(joined).toContain(probe);
    }
  });

  it("windows stay within one pass", () => {
    const text = "sentence. ".repeat(20_000);
    for (const w of cmdWindows(text)) {
      expect(Buffer.byteLength(w, "utf8")).toBeLessThanOrEqual(CMD_WINDOW_CHARS + CMD_WINDOW_OVERLAP);
    }
  });
});

// ============================================================================
// quiet_step_tests — ported verbatim
// ============================================================================

describe("quietStepText", () => {
  it("a quiet step never carries the model's reasoning", () => {
    expect(
      quietStepText("<think>The user wants French. Careful with the idiom.</think>\nBonjour le monde.")
    ).toBe("Bonjour le monde.");
    // Unterminated: everything after the opening tag is reasoning.
    expect(quietStepText("<think>still thinking about it")).toBe("");
    expect(quietStepText("  Plain answer.  ")).toBe("Plain answer.");
  });
});

// ============================================================================
// streamIdleSecs
// ============================================================================

describe("streamIdleSecs", () => {
  it("a cloud CLI is not judged by a streaming clock", () => {
    for (const m of ["claude-cli", "codex-cli::gpt-5.6-sol", "claude-cli::opus::high"]) {
      expect(streamIdleSecs(m)).toBeGreaterThan(900);
      expect(streamIdleSecs(m)).toBe(COMMAND_STREAM_IDLE_CLI_SECS);
    }
    for (const m of ["qwen3.5:4b", "minimax-m3:cloud", "openrouter::vendor/model"]) {
      expect(streamIdleSecs(m)).toBe(COMMAND_STREAM_IDLE_SECS);
    }
  });
});

// ============================================================================
// formatHistory
// ============================================================================

describe("formatHistory", () => {
  it("skips a message that strips to blank, and trims the whole result", () => {
    const out = formatHistory([
      ["user", "```boxes\n[1,2,3]\n```"],
      ["assistant", "Hello there."],
    ]);
    expect(out).toBe("[assistant]\nHello there.");
  });

  it("formats every kept message as [role]\\ncontent", () => {
    const out = formatHistory([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    expect(out).toBe("[user]\nhi\n\n[assistant]\nhello");
  });
});

// ============================================================================
// stream_watchdog_tests — ported verbatim
// ============================================================================

describe("watchStream", () => {
  function never(): Promise<string> {
    return new Promise(() => {});
  }

  it("stop keeps the partial the user already saw", async () => {
    vi.useFakeTimers();
    const cancel = new CancelFlag();
    cancel.store(true);
    const lastToken = { value: Date.now() };
    const partial = { value: "half an answer already on screen" };
    const pending = watchStream(never(), cancel, lastToken, partial, 300, 0);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBe("half an answer already on screen");
  });

  it("a silent stream still gets hung up on", async () => {
    vi.useFakeTimers();
    const cancel = new CancelFlag();
    const lastToken = { value: Date.now() };
    const partial = { value: "" };
    const pending = watchStream(never(), cancel, lastToken, partial, 0, 1_500);
    // Attach the rejection assertion BEFORE advancing the fake clock, so the
    // rejection is never briefly unhandled between the timer firing and the
    // assertion subscribing to it.
    const assertion = expect(pending).rejects.toThrow(/stopped responding/);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it("resolves with the future's own value on a clean finish", async () => {
    const cancel = new CancelFlag();
    const lastToken = { value: Date.now() };
    const partial = { value: "" };
    await expect(watchStream(Promise.resolve("full answer"), cancel, lastToken, partial, 300, 0)).resolves.toBe(
      "full answer"
    );
  });
});

// ============================================================================
// CmdCtx
// ============================================================================

function makeCtx(opts: {
  generate?: (
    model: string,
    messages: readonly SidecarChatMessage[],
    temperature: number | null,
    keepAlive: string,
    opts?: GenerateOpts
  ) => Promise<string>;
  chatStructured?: (
    model: string,
    messages: readonly SidecarChatMessage[],
    temperature: number | null,
    keepAlive: string,
    schema: unknown,
    opts?: unknown
  ) => Promise<string>;
  streamGenerate?: StreamGenerateFn;
  cancel?: CancelFlag;
  send?: (event: string, payload: unknown) => void;
}): CmdCtx {
  const cancel = opts.cancel ?? new CancelFlag();
  return new CmdCtx({
    model: "qwen3.5:4b",
    refs: [],
    args: "",
    history: "",
    temperature: null,
    cancel,
    turn: new TurnId("ask-1", "chat-1"),
    send: opts.send ?? (() => {}),
    room: { roomEpoch: () => 1, currentRoomPath: () => null, currentRoom: () => null },
    generate: opts.generate as unknown as typeof generateReal,
    chatStructured: opts.chatStructured as unknown as typeof chatStructuredReal,
    streamGenerate: opts.streamGenerate,
  });
}

describe("CmdCtx.askQuiet", () => {
  it("strips a model's <think> preamble from a quiet step", async () => {
    const generate = vi.fn().mockResolvedValue("<think>reasoning</think>Bonjour le monde.");
    const ctx = makeCtx({ generate });
    await expect(ctx.askQuiet("system", "user text", 0.2)).resolves.toBe("Bonjour le monde.");
    expect(generate).toHaveBeenCalledWith(
      "qwen3.5:4b",
      [
        { role: "system", content: "system" },
        { role: "user", content: "user text" },
      ],
      0.2,
      "30m",
      expect.objectContaining({ cancel: expect.any(CancelFlag) })
    );
  });

  it("times out with an actionable message when the model never answers", async () => {
    vi.useFakeTimers();
    const generate = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    const ctx = makeCtx({ generate });
    const pending = ctx.askQuiet("system", "user text", null);
    // Attach the rejection assertion before advancing the clock — see the
    // matching comment on the watchStream "silent stream" test above.
    const assertion = expect(pending).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
  });
});

describe("CmdCtx.askStructured", () => {
  it("passes the schema through to chatStructured with no timeout of its own", async () => {
    const chatStructured = vi.fn().mockResolvedValue('{"ok":true}');
    const ctx = makeCtx({ chatStructured });
    const schema = { type: "object" };
    await expect(ctx.askStructured("sys", "usr", 0.5, schema)).resolves.toBe('{"ok":true}');
    expect(chatStructured).toHaveBeenCalledWith(
      "qwen3.5:4b",
      [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      0.5,
      "30m",
      schema,
      expect.objectContaining({ cancel: expect.any(CancelFlag) })
    );
  });
});

describe("CmdCtx.askStreaming", () => {
  it("emits every delta as ask-delta and resolves the future's own final text", async () => {
    const { send, events } = recordingSender();
    const streamGenerate = vi.fn(
      async (_body: Record<string, unknown>, _cancel: CancelFlag, onDelta: (d: string) => void) => {
        onDelta("Bon");
        onDelta("jour");
        return "Bonjour le monde.";
      }
    );
    const ctx = makeCtx({ streamGenerate, send });
    await expect(ctx.askStreaming("sys", "usr")).resolves.toBe("Bonjour le monde.");
    const deltas = events.filter(([event]) => event === "ask-delta");
    expect(deltas.map(([, payload]) => (payload as { v: string }).v)).toEqual(["Bon", "jour"]);
  });

  it("defaults to the REAL /generate_stream client, not a NOT_IMPLEMENTED stub", async () => {
    // `chatCommandsGenerate.ts` ports `sidecar::generate_stream` for real, so
    // this seam must reach it. Proven without a network: the real client's
    // FIRST step is `ensureUp()`, so a rejecting `ensureUp` comes back as the
    // classified SIDECAR_DOWN sentinel — never the old NOT_IMPLEMENTED
    // refusal, which never touched `ensureUp` at all.
    vi.mocked(ensureUp).mockRejectedValue(new Error("no sidecar in this test"));
    const err = await defaultStreamGenerate({ model: "qwen3.5:4b" }, new CancelFlag(), () => {}).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(ensureUp).toHaveBeenCalled();
    expect(err?.message).not.toMatch(/NOT_IMPLEMENTED/);
    expect(err?.message).toMatch(/no sidecar in this test/);
    vi.mocked(ensureUp).mockReset();
  });

  it("a Stop mid-stream keeps the partial once the grace period elapses", async () => {
    vi.useFakeTimers();
    const cancel = new CancelFlag();
    const streamGenerate = vi.fn(
      async (_body: Record<string, unknown>, _c: CancelFlag, onDelta: (d: string) => void) => {
        onDelta("partial answer");
        cancel.store(true);
        return new Promise<string>(() => {}); // never actually finishes
      }
    );
    const ctx = makeCtx({ streamGenerate, cancel });
    const pending = ctx.askStreaming("sys", "usr");
    // One tick to let streamGenerate emit its delta and flip cancel, then run
    // past the poll cadence + the stop grace period.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe("partial answer");
  });
});

describe("CmdCtx.mapWindows / foldNotes / digest", () => {
  it("mapWindows steps per window only when there is more than one, and counts unread windows", async () => {
    const { send, events } = recordingSender();
    const source = "x".repeat(CMD_WINDOW_CHARS + 1000); // forces >1 window
    let call = 0;
    const generate = vi.fn().mockImplementation(async () => {
      call += 1;
      // The second window's model call comes back empty -> counted unread.
      return call === 2 ? "" : `note ${call}`;
    });
    const ctx = makeCtx({ generate, send });
    const notes = await ctx.mapWindows(source, "Reading", "sys", (w) => w, 0.2);
    expect(notes).toEqual(["note 1"]);
    expect(ctx.unreadCount()).toBe(1);
    const steps = events.filter(([event]) => event === "ask-step").map(([, p]) => (p as { v: string }).v);
    expect(steps).toEqual(["Reading (1/2)", "Reading (2/2)"]);
  });

  it("mapWindows does not step at all for a single-window source", async () => {
    const { send, events } = recordingSender();
    const generate = vi.fn().mockResolvedValue("only note");
    const ctx = makeCtx({ generate, send });
    const notes = await ctx.mapWindows("short source", "Reading", "sys", (w) => w, null);
    expect(notes).toEqual(["only note"]);
    expect(events.filter(([event]) => event === "ask-step")).toHaveLength(0);
  });

  it("a failed window is counted unread, not thrown", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("engine down"));
    const ctx = makeCtx({ generate });
    const notes = await ctx.mapWindows("short source", "Reading", "sys", (w) => w, null);
    expect(notes).toEqual([]);
    expect(ctx.unreadCount()).toBe(1);
  });

  it("foldNotes stops once a round fails to shrink", async () => {
    // Every round echoes back exactly what it was given -> never shrinks.
    const generate = vi.fn().mockImplementation(async (_m: string, messages: SidecarChatMessage[]) => {
      const user = messages[1]!.content;
      return user.replace(/^Notes:\n/, "");
    });
    const ctx = makeCtx({ generate });
    const big = "y".repeat(CMD_WINDOW_CHARS + 500);
    const folded = await ctx.foldNotes([big], "Folding");
    // Stops after the first non-shrinking round rather than looping forever:
    // `text` is only ever reassigned to a round's joined output once that
    // round proved it shrank, so a round that doesn't leaves the ORIGINAL
    // text untouched — never mind that this source needed two window calls
    // (it is 500 bytes over budget) to produce that one non-shrinking round.
    expect(folded).toBe(big);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("digest returns short text unchanged with no model call", async () => {
    const generate = vi.fn();
    const ctx = makeCtx({ generate });
    await expect(ctx.digest("short", "Reading")).resolves.toBe("short");
    expect(generate).not.toHaveBeenCalled();
  });

  it("digest maps then folds a long text", async () => {
    const generate = vi.fn().mockResolvedValue("a short note");
    const ctx = makeCtx({ generate });
    const long = "z".repeat(CMD_WINDOW_CHARS + 1000);
    // Two windows (1000 bytes over budget), one note apiece, joined — already
    // well under CMD_WINDOW_CHARS so foldNotes's own loop never fires.
    await expect(ctx.digest(long, "Reading")).resolves.toBe("a short note\n\na short note");
  });
});

// ============================================================================
// notImplementedChatCommandHandler / defaultCommandResult
// ============================================================================

describe("notImplementedChatCommandHandler", () => {
  it("throws a labeled NOT_IMPLEMENTED refusal naming the command", async () => {
    const handler = notImplementedChatCommandHandler("remember");
    await expect(handler(makeCtx({}))).rejects.toThrow(/NOT_IMPLEMENTED: #remember/);
  });
});

describe("defaultCommandResult", () => {
  it("is empty content, no sources, fresh effects", () => {
    const r = defaultCommandResult();
    expect(r).toEqual({ content: "", sources: [], effects: expect.any(Object) });
    expect(r.effects.wrote).toBe(false);
  });
});

// ============================================================================
// runCommand
// ============================================================================

describe("runCommand", () => {
  it("rejects an unknown command before touching the room", async () => {
    const fixture = freshRoom();
    await expect(
      runCommand(
        { askId: "a1", chatId: "c1", command: "frobnicate", args: "", refs: [], raw: "#frobnicate" },
        baseDeps(fixture)
      )
    ).rejects.toThrow("Unknown command #frobnicate.");
    expect(listMessages(fixture.db, "c1")).toHaveLength(0);
  });

  it("#checkpoint saves a real checkpoint with no model call, and persists the reply", async () => {
    const fixture = freshRoom();
    const listModels = vi.fn();
    const msg = await runCommand(
      {
        askId: "a1",
        chatId: "c1",
        command: "checkpoint",
        args: "before cleanup",
        refs: [],
        raw: "#checkpoint before cleanup",
      },
      baseDeps(fixture, { listModels })
    );
    expect(msg.content).toBe('Saved checkpoint **before cleanup**. Roll back to it in Settings → Checkpoints.');
    expect(msg.role).toBe("assistant");
    // No model was ever probed for a no-model command.
    expect(listModels).not.toHaveBeenCalled();
    // The user's raw line was saved even though no model ran.
    const rows = listMessages(fixture.db, "c1");
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ["user", "#checkpoint before cleanup"],
      ["assistant", msg.content],
    ]);
  });

  it("dispatches to a real injected handler and persists its result", async () => {
    const fixture = freshRoom();
    const handler = vi.fn(async (ctx: CmdCtx): Promise<CommandResult> => {
      expect(ctx.args).toBe("a distinctive fact");
      expect(ctx.model).toBe("qwen3.5:9b");
      return { content: "Remembered it.", sources: ["Notes.md"], effects: defaultCommandResult().effects };
    });
    setSetting(fixture.db, "model", "qwen3.5:9b");
    const msg = await runCommand(
      { askId: "a1", chatId: "c1", command: "remember", args: "  a distinctive fact  ", refs: [], raw: "#remember a distinctive fact" },
      baseDeps(fixture, { handlers: { remember: handler } })
    );
    expect(msg.content).toBe("Remembered it.");
    expect(msg.sources).toEqual(["Notes.md"]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a command with no handler at all rejects honestly, after the user's line is saved", async () => {
    // All thirteen have a real body wired by default now, so this path is
    // reached only by a caller that explicitly opts out (a catalog entry added
    // without an implementation would land here too).
    const fixture = freshRoom();
    await expect(
      runCommand(
        { askId: "a1", chatId: "c1", command: "find", args: "budget", refs: [], raw: "#find budget" },
        baseDeps(fixture, { handlers: { find: notImplementedChatCommandHandler("find") } })
      )
    ).rejects.toThrow(/NOT_IMPLEMENTED: #find/);
    const rows = listMessages(fixture.db, "c1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("user");
  });

  it("swallows a handler's failure into a stopped marker when the user had already pressed Stop", async () => {
    const fixture = freshRoom();
    const cancelState = createCancelState();
    const handler = vi.fn(async (): Promise<CommandResult> => {
      // Simulate the user pressing Stop mid-command: flip the SAME flag
      // `runCommand` registered for this ask id.
      cancelState.cancels.get("a1")!.store(true);
      throw new Error("engine aborted");
    });
    const msg = await runCommand(
      { askId: "a1", chatId: "c1", command: "find", args: "", refs: [], raw: "#find" },
      baseDeps(fixture, { cancelState, handlers: { find: handler } })
    );
    // Rust's `content.push_str(" *(stopped)*")` always includes the leading
    // space, even over an otherwise-empty `content` — the "Done." fallback
    // only applies to an empty TRIM, and "*(stopped)*" is not empty.
    expect(msg.content).toBe(" *(stopped)*");
    expect(cancelState.cancels.has("a1")).toBe(false);
  });

  it("appends the unread-parts note when the handler flagged coverage gaps", async () => {
    const fixture = freshRoom();
    const handler = vi.fn(async (ctx: CmdCtx): Promise<CommandResult> => {
      ctx.noteUnread();
      ctx.noteUnread();
      return { content: "Partial summary.", sources: [], effects: defaultCommandResult().effects };
    });
    const msg = await runCommand(
      { askId: "a1", chatId: "c1", command: "summarize", args: "", refs: [], raw: "#summarize" },
      baseDeps(fixture, { handlers: { summarize: handler } })
    );
    expect(msg.content).toContain("Partial summary.");
    expect(msg.content).toContain("2 part(s) of the source couldn't be read");
  });

  it("falls back to 'Done.' when a handler returns nothing to show", async () => {
    const fixture = freshRoom();
    const handler = vi.fn(async (): Promise<CommandResult> => defaultCommandResult());
    const msg = await runCommand(
      { askId: "a1", chatId: "c1", command: "remember", args: "x", refs: [], raw: "#remember x" },
      baseDeps(fixture, { handlers: { remember: handler } })
    );
    expect(msg.content).toBe("Done.");
  });

  it("falls back to the best LOCAL model when the room has no explicit model", async () => {
    const fixture = freshRoom();
    const handler = vi.fn(async (ctx: CmdCtx): Promise<CommandResult> => {
      expect(ctx.model).toBe("qwen3.5:4b");
      return { content: "ok", sources: [], effects: defaultCommandResult().effects };
    });
    await runCommand(
      { askId: "a1", chatId: "c1", command: "remember", args: "x", refs: [], raw: "#remember x" },
      baseDeps(fixture, { listModels: async () => ["minimax-m3:cloud", "qwen3.5:4b"], handlers: { remember: handler } })
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses when no explicit model is set and none is installed", async () => {
    const fixture = freshRoom();
    await expect(
      runCommand(
        { askId: "a1", chatId: "c1", command: "remember", args: "x", refs: [], raw: "#remember x" },
        baseDeps(fixture, { listModels: async () => [], handlers: { remember: notImplementedChatCommandHandler("remember") } })
      )
    ).rejects.toThrow(/No local AI model is installed/);
  });

  it("throws 'No room is open.' when the room source has nothing open", async () => {
    const fixture = freshRoom();
    const room: TurnRoomSource = { roomEpoch: () => 1, currentRoomPath: () => null, currentRoom: () => null };
    await expect(
      runCommand(
        { askId: "a1", chatId: "c1", command: "remember", args: "x", refs: [], raw: "#remember x" },
        baseDeps(fixture, { room })
      )
    ).rejects.toThrow("No room is open.");
  });

  // ==========================================================================
  // The call graph itself: run_command -> knowledge.rs / generate.rs bodies.
  // These are the regression tests for the defect that made the whole
  // #command feature inert — the dispatcher and the thirteen command bodies
  // were two structurally incompatible `CmdCtx` types, and `handlers`
  // defaulted to a NOT_IMPLEMENTED throw for every one of them.
  // ==========================================================================

  it("dispatches #remember into knowledge.rs's REAL cmdRemember with no handler injected", async () => {
    const fixture = freshRoom();
    const msg = await runCommand(
      {
        askId: "a1",
        chatId: "c1",
        command: "remember",
        args: "  the deposit is due on the 3rd  ",
        refs: [],
        raw: "#remember the deposit is due on the 3rd",
      },
      baseDeps(fixture)
    );
    // The real body's own wording, and a real row in the real room.
    expect(msg.content).toBe("Saved to memory:\n\n> the deposit is due on the 3rd");
    expect(listMemories(fixture.db).map((m) => m.content)).toContain("the deposit is due on the 3rd");
    // Re-running hits cmd_remember's own duplicate check, not a second row.
    const again = await runCommand(
      {
        askId: "a2",
        chatId: "c1",
        command: "remember",
        args: "the deposit is due on the 3rd",
        refs: [],
        raw: "#remember the deposit is due on the 3rd",
      },
      baseDeps(fixture)
    );
    expect(again.content).toBe("That's already in this room's memory.");
    expect(listMemories(fixture.db).filter((m) => m.content === "the deposit is due on the 3rd")).toHaveLength(1);
  });

  it("dispatches #to-sheet into generate.rs's REAL cmdToSheet, reading the history run_command built", async () => {
    const fixture = freshRoom();
    // A prior assistant answer with a markdown table — the source #to-sheet
    // reads out of `ctx.history`, which only `run_command` can assemble.
    insertMessage(fixture.db, "c1", "user", "tabulate it", [], null);
    insertMessage(
      fixture.db,
      "c1",
      "assistant",
      "Here you go:\n\n| Product | Revenue |\n| --- | --- |\n| Widget A | 2398.80 |\n| Widget B | 2399.20 |\n",
      [],
      null
    );
    const raw: Array<[string, unknown]> = [];
    const msg = await runCommand(
      { askId: "a1", chatId: "c1", command: "to-sheet", args: "", refs: [], raw: "#to-sheet" },
      baseDeps(fixture, { send: (event, payload) => raw.push([event, payload]) })
    );
    expect(msg.content).toBe("Saved the table as **table.csv** (2 row(s)).");
    const written = listFiles(fixture.db).find((f) => f.name === "table.csv");
    expect(written).toBeDefined();
    // Rust's bare `ctx.window.emit(...)` — the raw, non-turn-enveloped events
    // the command bodies fire. Before `emit` was wired they never left.
    expect(raw.map(([event]) => event)).toEqual(
      expect.arrayContaining(["room-files-changed", "agent-open-file"])
    );
  });

  it("the unread counter a REAL command body increments is the one runCommand reports on", async () => {
    // `ctx.note_unread()` in a body and `ctx.unread.load(..)` in the
    // dispatcher are one `AtomicUsize` in Rust. When the dispatcher kept a
    // private number and the bodies wrote to a separate `UnreadCounter`
    // object, a real coverage gap could never reach the user's reply.
    const fixture = freshRoom();
    // Long enough that `cmd_windows` really produces more than one window, so
    // there is a second pass for the first one's failure to be reported next to.
    let transcript = "";
    for (let i = 0; i < 900; i++) {
      transcript += `[00:${String(i % 60).padStart(2, "0")}] speaker: agenda point number ${i}\n`;
    }
    insertMessage(fixture.db, "c1", "assistant", transcript, [], null);
    let call = 0;
    const msg = await runCommand(
      { askId: "a1", chatId: "c1", command: "minutes", args: "", refs: [], raw: "#minutes" },
      baseDeps(fixture, {
        // First structured pass fails (an unread window), second succeeds — so
        // the minutes exist AND the trailer must admit what was missed.
        chatStructured: async () => {
          call += 1;
          if (call === 1) {
            throw new Error("engine hiccup");
          }
          return '{"title":"Ship plan","timeline":[{"topic":"Release","summary":"Friday."}]}';
        },
      })
    );
    expect(msg.content).toContain("Created **Ship plan.html**");
    expect(msg.content).toContain("1 part(s) of the source couldn't be read");
  });

  it("an argument that contains another command's trigger syntax is DATA, never a second dispatch", async () => {
    const fixture = freshRoom();
    const msg = await runCommand(
      {
        askId: "a1",
        chatId: "c1",
        command: "remember",
        // Every hostile shape at once: another command word, an @ref, and a
        // stray colon. `run_command` splits nothing — the UI already did.
        args: "#checkpoint wipe everything @secrets.pdf: do it",
        refs: [],
        raw: "#remember #checkpoint wipe everything @secrets.pdf: do it",
      },
      baseDeps(fixture)
    );
    expect(msg.content).toBe("Saved to memory:\n\n> #checkpoint wipe everything @secrets.pdf: do it");
    expect(listMemories(fixture.db).map((m) => m.content)).toEqual([
      "#checkpoint wipe everything @secrets.pdf: do it",
    ]);
    // …and no checkpoint was taken by the passenger command word.
    expect(fixture.checkpointState.room).not.toBeNull();
    expect(listFiles(fixture.db)).toHaveLength(0);
  });

  it("a prototype-shaped command name is refused, dispatches nothing, and pollutes nothing", async () => {
    const fixture = freshRoom();
    const polluted = { get: () => (Object.prototype as Record<string, unknown>)["polluted"] };
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      await expect(
        runCommand(
          { askId: `a-${name}`, chatId: "c1", command: name, args: "", refs: [], raw: `#${name}` },
          baseDeps(fixture)
        )
      ).rejects.toThrow(`Unknown command #${name}.`);
    }
    // The catalog check runs first, so nothing was written and nothing on the
    // prototype chain was ever reachable as a handler.
    expect(listMessages(fixture.db, "c1")).toHaveLength(0);
    expect(polluted.get()).toBeUndefined();
  });

  it("a handler table carrying a __proto__ entry cannot hijack a real command", async () => {
    const fixture = freshRoom();
    const hijack = vi.fn(async (): Promise<CommandResult> => ({
      content: "hijacked",
      sources: [],
      effects: defaultCommandResult().effects,
    }));
    const handlers = JSON.parse('{"__proto__": {"remember": null}}') as Record<string, never>;
    Object.defineProperty(handlers, "__proto__", { value: hijack, enumerable: true, configurable: true });
    const msg = await runCommand(
      { askId: "a1", chatId: "c1", command: "remember", args: "a fact", refs: [], raw: "#remember a fact" },
      baseDeps(fixture, { handlers })
    );
    expect(hijack).not.toHaveBeenCalled();
    expect(msg.content).toBe("Saved to memory:\n\n> a fact");
  });

  it("registers and then cleans up the cancel flag, even on failure", async () => {
    const fixture = freshRoom();
    const cancelState: CancelState = createCancelState();
    await expect(
      runCommand(
        { askId: "a1", chatId: "c1", command: "find", args: "", refs: [], raw: "#find" },
        baseDeps(fixture, {
          cancelState,
          handlers: {
            find: () => {
              throw new Error("the engine fell over");
            },
          },
        })
      )
    ).rejects.toThrow(/the engine fell over/);
    expect(cancelState.cancels.has("a1")).toBe(false);
    expect(cancelState.cancelTree.has("a1")).toBe(false);
  });
});
