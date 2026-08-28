/**
 * REAL cross-language wire-compat test for `sidecar.ts`'s `/run` NDJSON
 * streaming client.
 *
 * The mirror image of `services/agent-sidecar/tests/test_mcp_bridge_wire_compat.py`: that
 * file is a PYTHON test that spawns a TS process and drives it with the real
 * `arcelle_sidecar.mcp_client.McpClient`. Here a TS test spawns a Python
 * process — the REAL, UNMODIFIED `arcelle_sidecar.server.create_app` under
 * uvicorn, wired to the same `FakeChatModel`/`FakeMCP` test doubles
 * `services/agent-sidecar/tests/test_server.py` already uses (via
 * `services/agent-sidecar/tests/tools/run_wire_compat_server.py`; read that file's own doc
 * for exactly how) — and drives it with the newly ported `streamRun`.
 * Nothing at the language boundary is mocked. Only the MODEL is a double,
 * through `create_app`'s own `chat_factory` seam, which is how the Python
 * suite's own tests already stand up a deterministic sidecar.
 *
 * ONE SHARED SERVER. Every scenario below runs against a single long-lived
 * instance (the scenario is chosen per request, off `RunRequest.model`), so
 * what is proven is what one real process actually does across a sequence of
 * runs — including that a run it has already released answers `/cancel` with
 * `known:false`, which a per-scenario server could not show.
 *
 * THE HARD CONDITIONS COME FROM A TCP RELAY, NOT THE SERVER. A severed
 * stream, a cleanly TRUNCATED one, a foreign run's line interleaved into ours
 * and a line cut in half mid-character are all TRANSPORT conditions; the real
 * server cannot produce any of them from the inside (see the launcher's own
 * doc — `graph.stream_events` catches `BaseException` and always emits a
 * terminal `error` line, which is the fix for the live-QA 2026-07-30
 * defect). So {@link startRelay} sits in front of the real server and
 * reshapes its real bytes. The server stays real and unmodified either way.
 *
 * The relay is CHUNK-AWARE (2026-08-22): it decodes uvicorn's HTTP/1.1
 * chunked framing and re-frames each NDJSON line itself. That is what makes
 * the two conditions the original batch could not express possible — ending
 * the body CLEANLY with a real `0\r\n\r\n` terminator and no `final` (the
 * only route to `finalOutcome`'s `finalSeen === false` arm, which a severed
 * socket does NOT reach), and splitting one line across two genuinely
 * separate TCP segments at a byte offset asserted to be mid-UTF-8-sequence.
 * It also re-points `/cancel` bodies at an unregistered run id, so a real
 * `known:false` retry can be observed end to end without faking the reply.
 *
 * Requires `uv` on PATH (used to run the launcher inside the sidecar's own
 * venv) — the same tool the sidecar's own test suite and build depend on.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AskEnvelope } from "../shared/events.js";
import { TurnId } from "./turn.js";
import {
  CANCEL_RETRY_DELAY_MS,
  authToken,
  buildRunRequestBody,
  deliverCancel,
  streamRun,
  type RunViaSidecarRequest,
} from "./sidecar.js";

// src/main/ -> the desktop workspace; the sidecar is the repository service.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = path.resolve(HERE, "../../../../services/agent-sidecar");
const LAUNCHER_RELATIVE = "tests/tools/run_wire_compat_server.py";
const PORT_HANDSHAKE_PREFIX = "WIRE_COMPAT_PORT=";
const STARTUP_TIMEOUT_MS = 60_000;

/** The scenario models the launcher's `chat_factory` dispatches on. Keep in
 * step with `SCENARIOS` in `run_wire_compat_server.py`. */
const ANSWER = "wire-answer";
const ERROR = "wire-error";
const SLOW = "wire-slow";

interface WireServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

function readPortLine(
  stdout: NodeJS.ReadableStream,
  stderrChunks: Buffer[],
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const rl = createInterface({ input: stdout });
    const fail = (why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      reject(new Error(`${why}; stderr so far:\n${Buffer.concat(stderrChunks).toString("utf8")}`));
    };
    const timer = setTimeout(() => fail(`wire-compat launcher never announced a port within ${timeoutMs}ms`), timeoutMs);
    rl.on("line", (line: string) => {
      if (settled || !line.startsWith(PORT_HANDSHAKE_PREFIX)) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(Number(line.slice(PORT_HANDSHAKE_PREFIX.length)));
    });
    rl.on("close", () => fail("wire-compat launcher's stdout ended before announcing a port"));
  });
}

/** Spawn the real Python sidecar app (via `uv run`, inside the sidecar's own
 * venv) and resolve once it has announced a live port. `extraEnv` lets the
 * auth suite set `ARCELLE_SIDECAR_TOKEN`; every other test runs with it
 * deliberately UNSET (an empty token leaves the port open, per
 * `TokenAuthMiddleware`'s own documented dev/test behaviour). */
async function startWireCompatServer(extraEnv: Record<string, string> = {}): Promise<WireServer> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ARCELLE_SIDECAR_TOKEN;
  Object.assign(env, extraEnv);

  // A clean checkout does not yet have pytest in the sidecar environment.
  // The launcher imports the shared pytest-backed test doubles, so explicitly
  // request the optional dev dependencies instead of relying on a warm venv.
  const proc: ChildProcess = spawn("uv", ["run", "--extra", "dev", "python", LAUNCHER_RELATIVE], {
    cwd: SIDECAR_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrChunks: Buffer[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  let port: number;
  try {
    if (!proc.stdout) throw new Error("wire-compat launcher's stdout could not be captured");
    port = await readPortLine(proc.stdout, stderrChunks, STARTUP_TIMEOUT_MS);
  } catch (err) {
    proc.kill("SIGKILL");
    throw err;
  }

  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5_000);
      proc.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  };

  return { baseUrl: `http://127.0.0.1:${port}`, stop };
}

// ------------------------------------------------------------- the relay

type BodyPolicy =
  /** Forward upstream's bytes unchanged (re-framed, see below). */
  | { mode: "passthrough" }
  /** Cut the socket right after the first `delta` line: no terminating
   * chunk, no `final`, no `error`. The reader REJECTS. */
  | { mode: "severAfterFirstDelta" }
  /** END the response body CLEANLY right after the first `delta` — a proper
   * `0\r\n\r\n` chunked terminator and a FIN, with no `final` and no `error`.
   * A truncating proxy, and a DIFFERENT client-side path from a sever: the
   * reader reports a normal end of stream, so this is the only condition that
   * reaches `finalOutcome`'s `finalSeen === false` arm. */
  | { mode: "truncateCleanlyAfterFirstDelta" }
  /** Inject one extra NDJSON line as its own well-formed chunk, before
   * anything upstream has said. */
  | { mode: "injectLine"; line: string }
  /** Inject one extra NDJSON line as TWO chunks, split at byte `cutAt` with a
   * real pause between the writes so they cannot coalesce into one TCP
   * segment — the client must rejoin them. */
  | { mode: "injectLineSplitAt"; line: string; cutAt: number };

interface RelayPolicy {
  body?: BodyPolicy;
  /** Rewrite every `POST /cancel` body to name THIS run id instead. The reply
   * is still the REAL server's — which, for an id it never registered,
   * is a real `known:false`. */
  cancelRunIdOverride?: string;
  /** Every request line that crosses the relay, upward. */
  onRequest?: (method: string, path: string) => void;
}

/**
 * A TCP relay in front of the REAL server, for the transport conditions the
 * server cannot produce from the inside.
 *
 * It is CHUNK-AWARE rather than byte-transparent: it parses upstream's
 * HTTP/1.1 chunked response (uvicorn writes exactly one chunk per NDJSON
 * line — verified against the live server) and RE-FRAMES each payload into a
 * chunk of its own. That is what makes the two hard conditions below
 * expressible at all. A byte-transparent relay cannot terminate a body
 * cleanly (it has no idea where a chunk ends, so `0\r\n\r\n` would land
 * mid-frame), and cannot split one line across two segments without risking
 * the same corruption it is supposed to be testing for.
 *
 * Writes are SERIALIZED through `emit`: while a deliberately split injection
 * is mid-flight, upstream's own chunks are queued rather than written between
 * the two halves. Interleaving there would corrupt the split line and the
 * test would be measuring the relay's bug, not the client's behaviour.
 */
async function startRelay(policy: RelayPolicy, upstream: string): Promise<{ url: string; close: () => void }> {
  const upstreamPort = Number(new URL(upstream).port);
  const body: BodyPolicy = policy.body ?? { mode: "passthrough" };

  const server = net.createServer((client) => {
    const up = net.connect(upstreamPort, "127.0.0.1");

    // ---- client -> upstream: parse each request head, so /cancel can be
    // counted and (optionally) re-pointed at a run id the server never had.
    let reqBuf = Buffer.alloc(0);
    let forwardBytes = 0;
    let dropBytes = 0;
    // ONLY the `/run` response is re-framed. `/cancel` answers a plain
    // content-length JSON body, and running that through the chunked decoder
    // below corrupts it into an unreadable frame — which the client then reads
    // as "a 2xx whose body I could not parse", i.e. an ACCEPTED Stop, silently
    // suppressing the retry this suite exists to observe.
    let reframe = false;
    client.on("data", (chunk: Buffer) => {
      reqBuf = Buffer.concat([reqBuf, chunk]);
      for (;;) {
        if (dropBytes > 0) {
          const take = Math.min(dropBytes, reqBuf.length);
          if (take === 0) return;
          reqBuf = reqBuf.subarray(take);
          dropBytes -= take;
          continue;
        }
        if (forwardBytes > 0) {
          const take = Math.min(forwardBytes, reqBuf.length);
          if (take === 0) return;
          up.write(reqBuf.subarray(0, take));
          reqBuf = reqBuf.subarray(take);
          forwardBytes -= take;
          continue;
        }
        const end = reqBuf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const headLines = reqBuf.subarray(0, end).toString("latin1").split("\r\n");
        reqBuf = reqBuf.subarray(end + 4);
        const [method = "", path = ""] = (headLines[0] ?? "").split(" ");
        const lengthHeader = headLines.find((h) => /^content-length:/i.test(h));
        const declared = lengthHeader ? Number(lengthHeader.split(":")[1]?.trim() ?? 0) : 0;
        reframe = path === "/run";
        policy.onRequest?.(method, path);

        if (path === "/cancel" && policy.cancelRunIdOverride !== undefined) {
          const rewritten = Buffer.from(JSON.stringify({ run_id: policy.cancelRunIdOverride }), "utf8");
          up.write(
            `${headLines
              .filter((h) => !/^content-length:/i.test(h))
              .concat(`content-length: ${rewritten.length}`)
              .join("\r\n")}\r\n\r\n`
          );
          up.write(rewritten);
          dropBytes = declared; // the client's own body is discarded
          continue;
        }
        up.write(`${headLines.join("\r\n")}\r\n\r\n`);
        forwardBytes = declared;
      }
    });

    // ---- upstream -> client: re-frame the chunked response.
    let respBuf = Buffer.alloc(0);
    let headersSent = false;
    let chunkSize: number | null = null;
    let finished = false;
    let sawDelta = false;
    let injected = false;
    let held: Buffer[] | null = null;
    let endHeld = false;

    const writeChunk = (payload: Buffer): void => {
      client.write(`${payload.length.toString(16)}\r\n`);
      client.write(payload);
      client.write("\r\n");
    };
    const emit = (payload: Buffer): void => {
      if (held !== null) {
        held.push(payload);
        return;
      }
      writeChunk(payload);
    };
    const terminate = (): void => {
      client.write("0\r\n\r\n");
      client.end();
      up.destroy();
    };
    const endCleanly = (): void => {
      finished = true;
      // A split injection still owes the client its second half and whatever
      // queued behind it. Terminating the body now would truncate the very
      // line this relay was asked to split, and the test would be measuring
      // the relay rather than the client.
      if (held !== null) {
        endHeld = true;
        return;
      }
      terminate();
    };
    const flushHeld = (): void => {
      const queued = held ?? [];
      held = null;
      for (const q of queued) writeChunk(q);
      if (endHeld) {
        endHeld = false;
        terminate();
      }
    };

    up.on("data", (data: Buffer) => {
      if (!reframe) {
        client.write(data);
        return;
      }
      if (finished) return;
      respBuf = Buffer.concat([respBuf, data]);
      for (;;) {
        if (!headersSent) {
          const end = respBuf.indexOf("\r\n\r\n");
          if (end === -1) return;
          client.write(respBuf.subarray(0, end + 4));
          respBuf = respBuf.subarray(end + 4);
          headersSent = true;
          if (!injected && body.mode === "injectLine") {
            injected = true;
            emit(Buffer.from(`${body.line}\n`, "utf8"));
          }
          if (!injected && body.mode === "injectLineSplitAt") {
            injected = true;
            const payload = Buffer.from(`${body.line}\n`, "utf8");
            held = []; // hold upstream's own chunks until the split completes
            writeChunk(payload.subarray(0, body.cutAt));
            setTimeout(() => {
              writeChunk(payload.subarray(body.cutAt));
              flushHeld();
            }, 60);
          }
          continue;
        }
        if (chunkSize === null) {
          const nl = respBuf.indexOf("\r\n");
          if (nl === -1) return;
          const sizeToken = respBuf.subarray(0, nl).toString("latin1").split(";")[0]?.trim() ?? "";
          chunkSize = Number.parseInt(sizeToken, 16);
          respBuf = respBuf.subarray(nl + 2);
          continue;
        }
        if (chunkSize === 0) {
          endCleanly();
          return;
        }
        if (respBuf.length < chunkSize + 2) return;
        const payload = respBuf.subarray(0, chunkSize);
        respBuf = respBuf.subarray(chunkSize + 2);
        chunkSize = null;
        emit(payload);

        if (!sawDelta && payload.includes('"t":"delta"')) {
          sawDelta = true;
          if (body.mode === "severAfterFirstDelta") {
            finished = true;
            // A beat, so the delta is genuinely delivered before the cut.
            setTimeout(() => {
              client.destroy();
              up.destroy();
            }, 10);
            return;
          }
          if (body.mode === "truncateCleanlyAfterFirstDelta") {
            finished = true;
            setTimeout(endCleanly, 10);
            return;
          }
        }
      }
    });

    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    up.on("close", () => client.end());
    client.on("close", () => up.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () => server.close(),
  };
}

/** Wraps `globalThis.fetch` to COUNT `/cancel` calls while still hitting the
 * REAL server underneath — a spy, never a fake response. Proves the real
 * `/cancel` endpoint was reached, not merely that the call site returned. */
function spyOnCancelCalls(): { calls: string[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    if (url.includes("/cancel")) calls.push(url);
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = realFetch) };
}

function req(model: string, runId: string, question = "edit the lease and fix the rent"): RunViaSidecarRequest {
  return {
    model,
    question,
    runId,
    webEnabled: true,
    messages: [
      { role: "system", content: "You are the room assistant." },
      { role: "user", content: question },
    ],
    mcp: { url: "http://127.0.0.1:1/mcp", token: "unused-by-the-fake-mcp-factory" },
  };
}

// ----------------------------------------------------------------- suites

let server: WireServer;

beforeAll(async () => {
  server = await startWireCompatServer();
}, STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
});

describe("wire-compat: a normal multi-round answer", () => {
  it("streams the exact event order test_server.py's own test_run_streams_ndjson_in_order pins, and produces the right Done outcome", async () => {
    const seen: Array<{ event: string; payload: AskEnvelope<unknown> }> = [];

    const outcome = await streamRun(server.baseUrl, req(ANSWER, "run-1"), {
      turn: new TurnId("run-1", "chat-1"),
      onEvent: (event, payload) => seen.push({ event, payload: payload as AskEnvelope<unknown> }),
    });

    expect(outcome).toEqual({
      kind: "done",
      text: "The rent is 1200.",
      usage: expect.objectContaining({ total_tokens: expect.any(Number) }),
      plan: expect.any(Array),
    });

    expect(seen.map((s) => s.event)).toEqual([
      "ask-plan",
      "ask-agent",
      "ask-round",
      "ask-token-usage",
      // The roster is emitted at DISPATCH -- the whole batch of children is
      // launched as a unit, before any step chip.
      "ask-plan",
      "ask-agent",
      "ask-step",
      "ask-lane",
      "ask-round",
      "ask-delta",
      "ask-token-usage",
      "ask-step",
      "ask-step-status",
      "ask-round",
      "ask-delta",
      "ask-token-usage",
      // The child's report, kept so the diagram can still show it once the
      // next round has wiped the live text.
      "ask-report",
      // A child FINISHED: its roster slot flips to done as its sub-loop ends.
      "ask-plan",
      "ask-agent",
      "ask-step-status",
      // The Main agent is marked active once the whole batch is collected.
      "ask-plan",
      "ask-agent",
      "ask-round",
      "ask-delta",
      "ask-token-usage",
      // note: the terminal `final` line produces NO event of its own -- the
      // delta stream already painted the text as it arrived.
    ]);

    const steps = seen.filter((s) => s.event === "ask-step").map((s) => (s.payload.v as { label: string }).label);
    expect(steps).toEqual(["Asked the File agent", "Searched the room"]);
    expect(seen.find((s) => s.event === "ask-lane")?.payload.v).toBe("Working on your files");

    // Owner replacement #4: every event names the run and the chat it belongs
    // to -- and the run stamp never leaked INTO a payload.
    for (const { event, payload } of seen) {
      expect(payload.runId).toBe("run-1");
      expect(payload.chatId).toBe("chat-1");
      if (event === "ask-token-usage") {
        expect(payload.v).not.toHaveProperty("run_id");
        expect(payload.v).not.toHaveProperty("t");
      }
    }
  }, STARTUP_TIMEOUT_MS);

  it("omitting `routing` entirely still produces a working run against the real server", async () => {
    // RunViaSidecarRequest has no routing field at all, so
    // buildRunRequestBody never sends the key and Python's own
    // RunRequest.resolved_routing() fallback (routing.py's keyword
    // heuristics) is what actually ran above. Said explicitly here rather
    // than left as an unstated side effect of the event-order test.
    expect(Object.prototype.hasOwnProperty.call(buildRunRequestBody(req(ANSWER, "run-1b")), "routing")).toBe(false);
    const outcome = await streamRun(server.baseUrl, req(ANSWER, "run-1b"), { turn: null, onEvent: () => undefined });
    expect(outcome.kind).toBe("done");
  }, STARTUP_TIMEOUT_MS);

  it("a null turn emits NOTHING at all, but still returns the real outcome (Rust's headless shape)", async () => {
    const seen: string[] = [];
    const outcome = await streamRun(server.baseUrl, req(ANSWER, "run-1c"), {
      turn: null,
      onEvent: (event) => seen.push(event),
    });
    expect(seen).toEqual([]);
    expect(outcome.kind).toBe("done");
  }, STARTUP_TIMEOUT_MS);
});

describe("wire-compat: a stream that ends in an error line", () => {
  it("becomes a Failed outcome carrying the partial the user watched arrive", async () => {
    const outcome = await streamRun(server.baseUrl, req(ERROR, "run-2", "write me a long report"), {
      turn: null,
      onEvent: () => undefined,
    });
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.text).toBe("half an answer");
    expect(outcome.error).toContain("torn down");
    expect(outcome.toolRan).toBe(false);
  }, STARTUP_TIMEOUT_MS);
});

describe("wire-compat: a stream that NEVER sends final", () => {
  it("is read as LOST — never as an empty success — and keeps the partial", async () => {
    // The relay severs the connection right after the first delta: no
    // `final`, no `error`, no terminating chunk. Node's reader REJECTS, which
    // is the single most important thing this client must not propagate:
    // throwing here would lose the partial AND hand the caller an exception
    // where every other exit hands it an outcome.
    const relay = await startRelay({ body: { mode: "severAfterFirstDelta" } }, server.baseUrl);
    try {
      const outcome = await streamRun(relay.url, req(SLOW, "run-3", "keep going"), {
        turn: null,
        onEvent: () => undefined,
      });
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error("expected failed");
      // The load-bearing pair: NOT done, and the partial survived.
      expect(outcome.text).toBe("thinking it through slowly");
      expect(outcome.error.length).toBeGreaterThan(0);
    } finally {
      relay.close();
    }
  }, STARTUP_TIMEOUT_MS);
});

describe("wire-compat: a real mid-stream cancellation", () => {
  it("POSTs the real /cancel exactly once, returns the partial as Done, and actually stops the run", async () => {
    const controller = new AbortController();
    const spy = spyOnCancelCalls();
    try {
      const outcome = await streamRun(server.baseUrl, req(SLOW, "run-4", "keep going"), {
        turn: new TurnId("run-4", "chat-4"),
        signal: controller.signal,
        onEvent: (event, payload) => {
          // The fake model streams one delta then pauses, cooperatively
          // polling the real CancelToken -- press Stop the moment the client
          // has actually seen it, so the abort always lands mid-round rather
          // than racing a fixed timer.
          if (event === "ask-delta" && (payload as AskEnvelope<unknown>).v === "thinking it through slowly") {
            controller.abort();
          }
        },
      });
      expect(outcome.kind).toBe("done");
      expect(outcome.text).toBe("thinking it through slowly");
      // The real /cancel POST is load-bearing, not a courtesy: dropping the
      // connection alone does not stop the Python run. This run was live and
      // registered, so `known:true` first time and no retry was needed.
      expect(spy.calls.length).toBe(1);
    } finally {
      spy.restore();
    }

    // OUT-OF-BAND confirmation that /cancel reached the actual CancelToken
    // the fake model was polling -- not just that our own call returned. The
    // model re-checks the token every 50ms, so poll rather than assert on the
    // first read.
    const deadline = Date.now() + 3_000;
    let state = { cancel_seen: false };
    while (Date.now() < deadline) {
      state = (await (await fetch(`${server.baseUrl}/__test_state`)).json()) as { cancel_seen: boolean };
      if (state.cancel_seen) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(state).toEqual({ cancel_seen: true });
  }, STARTUP_TIMEOUT_MS);

  it("retry-once-on-known:false runs against the REAL /cancel endpoint, and posts exactly twice", async () => {
    // No run was ever started under this id, so the real endpoint
    // deterministically answers `known:false` both times -- which is what
    // lets the retry be exercised without racing a live run's registration.
    const spy = spyOnCancelCalls();
    const started = Date.now();
    try {
      const result = await deliverCancel(server.baseUrl, "a-run-that-was-never-started");
      expect(result).toEqual({ ok: false, error: "the AI service did not recognise the run" });
      expect(spy.calls.length).toBe(2); // exactly one retry, never more
      expect(Date.now() - started).toBeGreaterThanOrEqual(CANCEL_RETRY_DELAY_MS);
    } finally {
      spy.restore();
    }
  }, STARTUP_TIMEOUT_MS);

  it("a run this same server has already FINISHED also answers known:false", async () => {
    // Only checkable because every scenario shares one long-lived process:
    // `/run`'s generator releases the id from the RunRegistry in its finally,
    // so a Stop arriving after the answer landed reports honestly rather than
    // claiming to have stopped something.
    const outcome = await streamRun(server.baseUrl, req(ANSWER, "run-5"), { turn: null, onEvent: () => undefined });
    expect(outcome.kind).toBe("done");
    const resp = await fetch(`${server.baseUrl}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "run-5" }),
    });
    expect(await resp.json()).toEqual({ ok: true, known: false, stopped: [] });
  }, STARTUP_TIMEOUT_MS);
});

describe("wire-compat: a badly-behaved proxy interleaving another run's lines", () => {
  it("DROPS a line stamped for a different run, rather than painting it into this chat", async () => {
    const foreign = JSON.stringify({ t: "delta", v: "SOMEONE ELSE'S ANSWER", run_id: "a-totally-different-run" });
    const relay = await startRelay({ body: { mode: "injectLine", line: foreign } }, server.baseUrl);
    try {
      const deltas: string[] = [];
      const outcome = await streamRun(relay.url, req(ANSWER, "run-6"), {
        turn: new TurnId("run-6", "chat-6"),
        onEvent: (event, payload) => {
          if (event === "ask-delta") deltas.push((payload as AskEnvelope<string>).v);
        },
      });
      expect(deltas.join("")).not.toContain("SOMEONE ELSE");
      // ...and it never reached the answer text either.
      expect(outcome).toEqual({
        kind: "done",
        text: "The rent is 1200.",
        usage: expect.anything(),
        plan: expect.anything(),
      });
    } finally {
      relay.close();
    }
  }, STARTUP_TIMEOUT_MS);

  it("MUTATION CHECK: the same injected line, stamped with OUR run id, IS painted", async () => {
    // Without this the test above proves nothing: a relay that silently
    // failed to inject anything would produce exactly the same "no foreign
    // text" result. This is what makes the drop a real observation.
    const mine = JSON.stringify({ t: "delta", v: "INJECTED-BUT-MINE", run_id: "run-7" });
    const relay = await startRelay({ body: { mode: "injectLine", line: mine } }, server.baseUrl);
    try {
      const deltas: string[] = [];
      await streamRun(relay.url, req(ANSWER, "run-7"), {
        turn: new TurnId("run-7", "chat-7"),
        onEvent: (event, payload) => {
          if (event === "ask-delta") deltas.push((payload as AskEnvelope<string>).v);
        },
      });
      expect(deltas).toContain("INJECTED-BUT-MINE");
    } finally {
      relay.close();
    }
  }, STARTUP_TIMEOUT_MS);

  it("a JSON line split across two TCP segments is reassembled, not dropped", async () => {
    // The relay writes the injected line's chunk header and body in separate
    // socket writes already; this drives the same property explicitly by
    // splitting one line's bytes across two chunks the client must rejoin.
    const line = JSON.stringify({ t: "delta", v: "בעברית, מפוצל", run_id: "run-8" });
    const relay = await startRelay({ body: { mode: "injectLine", line } }, server.baseUrl);
    try {
      const deltas: string[] = [];
      await streamRun(relay.url, req(ANSWER, "run-8"), {
        turn: new TurnId("run-8", "chat-8"),
        onEvent: (event, payload) => {
          if (event === "ask-delta") deltas.push((payload as AskEnvelope<string>).v);
        },
      });
      // Multi-byte UTF-8 survived the byte-level buffering intact.
      expect(deltas).toContain("בעברית, מפוצל");
    } finally {
      relay.close();
    }
  }, STARTUP_TIMEOUT_MS);
});

// ============================================================================
// ADVERSARIAL WIRE PASS (2026-08-22)
// ============================================================================
//
// Conditions the original batch reasoned about but never drove end to end
// against the real server. Each needed the chunk-aware relay above to be
// expressible at all.

describe("wire-compat: a proxy that TRUNCATES the answer cleanly", () => {
  it("a body that ENDS NORMALLY without a final is LOST, not an empty success", async () => {
    // The distinct sibling of the severed-connection test further up, and the
    // one the whole `finalOutcome` section exists for. A sever makes the
    // reader REJECT, which lands in `transportFailure`; this is a proper
    // `0\r\n\r\n` terminator and a FIN, so the reader reports a NORMAL end of
    // stream and control reaches `finalOutcome` with `finalSeen === false` —
    // the arm that used to be spelled `Done("")` and made a torn-down run
    // byte-identical to a finished one (live QA 2026-07-30, the Yahoo/ETF
    // task: an empty assistant row, no `stopped` marker, no error).
    //
    // Until now nothing drove that arm over a real socket at all: the unit
    // suite reached it only through a hand-built ReadableStream.
    const relay = await startRelay(
      { body: { mode: "truncateCleanlyAfterFirstDelta" } },
      server.baseUrl
    );
    try {
      const outcome = await streamRun(relay.url, req(SLOW, "run-12", "keep going"), {
        turn: null,
        onEvent: () => undefined,
      });

      if (outcome.kind !== "failed") {
        throw new Error(`expected failed, got ${outcome.kind}`);
      }
      // The exact end-of-stream verdict, not a transport message: this proves
      // the CLEAN-end path ran rather than the rejected-read one.
      expect(outcome.error).toBe("the agent sidecar ended the run without an answer");
      // ...and the partial the user watched arrive is still the answer.
      expect(outcome.text).toBe("thinking it through slowly");
      expect(outcome.toolRan).toBe(false);
    } finally {
      relay.close();
    }
  }, STARTUP_TIMEOUT_MS);
});

describe("wire-compat: a foreign run's TERMINAL lines interleaved into ours", () => {
  it("a foreign `error` and a foreign `final` neither end our run nor become our answer", async () => {
    // The existing interleaving test only proves the guard on a `delta`.
    // These two are the kinds whose misattribution is unrecoverable: `error`
    // is TERMINAL (another chat's failure would end ours mid-answer), and
    // `final` would set `finalSeen` and hand back someone else's text as a
    // confident `done`. Both are injected BEFORE upstream says anything, so
    // an unguarded client decides the whole run on them.
    const foreign =
      `${JSON.stringify({ t: "error", v: "SOMEONE ELSE'S RUN DIED", run_id: "a-totally-different-run" })}\n` +
      `${JSON.stringify({ t: "final", v: "SOMEONE ELSE'S ANSWER", run_id: "a-totally-different-run" })}`;
    const relay = await startRelay({ body: { mode: "injectLine", line: foreign } }, server.baseUrl);
    try {
      const outcome = await streamRun(relay.url, req(ANSWER, "run-13"), {
        turn: new TurnId("run-13", "chat-13"),
        onEvent: () => undefined,
      });
      // Ran to ITS OWN completion, on its own `final`.
      expect(outcome).toEqual({
        kind: "done",
        text: "The rent is 1200.",
        usage: expect.anything(),
        plan: expect.anything(),
      });
    } finally {
      relay.close();
    }
  }, STARTUP_TIMEOUT_MS);
});

describe("wire-compat: a chunk boundary INSIDE a multi-byte character", () => {
  it("rejoins a real Hebrew delta cut mid-character across two TCP segments", async () => {
    // The existing "split across two TCP segments" test wrote the chunk
    // header and body in back-to-back `write()` calls, which the kernel is
    // free to coalesce into ONE segment — so it could pass without any split
    // ever happening, and the cut was never aimed inside a character.
    //
    // Here the line is split at a byte offset ASSERTED to be mid-sequence,
    // into two separate HTTP chunks 60ms apart, so the client genuinely has
    // to buffer raw bytes across two reads. Decoding per chunk would yield a
    // U+FFFD and a JSON line that no longer parses.
    const text = "בעברית, מפוצל באמצע תו";
    const line = JSON.stringify({ t: "delta", v: text, run_id: "run-14" });
    const bytes = Buffer.from(`${line}\n`, "utf8");

    const firstMultiByte = bytes.findIndex((b) => b >= 0x80);
    expect(firstMultiByte).toBeGreaterThan(0);
    const cutAt = firstMultiByte + 1;
    // The load-bearing precondition, asserted rather than assumed: neither
    // half is valid UTF-8 on its own.
    expect(bytes.subarray(0, cutAt).toString("utf8")).toContain("�");
    expect(bytes.subarray(cutAt).toString("utf8")).toContain("�");

    const relay = await startRelay({ body: { mode: "injectLineSplitAt", line, cutAt } }, server.baseUrl);
    try {
      const deltas: string[] = [];
      const outcome = await streamRun(relay.url, req(ANSWER, "run-14"), {
        turn: new TurnId("run-14", "chat-14"),
        onEvent: (event, payload) => {
          if (event === "ask-delta") deltas.push((payload as AskEnvelope<string>).v);
        },
      });

      // Byte-exact, and delivered ONCE -- not two halves, not a dropped line.
      expect(deltas).toContain(text);
      expect(deltas.filter((d) => d === text)).toHaveLength(1);
      expect(deltas.join("")).not.toContain("�");
      // ...and the rest of the real run was unaffected by the re-framing.
      expect(outcome.kind).toBe("done");
      expect(outcome.text).toBe("The rent is 1200.");
    } finally {
      relay.close();
    }
  }, STARTUP_TIMEOUT_MS);
});

describe("wire-compat: streamRun's OWN Stop, retried against the real /cancel", () => {
  it("posts /cancel exactly TWICE when the real endpoint answers known:false", async () => {
    // The existing retry test calls `deliverCancel` directly. This drives the
    // whole path the user's Stop actually takes -- streamRun observes the
    // abort, and what IT does must be the retrying delivery, not a single
    // fire-and-forget POST.
    //
    // A real `known:false` is forced without faking the reply: the relay
    // re-points every /cancel body at an id this server never registered, so
    // the answer is the REAL endpoint's real verdict on a genuinely unknown
    // run -- the same shape as a Stop that raced its run's registration.
    const crossings: string[] = [];
    const relay = await startRelay(
      {
        cancelRunIdOverride: "a-run-id-this-server-never-registered",
        onRequest: (method, path) => crossings.push(`${method} ${path}`),
      },
      server.baseUrl
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = new AbortController();
    try {
      const outcome = await streamRun(relay.url, req(SLOW, "run-15", "keep going"), {
        turn: new TurnId("run-15", "chat-15"),
        signal: controller.signal,
        onEvent: (event) => {
          if (event === "ask-delta") controller.abort();
        },
      });

      expect(crossings.filter((c) => c === "POST /cancel")).toHaveLength(2);
      // A clean Stop is still a successful partial answer, even when the
      // sidecar could not confirm it.
      expect(outcome.kind).toBe("done");
      expect(outcome.text).toBe("thinking it through slowly");
      // ...and the unconfirmed delivery was SAID, not swallowed.
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      relay.close();
    }
  }, STARTUP_TIMEOUT_MS);
});

describe("wire-compat: auth", () => {
  it("a real ARCELLE_SIDECAR_TOKEN is authenticated by the client's own authedHeaders() usage", async () => {
    // Its own server: the token is read from the process ENVIRONMENT
    // (`server.TOKEN_ENV`), so it cannot be varied on the shared instance.
    // The SAME token this process's authedHeaders() sends, minted once per
    // process and handed to the child's env, exactly as the real spawn path
    // in `sidecar.ts` does it.
    const tokened = await startWireCompatServer({ ARCELLE_SIDECAR_TOKEN: authToken() });
    try {
      const outcome = await streamRun(tokened.baseUrl, req(ANSWER, "run-9"), { turn: null, onEvent: () => undefined });
      expect(outcome.kind).toBe("done");

      // And a wrong token is refused -- proving the server really is checking
      // it, rather than accepting everything regardless of our headers.
      const rejected = await fetch(`${tokened.baseUrl}/run`, {
        method: "POST",
        headers: { authorization: "Bearer the-wrong-token", "content-type": "application/json" },
        body: JSON.stringify(buildRunRequestBody(req(ANSWER, "run-10"))),
      });
      expect(rejected.status).toBe(401);
    } finally {
      await tokened.stop();
    }
  }, STARTUP_TIMEOUT_MS);

  it("an empty token env leaves the port open even to a garbage Authorization header (the dev/test default)", async () => {
    const resp = await fetch(`${server.baseUrl}/run`, {
      method: "POST",
      headers: { authorization: "Bearer definitely-not-a-real-token", "content-type": "application/json" },
      body: JSON.stringify(buildRunRequestBody(req(ANSWER, "run-11"))),
    });
    expect(resp.status).toBe(200);
    await resp.body?.cancel();
  }, STARTUP_TIMEOUT_MS);
});
