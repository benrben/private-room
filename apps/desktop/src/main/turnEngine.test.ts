/**
 * Tests for `turnEngine.ts`: `ask`, `streamAnswer`,
 * `persistAssistantReply(Pinned)`, `saveGeneratedFile`, `handoffChat` and
 * `handoffUsageValue`.
 *
 * Real fixture rooms (`db-host/open.ts`'s `createRoom`), real `cancel.ts`
 * trees, real `turn.ts` envelopes. The sidecar `/run` call is driven for real
 * over a local `node:http` NDJSON server through `sidecar.ts`'s own
 * `streamRun` — the seam that module built for exactly this — wherever the
 * scenario is about the wire (done/empty/failed/cancel). A directly injected
 * outcome is used only where the test is about what `turnEngine.ts` does with
 * an outcome it has already been handed, so no test re-races sidecar.ts's own
 * network timing.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskEnvelope } from "../shared/events.js";
import { cancelId, createCancelState, nodeFor, type CancelState } from "./cancel.js";
import { createChat } from "./db-host/chats.js";
import { insertFile } from "./db-host/files.js";
import { insertHandoffMessage, insertMessage, listMessages } from "./db-host/messages.js";
import { createRoom } from "./db-host/open.js";
import { setSetting } from "./db-host/settings.js";
import { createToolEffects } from "./execTool.js";
import type { PolicyState } from "./privacy.js";
import { Redactor } from "./privacyRedact.js";
import { RoomPin } from "./roomPin.js";
import { streamRun, type RunViaSidecarOptions, type RunViaSidecarRequest, type SidecarOutcome } from "./sidecar.js";
import { TurnId } from "./turn.js";
import { LOST_REPLY_AFTER_WRITE, LOST_REPLY_CLEAN, LOST_REPLY_WITH_JOB } from "./turnNotices.js";
import {
  ask,
  handoffChat,
  handoffUsageValue,
  persistAssistantReply,
  persistAssistantReplyPinned,
  saveGeneratedFile,
  streamAnswer,
  type AskDeps,
  type OpenRoom,
  type StreamAnswerDeps,
  type StreamAnswerRequest,
  type TurnRoomSource,
} from "./turnEngine.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";

// ------------------------------------------------------------------ fixtures

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function freshRoomDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "turn-engine-"));
  tmpDirs.push(dir);
  const roomPath = path.join(dir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** A mutable {@link TurnRoomSource} double: it can be closed, or swapped to a
 * different room at a new epoch, mid-test. */
function makeRoomSource(initial: OpenRoom | null, epoch = 1) {
  let room = initial;
  let ep = epoch;
  return {
    roomEpoch: () => ep,
    currentRoomPath: () => room?.path ?? null,
    currentRoom: () => room,
    setRoom(next: OpenRoom | null, newEpoch?: number): void {
      room = next;
      if (newEpoch !== undefined) {
        ep = newEpoch;
      }
    },
  } satisfies TurnRoomSource & { setRoom: (next: OpenRoom | null, newEpoch?: number) => void };
}

function recordingSender(): { send: (event: string, payload: unknown) => void; events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  return { send: (event, payload) => events.push([event, payload]), events };
}

function stepLabels(events: Array<[string, unknown]>): string[] {
  return events.filter(([e]) => e === "ask-step").map(([, v]) => (v as AskEnvelope<string>).v);
}

function alwaysFlag(value: boolean): StreamAnswerRequest["cancel"] {
  return { load: () => value } as StreamAnswerRequest["cancel"];
}

function fakeOutcome(o: Partial<SidecarOutcome> & { kind: SidecarOutcome["kind"] }): SidecarOutcome {
  if (o.kind === "done") {
    return { kind: "done", text: o.text ?? "", usage: o.usage ?? null, plan: o.plan ?? null };
  }
  return {
    kind: "failed",
    text: o.text ?? "",
    error: (o as { error?: string }).error ?? "boom",
    toolRan: (o as { toolRan?: boolean }).toolRan ?? false,
    usage: o.usage ?? null,
    plan: o.plan ?? null,
  };
}

function protectedPolicy(): PolicyState {
  const rules = [
    ["Ben Reich", "[Person A]"],
    ["ben@example.com", "[Email A]"],
  ] as const;
  return {
    active: true,
    rules: rules.map((rule) => [rule[0], rule[1]] as const),
    concepts: [],
    guardModel: "qwen3.5:4b",
    redactor: new Redactor(rules),
  };
}

// --------------------------------------------------- a real NDJSON /run server

interface FakeServer {
  url: string;
  /** Every `/cancel` body this server received. */
  cancels: Array<Record<string, unknown>>;
  /** The `/run` bodies it was sent, in order. */
  runs: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

/**
 * A real local NDJSON `/run` server. The script is chosen from the request
 * body's own `question`, mirroring how the wire-compat suite picks a scenario
 * off the request — so one instance serves every case in this file.
 *
 * `HANG:` streams a delta and then holds the response open forever, which is
 * what makes a Stop observable end to end: the only way the stream ends is the
 * client aborting and POSTing `/cancel`.
 */
async function startFakeRunServer(): Promise<FakeServer> {
  const open = new Set<http.ServerResponse>();
  const cancels: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      if (req.method === "POST" && req.url === "/cancel") {
        cancels.push(body);
        for (const held of open) {
          held.end();
        }
        open.clear();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      runs.push(body);
      const runId = body.run_id as string;
      const question = body.question as string;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (ev: Record<string, unknown>): void => {
        res.write(`${JSON.stringify({ ...ev, run_id: runId })}\n`);
      };
      if (question.startsWith("ECHO:")) {
        const text = question.slice("ECHO:".length);
        line({ t: "step", v: "Thinking" });
        line({ t: "delta", v: text });
        line({ t: "usage", tokens: 42 });
        line({ t: "final", v: text });
      } else if (question === "EMPTY") {
        line({ t: "final", v: "" });
      } else if (question.startsWith("FAIL:")) {
        line({ t: "error", v: question.slice("FAIL:".length) });
      } else if (question.startsWith("HANG:")) {
        line({ t: "delta", v: question.slice("HANG:".length) });
        open.add(res);
        return; // held open until the client cancels
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    cancels,
    runs,
    close: () =>
      new Promise((resolve) => {
        for (const held of open) {
          held.end();
        }
        open.clear();
        server.close(() => resolve());
      }),
  };
}

function runViaFakeServer(base: string) {
  return (req: RunViaSidecarRequest, opts: RunViaSidecarOptions): Promise<SidecarOutcome> => streamRun(base, req, opts);
}

// ================================================== persist assistant reply

describe("persistAssistantReply / persistAssistantReplyPinned", () => {
  it("writes when the room is open and no pin is given", () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const msg = persistAssistantReply(room, chat.id, "hello", ["a.txt"], null);
    expect(msg.id).not.toBe("");
    expect(listMessages(db, chat.id)).toHaveLength(1);
  });

  it("writes when the pin still holds the room open now", () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const pin = RoomPin.take(room);
    const msg = persistAssistantReplyPinned(room, pin, chat.id, "the answer", ["file.txt"], null);
    expect(msg.id).not.toBe("");
    expect(listMessages(db, chat.id).map((m) => m.content)).toContain("the answer");
  });

  it("refuses (quietly, in memory) when the room closed mid-answer", () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const pin = RoomPin.take(room);
    room.setRoom(null);
    const msg = persistAssistantReplyPinned(room, pin, chat.id, "orphaned", [], null);
    expect(msg.id).toBe("");
    expect(msg.content).toBe("orphaned");
    expect(listMessages(db, chat.id)).toHaveLength(0);
  });

  it("refuses when a DIFFERENT room was opened while the answer was in flight", () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const other = freshRoomDb();
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const pin = RoomPin.take(room);
    room.setRoom({ db: other, path: "/rooms/b.roomai" }, 2);
    const msg = persistAssistantReplyPinned(room, pin, chat.id, "late answer", [], null);
    expect(msg.id).toBe("");
    expect(msg.content).toBe("late answer");
    // Neither room received it — the point of the pin.
    expect(listMessages(db, chat.id)).toHaveLength(0);
    expect(listMessages(other, chat.id)).toHaveLength(0);
  });

  it("refuses when the SAME room file was closed and reopened (new epoch)", () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const pin = RoomPin.take(room);
    room.setRoom({ db, path: "/rooms/a.roomai" }, 2);
    expect(persistAssistantReplyPinned(room, pin, chat.id, "stale", [], null).id).toBe("");
    expect(listMessages(db, chat.id)).toHaveLength(0);
  });

  it("returns an unsaved message when no room is open at write time", () => {
    const room = makeRoomSource(null);
    const pin = RoomPin.take(room);
    const msg = persistAssistantReplyPinned(room, pin, "chat-x", "answer", ["s.txt"], { usage: 1 });
    expect(msg.id).toBe("");
    expect(msg.content).toBe("answer");
    expect(msg.sources).toEqual(["s.txt"]);
    expect(msg.effects).toEqual({ usage: 1 });
  });
});

// ========================================================= saveGeneratedFile

describe("saveGeneratedFile", () => {
  it("defaults to .md when the requested name has no extension", () => {
    const db = freshRoomDb();
    const meta = saveGeneratedFile(db, "Saved answer", "some content");
    expect(meta.name).toBe("Saved answer.md");
    expect(meta.mimeType).toBe("text/markdown");
    expect(meta.source).toBe("generated");
  });

  it("keeps an explicit extension and guesses its mime", () => {
    const db = freshRoomDb();
    expect(saveGeneratedFile(db, "data.csv", "a,b,c").mimeType).toBe("text/csv");
    expect(saveGeneratedFile(db, "notes.txt", "hi").mimeType).toBe("text/plain");
  });

  it("falls back to text/plain for an unrecognized extension", () => {
    const db = freshRoomDb();
    expect(saveGeneratedFile(db, "weird.xyz", "???").mimeType).toBe("text/plain");
  });

  it("survives a requested name whose extension is an Object.prototype key", () => {
    // `requestedName` is the USER'S OWN TYPED TEXT ("save that as …", parsed
    // by `requestedFileName`) — so an extension of `constructor`/
    // `__proto__`/… must not read `Object`/`Object.prototype` off the plain
    // MIME_BY_EXT `{}` literal in place of "not found" (see docsHtml.ts's
    // `noteMime` for the same class of bug on a sibling copy of this table).
    // A non-string mime reaching `insertFile` dies inside better-sqlite3 with
    // "SQLite3 can only bind numbers, strings, bigints, buffers, and null";
    // guarded, it falls back to text/plain exactly like
    // `mime_guess::from_path` does in Rust.
    const db = freshRoomDb();
    for (const name of ["Report.constructor", "Report.__proto__", "Report.hasOwnProperty"]) {
      const meta = saveGeneratedFile(db, name, "content");
      expect(meta.name).toBe(name);
      expect(meta.mimeType).toBe("text/plain");
    }
  });
});

// ============================================================== streamAnswer

describe("streamAnswer", () => {
  let server: FakeServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  function baseReq(overrides: Partial<StreamAnswerRequest> = {}): StreamAnswerRequest {
    return {
      model: "qwen3.5:4b",
      question: "hi",
      chatMessages: [{ role: "user", content: "hi" }],
      temperature: null,
      effects: createToolEffects(),
      webEnabled: false,
      advisorsOn: false,
      evidencePolicy: "normal",
      cancel: alwaysFlag(false),
      privacyBypass: false,
      turn: new TurnId("run-1", "chat-1"),
      mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
      ...overrides,
    };
  }

  function depsFor(overrides: Partial<StreamAnswerDeps> = {}): StreamAnswerDeps {
    return { send: () => {}, resolvedBaseUrl: () => "http://fake-ollama", ...overrides };
  }

  it("streams a real NDJSON run: returns the text, merges usage, stamps the events", async () => {
    server = await startFakeRunServer();
    const { send, events } = recordingSender();
    const req = baseReq({ question: "ECHO:hello there" });
    const text = await streamAnswer(req, depsFor({ send, runViaSidecar: runViaFakeServer(server.url) }));
    expect(text).toBe("hello there");
    expect(req.effects.tokenUsage).toEqual({ tokens: 42 });
    const delta = events.find(([e]) => e === "ask-delta");
    expect((delta?.[1] as AskEnvelope<string>).runId).toBe("run-1");
    expect((delta?.[1] as AskEnvelope<string>).v).toBe("hello there");
  });

  it("sends the run id and the resolved Ollama base URL on the wire", async () => {
    server = await startFakeRunServer();
    await streamAnswer(
      baseReq({ question: "ECHO:hi", turn: new TurnId("the-run-id", "chat-1") }),
      depsFor({ runViaSidecar: runViaFakeServer(server.url), resolvedBaseUrl: () => "http://closet:11434" })
    );
    expect(server.runs[0]?.run_id).toBe("the-run-id");
    // C1: a room pointed at a remote Ollama must not silently fall back to the
    // sidecar's own localhost default.
    expect(server.runs[0]?.ollama_base_url).toBe("http://closet:11434");
  });

  it("sends the host hard tool policy and disables web and advisors", async () => {
    const runViaSidecar = vi.fn(async (request: RunViaSidecarRequest) =>
      fakeOutcome({ kind: "done", text: "A mutex protects shared state." }));
    await streamAnswer(
      baseReq({
        question: "Do not use tools. Explain mutexes.",
        webEnabled: false,
        advisorsOn: false,
        evidencePolicy: "no-tools-no-sources",
      }),
      depsFor({ runViaSidecar }),
    );
    expect(runViaSidecar).toHaveBeenCalledWith(
      expect.objectContaining({ toolPolicy: "none", webEnabled: false, advisors: [] }),
      expect.anything(),
    );
  });

  it("sends the active policy and stream-redacts split output for local and cloud models", async () => {
    for (const model of ["qwen3.5:4b", "claude-cli::opus"]) {
      const { send, events } = recordingSender();
      let seen: RunViaSidecarRequest | null = null;
      const answer = await streamAnswer(
        baseReq({ model }),
        depsFor({
          send,
          privacyPolicy: protectedPolicy,
          runViaSidecar: async (request, opts) => {
            seen = request;
            opts.turn?.emit(opts.onEvent, "ask-delta", "Call Ben ");
            opts.turn?.emit(opts.onEvent, "ask-delta", "Reich at ben@");
            opts.turn?.emit(opts.onEvent, "ask-delta", "example.com.");
            return fakeOutcome({
              kind: "done",
              text: "Call Ben Reich at ben@example.com.",
            });
          },
        }),
      );

      const request = seen as RunViaSidecarRequest | null;
      expect(request?.privacy).toMatchObject({
        active: true,
        rules: [
          { real: "Ben Reich", placeholder: "[Person A]" },
          { real: "ben@example.com", placeholder: "[Email A]" },
        ],
      });
      const visible = events
        .filter(([event]) => event === "ask-delta")
        .map(([, payload]) => (payload as AskEnvelope<string>).v)
        .join("");
      expect(visible).toBe("Call [Person A] at [Email A].");
      expect(visible).not.toContain("Ben Reich");
      expect(visible).not.toContain("ben@example.com");
      expect(answer).toBe("Call [Person A] at [Email A].");
    }
  });

  it("redacts every visible event form and silently drops malformed deltas", async () => {
    const { send, events } = recordingSender();
    const answer = await streamAnswer(
      baseReq(),
      depsFor({
        send,
        privacyPolicy: protectedPolicy,
        runViaSidecar: async (_request, options) => {
          options.onEvent("ask-round", { v: "replacement" });
          options.onEvent("ask-step", { v: "working" });
          options.onEvent("ask-delta", "Ben Reich");
          options.onEvent("ask-delta", null);
          options.onEvent("ask-delta", { v: 42 });
          return fakeOutcome({ kind: "done", text: "Ben Reich" });
        },
      })
    );

    expect(events.some(([event]) => event === "ask-round")).toBe(true);
    expect(events.some(([event]) => event === "ask-step")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("Ben Reich");
    expect(answer).toBe("[Person A]");
  });

  it("an explicit privacy bypass sends no policy and keeps the answer unchanged", async () => {
    let seen: RunViaSidecarRequest | null = null;
    const answer = await streamAnswer(
      baseReq({ privacyBypass: true }),
      depsFor({
        privacyPolicy: protectedPolicy,
        runViaSidecar: async (request) => {
          seen = request;
          return fakeOutcome({ kind: "done", text: "Ben Reich" });
        },
      }),
    );
    expect((seen as RunViaSidecarRequest | null)?.privacy).toBeNull();
    expect(answer).toBe("Ben Reich");
  });

  it("a Stop mid-stream reaches the sidecar: /cancel is POSTed and the partial is kept", async () => {
    server = await startFakeRunServer();
    let stopped = false;
    const req = baseReq({ question: "HANG:partial so far", cancel: { load: () => stopped } as StreamAnswerRequest["cancel"] });
    setTimeout(() => {
      stopped = true;
    }, 120);
    const text = await streamAnswer(req, depsFor({ runViaSidecar: runViaFakeServer(server.url) }));
    expect(server.cancels).toHaveLength(1);
    expect(server.cancels[0]?.run_id).toBe("run-1");
    expect(text).toBe("partial so far");
  });

  it("keeps the partial and appends the mid-run failure note on a terminal error", async () => {
    server = await startFakeRunServer();
    const text = await streamAnswer(
      baseReq({ question: "FAIL:boom" }),
      depsFor({ runViaSidecar: runViaFakeServer(server.url) })
    );
    expect(text).toContain("hit an error and stopped mid-run: boom");
    expect(text).toContain("Any change shown here was already applied.");
  });

  it("retains a whitespace partial before the terminal failure note", async () => {
    const text = await streamAnswer(
      baseReq(),
      depsFor({ runViaSidecar: async () => fakeOutcome({ kind: "failed", text: "  ", error: "boom" }) })
    );
    expect(text.startsWith("  *(The agent hit an error")).toBe(true);
  });

  it("an empty final picks the honest notice from what the runtime KNOWS", async () => {
    server = await startFakeRunServer();
    const run = runViaFakeServer(server.url);

    expect(await streamAnswer(baseReq({ question: "EMPTY" }), depsFor({ runViaSidecar: run }))).toBe(LOST_REPLY_CLEAN);

    const wrote = createToolEffects();
    wrote.wrote = true;
    expect(await streamAnswer(baseReq({ question: "EMPTY", effects: wrote }), depsFor({ runViaSidecar: run }))).toBe(
      LOST_REPLY_AFTER_WRITE
    );

    expect(
      await streamAnswer(
        baseReq({ question: "EMPTY" }),
        depsFor({ runViaSidecar: run, jobStatuses: () => [{ status: "running" }] })
      )
    ).toBe(LOST_REPLY_WITH_JOB);
  });

  it("an empty answer AFTER a Stop is not reported as a lost reply", async () => {
    const text = await streamAnswer(
      baseReq({ cancel: alwaysFlag(true) }),
      depsFor({ runViaSidecar: async () => fakeOutcome({ kind: "done", text: "" }) })
    );
    expect(text).toBe("*(The agent was stopped before it produced an answer, and nothing was written.)*");
  });

  it("a non-empty partial after a Stop is returned as-is (a clean Stop is a successful partial)", async () => {
    const text = await streamAnswer(
      baseReq({ cancel: alwaysFlag(true) }),
      depsFor({ runViaSidecar: async () => fakeOutcome({ kind: "done", text: "partial answer" }) })
    );
    expect(text).toBe("partial answer");
  });

  it("announces a cloud CLI engine before anything is sent, and never for a local model", async () => {
    const cli = recordingSender();
    await streamAnswer(
      baseReq({ model: "claude-cli::opus" }),
      depsFor({ send: cli.send, runViaSidecar: async () => fakeOutcome({ kind: "done", text: "ok" }) })
    );
    expect(stepLabels(cli.events)).toContain("Asking your cloud AI (content leaves this Mac)");

    const local = recordingSender();
    await streamAnswer(
      baseReq({ model: "qwen3.5:4b" }),
      depsFor({ send: local.send, runViaSidecar: async () => fakeOutcome({ kind: "done", text: "ok" }) })
    );
    expect(stepLabels(local.events)).not.toContain("Asking your cloud AI (content leaves this Mac)");
  });

  it("emits the PRIV-1 bypass note only when a policy was actually there to bypass", async () => {
    const withDoor = recordingSender();
    await streamAnswer(
      baseReq({ privacyBypass: true }),
      depsFor({
        send: withDoor.send,
        privacyActive: () => true,
        runViaSidecar: async () => fakeOutcome({ kind: "done", text: "ok" }),
      })
    );
    expect(
      withDoor.events.some(([e, v]) => e === "ask-privacy" && (v as AskEnvelope<{ bypassed: boolean }>).v.bypassed)
    ).toBe(true);

    const noDoor = recordingSender();
    await streamAnswer(
      baseReq({ privacyBypass: true }),
      depsFor({ send: noDoor.send, runViaSidecar: async () => fakeOutcome({ kind: "done", text: "ok" }) })
    );
    expect(noDoor.events.some(([e]) => e === "ask-privacy")).toBe(false);
  });

  it("resolves advisors — and sends them on the wire — only when advisorsOn", async () => {
    const detected = vi.fn(async () => ["claude-cli"]);
    let seen: RunViaSidecarRequest | undefined;
    await streamAnswer(
      baseReq({ advisorsOn: true }),
      depsFor({
        detectedAdvisors: detected,
        runViaSidecar: async (r) => {
          seen = r;
          return fakeOutcome({ kind: "done", text: "ok" });
        },
      })
    );
    expect(detected).toHaveBeenCalledTimes(1);
    expect(seen?.advisors).toEqual(["claude-cli"]);

    detected.mockClear();
    await streamAnswer(
      baseReq({ advisorsOn: false }),
      depsFor({ detectedAdvisors: detected, runViaSidecar: async () => fakeOutcome({ kind: "done", text: "ok" }) })
    );
    expect(detected).not.toHaveBeenCalled();
  });

  it("a null usage/plan does not erase what a bridge session already recorded", async () => {
    const effects = createToolEffects();
    effects.tokenUsage = { total_tokens: 7 };
    await streamAnswer(
      baseReq({ effects }),
      depsFor({ runViaSidecar: async () => fakeOutcome({ kind: "done", text: "ok" }) })
    );
    expect(effects.tokenUsage).toEqual({ total_tokens: 7 });
  });

  it("merges a reported sidecar plan alongside usage", async () => {
    const effects = createToolEffects();
    await streamAnswer(
      baseReq({ effects }),
      depsFor({
        runViaSidecar: async () => fakeOutcome({ kind: "done", text: "ok", usage: { tokens: 12 }, plan: { step: "search" } }),
      })
    );
    expect(effects.tokenUsage).toEqual({ tokens: 12 });
    expect(effects.agentPlan).toEqual({ step: "search" });
  });

  // `runViaSidecar` throws for exactly one failure class — `ensureUp` could not
  // start the sidecar at all — which is Rust's `SidecarOutcome::Unavailable`.
  it("a sidecar that could not start surfaces Rust's own sentence, carrying the reason", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        streamAnswer(
          baseReq(),
          depsFor({
            runViaSidecar: async () => {
              throw new Error("SIDECAR_UNAVAILABLE: no bundled binary in Resources/");
            },
          })
        )
      ).rejects.toThrow(
        "AI engine unavailable — the agent sidecar could not start (SIDECAR_UNAVAILABLE: no bundled binary in Resources/)."
      );
      // The app writes no log of its own, so the underlying reason has to go
      // somewhere a person can read it.
      expect(logged).toHaveBeenCalledWith(
        "agent sidecar unavailable: SIDECAR_UNAVAILABLE: no bundled binary in Resources/"
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("that same failure AFTER a Stop reports nothing — a stopped turn is not an app failure", async () => {
    const text = await streamAnswer(
      baseReq({ cancel: alwaysFlag(true) }),
      depsFor({
        runViaSidecar: async () => {
          throw new Error("SIDECAR_UNAVAILABLE: could not start the sidecar");
        },
      })
    );
    // Empty, exactly as Rust's `Err(_) if stopped => Ok(String::new())` — `ask`
    // then writes the bare `*(stopped)*` marker over it.
    expect(text).toBe("");
  });
});

// ====================================================================== ask

describe("ask", () => {
  let server: FakeServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  function askDeps(
    room: TurnRoomSource,
    cancelState: CancelState,
    send: (event: string, payload: unknown) => void,
    overrides: Partial<AskDeps> = {}
  ): AskDeps {
    return {
      room,
      cancelState,
      send,
      mcp: () => ({ url: "http://127.0.0.1:1/mcp", token: "tok" }),
      isAwake: async () => true,
      resolvedBaseUrl: () => "http://fake-ollama",
      listModels: async () => ["qwen3.5:4b"],
      runViaSidecar: async () => fakeOutcome({ kind: "done", text: "The lease ends March 2027." }),
      ...overrides,
    };
  }

  it("answers end to end over a real /run stream and clears BOTH cancel registries", async () => {
    server = await startFakeRunServer();
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const cancelState = createCancelState();
    const { send } = recordingSender();

    const msg = await ask(
      { askId: "ask-1", chatId: chat.id, question: "ECHO:the answer", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, cancelState, send, { runViaSidecar: runViaFakeServer(server.url) })
    );

    expect(msg.content).toBe("the answer");
    expect(msg.id).not.toBe("");
    // `CancelGuard::drop` removes the flat flag AND the tree node. Leaving the
    // flat one behind would make `close_room`'s drain wait forever.
    expect(cancelState.cancels.has("ask-1")).toBe(false);
    expect(nodeFor(cancelState, "ask-1")).toBeUndefined();
  });

  it("persists only the deterministically redacted final assistant answer", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/private.roomai" });
    const msg = await ask(
      {
        askId: "ask-private",
        chatId: chat.id,
        question: "Who should I call?",
        attachments: [],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), () => {}, {
        privacyPolicy: protectedPolicy,
        runViaSidecar: async () =>
          fakeOutcome({
            kind: "done",
            text: "Call Ben Reich at ben@example.com.",
          }),
      }),
    );

    expect(msg.content).toBe("Call [Person A] at [Email A].");
    expect(listMessages(db, chat.id).at(-1)?.content).toBe(
      "Call [Person A] at [Email A].",
    );
  });

  it("clears both cancel registries even when Phase 1 throws", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const cancelState = createCancelState();

    await expect(
      ask(
        { askId: "ask-err", chatId: chat.id, question: "/no-such-skill go", attachments: [], viewing: null, privacyBypass: false },
        askDeps(room, cancelState, () => {})
      )
    ).rejects.toThrow(/No skill named/);

    expect(cancelState.cancels.has("ask-err")).toBe(false);
    expect(nodeFor(cancelState, "ask-err")).toBeUndefined();
  });

  // Phase 1 throwing is the EASY exit path — it happens before the answer is
  // even requested. The one that actually leaks is a throw MID-FLIGHT, after
  // the run is registered and the sidecar call is under way: without the
  // `finally`, `close_room`'s drain would then wait on this ask forever.
  it("clears both cancel registries when the turn throws MID-FLIGHT, after the run is registered", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const cancelState = createCancelState();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        ask(
          { askId: "ask-mid", chatId: chat.id, question: "hi", attachments: [], viewing: null, privacyBypass: false },
          askDeps(room, cancelState, () => {}, {
            runViaSidecar: async () => {
              // The run IS registered by now — Phase 1 already ran.
              expect(nodeFor(cancelState, "ask-mid")).toBeDefined();
              expect(cancelState.cancels.has("ask-mid")).toBe(true);
              throw new Error("SIDECAR_UNAVAILABLE: could not start the sidecar");
            },
          })
        )
      ).rejects.toThrow("AI engine unavailable");
    } finally {
      logged.mockRestore();
    }

    expect(cancelState.cancels.has("ask-mid")).toBe(false);
    expect(nodeFor(cancelState, "ask-mid")).toBeUndefined();
  });

  it("clears both cancel registries when the deferred grounding pass throws", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const cancelState = createCancelState();
    const img = insertFile(db, "receipt.png", "image/png", Buffer.from([1, 2, 3]), null, "upload");

    await expect(
      ask(
        {
          askId: "ask-ground-boom",
          chatId: chat.id,
          question: "where is the total on the image?",
          attachments: [img.id],
          viewing: null,
          privacyBypass: false,
        },
        askDeps(room, cancelState, () => {}, {
          groundingPass: async () => {
            throw new Error("the vision model fell over");
          },
        })
      )
    ).rejects.toThrow("the vision model fell over");

    expect(cancelState.cancels.has("ask-ground-boom")).toBe(false);
    expect(nodeFor(cancelState, "ask-ground-boom")).toBeUndefined();
  });

  it("refuses to start while the room is rolling back, before registering anything", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room: TurnRoomSource = { ...makeRoomSource({ db, path: "/rooms/a.roomai" }), rollingBack: () => true };
    const cancelState = createCancelState();

    await expect(
      ask(
        { askId: "ask-rb", chatId: chat.id, question: "hi", attachments: [], viewing: null, privacyBypass: false },
        askDeps(room, cancelState, () => {})
      )
    ).rejects.toThrow("The room is rolling back");
    expect(cancelState.cancels.has("ask-rb")).toBe(false);
  });

  it("throws when no room is open, and still cleans up", async () => {
    const room = makeRoomSource(null);
    const cancelState = createCancelState();
    await expect(
      ask(
        { askId: "ask-noroom", chatId: "whatever", question: "hi", attachments: [], viewing: null, privacyBypass: false },
        askDeps(room, cancelState, () => {})
      )
    ).rejects.toThrow("No room is open.");
    expect(cancelState.cancels.has("ask-noroom")).toBe(false);
    expect(nodeFor(cancelState, "ask-noroom")).toBeUndefined();
  });

  it("emits the three step chips in order, skipping the wake-up one when Ollama is awake", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });

    const awake = recordingSender();
    await ask(
      { askId: "ask-awake", chatId: chat.id, question: "hi", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), awake.send, { isAwake: async () => true })
    );
    expect(stepLabels(awake.events)).toEqual(["Preparing the search…", "Searching your files…"]);

    const asleep = recordingSender();
    await ask(
      { askId: "ask-asleep", chatId: chat.id, question: "hi", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), asleep.send, { isAwake: async () => false })
    );
    expect(stepLabels(asleep.events)).toEqual([
      "Starting the local AI…",
      "Preparing the search…",
      "Searching your files…",
    ]);
  });

  it("embeds BETWEEN the two search chips — never under a chip claiming the search already began", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const { send, events } = recordingSender();
    let labelsWhenEmbedding: string[] = [];

    await ask(
      { askId: "ask-embed", chatId: chat.id, question: "/lease-review find the rent", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), send, {
        embedQuestion: async (q) => {
          labelsWhenEmbedding = stepLabels(events);
          // ADD-13 embeds the REQUEST text of a /skill turn, not the command.
          expect(q).toBe("find the rent");
          return null;
        },
      })
    ).catch(() => {
      // The unknown skill makes Phase 1 throw; the embed step already ran.
    });

    expect(labelsWhenEmbedding).toEqual(["Preparing the search…"]);
    expect(stepLabels(events)).toEqual(["Preparing the search…", "Searching your files…"]);
  });

  it("hard mode skips embedding and search before sending a tool-less turn", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    insertFile(db, "private.txt", "text/plain", Buffer.from("secret"), "secret", "upload");
    setSetting(db, "web_provider", "duckduckgo");
    setSetting(db, "advisors_enabled", "on");
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const embedQuestion = vi.fn(async () => [0.1]);
    const connectedMcpServers = vi.fn(() => ["notion"]);
    const runViaSidecar = vi.fn(async (request: RunViaSidecarRequest) => {
      expect(request.toolPolicy).toBe("none");
      expect(request.webEnabled).toBe(false);
      expect(request.advisors).toEqual([]);
      expect(request.messages).toHaveLength(2);
      expect(request.messages?.at(-1)?.content).toBe("Question: Explain mutexes. Do not use tools.");
      return fakeOutcome({ kind: "done", text: "A mutex protects shared state." });
    });
    const { send, events } = recordingSender();

    await ask(
      {
        askId: "ask-hard",
        chatId: chat.id,
        question: "Explain mutexes. Do not use tools.",
        attachments: [],
        viewing: "private.txt",
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), send, {
        embedQuestion,
        connectedMcpServers,
        runViaSidecar,
      }),
    );

    expect(embedQuestion).not.toHaveBeenCalled();
    expect(connectedMcpServers).not.toHaveBeenCalled();
    expect(stepLabels(events)).toEqual(["Answering without tools or room sources"]);
  });

  it("hands the bridge seam this run's id and the room's advisor-tools decision", async () => {
    const db = freshRoomDb();
    setSetting(db, "advisors_enabled", "on");
    setSetting(db, "advisor_tools_enabled", "on");
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const mcp = vi.fn(() => ({ url: "http://127.0.0.1:1/mcp", token: "tok" }));

    await ask(
      { askId: "ask-mcp", chatId: chat.id, question: "hi", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), () => {}, { mcp, detectedAdvisors: async () => [] })
    );
    expect(mcp).toHaveBeenCalledWith("ask-mcp", true);
  });

  it("the pure-save fast path writes the previous reply as a file, without ever picking a model", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    insertMessage(db, chat.id, "user", "write me a poem", [], null);
    insertMessage(db, chat.id, "assistant", "Roses are red... *(stopped)*", [], null);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const listModels = vi.fn(async () => ["qwen3.5:4b"]);
    const runViaSidecar = vi.fn();
    const { send, events } = recordingSender();

    const msg = await ask(
      {
        askId: "ask-save",
        chatId: chat.id,
        question: "save that as a file called Poem",
        attachments: [],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), send, { listModels, runViaSidecar })
    );

    expect(listModels).not.toHaveBeenCalled();
    expect(runViaSidecar).not.toHaveBeenCalled();
    expect(msg.content).toBe('Saved your previous answer to the room as "Poem.md".');
    expect(events.some(([e]) => e === "ask-delta")).toBe(true);
    const files = db.prepare("SELECT name, extracted_text FROM files").all() as Array<{
      name: string;
      extracted_text: string;
    }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("Poem.md");
    // The stopped marker is stripped from the copy.
    expect(files[0]?.extracted_text).toBe("Roses are red...");
  });

  it("keeps a pure-save reply when the best-effort file notification fails", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    insertMessage(db, chat.id, "assistant", "A saved answer", [], null);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });

    const msg = await ask(
      { askId: "ask-save-notify", chatId: chat.id, question: "save that as a file", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), () => {}, {
        notifyFilesChanged: () => { throw new Error("window closed"); },
      })
    );

    expect(msg.content).toBe('Saved your previous answer to the room as "Saved answer.md".');
    expect(db.prepare("SELECT name FROM files").all()).toEqual([{ name: "Saved answer.md" }]);
  });

  it("the pure-save fast path publishes a normal file in a workspace room", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "turn-workspace-"));
    tmpDirs.push(parent);
    const root = path.join(parent, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    const workspace = new WorkspaceService(db, root);
    const chat = createChat(db);
    insertMessage(db, chat.id, "user", "write me a poem", [], null);
    insertMessage(db, chat.id, "assistant", "Workspace roses", [], null);
    const room = makeRoomSource({ db, path: root, workspace });

    const msg = await ask(
      {
        askId: "ask-workspace-save",
        chatId: chat.id,
        question: "save that as a file called Poem",
        attachments: [],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), () => {}),
    );

    expect(msg.content).toBe('Saved your previous answer to the room as "Poem.md".');
    expect(readFileSync(path.join(root, "Poem.md"), "utf8")).toBe("Workspace roses");
    const row = db.prepare(
      "SELECT storage_kind, original_bytes FROM files WHERE name = 'Poem.md'",
    ).get() as { storage_kind: string; original_bytes: Buffer | null };
    expect(row).toEqual({ storage_kind: "workspace", original_bytes: null });
    db.close();
  });

  it("the fast path never turns one of the app's OWN failure notices into a document", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    insertMessage(db, chat.id, "user", "do the thing", [], null);
    insertMessage(
      db,
      chat.id,
      "assistant",
      "*(The agent hit an error and stopped mid-run: boom. Any change shown here was already applied.)*",
      [],
      null
    );
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });

    const msg = await ask(
      { askId: "ask-notice", chatId: chat.id, question: "save that as a file", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), () => {})
    );

    // Fell through to the model instead of saving the error text.
    expect(msg.content).toBe("The lease ends March 2027.");
    expect(db.prepare("SELECT COUNT(*) AS n FROM files").get()).toEqual({ n: 0 });
  });

  it("appends the anti-fabrication correction when the answer claims an unbacked write", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });

    const msg = await ask(
      { askId: "ask-fab", chatId: chat.id, question: "fix the typo", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), () => {}, {
        runViaSidecar: async () => fakeOutcome({ kind: "done", text: "I've fixed the typo in the file." }),
      })
    );
    expect(msg.content).toContain("Correction: no file was actually changed this turn");
  });

  it("marks a stopped run, names the children the Stop also reached, and skips the fabrication check", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const cancelState = createCancelState();

    const msg = await ask(
      { askId: "ask-stop", chatId: chat.id, question: "start a long build", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, cancelState, () => {}, {
        runViaSidecar: async () => {
          nodeFor(cancelState, "ask-stop")!.child("Flashcards"); // still live when the Stop lands
          cancelId(cancelState, "ask-stop");
          return fakeOutcome({ kind: "done", text: "I've updated the file with what I had so far." });
        },
      })
    );

    expect(msg.content).toContain("*(Also stopped: Flashcards.)*");
    // The bare suffix stays LAST — the save-that path strips it by that literal.
    expect(msg.content.endsWith(" *(stopped)*")).toBe(true);
    expect(msg.content).not.toContain("Correction:");
    expect(cancelState.cancels.has("ask-stop")).toBe(false);
  });

  it("respects the room pin: a room swapped mid-turn does not receive the write", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const other = freshRoomDb();
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });

    const msg = await ask(
      { askId: "ask-pin", chatId: chat.id, question: "hi", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), () => {}, {
        runViaSidecar: async () => {
          // The user closed A and opened B while the answer was in flight.
          room.setRoom({ db: other, path: "/rooms/b.roomai" }, 2);
          return fakeOutcome({ kind: "done", text: "answer for A" });
        },
      })
    );

    expect(msg.id).toBe("");
    expect(msg.content).toBe("answer for A");
    expect(listMessages(db, chat.id).some((m) => m.role === "assistant")).toBe(false);
    expect(listMessages(other, chat.id).some((m) => m.role === "assistant")).toBe(false);
  });

  it("runs the deferred grounding pass only for a locate question, and records the boxes", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const groundingPass = vi.fn(async () => ({ fileId: "f1", name: "receipt.png", boxes: [{ x: 1 }] }));
    const img = insertFile(db, "receipt.png", "image/png", Buffer.from([1, 2, 3]), null, "upload");

    const located = await ask(
      {
        askId: "ask-ground",
        chatId: chat.id,
        question: "where is the total on the image?",
        attachments: [img.id],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), () => {}, { groundingPass })
    );
    expect(groundingPass).toHaveBeenCalledTimes(1);
    expect((located.effects as Record<string, unknown>).boxes).toEqual({
      fileId: "f1",
      name: "receipt.png",
      boxes: [{ x: 1 }],
    });

    groundingPass.mockClear();
    await ask(
      {
        askId: "ask-noground",
        chatId: chat.id,
        question: "what does this say?",
        attachments: [img.id],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), () => {}, { groundingPass })
    );
    expect(groundingPass).not.toHaveBeenCalled();
  });

  it("keeps the answer unmarked when the deferred grounding pass declines", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const img = insertFile(db, "receipt.png", "image/png", Buffer.from([1, 2, 3]), null, "upload");
    const groundingPass = vi.fn(async () => null);
    const { send, events } = recordingSender();

    const msg = await ask(
      {
        askId: "ask-ground-none",
        chatId: chat.id,
        question: "where is the total on the image?",
        attachments: [img.id],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), send, { groundingPass })
    );

    expect(groundingPass).toHaveBeenCalledTimes(1);
    expect(msg.effects).toBeNull();
    expect(stepLabels(events)).not.toContain("Marked the image");
  });

  // CHG-19 + CHG-17: the pass is DEFERRED to after the answer, which is exactly
  // what puts it on the far side of a Stop. Loading a multi-GB vision model for
  // a turn the user has already stopped is the one cost the deferral must not
  // introduce — and boxes drawn after a Stop would mark an answer that never
  // finished.
  it("never runs the grounding pass after a Stop, however locate-ish the question", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const cancelState = createCancelState();
    const groundingPass = vi.fn(async () => ({ fileId: "f1", name: "receipt.png", boxes: [{ x: 1 }] }));
    const img = insertFile(db, "receipt.png", "image/png", Buffer.from([1, 2, 3]), null, "upload");

    const msg = await ask(
      {
        askId: "ask-stopped-ground",
        chatId: chat.id,
        question: "where is the total on the image?",
        attachments: [img.id],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, cancelState, () => {}, {
        groundingPass,
        runViaSidecar: async () => {
          cancelId(cancelState, "ask-stopped-ground");
          return fakeOutcome({ kind: "done", text: "partial" });
        },
      })
    );

    expect(groundingPass).not.toHaveBeenCalled();
    expect(msg.content).toBe("partial *(stopped)*");
    expect(msg.effects).toBeNull();
  });

  // The gate reads BOTH highlight effects. Reading only `annotation` would
  // correct a model that really did draw boxes this turn — the anti-fabrication
  // check fabricating a fabrication.
  it("counts boxes as a highlight, so a real mark_image is not 'corrected'", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const img = insertFile(db, "receipt.png", "image/png", Buffer.from([1, 2, 3]), null, "upload");
    const claim = "I've marked the total for you.";
    const req = {
      chatId: chat.id,
      question: "where is the total on the image?",
      attachments: [img.id],
      viewing: null,
      privacyBypass: false,
    };
    const answered = { runViaSidecar: async () => fakeOutcome({ kind: "done", text: claim }) };

    const marked = await ask(
      { askId: "ask-boxed", ...req },
      askDeps(room, createCancelState(), () => {}, {
        ...answered,
        groundingPass: async () => ({ fileId: img.id, name: "receipt.png", boxes: [{ x: 1 }] }),
      })
    );
    expect(marked.content).toBe(claim);

    // Same claim, nothing drawn: now it IS corrected.
    const unmarked = await ask(
      { askId: "ask-unboxed", ...req },
      askDeps(room, createCancelState(), () => {}, answered)
    );
    expect(unmarked.content).toContain("Correction: no file was actually changed this turn");
  });

  it("the fast path stands down when the turn carries attachments — the paperclip may be the point", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const file = insertFile(db, "notes.txt", "text/plain", Buffer.from("secret plan"), "secret plan", "upload");
    insertMessage(db, chat.id, "user", "write me a poem", [], null);
    insertMessage(db, chat.id, "assistant", "Roses are red...", [], null);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });

    const msg = await ask(
      {
        askId: "ask-save-attached",
        chatId: chat.id,
        question: "save that as a file called Poem",
        attachments: [file.id],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), () => {})
    );

    expect(msg.content).toBe("The lease ends March 2027.");
    // Only the attachment — the bypass wrote nothing.
    expect(db.prepare("SELECT COUNT(*) AS n FROM files").get()).toEqual({ n: 1 });
  });

  it("the fast path copies the last real ANSWER, never a handoff marker row", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    insertMessage(db, chat.id, "user", "write me a poem", [], null);
    insertMessage(db, chat.id, "assistant", "Roses are red...", [], null);
    // A marker is an assistant row too, and it is the NEWEST one.
    insertHandoffMessage(db, chat.id, "Recap: they talked about poems.", null);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });

    const msg = await ask(
      {
        askId: "ask-save-marker",
        chatId: chat.id,
        question: "save that as a file called Poem",
        attachments: [],
        viewing: null,
        privacyBypass: false,
      },
      askDeps(room, createCancelState(), () => {})
    );

    expect(msg.content).toBe('Saved your previous answer to the room as "Poem.md".');
    const saved = db.prepare("SELECT extracted_text FROM files").get() as { extracted_text: string };
    expect(saved.extracted_text).toBe("Roses are red...");
  });

  it("asks the capability seam once, for the model this turn actually resolved to", async () => {
    const db = freshRoomDb();
    setSetting(db, "model", "claude-cli::opus");
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const chatModelSeesImages = vi.fn(async () => true);
    const effects = createToolEffects();
    let request: RunViaSidecarRequest | null = null;

    await ask(
      { askId: "ask-vision", chatId: chat.id, question: "hi", attachments: [], viewing: null, privacyBypass: false },
      askDeps(room, createCancelState(), () => {}, {
        chatModelSeesImages,
        effects,
        runViaSidecar: async (value) => {
          request = value;
          return fakeOutcome({ kind: "done", text: "ok" });
        },
      })
    );
    expect(chatModelSeesImages).toHaveBeenCalledTimes(1);
    expect(chatModelSeesImages).toHaveBeenCalledWith("claude-cli::opus");
    expect(effects.visionChat).toBe(true);
    expect((request as RunViaSidecarRequest | null)?.supportsVision).toBe(true);
  });
});

// ======================================================== handoffUsageValue

describe("handoffUsageValue", () => {
  it("charges the recap to history only, marking the whole snapshot estimated", () => {
    const v = handoffUsageValue("123456789", 8192);
    expect(v.total_tokens).toBe(3); // 9 bytes / 3
    expect(v.max_context).toBe(8192);
    expect(v.estimated).toBe(true);
    const breakdown = v.breakdown as Record<string, { tokens: number; estimated: boolean }>;
    expect(breakdown.history!.tokens).toBe(3);
    for (const c of ["system", "tools", "skills", "files"]) {
      expect(breakdown[c]!.tokens).toBe(0);
      expect(breakdown[c]!.estimated).toBe(true);
    }
  });

  it("keeps every legend category — a missing key would silently drop a segment", () => {
    expect(Object.keys(handoffUsageValue("", 1).breakdown as object)).toEqual([
      "system",
      "history",
      "tools",
      "skills",
      "files",
    ]);
  });

  // ------------------------------------------------ adversarial: Rust parity

  it("charges the recap in UTF-8 BYTES, as `recap.len()` does — not UTF-16 units", () => {
    // `token_usage.rs`'s `recap.len() as u64 / CHARS_PER_TOKEN` is a BYTE
    // length. A Hebrew recap is 2 bytes per character, an emoji 4, so a port
    // that used `recap.length` would report less than half the tokens and the
    // budget bar would understate a nearly-full window right after a handoff —
    // the one moment the bar exists to be honest about.
    expect(handoffUsageValue("שלום", 8192).total_tokens).toBe(2); // 8 bytes / 3
    expect("שלום".length).toBe(4); // what the wrong answer would have divided
    expect(handoffUsageValue("😀", 8192).total_tokens).toBe(1); // 4 bytes / 3
  });

  it("floors the division, exactly as Rust's integer division does", () => {
    expect(handoffUsageValue("ab", 8192).total_tokens).toBe(0); // 2/3 -> 0, not 0.67
    expect(handoffUsageValue("abcde", 8192).total_tokens).toBe(1); // 5/3 -> 1, not 1.67
    expect(Number.isInteger(handoffUsageValue("abcde", 8192).total_tokens)).toBe(true);
  });

  it("keeps history and total in step, and every other bucket honestly zero", () => {
    const v = handoffUsageValue("x".repeat(3000), 128_000);
    const breakdown = v.breakdown as Record<string, { tokens: number; estimated: boolean }>;
    expect(v.total_tokens).toBe(1000);
    expect(breakdown.history!.tokens).toBe(v.total_tokens);
    const others = ["system", "tools", "skills", "files"].map((c) => breakdown[c]!.tokens);
    expect(others).toEqual([0, 0, 0, 0]);
  });

  it("builds a breakdown with no inherited keys, whatever the recap says", () => {
    // Rule 2 of this migration: a `{}` literal keyed by anything the room or a
    // model can influence has already shipped a `__proto__` bug four times
    // here. The keys are fixed constants, so this pins that they stay fixed
    // (and that the object carries nothing from the prototype chain into the
    // serialized event).
    const v = handoffUsageValue("__proto__", 8192);
    const breakdown = v.breakdown as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(breakdown)).toEqual([
      "system",
      "history",
      "tools",
      "skills",
      "files",
    ]);
    expect(Object.prototype.hasOwnProperty.call(breakdown, "__proto__")).toBe(false);
    expect(JSON.parse(JSON.stringify(v.breakdown))).toEqual(breakdown);
  });
});

// ============================================================== handoffChat

describe("handoffChat", () => {
  function deps(room: TurnRoomSource, overrides: Partial<Parameters<typeof handoffChat>[1]> = {}) {
    return {
      room,
      listModels: async () => ["qwen3.5:4b"],
      handoffSummary: async () => "They greeted each other.",
      ...overrides,
    };
  }

  it("refuses to summarize an empty chat", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    await expect(handoffChat(chat.id, deps(room))).rejects.toThrow("Nothing to summarize yet.");
  });

  it("refuses when no room is open at all", async () => {
    await expect(handoffChat("chat-x", deps(makeRoomSource(null)))).rejects.toThrow("No room is open");
  });

  it("inserts a handoff marker carrying the recap and a usage snapshot", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    insertMessage(db, chat.id, "user", "hello", [], null);
    insertMessage(db, chat.id, "assistant", "hi there", [], null);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });

    const msg = await handoffChat(
      chat.id,
      deps(room, {
        contextWindowFor: async () => 8_000,
        handoffSummary: async (model, messages) => {
          expect(model).toBe("qwen3.5:4b");
          expect(messages.map((m) => m.content)).toEqual(["hello", "hi there"]);
          return "They greeted each other.";
        },
      })
    );

    expect(msg.kind).toBe("handoff");
    expect(msg.content).toBe("They greeted each other.");
    expect((msg.effects as Record<string, unknown>).max_context).toBe(8_000);
    expect((msg.effects as Record<string, unknown>).total_tokens).toBeDefined();
  });

  it("says what the recap could NOT cover when compaction dropped older turns", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    for (let i = 0; i < 5; i++) {
      insertMessage(db, chat.id, "user", `message number ${i}`, [], null);
    }
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    const msg = await handoffChat(
      chat.id,
      // A tiny window forces the budget down far enough that most rows are cut.
      deps(room, { contextWindowFor: async () => 30, handoffSummary: async () => "Recap." })
    );
    expect(msg.content).toContain("This recap covers the most recent");
    expect(msg.content).toContain("of 5 messages in this chat");
  });

  it("refuses an empty summary rather than wiping the conversation's memory", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    insertMessage(db, chat.id, "user", "hello", [], null);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    await expect(handoffChat(chat.id, deps(room, { handoffSummary: async () => "   " }))).rejects.toThrow(
      "The model returned an empty summary"
    );
    expect(listMessages(db, chat.id)).toHaveLength(1); // no marker inserted
  });

  it("refuses to write the recap into a room that closed while summarizing", async () => {
    const db = freshRoomDb();
    const chat = createChat(db);
    insertMessage(db, chat.id, "user", "hello", [], null);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    await expect(
      handoffChat(
        chat.id,
        deps(room, {
          handoffSummary: async () => {
            room.setRoom(null);
            return "A recap nobody can save.";
          },
        })
      )
    ).rejects.toThrow("The room closed while summarizing.");
    expect(listMessages(db, chat.id)).toHaveLength(1);
  });

  it("uses the room's explicitly chosen model over the installed default", async () => {
    const db = freshRoomDb();
    setSetting(db, "model", "claude-cli::opus");
    setSetting(db, "temperature", "0.2");
    const chat = createChat(db);
    insertMessage(db, chat.id, "user", "hello", [], null);
    const room = makeRoomSource({ db, path: "/rooms/a.roomai" });
    let seenModel = "";
    let seenTemp: number | null = null;
    await handoffChat(
      chat.id,
      deps(room, {
        handoffSummary: async (model, _messages, temperature) => {
          seenModel = model;
          seenTemp = temperature;
          return "Recap.";
        },
      })
    );
    expect(seenModel).toBe("claude-cli::opus");
    expect(seenTemp).toBe(0.2);
  });
});
