/**
 * Tests for `ollamaModels.ts`.
 *
 * Pure logic is driven directly; every network call is driven against a REAL
 * local `node:http` server — never a patched `fetch` — with `ensureUp` (from
 * `sidecar.js`) mocked to point at it, the convention
 * `sidecarJsonCancellable.test.ts`/`engineRouting.test.ts` already establish.
 * No real sidecar process and no real Ollama daemon is ever touched.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { CancelFlag, cancelId, createCancelState } from "./cancel.js";
import { ensureUp } from "./sidecar.js";
import {
  AI_STATUS_DETECTION_NOT_IMPLEMENTED,
  aiStatus,
  bestLocalDefault,
  chatModelSeesImages,
  defaultAiStatusDeps,
  deleteModel,
  groundingModelForRoom,
  groundingPick,
  HIGH_RAM_THRESHOLD_BYTES,
  KEEP_ALIVE_SHORT,
  KEEP_ALIVE_WARM,
  modelCapabilities,
  ollamaCapabilities,
  ollamaNativeContextLength,
  openOllama,
  openOllamaFailure,
  PULL_CANCELLED,
  PULL_PROGRESS_STEP,
  pullCancelKey,
  pullCancellable,
  pullCancellableAt,
  pullModel,
  pullProgressShouldEmit,
  probeOllamaModelSelection,
  registerOllamaModelsIpc,
  registryName,
  resetTotalRamCacheForTests,
  totalRamBytes,
  visionKeepAlive,
  warm,
  warmModel,
  type GroundingPickDeps,
  type OpenOllamaProcess,
  type OpenOllamaSpawnFn,
  type PullOutcome,
} from "./ollamaModels.js";
import type { VisionSupportDeps } from "./capabilities.js";

// --------------------------------------------------------- test HTTP server

let server: http.Server | undefined;

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A base URL nothing is listening on: a real ephemeral port that WAS bound and
 * is now closed, so a connection is genuinely REFUSED. (Port 1 would not do —
 * `fetch` rejects a forbidden port before any connection is attempted, so it
 * never reaches the `ECONNREFUSED` check under test.) */
async function deadBaseUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** Serve `handler` AND point the mocked `ensureUp` at it. */
async function sidecarAt(handler: http.RequestListener): Promise<string> {
  const base = await listenOn(handler);
  vi.mocked(ensureUp).mockResolvedValue(base);
  return base;
}

function jsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => resolve(raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)));
  });
}

function ndjson(lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

afterEach(async () => {
  vi.mocked(ensureUp).mockReset();
  if (server !== undefined) {
    const s = server;
    server = undefined;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

// ================================================================ pure logic

describe("bestLocalDefault", () => {
  it("skips cloud, embedding and external models, landing on the local chat model", () => {
    // The failing QA env: a cloud model + embeddings + a local chat model.
    expect(bestLocalDefault(["minimax-m3:cloud", "nomic-embed-text:latest", "qwen3.5:9b"])).toBe("qwen3.5:9b");
  });

  it("names the bare default when nothing local and chat-capable is installed", () => {
    expect(bestLocalDefault([])).toBe("qwen3.5:4b");
    expect(bestLocalDefault(["nomic-embed-text:latest"])).toBe("qwen3.5:4b");
    expect(bestLocalDefault(["minimax-m3:cloud", "nomic-embed-text:latest"])).toBe("qwen3.5:4b");
  });

  it("picks the INSTALLED build, never the bare constant (the MLX bug)", () => {
    // Live QA saw this as the privacy scan failing on all 20 files: the scan's
    // own model is exactly this fallback, and `qwen3.5:4b` does not exist on a
    // Mac holding only `qwen3.5:4b-mlx`.
    expect(bestLocalDefault(["qwen3.5:4b-mlx", "nomic-embed-text:latest"])).toBe("qwen3.5:4b-mlx");
  });

  it("prefers an exact match over a variant, whatever order Ollama lists them", () => {
    expect(bestLocalDefault(["qwen3.5:4b-mlx", "qwen3.5:4b", "qwen3.5:4b-q4_K_M"])).toBe("qwen3.5:4b");
  });
});

describe("visionKeepAlive", () => {
  const gb = 1024 * 1024 * 1024;

  it("releases a distinct vision model quickly on a 16 GB Mac", () => {
    expect(visionKeepAlive(16 * gb, "qwen2.5vl", "qwen3.5:4b")).toBe(KEEP_ALIVE_SHORT);
  });

  it("stays warm when the vision model IS the chat model, even on 16 GB", () => {
    expect(visionKeepAlive(16 * gb, "qwen3.5:4b", "qwen3.5:4b")).toBe(KEEP_ALIVE_WARM);
  });

  it("a 32 GB+ Mac keeps a distinct vision model warm too", () => {
    expect(visionKeepAlive(32 * gb, "qwen2.5vl", "qwen3.5:4b")).toBe(KEEP_ALIVE_WARM);
    expect(visionKeepAlive(64 * gb, "qwen2.5vl", "qwen3.5:4b")).toBe(KEEP_ALIVE_WARM);
    expect(HIGH_RAM_THRESHOLD_BYTES).toBe(32 * gb);
  });
});

describe("totalRamBytes", () => {
  it("reads a real, positive byte count and caches it", () => {
    resetTotalRamCacheForTests();
    const first = totalRamBytes();
    expect(first).toBeGreaterThan(0);
    expect(totalRamBytes()).toBe(first);
  });
});

describe("registryName", () => {
  it("lowercases a bare name:tag — ollama.com is lowercase throughout", () => {
    // A STRAY CAPITAL USED TO BRICK A HOSTED MODEL FOREVER: /api/chat strips
    // `-cloud` and proxies the rest verbatim, so `Gpt-oss:120b-cloud` answered
    // `model 'Gpt-oss:120b' not found` on every request.
    expect(registryName("  Gpt-oss:120b-cloud ")).toBe("gpt-oss:120b-cloud");
    expect(registryName("Qwen3.5:4B")).toBe("qwen3.5:4b");
    expect(registryName("qwen3.5:4b")).toBe("qwen3.5:4b");
  });

  it("leaves a hosted/namespaced name's casing alone — that registry is case-SENSITIVE", () => {
    expect(registryName("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF")).toBe(
      "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF"
    );
    expect(registryName("  library/Gemma3  ")).toBe("library/Gemma3");
  });
});

describe("pullCancelKey", () => {
  it("is derivable from the model name alone, and distinct per model", () => {
    // The Stop button rebuilds this string rather than being handed it.
    expect(pullCancelKey("qwen2.5vl")).toBe("pull:qwen2.5vl");
    expect(pullCancelKey("qwen2.5vl:7b")).toBe("pull:qwen2.5vl:7b");
    expect(pullCancelKey("a")).not.toBe(pullCancelKey("b"));
  });
});

describe("openOllamaFailure", () => {
  it("names open's own reason plus the command-line-install escape hatch", () => {
    const msg = openOllamaFailure(Buffer.from("Unable to find application named 'Ollama'\n"));
    expect(msg).toContain("Unable to find application named 'Ollama'");
    expect(msg).toContain("ollama serve");
  });

  it("still says something, and still names the escape hatch, with no reason at all", () => {
    const msg = openOllamaFailure(Buffer.alloc(0));
    expect(msg.startsWith("Couldn't open the Ollama app.")).toBe(true);
    expect(msg).toContain("ollama serve");
  });

  it("truncates a long stderr at 200 code points, never mid-character", () => {
    expect(openOllamaFailure("x".repeat(500))).toContain("x".repeat(200));
    expect(openOllamaFailure("x".repeat(500))).not.toContain("x".repeat(201));
    // Astral characters are whole code points, not UTF-16 units.
    const emoji = openOllamaFailure("🙂".repeat(300));
    expect([...emoji].filter((c) => c === "🙂")).toHaveLength(200);
  });
});

describe("pullProgressShouldEmit", () => {
  it("always emits the first percentage value", () => {
    expect(pullProgressShouldEmit("downloading", 3, "downloading", null)).toBe(true);
  });

  it("emits on a phase change even with no percentage at all", () => {
    expect(pullProgressShouldEmit("verifying", null, "downloading", 50)).toBe(true);
  });

  it("suppresses a same-phase update that moved less than the step", () => {
    expect(pullProgressShouldEmit("downloading", 50.2, "downloading", 50)).toBe(false);
  });

  it("emits once the step threshold is crossed", () => {
    expect(pullProgressShouldEmit("downloading", 50 + PULL_PROGRESS_STEP, "downloading", 50)).toBe(true);
  });

  it("always emits on reaching 100, whatever the last value was", () => {
    expect(pullProgressShouldEmit("downloading", 100, "downloading", 99.9)).toBe(true);
  });

  it("a percentage-less line never counts as movement on its own", () => {
    expect(pullProgressShouldEmit("downloading", null, "downloading", 50)).toBe(false);
  });
});

// ============================================================ vision/grounding

/** Capability answers keyed by model name. A `Map`, never an object literal:
 * the key is a MODEL NAME, i.e. room-controlled, and `caps["__proto__"]` on a
 * plain `{}` is a real bug this codebase has already been bitten by twice. */
function fakeVisionDeps(vision: Map<string, string[]>): VisionSupportDeps {
  return {
    ollamaCapabilities: async (model: string) => vision.get(model) ?? [],
    ensureProviderCatalog: async () => {},
    providerModelVision: () => undefined,
  };
}

function pickDeps(vision: Map<string, string[]>, doorActive: boolean): GroundingPickDeps {
  return { ...fakeVisionDeps(vision), privacyDoorActive: () => doorActive };
}

describe("chatModelSeesImages", () => {
  it("is true only when the engine actually reports vision", async () => {
    const deps = fakeVisionDeps(new Map([["qwen2.5vl", ["vision"]]]));
    expect(await chatModelSeesImages("qwen2.5vl", deps)).toBe(true);
    expect(await chatModelSeesImages("qwen3.5:4b", deps)).toBe(false);
  });

  it("an embedding model never sees, whatever it is called", async () => {
    const deps = fakeVisionDeps(new Map([["nomic-embed-text:latest", ["vision"]]]));
    expect(await chatModelSeesImages("nomic-embed-text:latest", deps)).toBe(false);
  });

  it("cloud CLI image channels answer per engine, catalog-free", async () => {
    const deps = fakeVisionDeps(new Map());
    // Claude and Codex gained real pixel channels (stream-json blocks / -i
    // files, both live-verified); Antigravity's print mode still has none.
    expect(await chatModelSeesImages("claude-cli", deps)).toBe(true);
    expect(await chatModelSeesImages("codex-cli::some-model::high", deps)).toBe(true);
    expect(await chatModelSeesImages("antigravity-cli::gemini-3.7-flash-high", deps)).toBe(false);
  });
});

describe("groundingPick", () => {
  it("prefers the room's own chat model when it can see and pixels reach it", async () => {
    const deps = pickDeps(new Map([["qwen2.5vl", ["vision"]]]), false);
    expect(await groundingPick(["qwen2.5vl", "qwen3.5:4b"], "qwen2.5vl", deps)).toBe("qwen2.5vl");
  });

  it("falls through to another installed model when the chat model cannot see", async () => {
    const deps = pickDeps(new Map([["qwen2.5vl", ["vision"]]]), false);
    expect(await groundingPick(["qwen3.5:4b", "qwen2.5vl"], "qwen3.5:4b", deps)).toBe("qwen2.5vl");
  });

  it("is null when nothing installed can see, rather than a name we hope is multimodal", async () => {
    expect(await groundingPick([], "antigravity-cli", pickDeps(new Map(), false))).toBeNull();
  });

  it("a CLI room's own engine wins the grounding pick when the door is open", async () => {
    expect(await groundingPick([], "claude-cli", pickDeps(new Map(), false))).toBe("claude-cli");
  });

  it("a capable cloud model is NOT picked when the privacy door would blind it", async () => {
    // The door strips images out of a non-local request and only COUNTS them,
    // so such a pick answers with no boxes and the viewer renders that as
    // "could not locate that in this image" — a false claim about the photo.
    const deps = pickDeps(new Map([["openrouter::vendor/sees", ["vision"]]]), true);
    expect(await groundingPick([], "openrouter::vendor/sees", deps)).toBeNull();
  });
});

describe("groundingModelForRoom", () => {
  it("resolves the chat model from bestDefault when the room has no explicit setting", async () => {
    const deps = {
      ...pickDeps(new Map([["qwen3.5:4b", ["vision"]]]), false),
      listModels: async () => ["qwen3.5:4b"],
    };
    expect(await groundingModelForRoom(null, deps)).toBe("qwen3.5:4b");
  });

  it("honours an explicit room model setting", async () => {
    const deps = {
      ...pickDeps(new Map([["qwen2.5vl", ["vision"]]]), false),
      listModels: async () => ["qwen3.5:9b", "qwen2.5vl"],
    };
    expect(await groundingModelForRoom("qwen3.5:9b", deps)).toBe("qwen2.5vl");
  });
});

// ======================================================== sidecar metadata

describe("ollamaCapabilities", () => {
  it("parses the capabilities array out of a real response", async () => {
    let seen: Record<string, unknown> = {};
    await sidecarAt(async (req, res) => {
      seen = await jsonBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ capabilities: ["completion", "vision", "tools"] }));
    });
    expect(await ollamaCapabilities("qwen2.5vl")).toEqual(["completion", "vision", "tools"]);
    expect(seen.model).toBe("qwen2.5vl");
  });

  it("is empty on a non-2xx response, never a thrown error", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "OLLAMA_DOWN", error: "down" }));
    });
    await expect(ollamaCapabilities("qwen2.5vl")).resolves.toEqual([]);
  });

  it("is empty when the sidecar itself cannot be reached", async () => {
    vi.mocked(ensureUp).mockRejectedValue(new Error("no bundled binary"));
    await expect(ollamaCapabilities("qwen2.5vl")).resolves.toEqual([]);
  });

  it("is empty on a malformed capabilities field", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ capabilities: "not-an-array" }));
    });
    await expect(ollamaCapabilities("qwen2.5vl")).resolves.toEqual([]);
  });
});

describe("probeOllamaModelSelection", () => {
  it("uses the strict probe route and accepts a validated exact ID", async () => {
    let requestPath = "";
    let seen: Record<string, unknown> = {};
    await sidecarAt(async (req, res) => {
      requestPath = req.url ?? "";
      seen = await jsonBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ capabilities: [] }));
    });

    await expect(probeOllamaModelSelection("gpt-oss:120b-cloud")).resolves.toEqual({
      ok: true,
      detail: null,
    });
    expect(requestPath).toBe("/probe_model");
    expect(seen.model).toBe("gpt-oss:120b-cloud");
  });

  it("rejects MODEL_MISSING instead of accepting empty badge capabilities", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "MODEL_MISSING", error: "not found" }));
    });

    await expect(probeOllamaModelSelection("Gpt-oss:120b-cloud")).resolves.toEqual({
      ok: false,
      detail: "MODEL_MISSING:Gpt-oss:120b-cloud",
    });
  });

  it("rejects provider errors with their classified detail", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "ENGINE_ERROR", error: "cloud relay unavailable" }));
    });

    const result = await probeOllamaModelSelection("gpt-oss:120b-cloud");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("cloud relay unavailable");
  });
});

describe("ollamaNativeContextLength", () => {
  it("returns the model's real advertised context length", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ context_length: 32768 }));
    });
    expect(await ollamaNativeContextLength("qwen3.5:4b")).toBe(32768);
  });

  it("is null on failure — unknown, never zero", async () => {
    vi.mocked(ensureUp).mockRejectedValue(new Error("down"));
    expect(await ollamaNativeContextLength("qwen3.5:4b")).toBeNull();
  });

  it("is null on a negative or fractional value (Rust reads it as u64)", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ context_length: -1 }));
    });
    expect(await ollamaNativeContextLength("qwen3.5:4b")).toBeNull();
  });
});

describe("modelCapabilities", () => {
  it("badges each installed model, in list order", async () => {
    const caps = new Map([
      ["qwen3.5:9b", ["completion", "tools"]],
      ["qwen2.5vl", ["completion", "vision"]],
    ]);
    const out = await modelCapabilities({
      listModels: async () => ["qwen3.5:9b", "qwen2.5vl"],
      ollamaCapabilities: async (m) => caps.get(m) ?? [],
    });
    expect(out).toEqual([
      { name: "qwen3.5:9b", tools: true, vision: false },
      { name: "qwen2.5vl", tools: false, vision: true },
    ]);
  });

  it("an unreachable engine yields an empty list, not an error", async () => {
    await expect(
      modelCapabilities({ listModels: async () => [], ollamaCapabilities: async () => [] })
    ).resolves.toEqual([]);
  });
});

describe("deleteModel", () => {
  it("resolves silently on a successful sidecar delete", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await expect(deleteModel("qwen3.5:9b")).resolves.toBeUndefined();
  });

  it("rebuilds the MODEL_MISSING sentinel from a classified error body", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "MODEL_MISSING", error: "not pulled" }));
    });
    await expect(deleteModel("qwen3.5:9b")).rejects.toThrow("MODEL_MISSING:qwen3.5:9b");
  });

  it("a refused connection surfaces as OLLAMA_DOWN, not a raw network error", async () => {
    vi.mocked(ensureUp).mockResolvedValue(await deadBaseUrl());
    await expect(deleteModel("qwen3.5:9b")).rejects.toThrow("OLLAMA_DOWN");
  });
});

describe("warm", () => {
  it("posts the warm keep_alive and resolves on success", async () => {
    let seen: Record<string, unknown> = {};
    await sidecarAt(async (req, res) => {
      seen = await jsonBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await expect(warm("qwen3.5:9b")).resolves.toBeUndefined();
    expect(seen).toMatchObject({ model: "qwen3.5:9b", keep_alive: KEEP_ALIVE_WARM });
  });

  it("surfaces OLLAMA_DOWN straight through", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "OLLAMA_DOWN", error: "connection refused" }));
    });
    await expect(warm("qwen3.5:9b")).rejects.toThrow("OLLAMA_DOWN");
  });
});

// ==================================================================== warm_model

describe("warmModel", () => {
  it("warms the room's explicit model", async () => {
    const warmed: string[] = [];
    await warmModel("qwen3.5:9b", {
      listModels: async () => ["qwen3.5:9b"],
      warm: async (m) => void warmed.push(m),
    });
    expect(warmed).toEqual(["qwen3.5:9b"]);
  });

  it("warms ONE model — the installed default — for a room on an external engine", async () => {
    const warmed: string[] = [];
    await warmModel("claude-cli", {
      listModels: async () => ["qwen3.5:4b"],
      warm: async (m) => void warmed.push(m),
    });
    expect(warmed).toEqual(["qwen3.5:4b"]);
  });

  it("does nothing at all when the room is external and nothing is installed", async () => {
    const warmed: string[] = [];
    await warmModel("claude-cli", { listModels: async () => [], warm: async (m) => void warmed.push(m) });
    expect(warmed).toEqual([]);
  });
});

// ======================================================================= ai_status

const workingAiStatusDeps = {
  detectedExternal: async () => [] as string[],
  ollamaInstalled: async () => true,
  providerConnected: () => false,
  ollamaRunsHere: () => true,
  listModelsRaw: async () => ["qwen3.5:9b"],
};

describe("aiStatus", () => {
  it("rejects with an honest NOT_IMPLEMENTED on the un-injected default deps", async () => {
    await expect(aiStatus(null, defaultAiStatusDeps)).rejects.toThrow(AI_STATUS_DETECTION_NOT_IMPLEMENTED);
  });

  it("reports running/installed and the resolved default model on success", async () => {
    const status = await aiStatus(null, { ...workingAiStatusDeps, detectedExternal: async () => ["claude-cli"] });
    expect(status).toEqual({
      running: true,
      installed: true,
      models: ["qwen3.5:9b"],
      defaultModel: "qwen3.5:9b",
      external: ["claude-cli"],
      remoteRelay: false,
    });
  });

  it("honours an explicit room model over bestDefault", async () => {
    const status = await aiStatus("qwen2.5vl", {
      ...workingAiStatusDeps,
      listModelsRaw: async () => ["qwen3.5:9b", "qwen2.5vl"],
    });
    expect(status.defaultModel).toBe("qwen2.5vl");
  });

  it("appends openrouter to the detected engines when connected, without mutating the cached probe", async () => {
    const cached = ["codex-cli"];
    const status = await aiStatus(null, {
      ...workingAiStatusDeps,
      detectedExternal: async () => cached,
      providerConnected: (p) => p === "openrouter",
    });
    expect(status.external).toEqual(["codex-cli", "openrouter"]);
    // The session cache belongs to the caller: appending must not grow it.
    expect(cached).toEqual(["codex-cli"]);
  });

  it("reports NOT running (installed/external still filled) when the model list fails", async () => {
    const status = await aiStatus(null, {
      ...workingAiStatusDeps,
      ollamaRunsHere: () => false,
      listModelsRaw: async () => {
        throw new Error("OLLAMA_DOWN");
      },
    });
    expect(status).toEqual({
      running: false,
      installed: true,
      models: [],
      defaultModel: "qwen3.5:4b",
      external: [],
      remoteRelay: true,
    });
  });
});

// =============================================================== pullCancellable

describe("pullCancellableAt", () => {
  it("streams progress lines and reports ok at the end of the stream", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(
        ndjson([
          { status: "pulling manifest" },
          { status: "downloading", completed: 50, total: 100 },
          { status: "success" },
        ])
      );
    });
    const events: Array<[string, number | null]> = [];
    const outcome = await pullCancellableAt(base, "qwen2.5vl", new CancelFlag(), (s, p) => events.push([s, p]));
    expect(outcome).toEqual({ kind: "ok" });
    expect(events).toEqual([
      ["pulling manifest", null],
      ["downloading", 50],
      ["success", null],
    ]);
  });

  it("sends the model name it was given in the request body", async () => {
    let seen: Record<string, unknown> = {};
    const base = await listenOn(async (req, res) => {
      seen = await jsonBody(req);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(ndjson([{ status: "success" }]));
    });
    await pullCancellableAt(base, "qwen3.5:4b", new CancelFlag(), () => {});
    expect(seen.model).toBe("qwen3.5:4b");
  });

  it("an already-cancelled pull never touches the network", async () => {
    let hit = false;
    const base = await listenOn((_req, res) => {
      hit = true;
      res.end();
    });
    const cancel = new CancelFlag();
    cancel.store(true);
    expect(await pullCancellableAt(base, "qwen2.5vl", cancel, () => {})).toEqual({ kind: "cancelled" });
    expect(hit).toBe(false);
  });

  it("classifies a coded error line as OLLAMA_DOWN", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(ndjson([{ status: "pulling manifest" }, { error: "down", code: "OLLAMA_DOWN" }]));
    });
    expect(await pullCancellableAt(base, "qwen2.5vl", new CancelFlag(), () => {})).toEqual({
      kind: "error",
      message: "OLLAMA_DOWN",
    });
  });

  it("re-tags a MODEL_MISSING error line with the model name", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(ndjson([{ error: "not found", code: "MODEL_MISSING" }]));
    });
    expect(await pullCancellableAt(base, "qwen2.5vl", new CancelFlag(), () => {})).toEqual({
      kind: "error",
      message: "MODEL_MISSING:qwen2.5vl",
    });
  });

  it("passes an uncoded error line through verbatim", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(ndjson([{ error: "disk full" }]));
    });
    expect(await pullCancellableAt(base, "qwen2.5vl", new CancelFlag(), () => {})).toEqual({
      kind: "error",
      message: "disk full",
    });
  });

  it("skips a malformed line rather than aborting the whole download", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end('{"status":"pulling manifest"}\nnot json at all\n{"status":"success"}\n');
    });
    const events: string[] = [];
    const outcome = await pullCancellableAt(base, "qwen2.5vl", new CancelFlag(), (s) => events.push(s));
    expect(outcome).toEqual({ kind: "ok" });
    expect(events).toEqual(["pulling manifest", "success"]);
  });

  it("a non-2xx initial response is a plain 'Download failed', not a classified sentinel", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("model not found on registry");
    });
    expect(await pullCancellableAt(base, "qwen2.5vl", new CancelFlag(), () => {})).toEqual({
      kind: "error",
      message: "Download failed: model not found on registry",
    });
  });

  it("surfaces a refused connection as OLLAMA_DOWN", async () => {
    const outcome = await pullCancellableAt(await deadBaseUrl(), "qwen2.5vl", new CancelFlag(), () => {});
    expect(outcome).toEqual({ kind: "error", message: "OLLAMA_DOWN" });
  });

  it("a connection that BREAKS mid-stream is 'Download interrupted', not a raw rejection", async () => {
    // Rust: `c.map_err(|e| format!("Download interrupted: {e}"))?`. Both
    // candidate ports let the rejected read escape the outcome contract
    // entirely — the caller got a thrown network error instead of an outcome,
    // so a Stop-aware caller could not tell this from anything else.
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson", "transfer-encoding": "chunked" });
      res.write(JSON.stringify({ status: "downloading", completed: 1, total: 100 }) + "\n");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const outcome = await pullCancellableAt(base, "qwen2.5vl", new CancelFlag(), () => {});
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message.startsWith("Download interrupted: ")).toBe(true);
    }
  });

  it("a flipped cancel flag stops a quiet download promptly", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      // Then never closes on its own: only the cancel can end this.
    });
    const cancel = new CancelFlag();
    const started = Date.now();
    const promise = pullCancellableAt(base, "qwen2.5vl", cancel, () => {});
    setTimeout(() => cancel.store(true), 30);
    expect(await promise).toEqual({ kind: "cancelled" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a stalled download is reported rather than left hanging", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      // Then goes quiet forever (within this test's lifetime).
    });
    const outcome = await pullCancellableAt(base, "qwen2.5vl", new CancelFlag(), () => {}, 100);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("stopped receiving data");
    }
  });
});

describe("pullCancellable (the ensureUp wrapper)", () => {
  it("resolves the sidecar base itself and streams through", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(ndjson([{ status: "success" }]));
    });
    const events: string[] = [];
    expect(await pullCancellable("qwen2.5vl", new CancelFlag(), (s) => events.push(s))).toEqual({ kind: "ok" });
    expect(events).toEqual(["success"]);
  });

  it("an already-cancelled pull does not even start the sidecar", async () => {
    const cancel = new CancelFlag();
    cancel.store(true);
    expect(await pullCancellable("qwen2.5vl", cancel, () => {})).toEqual({ kind: "cancelled" });
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("a sidecar that will not start is an error outcome, never a throw", async () => {
    vi.mocked(ensureUp).mockRejectedValue(new Error("no bundled binary"));
    expect(await pullCancellable("qwen2.5vl", new CancelFlag(), () => {})).toEqual({
      kind: "error",
      message: "no bundled binary",
    });
  });
});

// ========================================================================= pullModel

describe("pullModel", () => {
  it("registers, then cleans up, the pull:<name> cancel key", async () => {
    const state = createCancelState();
    let registeredDuringCall = false;
    const outcome = await pullModel(state, "qwen2.5vl", () => {}, {
      pullCancellable: async (_m, _c, onProgress) => {
        registeredDuringCall = state.cancels.has(pullCancelKey("qwen2.5vl"));
        onProgress("downloading", 10);
        return { kind: "ok" };
      },
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(registeredDuringCall).toBe(true);
    expect(state.cancels.has(pullCancelKey("qwen2.5vl"))).toBe(false);
  });

  it("normalises the name for the registry but files the cancel key under what was typed", async () => {
    const state = createCancelState();
    let seenModel = "";
    let keyDuringCall = "";
    await pullModel(state, "Qwen3.5:4B", () => {}, {
      pullCancellable: async (m) => {
        seenModel = m;
        keyDuringCall = [...state.cancels.keys()][0] ?? "";
        return { kind: "ok" };
      },
    });
    expect(seenModel).toBe("qwen3.5:4b");
    expect(keyDuringCall).toBe("pull:Qwen3.5:4B");
  });

  it("removes the cancel key even when the pull errors", async () => {
    const state = createCancelState();
    await pullModel(state, "qwen2.5vl", () => {}, {
      pullCancellable: async (): Promise<PullOutcome> => ({ kind: "error", message: "boom" }),
    });
    expect(state.cancels.has(pullCancelKey("qwen2.5vl"))).toBe(false);
  });

  it("throttles progress: only phase changes and >= 0.5% moves reach the caller", async () => {
    const state = createCancelState();
    const events: Array<[string, number | null]> = [];
    await pullModel(state, "m", (s, p) => events.push([s, p]), {
      pullCancellable: async (_m, _c, onProgress) => {
        onProgress("downloading", 10);
        onProgress("downloading", 10.1); // suppressed: moved < 0.5
        onProgress("downloading", 10.6); // emitted: crossed the step
        onProgress("verifying", 10.6); // emitted: phase changed
        onProgress("verifying", 100); // emitted: reached 100
        return { kind: "ok" };
      },
    });
    expect(events).toEqual([
      ["downloading", 10],
      ["downloading", 10.6],
      ["verifying", 10.6],
      ["verifying", 100],
    ]);
  });

  it("a Stop delivered through the SHARED cancel registry stops a real download", async () => {
    // Exactly what the frontend does: `cancelAsk('pull:' + <the name it asked
    // with>)`, through cancel.ts's own by-id entry point — not a local flag.
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
    });
    const state = createCancelState();
    const promise = pullModel(state, "qwen2.5vl", () => {});
    await new Promise((r) => setTimeout(r, 20));
    const report = cancelId(state, pullCancelKey("qwen2.5vl"));
    expect(report.known).toBe(true);
    expect(await promise).toEqual({ kind: "cancelled" });
  });
});

// ========================================================================= openOllama

function fakeChild(): {
  proc: OpenOllamaProcess;
  emitError: (e: Error) => void;
  emitClose: (c: number | null) => void;
  emitStderr: (s: string) => void;
} {
  const listeners: { error?: (e: Error) => void; close?: (c: number | null) => void } = {};
  const stderrListeners: { data?: (c: Buffer) => void } = {};
  const proc: OpenOllamaProcess = {
    stderr: {
      on: (event: string, cb: (chunk: Buffer) => void) => {
        if (event === "data") stderrListeners.data = cb;
        return proc.stderr;
      },
    } as unknown as NodeJS.ReadableStream,
    once: ((event: string, cb: (...args: never[]) => void) => {
      if (event === "error") listeners.error = cb as unknown as (e: Error) => void;
      if (event === "close") listeners.close = cb as unknown as (c: number | null) => void;
      return proc;
    }) as OpenOllamaProcess["once"],
  };
  return {
    proc,
    emitError: (e) => listeners.error?.(e),
    emitClose: (c) => listeners.close?.(c),
    emitStderr: (s) => stderrListeners.data?.(Buffer.from(s)),
  };
}

describe("openOllama", () => {
  it("resolves when `open` exits 0", async () => {
    const { proc, emitClose } = fakeChild();
    const spawnFn: OpenOllamaSpawnFn = () => proc;
    const promise = openOllama(spawnFn);
    emitClose(0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with open's own reason on a non-zero exit, rather than reporting success", async () => {
    const { proc, emitStderr, emitClose } = fakeChild();
    const promise = openOllama(() => proc);
    emitStderr("Unable to find application named 'Ollama'\n");
    emitClose(1);
    await expect(promise).rejects.toThrow(/Unable to find application named 'Ollama'[\s\S]*ollama serve/);
  });

  it("a signal-killed `open` (null exit code) is a failure, not a launch", async () => {
    const { proc, emitClose } = fakeChild();
    const promise = openOllama(() => proc);
    emitClose(null);
    await expect(promise).rejects.toThrow("Couldn't open the Ollama app.");
  });

  it("rejects distinctly when `open` itself could not be spawned", async () => {
    const { proc, emitError } = fakeChild();
    const promise = openOllama(() => proc);
    emitError(new Error("ENOENT"));
    await expect(promise).rejects.toThrow("Could not open Ollama: ENOENT");
  });

  it("a synchronous spawn failure is still a rejection, not a crash", async () => {
    await expect(
      openOllama(() => {
        throw new Error("spawn open EPERM");
      })
    ).rejects.toThrow("Could not open Ollama: spawn open EPERM");
  });
});

// =============================================================================== IPC

describe("registerOllamaModelsIpc", () => {
  const RUST_COMMANDS = [
    "ai_status",
    "model_capabilities",
    "grounding_model_for_room",
    "open_ollama",
    "warm_model",
    "delete_model",
    "pull_model",
  ];

  function register(overrides: Partial<Parameters<typeof registerOllamaModelsIpc>[1]> = {}) {
    const handle = vi.fn();
    const state = createCancelState();
    registerOllamaModelsIpc(
      { handle },
      { cancelState: state, explicitModel: () => null, ...overrides }
    );
    const listener = (channel: string) =>
      handle.mock.calls.find((c) => c[0] === channel)![1] as (event: unknown, args?: unknown) => Promise<unknown>;
    return { handle, state, listener };
  }

  it("registers exactly the seven Rust command names, so no renderer rename is needed", () => {
    const { handle } = register();
    expect(handle.mock.calls.map((c) => c[0] as string).sort()).toEqual([...RUST_COMMANDS].sort());
  });

  it("delete_model forwards the { name } argument object src/api.ts already sends", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "MODEL_MISSING", error: "not pulled" }));
    });
    const { listener } = register();
    await expect(listener("delete_model")({}, { name: "qwen3.5:9b" })).rejects.toThrow("MODEL_MISSING:qwen3.5:9b");
  });

  it("warm_model reads the room's explicit model through the injected resolver", async () => {
    const warmed: string[] = [];
    const { listener } = register({
      explicitModel: () => "qwen3.5:9b",
      warmModelDeps: { listModels: async () => ["qwen3.5:9b"], warm: async (m) => void warmed.push(m) },
    });
    await listener("warm_model")({});
    expect(warmed).toEqual(["qwen3.5:9b"]);
  });

  it("pull_model streams throttled progress to the invoking window and resolves on success", async () => {
    const sent: unknown[] = [];
    const { listener } = register({
      pullModelDeps: {
        pullCancellable: async (_m, _c, onProgress) => {
          onProgress("downloading", 10);
          onProgress("downloading", 10.1); // throttled away
          onProgress("success", null);
          return { kind: "ok" };
        },
      },
    });
    const event = { sender: { send: (_c: string, payload: unknown) => sent.push(payload) } };
    await expect(listener("pull_model")(event, { name: "qwen2.5vl" })).resolves.toBeUndefined();
    expect(sent).toEqual([
      { status: "downloading", percent: 10 },
      { status: "success", percent: null },
    ]);
  });

  it("pull_model rejects with the exact PULL_CANCELLED sentence a Stop produces", async () => {
    // The wire contract every "start a pull" surface already reads as
    // "stopped" rather than as an error — unchanged by this port's internal
    // PullOutcome classification.
    const { listener } = register({
      pullModelDeps: { pullCancellable: async (): Promise<PullOutcome> => ({ kind: "cancelled" }) },
    });
    await expect(listener("pull_model")({ sender: { send: () => {} } }, { name: "qwen2.5vl" })).rejects.toThrow(
      PULL_CANCELLED
    );
  });

  it("pull_model rejects with a genuine failure's own message", async () => {
    const { listener } = register({
      pullModelDeps: {
        pullCancellable: async (): Promise<PullOutcome> => ({ kind: "error", message: "MODEL_MISSING:qwen2.5vl" }),
      },
    });
    await expect(listener("pull_model")({ sender: { send: () => {} } }, { name: "qwen2.5vl" })).rejects.toThrow(
      "MODEL_MISSING:qwen2.5vl"
    );
  });

  it("ai_status surfaces the honest NOT_IMPLEMENTED refusal rather than a fabricated status", async () => {
    const { listener } = register();
    await expect(listener("ai_status")({})).rejects.toThrow(AI_STATUS_DETECTION_NOT_IMPLEMENTED);
  });
});
