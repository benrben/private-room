/**
 * Integration proof for `liveContext.ts`. The acceptance criterion this file
 * exists to satisfy: the assembled deps must be GENUINELY LOAD-BEARING —
 * actually driven through a real `#command` (`runCommand`) and real `execTool`
 * calls against a real, on-disk SQLCipher room opened through `roomManager.ts`'s
 * real `createRoom` — never merely constructed and type-checked. An assembler
 * that compiles but was never called through is precisely the "shipped inert"
 * bug class this port has been bitten by before.
 *
 * WHAT IS AND IS NOT FAKED. The room is real (a real `.roomai` on a real temp
 * disk, real SQLCipher, real schema), the DB reads/writes are real, the
 * subprocess pipeline is real. Two edges are stood in for, both of them
 * PROCESS boundaries this sandbox has no live instance of, and both using the
 * convention neighbouring suites already established:
 *   - the Python sidecar — a real `node:http` server on a real loopback port,
 *     with `sidecar.ts`'s `ensureUp` pointed at it, exactly as
 *     `ollamaGenerate.test.ts` does. No mocked `fetch`; the bytes really cross
 *     a socket.
 *   - `child_process.spawn` for the advisor CLI — `externalAdvisor.ts`'s own
 *     `spawnFn` seam, as `externalAdvisor.test.ts` does. Everything above the
 *     spawn (shell selection, argv construction, stdin, the cancel watcher) is
 *     the real code.
 * `listModels` is overridden per test for the same reason: `runCommand` calls
 * it unconditionally and the real one reaches an actual Ollama daemon.
 * `liveRunCommandDeps` itself leaves it unset — asserted below — so a live app
 * gets the real resolver.
 *
 * Every assertion that a write happened reads it back through a DIFFERENT
 * module than the one that wrote it (`db-host/memories.ts`,
 * `db-host/artifacts.ts`, `db-host/checkpoints.ts`, `db-host/files.ts`), so a
 * pass cannot be explained by the assembler and the checker sharing a bug.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});
import { ensureUp } from "./sidecar.js";

import { CancelFlag, cancelId, forget, registerRun, UNLABELLED } from "./cancel.js";
import { runCommand, type RunCommandDeps, type RunCommandRequest } from "./chatCommands.js";
import { generateStream as generateStreamReal } from "./chatCommandsGenerate.js";
import { fileProvenance } from "./db-host/artifacts.js";
import { checkpointsDir, readManifest } from "./db-host/checkpoints.js";
import { fileByExactName, getFileFull, insertFile, listFiles } from "./db-host/files.js";
import { listMemories } from "./db-host/memories.js";
import { realRunAdvisorCli, type AdvisorSpawnedProcess, type AdvisorSpawnFn } from "./externalAdvisor.js";
import { createToolEffects, execTool, type ExecToolDeps } from "./execTool.js";
import {
  assembleCmdCtx,
  assembleLiveContext,
  liveCmdCtxDeps,
  liveExecToolDeps,
  liveRunCommandDeps,
  liveTurnRoomSource,
} from "./liveContext.js";
import { chatStructured as chatStructuredReal, generate as generateReal } from "./ollamaGenerate.js";
import { clearPolicy, setPolicyRulesForTests } from "./privacy.js";
import {
  createRoom,
  createRoomManagerState,
  spawnRoomServerIfEnabledNotImplemented,
  type RoomManagerDeps,
  type RoomManagerState,
} from "./roomManager.js";
import { layoutGraphReal } from "./sketchLayoutAdapter.js";
import { TurnId, type EventSender } from "./turn.js";

// ============================================================================
// fixtures
// ============================================================================

const PASSWORD = "correct horse battery staple";
const FIXED_MODELS = { listModels: async (): Promise<string[]> => ["qwen3.5:4b"] };

let tmpDirs: string[] = [];
let server: http.Server | undefined;

beforeEach(() => {
  // `createRoom` logs an honest SKIPPED/NOT_IMPLEMENTED line for every
  // bucket-1/bucket-2 dep this fixture does not supply (mcp, scheduler,
  // policy, …) — expected noise on the real open-room path, silenced like
  // every other suite in this repo that drives it.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.mocked(ensureUp).mockReset();
  clearPolicy();
  vi.restoreAllMocks();
  await closeServer();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** A real, on-disk `.roomai` opened through `roomManager.ts`'s real
 * `createRoom` — the exact path a running app takes, not a hand-built
 * `Database` connection dropped into `state.room`. */
function freshOpenRoom(): { state: RoomManagerState; roomPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "live-context-"));
  tmpDirs.push(dir);
  const roomPath = path.join(dir, `room-${randomUUID()}.roomai`);
  const state = createRoomManagerState();
  const deps: RoomManagerDeps = {
    userDataDir: dir,
    spawnRoomServerIfEnabled: spawnRoomServerIfEnabledNotImplemented,
  };
  createRoom(state, deps, roomPath, PASSWORD, "Live Context Fixture");
  return { state, roomPath };
}

/** Serve `handler` on a real ephemeral loopback port and point the mocked
 * `ensureUp` at it, so `ollamaGenerate.ts`'s real `/generate` POST lands on a
 * server this test controls exactly as a real sidecar would answer. */
async function fakeSidecarAt(handler: http.RequestListener): Promise<void> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
}

async function closeServer(): Promise<void> {
  if (server === undefined) {
    return;
  }
  const s = server;
  server = undefined;
  s.closeAllConnections?.();
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

/** What the model "returns" for a `#sketch`: the one command that drives BOTH
 * an engine seam and `layoutGraph` in a single run. */
const SKETCH_JSON = JSON.stringify({
  title: "Login Flow",
  explanation: "How our login works.",
  nodes: [
    { id: "a", label: "User signs in", kind: "start" },
    { id: "b", label: "Server verifies" },
    { id: "c", label: "Session created", kind: "end" },
  ],
  edges: [
    { from: "a", to: "b", label: "submits" },
    { from: "b", to: "c", label: "grants" },
  ],
});

/** Answers every POST with one fixed JSON body and records what was asked. */
async function sidecarReplying(text: string): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  await fakeSidecarAt((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text }));
    });
  });
  return seen;
}

/** A sidecar that accepts the POST and then never answers — the wedged engine
 * only a Stop can break out of. `posts` counts requests whose body fully
 * arrived, so a test can wait for the model call to be genuinely in flight
 * before it presses Stop. */
async function sidecarThatNeverAnswers(): Promise<{ posts: number }> {
  const counter = { posts: 0 };
  await fakeSidecarAt((req) => {
    req.on("data", () => {});
    req.on("end", () => {
      counter.posts += 1;
    });
  });
  return counter;
}

/** Collects `(event, payload)` pairs the way a real `webContents.send` would
 * receive them, so a test can assert BOTH that an event arrived and which
 * envelope (turn-stamped or raw) it carried. */
function recordingSender(): { send: EventSender; events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  return { send: (event, payload) => events.push([event, payload]), events };
}

function payloadsOf(events: ReadonlyArray<[string, unknown]>, event: string): unknown[] {
  return events.filter(([name]) => name === event).map(([, payload]) => payload);
}

function baseRequest(overrides: Partial<RunCommandRequest> = {}): RunCommandRequest {
  return {
    askId: randomUUID(),
    chatId: randomUUID(),
    command: "remember",
    args: "",
    refs: [],
    raw: "",
    ...overrides,
  };
}

class FakeAdvisorProcess extends EventEmitter implements AdvisorSpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

/** Records every spawn and answers with a fixed reply — the shape
 * `externalAdvisor.test.ts`'s own fixture uses, kept local since it is not
 * exported. */
function recordingAdvisorSpawner(reply: string): {
  spawnFn: AdvisorSpawnFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnFn: AdvisorSpawnFn = (command, args) => {
    calls.push({ command, args });
    const proc = new FakeAdvisorProcess();
    proc.stdin.on("end", () => {
      proc.stdout.end(reply);
      proc.stderr.end();
      proc.emit("close", 0, null);
    });
    proc.stdin.resume();
    return proc;
  };
  return { spawnFn, calls };
}

// ============================================================================
// liveTurnRoomSource — a live view, not a snapshot
// ============================================================================

describe("liveTurnRoomSource", () => {
  it("tracks state.room live: open, then rolling back, then locked", () => {
    const { state, roomPath } = freshOpenRoom();
    const room = liveTurnRoomSource(state);

    expect(room.currentRoom()?.path).toBe(roomPath);
    expect(room.currentRoom()?.db).toBe(state.room!.conn);
    expect(room.currentRoomPath()).toBe(roomPath);
    expect(room.roomEpoch()).toBe(state.roomEpoch);
    expect(room.rollingBack?.()).toBe(false);

    state.rollingBack = true;
    expect(room.rollingBack?.()).toBe(true);
    state.rollingBack = false;

    // A lock (or a swap) mutates `state.room` itself — the SAME TurnRoomSource
    // object must see it, proving this is a live view and not a value captured
    // at assembly time.
    const epochBefore = room.roomEpoch();
    state.room!.conn.close();
    state.room = null;
    state.roomEpoch += 1;
    expect(room.currentRoom()).toBeNull();
    expect(room.currentRoomPath()).toBeNull();
    expect(room.roomEpoch()).toBe(epochBefore + 1);
  });
});

// ============================================================================
// runCommand, driven for real through liveRunCommandDeps
// ============================================================================

describe("runCommand end to end, through liveRunCommandDeps", () => {
  it("drives #remember for real: the memory lands in the exact db the assembler was built against", async () => {
    const { state } = freshOpenRoom();
    const events: Array<[string, unknown]> = [];
    const deps: RunCommandDeps = {
      ...liveRunCommandDeps(state, (e, p) => events.push([e, p])),
      ...FIXED_MODELS,
    };

    const reply = await runCommand(
      baseRequest({ command: "remember", args: "the sky is blue", raw: "#remember the sky is blue" }),
      deps
    );

    expect(reply.content).toContain("Saved to memory");
    // Read back through a completely different module, against
    // `state.room!.conn` directly — proving `RunCommandDeps.room` really is a
    // view over the SAME connection, not a stub returning a plausible reply.
    expect(listMemories(state.room!.conn).map((m) => m.content)).toContain("the sky is blue");
  });

  it("drives #checkpoint for real: checkpointState is the exact RoomManagerState createRoom populated", async () => {
    const { state, roomPath } = freshOpenRoom();
    const deps: RunCommandDeps = { ...liveRunCommandDeps(state, () => {}), ...FIXED_MODELS };

    const reply = await runCommand(
      baseRequest({ command: "checkpoint", args: "before wiring", raw: "#checkpoint before wiring" }),
      deps
    );

    expect(reply.content).toContain("Saved checkpoint");
    // `createCheckpointCore` writes a REAL file next to the room — read it back
    // via `db-host/checkpoints.ts`, independent of both `liveContext.ts` and
    // `roomCheckpoints.ts`.
    const manifest = readManifest(checkpointsDir(roomPath));
    expect(manifest.entries.some((e) => e.name === "before wiring")).toBe(true);
  });

  it("leaves listModels unset, so a live app resolves engineRouting.ts's real one", () => {
    const { state } = freshOpenRoom();
    expect(liveRunCommandDeps(state, () => {}).listModels).toBeUndefined();
  });

  it("honestly leaves #transcribe's on-demand branch NOT_IMPLEMENTED — never fakes on-device STT", async () => {
    const { state } = freshOpenRoom();
    const file = insertFile(
      state.room!.conn,
      "meeting.mp3",
      "audio/mp3",
      Buffer.from("not real audio bytes"),
      null, // no cached transcript — forces the on-demand transcribeAudio branch
      "recording"
    );
    const deps: RunCommandDeps = { ...liveRunCommandDeps(state, () => {}), ...FIXED_MODELS };

    const message = await runCommand(
      baseRequest({ command: "transcribe", refs: [file.id], raw: "#transcribe @meeting.mp3" }),
      deps
    );
    expect(message.kind).toBe("turn_error");
    expect(message.content).toMatch(/NOT_IMPLEMENTED.*transcrib/i);
  });
});

// ============================================================================
// #sketch — the one #command that proves BOTH the model seam (a real POST over
// a real socket) and the layoutGraph seam (real geometry) in one drive
// ============================================================================

describe("#sketch, end to end through liveRunCommandDeps", () => {
  const sketchRequest = (): RunCommandRequest =>
    baseRequest({
      command: "sketch",
      args: "how our login flow works",
      raw: "#sketch how our login flow works",
    });

  it("with layoutGraph stripped back to its default, #sketch fails with the honest refusal", async () => {
    const seen = await sidecarReplying(SKETCH_JSON);
    const { state } = freshOpenRoom();
    // The assembled deps with ONE field cleared — exactly what a caller gets
    // who never wired the sketch layout adapter in. This is the "before" half
    // of the proof. `runCommand` swallows a command-body throw only when the
    // run was Stopped, so an unwired layoutGraph genuinely rejects.
    const deps: RunCommandDeps = {
      ...liveRunCommandDeps(state, () => {}),
      ...FIXED_MODELS,
      layoutGraph: undefined,
    };

    const message = await runCommand(sketchRequest(), deps);
    expect(message.kind).toBe("turn_error");
    expect(message.content).toMatch(/NOT_IMPLEMENTED.*sketch layout engine/s);
    // The model call itself DID happen — so the refusal is specifically
    // layoutGraph's, not a knock-on from the engine seams never being reached.
    expect(seen.length).toBeGreaterThan(0);
  });

  it("with the real assembler, #sketch actually draws: a real chatStructured POST and a real render", async () => {
    const seen = await sidecarReplying(SKETCH_JSON);
    const { state } = freshOpenRoom();
    const { send, events } = recordingSender();
    const deps: RunCommandDeps = { ...liveRunCommandDeps(state, send), ...FIXED_MODELS };
    const req = sketchRequest();

    const msg = await runCommand(req, deps);

    // The network hop genuinely happened, against THIS test's server — not a
    // stub answering in-process.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe("qwen3.5:4b");
    const sent = seen[0]?.messages as Array<{ role: string; content: string }>;
    expect(sent.some((m) => m.role === "user" && m.content.includes("how our login flow works"))).toBe(true);

    expect(msg.content).not.toContain("NOT_IMPLEMENTED");
    expect(msg.content).toMatch(/^Drew \*\*.*\.sketch\*\* — 3 box\(es\) and 2 connection\(s\)\./);

    // `layoutGraphReal` genuinely ran: a real ".sketch" file landed in the real
    // room, and its JSON carries geometry (x/y per box) that only sketchDoc.ts
    // computes — neither the model's own JSON (no coordinates at all) nor a
    // stub could produce it.
    const sketchFile = listFiles(state.room!.conn).find((f) => f.name.endsWith(".sketch"));
    expect(sketchFile).toBeDefined();
    const [, , bytes] = getFileFull(state.room!.conn, sketchFile!.id);
    const doc = JSON.parse(bytes?.toString("utf8") ?? "{}") as {
      elements?: Array<{ type: string; x?: number; y?: number }>;
    };
    const boxes = (doc.elements ?? []).filter((e) => e.type === "rect" || e.type === "ellipse");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) {
      expect(typeof box.x).toBe("number");
      expect(typeof box.y).toBe("number");
    }

    // `send` reaches the caller for real: `cmdSketch`'s own step chips arrive
    // stamped with THIS run's turn, so a sender swapped for a no-op (a live
    // app whose step chips silently never render) fails here.
    expect(payloadsOf(events, "ask-step")).toContainEqual({
      runId: req.askId,
      chatId: req.chatId,
      v: "Drawing it…",
    });
    // `emit` reaches the caller too, and carries the RAW (non-enveloped) shape
    // Rust's bare `window.emit` sends — proving the two seams are wired to the
    // same sender without `emit` accidentally acquiring the turn envelope.
    expect(payloadsOf(events, "room-files-changed")).toEqual([undefined]);
    expect(payloadsOf(events, "agent-open-file")).toEqual([{ id: sketchFile!.id }]);
  });

  it("cancelState IS state.cancel: the app's own Stop path reaches a running #command", async () => {
    const wedged = await sidecarThatNeverAnswers();
    const { state } = freshOpenRoom();
    const deps: RunCommandDeps = { ...liveRunCommandDeps(state, () => {}), ...FIXED_MODELS };
    const req = sketchRequest();

    const pending = runCommand(req, deps);
    // The model call is genuinely in flight against the wedged sidecar before
    // Stop is pressed, so what ends it can only be the cancel flag.
    await vi.waitFor(() => expect(wedged.posts).toBeGreaterThan(0));

    // `cancelId` is the app's REAL Stop entry point, and it is given
    // `state.cancel` — NOT `deps.cancelState`. It can only find this run if the
    // assembler pointed the two at the same registry; a `cancelState` built
    // fresh here would leave `known` false and the command running.
    expect(cancelId(state.cancel, req.askId)).toEqual({ stopped: [UNLABELLED], known: true });

    const reply = await pending;
    expect(reply.content).toContain("*(stopped)*");
    // The same registry is the one `runCommand`'s `finally` cleans up.
    expect(state.cancel.cancels.has(req.askId)).toBe(false);
  });
});

// ============================================================================
// liveCmdCtxDeps / assembleCmdCtx
// ============================================================================

describe("liveCmdCtxDeps", () => {
  it("wires generate/chatStructured/generateStream to the real, identical functions", () => {
    const deps = liveCmdCtxDeps();
    expect(deps.generate).toBe(generateReal);
    expect(deps.chatStructured).toBe(chatStructuredReal);
    expect(deps.generateStream).toBe(generateStreamReal);
  });

  it("leaves transcribeAudio unset — the honest STT gap, not a fake", () => {
    expect(liveCmdCtxDeps().transcribeAudio).toBeUndefined();
  });

  it("wires layoutGraph to the real layout engine and DRIVES it: real geometry, not a stub", () => {
    const deps = liveCmdCtxDeps();
    expect(deps.layoutGraph).toBe(layoutGraphReal);

    const doc = deps.layoutGraph!(
      [
        { id: "a", label: "Start", kind: "start" },
        { id: "b", label: "Finish", note: "the end of it", kind: "end" },
      ],
      [{ from: "a", to: "b", label: "then" }]
    );

    // `layoutGraphNotImplemented` (the default this batch replaces) throws
    // synchronously on any call, so reaching real JSON/text at all proves the
    // real engine ran.
    expect(doc.toJson()).toContain('"elements"');
    const text = doc.extractedText();
    expect(text).toContain("Start");
    expect(text).toContain("Finish");
    expect(text).toContain("the end of it");
  });
});

describe("assembleCmdCtx", () => {
  it("drives a real command body end to end: #remember with no runCommand dispatch at all", async () => {
    const { state } = freshOpenRoom();
    const ctx = assembleCmdCtx(state, () => {}, {
      model: "qwen3.5:4b",
      turn: new TurnId(randomUUID(), randomUUID()),
      args: "assembled directly",
    });

    // `cmdRemember` reaches the room only through `ctx.rooms`, which CmdCtx
    // derives from `ctx.room` — so a write landing in the real db proves the
    // derived view is the same open room, not a second one.
    const { cmdRemember } = await import("./chatCommandsKnowledge.js");
    const result = await cmdRemember(ctx);
    expect(result.content).toContain("assembled directly");
    expect(listMemories(state.room!.conn).map((m) => m.content)).toContain("assembled directly");
  });

  it("drives cmdSketch directly: send carries this ctx's turn, emit carries the raw file events", async () => {
    await sidecarReplying(SKETCH_JSON);
    const { state } = freshOpenRoom();
    const { send, events } = recordingSender();
    const turn = new TurnId(randomUUID(), randomUUID());
    const ctx = assembleCmdCtx(state, send, { model: "qwen3.5:4b", turn, args: "how our login flow works" });

    const { cmdSketch } = await import("./chatCommandsGenerate.js");
    const result = await cmdSketch(ctx);
    expect(result.content).toContain("box(es)");

    const sketchFile = listFiles(state.room!.conn).find((f) => f.name.endsWith(".sketch"));
    expect(sketchFile).toBeDefined();
    expect(payloadsOf(events, "ask-step")).toContainEqual({
      runId: turn.runId,
      chatId: turn.chatId,
      v: "Drawing it…",
    });
    expect(payloadsOf(events, "room-files-changed")).toEqual([undefined]);
    expect(payloadsOf(events, "agent-open-file")).toEqual([{ id: sketchFile!.id }]);
  });

  it("builds a CmdCtx whose room/rooms are ONE view, not two", () => {
    const { state } = freshOpenRoom();
    const ctx = assembleCmdCtx(state, () => {}, {
      model: "qwen3.5:4b",
      turn: new TurnId(randomUUID(), randomUUID()),
    });

    expect(ctx.generate).toBe(generateReal);
    expect(ctx.layoutGraph).toBe(layoutGraphReal);
    expect(ctx.transcribeAudio).toBeUndefined();
    expect(ctx.refs).toEqual([]);
    expect(ctx.args).toBe("");
    expect(ctx.history).toBe("");
    expect(ctx.temperature).toBeNull();
    expect(ctx.rooms.current()?.path).toBe(state.room!.path);
    expect(ctx.rooms.current()?.db).toBe(state.room!.conn);
  });

  it("keeps supplied command values intact while the direct context is wired", () => {
    const { state } = freshOpenRoom();
    const turn = new TurnId(randomUUID(), randomUUID());
    const refs = ["file-a", "file-b"];
    const ctx = assembleCmdCtx(state, () => {}, {
      model: "qwen3.5:4b",
      turn,
      refs,
      args: "summarize the notes",
      history: "Earlier message",
      temperature: 0,
    });

    expect(ctx).toMatchObject({
      model: "qwen3.5:4b",
      refs,
      args: "summarize the notes",
      history: "Earlier message",
      temperature: 0,
      turn,
    });
  });

  it("cancel prefers the already-registered flag for the turn's run id", () => {
    const { state } = freshOpenRoom();
    const turn = new TurnId(randomUUID(), randomUUID());
    const node = registerRun(state.cancel, turn.runId, "test run");
    try {
      const ctx = assembleCmdCtx(state, () => {}, { model: "qwen3.5:4b", turn });
      expect(ctx.cancel).toBe(node.flag());
      node.flag().store(true);
      expect(ctx.cancel.load()).toBe(true);
    } finally {
      state.cancel.cancels.delete(turn.runId);
      forget(state.cancel, turn.runId);
    }
  });

  it("falls back to a fresh, unflipped flag for a turn nothing registered", () => {
    const { state } = freshOpenRoom();
    const ctx = assembleCmdCtx(state, () => {}, {
      model: "qwen3.5:4b",
      turn: new TurnId(randomUUID(), randomUUID()),
    });
    expect(ctx.cancel).toBeInstanceOf(CancelFlag);
    expect(ctx.cancel.load()).toBe(false);
  });
});

// ============================================================================
// liveExecToolDeps + execTool, driven for real
// ============================================================================

describe("liveExecToolDeps + execTool, end to end", () => {
  it("db/emit wiring is real: add_memory round-trips through the SAME room db and fires the real emit", async () => {
    const { state } = freshOpenRoom();
    const send = vi.fn();
    const deps = liveExecToolDeps(state, send);
    const effects = createToolEffects();

    const added = await execTool("add_memory", { content: "wiring is real" }, effects, deps);
    expect(added).toEqual({ ok: true, text: "Memory saved." });
    expect(send).toHaveBeenCalledWith("memories-changed", undefined);

    // Read back through db-host/memories.ts, independent of execTool.ts and
    // liveContext.ts both.
    expect(listMemories(state.room!.conn).map((m) => m.content)).toContain("wiring is real");

    const listed = await execTool("list_memories", {}, effects, deps);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.text).toContain("wiring is real");
    }
  });

  it("db answers null (no room open) exactly like execTool's own requireRoom contract", async () => {
    const state = createRoomManagerState(); // no room ever opened
    const deps = liveExecToolDeps(state, () => {});
    expect(deps.db).toBeNull();
    const outcome = await execTool("list_memories", {}, createToolEffects(), deps);
    expect(outcome).toEqual({ ok: false, error: "No room is open." });
  });

  it("turn/runId wiring is real: create_file records the assembled turn's actual run id in provenance", async () => {
    const { state } = freshOpenRoom();
    const turn = new TurnId(randomUUID(), randomUUID());
    const deps = liveExecToolDeps(state, () => {}, { turn });
    const effects = createToolEffects();

    const result = await execTool("create_file", { name: "Wiring Note", content: "hello" }, effects, deps);
    expect(result.ok).toBe(true);
    expect(effects.wrote).toBe(true);

    const file = fileByExactName(state.room!.conn, "Wiring Note.html");
    expect(file).not.toBeNull();
    const provenance = fileProvenance(state.room!.conn, file!.id);
    expect(provenance?.runId).toBe(turn.runId);
    expect(provenance?.tool).toBe("create_file");
  });

  it("cancel prefers the already-registered flag for a turn, and null when nothing registered one", () => {
    const { state } = freshOpenRoom();
    const turn = new TurnId(randomUUID(), randomUUID());
    expect(liveExecToolDeps(state, () => {}, { turn }).cancel).toBeNull();

    const node = registerRun(state.cancel, turn.runId, "test run");
    try {
      const deps = liveExecToolDeps(state, () => {}, { turn });
      expect(deps.cancel).toBe(node.flag());
      node.flag().store(true);
      expect(deps.cancel?.load()).toBe(true);
    } finally {
      state.cancel.cancels.delete(turn.runId);
      forget(state.cancel, turn.runId);
    }
  });

  it("an explicit cancel override wins over the turn-derived lookup", () => {
    const { state } = freshOpenRoom();
    const turn = new TurnId(randomUUID(), randomUUID());
    const node = registerRun(state.cancel, turn.runId, "test run");
    try {
      const explicit = new CancelFlag();
      expect(liveExecToolDeps(state, () => {}, { turn, cancel: explicit }).cancel).toBe(explicit);
    } finally {
      state.cancel.cancels.delete(turn.runId);
      forget(state.cancel, turn.runId);
    }
  });

  it("routes default to [] — no connector manager is live, and [] is the honest answer", () => {
    const { state } = freshOpenRoom();
    expect(liveExecToolDeps(state, () => {}).routes).toEqual([]);
  });

  it("job-queue/connector-management seams stay unset — each needs app-wide state this assembler does not own", () => {
    const { state } = freshOpenRoom();
    const deps = liveExecToolDeps(state, () => {});
    expect(deps.downloadJob).toBeUndefined();
    expect(deps.workflowRun).toBeUndefined();
    expect(deps.runStudioDeps).toBeUndefined();
    expect(deps.callConnectorTool).toBeUndefined();
    expect(deps.connectorApproved).toBeUndefined();
    expect(deps.remoteSeam).toBeUndefined();
    expect(deps.confirmDestructive).toBeUndefined();
  });
});

// ============================================================================
// The PRIV-4 gates: genuinely installed, and genuinely blocking
// ============================================================================

describe("liveExecToolDeps installs the real PRIV-4 privacy gates", () => {
  it("without the assembler, fetch_page refuses with NOT_IMPLEMENTED (the raw seam is unset)", async () => {
    const { state } = freshOpenRoom();
    const bare: ExecToolDeps = { db: state.room!.conn, cancel: null, routes: [] };
    const outcome = await execTool(
      "fetch_page",
      { url: "https://example.com/?q=Ben+Reich" },
      createToolEffects(),
      bare
    );
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("NOT_IMPLEMENTED") });
  });

  it("with the assembler and an active policy, fetch_page is refused before any network call", async () => {
    setPolicyRulesForTests(true, [["Ben Reich", "[Person A]"]]);
    const { state } = freshOpenRoom();
    const deps = liveExecToolDeps(state, () => {});

    const outcome = await execTool(
      "fetch_page",
      { url: "https://example.com/?q=Ben+Reich" },
      createToolEffects(),
      deps
    );
    // privacy.ts's REAL outboundUrlHides ran and found the protected name.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("protected name(s)");
      expect(outcome.text).toContain("Cloud privacy is on");
    }
  });

  it("masks a web_search query for real, and answers null once the policy is cleared", () => {
    setPolicyRulesForTests(true, [["Ben Reich", "[Person A]"]]);
    const { state } = freshOpenRoom();
    const deps = liveExecToolDeps(state, () => {});

    const masked = deps.maskOutboundWeb!("search for Ben Reich please");
    expect(masked?.query).toBe("search for [Person A] please");
    expect(masked?.note).toContain("1 protected name");

    clearPolicy();
    expect(deps.outboundUrlRefusal!("https://example.com/?q=Ben%20Reich")).toBeNull();
  });
});

// ============================================================================
// The advisor CLI: real subprocess pipeline, and a Stop that can actually
// reach it (the wiring hazard execTool.ts's own doc names)
// ============================================================================

describe("liveExecToolDeps installs the real advisor CLI", () => {
  it("without the assembler, consult_advisor refuses with NOT_IMPLEMENTED", async () => {
    const { state } = freshOpenRoom();
    const bare: ExecToolDeps = { db: state.room!.conn, cancel: null, routes: [] };
    const outcome = await execTool("consult_advisor", { question: "what now?" }, createToolEffects(), bare);
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("NOT_IMPLEMENTED") });
  });

  it("with the assembler, consult_advisor genuinely spawns the real claude-cli pipeline", async () => {
    const { spawnFn, calls } = recordingAdvisorSpawner(JSON.stringify({ result: "use OAuth" }));
    const { state } = freshOpenRoom();
    const deps = liveExecToolDeps(state, () => {}, { advisorOptions: { spawnFn } });

    const effects = createToolEffects();
    const outcome = await execTool(
      "consult_advisor",
      { question: "How should login work?" },
      effects,
      deps
    );

    expect(outcome).toEqual({ ok: true, text: "Advisor (claude) replied:\n\nuse OAuth" });
    expect(effects.advisorCalls).toBe(1);
    // The real externalAdvisor.ts pipeline ran: the real shell invocation shape
    // (`zsh -ilc 'claude -p …'`), not a hand-rolled answer.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("zsh");
    expect(calls[0]?.args[0]).toBe("-ilc");
    expect(calls[0]?.args[1]).toContain("claude -p");
  });

  it("binds the run's Stop flag to the advisor, so a wedged CLI is actually killed", async () => {
    const { state } = freshOpenRoom();
    const turn = new TurnId(randomUUID(), randomUUID());
    const node = registerRun(state.cancel, turn.runId, "test run");
    // A CLI that accepts stdin and then never answers — the wedged `claude -p`
    // the hazard is about. Only the cancel watcher can end this.
    const spawned: FakeAdvisorProcess[] = [];
    const spawnFn: AdvisorSpawnFn = () => {
      const proc = new FakeAdvisorProcess();
      spawned.push(proc);
      proc.stdin.resume();
      return proc;
    };

    try {
      const deps = liveExecToolDeps(state, () => {}, { turn, advisorOptions: { spawnFn } });
      const pending = execTool("consult_advisor", { question: "hang please" }, createToolEffects(), deps);

      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      node.flag().store(true);
      // The watcher polls every 100ms and kills — with no flag bound (the
      // default `realRunAdvisorCli` both earlier drafts installed) nothing
      // would ever signal this child and `pending` would never settle.
      await vi.waitFor(() => expect(spawned[0]!.killed).toContain("SIGTERM"));

      spawned[0]!.stdout.end();
      spawned[0]!.stderr.end();
      spawned[0]!.emit("close", null, "SIGTERM");
      const outcome = await pending;
      // execConsultAdvisor turns a rejected advisor call into an `ok` steer,
      // never a fabricated answer.
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.text).toContain("could not be reached");
      }
    } finally {
      state.cancel.cancels.delete(turn.runId);
      forget(state.cancel, turn.runId);
    }
  });

  it("keeps the flagless default when there is genuinely no run flag to bind", () => {
    const { state } = freshOpenRoom();
    expect(liveExecToolDeps(state, () => {}).runAdvisorCli).toBe(realRunAdvisorCli);
  });
});

// ============================================================================
// assembleLiveContext — the one entry point a real host wires up
// ============================================================================

describe("assembleLiveContext", () => {
  it("bundles a real, drivable RunCommandDeps and per-call CmdCtx/ExecToolDeps builders", async () => {
    const { state } = freshOpenRoom();
    const ctx = assembleLiveContext(state, () => {});

    const reply = await runCommand(
      baseRequest({ command: "remember", args: "assembled for real", raw: "#remember assembled for real" }),
      { ...ctx.runCommandDeps, ...FIXED_MODELS }
    );
    expect(reply.content).toContain("Saved to memory");
    expect(listMemories(state.room!.conn).map((m) => m.content)).toContain("assembled for real");

    const turn = new TurnId(randomUUID(), randomUUID());
    const execDeps = ctx.execToolDeps({ turn });
    expect(execDeps.db).toBe(state.room!.conn);
    expect(execDeps.runId).toBe(turn.runId);

    const cmdCtx = ctx.cmdCtx({ model: "qwen3.5:4b", turn });
    expect(cmdCtx.layoutGraph).toBe(layoutGraphReal);
    expect(cmdCtx.rooms.current()?.path).toBe(state.room!.path);
  });
});
