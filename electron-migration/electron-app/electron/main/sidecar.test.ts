import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

// Mocked so the single-flight test below can prove "exactly one spawn" for
// two concurrent ensureUp() calls without needing a real Python interpreter
// on the machine running the suite. Every OTHER test in this file reaches
// spawnAndWait() only through the "nothing configured -> launchCommand()
// returns null" failure path, which returns before ever calling spawn(), so
// this mock is inert for them.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import {
  STDERR_LOG_BUDGET,
  TOKEN_ENV,
  authToken,
  authedHeaders,
  baseUrlIfRunning,
  busy,
  ensureUp,
  inflightCount,
  parsePortLine,
  previousStderrLogPath,
  probeOnce,
  shouldReplace,
  runViaSidecar,
  spawnAndWait,
  stderrLogPath,
  stopIfOurs,
  type Probe,
} from "./sidecar.js";
import { TurnId } from "./turn.js";

// Port of src-tauri/src/sidecar_lifecycle.rs's #[cfg(test)] module.
//
// This file covers ONLY the process-lifecycle half of `sidecar.ts`. Its
// `/run` NDJSON streaming client (ported from `src-tauri/src/sidecar.rs`)
// is covered by `sidecarRun.test.ts` + `sidecarRun.wire.test.ts` — see the
// first of those for why they are separate files and not more `describe`
// blocks here (short version: the `vi.mock("node:child_process")` above is
// file-wide, and the wire test has to really spawn a Python sidecar).
//
// Skipped verbatim (per the porting brief, both grep Rust source files or
// assume a Cargo-relative path that do not apply to this workspace):
//   - no_sidecar_request_is_sent_without_the_token
//   - dev_sidecar_dir_points_at_the_package

describe("parsePortLine", () => {
  it("parses the port handshake line", () => {
    expect(parsePortLine("SIDECAR_PORT=53421")).toBe(53421);
    expect(parsePortLine("  SIDECAR_PORT=8000  ")).toBe(8000);
    expect(parsePortLine("SIDECAR_PORT=notaport")).toBeNull();
    expect(parsePortLine("uvicorn running on ...")).toBeNull();
    expect(parsePortLine("PORT=1234")).toBeNull();
  });
});

describe("authToken / authedHeaders", () => {
  it("the sidecar token is a usable secret and rides on every request", () => {
    const tok = authToken();
    // Stable for the process -- a fresh one per call would 401 against the
    // sidecar we already spawned with the first.
    expect(authToken()).toBe(tok);
    expect(tok.length).toBeGreaterThanOrEqual(32);
    // A header value: no whitespace, no newline, nothing to smuggle with.
    expect(/^[a-zA-Z0-9]+$/.test(tok)).toBe(true);

    const headers = authedHeaders();
    // `Record<string, string>`'s index signature makes this `string | undefined`
    // under noUncheckedIndexedAccess even via dot access; the `!` below is
    // what this exact assertion is proving is safe.
    expect(headers.authorization!).toBe(`Bearer ${tok}`);
  });

  it("TOKEN_ENV is the exact name the sidecar reads it back from", () => {
    expect(TOKEN_ENV).toBe("ARCELLE_SIDECAR_TOKEN");
  });

  // TS-appropriate equivalent of the skipped no_sidecar_request_is_sent_
  // without_the_token test (that one greps Rust call sites, which has no
  // analogue here): assert the cheap property directly -- every call to
  // authedHeaders() carries a usable bearer header, so a call site that
  // uses this helper can never accidentally send an unauthenticated request.
  it("authedHeaders always includes a usable authorization header", () => {
    for (let i = 0; i < 5; i++) {
      const headers = authedHeaders();
      expect(Object.keys(headers)).toContain("authorization");
      expect(headers.authorization!.startsWith("Bearer ")).toBe(true);
      expect(headers.authorization!).toBe(`Bearer ${authToken()}`);
    }
  });
});

describe("shouldReplace", () => {
  it("a busy sidecar is never killed out from under a request", () => {
    // Regression: one missed 1.5s /health probe used to SIGTERM the
    // sidecar, and ensureUp runs before EVERY sidecar request -- including
    // the ones a tool call makes while an answer is streaming. A moment of
    // event-loop starvation therefore killed the user's in-flight answer
    // and any background job (a file pass has a ten-hour budget) sharing
    // the process.
    expect(shouldReplace("healthy", 0)).toBe(false);
    expect(shouldReplace("healthy", 3)).toBe(false);
    // Alive (the connection was accepted) with work of ours riding on it.
    expect(shouldReplace("busy", 1)).toBe(false);
    expect(shouldReplace("busy", 9)).toBe(false);
    // Alive but idle -> replacing it costs nothing, and this is how a
    // genuinely wedged sidecar still gets recovered rather than leaked.
    expect(shouldReplace("busy", 0)).toBe(true);
    // Nothing is listening any more: there is nothing left to protect.
    expect(shouldReplace("gone", 0)).toBe(true);
    expect(shouldReplace("gone", 4)).toBe(true);
  });
});

describe("busy guard", () => {
  it("counts requests in flight", () => {
    const before = inflightCount();
    const a = busy();
    expect(inflightCount()).toBe(before + 1);
    const b = busy();
    expect(inflightCount()).toBe(before + 2);
    b.release();
    a.release();
    expect(inflightCount()).toBe(before);
  });
});

describe("probeOnce against a real TCP listener", () => {
  it("a silent port reads as busy and a closed one as gone", async () => {
    // The whole distinction rests on this: a wedged Python process still
    // has its socket bound, so the kernel completes the handshake and the
    // probe TIMES OUT, while a process that is really gone refuses
    // instantly. A real bound listener (not a mock) is the only way to
    // prove that distinction actually works.
    const server = net.createServer();
    // Global fetch (undici) keeps accepted sockets open for keep-alive reuse
    // even after the client-side request is aborted, so a plain
    // `server.close(cb)` would hang forever waiting for a connection that
    // neither side ever ends. Track and force-destroy accepted sockets so
    // the close actually completes once we're done with the "busy" half of
    // this test.
    const sockets = new Set<net.Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a TCP listener");
    }
    const url = `http://127.0.0.1:${address.port}`;

    // Bound, never answers -- alive (busy). Use a short timeout so the
    // test doesn't have to pay the real 1500ms production HEALTH_TIMEOUT.
    const verdict1: Probe = await probeOnce(url, 300);
    expect(verdict1).toBe("busy");

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) {
        socket.destroy();
      }
    });

    // Same port, nothing behind it -- gone.
    const verdict2: Probe = await probeOnce(url, 300);
    expect(verdict2).toBe("gone");
  }, 10_000);
});

describe("stderr log paths", () => {
  it("the two stderr mirrors are distinct files", () => {
    // The current run's log is rotated to the `.prev` name on each spawn,
    // so the crash that triggered the automatic restart survives it.
    expect(stderrLogPath()).not.toBe(previousStderrLogPath());
    expect(stderrLogPath().endsWith("arcelle-sidecar.log")).toBe(true);
    expect(previousStderrLogPath().endsWith("arcelle-sidecar.prev.log")).toBe(true);
  });
});

describe("spawnAndWait failure shape", () => {
  const savedPython = process.env.ARCELLE_SIDECAR_PYTHON;
  const savedDir = process.env.ARCELLE_SIDECAR_DIR;

  afterEach(() => {
    if (savedPython === undefined) {
      delete process.env.ARCELLE_SIDECAR_PYTHON;
    } else {
      process.env.ARCELLE_SIDECAR_PYTHON = savedPython;
    }
    if (savedDir === undefined) {
      delete process.env.ARCELLE_SIDECAR_DIR;
    } else {
      process.env.ARCELLE_SIDECAR_DIR = savedDir;
    }
  });

  it("an unavailable error keeps the reason it used to drop", async () => {
    // Three unrelated failures (nothing to launch, spawn failed, no port
    // line) all used to surface as the bare "SIDECAR_UNAVAILABLE" sentinel
    // with no reason attached, so a broken Python install, a busy port and
    // a crash on import were indistinguishable. `formatUnavailable` (the TS
    // equivalent of Rust's private `unavailable()`) is not exported --
    // unlike the Rust test module, which shares its parent module's
    // privacy and can call it directly, a separate .test.ts file cannot
    // reach an unexported helper -- so this drives the REAL "nothing to
    // launch" failure path in spawnAndWait() instead of calling the
    // formatter in isolation. It exercises the same code and proves the
    // same property: the sentinel prefix is present AND the specific
    // reason string survives alongside it, rather than being discarded.
    delete process.env.ARCELLE_SIDECAR_PYTHON;
    delete process.env.ARCELLE_SIDECAR_DIR;

    await expect(spawnAndWait(50)).rejects.toThrow(
      /^SIDECAR_UNAVAILABLE: no sidecar to launch — no bundled binary in Resources\/ and no ARCELLE_SIDECAR_PYTHON pointing at a Python with the package$/,
    );
  });
});

describe("ensureUp single-flight spawn guard", () => {
  // This has no Rust-side test to port: the Rust module never had one
  // either (its `SPAWNING` mutex is described only in a doc comment), but
  // it is exactly the property the porting brief calls out as one of the
  // three things most worth verifying, so it gets a real one here. The
  // `spawn()` mock stands in for the child process; the /health probe it
  // must pass runs against a REAL bound HTTP server, same reasoning as the
  // TCP-listener test above -- the health poll's fetch() really has to
  // reach something real to prove the whole path, not just the mock.
  const savedPython = process.env.ARCELLE_SIDECAR_PYTHON;
  const savedDir = process.env.ARCELLE_SIDECAR_DIR;
  let server: http.Server | null = null;

  beforeEach(() => {
    // In case a previous test in this file left a recorded sidecar (it
    // shouldn't), start from the same "nothing running" state ensureUp()
    // itself assumes on a fresh app launch.
    stopIfOurs();
  });

  afterEach(async () => {
    if (savedPython === undefined) {
      delete process.env.ARCELLE_SIDECAR_PYTHON;
    } else {
      process.env.ARCELLE_SIDECAR_PYTHON = savedPython;
    }
    if (savedDir === undefined) {
      delete process.env.ARCELLE_SIDECAR_DIR;
    } else {
      process.env.ARCELLE_SIDECAR_DIR = savedDir;
    }
    vi.mocked(spawn).mockReset();
    stopIfOurs();
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("two concurrent calls share exactly one spawn, never two", async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a TCP listener");
    }
    const fakeUrl = `http://127.0.0.1:${address.port}`;

    // Point launchCommand() at the dev fallback with a real, existing file
    // as the "interpreter" -- spawn() is mocked below, so it is never
    // actually executed; only existsSync() needs it to be real.
    process.env.ARCELLE_SIDECAR_PYTHON = process.execPath;
    delete process.env.ARCELLE_SIDECAR_DIR;

    const spawnMock = vi.mocked(spawn);
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr, pid: 987_654 });
      // Announce the port asynchronously, like a real child would after it
      // finishes importing langgraph -- if ensureUp() ever launched a SECOND
      // sidecar concurrently with the first, this mock would be invoked a
      // second time and the assertion on call count below would catch it.
      queueMicrotask(() => stdout.write(`SIDECAR_PORT=${address.port}\n`));
      return child;
    });

    const [url1, url2] = await Promise.all([ensureUp(), ensureUp()]);

    expect(url1).toBe(fakeUrl);
    expect(url2).toBe(fakeUrl);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("baseUrlIfRunning", () => {
  // Port of `sidecar_lifecycle::base_url_if_running` -- the one function of
  // that Rust file this port had not yet carried over (see the doc comment
  // on the export). No Rust-side test exists for it either (it has no
  // `#[cfg(test)]` case of its own in sidecar_lifecycle.rs), so this proves
  // the property its own doc comment stakes out: read-only, no spawn.
  const savedPython = process.env.ARCELLE_SIDECAR_PYTHON;
  const savedDir = process.env.ARCELLE_SIDECAR_DIR;
  let server: http.Server | null = null;

  beforeEach(() => {
    stopIfOurs();
  });

  afterEach(async () => {
    if (savedPython === undefined) {
      delete process.env.ARCELLE_SIDECAR_PYTHON;
    } else {
      process.env.ARCELLE_SIDECAR_PYTHON = savedPython;
    }
    if (savedDir === undefined) {
      delete process.env.ARCELLE_SIDECAR_DIR;
    } else {
      process.env.ARCELLE_SIDECAR_DIR = savedDir;
    }
    vi.mocked(spawn).mockReset();
    stopIfOurs();
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("is null with nothing running, never spawns, and forgets the URL once stopIfOurs runs", async () => {
    // Nothing recorded yet -- and critically, asking must not be the thing
    // that starts a sidecar. A room lock calling this must never wake the AI
    // service just to tell it something.
    expect(baseUrlIfRunning()).toBeNull();
    expect(spawn).not.toHaveBeenCalled();

    server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a TCP listener");
    }
    const fakeUrl = `http://127.0.0.1:${address.port}`;

    process.env.ARCELLE_SIDECAR_PYTHON = process.execPath;
    delete process.env.ARCELLE_SIDECAR_DIR;
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr, pid: 555_111 });
      queueMicrotask(() => stdout.write(`SIDECAR_PORT=${address.port}\n`));
      return child;
    });

    const url = await ensureUp();
    expect(url).toBe(fakeUrl);

    // Reads back what ensureUp() just recorded, WITHOUT spawning again.
    const spawnCallsAfterEnsure = vi.mocked(spawn).mock.calls.length;
    expect(baseUrlIfRunning()).toBe(fakeUrl);
    expect(vi.mocked(spawn).mock.calls.length).toBe(spawnCallsAfterEnsure);

    stopIfOurs();
    expect(baseUrlIfRunning()).toBeNull();
  });

  it("never hands back a STALE url after ensureUp gave up on the recorded sidecar", async () => {
    // ADVERSARIAL ADDITION (verification pass). The accessor's entire reason
    // to exist is that a fire-and-forget teardown caller (Rust's
    // `sidecar::forget_room_memory`, reached while LOCKING a room) reads it
    // and posts to whatever it says WITHOUT a health check — `ensure_up` is
    // "the wrong door" precisely because it would spawn. So the one thing
    // this accessor must never do is name a port that is no longer ours:
    // loopback ports get recycled, and a room-lock message sent to whatever
    // took the port over is worse than not sending it at all.
    //
    // The invariant is carried by `stopOurs()` clearing `recordedBaseUrl`
    // BEFORE the respawn attempt, so a respawn that then fails leaves
    // nothing recorded. Nothing tested that ordering: the existing case only
    // walks the clean `stopIfOurs()` path.
    server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a TCP listener");
    }
    const deadUrl = `http://127.0.0.1:${address.port}`;

    process.env.ARCELLE_SIDECAR_PYTHON = process.execPath;
    delete process.env.ARCELLE_SIDECAR_DIR;
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr, pid: 555_222 });
      queueMicrotask(() => stdout.write(`SIDECAR_PORT=${address.port}\n`));
      return child;
    });
    expect(await ensureUp()).toBe(deadUrl);
    expect(baseUrlIfRunning()).toBe(deadUrl);

    // The sidecar dies: the port stops answering AND stops accepting, which
    // is what `probeOnce` classifies as "gone" (a dead port refuses
    // instantly, unlike a wedged one that still completes the handshake).
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    // Nothing of ours is riding on it (inflight 0), so ensureUp replaces it —
    // and with nothing left to launch, the replacement fails.
    delete process.env.ARCELLE_SIDECAR_PYTHON;
    await expect(ensureUp()).rejects.toThrow(/SIDECAR_UNAVAILABLE/);

    // THE ASSERTION: not the dead URL, not a leftover — nothing.
    expect(baseUrlIfRunning()).toBeNull();
  }, 20_000);
});

describe("stderr drain past the log budget", () => {
  // Adversarial-review addition: neither this file's own original test suite
  // nor the Rust source it was ported from (src-tauri/src/sidecar_lifecycle.rs
  // -- see `the_two_stderr_mirrors_are_distinct_files`, which checks only the
  // path names) actually drove data through the drain to prove the "keep
  // consuming, stop growing the file" contract. Stopping to consume once the
  // budget is hit is exactly the bug this exists to prevent: an unread pipe
  // fills its OS buffer and blocks the child mid-write, hanging the sidecar
  // instead of just losing the tail of an oversized log.
  const savedPython = process.env.ARCELLE_SIDECAR_PYTHON;
  const savedDir = process.env.ARCELLE_SIDECAR_DIR;
  let server: http.Server | null = null;

  beforeEach(() => {
    stopIfOurs();
  });

  afterEach(async () => {
    if (savedPython === undefined) {
      delete process.env.ARCELLE_SIDECAR_PYTHON;
    } else {
      process.env.ARCELLE_SIDECAR_PYTHON = savedPython;
    }
    if (savedDir === undefined) {
      delete process.env.ARCELLE_SIDECAR_DIR;
    } else {
      process.env.ARCELLE_SIDECAR_DIR = savedDir;
    }
    vi.mocked(spawn).mockReset();
    stopIfOurs();
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("keeps mirroring every line past STDERR_LOG_BUDGET but stops growing the file on disk", async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a TCP listener");
    }

    // Point launchCommand() at the dev fallback with a real, existing file
    // as the "interpreter" -- spawn() is mocked below, so it is never
    // actually executed; only existsSync() needs it to be real.
    process.env.ARCELLE_SIDECAR_PYTHON = process.execPath;
    delete process.env.ARCELLE_SIDECAR_DIR;

    let stderrStream: PassThrough | null = null;
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stderrStream = stderr;
      Object.assign(child, { stdout, stderr, pid: 424_242 });
      queueMicrotask(() => stdout.write(`SIDECAR_PORT=${address.port}\n`));
      return child;
    });

    // Silence + count the process.stderr mirror so the test doesn't spam
    // real console output with thousands of lines.
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const url = await spawnAndWait(5_000);
    expect(url).toBe(`http://127.0.0.1:${address.port}`);
    expect(stderrStream).not.toBeNull();

    // Push well past the budget: enough 1,000-byte lines to add up to
    // several times STDERR_LOG_BUDGET.
    const LINE_BYTES = 1_000;
    const LINE_COUNT = Math.ceil((STDERR_LOG_BUDGET * 3) / (LINE_BYTES + 1));
    const line = "x".repeat(LINE_BYTES);
    // TS narrows a `let` written from inside a nested closure (the mock
    // above) back to only its initializer's type at the point it's read
    // here, not `PassThrough | null` -- a known control-flow-analysis limit
    // across closure boundaries, not a real possible-null case (the
    // `expect(...).not.toBeNull()` above is the actual runtime guarantee).
    const stderr = stderrStream as unknown as PassThrough;
    const drained = new Promise<void>((resolve) => stderr.on("end", resolve));
    for (let i = 0; i < LINE_COUNT; i++) {
      stderr.write(`${line}\n`);
    }
    stderr.end();
    await drained;

    // Every single line was drained off the pipe and mirrored -- the reader
    // never stopped consuming, which is what would otherwise wedge the
    // child's writes once the on-disk budget was reached.
    const mirroredLines = writeSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("[sidecar] "),
    );
    expect(mirroredLines.length).toBe(LINE_COUNT);

    // ...but the FILE on disk stopped growing at the budget, plus the
    // one-time "dropped" notice, instead of holding the full multi-times-
    // budget stream.
    const onDisk = readFileSync(stderrLogPath(), "utf8");
    expect(onDisk.length).toBeLessThan(STDERR_LOG_BUDGET + LINE_BYTES + 200);
    expect(onDisk.length).toBeGreaterThan(STDERR_LOG_BUDGET - LINE_BYTES);
    expect(onDisk).toContain("log budget reached — further output dropped");
    expect(onDisk.length).toBeLessThan(LINE_COUNT * (LINE_BYTES + 1));

    writeSpy.mockRestore();
  }, 10_000);
});

describe("runViaSidecar: the busy guard around a whole streaming answer", () => {
  // ADVERSARIAL-PASS ADDITION (2026-08-22). `runViaSidecar` is the PUBLIC
  // entry point of the `/run` client and had no test of any kind: nothing in
  // the workspace referenced it, so its whole body — ensureUp, take the guard,
  // stream, release in a `finally` — could have been deleted with every suite
  // still green.
  //
  // The guard is the point, and it fails in two opposite and equally silent
  // ways. Never TAKEN, and a concurrent `ensureUp()` on another task sees an
  // idle sidecar and SIGTERMs the process mid-reply — the exact thing
  // `sidecar.ts`'s own header calls "the one thing that stops another task's
  // health probe SIGTERMing the process mid-reply". Never RELEASED, and
  // `inflightCount()` never returns to zero, so `shouldReplace("busy", n)` is
  // false forever and a genuinely wedged sidecar can never be replaced again
  // for the life of the app.
  //
  // It lives in THIS file rather than beside the other `/run` tests because
  // reaching `runViaSidecar` at all means going through `ensureUp()`'s spawn
  // lifecycle, which needs the file-wide `vi.mock("node:child_process")` above
  // and the real-HTTP-server harness the single-flight test established.
  const savedPython = process.env.ARCELLE_SIDECAR_PYTHON;
  const savedDir = process.env.ARCELLE_SIDECAR_DIR;
  let server: http.Server | null = null;

  beforeEach(() => {
    stopIfOurs();
  });

  afterEach(async () => {
    if (savedPython === undefined) {
      delete process.env.ARCELLE_SIDECAR_PYTHON;
    } else {
      process.env.ARCELLE_SIDECAR_PYTHON = savedPython;
    }
    if (savedDir === undefined) {
      delete process.env.ARCELLE_SIDECAR_DIR;
    } else {
      process.env.ARCELLE_SIDECAR_DIR = savedDir;
    }
    vi.mocked(spawn).mockReset();
    stopIfOurs();
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  /** Stand up a real loopback server answering `/health` plus a `/run` the
   * caller shapes, and point the (mocked) spawn at it — the same harness the
   * single-flight test uses, so `runViaSidecar` runs its REAL `ensureUp()`
   * path rather than a stubbed one. */
  async function sidecarServing(run: (res: http.ServerResponse) => void): Promise<void> {
    server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/run") {
        run(res);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a TCP listener");
    }
    process.env.ARCELLE_SIDECAR_PYTHON = process.execPath;
    delete process.env.ARCELLE_SIDECAR_DIR;
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr, pid: 987_654 });
      queueMicrotask(() => stdout.write(`SIDECAR_PORT=${address.port}\n`));
      return child;
    });
  }

  const request = {
    model: "qwen3.5:9b",
    question: "what is the rent",
    runId: "ask-guard",
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok" },
  };

  it("HOLDS the guard for the whole answer and releases it once the run is done", async () => {
    await sidecarServing((res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ t: "delta", v: "streaming", run_id: "ask-guard" })}\n`);
      setTimeout(() => {
        res.write(`${JSON.stringify({ t: "final", v: "the answer", run_id: "ask-guard" })}\n`);
        res.end();
      }, 20);
    });

    const baseline = inflightCount();
    // Sampled from INSIDE the stream, which is the only moment the claim is
    // checkable at all: a guard taken and released around nothing would leave
    // the before/after readings identical and prove nothing.
    let heldDuringStream = -1;
    const outcome = await runViaSidecar(request, {
      turn: new TurnId("ask-guard", "chat-guard"),
      onEvent: () => {
        heldDuringStream = inflightCount();
      },
    });

    expect(outcome).toEqual({ kind: "done", text: "the answer", usage: null, plan: null });
    expect(heldDuringStream).toBe(baseline + 1);
    expect(inflightCount()).toBe(baseline);
  }, 15_000);

  it("releases the guard even when the run FAILS, so a wedged sidecar stays replaceable", async () => {
    // The leak that matters: a run that ends badly is exactly when the next
    // `ensureUp()` most needs to be free to replace the process.
    await sidecarServing((res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "boom" }));
    });

    const baseline = inflightCount();
    const outcome = await runViaSidecar(request, { turn: null, onEvent: () => undefined });

    expect(outcome.kind).toBe("failed");
    expect(inflightCount()).toBe(baseline);
    // ...and the counter really is back at a value that permits replacement.
    expect(shouldReplace("busy", inflightCount())).toBe(true);
  }, 15_000);
});
