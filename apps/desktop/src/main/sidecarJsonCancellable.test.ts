/**
 * Tests for `sidecarJsonCancellable_b.ts` — the pure sentinel/classification
 * logic ported verbatim from `src-tauri/src/sidecar.rs`'s `SidecarError`
 * impl, plus wire-level coverage of the cancellable POST against a real local
 * `node:http` server (the same convention `sidecarRun.test.ts` uses for its
 * own `streamRun` wire tests — a real server, `ensureUp` mocked to point at
 * it rather than going through the real spawn lifecycle, which is
 * `sidecar.ts`'s own territory and already tested there).
 */

import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CancelFlag } from "./cancel.js";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { ensureUp } from "./sidecar.js";
import {
  humanizeEmptyGeneration,
  SIDECAR_DOWN,
  sidecarErrorSentinel,
  sidecarJsonCancellable,
  type SidecarError,
} from "./sidecarJsonCancellable.js";

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("sidecarErrorSentinel", () => {
  // Ported from `SidecarError::sentinel`'s own doc: this is what makes
  // `file_pass.rs`/`summarize.rs`/`vision.rs` match exactly what they
  // returned when Rust called Ollama directly.
  it("passes OLLAMA_DOWN straight through", () => {
    const e: SidecarError = { code: "OLLAMA_DOWN", error: "connection refused", status: 0 };
    expect(sidecarErrorSentinel(e, "qwen3.5:4b")).toBe("OLLAMA_DOWN");
  });

  it("SIDECAR_DOWN gets its own sentence, never the OLLAMA_DOWN token", () => {
    const e: SidecarError = { code: SIDECAR_DOWN, error: "no bundled binary found", status: 503 };
    expect(sidecarErrorSentinel(e, null)).toBe(
      "Arcelle's AI helper could not start, so nothing could run: no bundled binary found"
    );
  });

  it("MODEL_MISSING is re-tagged with the model name when one is given", () => {
    const e: SidecarError = { code: "MODEL_MISSING", error: "not pulled", status: 404 };
    expect(sidecarErrorSentinel(e, "qwen3.5:4b")).toBe("MODEL_MISSING:qwen3.5:4b");
    expect(sidecarErrorSentinel(e, null)).toBe("MODEL_MISSING");
  });

  it("anything else falls back to a plain Local AI error line", () => {
    const e: SidecarError = { code: "ENGINE_ERROR", error: "boom", status: 500 };
    expect(sidecarErrorSentinel(e, "m")).toBe("Local AI error (500): boom");
  });

  it("an empty-generation hint is humanized instead of the raw status line", () => {
    const e: SidecarError = { code: "ENGINE_ERROR", error: "Usage limit reached for today", status: 429 };
    expect(sidecarErrorSentinel(e, "m")).toBe(humanizeEmptyGeneration(e.error));
    expect(sidecarErrorSentinel(e, "m")).toContain("switch to an on-device model");
  });
});

describe("humanizeEmptyGeneration", () => {
  it("recognizes every documented hint, case-insensitively", () => {
    for (const hint of [
      "Usage limit exceeded",
      "you have reached your daily limit",
      "No generation chunks were returned",
      "Quota Exceeded",
      "insufficient_quota",
    ]) {
      expect(humanizeEmptyGeneration(hint)).not.toBeNull();
    }
  });

  it("leaves an unrelated message alone", () => {
    expect(humanizeEmptyGeneration("connection reset by peer")).toBeNull();
    // The regression the Rust comment calls out: a bare "quota" that is NOT
    // one of the allowance phrases must not be humanized away.
    expect(humanizeEmptyGeneration("disk quota exceeded on /var")).not.toBeNull(); // contains "quota exceeded"
    expect(humanizeEmptyGeneration("a file named quota.xlsx failed to open")).toBeNull();
  });
});

describe("sidecarJsonCancellable", () => {
  afterEach(() => {
    vi.mocked(ensureUp).mockReset();
    vi.unstubAllGlobals();
  });

  it("checks cancellation before touching the network at all", async () => {
    const cancel = new CancelFlag();
    cancel.store(true);
    const outcome = await sidecarJsonCancellable("/file_pass_map", { a: 1 }, cancel);
    expect(outcome).toEqual({ kind: "stopped" });
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("a dead sidecar surfaces as SIDECAR_DOWN, not as a network error", async () => {
    vi.mocked(ensureUp).mockRejectedValue(new Error("no bundled binary in Resources/"));
    const outcome = await sidecarJsonCancellable("/file_pass_map", {}, new CancelFlag());
    expect(outcome).toEqual({
      kind: "error",
      error: { code: SIDECAR_DOWN, error: "no bundled binary in Resources/", status: 503 },
    });
  });

  it("a successful response is returned as the parsed value", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echo: JSON.parse(body) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      const outcome = await sidecarJsonCancellable("/file_pass_map", { window: 3 }, new CancelFlag());
      expect(outcome).toEqual({ kind: "value", value: { echo: { window: 3 } } });
    } finally {
      await closeServer(server);
    }
  });

  it("a non-2xx JSON body becomes a classified SidecarError", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "MODEL_MISSING", error: "qwen3.5:4b is not pulled" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      const outcome = await sidecarJsonCancellable("/file_pass_map", {}, new CancelFlag());
      expect(outcome).toEqual({
        kind: "error",
        error: { code: "MODEL_MISSING", error: "qwen3.5:4b is not pulled", status: 422 },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("a non-2xx body that isn't JSON falls back to ENGINE_ERROR/unknown error", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal server error");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      const outcome = await sidecarJsonCancellable("/file_pass_map", {}, new CancelFlag());
      expect(outcome).toEqual({
        kind: "error",
        error: { code: "ENGINE_ERROR", error: "unknown error", status: 500 },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("classifies a refused sidecar connection through its cause chain", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      cause: { code: "ECONNREFUSED" },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(refused));

    await expect(sidecarJsonCancellable("/file_pass_map", {}, new CancelFlag())).resolves.toEqual({
      kind: "error",
      error: { code: "OLLAMA_DOWN", error: "connect ECONNREFUSED", status: 0 },
    });
  });

  it("keeps a non-refused, non-Error fetch failure as ENGINE_ERROR", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("socket closed"));

    await expect(sidecarJsonCancellable("/file_pass_map", {}, new CancelFlag())).resolves.toEqual({
      kind: "error",
      error: { code: "ENGINE_ERROR", error: "socket closed", status: 0 },
    });
  });

  it("keeps a malformed successful JSON body as an engine error", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON", { status: 200 })));

    await expect(sidecarJsonCancellable("/file_pass_map", {}, new CancelFlag())).resolves.toEqual({
      kind: "error",
      error: expect.objectContaining({ code: "ENGINE_ERROR", status: 200 }),
    });
  });

  it("turns its deadline abort into the established timeout envelope", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")));
        })
      )
    );

    await expect(sidecarJsonCancellable("/file_pass_map", {}, new CancelFlag(), 1)).resolves.toEqual({
      kind: "error",
      error: {
        code: "ENGINE_ERROR",
        error: "The AI engine did not answer within 0s. Try a shorter request, or a faster model in Settings → Model.",
        status: 0,
      },
    });
  });

  it("stops when cancellation interrupts a non-OK response body", async () => {
    vi.mocked(ensureUp).mockResolvedValue("http://sidecar.test");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: false,
          status: 503,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")));
            }),
        } as Response)
      )
    );
    const cancel = new CancelFlag();
    const result = sidecarJsonCancellable("/file_pass_map", {}, cancel);
    setTimeout(() => cancel.store(true), 1);

    await expect(result).resolves.toEqual({ kind: "stopped" });
  });

  it("flipping the cancel flag mid-request aborts it and resolves stopped, promptly", async () => {
    let serverSawAbort = false;
    const server = http.createServer((req, res) => {
      req.on("aborted", () => {
        serverSawAbort = true;
      });
      // Never respond — simulates a long-running generation.
      void res;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    const cancel = new CancelFlag();
    try {
      const started = Date.now();
      const promise = sidecarJsonCancellable("/file_pass_map", {}, cancel);
      setTimeout(() => cancel.store(true), 30);
      const outcome = await promise;
      expect(outcome).toEqual({ kind: "stopped" });
      // Resolved close to the 100ms poll tick, not left hanging on a request
      // that never responds.
      expect(Date.now() - started).toBeLessThan(1_000);
      // Give the server's 'aborted' handler a tick to fire.
      await new Promise((r) => setTimeout(r, 20));
      expect(serverSawAbort).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("a cancel that lands while the BODY is still streaming is stopped, not an engine error", async () => {
    // The gap the poll+abort design opens: `fetch` resolves as soon as the
    // HEADERS arrive, so a 200 can be in hand while the generation is still
    // being written. Aborting then tears the body stream and `resp.json()`
    // throws — and reporting THAT as `{kind:"error"}` is wrong twice over: the
    // user is shown an AI error for a Stop they pressed, and `isFatal` says
    // false for it, so `filePass.ts` marks the window SKIPPED and drives on
    // past the Stop instead of parking the job. Rust's `select!` returns
    // `Ok(None)` for the whole race the moment the flag is set.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"result":"the first half of a long ');
      // …and never the closing brace.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    const cancel = new CancelFlag();
    try {
      const promise = sidecarJsonCancellable("/file_pass_map", {}, cancel);
      setTimeout(() => cancel.store(true), 30);
      expect(await promise).toEqual({ kind: "stopped" });
    } finally {
      await closeServer(server);
    }
  });
});
