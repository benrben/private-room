/**
 * Tests for `sttTools.ts`.
 *
 * The download's network step runs against a REAL local `node:http` server,
 * never a patched global `fetch` — the discipline `ollamaModels.test.ts`
 * establishes for `pullCancellableAt` — and its filesystem work runs against
 * real temp directories, matching `recBridge.ts`'s "fake the transport, keep the
 * real disk logic" convention. Only `sttDownloadModel`'s pre-network short
 * circuits use an injected `fetchImpl`, to prove the network is never reached.
 *
 * The `DICT_*` prompt constants are pinned BYTE-FOR-BYTE against literals
 * extracted from `stt_cmds.rs` itself (its `\`-continued lines joined exactly as
 * rustc joins them), not spot-checked by substring: these strings are the whole
 * behavior of the shaping passes, and a dropped word in one would be invisible
 * to every other assertion here.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DICT_PROMPT_OPTIMIZER,
  DICT_RETIRED_REASON,
  DICT_REWRITE,
  DICT_TAIL,
  DICT_TRANSLATE,
  MAX_MODEL_BYTES,
  MIN_MODEL_BYTES,
  MODEL_FILE,
  MODEL_SIZE_MB,
  MODEL_URL,
  NOT_A_MODEL,
  NO_LOCAL_MODEL_INSTALLED,
  OLLAMA_NOT_RUNNING,
  STT_ALREADY_DOWNLOADING,
  STT_DOWNLOAD_PROGRESS_CHANNEL,
  STT_DOWNLOAD_STOPPED,
  SttModelState,
  bundledSttModelPath,
  defaultShapeTextDeps,
  defaultSttDownloadDeps,
  dictCancel,
  dictModeGuidance,
  dictPassText,
  dictPushAudio,
  dictStart,
  dictStop,
  looksLikeGgmlModel,
  registerSttToolsIpc,
  runDictPass,
  shapeText,
  sttCancelDownload,
  sttDeleteModel,
  sttDownloadModel,
  sttDownloadModelAt,
  sttEffectiveModel,
  sttModelPath,
  sttStatus,
  writeAll,
  type DictGenerateFn,
  type ShapeTextDeps,
} from "./sttTools.js";
import type { OpenRoom } from "./turnEngine.js";
import {
  TRANSCRIBE_AUDIO_NOT_IMPLEMENTED,
  transcribeAudioNotImplemented,
} from "./chatCommandsGenerate.js";

// --------------------------------------------------------- test HTTP server

let server: http.Server | undefined;

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

// --------------------------------------------------------- scratch dirs

let scratch: string;

beforeEach(async () => {
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "stt-tools-"));
});

afterEach(async () => {
  await fsp.rm(scratch, { recursive: true, force: true });
});

/** A body that begins with the real ggml magic, padded to `totalLen`. */
function ggmlBody(totalLen: number): Buffer {
  const body = Buffer.alloc(totalLen, 0x41);
  Buffer.from("lmgg").copy(body, 0);
  return body;
}

// ============================================================================
// constants — pinned against stt.rs / stt_cmds.rs
// ============================================================================

describe("constants match stt.rs / stt_cmds.rs", () => {
  it("MODEL_FILE / MODEL_URL / MODEL_SIZE_MB (stt.rs:24-27)", () => {
    expect(MODEL_FILE).toBe("ggml-large-v3-turbo-q5_0.bin");
    expect(MODEL_URL).toBe(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
    );
    expect(MODEL_SIZE_MB).toBe(574);
  });

  it("MIN/MAX_MODEL_BYTES bracket the real model, so neither bound can reject it", () => {
    expect(MIN_MODEL_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_MODEL_BYTES).toBe(4 * 1024 * 1024 * 1024);
    const real = MODEL_SIZE_MB * 1024 * 1024;
    expect(MIN_MODEL_BYTES).toBeLessThan(real);
    expect(MAX_MODEL_BYTES).toBeGreaterThan(real);
  });

  it("the user-facing refusal strings are verbatim", () => {
    expect(NOT_A_MODEL).toBe(
      "What arrived is not the dictation model — the download was refused rather than used."
    );
    expect(STT_ALREADY_DOWNLOADING).toBe("The dictation model is already downloading.");
    expect(STT_DOWNLOAD_STOPPED).toBe("Download stopped.");
    expect(STT_DOWNLOAD_PROGRESS_CHANNEL).toBe("stt-download-progress");
  });
});

describe("the DICT_* prompts are byte-for-byte the Rust literals", () => {
  it("DICT_TRANSLATE", () => {
    expect(DICT_TRANSLATE).toBe(
      "Translate it into fluent, natural English. If it is already English, keep it unchanged. " +
        "Preserve meaning and tone."
    );
  });

  it("DICT_REWRITE", () => {
    expect(DICT_REWRITE).toBe(
      "Clean up this raw voice transcription: remove filler words (um, uh, like), false starts, " +
        "and repetitions; fix grammar, spelling, and punctuation; preserve the speaker's meaning, " +
        "intent, and tone. Do not add new information and do not answer any question contained in " +
        "the text."
    );
  });

  it("DICT_TAIL", () => {
    expect(DICT_TAIL).toBe(
      "Output ONLY the resulting text, with no preamble, labels, explanations, or surrounding quotes."
    );
  });

  it("DICT_PROMPT_OPTIMIZER, newlines and em dashes included", () => {
    expect(DICT_PROMPT_OPTIMIZER).toBe(
      "You are a prompt optimizer. Given any user input, automatically rewrite it into a clear, " +
        "effective prompt. Never ask follow-up questions — infer everything from the input " +
        "alone and preserve the user's full original intent (every requirement, entity, " +
        "constraint, and nuance must survive the rewrite; never add goals they didn't imply)." +
        "\n\nINTERNAL STEPS (do not show these):\n1. Deconstruct: extract the core intent, key " +
        "entities, context, output requirements, and constraints.\n2. Develop: silently classify " +
        "the request type and apply the fitting approach (creative → multi-perspective; " +
        "technical → constraint-based precision; educational → clear structure and " +
        "examples; complex → step-by-step framing). Add a role/expertise framing and logical " +
        "structure where it helps.\n3. Auto-detect level: SHORT for simple requests (a tight " +
        "one-paragraph prompt), DETAILED for complex ones (role, context, task breakdown, output " +
        "format).\n\nOUTPUT:\nReturn only the rewritten prompt — no preamble, no explanation " +
        "of changes, no questions."
    );
  });
});

// ============================================================================
// looksLikeGgmlModel
// ============================================================================

describe("looksLikeGgmlModel", () => {
  it("accepts the real ggml magic (the bytes 'l m g g'), with or without a tail", () => {
    expect(looksLikeGgmlModel(Buffer.from([0x6c, 0x6d, 0x67, 0x67, 0x9a, 0xca, 0x00, 0x00]))).toBe(
      true
    );
    expect(looksLikeGgmlModel(Buffer.from("lmgg"))).toBe(true);
    expect(looksLikeGgmlModel(new Uint8Array([0x6c, 0x6d, 0x67, 0x67]))).toBe(true);
  });

  it("rejects an error page, a JSON error body, a byte-order mixup, and anything short", () => {
    expect(looksLikeGgmlModel(Buffer.from("<!DOCTYPE html>"))).toBe(false);
    expect(looksLikeGgmlModel(Buffer.from('{"error":"not found"}'))).toBe(false);
    expect(looksLikeGgmlModel(Buffer.from("ggml"))).toBe(false); // byte order matters
    expect(looksLikeGgmlModel(Buffer.from("lmg"))).toBe(false);
    expect(looksLikeGgmlModel(Buffer.alloc(0))).toBe(false);
  });
});

// ============================================================================
// path resolution
// ============================================================================

describe("sttModelPath / bundledSttModelPath / sttEffectiveModel", () => {
  it("keeps Rust's 'models/' segment under BOTH the data dir and Resources", () => {
    expect(sttModelPath("/Users/x/Library/Application Support/Arcelle")).toBe(
      path.join("/Users/x/Library/Application Support/Arcelle", "models", MODEL_FILE)
    );
    expect(bundledSttModelPath("/Applications/Arcelle.app/Contents/Resources")).toBe(
      path.join("/Applications/Arcelle.app/Contents/Resources", "models", MODEL_FILE)
    );
  });

  it("prefers a downloaded copy over a bundled one", () => {
    const exists = (p: string): boolean =>
      p === sttModelPath("/data") || p === bundledSttModelPath("/res");
    expect(sttEffectiveModel("/data", "/res", exists)).toBe(sttModelPath("/data"));
  });

  it("falls back to the bundled copy when nothing was downloaded", () => {
    const exists = (p: string): boolean => p === bundledSttModelPath("/res");
    expect(sttEffectiveModel("/data", "/res", exists)).toBe(bundledSttModelPath("/res"));
  });

  it("answers null when neither exists (an unbundled dev build with nothing downloaded)", () => {
    expect(sttEffectiveModel("/data", "/res", () => false)).toBeNull();
    expect(sttEffectiveModel("/data", null, () => false)).toBeNull();
  });

  it("never dereferences a null resourcesPath", () => {
    const exists = vi.fn().mockReturnValue(false);
    expect(sttEffectiveModel("/data", null, exists)).toBeNull();
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith(sttModelPath("/data"));
  });

  it("reads the REAL filesystem by default (no injected `exists`)", async () => {
    expect(sttEffectiveModel(scratch, null)).toBeNull();
    await fsp.mkdir(path.dirname(sttModelPath(scratch)), { recursive: true });
    await fsp.writeFile(sttModelPath(scratch), "weights");
    expect(sttEffectiveModel(scratch, null)).toBe(sttModelPath(scratch));
  });
});

// ============================================================================
// sttStatus / sttCancelDownload
// ============================================================================

describe("sttStatus", () => {
  it("reports installed from sttEffectiveModel, downloading from state, and the real size", () => {
    const state = new SttModelState();
    expect(sttStatus("/data", null, state, () => false)).toEqual({
      installed: false,
      downloading: false,
      sizeMb: MODEL_SIZE_MB,
    });

    state.downloading = true;
    expect(sttStatus("/data", null, state, (p) => p === sttModelPath("/data"))).toEqual({
      installed: true,
      downloading: true,
      sizeMb: MODEL_SIZE_MB,
    });
  });

  it("a BUNDLED-only build reads as installed, so a release never prompts for a download", () => {
    const state = new SttModelState();
    const exists = (p: string): boolean => p === bundledSttModelPath("/res");
    expect(sttStatus("/data", "/res", state, exists).installed).toBe(true);
  });
});

describe("sttCancelDownload", () => {
  it("says so when there was nothing to stop, and leaves no flag armed for the next download", () => {
    const state = new SttModelState();
    expect(sttCancelDownload(state)).toBe(false);
    expect(state.cancelRequested).toBe(false);
  });

  it("raises the flag the download loop reads when one IS running", () => {
    const state = new SttModelState();
    state.downloading = true;
    expect(sttCancelDownload(state)).toBe(true);
    expect(state.cancelRequested).toBe(true);
  });
});

// ============================================================================
// writeAll — Rust's `write_all`, which `FileHandle.write` alone is not
// ============================================================================

describe("writeAll", () => {
  it("loops until every byte is stored, exactly as Rust's write_all does", async () => {
    const stored: number[] = [];
    // A writer that stores at most 3 bytes per call — what a `write(2)` short
    // write looks like. A single `fh.write(chunk)` would silently keep 3 of 10.
    const fake = {
      write: async (buffer: Buffer, offset: number, length: number) => {
        const n = Math.min(3, length);
        for (let i = 0; i < n; i += 1) {
          stored.push(buffer[offset + i]!);
        }
        return Promise.resolve({ bytesWritten: n });
      },
    };
    const chunk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await writeAll(fake, chunk);
    expect(Buffer.from(stored)).toEqual(chunk);
  });

  it("refuses to spin forever when a write makes no progress", async () => {
    const stuck = { write: async () => Promise.resolve({ bytesWritten: 0 }) };
    await expect(writeAll(stuck, Buffer.from("abc"))).rejects.toThrow(/no progress/);
  });

  it("is a no-op for an empty chunk", async () => {
    const write = vi.fn();
    await writeAll({ write }, Buffer.alloc(0));
    expect(write).not.toHaveBeenCalled();
  });
});

// ============================================================================
// sttDownloadModelAt — the real streaming/validation core
// ============================================================================

describe("sttDownloadModelAt", () => {
  it("streams to .part, validates magic + size, renames into place, and reports progress", async () => {
    const body = ggmlBody(64);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.write(body.subarray(0, 20));
      res.end(body.subarray(20));
    });
    const dest = path.join(scratch, MODEL_FILE);
    const state = new SttModelState();
    const progress: Array<[number, number, number]> = [];

    await sttDownloadModelAt(base, dest, state, (got, total, pct) => progress.push([got, total, pct]), {
      minBytes: 50,
    });

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    // Byte-identical: this is what `writeAll` is there to guarantee.
    expect(fs.readFileSync(dest)).toEqual(body);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual([body.length, body.length, 100]);
  });

  it("creates the destination's parent directory when it does not exist yet", async () => {
    const body = ggmlBody(64);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const dest = sttModelPath(scratch); // <scratch>/models/<MODEL_FILE>
    await sttDownloadModelAt(base, dest, new SttModelState(), undefined, { minBytes: 10 });
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("refuses an error page served with a 200, and cleans up .part", async () => {
    const page = Buffer.from("<!DOCTYPE html><html>captive portal</html>");
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(page.length) });
      res.end(page);
    });
    const dest = path.join(scratch, MODEL_FILE);

    await expect(
      sttDownloadModelAt(base, dest, new SttModelState(), undefined, { minBytes: 10 })
    ).rejects.toThrow(NOT_A_MODEL);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("refuses a truncated body even when its first four bytes are valid magic", async () => {
    const body = ggmlBody(10);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const dest = path.join(scratch, MODEL_FILE);

    await expect(
      sttDownloadModelAt(base, dest, new SttModelState(), undefined, { minBytes: 1000 })
    ).rejects.toThrow(NOT_A_MODEL);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("refuses on the DECLARED size alone, before a byte is written", async () => {
    const small = ggmlBody(20);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": "999999999" });
      res.end(small);
    });
    const dest = path.join(scratch, MODEL_FILE);

    await expect(
      sttDownloadModelAt(base, dest, new SttModelState(), undefined, { minBytes: 10, maxBytes: 100 })
    ).rejects.toThrow(NOT_A_MODEL);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("bounds a server that declares NOTHING and keeps sending (chunked)", async () => {
    // No content-length at all — Rust's `unwrap_or` fallback path — so only the
    // per-chunk `got > maxBytes` guard can stop it.
    const base = await listenOn((_req, res) => {
      res.writeHead(200); // chunked
      res.write(ggmlBody(64));
      res.write(Buffer.alloc(256, 2));
      res.end();
    });
    const dest = path.join(scratch, MODEL_FILE);

    await expect(
      sttDownloadModelAt(base, dest, new SttModelState(), undefined, { minBytes: 1, maxBytes: 32 })
    ).rejects.toThrow(NOT_A_MODEL);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("stops without keeping any bytes once cancelled", async () => {
    const body = ggmlBody(64);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const dest = path.join(scratch, MODEL_FILE);
    const state = new SttModelState();
    state.cancelRequested = true; // requested before the transfer even starts

    await expect(
      sttDownloadModelAt(base, dest, state, undefined, { minBytes: 10 })
    ).rejects.toThrow(STT_DOWNLOAD_STOPPED);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("stops MID-stream when the flag is raised after the first chunk", async () => {
    const state = new SttModelState();
    const base = await listenOn((_req, res) => {
      res.writeHead(200);
      res.write(ggmlBody(16));
      const timer = setTimeout(() => {
        state.cancelRequested = true;
        res.write(Buffer.alloc(1024, 1));
        res.end();
      }, 20);
      res.on("close", () => clearTimeout(timer));
    });
    const dest = path.join(scratch, MODEL_FILE);

    await expect(
      sttDownloadModelAt(base, dest, state, undefined, { minBytes: 1 })
    ).rejects.toThrow(STT_DOWNLOAD_STOPPED);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("rejects a non-2xx response", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });
    await expect(
      sttDownloadModelAt(base, path.join(scratch, MODEL_FILE), new SttModelState())
    ).rejects.toThrow(/download failed: HTTP 404/);
  });

  it("wraps a transport failure in Rust's own 'download failed:' prefix", async () => {
    // Port 1 on loopback answers nothing — a connection error, not an HTTP one.
    await expect(
      sttDownloadModelAt(
        "http://127.0.0.1:1/unreachable",
        path.join(scratch, MODEL_FILE),
        new SttModelState()
      )
    ).rejects.toThrow(/^download failed: /);
    expect(fs.existsSync(`${path.join(scratch, MODEL_FILE)}.part`)).toBe(false);
  });

  it("refuses a response with no body at all", async () => {
    const noBody: typeof fetch = async () =>
      Promise.resolve(new Response(null, { status: 200, headers: { "content-length": "10" } }));
    await expect(
      sttDownloadModelAt("https://example.invalid/m", path.join(scratch, MODEL_FILE), new SttModelState(), undefined, {
        deps: { exists: () => false, fetchImpl: noBody },
      })
    ).rejects.toThrow(/no body/);
  });

  // -- the transfer must be RELEASED on every abnormal exit ------------------
  // Rust's `return Err(..)` drops `resp.bytes_stream()`, and dropping a reqwest
  // body aborts the request. An abandoned reader does not: Stop would answer
  // "Download stopped." while 574 MB stayed on the wire. A hand-built
  // ReadableStream is the only way to observe this — a real socket's release is
  // invisible from here.

  /**
   * A response body that reports whether its consumer released it.
   *
   * `endless` keeps the source producing after `chunks` runs out (with a hard
   * cap that errors rather than hangs). That is what a real, still-open socket
   * does, and it is the only way to observe the release deterministically: a
   * source allowed to reach its own end CLOSES the stream, after which
   * `cancel()` is a silent no-op and the assertion would pass or fail on a
   * microtask race.
   */
  function observableBody(
    chunks: readonly Uint8Array[],
    opts: { endless?: boolean; onPull?: (index: number) => void } = {}
  ): { body: ReadableStream<Uint8Array>; wasCancelled: () => boolean } {
    let cancelled = false;
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        opts.onPull?.(i);
        const next = chunks[i];
        i += 1;
        if (next !== undefined) {
          controller.enqueue(next);
          return;
        }
        if (opts.endless !== true) {
          controller.close();
          return;
        }
        if (i > chunks.length + 200) {
          controller.error(new Error("the transfer was never released"));
          return;
        }
        controller.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, wasCancelled: () => cancelled };
  }

  it("releases the transfer when Stop lands mid-stream, instead of leaving it on the wire", async () => {
    const state = new SttModelState();
    const { body, wasCancelled } = observableBody([new Uint8Array(ggmlBody(64))], {
      endless: true,
      onPull: (index) => {
        if (index === 1) {
          state.cancelRequested = true; // Stop, with a chunk already in flight
        }
      },
    });
    const fetchImpl: typeof fetch = async () =>
      Promise.resolve(new Response(body, { status: 200, headers: { "content-length": "999" } }));

    await expect(
      sttDownloadModelAt("https://example.invalid/m", path.join(scratch, MODEL_FILE), state, undefined, {
        deps: { exists: () => false, fetchImpl },
        minBytes: 1,
      })
    ).rejects.toThrow(STT_DOWNLOAD_STOPPED);
    expect(wasCancelled()).toBe(true);
  });

  it("releases the transfer when a misbehaving mirror blows the size ceiling", async () => {
    const { body, wasCancelled } = observableBody([new Uint8Array(ggmlBody(64))], {
      endless: true,
    });
    const fetchImpl: typeof fetch = async () => Promise.resolve(new Response(body, { status: 200 }));

    await expect(
      sttDownloadModelAt("https://example.invalid/m", path.join(scratch, MODEL_FILE), new SttModelState(), undefined, {
        deps: { exists: () => false, fetchImpl },
        minBytes: 1,
        maxBytes: 100,
      })
    ).rejects.toThrow(NOT_A_MODEL);
    expect(wasCancelled()).toBe(true);
  });

  it("does not choke on releasing a stream that already ended by itself", async () => {
    const { body, wasCancelled } = observableBody([new Uint8Array(ggmlBody(64))]);
    const fetchImpl: typeof fetch = async () => Promise.resolve(new Response(body, { status: 200 }));
    const dest = path.join(scratch, MODEL_FILE);

    await sttDownloadModelAt("https://example.invalid/m", dest, new SttModelState(), undefined, {
      deps: { exists: () => false, fetchImpl },
      minBytes: 1,
    });
    expect(fs.existsSync(dest)).toBe(true);
    // An exhausted reader is already closed: cancelling it is a silent no-op,
    // never an error that would turn a finished download into a failed one.
    expect(wasCancelled()).toBe(false);
  });

  it("a stream that BREAKS mid-transfer keeps Rust's own 'download interrupted:' wording", async () => {
    // stt_cmds.rs:166 — distinct from "download failed:", which is the request
    // itself never getting off the ground. Without it the rejected read escapes
    // as a bare "terminated"/"socket hang up".
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(ggmlBody(32)));
        controller.error(new Error("socket hang up"));
      },
    });
    const fetchImpl: typeof fetch = async () => Promise.resolve(new Response(body, { status: 200 }));
    const dest = path.join(scratch, MODEL_FILE);

    await expect(
      sttDownloadModelAt("https://example.invalid/m", dest, new SttModelState(), undefined, {
        deps: { exists: () => false, fetchImpl },
        minBytes: 1,
      })
    ).rejects.toThrow(/^download interrupted: socket hang up/);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("survives a real socket dying partway through, leaving no half model behind", async () => {
    const body = ggmlBody(4096);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.write(body.subarray(0, 1024));
      setTimeout(() => res.socket?.destroy(), 10);
    });
    const dest = sttModelPath(scratch);

    await expect(
      sttDownloadModelAt(base, dest, new SttModelState(), undefined, { minBytes: 1 })
    ).rejects.toThrow(/^download interrupted: /);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  // -- content-length is `Option<u64>` in Rust, not `Number()` ---------------
  for (const header of ["-1", "", "1e3"]) {
    it(`a content-length of ${JSON.stringify(header)} reads as ABSENT, like Rust's u64 parse`, async () => {
      const seen: Array<[number, number, number]> = [];
      const fetchImpl: typeof fetch = async () =>
        Promise.resolve(
          new Response(ggmlBody(64), { status: 200, headers: { "content-length": header } })
        );

      await expect(
        sttDownloadModelAt(
          "https://example.invalid/m",
          path.join(scratch, MODEL_FILE),
          new SttModelState(),
          (got, total, pct) => seen.push([got, total, pct]),
          { deps: { exists: () => false, fetchImpl }, minBytes: 1000 }
        )
      ).rejects.toThrow(NOT_A_MODEL);
      // Rust falls back to MODEL_SIZE_MB*1024*1024 as the denominator, so a
      // 64-byte body rounds to 0% and emits nothing at all. Taking these
      // headers at face value instead sent `{total: -1, percent: 6400}` — a
      // denominator the renderer's progress bar divides by.
      expect(seen).toEqual([]);
    });
  }
});

// ============================================================================
// sttDownloadModel — the production short circuits and the single-flight gate
// ============================================================================

describe("sttDownloadModel", () => {
  const neverCalled = (spy: ReturnType<typeof vi.fn>): { exists: (p: string) => boolean; fetchImpl: typeof fetch } => ({
    exists: () => false,
    fetchImpl: spy as unknown as typeof fetch,
  });

  it("does nothing, and sweeps a leftover .part, when a downloaded copy already exists", async () => {
    const dest = sttModelPath(scratch);
    const part = `${dest}.part`;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(part, "leftover");
    const fetchSpy = vi.fn();

    await sttDownloadModel(scratch, null, new SttModelState(), undefined, {
      exists: (p) => p === dest,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(part)).toBe(false);
  });

  it("does nothing when a BUNDLED copy already exists", async () => {
    const fetchSpy = vi.fn();
    const bundled = bundledSttModelPath("/res");
    await sttDownloadModel(scratch, "/res", new SttModelState(), undefined, {
      exists: (p) => p === bundled,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a second download while one is running, without touching the network", async () => {
    const state = new SttModelState();
    state.downloading = true;
    const fetchSpy = vi.fn();
    await expect(
      sttDownloadModel(scratch, null, state, undefined, neverCalled(fetchSpy))
    ).rejects.toThrow(STT_ALREADY_DOWNLOADING);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The refusal must not clear the flags the download in flight is using.
    expect(state.downloading).toBe(true);
  });

  it("clears downloading/cancelRequested on the failure path, so the next attempt is clean", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    const state = new SttModelState();
    state.cancelRequested = true; // a Stop against a PREVIOUS download
    const deps = { exists: () => false, fetchImpl: ((url: string) => fetch(base + new URL(url).pathname)) as unknown as typeof fetch };

    await expect(sttDownloadModel(scratch, null, state, undefined, deps)).rejects.toThrow(/HTTP 500/);
    expect(state.downloading).toBe(false);
    expect(state.cancelRequested).toBe(false);
  });

  it("marks downloading for the whole transfer, so sttStatus can say so", async () => {
    let seen: boolean | undefined;
    const body = ggmlBody(64);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const state = new SttModelState();
    const deps = {
      exists: () => false,
      fetchImpl: ((url: string) => {
        seen = sttStatus(scratch, null, state, () => false).downloading;
        return fetch(base + new URL(url).pathname);
      }) as unknown as typeof fetch,
    };
    // The real MIN_MODEL_BYTES rejects this 64-byte body — that is fine; the
    // flag's lifetime is what this pins.
    await expect(sttDownloadModel(scratch, null, state, undefined, deps)).rejects.toThrow(NOT_A_MODEL);
    expect(seen).toBe(true);
    expect(state.downloading).toBe(false);
  });

  it("refuses a second call while one is GENUINELY in flight, without disturbing the first", async () => {
    const body = ggmlBody(4096);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.write(body.subarray(0, 1024));
      void gate.then(() => res.end(body.subarray(1024)));
    });
    const state = new SttModelState();
    const deps = {
      exists: () => false,
      fetchImpl: ((url: string) => fetch(base + new URL(url).pathname)) as unknown as typeof fetch,
    };
    try {
      const first = sttDownloadModelAt(`${base}/m`, sttModelPath(scratch), state, undefined, {
        deps,
        minBytes: 1,
      });
      state.downloading = true; // what sttDownloadModel does around that call

      await expect(sttDownloadModel(scratch, null, state, undefined, deps)).rejects.toThrow(
        STT_ALREADY_DOWNLOADING
      );
      release();
      await first;

      expect(fs.readFileSync(sttModelPath(scratch))).toEqual(body);
      expect(fs.existsSync(`${sttModelPath(scratch)}.part`)).toBe(false);
    } finally {
      release();
    }
  });

  it("a Stop pressed against the PREVIOUS download does not kill the next one", async () => {
    const body = ggmlBody(4096);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const state = new SttModelState();
    // The user stopped a download, and the flag outlived it.
    state.downloading = true;
    expect(sttCancelDownload(state)).toBe(true);
    state.downloading = false;

    const deps = {
      exists: () => false,
      fetchImpl: ((url: string) => fetch(base + new URL(url).pathname)) as unknown as typeof fetch,
    };
    // The real MIN_MODEL_BYTES refuses this 4 KB body; what matters is that the
    // refusal is NOT_A_MODEL — a stale cancel flag would have said "Download
    // stopped." on the very first chunk instead.
    await expect(sttDownloadModel(scratch, null, state, undefined, deps)).rejects.toThrow(
      NOT_A_MODEL
    );
    expect(state.cancelRequested).toBe(false);
  });

  it("defaultSttDownloadDeps points at the real fs/fetch", () => {
    expect(defaultSttDownloadDeps.exists).toBeTypeOf("function");
    expect(defaultSttDownloadDeps.fetchImpl).toBe(fetch);
  });
});

// ============================================================================
// sttDeleteModel
// ============================================================================

describe("sttDeleteModel", () => {
  it("deletes the downloaded model AND the .part a quit-out download left behind", async () => {
    const dest = sttModelPath(scratch);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, "weights");
    await fsp.writeFile(`${dest}.part`, "stale");

    await sttDeleteModel(scratch);

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("succeeds when nothing was ever downloaded", async () => {
    await expect(sttDeleteModel(scratch)).resolves.toBeUndefined();
  });

  it("propagates a real removal failure rather than swallowing it", async () => {
    const dest = sttModelPath(scratch);
    // A directory in the model's place cannot be removed by a non-recursive
    // `rm` even with `force: true` — a real failure, not an absence.
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, "inside"), "x");
    await expect(sttDeleteModel(scratch)).rejects.toThrow();
  });
});

// ============================================================================
// dictModeGuidance / dictPassText
// ============================================================================

describe("dictModeGuidance", () => {
  it("carries each mode's guidance verbatim", () => {
    expect(dictModeGuidance("raw")).toEqual(["", false]);
    expect(dictModeGuidance("email")).toEqual([
      "Shape it as the body of a clear, courteous email. Do not invent a subject line, " +
        "greeting, or signature unless they were dictated.",
      false,
    ]);
    expect(dictModeGuidance("message")).toEqual([
      "Shape it as a concise, natural chat/Slack message.",
      false,
    ]);
    expect(dictModeGuidance("commit")).toEqual([
      "Shape it as a git commit message: a short imperative summary line (<=72 chars), " +
        "then a blank line, then bullet points if warranted.",
      false,
    ]);
    expect(dictModeGuidance("notes")).toEqual([
      "Shape it as clean, organized notes (short paragraphs or bullets).",
      false,
    ]);
  });

  it("prompt REPLACES the cleanup step with the prompt optimizer", () => {
    expect(dictModeGuidance("prompt")).toEqual([DICT_PROMPT_OPTIMIZER, true]);
  });

  it("off / unknown is null — no rewrite stage at all", () => {
    expect(dictModeGuidance("off")).toBeNull();
    expect(dictModeGuidance("")).toBeNull();
    expect(dictModeGuidance("nonsense")).toBeNull();
  });

  it("a prototype-polluting mode name is just an unknown mode", () => {
    // `mode` arrives from the renderer. A lookup table keyed by it would answer
    // for "__proto__"/"constructor"; the switch cannot.
    expect(dictModeGuidance("__proto__")).toBeNull();
    expect(dictModeGuidance("constructor")).toBeNull();
    expect(dictModeGuidance("toString")).toBeNull();
  });
});

describe("dictPassText", () => {
  it("strips a closed <think> span so the model's reasoning never types into the composer", () => {
    expect(
      dictPassText("<think>They said 'their' but meant 'there'.</think>\nMeet me there at six.")
    ).toBe("Meet me there at six.");
  });

  it("an UNTERMINATED <think> truncates everything after it", () => {
    expect(dictPassText("<think>unterminated")).toBe("");
  });

  it("plain text is just trimmed", () => {
    expect(dictPassText("  Meet me at six.  ")).toBe("Meet me at six.");
  });
});

// ============================================================================
// runDictPass
// ============================================================================

/** The user-message `content` of one recorded {@link DictGenerateFn} call. */
function promptOf(call: unknown): string {
  const messages = (call as [string, { content: string }[]])[1];
  const first = messages[0];
  if (first === undefined) {
    throw new Error("generate() was called with no messages");
  }
  return first.content;
}

describe("runDictPass", () => {
  it("a single step gets a plain prompt, at temperature 0.2 / keepAlive 5m", async () => {
    const generateFn = vi.fn().mockResolvedValue("Cleaned up text.");
    const result = await runDictPass("qwen3.5:4b", [DICT_REWRITE], "um so like hi", generateFn);
    expect(result).toBe("Cleaned up text.");
    expect(generateFn).toHaveBeenCalledWith(
      "qwen3.5:4b",
      [{ role: "user", content: `${DICT_REWRITE}\n\n${DICT_TAIL}\n\nINPUT TEXT:\num so like hi` }],
      0.2,
      "5m"
    );
  });

  it("multiple steps keep the numbered 'operations in order' prompt", async () => {
    const generateFn = vi.fn().mockResolvedValue("Shaped.");
    await runDictPass("m", [DICT_REWRITE, "Shape it as a memo."], "text", generateFn);
    const prompt = promptOf(generateFn.mock.calls[0]);
    expect(
      prompt.startsWith(
        "You are a text post-processor. Apply the following operations to the INPUT TEXT, in order:\n"
      )
    ).toBe(true);
    expect(prompt).toContain(`1. ${DICT_REWRITE}`);
    expect(prompt).toContain("2. Shape it as a memo.");
    expect(prompt.endsWith(`${DICT_TAIL}\n\nINPUT TEXT:\ntext`)).toBe(true);
  });

  it("strips <think> spans from the model's raw answer", async () => {
    const generateFn = vi.fn().mockResolvedValue("<think>reasoning</think>Final answer.");
    expect(await runDictPass("m", [DICT_REWRITE], "x", generateFn)).toBe("Final answer.");
  });

  it("propagates a generate() failure rather than inventing text", async () => {
    const generateFn = vi.fn().mockRejectedValue(new Error("OLLAMA_DOWN"));
    await expect(runDictPass("m", [DICT_REWRITE], "x", generateFn)).rejects.toThrow("OLLAMA_DOWN");
  });
});

// ============================================================================
// shapeText
// ============================================================================

function fakeShapeDeps(overrides: Partial<ShapeTextDeps> = {}): ShapeTextDeps {
  return {
    listModelsRaw: vi.fn().mockResolvedValue(["qwen3.5:4b"]),
    modelSetting: vi.fn().mockReturnValue(null),
    runsOnThisMac: vi.fn().mockReturnValue(true),
    bestLocalDefault: vi.fn().mockReturnValue("qwen3.5:4b"),
    generate: vi.fn().mockResolvedValue("shaped text"),
    ...overrides,
  };
}

const fakeDb = {} as unknown as Parameters<ShapeTextDeps["modelSetting"]>[0];

describe("shapeText", () => {
  it("mode=off + translate=false returns the text unchanged, with NO model call at all", async () => {
    const deps = fakeShapeDeps();
    expect(await shapeText(null, "hello world", false, "off", deps)).toBe("hello world");
    expect(deps.listModelsRaw).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("an unrecognised mode with translate off is equally a no-op", async () => {
    const deps = fakeShapeDeps();
    expect(await shapeText(null, "um hi", false, "bogus-mode", deps)).toBe("um hi");
    expect(deps.listModelsRaw).not.toHaveBeenCalled();
  });

  it("list_models FAILING keeps Rust's own 'Ollama isn't running' message", async () => {
    const deps = fakeShapeDeps({
      listModelsRaw: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    });
    await expect(shapeText(null, "x", false, "raw", deps)).rejects.toThrow(OLLAMA_NOT_RUNNING);
    expect(OLLAMA_NOT_RUNNING).toBe("The local AI (Ollama) isn't running — raw transcript kept.");
  });

  it("an EMPTY model list keeps Rust's DIFFERENT 'nothing installed' message", async () => {
    const deps = fakeShapeDeps({ listModelsRaw: vi.fn().mockResolvedValue([]) });
    await expect(shapeText(null, "x", false, "raw", deps)).rejects.toThrow(NO_LOCAL_MODEL_INSTALLED);
    expect(NO_LOCAL_MODEL_INSTALLED).toBe("No local AI model is installed — raw transcript kept.");
    // The two causes are genuinely different things to do about it.
    expect(NO_LOCAL_MODEL_INSTALLED).not.toBe(OLLAMA_NOT_RUNNING);
  });

  it("prefers the open room's model_setting when it runs on this Mac", async () => {
    const modelSetting = vi.fn().mockReturnValue("room-model");
    const bestLocalDefault = vi.fn().mockReturnValue("qwen3.5:4b");
    const generateFn = vi.fn().mockResolvedValue("out");
    const deps = fakeShapeDeps({ modelSetting, bestLocalDefault, generate: generateFn });

    await shapeText(fakeDb, "x", false, "raw", deps);

    expect(modelSetting).toHaveBeenCalledWith(fakeDb);
    expect(generateFn.mock.calls[0]?.[0]).toBe("room-model");
    expect(bestLocalDefault).not.toHaveBeenCalled();
  });

  it("never reads model_setting when no room is open", async () => {
    const modelSetting = vi.fn();
    const deps = fakeShapeDeps({
      modelSetting,
      bestLocalDefault: vi.fn().mockReturnValue("installed-model"),
      listModelsRaw: vi.fn().mockResolvedValue(["installed-model"]),
    });
    await shapeText(null, "x", false, "raw", deps);
    expect(modelSetting).not.toHaveBeenCalled();
    expect(deps.bestLocalDefault).toHaveBeenCalledWith(["installed-model"]);
  });

  it("swaps a model that does not run on this Mac — dictated words stay local", async () => {
    const modelSetting = vi.fn().mockReturnValue("gpt-oss:120b-cloud");
    const runsOnThisMac = vi.fn().mockImplementation((m: string) => m === "local-model");
    const bestLocalDefault = vi.fn().mockReturnValue("local-model");
    const generateFn = vi.fn().mockResolvedValue("out");
    const deps = fakeShapeDeps({ modelSetting, runsOnThisMac, bestLocalDefault, generate: generateFn });

    await shapeText(fakeDb, "x", false, "raw", deps);

    expect(generateFn.mock.calls[0]?.[0]).toBe("local-model");
  });

  it("mode=raw shapes with DICT_REWRITE alone", async () => {
    const generateFn = vi.fn().mockResolvedValue("cleaned");
    const deps = fakeShapeDeps({ generate: generateFn });
    expect(await shapeText(null, "um hi", false, "raw", deps)).toBe("cleaned");
    expect(promptOf(generateFn.mock.calls[0]).startsWith(DICT_REWRITE)).toBe(true);
  });

  it("mode=email appends the mode's guidance AFTER DICT_REWRITE", async () => {
    const generateFn = vi.fn().mockResolvedValue("shaped");
    const deps = fakeShapeDeps({ generate: generateFn });
    await shapeText(null, "text", false, "email", deps);
    const prompt = promptOf(generateFn.mock.calls[0]);
    expect(prompt).toContain(`1. ${DICT_REWRITE}`);
    expect(prompt).toContain("2. Shape it as the body of a clear, courteous email.");
  });

  it("mode=prompt replaces cleanup entirely", async () => {
    const generateFn = vi.fn().mockResolvedValue("optimized");
    const deps = fakeShapeDeps({ generate: generateFn });
    await shapeText(null, "text", false, "prompt", deps);
    const prompt = promptOf(generateFn.mock.calls[0]);
    expect(prompt.startsWith(DICT_PROMPT_OPTIMIZER)).toBe(true);
    expect(prompt).not.toContain(DICT_REWRITE);
  });

  it("translate runs FIRST, as its own pass, and the shape pass sees the TRANSLATED text", async () => {
    const generateFn = vi
      .fn()
      .mockResolvedValueOnce("translated english")
      .mockResolvedValueOnce("shaped translated");
    const deps = fakeShapeDeps({ generate: generateFn });

    expect(await shapeText(null, "texto original", true, "notes", deps)).toBe("shaped translated");
    expect(promptOf(generateFn.mock.calls[0]).startsWith(DICT_TRANSLATE)).toBe(true);
    expect(promptOf(generateFn.mock.calls[1])).toContain("INPUT TEXT:\ntranslated english");
  });

  it("translate=true with no shape steps returns the translation directly", async () => {
    const generateFn = vi.fn().mockResolvedValue("translated");
    const deps = fakeShapeDeps({ generate: generateFn });
    expect(await shapeText(null, "texto", true, "off", deps)).toBe("translated");
    expect(generateFn).toHaveBeenCalledTimes(1);
  });

  it("an EMPTY translate result keeps the prior text and still runs the shape pass", async () => {
    const generateFn = vi.fn().mockResolvedValueOnce("   ").mockResolvedValueOnce("shaped");
    const deps = fakeShapeDeps({ generate: generateFn });
    expect(await shapeText(null, "original", true, "raw", deps)).toBe("shaped");
    expect(promptOf(generateFn.mock.calls[1])).toContain("INPUT TEXT:\noriginal");
  });

  it("a FAILED translate stops immediately, never shaping the untranslated words", async () => {
    const generateFn = vi.fn().mockRejectedValue(new Error("sidecar down"));
    const deps = fakeShapeDeps({ generate: generateFn });
    await expect(shapeText(null, "texto", true, "notes", deps)).rejects.toThrow("sidecar down");
    expect(generateFn).toHaveBeenCalledTimes(1);
  });

  it("an EMPTY shape result falls back to the prior text — the words are never lost", async () => {
    const deps = fakeShapeDeps({ generate: vi.fn().mockResolvedValue("   ") });
    expect(await shapeText(null, "keep me", false, "raw", deps)).toBe("keep me");
  });

  it("defaultShapeTextDeps wires all five real implementations", () => {
    expect(defaultShapeTextDeps.listModelsRaw).toBeTypeOf("function");
    expect(defaultShapeTextDeps.modelSetting).toBeTypeOf("function");
    expect(defaultShapeTextDeps.runsOnThisMac).toBeTypeOf("function");
    expect(defaultShapeTextDeps.bestLocalDefault).toBeTypeOf("function");
    expect(defaultShapeTextDeps.generate).toBeTypeOf("function");
  });
});

// ============================================================================
// retired dict_* stubs
// ============================================================================

describe("dictation socket bootstrap and retired data IPC", () => {
  it("dict_start resolves the model and returns an authenticated direct socket", async () => {
    await fsp.mkdir(path.dirname(sttModelPath(scratch)), { recursive: true });
    await fsp.writeFile(sttModelPath(scratch), "weights");
    const info = await dictStart(scratch, null, {
      ensureUp: async () => "http://127.0.0.1:8420",
      authToken: () => "tok&en",
    });
    const url = new URL(info.url);
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/dict/session");
    expect(url.searchParams.get("token")).toBe("tok&en");
    expect(url.searchParams.get("modelPath")).toBe(sttModelPath(scratch));
    expect(info).toMatchObject({ stopBaseMs: 120_000, stopPerAudioSecondMs: 2_000 });
  });

  it("dict_start refuses before opening the sidecar when the model is missing", async () => {
    const ensureUp = vi.fn();
    await expect(
      dictStart(scratch, null, { ensureUp, authToken: () => "token" }),
    ).rejects.toThrow("STT_MODEL_MISSING");
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("the three old data/control commands throw the same explaining error", async () => {
    await expect(dictPushAudio(16000, "AAAA")).rejects.toThrow(DICT_RETIRED_REASON);
    await expect(dictStop()).rejects.toThrow(DICT_RETIRED_REASON);
    await expect(dictCancel()).rejects.toThrow(DICT_RETIRED_REASON);
  });

  it("the message names the real, renderer-owned data path", () => {
    expect(DICT_RETIRED_REASON).toContain("WS /dict/session");
    expect(DICT_RETIRED_REASON).toContain("dictStopTimeout.ts");
  });
});

// ============================================================================
// whole-FILE transcription — the scope claim, cross-checked against its owner
// ============================================================================

describe("transcribe_audio is not fabricated here OR anywhere it was handed to", () => {
  it("this module ships no transcribe of any kind", async () => {
    const mod: Record<string, unknown> = await import("./sttTools.js");
    expect(Object.keys(mod).filter((k) => /transcribe/i.test(k))).toEqual([]);
  });

  it("its declared owner REFUSES malformed and empty audio rather than answering ''", async () => {
    // The tempting failure mode for an unported decoder is to hand back an
    // empty transcript, which is indistinguishable from a silent recording and
    // gets stored as the file's extracted text. It must reject instead.
    for (const bytes of [Buffer.alloc(0), Buffer.from("not audio at all"), Buffer.from([0xff, 0x00, 0xff])]) {
      await expect(transcribeAudioNotImplemented(bytes, "m4a", "audio")).rejects.toThrow(
        TRANSCRIBE_AUDIO_NOT_IMPLEMENTED
      );
    }
    // …and for an extension nothing could sniff, and for video.
    await expect(transcribeAudioNotImplemented(Buffer.alloc(0), "", "video")).rejects.toThrow(
      /^NOT_IMPLEMENTED: /
    );
  });
});

// ============================================================================
// registerSttToolsIpc
// ============================================================================

describe("registerSttToolsIpc", () => {
  interface FakeIpc {
    handle: (channel: string, fn: unknown) => void;
    handlers: Map<string, (...a: unknown[]) => unknown>;
    sent: Array<[string, unknown]>;
  }

  function fakeIpcMain(): FakeIpc {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    const event = {
      sender: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
    } as unknown as IpcMainInvokeEvent;
    return {
      handlers,
      sent,
      handle: (channel: string, fn: unknown) => {
        handlers.set(channel, (...args: unknown[]) =>
          (fn as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(event, ...args)
        );
      },
    };
  }

  function register(ipcMain: FakeIpc, over: Partial<Parameters<typeof registerSttToolsIpc>[1]> = {}): void {
    registerSttToolsIpc(ipcMain, {
      userDataDir: scratch,
      resourcesPath: null,
      modelState: new SttModelState(),
      room: { currentRoom: () => null },
      ...over,
    });
  }

  it("registers exactly the nine ipc-contract.ts channels this module owns", () => {
    const ipcMain = fakeIpcMain();
    register(ipcMain);
    expect(new Set(ipcMain.handlers.keys())).toEqual(
      new Set([
        "stt_status",
        "stt_download_model",
        "stt_cancel_download",
        "stt_delete_model",
        "shape_text",
        "dict_start",
        "dict_push_audio",
        "dict_stop",
        "dict_cancel",
      ])
    );
    // No channel is claimed for a command `ipc-contract.ts` does not declare.
    expect(ipcMain.handlers.has("transcribe_audio")).toBe(false);
  });

  it("stt_status reflects the real filesystem through the resolved userDataDir", async () => {
    const ipcMain = fakeIpcMain();
    register(ipcMain);
    expect(await ipcMain.handlers.get("stt_status")!()).toEqual({
      installed: false,
      downloading: false,
      sizeMb: MODEL_SIZE_MB,
    });

    await fsp.mkdir(path.dirname(sttModelPath(scratch)), { recursive: true });
    await fsp.writeFile(sttModelPath(scratch), "weights");
    expect(await ipcMain.handlers.get("stt_status")!()).toMatchObject({ installed: true });
  });

  it("stt_cancel_download and stt_delete_model reach the real shared state / filesystem", async () => {
    const ipcMain = fakeIpcMain();
    const modelState = new SttModelState();
    register(ipcMain, { modelState });

    expect(await ipcMain.handlers.get("stt_cancel_download")!()).toBe(false);
    modelState.downloading = true;
    expect(await ipcMain.handlers.get("stt_cancel_download")!()).toBe(true);
    expect(modelState.cancelRequested).toBe(true);

    await fsp.mkdir(path.dirname(sttModelPath(scratch)), { recursive: true });
    await fsp.writeFile(sttModelPath(scratch), "weights");
    await ipcMain.handlers.get("stt_delete_model")!();
    expect(fs.existsSync(sttModelPath(scratch))).toBe(false);
  });

  it("stt_download_model reports progress on the INVOKING window by default", async () => {
    const body = ggmlBody(4096);
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.write(body.subarray(0, 2048));
      res.end(body.subarray(2048));
    });
    const ipcMain = fakeIpcMain();
    register(ipcMain, {
      downloadDeps: {
        exists: () => false,
        fetchImpl: ((url: string) => fetch(base + new URL(url).pathname)) as unknown as typeof fetch,
      },
    });

    // The real MIN_MODEL_BYTES refuses this small body; the progress events on
    // the way there are what this pins.
    await expect(ipcMain.handlers.get("stt_download_model")!()).rejects.toThrow(NOT_A_MODEL);
    expect(ipcMain.sent.length).toBeGreaterThan(0);
    for (const [channel, payload] of ipcMain.sent) {
      expect(channel).toBe(STT_DOWNLOAD_PROGRESS_CHANNEL);
      expect(payload).toMatchObject({
        got: expect.any(Number),
        total: expect.any(Number),
        percent: expect.any(Number),
      });
    }
  });

  it("an injected onDownloadProgress replaces the window send", async () => {
    const ipcMain = fakeIpcMain();
    const onDownloadProgress = vi.fn();
    register(ipcMain, {
      onDownloadProgress,
      downloadDeps: { exists: () => true, fetchImpl: vi.fn() as unknown as typeof fetch },
    });
    // Already installed: resolves without a transfer, and never touches the window.
    await ipcMain.handlers.get("stt_download_model")!();
    expect(ipcMain.sent).toHaveLength(0);
    expect(onDownloadProgress).not.toHaveBeenCalled();
  });

  it("shape_text passes the currently open room's db through, or null between rooms", async () => {
    const ipcMain = fakeIpcMain();
    const modelSetting = vi.fn().mockReturnValue("room-model");
    const generateFn = vi.fn().mockResolvedValue("shaped");
    const shapeTextDeps = fakeShapeDeps({ modelSetting, generate: generateFn });
    const roomDb = { marker: "room-db" } as unknown as OpenRoom["db"];
    let openRoom: OpenRoom | null = null;
    register(ipcMain, { room: { currentRoom: () => openRoom }, shapeTextDeps });

    await ipcMain.handlers.get("shape_text")!({ text: "hi", translate: false, mode: "raw" });
    expect(modelSetting).not.toHaveBeenCalled();

    openRoom = { db: roomDb, path: "/some/room.room" };
    const result = await ipcMain.handlers.get("shape_text")!({
      text: "hi again",
      translate: false,
      mode: "raw",
    });
    expect(modelSetting).toHaveBeenCalledWith(roomDb);
    expect(result).toBe("shaped");
  });

  it("dict_start provisions the socket while retired data channels reject clearly", async () => {
    const ipcMain = fakeIpcMain();
    await fsp.mkdir(path.dirname(sttModelPath(scratch)), { recursive: true });
    await fsp.writeFile(sttModelPath(scratch), "weights");
    register(ipcMain, {
      dictSessionDeps: {
        ensureUp: async () => "http://127.0.0.1:8420",
        authToken: () => "token",
      },
    });
    await expect(ipcMain.handlers.get("dict_start")!()).resolves.toMatchObject({
      url: expect.stringContaining("/dict/session"),
    });
    await expect(
      ipcMain.handlers.get("dict_push_audio")!({ rate: 16000, dataB64: "AAAA" })
    ).rejects.toThrow(DICT_RETIRED_REASON);
    await expect(ipcMain.handlers.get("dict_stop")!()).rejects.toThrow(DICT_RETIRED_REASON);
    await expect(ipcMain.handlers.get("dict_cancel")!()).rejects.toThrow(DICT_RETIRED_REASON);
  });
});
