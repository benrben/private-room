import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Node as CancelNode } from "./cancel.js";
import {
  MAX_REQUEST_BODY,
  McpBridge,
  PROTOCOL_VERSION,
  STOPPED_REFUSAL_TEXT,
  authorize,
  ctEq,
  declaredBodySize,
  dispatchJsonRpc,
  includeMcp,
  type ToolCallResult,
  type ToolDispatcher,
  type ToolScope,
  type ToolSpec,
} from "./mcpBridge.js";

// Port of the WIRE TRANSPORT behaviour of src-tauri/src/room_mcp.rs (module
// doc lines 1-38; authorize/ct_eq lines 730-752; read_framed_request /
// MAX_REQUEST_BODY lines 664-728; serve_conn lines 605-656; dispatch_jsonrpc
// lines 756-850). The tool catalog and exec_tool dispatch are explicitly out
// of scope for this batch — see mcpBridge.ts's module doc — so every test
// here drives the transport against a small FAKE ToolDispatcher.
//
// The cross-language half of this batch's coverage lives in
// sidecar/tests/test_mcp_bridge_wire_compat.py, which runs the REAL
// arcelle_sidecar.mcp_client.McpClient against this bridge over a real
// socket. This file owns everything that client cannot reach: the oversize
// guard, the constant-time compare, and the shutdown severing.

const TOKEN = "test-token-0123456789abcdef";
const LOCAL_ENGINE: ToolScope = { kind: "LocalEngine" };

const FAKE_TOOLS: ToolSpec[] = [
  {
    name: "echo",
    description: "Echoes back its text argument.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "boom",
    description: "Always fails.",
    inputSchema: { type: "object", properties: {} },
    // The real catalog attaches these (arcelle_tool_annotations); they must
    // survive tools/list untouched.
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
];

interface FakeDispatcher extends ToolDispatcher {
  calls: Array<{ name: string; args: Record<string, unknown>; bodyBytes: number }>;
}

function makeFakeDispatcher(): FakeDispatcher {
  const calls: FakeDispatcher["calls"] = [];
  return {
    calls,
    listTools: () => FAKE_TOOLS,
    callTool: async (_scope, name, args): Promise<ToolCallResult> => {
      calls.push({ name, args, bodyBytes: JSON.stringify(args).length });
      if (name === "echo") {
        return { isError: false, content: [{ type: "text", text: String(args.text ?? "") }] };
      }
      if (name === "boom") {
        return { isError: true, content: [{ type: "text", text: "boom failed on purpose" }] };
      }
      return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
    },
  };
}

async function dispatch(
  body: unknown,
  opts: {
    dispatcher?: ToolDispatcher;
    cancelFlag?: { load(): boolean };
    raw?: string;
  } = {}
): Promise<{ status: number; bodyLength: number; reply: Record<string, any> | null }> {
  const buffer = Buffer.from(opts.raw ?? JSON.stringify(body), "utf8");
  const result = await dispatchJsonRpc(
    buffer,
    LOCAL_ENGINE,
    opts.dispatcher ?? makeFakeDispatcher(),
    opts.cancelFlag,
    "9.9.9-test"
  );
  return {
    status: result.status,
    bodyLength: result.body.length,
    reply: result.body.length === 0 ? null : JSON.parse(result.body.toString("utf8")),
  };
}

// ---------------------------------------------------------------------------
// live bridges, torn down after every test
// ---------------------------------------------------------------------------

let live: McpBridge[] = [];

afterEach(async () => {
  await Promise.all(live.map((b) => b.stop()));
  live = [];
});

async function startBridge(
  opts: { cancelFlag?: { load(): boolean }; dispatcher?: ToolDispatcher } = {}
): Promise<{ bridge: McpBridge; url: string; dispatcher: FakeDispatcher }> {
  const dispatcher = (opts.dispatcher as FakeDispatcher | undefined) ?? makeFakeDispatcher();
  const bridge = new McpBridge({
    token: TOKEN,
    scope: LOCAL_ENGINE,
    dispatcher,
    cancelFlag: opts.cancelFlag,
    serverVersion: "9.9.9-test",
  });
  await bridge.listen();
  live.push(bridge);
  return { bridge, url: bridge.url, dispatcher };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * One raw HTTP exchange on a socket we control, for everything `fetch` cannot
 * express: a `Content-Length` that lies, a body deliberately larger than the
 * cap, a second pipelined request after a refusal, and the exact bytes on the
 * wire. Resolves once the socket closes or `settleAfterMs` elapses.
 */
function rawExchange(
  port: number,
  head: string,
  bodyChunks: Buffer[],
  opts: { pipelineAfterResponse?: string; settleAfterMs?: number; settleOnResponses?: number } = {}
): Promise<{ raw: string; status: number | null; responses: number; severed: boolean }> {
  return new Promise((resolve) => {
    let raw = "";
    let pipelined = false;
    let severed = false;
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(head);
      void (async () => {
        for (const chunk of bodyChunks) {
          if (socket.destroyed || socket.writableEnded) {
            break;
          }
          socket.write(chunk);
          await new Promise((r) => setImmediate(r));
        }
      })();
    });
    const settle = (): void => {
      const statusLine = raw.split("\r\n")[0] ?? "";
      const match = /^HTTP\/1\.\d (\d+)/.exec(statusLine);
      clearTimeout(timer);
      socket.destroy();
      resolve({
        raw,
        status: match?.[1] !== undefined ? Number(match[1]) : null,
        responses: (raw.match(/HTTP\/1\.\d \d\d\d/g) ?? []).length,
        severed,
      });
    };
    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
      if (
        opts.settleOnResponses !== undefined &&
        (raw.match(/HTTP\/1\.\d \d\d\d/g) ?? []).length >= opts.settleOnResponses
      ) {
        settle();
        return;
      }
      const followUp = opts.pipelineAfterResponse;
      if (followUp !== undefined && !pipelined && raw.includes("\r\n\r\n")) {
        pipelined = true;
        setTimeout(() => {
          if (socket.destroyed || socket.writableEnded) {
            return;
          }
          socket.write(followUp);
        }, 80);
      }
    });
    // A peer that resets us mid-upload is itself an observable outcome, not a
    // test failure — record it rather than throwing out of a listener.
    socket.on("error", () => {
      severed = true;
    });
    socket.on("close", () => {
      severed = true;
      settle();
    });
    const timer = setTimeout(settle, opts.settleAfterMs ?? 1500);
  });
}

/**
 * A peer that keeps pushing body bytes on a SLOW schedule — one chunk every
 * `everyMs` for `pushForMs` — and never reads until it is done writing, which
 * is exactly what the real client does (`httpx` writes the whole request
 * before it reads a byte of the reply).
 *
 * `rawExchange` cannot express this: its chunk loop yields with
 * `setImmediate`, so a whole upload lands inside a single event-loop turn and
 * a drain that stalls after 500 ms still looks healthy. Reports WHEN the
 * server severed us, so "severed while the peer was still uploading" is an
 * assertable outcome rather than a coin flip.
 */
function trickleUpload(
  port: number,
  head: string,
  chunk: Buffer,
  opts: { pushForMs: number; everyMs?: number }
): Promise<{ status: number | null; closedAtMs: number | null; bytesSent: number; body: string }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let raw = "";
    let bytesSent = 0;
    let closedAtMs: number | null = null;
    let done = false;
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(head);
      const pump = setInterval(() => {
        if (socket.destroyed || socket.writableEnded) {
          clearInterval(pump);
          return;
        }
        socket.write(chunk);
        bytesSent += chunk.length;
      }, opts.everyMs ?? 100);
      setTimeout(() => clearInterval(pump), opts.pushForMs);
    });
    const settle = (): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const statusLine = raw.split("\r\n")[0] ?? "";
      const match = /^HTTP\/1\.\d (\d+)/.exec(statusLine);
      resolve({
        status: match?.[1] !== undefined ? Number(match[1]) : null,
        closedAtMs,
        bytesSent,
        body: raw,
      });
    };
    socket.on("data", (data) => {
      raw += data.toString("latin1");
    });
    socket.on("error", () => {
      /* an RST from the server is an outcome, recorded via `close` below */
    });
    socket.on("close", () => {
      closedAtMs ??= Date.now() - startedAt;
      settle();
    });
    // A settle margin past the push window, so a healthy drain gets to report
    // "still open while I was pushing" rather than racing the assertion.
    const timer = setTimeout(settle, opts.pushForMs + 400);
  });
}

// ---------------------------------------------------------------------------
// ToolScope
// ---------------------------------------------------------------------------

describe("ToolScope.includeMcp", () => {
  it("a plain CloudAdvisor follows its own sub-option; every other tier is always true", () => {
    expect(includeMcp({ kind: "CloudAdvisor", includeMcp: true })).toBe(true);
    expect(includeMcp({ kind: "CloudAdvisor", includeMcp: false })).toBe(false);
    expect(includeMcp({ kind: "CloudEngine" })).toBe(true);
    expect(includeMcp({ kind: "LocalEngine" })).toBe(true);
    expect(includeMcp({ kind: "ExternalAgent" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ctEq / authorize
// ---------------------------------------------------------------------------

describe("ctEq (ct_eq_rejects_length_and_content_mismatch)", () => {
  it("matches identical bytes and rejects any content difference", () => {
    expect(ctEq(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(ctEq(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
    expect(ctEq(Buffer.from(""), Buffer.from(""))).toBe(true);
  });

  it("rejects a length mismatch instead of throwing the way a bare timingSafeEqual does", () => {
    // crypto.timingSafeEqual REFUSES mismatched-length buffers outright, so a
    // naive port throws here and a wrong-length token becomes a 500 (or a
    // crash) rather than a 401.
    expect(() => ctEq(Buffer.from("abc"), Buffer.from("ab"))).not.toThrow();
    expect(ctEq(Buffer.from("abc"), Buffer.from("ab"))).toBe(false);
    expect(ctEq(Buffer.from("ab"), Buffer.from("abc"))).toBe(false);
    expect(ctEq(Buffer.from("short"), Buffer.from("a lot longer than that"))).toBe(false);
  });

  it("rejects the real token followed by NUL padding, at EVERY padding length", () => {
    // The regression this exists for: folding the length difference into a
    // single u8 (as `ct_eq` does with `(a.len() ^ b.len()) as u8`) makes any
    // difference that is a multiple of 256 vanish, and the zero-padded byte
    // compare then passes because the padding IS zero. `Bearer <token>`
    // followed by exactly 256 NUL bytes would authenticate.
    const expected = Buffer.from(`Bearer ${TOKEN}`, "utf8");
    for (const pad of [1, 2, 255, 256, 257, 511, 512, 768, 1024]) {
      const forged = Buffer.concat([expected, Buffer.alloc(pad)]);
      expect(ctEq(forged, expected), `padding of ${pad} NUL bytes was accepted`).toBe(false);
      expect(ctEq(expected, forged), `padding of ${pad} NUL bytes was accepted`).toBe(false);
    }
  });
});

describe("authorize (authorize_reads_the_bearer_header)", () => {
  it("accepts the exact bearer header and rejects everything else", () => {
    expect(authorize(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authorize("Bearer wrong", TOKEN)).toBe(false);
    expect(authorize(undefined, TOKEN)).toBe(false);
    expect(authorize("", TOKEN)).toBe(false);
    expect(authorize(TOKEN, TOKEN)).toBe(false); // the scheme is part of the value
    // A prefix of the real token must be rejected too.
    expect(authorize(`Bearer ${TOKEN.slice(0, 8)}`, TOKEN)).toBe(false);
    // Trimmed, same as the Rust source trims the header value.
    expect(authorize(`  Bearer ${TOKEN}  `, TOKEN)).toBe(true);
  });

  it("rejects a NUL-padded bearer value", () => {
    // NUL, not whitespace: `.trim()` would strip trailing spaces and the
    // value would (correctly) be the real token again.
    const nul = String.fromCharCode(0);
    expect(authorize(`Bearer ${TOKEN}${nul.repeat(256)}`, TOKEN)).toBe(false);
    expect(authorize(`Bearer ${TOKEN}${nul.repeat(512)}`, TOKEN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// declaredBodySize
// ---------------------------------------------------------------------------

describe("declaredBodySize", () => {
  it("reads a decimal declaration and refuses to be fooled by an absurd one", () => {
    expect(declaredBodySize("0")).toBe(0);
    expect(declaredBodySize(String(MAX_REQUEST_BODY))).toBe(MAX_REQUEST_BODY);
    expect(declaredBodySize(` ${MAX_REQUEST_BODY + 1} `)).toBe(MAX_REQUEST_BODY + 1);
    expect(declaredBodySize(["42", "43"])).toBe(42);
    expect(declaredBodySize(undefined)).toBeNull();
    expect(declaredBodySize("not-a-number")).toBeNull();
    expect(declaredBodySize("-1")).toBeNull();
    expect(declaredBodySize("1e9")).toBeNull();
    // The declaration is attacker-chosen: a value too large to be an exact
    // JS integer must still read as "over the cap", never as "unknown, go
    // ahead and stream it".
    expect(declaredBodySize("9".repeat(30))).toBe(Number.POSITIVE_INFINITY);
    expect(declaredBodySize("9".repeat(30))! > MAX_REQUEST_BODY).toBe(true);
    expect(declaredBodySize("0".repeat(20) + "5")).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// dispatchJsonRpc — pure, no socket
// ---------------------------------------------------------------------------

describe("dispatchJsonRpc", () => {
  it("initialize echoes the requested protocol version and names the server", async () => {
    const { status, reply } = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(status).toBe(200);
    expect(reply?.result).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "arcelle", version: "9.9.9-test" },
    });
  });

  it("initialize falls back to the bridge's own protocol version when the client names none", async () => {
    const { reply } = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(reply?.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(PROTOCOL_VERSION).toBe("2024-11-05"); // matches mcp_client.py's constant
  });

  it("a request with no id key is a notification: 202 and a body of ZERO bytes", async () => {
    // Not `{}`, not `null`, not a space: McpClient.notify() is documented to
    // never parse this, and anything non-empty here would still "work" today
    // and quietly become load-bearing tomorrow.
    const { status, bodyLength } = await dispatch({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(status).toBe(202);
    expect(bodyLength).toBe(0);
  });

  it("an id of null is NOT a notification (the key is present) and gets a real reply", async () => {
    const { status, reply } = await dispatch({ jsonrpc: "2.0", id: null, method: "ping" });
    expect(status).toBe(200);
    expect(reply).toEqual({ jsonrpc: "2.0", id: null, result: {} });
  });

  it("unparseable JSON gets 400", async () => {
    expect((await dispatch(null, { raw: "not json{" })).status).toBe(400);
    expect((await dispatch(null, { raw: "" })).status).toBe(400);
  });

  it("a well-formed body that is not an object is a notification, exactly as it is in Rust", async () => {
    // dispatch_jsonrpc holds a serde_json::Value of ANY shape and asks it for
    // "id"; a non-object answers None, which is the notification path. A
    // JSON-RPC batch array is the realistic case, and answering 400 where the
    // host answers 202 is a wire difference nothing else would catch.
    for (const raw of ["null", "5", "true", '"hi"', "[1,2]", '[{"jsonrpc":"2.0","id":1}]']) {
      const { status, bodyLength } = await dispatch(null, { raw });
      expect(status, `body ${raw}`).toBe(202);
      expect(bodyLength, `body ${raw}`).toBe(0);
    }
  });

  it("an unknown method returns a real JSON-RPC error, code -32601", async () => {
    const { status, reply } = await dispatch({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(status).toBe(200);
    expect(reply?.error).toEqual({ code: -32601, message: "method not found: resources/list" });
    expect(reply?.result).toBeUndefined();
  });

  it("tools/list hands the dispatcher's specs through untouched, annotations included", async () => {
    const { reply } = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    // Rebuilding each spec from its three known fields would silently drop
    // the annotations the real catalog attaches.
    expect(reply?.result.tools).toEqual(FAKE_TOOLS);
    expect(reply?.result.tools[1].annotations).toEqual({
      destructiveHint: false,
      readOnlyHint: true,
    });
  });

  it("tools/call passes name and arguments through and returns the tool's own result", async () => {
    const dispatcher = makeFakeDispatcher();
    const { reply } = await dispatch(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      },
      { dispatcher }
    );
    expect(dispatcher.calls).toEqual([{ name: "echo", args: { text: "hello" }, bodyBytes: 16 }]);
    // Exactly the shape mcp_client.py's `_parse_tool_result` reads.
    expect(reply?.result).toEqual({ isError: false, content: [{ type: "text", text: "hello" }] });
  });

  it("a tool FAILURE is a normal result with isError:true, never a JSON-RPC error", async () => {
    const { reply } = await dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    expect(reply?.error).toBeUndefined();
    expect(reply?.result).toEqual({
      isError: true,
      content: [{ type: "text", text: "boom failed on purpose" }],
    });
  });

  it("initialize / ping / tools-list all still succeed on an already-cancelled run", async () => {
    // Refusing tools/list would report an EMPTY CATALOG, which the Main agent
    // surfaces as "the room tool bridge served 0 tools" — a clean user Stop
    // reading as a wiring failure.
    const cancelFlag = { load: () => true };
    for (const method of ["initialize", "ping", "tools/list"]) {
      const { status, reply } = await dispatch({ jsonrpc: "2.0", id: 1, method }, { cancelFlag });
      expect(status, method).toBe(200);
      expect(reply?.error, method).toBeUndefined();
    }
    expect(
      (await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { cancelFlag })).reply?.result
        .tools
    ).toEqual(FAKE_TOOLS);
  });

  it("tools/call on a cancelled run is refused BEFORE the dispatcher, as a normal result", async () => {
    const dispatcher = makeFakeDispatcher();
    const { status, reply } = await dispatch(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      { dispatcher, cancelFlag: { load: () => true } }
    );
    expect(status).toBe(200);
    expect(reply?.error).toBeUndefined();
    expect(reply?.result).toEqual({
      isError: true,
      content: [{ type: "text", text: STOPPED_REFUSAL_TEXT }],
    });
    // Stop lands BEFORE the side effect: the tool must never have run.
    expect(dispatcher.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the HTTP transport
// ---------------------------------------------------------------------------

describe("McpBridge over real HTTP", () => {
  it("a valid bearer succeeds", async () => {
    const { url } = await startBridge();
    const resp = await postJson(url, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("a wrong bearer gets 401 and a missing one gets 401", async () => {
    const { url } = await startBridge();
    expect(
      (await postJson(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer nope" }))
        .status
    ).toBe(401);
    expect((await postJson(url, { jsonrpc: "2.0", id: 1, method: "ping" }, {})).status).toBe(401);
  });

  it("a repeated Authorization header resolves to the FIRST one, exactly as the Rust source does", async () => {
    // Pinned because it is easy to "fix" into a divergence. Node's parser
    // treats `authorization` as a unique field and DROPS the duplicate, so the
    // first value is what the bridge sees; `header_value` in room_mcp.rs takes
    // the first match too. Both therefore accept real-then-junk and reject
    // junk-then-real, and any change that makes the two hosts disagree about a
    // smuggled header is a change worth failing a test over.
    const { bridge } = await startBridge();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const exchange = (authHeaders: string): Promise<{ status: number | null }> =>
      rawExchange(
        bridge.port as number,
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n${authHeaders}Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
        [Buffer.from(body, "utf8")],
        { settleOnResponses: 1, settleAfterMs: 2000 }
      );

    expect(
      (await exchange(`Authorization: Bearer ${TOKEN}\r\nAuthorization: junk\r\n`)).status
    ).toBe(200);
    expect(
      (await exchange(`Authorization: junk\r\nAuthorization: Bearer ${TOKEN}\r\n`)).status
    ).toBe(401);
  }, 20_000);

  it("a non-POST gets 405 (the optional SSE GET channel is not implemented)", async () => {
    const { url } = await startBridge();
    const resp = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(resp.status).toBe(405);
  });

  it("a notification puts 202 and a literally empty body ON THE WIRE", async () => {
    const { bridge } = await startBridge();
    const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const { raw, status } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      [Buffer.from(body, "utf8")],
      { settleAfterMs: 800 }
    );
    expect(status).toBe(202);
    const headerEnd = raw.indexOf("\r\n\r\n");
    expect(headerEnd).toBeGreaterThan(0);
    expect(raw.slice(headerEnd + 4)).toBe(""); // zero bytes after the head
    expect(raw.toLowerCase()).toContain("content-length: 0");
  });

  it("a tools/list + tools/call round trip returns exactly what mcp_client.py expects", async () => {
    const { url } = await startBridge();
    const list = await (await postJson(url, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    expect((list as any).result.tools).toEqual(FAKE_TOOLS);

    const call = await (
      await postJson(url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "boom", arguments: {} },
      })
    ).json();
    expect((call as any).result).toEqual({
      isError: true,
      content: [{ type: "text", text: "boom failed on purpose" }],
    });
  });

  it("a bearer of ANY wrong length is a clean 401, never a 500 and never a dropped socket", async () => {
    // `crypto.timingSafeEqual` THROWS on mismatched-length buffers. A port
    // that fed it the raw values would turn every wrong-length token into an
    // exception — caught by `handleRequest` and answered 500 — which is itself
    // an oracle: 401 would mean "right length, wrong bytes" and 500 would mean
    // "wrong length", handing a prober the one fact the constant-time compare
    // exists to hide. The unit test proves `ctEq` does not throw; this proves
    // the whole request path agrees, at lengths from empty to 8 KiB.
    const { url } = await startBridge();
    const forged = [
      "",
      "B",
      "Bearer ",
      `Bearer ${TOKEN.slice(0, 1)}`,
      `Bearer ${TOKEN.slice(0, TOKEN.length - 1)}`, // one byte short
      `Bearer ${TOKEN}x`, // one byte long
      `Bearer ${TOKEN}${"a".repeat(255)}`,
      `Bearer ${TOKEN}${"a".repeat(256)}`, // the u8 length-fold's blind spot
      `Bearer ${TOKEN}${"a".repeat(257)}`,
      `Bearer ${TOKEN}${"a".repeat(8192)}`,
      TOKEN, // the right token, no scheme
      `bearer ${TOKEN}`, // the scheme is compared byte for byte
    ];
    for (const authorization of forged) {
      const resp = await postJson(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization });
      expect(resp.status, `${authorization.length} bytes: ${authorization.slice(0, 24)}…`).toBe(401);
    }
    // Not a blanket refusal: the real one still works afterwards, on the same
    // bridge, so nothing above put it into a permanently-rejecting state.
    expect((await postJson(url, { jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(200);
  }, 20_000);

  it("a dispatcher that throws answers 500 instead of taking the process down", async () => {
    const exploding: ToolDispatcher = {
      listTools: () => [],
      callTool: async () => {
        throw new Error("the real exec_tool blew up");
      },
    };
    const { url } = await startBridge({ dispatcher: exploding });
    const resp = await postJson(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "x", arguments: {} },
    });
    expect(resp.status).toBe(500);
    // And the bridge is still serving afterwards.
    expect((await postJson(url, { jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// the cancel gate, wired to the REAL cancel tree over a REAL socket
// ---------------------------------------------------------------------------

describe("McpBridge + cancel.ts: a Stop mid-run, end to end", () => {
  it("serves everything until the Stop, then refuses ONLY tools/call — with the run's own node", async () => {
    // `mcpBridge.ts` declares `CancelFlagLike` structurally rather than
    // importing `cancel.ts`, and its doc claims `bridge.cancelFlag =
    // node.flag()` therefore "composes with no glue". Nothing tested that
    // claim: every other test here passes a hand-written `{ load: () => … }`,
    // which would keep passing if the two modules' notions of a flag had
    // drifted apart entirely. This wires the real thing — and it flips MID
    // RUN, on a live bridge, rather than starting cancelled, so it also
    // exercises the flag being READ PER REQUEST instead of captured at
    // construction.
    const run = CancelNode.root("this answer");
    const { url, dispatcher } = await startBridge({ cancelFlag: run.flag() });

    const before = await (
      await postJson(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "before the stop" } },
      })
    ).json();
    expect((before as any).result).toEqual({
      isError: false,
      content: [{ type: "text", text: "before the stop" }],
    });
    expect(dispatcher.calls).toHaveLength(1);

    // The Stop, exactly as `cancelId`/the UI's Stop button delivers it.
    const report = run.cancel();
    expect(report.stopped).toEqual(["this answer"]);

    // initialize / ping / tools/list are NOT gated: an empty catalog would
    // read as a wiring failure rather than a clean user Stop.
    const init = await (
      await postJson(url, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} })
    ).json();
    expect((init as any).result.serverInfo).toEqual({ name: "arcelle", version: "9.9.9-test" });
    expect((init as any).result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(
      (await (await postJson(url, { jsonrpc: "2.0", id: 3, method: "ping" })).json()) as any
    ).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    const list = await (await postJson(url, { jsonrpc: "2.0", id: 4, method: "tools/list" })).json();
    expect((list as any).result.tools).toEqual(FAKE_TOOLS);

    // …and tools/call is refused, as a NORMAL result the model can read.
    const after = await postJson(url, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "after the stop" } },
    });
    expect(after.status).toBe(200);
    const refusal = (await after.json()) as any;
    expect(refusal.error).toBeUndefined();
    expect(refusal.result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Stopped by the user — this tool was not run." }],
    });
    // Asserted against the literal string above AND the exported constant, so
    // neither a drifting constant nor a drifting literal can pass alone.
    expect(refusal.result.content[0].text).toBe(STOPPED_REFUSAL_TEXT);
    // Stop lands BEFORE the side effect: the tool never ran a second time.
    expect(dispatcher.calls).toHaveLength(1);
  }, 20_000);

  it("a child's Stop does not gate the run's bridge, and the run's Stop gates the child's", async () => {
    // The tree's whole point, seen from the bridge: two bridges on one run —
    // the ask's own and a delegated specialist's — must inherit Stop downward
    // and never upward.
    const run = CancelNode.root("this answer");
    const specialist = run.child("Flashcards");
    const parent = await startBridge({ cancelFlag: run.flag() });
    const child = await startBridge({ cancelFlag: specialist.flag() });
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "ok" } } };

    specialist.cancel();
    expect(((await (await postJson(child.url, call)).json()) as any).result.isError).toBe(true);
    expect(((await (await postJson(parent.url, call)).json()) as any).result).toEqual({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });

    // And the other direction, on a fresh child of the same run.
    const second = run.child("Mind map");
    const grandchild = await startBridge({ cancelFlag: second.flag() });
    run.cancel();
    for (const bridge of [parent, grandchild]) {
      const result = ((await (await postJson(bridge.url, call)).json()) as any).result;
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: STOPPED_REFUSAL_TEXT }] });
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// the oversize guard — driven with ACTUAL bytes, not just a length check
// ---------------------------------------------------------------------------

describe("McpBridge: the MAX_REQUEST_BODY guard", () => {
  const junk = Buffer.alloc(256 * 1024, 0x61);

  it("refuses a DECLARED oversize with 413 before asking for a single body byte", async () => {
    const { bridge, dispatcher } = await startBridge();
    const { status } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${MAX_REQUEST_BODY + 1}\r\n\r\n`,
      [] // deliberately send NO body: the declaration alone must be enough
    );
    expect(status).toBe(413);
    expect(dispatcher.calls).toEqual([]);
  });

  it("refuses an ACTUALLY oversized upload with 413 while it is still arriving", async () => {
    // The declaration-only test above would pass against a server that
    // happily buffers 8 MiB before checking anything. This one pushes real
    // bytes: 8 MiB behind a 64 MiB declaration.
    const { bridge, dispatcher } = await startBridge();
    const { status } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${64 * 1024 * 1024}\r\n\r\n`,
      Array.from({ length: 32 }, () => junk),
      { settleAfterMs: 4000 }
    );
    expect(status).toBe(413);
    expect(dispatcher.calls).toEqual([]);
  }, 20_000);

  it("refuses a LYING peer: 20 MiB chunked, with no Content-Length to check at all", async () => {
    // The declared-length guard cannot see this one — only the actual-bytes
    // cap can. A port with just the header check buffers the whole flood.
    const { bridge, dispatcher } = await startBridge();
    const { status } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
      Array.from({ length: 80 }, () =>
        Buffer.concat([Buffer.from(`${junk.length.toString(16)}\r\n`), junk, Buffer.from("\r\n")])
      ),
      { settleAfterMs: 4000 }
    );
    expect(status).toBe(413);
    expect(dispatcher.calls).toEqual([]);
  }, 20_000);

  it("SEVERS the connection after the refusal, rather than leaving it framing a body that never comes", async () => {
    // Node detaches the socket from the response before emitting `finish`, so
    // a `res.socket?.destroy()` scheduled there is a silent no-op and the
    // connection lingers open — still expecting the declared 16 MiB. That is
    // the same exhaustion posture the cap exists to close, moved from memory
    // to file descriptors, and a status-code-only assertion cannot see it.
    const { bridge } = await startBridge();
    const second = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    const { status, responses, severed } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${MAX_REQUEST_BODY + 1}\r\n\r\n`,
      [],
      {
        pipelineAfterResponse: `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${second.length}\r\n\r\n${second}`,
        settleAfterMs: 2500,
      }
    );
    expect(status).toBe(413);
    expect(responses).toBe(1); // the pipelined request was never served
    expect(severed).toBe(true); // and the socket really did close
  }, 20_000);

  it("keeps the connection usable when the refused body was fully drained", async () => {
    // The severing above is for a drain that never finished. A peer that
    // pushed its whole (refused) body left the framing intact, and the real
    // client is exactly that peer: httpx writes the entire request before it
    // reads a byte of the reply. Severing here would hand it a dead pooled
    // connection to trip over on its very next call — a flake in the shipped
    // app, not just in a test.
    const { bridge } = await startBridge();
    const oversized = Buffer.alloc(MAX_REQUEST_BODY + 1, 0x61);
    const second = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    const { raw, status, responses } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${oversized.length}\r\n\r\n`,
      // 256 KiB at a time, so the refusal really is written while the upload
      // is still in flight rather than after it.
      Array.from({ length: oversized.length / (256 * 1024) }, (_unused, i) =>
        oversized.subarray(i * 256 * 1024, (i + 1) * 256 * 1024)
      ).concat([oversized.subarray(oversized.length - 1)]),
      {
        pipelineAfterResponse: `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${second.length}\r\n\r\n${second}`,
        settleOnResponses: 2,
        settleAfterMs: 8000,
      }
    );
    expect(status).toBe(413);
    expect(responses).toBe(2);
    expect(raw).toContain('"result":{}');
  }, 30_000);

  it("keeps DRAINING a refused peer that is still pushing, on the declared path as well as the lying one", async () => {
    // The regression: `refuseOversize` armed its lingering drain from
    // `res.end`'s completion callback, and by then Node had already run its
    // own `resOnFinish` — which, for a request nothing had read yet, calls
    // `req._dump()`. That sets `_dumped` (the parser then DROPS body chunks
    // instead of pushing them) and removes every `data` listener. The drain's
    // `discard` therefore never fired, `armIdle()` was never re-armed, and the
    // socket was destroyed 500 ms after the refusal however hard the peer was
    // still uploading — an RST that discards the 413 the peer had not read
    // yet, which is the precise failure `refuseOversize`'s own doc says it
    // exists to prevent. The ACTUAL-bytes path (which had already attached a
    // `data` listener in `readCappedBody`, so Node skipped `_dump()`) drained
    // correctly, so the two paths disagreed and only this one was broken.
    const { bridge } = await startBridge();
    const port = bridge.port as number;
    const pushForMs = 1400;

    const declared = await trickleUpload(
      port,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${64 * 1024 * 1024}\r\n\r\n`,
      Buffer.alloc(4096, 0x61),
      { pushForMs }
    );
    expect(declared.status).toBe(413);
    expect(declared.bytesSent).toBeGreaterThan(0);
    expect(
      declared.closedAtMs === null || declared.closedAtMs >= pushForMs,
      `severed after ${declared.closedAtMs}ms while the peer was still uploading`
    ).toBe(true);

    // The lying-Content-Length path, as the control: it always behaved, and
    // must keep behaving identically.
    const big = Buffer.alloc(MAX_REQUEST_BODY + 1, 0x61);
    const lying = await trickleUpload(
      port,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${big.length.toString(16)}\r\n${big.toString("latin1")}\r\n`,
      Buffer.concat([Buffer.from("1000\r\n"), Buffer.alloc(4096, 0x61), Buffer.from("\r\n")]),
      { pushForMs }
    );
    expect(lying.status).toBe(413);
    expect(
      lying.closedAtMs === null || lying.closedAtMs >= pushForMs,
      `severed after ${lying.closedAtMs}ms while the peer was still uploading`
    ).toBe(true);
  }, 30_000);

  it("answers 413 on a declaration nothing could ever buffer, before a single body byte exists", async () => {
    // A terabyte, and then 19 nines — past `Number.MAX_SAFE_INTEGER`, so
    // `declaredBodySize` answers `Infinity` rather than a rounded value, and
    // still inside the `uint64` llhttp will parse at all, so it really does
    // reach our check. Neither can be pre-allocated (both are past Buffer's
    // maximum length), so a port that sized anything off the declaration would
    // throw here rather than answer; and the reply arrives while the peer has
    // sent ZERO body bytes, which is the strongest available proof that
    // nothing was buffered — there was nothing to buffer.
    const { bridge, dispatcher } = await startBridge();
    for (const declaration of [String(1024 ** 4), "9".repeat(19)]) {
      const startedAt = Date.now();
      const { status } = await rawExchange(
        bridge.port as number,
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${declaration}\r\n\r\n`,
        [], // not one byte of the declared body is ever sent
        { settleOnResponses: 1, settleAfterMs: 3000 }
      );
      expect(status, declaration).toBe(413);
      // Promptly: refused on the declaration, never waiting on bytes that are
      // never coming. The idle-linger sever is 500 ms, so anything near that
      // would mean the answer came from the timeout rather than the check.
      expect(Date.now() - startedAt, declaration).toBeLessThan(400);
      expect(dispatcher.calls, declaration).toEqual([]);
    }

    // Past `uint64` the request never reaches the bridge at all: llhttp
    // refuses the head itself with its own 400. `declaredBodySize`'s
    // `Infinity` branch above that width is therefore defence in depth, not
    // dead code — it is what keeps the exported function honest for a caller
    // that is not behind Node's parser — but it is NOT the layer a 30-digit
    // declaration is stopped by, and a test claiming otherwise would be
    // asserting llhttp's behaviour while believing it asserted ours.
    const { status } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${"9".repeat(30)}\r\n\r\n`,
      [],
      { settleOnResponses: 1, settleAfterMs: 3000 }
    );
    expect(status).toBe(400);
    expect(declaredBodySize("9".repeat(30))).toBe(Number.POSITIVE_INFINITY);
  }, 20_000);

  it("accepts a body of EXACTLY the cap, so the refusal is the cap and not something smaller", async () => {
    const { bridge } = await startBridge();
    const skeleton = { jsonrpc: "2.0", id: 1, method: "ping", pad: "" };
    const pad = "a".repeat(MAX_REQUEST_BODY - JSON.stringify(skeleton).length);
    const body = Buffer.from(JSON.stringify({ ...skeleton, pad }), "utf8");
    expect(body.length).toBe(MAX_REQUEST_BODY);

    const { status, raw } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      [body],
      { settleAfterMs: 4000 }
    );
    expect(status).toBe(200);
    expect(raw).toContain('"result":{}');
  }, 20_000);

  it("one byte over the cap, with no Content-Length, is refused", async () => {
    const { bridge } = await startBridge();
    const body = Buffer.alloc(MAX_REQUEST_BODY + 1, 0x61);
    const { status } = await rawExchange(
      bridge.port as number,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
      [
        Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from("\r\n")]),
        Buffer.from("0\r\n\r\n"),
      ],
      { settleOnResponses: 1, settleAfterMs: 8000 }
    );
    expect(status).toBe(413);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe("McpBridge.stop", () => {
  it("revokes a response whose dispatch was still running when the stop landed", async () => {
    // A tier downgrade or token rotation must not hand a result back on the
    // old scope. The side effects already happened; severing delivery is the
    // strongest guarantee available post-read.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ToolDispatcher = {
      listTools: () => [],
      callTool: async () => {
        await gate;
        return { isError: false, content: [{ type: "text", text: "too late" }] };
      },
    };
    const { bridge, url } = await startBridge({ dispatcher: slow });

    const pending = postJson(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    }).catch((err: unknown) => err);

    await new Promise((r) => setTimeout(r, 40));
    await bridge.stop();
    release();

    const outcome = await pending;
    if (outcome instanceof Response) {
      expect(await outcome.text().catch(() => "")).not.toContain("too late");
    } else {
      expect(outcome).toBeInstanceOf(Error);
    }
  }, 20_000);

  it("severs an idle keep-alive connection instead of waiting for the client to hang up", async () => {
    const { bridge, url } = await startBridge();
    // An MCP client holds ONE connection for a whole session; a stop that
    // waited for it would never return.
    expect((await postJson(url, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
    const started = Date.now();
    await bridge.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(postJson(url, { jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow();
  }, 20_000);
});
