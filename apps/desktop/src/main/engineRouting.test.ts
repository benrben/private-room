/**
 * Tests for `engineRouting.ts` — the small, honestly-scoped seam over the
 * unported `ollama.rs`/`ollama_lifecycle.rs` gap. Real `node:http` servers
 * throughout (this repo's "real behavior over mocks" convention), never a
 * patched `fetch`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  handoffSummaryAt,
  isAwake,
  listModelsAt,
  resetBaseUrlOverrideForTests,
  resolvedBaseUrl,
  setBaseUrlOverride,
  stripThinkSpans,
} from "./engineRouting.js";

let server: http.Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("resolvedBaseUrl (C1 layering)", () => {
  const originalEnv = process.env.ARCELLE_OLLAMA_URL;

  afterEach(() => {
    resetBaseUrlOverrideForTests();
    if (originalEnv === undefined) {
      delete process.env.ARCELLE_OLLAMA_URL;
    } else {
      process.env.ARCELLE_OLLAMA_URL = originalEnv;
    }
  });

  it("defaults to the local Ollama port with no env and no override", () => {
    delete process.env.ARCELLE_OLLAMA_URL;
    expect(resolvedBaseUrl()).toBe("http://127.0.0.1:11434");
  });

  it("reads ARCELLE_OLLAMA_URL, trimming whitespace and trailing slashes", () => {
    process.env.ARCELLE_OLLAMA_URL = "  http://box:11434//  ";
    expect(resolvedBaseUrl()).toBe("http://box:11434");
  });

  it("falls back to the default for an empty or whitespace-only env value", () => {
    process.env.ARCELLE_OLLAMA_URL = "   ";
    expect(resolvedBaseUrl()).toBe("http://127.0.0.1:11434");
  });

  it("a runtime override (the closet supercomputer) wins over the env var", () => {
    process.env.ARCELLE_OLLAMA_URL = "http://box:11434";
    setBaseUrlOverride("http://closet:11434/");
    expect(resolvedBaseUrl()).toBe("http://closet:11434");
  });

  it("clearing the override — null or blank — falls back through to env, then the default", () => {
    process.env.ARCELLE_OLLAMA_URL = "http://box:11434";
    setBaseUrlOverride("http://closet:11434");
    setBaseUrlOverride("   ");
    expect(resolvedBaseUrl()).toBe("http://box:11434");
    setBaseUrlOverride("http://closet:11434");
    setBaseUrlOverride(null);
    delete process.env.ARCELLE_OLLAMA_URL;
    expect(resolvedBaseUrl()).toBe("http://127.0.0.1:11434");
  });
});

describe("isAwake", () => {
  it("true for a 2xx /api/version", async () => {
    const base = await listenOn((req, res) => {
      expect(req.url).toBe("/api/version");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.1.0" }));
    });
    expect(await isAwake(base)).toBe(true);
  });

  it("false for a non-2xx response", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    expect(await isAwake(base)).toBe(false);
  });

  it("false when nothing is listening (connection refused) — never throws", async () => {
    expect(await isAwake("http://127.0.0.1:1")).toBe(false);
  });
});

describe("listModelsAt", () => {
  it("POSTs the sidecar's own /models and returns the parsed list", async () => {
    const base = await listenOn((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/models");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: ["qwen3.5:4b", "nomic-embed-text"] }));
    });
    expect(await listModelsAt(base)).toEqual(["qwen3.5:4b", "nomic-embed-text"]);
  });

  it("drops non-string entries rather than failing the whole list", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: ["a", 5, null, "b"] }));
    });
    expect(await listModelsAt(base)).toEqual(["a", "b"]);
  });

  it("empty (never throws) when the models key is missing or malformed", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    expect(await listModelsAt(base)).toEqual([]);
  });

  it("empty (never throws) on a non-2xx status", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(503);
      res.end("busy");
    });
    expect(await listModelsAt(base)).toEqual([]);
  });

  it("empty (never throws) when nothing is listening", async () => {
    expect(await listModelsAt("http://127.0.0.1:1")).toEqual([]);
  });
});

describe("stripThinkSpans", () => {
  it("removes one complete span", () => {
    expect(stripThinkSpans("before<think>reasoning</think>after")).toBe("beforeafter");
  });

  it("removes several spans", () => {
    expect(stripThinkSpans("<think>a</think>mid<think>b</think>end")).toBe("midend");
  });

  it("truncates at an unterminated span — everything after it is unclosed reasoning", () => {
    expect(stripThinkSpans("keep this<think>never closes")).toBe("keep this");
  });

  it("passes ordinary text through untouched", () => {
    expect(stripThinkSpans("just an ordinary answer")).toBe("just an ordinary answer");
  });
});

describe("handoffSummaryAt", () => {
  it("posts the summarization request and strips think spans from the reply", async () => {
    const base = await listenOn((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/handoff_summary");
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        expect(body.model).toBe("qwen3.5:4b");
        expect(body.temperature).toBe(0.5);
        expect(Array.isArray(body.messages)).toBe(true);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ summary: "<think>drafting…</think>The recap.  " }));
      });
    });
    expect(await handoffSummaryAt(base, "qwen3.5:4b", [{ role: "user", content: "hi" }], 0.5)).toBe("The recap.");
  });

  it("throws (never defaults) when the sidecar call fails — an empty recap is a failed handoff", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    await expect(handoffSummaryAt(base, "qwen3.5:4b", [], null)).rejects.toThrow();
  });

  it("empty recap when the model returned no summary field", async () => {
    const base = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    expect(await handoffSummaryAt(base, "qwen3.5:4b", [], null)).toBe("");
  });
});
