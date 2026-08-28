/**
 * Tests for `ollamaGenerate.ts`.
 *
 * Pure logic (`plainGenerateBody`, `recoverJson`, `injectSchemaInstruction`)
 * is driven directly. Every network-carrying call runs against a REAL local
 * `node:http` server — never a patched `fetch` — with `ensureUp` (from
 * `sidecar.js`) mocked to point at it, the convention
 * `sidecarJsonCancellable.test.ts`/`ollamaModels.test.ts` already establish.
 * No real sidecar process, no real Ollama daemon, and no real macOS Keychain
 * entry is ever touched (the provider cases inject a fake `ProviderDeps`).
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { CancelFlag } from "./cancel.js";
import { resetBaseUrlOverrideForTests } from "./engineRouting.js";
import {
  chatStructured,
  generate,
  injectSchemaInstruction,
  plainGenerateBody,
  recoverJson,
} from "./ollamaGenerate.js";
import { clearPolicy, setActivePolicyForTests } from "./privacy.js";
import { resetProviderStateForTests, type ProviderDeps } from "./providers.js";
import { ensureUp } from "./sidecar.js";
import type { SidecarChatMessage } from "./sidecar.js";
import type { GenerateOllamaFn } from "./workflowCompose.js";

// --------------------------------------------------------- test HTTP server

let server: http.Server | undefined;

async function listenOn(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A base URL nothing is listening on: a real ephemeral port that WAS bound
 * and is now closed, so the connection is genuinely REFUSED rather than
 * simulated. */
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

/** Serve one JSON reply and capture the request body the port sent. */
async function captureBody(status: number, replyWith: unknown): Promise<() => Record<string, unknown> | undefined> {
  let seen: Record<string, unknown> | undefined;
  await sidecarAt((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(replyWith));
    });
  });
  return () => seen;
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Shut the current test server down, so a case that needs SEVERAL replies in
 * a row can stand one up per payload without leaking listeners. */
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
  // The provider catalog is a PROCESS-lifetime cache with its own retry
  // back-off. Left dirty, a case whose story is "the catalog is fetched now"
  // silently skips the fetch because an earlier case already spent the
  // attempt — the test then passes while exercising nothing.
  resetProviderStateForTests();
  await closeServer();
});

const fakeProviderDeps: ProviderDeps = {
  readKey: (provider) => (provider === "openrouter" ? "fake-key-123" : ""),
  storeKey: () => {},
  deleteKey: () => {},
  fetchJson: () => Promise.reject(new Error("no network in this test")),
};

// ---------------------------------------------------------- type-level proof
// `generate` really is a valid drop-in for `workflowCompose.ts`'s
// `GenerateOllamaFn` seam — a COMPILE-TIME assertion checked by `tsc`, not a
// runtime one. If this line stops compiling, the seam this module's doc
// describes as closeable is not actually closeable.
const _dropInProof: GenerateOllamaFn = generate;
void _dropInProof;

// ============================================================================
// plainGenerateBody
// ============================================================================

describe("plainGenerateBody", () => {
  it("builds the exact wire shape, with no num_ctx / format / tools", () => {
    const messages: SidecarChatMessage[] = [{ role: "user", content: "hi" }];
    const body = plainGenerateBody("qwen3.5:4b", messages, 0.2, "30m");
    expect(body).toEqual({
      model: "qwen3.5:4b",
      messages,
      base_url: "http://127.0.0.1:11434",
      temperature: 0.2,
      keep_alive: "30m",
    });
    expect(body).not.toHaveProperty("num_ctx");
    expect(body).not.toHaveProperty("format");
    expect(body).not.toHaveProperty("tools");
  });

  it("keeps a null temperature as an explicit null — the sidecar's own 'omit' signal", () => {
    const body = plainGenerateBody("m", [], null, "5m");
    expect("temperature" in body).toBe(true);
    expect(body.temperature).toBeNull();
  });
});

// ============================================================================
// recoverJson
// ============================================================================

describe("recoverJson", () => {
  // The same four rows `ollama.rs`'s own `recover_json_unwraps_fences_think_and_prose`
  // asserts, byte for byte.
  it("parses bare JSON, a ```json fence, a <think> preamble, and a bare array", () => {
    const cases: Array<[string, string]> = [
      ['{"markdown":"hi"}', '{"markdown":"hi"}'],
      ['```json\n{"markdown":"hi"}\n```', '{"markdown":"hi"}'],
      ['<think>hmm</think>\n{"a":1}', '{"a":1}'],
      ["```\n[1,2,3]\n```", "[1,2,3]"],
    ];
    for (const [input, expected] of cases) {
      expect(recoverJson(input)).toBe(expected);
    }
  });

  it("returns the trimmed, think-stripped text unchanged when there is no bracket at all", () => {
    expect(recoverJson("  <think>nope</think>just prose  ")).toBe("just prose");
  });

  it("slices from the FIRST opener to the LAST closer, whichever kind each is", () => {
    expect(recoverJson('prose [1, {"a":2}] trailing')).toBe('[1, {"a":2}]');
  });
});

// ============================================================================
// injectSchemaInstruction
// ============================================================================

describe("injectSchemaInstruction", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };

  it("appends the reminder to the LAST user message, searching from the end", () => {
    const messages: SidecarChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const out = injectSchemaInstruction(messages, schema);
    expect(out[0]!.content).toBe("first");
    expect(out[1]!.content).toBe("reply");
    // Byte for byte the Rust `format!` string.
    expect(out[2]!.content).toBe(
      "second\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n" +
        JSON.stringify(schema)
    );
  });

  it("never mutates the input array or its messages", () => {
    const messages: SidecarChatMessage[] = [{ role: "user", content: "hi" }];
    const snapshot = structuredClone(messages);
    injectSchemaInstruction(messages, schema);
    expect(messages).toEqual(snapshot);
  });

  it("is a no-op copy when there is no user message at all", () => {
    const messages: SidecarChatMessage[] = [{ role: "system", content: "you are helpful" }];
    const out = injectSchemaInstruction(messages, schema);
    expect(out).toEqual(messages);
    expect(out).not.toBe(messages);
  });

  it("falls back to an empty schema string rather than throwing on an unserializable schema", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = injectSchemaInstruction([{ role: "user", content: "hi" }], cyclic);
    expect(out[0]!.content).toBe(
      "hi\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n"
    );
  });
});

// ============================================================================
// generate
// ============================================================================

describe("generate", () => {
  it("POSTs /generate and returns the model's RAW text (no recoverJson on this path)", async () => {
    const seen = await captureBody(200, { text: "```json\nnot actually recovered\n```" });
    const messages: SidecarChatMessage[] = [{ role: "user", content: "hi" }];
    const text = await generate("qwen3.5:4b", messages, 0.2, "30m");
    expect(text).toBe("```json\nnot actually recovered\n```");
    expect(seen()).toEqual({
      model: "qwen3.5:4b",
      messages,
      base_url: "http://127.0.0.1:11434",
      temperature: 0.2,
      keep_alive: "30m",
    });
  });

  it("resolves '' for a missing/non-string text field", async () => {
    await sidecarAt((_req, res) => reply(res, 200, { notText: 1 }));
    expect(await generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m")).toBe("");
  });

  it("never reads an INHERITED text field off a polluted prototype", async () => {
    // A fabricated answer is worse than an empty one: `value.text` must be an
    // OWN-property read, which is what Rust's `value["text"]` on a serde Map is.
    await sidecarAt((_req, res) => reply(res, 200, { notText: 1 }));
    const proto = Object.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "text", { value: "fabricated", configurable: true, enumerable: false });
    try {
      expect(await generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m")).toBe("");
    } finally {
      delete proto.text;
    }
  });

  it("resolves '' when already cancelled, and never touches ensureUp or the network", async () => {
    const cancel = new CancelFlag();
    cancel.store(true);
    const text = await generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m", { cancel });
    expect(text).toBe("");
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("a dead engine surfaces as the OLLAMA_DOWN sentinel, not a raw network error", async () => {
    vi.mocked(ensureUp).mockResolvedValue(await deadBaseUrl());
    await expect(generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "5m")).rejects.toThrow("OLLAMA_DOWN");
  });

  it("re-tags a missing model as MODEL_MISSING:<model>", async () => {
    await sidecarAt((_req, res) => reply(res, 404, { code: "MODEL_MISSING", error: "not pulled" }));
    await expect(generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m")).rejects.toThrow(
      "MODEL_MISSING:qwen3.5:4b"
    );
  });

  it("passes OLLAMA_DOWN straight through", async () => {
    await sidecarAt((_req, res) => reply(res, 503, { code: "OLLAMA_DOWN", error: "connection refused" }));
    await expect(generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m")).rejects.toThrow("OLLAMA_DOWN");
  });

  // ---------------------------------------------------------------- PRIV-1

  it("attaches the room policy for a NON-LOCAL model when the door is on", async () => {
    setActivePolicyForTests();
    const seen = await captureBody(200, { text: "ok" });
    // The "-cloud" suffix is declared non-local by `capabilities.ts` no matter
    // where the Closet/base-URL override points.
    await generate("qwen3.5:4b-cloud", [{ role: "user", content: "hi" }], null, "30m");
    expect(seen()?.privacy).toMatchObject({ active: true });
  });

  it("attaches NO policy for a local model, even with the door on", async () => {
    setActivePolicyForTests();
    const seen = await captureBody(200, { text: "ok" });
    await generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m");
    const body = seen();
    expect(body).toBeDefined();
    expect(body && "privacy" in body).toBe(false);
  });

  // ------------------------------------------------------- provider runtime

  it("attaches the provider-runtime wire shape for an OpenRouter model", async () => {
    const seen = await captureBody(200, { text: "ok" });
    await generate("openrouter::some/model", [{ role: "user", content: "hi" }], null, "30m", {
      providerDeps: fakeProviderDeps,
    });
    expect(seen()?.provider).toMatchObject({ id: "openrouter", api_key: "fake-key-123", model: "some/model" });
  });

  it("attaches NO provider key for an ordinary Ollama model", async () => {
    const seen = await captureBody(200, { text: "ok" });
    await generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m", {
      providerDeps: fakeProviderDeps,
    });
    const body = seen();
    expect(body).toBeDefined();
    expect(body && "provider" in body).toBe(false);
  });

  it("rejects (never silently generates) when a provider model has no saved key", async () => {
    await sidecarAt((_req, res) => reply(res, 200, { text: "should never be reached" }));
    const noKeyDeps: ProviderDeps = {
      ...fakeProviderDeps,
      readKey: () => {
        throw new Error("No API key is saved for openrouter");
      },
    };
    await expect(
      generate("openrouter::some/model", [{ role: "user", content: "hi" }], null, "30m", { providerDeps: noKeyDeps })
    ).rejects.toThrow(/no OpenRouter API key is saved/);
  });

  // ------------------------------------------------- a Stop DURING the prelude

  it("a Stop that lands during the provider-catalog fetch wins over the prelude's own error", async () => {
    // Rust races the WHOLE `sidecar_post` future — `inject_policy`,
    // `ensure_provider_catalog`'s FETCH and `inject_provider_runtime` included —
    // against a 100 ms cancel poll, and a flag set during it returns
    // `Ok(json!({"text": ""}))` (ollama.rs:263-278). The prelude's own error must
    // therefore never outrank a Stop the user already pressed: doing so puts an
    // "AI error" dialog in front of someone who pressed Stop, the exact failure
    // `sidecarJsonCancellable.ts` documents refusing for the network hop.
    //
    // The story: a first-ever OpenRouter turn in a fresh process, so the catalog
    // is fetched (slow — it is a large document); mid-fetch the user presses Stop
    // and the key stops resolving (Settings → Cloud AI → Disconnect).
    await sidecarAt((_req, res) => reply(res, 200, { text: "should never be reached" }));
    const cancel = new CancelFlag();
    let reads = 0;
    const disconnectedMidFetchDeps: ProviderDeps = {
      ...fakeProviderDeps,
      readKey: () => {
        reads += 1;
        if (reads > 1) {
          throw new Error("No API key is saved for openrouter");
        }
        return "fake-key-123";
      },
      fetchJson: async () => {
        cancel.store(true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw new Error("catalog fetch failed");
      },
    };
    const text = await generate("openrouter::some/model", [{ role: "user", content: "hi" }], null, "30m", {
      cancel,
      providerDeps: disconnectedMidFetchDeps,
    });
    expect(text).toBe("");
  });

  // --------------------------------------------- malformed / oversized bodies

  it("a 200 whose body is not JSON at all rejects — never a fabricated answer", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>a captive-portal login page</html>");
    });
    await expect(generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m")).rejects.toThrow(
      /Local AI error \(200\)/
    );
  });

  it("reads '' from a body that is JSON but not an object", async () => {
    // Rust's `value["text"]` on a `Value::Null` / `Value::Array` yields
    // `Value::Null`, so `as_str().unwrap_or_default()` is "".
    for (const payload of ["null", "[1,2,3]", '"just a string"']) {
      await sidecarAt((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
      });
      expect(await generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m")).toBe("");
      await closeServer();
    }
  });

  it("an own __proto__ key in the reply neither answers nor pollutes Object.prototype", async () => {
    await sidecarAt((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"__proto__":{"text":"fabricated"},"other":1}');
    });
    expect(await generate("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "30m")).toBe("");
    expect(({} as Record<string, unknown>).text).toBeUndefined();
  });

  it("carries an oversized turn and an oversized answer through whole, never truncated", async () => {
    const bigIn = "y".repeat(4 * 1024 * 1024);
    const bigOut = "x".repeat(4 * 1024 * 1024);
    let sentLength = -1;
    await sidecarAt((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        sentLength = (JSON.parse(raw) as { messages: SidecarChatMessage[] }).messages[0]!.content.length;
        reply(res, 200, { text: bigOut });
      });
    });
    expect(await generate("qwen3.5:4b", [{ role: "user", content: bigIn }], null, "30m")).toBe(bigOut);
    expect(sentLength).toBe(bigIn.length);
  });
});

// ============================================================================
// chatStructured
// ============================================================================

describe("chatStructured", () => {
  const schema = { type: "object", properties: { name: { type: "string" } } };

  it("grounds the schema on the last user message, sends format:schema, and recovers a fenced reply", async () => {
    const seen = await captureBody(200, { text: '```json\n{"name":"Ada"}\n```' });
    const messages: SidecarChatMessage[] = [
      { role: "system", content: "be helpful" },
      { role: "user", content: "extract the name" },
    ];
    const result = await chatStructured("qwen3.5:4b", messages, 0.0, "2m", schema);
    expect(result).toBe('{"name":"Ada"}');

    const body = seen();
    expect(body).toMatchObject({
      model: "qwen3.5:4b",
      base_url: "http://127.0.0.1:11434",
      temperature: 0,
      keep_alive: "2m",
      format: schema,
    });
    const sent = body!.messages as SidecarChatMessage[];
    expect(sent[0]!.content).toBe("be helpful"); // the system turn is untouched
    expect(sent[1]!.content).toBe(
      "extract the name\n\nReply with ONLY JSON matching this schema, filling every field with real content:\n" +
        JSON.stringify(schema)
    );
    // The caller's own array was not mutated in place.
    expect(messages[1]!.content).toBe("extract the name");
  });

  it("leaves messages untouched when there is no user turn at all", async () => {
    const seen = await captureBody(200, { text: "{}" });
    await chatStructured("qwen3.5:4b", [{ role: "system", content: "only a system message" }], null, "30m", schema);
    const sent = seen()!.messages as SidecarChatMessage[];
    expect(sent[0]!.content).toBe("only a system message");
  });

  it("strips a <think> preamble as well as a fence", async () => {
    await sidecarAt((_req, res) => reply(res, 200, { text: '<think>hmm</think>\n```json\n{"a":"y"}\n```' }));
    const out = await chatStructured("qwen3.5:4b", [{ role: "user", content: "go" }], null, "30m", schema);
    expect(out).toBe('{"a":"y"}');
  });

  it("resolves '' when already cancelled, without touching the network", async () => {
    const cancel = new CancelFlag();
    cancel.store(true);
    const out = await chatStructured("qwen3.5:4b", [{ role: "user", content: "go" }], null, "30m", schema, { cancel });
    expect(out).toBe("");
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("a Stop MID-CALL resolves empty text rather than throwing", async () => {
    const cancel = new CancelFlag();
    let release: (() => void) | undefined;
    await sidecarAt((_req, res) => {
      // Hold the response open long enough for the 100ms cancel poll to fire.
      release = () => reply(res, 200, { text: '{"name":"too late"}' });
    });
    const promise = chatStructured("qwen3.5:4b", [{ role: "user", content: "hi" }], null, "2m", schema, { cancel });
    setTimeout(() => cancel.store(true), 30);
    expect(await promise).toBe("");
    release?.();
  });

  it("rejects with the classified sentinel on an engine error", async () => {
    await sidecarAt((_req, res) => reply(res, 500, { code: "ENGINE_ERROR", error: "boom" }));
    await expect(
      chatStructured("qwen3.5:4b", [{ role: "user", content: "go" }], null, "30m", schema)
    ).rejects.toThrow("Local AI error (500): boom");
  });
});
