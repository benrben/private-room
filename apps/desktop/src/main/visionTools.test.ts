/**
 * Tests for `visionTools.ts` — `commands/vision.rs`'s port.
 *
 * Pure logic (`groundingPrompt`, `boxesSchema`, `parseBoxes`/`boxesFromItems`,
 * `visionKeepAlive`, `groundingPick`) is driven directly, mirroring the exact
 * cases `vision.rs`'s own `#[cfg(test)] mod tests` and `models.rs`'s own
 * grounding/keep-alive tests pin. `prepareImage` is exercised against REAL
 * `sharp`-generated image bytes — never a mocked decoder. Every
 * network-carrying call (`groundPreparedImage`, `locateInImage`) runs against
 * a REAL local `node:http` server with `ensureUp` (from `sidecar.js`) mocked
 * to point at it — the convention `ollamaGenerate.test.ts`/
 * `sidecarJsonCancellable.test.ts` already establish — never a patched
 * `fetch`, never a call that always succeeds by construction.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { CancelFlag } from "./cancel.js";
import type { CapabilitiesForDeps, VisionSupportDeps } from "./capabilities.js";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import { setSetting } from "./db-host/settings.js";
import { resetBaseUrlOverrideForTests } from "./engineRouting.js";
import { clearPolicy, setActivePolicyForTests } from "./privacy.js";
import { ensureUp } from "./sidecar.js";
import type { SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import {
  boxesFromItems,
  boxesSchema,
  groundingPick,
  groundingPrompt,
  groundPreparedImage,
  HIGH_RAM_THRESHOLD_BYTES,
  KEEP_ALIVE_SHORT,
  KEEP_ALIVE_WARM,
  locateInImage,
  NO_VISION_MODEL,
  parseBoxes,
  prepareImage,
  registerVisionIpc,
  totalRamBytes,
  visionKeepAlive,
  VISION_SQUARE,
  type GroundingPickDeps,
  type LocateInImageDeps,
} from "./visionTools.js";

// --------------------------------------------------------- test HTTP server

let server: http.Server | undefined;

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function sidecarAt(handler: http.RequestListener): Promise<string> {
  const base = await listenOn(handler);
  vi.mocked(ensureUp).mockResolvedValue(base);
  return base;
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

/** Route by exact `req.url`, capturing each request body seen along the way. */
function router(
  routes: Record<string, (body: Record<string, unknown>) => { status: number; body: unknown }>,
  seen: Record<string, unknown>[] = []
): http.RequestListener {
  return (req, res) => {
    void (async () => {
      const body = await readJsonBody(req);
      seen.push(body);
      const handler = req.url !== undefined ? routes[req.url] : undefined;
      if (handler === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "NOT_FOUND", error: `no route for ${req.url}` }));
        return;
      }
      const { status, body: payload } = handler(body);
      reply(res, status, payload);
    })();
  };
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

afterEach(async () => {
  vi.mocked(ensureUp).mockReset();
  clearPolicy();
  resetBaseUrlOverrideForTests();
  await closeServer();
});

// ============================================================================
// groundingPrompt / boxesSchema — pure formatting
// ============================================================================

describe("groundingPrompt", () => {
  it("matches the Rust format!() string byte for byte", () => {
    expect(groundingPrompt("the red car", 800, 600)).toBe(
      "Outline the position of each instance of the following in this 800x600 pixel image: the red car\n" +
        'Output ONLY a JSON array, no other text, in the format [{"bbox_2d": [x1, y1, x2, y2], "label": "<short name>"}]. ' +
        "One element per match, each with a distinct descriptive label. " +
        "If it is not in the image, output []."
    );
  });

  it("formats width/height with .0 precision, even for a non-integer canvas size", () => {
    expect(groundingPrompt("x", 1000, 1000)).toContain("this 1000x1000 pixel image");
  });
});

describe("boxesSchema", () => {
  it("is the array-of-{bbox_2d,label} JSON schema Ollama's format grammar needs", () => {
    expect(boxesSchema()).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          bbox_2d: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          label: { type: "string" },
        },
        required: ["bbox_2d", "label"],
      },
    });
  });
});

// ============================================================================
// parseBoxes / boxesFromItems — the coordinate-scale-ambiguity parser
// ============================================================================

describe("parseBoxes", () => {
  // The exact three Rust `parse_boxes_survives_prose_and_think_spans` cases.
  it("survives leading prose containing a bracket, scanning to the real array", () => {
    const raw = 'Coordinates are [x1,y1,x2,y2]. Here: [{"label":"cat","bbox":[10,10,50,50]}]';
    expect(parseBoxes(raw, 100, 100)).toHaveLength(1);
  });

  it("survives a <think> block preceding the array", () => {
    const raw = '<think>let me look</think>[{"label":"dog","bbox":[0,0,40,40]}]';
    expect(parseBoxes(raw, 100, 100)).toHaveLength(1);
  });

  it("a genuine empty answer stays empty", () => {
    expect(parseBoxes("[]", 100, 100)).toHaveLength(0);
  });

  it("stops scanning after 8 candidate '[' positions", () => {
    const junk = Array.from({ length: 9 }, () => "[nope]").join(" ");
    const raw = `${junk} [{"label":"found","bbox":[0,0,10,10]}]`;
    // The real array is the 10th '[' — past the 8-position scan window — so
    // it must NOT be found.
    expect(parseBoxes(raw, 100, 100)).toEqual([]);
  });

  it("keeps scanning past a syntactically valid but empty-yielding array", () => {
    // The first bracket is valid JSON (`[1,2,3]`) but yields no boxes (no
    // object items), so the scan must continue to the second.
    const raw = '[1,2,3] then [{"label":"cat","bbox":[10,10,50,50]}]';
    expect(parseBoxes(raw, 100, 100)).toHaveLength(1);
  });

  it("never crashes on malformed JSON inside a bracket pair", () => {
    const raw = '[this is not json] [{"label":"cat","bbox":[10,10,50,50]}]';
    expect(parseBoxes(raw, 100, 100)).toHaveLength(1);
  });
});

describe("boxesFromItems", () => {
  it("reads bbox_2d as absolute pixels, x1y1x2y2 order", () => {
    const boxes = boxesFromItems([{ label: "cat", bbox_2d: [10, 20, 50, 80] }], 100, 100);
    expect(boxes).toEqual([{ label: "cat", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }]);
  });

  it("treats bbox as an alias for bbox_2d", () => {
    const boxes = boxesFromItems([{ label: "cat", bbox: [10, 20, 50, 80] }], 100, 100);
    expect(boxes).toEqual([{ label: "cat", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }]);
  });

  it("reads box_2d as Google-style [ymin,xmin,ymax,xmax] 0-1000", () => {
    // ymin=100,xmin=200,ymax=500,xmax=800 -> x1=0.2,y1=0.1,x2=0.8,y2=0.5
    const boxes = boxesFromItems([{ label: "x", box_2d: [100, 200, 500, 800] }], 100, 100);
    expect(boxes).toEqual([{ label: "x", x1: 0.2, y1: 0.1, x2: 0.8, y2: 0.5 }]);
  });

  it("falls back to 'name' when 'label' is absent, then to 'match'", () => {
    expect(boxesFromItems([{ name: "n", bbox_2d: [0, 0, 10, 10] }], 100, 100)[0]!.label).toBe("n");
    expect(boxesFromItems([{ bbox_2d: [0, 0, 10, 10] }], 100, 100)[0]!.label).toBe("match");
  });

  it("scales pixel coords by the ALREADY-normalized 0..1 path when max <= 1.0", () => {
    const boxes = boxesFromItems([{ label: "x", bbox_2d: [0.1, 0.2, 0.5, 0.8] }], 100, 100);
    expect(boxes).toEqual([{ label: "x", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }]);
  });

  it("falls back to 0-1000 scaling when a 'pixel' box overshoots the image dims", () => {
    // qwen2.5vl-on-a-small-image case: bbox_2d values that exceed img_w/img_h
    // by more than 5% are read as 0-1000-normalized, not pixels.
    const boxes = boxesFromItems([{ label: "x", bbox_2d: [100, 200, 500, 800] }], 50, 50);
    expect(boxes).toEqual([{ label: "x", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }]);
  });

  it("swaps reversed coordinates so x1<x2 and y1<y2", () => {
    const boxes = boxesFromItems([{ label: "x", bbox_2d: [50, 80, 10, 20] }], 100, 100);
    expect(boxes).toEqual([{ label: "x", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 }]);
  });

  it("clamps out-of-range coordinates into 0..1", () => {
    const boxes = boxesFromItems([{ label: "x", bbox_2d: [-500, -500, 2000, 2000] }], 100, 100);
    expect(boxes).toEqual([{ label: "x", x1: 0, y1: 0, x2: 1, y2: 1 }]);
  });

  it("drops a degenerate (near-zero-area) box", () => {
    expect(boxesFromItems([{ label: "x", bbox_2d: [10, 10, 10.05, 10.05] }], 100, 100)).toEqual([]);
  });

  it("skips an item with no recognized coordinate key, a wrong-length array, or a non-numeric entry", () => {
    expect(boxesFromItems([{ label: "x" }], 100, 100)).toEqual([]);
    expect(boxesFromItems([{ label: "x", bbox_2d: [1, 2, 3] }], 100, 100)).toEqual([]);
    expect(boxesFromItems([{ label: "x", bbox_2d: [1, 2, 3, "oops"] }], 100, 100)).toEqual([]);
  });

  it("skips a non-object item rather than throwing", () => {
    expect(boxesFromItems(["not an object", 42, null], 100, 100)).toEqual([]);
  });

  it("never reads an INHERITED key off a polluted Object.prototype", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "bbox_2d", {
      value: [0, 0, 90, 90],
      configurable: true,
      enumerable: false,
    });
    try {
      expect(boxesFromItems([{ label: "x" }], 100, 100)).toEqual([]);
    } finally {
      delete proto.bbox_2d;
    }
  });

  // The exact Rust `prepare_image_fits_square_so_boxes_dont_drift_down` box
  // assertion, run directly against `boxesFromItems`.
  it("keeps a vertically-centered box centered on a 1000x1000 canvas", () => {
    const boxes = boxesFromItems([{ bbox_2d: [100, 450, 900, 550], label: "mid" }], 1000, 1000);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.y1).toBeCloseTo(0.45, 2);
    expect(boxes[0]!.y2).toBeCloseTo(0.55, 2);
    expect(boxes[0]!.x1).toBeCloseTo(0.1, 2);
  });
});

// ============================================================================
// prepareImage — REAL sharp, no mocked decoder
// ============================================================================

describe("prepareImage", () => {
  it("fits a wide, non-square image onto the VISION_SQUARE canvas", async () => {
    const wide = await sharp({ create: { width: 800, height: 300, channels: 3, background: "#000" } })
      .png()
      .toBuffer();
    const prepared = await prepareImage(wide);
    expect(prepared.width).toBe(VISION_SQUARE);
    expect(prepared.height).toBe(VISION_SQUARE);
    // Re-decode the output: it really is a 1000x1000 PNG, not a pass-through
    // of the original 800x300 bytes.
    const meta = await sharp(prepared.bytes).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
    expect(meta.format).toBe("png");
  });

  it("stretches (fill), never letterboxes — the whole point of the square-canvas fix", async () => {
    const tall = await sharp({ create: { width: 100, height: 400, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    const prepared = await prepareImage(tall);
    const meta = await sharp(prepared.bytes).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it("falls back to the flat VISION_SQUARE guess for genuinely undecodable bytes", async () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x99, 0x12, 0x34]);
    const prepared = await prepareImage(garbage);
    expect(prepared.bytes).toBe(garbage);
    expect(prepared.width).toBe(VISION_SQUARE);
    expect(prepared.height).toBe(VISION_SQUARE);
  });
});

// ============================================================================
// totalRamBytes / visionKeepAlive
// ============================================================================

describe("totalRamBytes", () => {
  it("is os.totalmem() directly", () => {
    expect(totalRamBytes()).toBe(os.totalmem());
    expect(totalRamBytes()).toBeGreaterThan(0);
  });
});

// The exact Rust `vision_keep_alive_by_ram_and_model` cases.
describe("visionKeepAlive", () => {
  const gb = 1024 * 1024 * 1024;

  it("releases a DISTINCT vision model quickly on a 16 GB Mac", () => {
    expect(visionKeepAlive(16 * gb, "qwen2.5vl", "qwen3.5:4b")).toBe("2m");
  });

  it("keeps it warm when the vision model IS the chat model, even on 16 GB", () => {
    expect(visionKeepAlive(16 * gb, "qwen3.5:4b", "qwen3.5:4b")).toBe("30m");
  });

  it("keeps a distinct vision model warm on a 32 GB Mac", () => {
    expect(visionKeepAlive(32 * gb, "qwen2.5vl", "qwen3.5:4b")).toBe("30m");
  });

  it("keeps it warm well above the threshold too", () => {
    expect(visionKeepAlive(64 * gb, "qwen2.5vl", "qwen3.5:4b")).toBe("30m");
  });

  it("the threshold constant is exactly 32 GB", () => {
    expect(HIGH_RAM_THRESHOLD_BYTES).toBe(32 * gb);
  });

  it("the two literal keep-alive strings are what Ollama expects", () => {
    expect(KEEP_ALIVE_WARM).toBe("30m");
    expect(KEEP_ALIVE_SHORT).toBe("2m");
  });
});

// ============================================================================
// groundingPick
// ============================================================================

function fakeVisionSupportDeps(seesVision: (model: string) => boolean): VisionSupportDeps {
  return {
    ollamaCapabilities: async (model) => (seesVision(model) ? ["vision", "completion"] : ["completion"]),
    ensureProviderCatalog: async () => {},
    providerModelVision: () => undefined,
  };
}

function groundingDeps(seesVision: (model: string) => boolean, doorActive: boolean): GroundingPickDeps {
  return { ...fakeVisionSupportDeps(seesVision), privacyDoorActive: () => doorActive };
}

describe("groundingPick", () => {
  afterEach(() => clearPolicy());

  it("picks the room's OWN chosen model first when it can see", async () => {
    const deps = groundingDeps((m) => m === "qwen2.5vl", false);
    expect(await groundingPick(["qwen2.5vl", "qwen3.5:4b"], "qwen2.5vl", deps)).toBe("qwen2.5vl");
  });

  it("falls back to another INSTALLED, ON-MAC model that can see", async () => {
    const deps = groundingDeps((m) => m === "qwen2.5vl", false);
    // The chat model itself is text-only; a different installed model sees.
    expect(await groundingPick(["qwen3.5:4b", "qwen2.5vl"], "qwen3.5:4b", deps)).toBe("qwen2.5vl");
  });

  it("never re-offers the chat model itself as the fallback", async () => {
    const deps = groundingDeps(() => false, false);
    expect(await groundingPick(["qwen3.5:4b"], "qwen3.5:4b", deps)).toBeNull();
  });

  it("returns null with nothing installed to fall back to — an empty list, never a guessed name", async () => {
    const deps = groundingDeps(() => false, false);
    expect(await groundingPick([], "antigravity-cli", deps)).toBeNull();
  });

  it("the one CLI without an image channel stays null, regardless of what the deps claim", async () => {
    const deps = groundingDeps(() => true, false);
    expect(await groundingPick([], "antigravity-cli", deps)).toBeNull();
  });

  it("a Claude/Codex room keeps its own engine for image questions when the door is open", async () => {
    const deps = groundingDeps(() => false, false);
    expect(await groundingPick([], "claude-cli", deps)).toBe("claude-cli");
    expect(await groundingPick([], "codex-cli::gpt-5.6-sol", deps)).toBe("codex-cli::gpt-5.6-sol");
  });

  it("a model the privacy door would blind is not eligible, even though it can see", async () => {
    setActivePolicyForTests();
    // An OpenRouter model and an Ollama `:cloud` relay are both non-local —
    // the door strips their pixels, so picking either would hand a grounding
    // prompt to a model that never receives the picture.
    const deps = groundingDeps(() => true, true);
    expect(await groundingPick([], "openrouter::vendor/sees", deps)).toBeNull();
    expect(await groundingPick([], "vendor-vl:cloud", deps)).toBeNull();
  });

  it("a model running ON THIS MAC is untouched by the door", async () => {
    setActivePolicyForTests();
    const deps = groundingDeps((m) => m === "qwen3.5:4b", true);
    expect(await groundingPick(["qwen3.5:4b"], "qwen3.5:4b", deps)).toBe("qwen3.5:4b");
  });

  it("with the door off, every reachable model is eligible again", async () => {
    // An OpenRouter model's vision answer comes from the PROVIDER catalog,
    // not `ollamaCapabilities` — `providerModelVision` is the seam that
    // matters here.
    const deps: GroundingPickDeps = {
      ...fakeVisionSupportDeps(() => true),
      providerModelVision: () => true,
      privacyDoorActive: () => false,
    };
    expect(await groundingPick([], "openrouter::vendor/sees", deps)).toBe("openrouter::vendor/sees");
  });
});

// ============================================================================
// groundPreparedImage — real /generate round trip
// ============================================================================

describe("groundPreparedImage", () => {
  it("sends the image inline on the user turn and parses the model's box reply", async () => {
    const seen: Record<string, unknown>[] = [];
    await sidecarAt(
      router(
        {
          "/generate": () => ({
            status: 200,
            body: { text: '[{"label":"cat","bbox_2d":[10,10,50,50]}]' },
          }),
        },
        seen
      )
    );
    const prepared = Buffer.from([1, 2, 3, 4]);
    const boxes = await groundPreparedImage("qwen2.5vl", "qwen3.5:4b", prepared, "the cat", 100, 100);
    expect(boxes).toEqual([{ label: "cat", x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 }]);

    const body = seen[0]!;
    expect(body.model).toBe("qwen2.5vl");
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.images).toEqual([prepared.toString("base64")]);
    expect(body.temperature).toBe(0.0);
    expect(body.format).toEqual(boxesSchema());
    // Distinct vision/chat models: keep_alive matches this machine's own RAM
    // reading, exactly as `visionKeepAlive` would compute it.
    expect(body.keep_alive).toBe(visionKeepAlive(totalRamBytes(), "qwen2.5vl", "qwen3.5:4b"));
  });

  it("keeps the model warm when the vision model IS the chat model", async () => {
    const seen: Record<string, unknown>[] = [];
    await sidecarAt(router({ "/generate": () => ({ status: 200, body: { text: "[]" } }) }, seen));
    await groundPreparedImage("qwen3.5:4b", "qwen3.5:4b", Buffer.from([1]), "q", 10, 10);
    expect(seen[0]!.keep_alive).toBe(KEEP_ALIVE_WARM);
  });

  it("returns an empty list, never throws, when the model finds nothing", async () => {
    await sidecarAt(router({ "/generate": () => ({ status: 200, body: { text: "[]" } }) }));
    const boxes = await groundPreparedImage("qwen2.5vl", "qwen3.5:4b", Buffer.from([1]), "q", 10, 10);
    expect(boxes).toEqual([]);
  });

  it("propagates the classified sentinel when the engine is down", async () => {
    await sidecarAt(router({ "/generate": () => ({ status: 503, body: { code: "OLLAMA_DOWN", error: "down" } }) }));
    await expect(groundPreparedImage("qwen2.5vl", "qwen3.5:4b", Buffer.from([1]), "q", 10, 10)).rejects.toThrow(
      "OLLAMA_DOWN"
    );
  });
});

// ============================================================================
// locateInImage
// ============================================================================

let tmpDir: string;

function freshRoom(): { db: Database.Database; path: string } {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "visionTools-"));
  const roomPath = path.join(tmpDir, `vt-test-${randomUUID()}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return { db, path: roomPath };
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

const noVisionDeps: LocateInImageDeps["groundingDeps"] = {
  ollamaCapabilities: async () => [],
  ensureProviderCatalog: async () => {},
  providerModelVision: () => undefined,
  privacyDoorActive: () => false,
};

const blindCapabilitiesDeps: CapabilitiesForDeps = {
  ollamaCapabilities: async () => [],
  ollamaNativeContextLength: async () => null,
  ensureProviderCatalog: async () => {},
  providerModelFacts: () => undefined,
  codexContextWindow: async () => undefined,
  privacyDoorActive: () => false,
};

describe("locateInImage", () => {
  it("throws 'File has no stored content.' for a NULL bytes column — never silently marks nothing", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1]), null, "library");
    db.prepare("UPDATE files SET original_bytes = NULL WHERE id = ?").run(file.id);
    await expect(locateInImage(db, file.id, "the cat")).rejects.toThrow("File has no stored content.");
  });

  it("throws NO_VISION_MODEL when nothing can see and the privacy door has nothing more specific to say", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1, 2, 3]), null, "library");
    setSetting(db, "model", "antigravity-cli");
    await expect(
      locateInImage(db, file.id, "the cat", {
        listModels: async () => [],
        groundingDeps: noVisionDeps,
        capabilitiesDeps: blindCapabilitiesDeps,
      })
    ).rejects.toThrow(NO_VISION_MODEL);
  });

  it("names the privacy door specifically when a CAPABLE cloud model is the one being blinded", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1, 2, 3]), null, "library");
    setSetting(db, "model", "openrouter::vendor/sees");
    const doorBlockCapsDeps: CapabilitiesForDeps = {
      ...blindCapabilitiesDeps,
      providerModelFacts: () => ({
        contextWindow: null,
        tools: false,
        vision: true,
        structuredOutputs: false,
        imageOutput: false,
        videoOutput: false,
      }),
      privacyDoorActive: () => true,
    };
    await expect(
      locateInImage(db, file.id, "the cat", {
        listModels: async () => [],
        groundingDeps: { ...noVisionDeps, privacyDoorActive: () => true },
        capabilitiesDeps: doorBlockCapsDeps,
      })
    ).rejects.toThrow(/privacy door removes them/);
  });

  it("picks the room's explicit model setting over best_default when both could see", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1, 2, 3]), null, "library");
    setSetting(db, "model", "qwen2.5vl");
    const seenModels: string[] = [];
    const deps: GroundingPickDeps = {
      ollamaCapabilities: async (model) => {
        seenModels.push(model);
        return ["vision"];
      },
      ensureProviderCatalog: async () => {},
      providerModelVision: () => undefined,
      privacyDoorActive: () => false,
    };
    await sidecarAt(
      router({ "/vision_locate": () => ({ status: 200, body: { boxes: [] } }) })
    );
    await locateInImage(db, file.id, "the cat", { listModels: async () => ["qwen3.5:4b"], groundingDeps: deps });
    // grounding_pick asks the EXPLICIT room model first — never falls through
    // to best_default while the explicit pick can see.
    expect(seenModels[0]).toBe("qwen2.5vl");
  });

  it("falls back to best_default when the room has no explicit model setting", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1, 2, 3]), null, "library");
    const seenModels: string[] = [];
    const deps: GroundingPickDeps = {
      ollamaCapabilities: async (model) => {
        seenModels.push(model);
        return ["vision"];
      },
      ensureProviderCatalog: async () => {},
      providerModelVision: () => undefined,
      privacyDoorActive: () => false,
    };
    await sidecarAt(router({ "/vision_locate": () => ({ status: 200, body: { boxes: [] } }) }));
    await locateInImage(db, file.id, "x", { listModels: async () => ["qwen3.5:4b"], groundingDeps: deps });
    expect(seenModels[0]).toBe("qwen3.5:4b");
  });

  it("POSTs /vision_locate with the ORIGINAL bytes (no local prepare/transcode step) and decodes real boxes", async () => {
    const { db } = freshRoom();
    const original = new Uint8Array([9, 9, 9, 9, 9]);
    const file = insertFile(db, "photo.png", "image/png", original, null, "library");
    setSetting(db, "model", "qwen2.5vl");
    const seen: Record<string, unknown>[] = [];
    await sidecarAt(
      router(
        {
          "/vision_locate": () => ({
            status: 200,
            body: { boxes: [{ label: "cat", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 }] },
          }),
        },
        seen
      )
    );
    const deps: GroundingPickDeps = {
      ollamaCapabilities: async () => ["vision"],
      ensureProviderCatalog: async () => {},
      providerModelVision: () => undefined,
      privacyDoorActive: () => false,
    };
    const boxes = await locateInImage(db, file.id, "the cat", {
      listModels: async () => ["qwen2.5vl"],
      groundingDeps: deps,
    });
    expect(boxes).toEqual([{ label: "cat", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 }]);
    expect(seen[0]!.model).toBe("qwen2.5vl");
    expect(seen[0]!.query).toBe("the cat");
    expect(seen[0]!.image_b64).toBe(Buffer.from(original).toString("base64"));
    expect(seen[0]!.temperature).toBe(0.0);
  });

  it("throws the classified sentinel when the sidecar call itself fails", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1]), null, "library");
    setSetting(db, "model", "qwen2.5vl");
    await sidecarAt(
      router({ "/vision_locate": () => ({ status: 404, body: { code: "MODEL_MISSING", error: "not pulled" } }) })
    );
    const deps: GroundingPickDeps = {
      ollamaCapabilities: async () => ["vision"],
      ensureProviderCatalog: async () => {},
      providerModelVision: () => undefined,
      privacyDoorActive: () => false,
    };
    await expect(
      locateInImage(db, file.id, "q", { listModels: async () => ["qwen2.5vl"], groundingDeps: deps })
    ).rejects.toThrow("MODEL_MISSING:qwen2.5vl");
  });

  it("surfaces a stopped vision pass instead of treating it as an empty box list", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1]), null, "library");
    setSetting(db, "model", "qwen2.5vl");
    const groundingDeps: GroundingPickDeps = {
      ollamaCapabilities: async () => ["vision"],
      ensureProviderCatalog: async () => {},
      providerModelVision: () => undefined,
      privacyDoorActive: () => false,
    };

    await expect(
      locateInImage(db, file.id, "q", {
        listModels: async () => ["qwen2.5vl"],
        groundingDeps,
        post: async () => ({ kind: "stopped" }),
      })
    ).rejects.toThrow("The vision pass was stopped.");
  });

  it("throws rather than fabricating an answer when 'boxes' is missing or malformed", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1]), null, "library");
    setSetting(db, "model", "qwen2.5vl");
    const deps: GroundingPickDeps = {
      ollamaCapabilities: async () => ["vision"],
      ensureProviderCatalog: async () => {},
      providerModelVision: () => undefined,
      privacyDoorActive: () => false,
    };
    for (const payload of [{ notBoxes: [] }, { boxes: [{ label: "x" }] }, { boxes: "nope" }]) {
      await sidecarAt(router({ "/vision_locate": () => ({ status: 200, body: payload }) }));
      await expect(
        locateInImage(db, file.id, "q", { listModels: async () => ["qwen2.5vl"], groundingDeps: deps })
      ).rejects.toThrow(/unreadable result/);
    }
  });

  it("never reads an INHERITED 'boxes' key off a polluted Object.prototype", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1]), null, "library");
    setSetting(db, "model", "qwen2.5vl");
    await sidecarAt(router({ "/vision_locate": () => ({ status: 200, body: { notBoxes: 1 } }) }));
    const deps: GroundingPickDeps = {
      ollamaCapabilities: async () => ["vision"],
      ensureProviderCatalog: async () => {},
      providerModelVision: () => undefined,
      privacyDoorActive: () => false,
    };
    const proto = Object.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "boxes", {
      value: [{ label: "fabricated", x1: 0, y1: 0, x2: 1, y2: 1 }],
      configurable: true,
      enumerable: false,
    });
    try {
      await expect(
        locateInImage(db, file.id, "q", { listModels: async () => ["qwen2.5vl"], groundingDeps: deps })
      ).rejects.toThrow(/unreadable result/);
    } finally {
      delete proto.boxes;
    }
  });

  it("uses the default Codex capability context before reporting an image-blocked room", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1]), null, "library");
    setSetting(db, "model", "codex-cli::gpt-5.6-sol");
    setActivePolicyForTests();

    await expect(
      locateInImage(db, file.id, "q", { listModels: async () => [] })
    ).rejects.toThrow(/privacy door/i);
  });

  it("runs both default provider-catalog seams before refusing an unknown provider vision model", async () => {
    const ensureProviderCatalog = vi.fn(async () => {});
    try {
      vi.resetModules();
      vi.doMock("./providers.js", async (importOriginal) => {
        const actual = await importOriginal<typeof import("./providers.js")>();
        return {
          ...actual,
          ensureProviderCatalog,
          providerModelVision: () => false,
        };
      });
      const { locateInImage: locateWithDefaultProviderDeps } = await import("./visionTools.js");
      const { db } = freshRoom();
      const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1]), null, "library");
      setSetting(db, "model", "openrouter::unknown-vision-model");

      await expect(
        locateWithDefaultProviderDeps(db, file.id, "q", { listModels: async () => [] })
      ).rejects.toThrow(NO_VISION_MODEL);
      expect(ensureProviderCatalog).toHaveBeenCalledTimes(2);
      expect(ensureProviderCatalog).toHaveBeenCalledWith(
        "openrouter::unknown-vision-model",
        expect.anything()
      );
    } finally {
      vi.doUnmock("./providers.js");
      vi.resetModules();
    }
  });

  // -------------------------------------------------- real default deps

  it("closes the loop with the REAL default deps — no injected groundingDeps/capabilitiesDeps at all", async () => {
    const { db } = freshRoom();
    const original = new Uint8Array([7, 7, 7]);
    const file = insertFile(db, "photo.png", "image/png", original, null, "library");
    setSetting(db, "model", "qwen2.5vl");
    const seen: Record<string, unknown>[] = [];
    await sidecarAt(
      router(
        {
          "/capabilities": () => ({ status: 200, body: { capabilities: ["vision", "completion"] } }),
          "/vision_locate": () => ({
            status: 200,
            body: { boxes: [{ label: "cat", x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }] },
          }),
        },
        seen
      )
    );
    // `listModels` is still injected (it goes through /models, a route this
    // test does not need to also serve) — every OTHER seam is this file's
    // real, wired default.
    const boxes = await locateInImage(db, file.id, "the cat", { listModels: async () => ["qwen2.5vl"] });
    expect(boxes).toEqual([{ label: "cat", x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }]);
    const visionLocateCall = seen.find((b) => b.query === "the cat");
    expect(visionLocateCall?.model).toBe("qwen2.5vl");
  });
});

describe("registerVisionIpc", () => {
  function listener(handle: ReturnType<typeof vi.fn>, channel: string): (...args: unknown[]) => unknown {
    const entry = handle.mock.calls.find((c) => c[0] === channel);
    if (entry === undefined) {
      throw new Error(`channel ${channel} was not registered`);
    }
    return entry[1] as (...args: unknown[]) => unknown;
  }

  it("registers exactly the locate_in_image channel", () => {
    const { db } = freshRoom();
    const handle = vi.fn();
    registerVisionIpc({ handle }, { currentRoom: () => ({ db, path: "x" }) });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe("locate_in_image");
  });

  it("wires locate_in_image to a resolved db, reaching the real logic", async () => {
    const { db } = freshRoom();
    const file = insertFile(db, "photo.png", "image/png", new Uint8Array([1, 2, 3]), null, "library");
    setSetting(db, "model", "qwen2.5vl");
    await sidecarAt(router({ "/vision_locate": () => ({ status: 200, body: { boxes: [] } }) }));
    const deps: LocateInImageDeps = {
      listModels: async () => ["qwen2.5vl"],
      groundingDeps: {
        ollamaCapabilities: async () => ["vision"],
        ensureProviderCatalog: async () => {},
        providerModelVision: () => undefined,
        privacyDoorActive: () => false,
      },
    };
    const handle = vi.fn();
    registerVisionIpc({ handle }, { currentRoom: () => ({ db, path: "x" }) }, deps);
    const fn = listener(handle, "locate_in_image");
    await expect(fn({}, { fileId: file.id, query: "q" })).resolves.toEqual([]);
  });

  it("refuses with 'No room is open.' when no room is open", async () => {
    const handle = vi.fn();
    registerVisionIpc({ handle }, { currentRoom: () => null });
    const fn = listener(handle, "locate_in_image");
    // openDb() throws SYNCHRONOUSLY — normalize to a rejected promise exactly
    // as `previewTools.test.ts`/`recIpc.test.ts` do for the same case.
    await expect(Promise.resolve().then(() => fn({}, { fileId: "anything", query: "q" }))).rejects.toThrow(
      "No room is open."
    );
  });
});

// ============================================================================
// ADVERSARIAL — every byte here came out of a language model
// ============================================================================
//
// `parseBoxes` is fed a MODEL's raw text, and `boxesFromItems` the objects
// parsed out of it. Both keys and values are attacker-influenceable in the
// ordinary sense that a prompt-injected or simply confused model writes them.
// The Rust source survives this by construction (`serde_json::Value`'s
// `item["k"]` is a lookup on a `Map`, and a bad index yields `Null`); a
// TypeScript port has to earn it.

describe("parseBoxes / boxesFromItems, adversarial model output", () => {
  it("a '[' inside a JSON STRING does not end the value early — quoting is respected", () => {
    // A naive first-'['-to-last-']' slice, or a bracket walk that ignores
    // string quoting, cuts this in the middle of the label.
    const raw = '[{"label":"the ] bracket [ sign","bbox_2d":[10,10,50,50]}]';
    const boxes = parseBoxes(raw, 100, 100);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.label).toBe("the ] bracket [ sign");
  });

  it("an ESCAPED quote inside a label does not break the value boundary", () => {
    const raw = '[{"label":"a \\" b","bbox_2d":[10,10,50,50]}]';
    const boxes = parseBoxes(raw, 100, 100);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.label).toBe('a " b');
  });

  it("an UNTERMINATED array yields no boxes instead of hanging or throwing", () => {
    expect(parseBoxes('[{"label":"cat","bbox_2d":[10,10,50,50]', 100, 100)).toEqual([]);
    expect(parseBoxes("[[[[[[[[[[[[[[[[", 100, 100)).toEqual([]);
    expect(parseBoxes('[{"a":"' + "[".repeat(2000), 100, 100)).toEqual([]);
  });

  it("a '__proto__'-keyed item neither pollutes Object.prototype nor answers through it", () => {
    // Rule 2's exact shape, on the WRITE side this time: `JSON.parse` really
    // does create an OWN "__proto__" data property, so a port that copied
    // model keys onto a `{}` literal would install it on every object in the
    // process.
    const before = ({} as Record<string, unknown>).polluted;
    const raw = '[{"__proto__":{"polluted":"yes","label":"ghost"},"bbox_2d":[10,10,50,50]}]';
    const boxes = parseBoxes(raw, 100, 100);
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(boxes).toHaveLength(1);
    // The label came from a nested "__proto__" object, so it is NOT this
    // item's own label — the default stands.
    expect(boxes[0]!.label).toBe("match");
  });

  it("a label that is not a string falls through to 'name', then to 'match' — never String()-coerced", () => {
    expect(boxesFromItems([{ label: 42, bbox_2d: [0, 0, 50, 50] }], 100, 100)[0]!.label).toBe("match");
    expect(boxesFromItems([{ label: null, name: "n", bbox_2d: [0, 0, 50, 50] }], 100, 100)[0]!.label).toBe("n");
    expect(boxesFromItems([{ label: {}, name: [], bbox_2d: [0, 0, 50, 50] }], 100, 100)[0]!.label).toBe("match");
  });

  it("a coordinate that JSON.parse turns into Infinity is refused, not clamped into a fake box", () => {
    // `1e999` parses to Infinity in JS. serde_json REFUSES the number
    // outright (the whole array fails to decode); either way the answer must
    // be "no boxes", never a box spanning the entire image.
    expect(parseBoxes('[{"label":"x","bbox_2d":[0,0,1e999,1e999]}]', 100, 100)).toEqual([]);
    expect(boxesFromItems([{ label: "x", bbox_2d: [0, 0, Infinity, 50] }], 100, 100)).toEqual([]);
    expect(boxesFromItems([{ label: "x", bbox_2d: [NaN, 0, 50, 50] }], 100, 100)).toEqual([]);
  });

  it("a numeric STRING coordinate is not a number — the whole element is skipped", () => {
    // `filter_map(Value::as_f64)` returns None for a JSON string, so `vals`
    // is short and Rust `continue`s. A `Number(...)` coercion here would
    // silently accept it.
    expect(boxesFromItems([{ label: "x", bbox_2d: ["0", "0", "50", "50"] }], 100, 100)).toEqual([]);
    expect(boxesFromItems([{ label: "x", bbox_2d: [0, 0, 50, "50"] }], 100, 100)).toEqual([]);
  });

  it("EVERY box that survives is inside 0..1 with positive area, whatever the model claimed", () => {
    // The property the parser exists for: a box is drawn on the user's own
    // picture, so a coordinate outside the picture is not renderable.
    const hostile: unknown[] = [
      { label: "a", bbox_2d: [-500, -500, 5000, 5000] },
      { label: "b", box_2d: [-1, -1, 2000, 2000] },
      { label: "c", bbox: [1e6, 1e6, 2e6, 2e6] },
      { label: "d", box: [0.9, 0.9, 0.1, 0.1] },
      { label: "e", bbox_2d: [50, 50, 10, 10] },
      { label: "f", bbox_2d: [0, 0, 1000, 1000] },
      { label: "g", bbox_2d: [0.5, 0.5, 0.500001, 0.9] },
      { label: "h", box_2d: [999, 999, 1000, 1000] },
    ];
    for (const dims of [[100, 100], [1000, 1000], [1, 1], [4000, 30]] as const) {
      const boxes = boxesFromItems(hostile, dims[0], dims[1]);
      for (const b of boxes) {
        const where = `${JSON.stringify(b)} @ ${dims[0]}x${dims[1]}`;
        expect(b.x1, where).toBeGreaterThanOrEqual(0);
        expect(b.y1, where).toBeGreaterThanOrEqual(0);
        expect(b.x2, where).toBeLessThanOrEqual(1);
        expect(b.y2, where).toBeLessThanOrEqual(1);
        expect(b.x2 - b.x1, where).toBeGreaterThanOrEqual(0.001);
        expect(b.y2 - b.y1, where).toBeGreaterThanOrEqual(0.001);
        expect(Number.isFinite(b.x1) && Number.isFinite(b.y2), where).toBe(true);
      }
    }
  });

  it("a zero-size image cannot divide by zero — img_w.max(1.0) is why", () => {
    const boxes = boxesFromItems([{ label: "x", bbox_2d: [0, 0, 50, 50] }], 0, 0);
    for (const b of boxes) {
      expect(Number.isFinite(b.x2)).toBe(true);
      expect(b.x2).toBeLessThanOrEqual(1);
    }
  });

  it("prose with more than 8 brackets before the real array gives up rather than scanning forever", () => {
    // `.take(8)` in Rust. The ninth candidate is never examined, even when it
    // is the only valid one — a deliberate bound, asserted so a future
    // "improvement" that removes it is caught.
    const noise = "[a] ".repeat(8);
    expect(parseBoxes(`${noise}[{"label":"cat","bbox_2d":[10,10,50,50]}]`, 100, 100)).toEqual([]);
    const justUnder = "[a] ".repeat(7);
    expect(parseBoxes(`${justUnder}[{"label":"cat","bbox_2d":[10,10,50,50]}]`, 100, 100)).toHaveLength(1);
  });
});

describe("prepareImage, adversarial bytes", () => {
  it("keeps declared dimensions when decode fails after a readable PNG header", async () => {
    const real = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#123456" } })
      .png()
      .toBuffer();
    const headerReadableButTruncated = real.subarray(0, 65);

    const prepared = await prepareImage(headerReadableButTruncated);
    expect(prepared).toEqual({ bytes: headerReadableButTruncated, width: 40, height: 20 });
  });

  it("a TRUNCATED PNG never fabricates a canvas it did not produce", async () => {
    const real = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#123456" } })
      .png()
      .toBuffer();
    const truncated = real.subarray(0, 40);
    const prepared = await prepareImage(truncated);
    // Either sharp read the header and reported the file's OWN size, or it
    // could say nothing and the flat VISION_SQUARE guess stands. What it must
    // NOT do is claim a 1000x1000 canvas while handing back bytes that are
    // not a 1000x1000 image.
    if (prepared.width === VISION_SQUARE && prepared.height === VISION_SQUARE) {
      expect(prepared.bytes.equals(truncated)).toBe(true);
    } else {
      expect(prepared.width).toBe(40);
      expect(prepared.height).toBe(20);
      expect(prepared.bytes.equals(truncated)).toBe(true);
    }
  });

  it("zero bytes and pure noise resolve rather than throwing — the caller has no other branch", async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from("not an image at all"), Buffer.alloc(4096, 0xff)]) {
      const prepared = await prepareImage(bytes);
      expect(prepared.width).toBeGreaterThan(0);
      expect(prepared.height).toBeGreaterThan(0);
      expect(Buffer.isBuffer(prepared.bytes)).toBe(true);
    }
  });

  it("a real 1x1 image still stretches to the full square — the boundary of the resize", async () => {
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ff0000" } })
      .png()
      .toBuffer();
    const prepared = await prepareImage(tiny);
    expect(prepared.width).toBe(VISION_SQUARE);
    expect(prepared.height).toBe(VISION_SQUARE);
    const meta = await sharp(prepared.bytes).metadata();
    expect(meta.width).toBe(VISION_SQUARE);
    expect(meta.height).toBe(VISION_SQUARE);
    expect(meta.format).toBe("png");
  });
});
