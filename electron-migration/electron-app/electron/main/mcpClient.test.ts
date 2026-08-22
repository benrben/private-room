/**
 * Vitest port of `mcp.rs`'s `mod tests`, PLUS real protocol round-trips: a fake
 * stdio server and a fake HTTP server, both real, proving real
 * request/response cycles rather than that functions exist.
 *
 * The stdio half spawns `mcpFixtureStdioServer.mjs` as a REAL child process
 * over real pipes (not an in-process double) — the same shape as the Rust
 * source's own doc ("the pure pieces are unit-tested here; the interactive
 * orchestration needs a live server"), except the "live server" is a small
 * fixture instead of a real MCP package, so the suite has no network or
 * package-manager dependency.
 *
 * The HTTP half stands up a real `node:http` server on loopback.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  authErrorMessage,
  collectTools,
  configKey,
  connectMcpClient,
  flattenCallResult,
  isRemoteTransport,
  loginShellPath,
  MAX_TOOL_IMAGES,
  MAX_TOOL_IMAGE_B64,
  McpManager,
  parseHttpMessage,
  parseMcpConfig,
  pushStderrLine,
  sanitizeToolName,
  STDERR_TAIL_MAX,
  type ServerConfig,
  type Tool,
} from "./mcpClient.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "mcpFixtureStdioServer.mjs");

function stdioConfig(extraArgs: string[] = []): ServerConfig {
  return {
    transport: { kind: "stdio", command: process.execPath, args: [FIXTURE, ...extraArgs], env: {} },
    disabled: false,
  };
}

// ------------------------------------------------------------- pure parsing

describe("parseMcpConfig", () => {
  it("parses_standard_local_config", () => {
    const cfg = parseMcpConfig(
      `{"mcpServers": {"web": {"command": "uvx", "args": ["duckduckgo-mcp-server"], "env": {"DDG_REGION": "us-en"}, "disabled": true}}}`
    );
    expect(cfg.length).toBe(1);
    const [name, s] = cfg[0]!;
    expect(name).toBe("web");
    expect(s.disabled).toBe(true);
    expect(isRemoteTransport(s.transport)).toBe(false);
    if (s.transport.kind !== "stdio") throw new Error("expected stdio");
    expect(s.transport.command).toBe("uvx");
    expect(s.transport.args).toEqual(["duckduckgo-mcp-server"]);
    expect(s.transport.env["DDG_REGION"]).toBe("us-en");
  });

  it("parses_remote_http_config", () => {
    const cfg = parseMcpConfig(
      `{"mcpServers": {"gh": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer tok123"}}}}`
    );
    const [name, s] = cfg[0]!;
    expect(name).toBe("gh");
    expect(s.disabled).toBe(false);
    expect(isRemoteTransport(s.transport)).toBe(true);
    if (s.transport.kind !== "http") throw new Error("expected http");
    expect(s.transport.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(s.transport.headers["Authorization"]).toBe("Bearer tok123");
  });

  it("bare_url_is_remote_even_without_type", () => {
    const cfg = parseMcpConfig(`{"mcpServers": {"x": {"url": "https://ex.com/mcp"}}}`);
    expect(isRemoteTransport(cfg[0]![1].transport)).toBe(true);
  });

  it("rejects_bad_config", () => {
    expect(() => parseMcpConfig("not json")).toThrow();
    expect(() => parseMcpConfig(`{"servers": {}}`)).toThrow();
    expect(() => parseMcpConfig(`{"mcpServers": {"x": {"args": []}}}`)).toThrow();
    expect(() => parseMcpConfig(`{"mcpServers": {"x": {"type": "http"}}}`)).toThrow();
  });

  it("drops non-string args/env values rather than stringifying them", () => {
    const cfg = parseMcpConfig(`{"mcpServers":{"x":{"command":"c","args":["a",5,null],"env":{"A":"1","B":2}}}}`);
    const t = cfg[0]![1].transport;
    if (t.kind !== "stdio") throw new Error("expected stdio");
    expect(t.args).toEqual(["a"]);
    expect(t.env).toEqual({ A: "1" });
  });
});

it("sanitizes_tool_names", () => {
  expect(sanitizeToolName("fetch-page.v2")).toBe("fetch_page_v2");
  expect(sanitizeToolName("search")).toBe("search");
  // One astral character (an emoji) becomes exactly ONE underscore, matching
  // Rust's per-Unicode-scalar-value mapping rather than per-UTF-16-unit.
  expect(sanitizeToolName("a🚀b")).toBe("a_b");
});

describe("configKey", () => {
  it("config_key_identifies_an_unchanged_server", () => {
    const a = parseMcpConfig(`{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"A":"1","B":"2"}}}}`);
    const b = parseMcpConfig(`{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"B":"2","A":"1"}}}}`);
    expect(configKey(a[0]![1])).toBe(configKey(b[0]![1]));

    const off = parseMcpConfig(
      `{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"A":"1","B":"2"},"disabled":true}}}`
    );
    expect(configKey(a[0]![1])).toBe(configKey(off[0]![1]));

    for (const changed of [
      `{"mcpServers":{"web":{"command":"uvx","args":["other"],"env":{"A":"1","B":"2"}}}}`,
      `{"mcpServers":{"web":{"command":"npx","args":["ddg"],"env":{"A":"1","B":"2"}}}}`,
      `{"mcpServers":{"web":{"command":"uvx","args":["ddg"],"env":{"A":"9","B":"2"}}}}`,
    ]) {
      const c = parseMcpConfig(changed);
      expect(configKey(a[0]![1])).not.toBe(configKey(c[0]![1]));
    }

    // Remote: url and headers (the bearer) both count — a refreshed token must
    // reconnect rather than keep dialling with the old one.
    const h1 = parseMcpConfig(`{"mcpServers":{"gh":{"url":"https://x/mcp","headers":{"Authorization":"Bearer a"}}}}`);
    const h2 = parseMcpConfig(`{"mcpServers":{"gh":{"url":"https://x/mcp","headers":{"Authorization":"Bearer b"}}}}`);
    expect(configKey(h1[0]![1])).not.toBe(configKey(h2[0]![1]));
    expect(configKey(a[0]![1])).not.toBe(configKey(h1[0]![1]));
  });

  it("does_not_collide_on_unseparated_concatenation", () => {
    // Without separators, args ["ab","c"] and ["a","bc"] would join to the same
    // string. The record/unit separators must prevent that collision.
    const x = parseMcpConfig(`{"mcpServers":{"s":{"command":"c","args":["ab","c"]}}}`);
    const y = parseMcpConfig(`{"mcpServers":{"s":{"command":"c","args":["a","bc"]}}}`);
    expect(configKey(x[0]![1])).not.toBe(configKey(y[0]![1]));
  });
});

it("a manager reports one status row per server, naming its tools", () => {
  const mgr = new McpManager();
  expect(mgr.statuses()).toEqual([]);
  mgr.servers.push({
    name: "web",
    status: "connected",
    error: null,
    tools: [{ name: "search", description: "", schema: {}, annotations: null }],
    remote: false,
    client: null,
    configKey: "k",
  });
  mgr.servers.push({
    name: "gh",
    status: "failed",
    error: "nope",
    tools: [],
    remote: true,
    client: null,
    configKey: "k2",
  });
  expect(mgr.statuses()).toEqual([
    { name: "web", status: "connected", error: null, tools: ["search"], remote: false },
    { name: "gh", status: "failed", error: "nope", tools: [], remote: true },
  ]);
});

describe("pushStderrLine", () => {
  it("stderr_tail_trims_on_char_boundaries", () => {
    // A server that logs accents/emoji used to panic the reader task here in
    // Rust, which lost the real error AND left the child blocked on a full pipe.
    let tail = "";
    for (let i = 0; i < 40; i++) {
      tail = pushStderrLine(tail, "héllo wörld 🚀 — connector said something");
    }
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(STDERR_TAIL_MAX);
    expect(tail.endsWith("🚀 — connector said something\n")).toBe(true);
    // Every retained character is whole: a mangled cut shows up as U+FFFD when
    // the bytes are re-decoded.
    expect(tail).not.toContain("�");

    // A single line longer than the cap is kept whole-charactered too.
    const one = pushStderrLine("", "🚀".repeat(2000));
    expect(Buffer.byteLength(one, "utf8")).toBeLessThanOrEqual(STDERR_TAIL_MAX);
    expect(one.startsWith("🚀")).toBe(true);
    expect(one.endsWith("\n")).toBe(true);
    expect(one).not.toContain("�");

    // Under the cap, nothing is trimmed at all.
    expect(pushStderrLine("a\n", "b")).toBe("a\nb\n");
  });
});

describe("flattenCallResult", () => {
  it("flattens_tool_result_variants", () => {
    const ok = { content: [{ type: "text", text: "hello" }, { type: "audio", data: "…" }] };
    expect(flattenCallResult(ok).text).toBe("hello\n[audio content omitted]");

    const err = { content: [{ type: "text", text: "boom" }], isError: true };
    expect(() => flattenCallResult(err)).toThrow("boom");
    expect(() => flattenCallResult({ content: [], isError: true })).toThrow("Tool failed.");

    expect(flattenCallResult({ content: [] }).text).toBe("(no output)");

    const structured = { content: [], structuredContent: { n: 1 } };
    expect(flattenCallResult(structured).text).toBe(JSON.stringify({ n: 1 }));

    // An embedded resource's own text is the answer, not something to note as
    // omitted; a blob and a link are named, since neither is readable.
    const embedded = {
      content: [{ type: "resource", resource: { uri: "file:///x.md", mimeType: "text/plain", text: "the answer" } }],
    };
    expect(flattenCallResult(embedded).text).toBe("the answer");

    const blob = {
      content: [
        { type: "resource", resource: { uri: "file:///x.bin", mimeType: "application/octet-stream", blob: "AAAA" } },
      ],
    };
    const blobOut = flattenCallResult(blob).text;
    expect(blobOut).toContain("file:///x.bin");
    expect(blobOut).toContain("application/octet-stream");

    const link = { content: [{ type: "resource_link", uri: "file:///y.md", name: "y" }] };
    expect(flattenCallResult(link).text).toContain("file:///y.md");
    expect(flattenCallResult({ content: [{ type: "resource_link" }] }).text).toContain("no uri");

    // Neither text nor blob: say so rather than claim a binary payload.
    const hollow = { content: [{ type: "resource", resource: { uri: "file:///z" } }] };
    expect(flattenCallResult(hollow).text).toContain("carried no content");

    // A block whose `type` is not a string is SKIPPED, matching Rust's
    // `block["type"].as_str()` returning None — never described as
    // "[5 content omitted]".
    expect(flattenCallResult({ content: [{ type: 5 }, { text: "x" }] }).text).toBe("(no output)");
  });

  it("carries_a_connector_image_instead_of_omitting_it", () => {
    const shot = {
      content: [
        { type: "text", text: "here you go" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    };
    const out = flattenCallResult(shot);
    expect(out.images).toEqual(["AAAA"]);
    expect(out.text).toBe("here you go");

    // An image ALONE is a real result, not "(no output)".
    const bare = { content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }] };
    expect(flattenCallResult(bare).text).toBe("");
    expect(flattenCallResult(bare).images.length).toBe(1);

    // The three refusals are SAID, never silent — a model must not treat a
    // picture it did not get as one it did.
    const odd = { content: [{ type: "image", data: "AAAA", mimeType: "image/tiff" }] };
    const oddOut = flattenCallResult(odd);
    expect(oddOut.images.length).toBe(0);
    expect(oddOut.text).toContain("unsupported format");

    const huge = { content: [{ type: "image", data: "A".repeat(MAX_TOOL_IMAGE_B64 + 1), mimeType: "image/png" }] };
    const hugeOut = flattenCallResult(huge);
    expect(hugeOut.images.length).toBe(0);
    expect(hugeOut.text).toContain("too large");

    const many = Array.from({ length: MAX_TOOL_IMAGES + 2 }, () => ({
      type: "image",
      data: "A",
      mimeType: "image/png",
    }));
    const manyOut = flattenCallResult({ content: many });
    expect(manyOut.images.length).toBe(MAX_TOOL_IMAGES);
    expect(manyOut.text).toContain("further images omitted");
  });
});

it("collects_paginated_tools", () => {
  const into: Tool[] = [];
  const cursor = collectTools(
    { tools: [{ name: "a", description: "d", inputSchema: { type: "object", properties: {} } }], nextCursor: "p2" },
    into
  );
  expect(cursor).toBe("p2");
  expect(into.length).toBe(1);
  const end = collectTools({ tools: [{ name: "b" }] }, into);
  expect(end).toBeNull();
  expect(into.length).toBe(2);
  // A nameless record is not a tool, and a missing inputSchema becomes the
  // empty object schema rather than `undefined`.
  expect(collectTools({ tools: [{ description: "no name" }] }, into)).toBeNull();
  expect(into.length).toBe(2);
  expect(into[1]!.schema).toEqual({ type: "object", properties: {} });
});

it("preserves_tool_annotations_from_connector_catalogs", () => {
  const page = {
    tools: [
      {
        name: "lookup",
        description: "Look something up",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ],
  };
  const tools: Tool[] = [];
  expect(collectTools(page, tools)).toBeNull();
  expect(tools.length).toBe(1);
  expect(tools[0]!.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
});

describe("authErrorMessage", () => {
  it("distinguishes_signin_from_bad_token", () => {
    const signin = authErrorMessage("initialize", 401, 'Bearer resource_metadata="…"');
    expect(signin).toContain("sign in");
    expect(signin).toContain("Connect account");
    expect(signin).not.toContain("valid token");

    const bad = authErrorMessage("initialize", 401, null);
    expect(bad).toContain("valid token");
    expect(bad).toContain("401");
  });
});

describe("parseHttpMessage", () => {
  it("parses_json_and_sse_http_replies", () => {
    const json = `{"jsonrpc":"2.0","id":7,"result":{"ok":true}}`;
    const m = parseHttpMessage("application/json", json, 7) as Record<string, unknown>;
    expect((m["result"] as Record<string, unknown>)["ok"]).toBe(true);

    const sse =
      `event: message\ndata: {"jsonrpc":"2.0","method":"x"}\n\n` +
      `event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":1}}\n\n`;
    const m2 = parseHttpMessage("text/event-stream", sse, 7) as Record<string, unknown>;
    expect((m2["result"] as Record<string, unknown>)["ok"]).toBe(1);
    expect(parseHttpMessage("text/event-stream", sse, 99)).toBeUndefined();
    // An SSE body that never declares its content type is still recognised.
    expect(parseHttpMessage("", sse, 7)).toBeDefined();
    expect(parseHttpMessage("application/json", "not json", 1)).toBeUndefined();
  });
});

it("resolves a login-shell PATH once and reuses it", async () => {
  const first = await loginShellPath();
  expect(first).toContain("/opt/homebrew/bin");
  expect(first).toContain("/usr/local/bin");
  // The OnceLock equivalent: the second call is the same cached string.
  expect(await loginShellPath()).toBe(first);
});

// ---------------------------------------------------------- real stdio wire

describe("stdio transport (real child process)", () => {
  const clientsToClose: Array<{ close(): void }> = [];
  afterEach(() => {
    for (const c of clientsToClose.splice(0)) c.close();
  });

  it("connects, lists paginated tools, and round-trips a normal call", async () => {
    const { client, tools } = await connectMcpClient(stdioConfig());
    clientsToClose.push(client);
    // Page 1 has "echo"; page 2 has the rest — both pages must have been walked
    // via `cursor`.
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["boom", "die_with_stderr", "echo", "hang", "junk_then_ok", "loud_stderr", "null_error", "picture", "ping_me"].sort()
    );
    const boom = tools.find((t) => t.name === "boom")!;
    expect(boom.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });

    const out = await client.callTool("echo", { hello: "world" });
    expect(JSON.parse(out.text)).toEqual({ hello: "world" });
  });

  it("throws on a tool that reports isError", async () => {
    const { client } = await connectMcpClient(stdioConfig());
    clientsToClose.push(client);
    await expect(client.callTool("boom", {})).rejects.toThrow("kaboom");
  });

  it("carries an image the server returns", async () => {
    const { client } = await connectMcpClient(stdioConfig());
    clientsToClose.push(client);
    const out = await client.callTool("picture", {});
    expect(out.images).toEqual(["AAAA"]);
    expect(out.text).toBe("a picture");
  });

  it("skips a non-JSON line the server logs to stdout by mistake", async () => {
    const { client } = await connectMcpClient(stdioConfig());
    clientsToClose.push(client);
    const out = await client.callTool("junk_then_ok", {});
    expect(out.text).toBe("ok after junk");
  });

  it("answers a server-initiated ping with a stub pong, then reads the real reply", async () => {
    const { client } = await connectMcpClient(stdioConfig());
    clientsToClose.push(client);
    const out = await client.callTool("ping_me", {});
    expect(out.text).toBe("answered after pong");
  });

  it("a normal reply still arrives after the server chatters on stderr", async () => {
    const { client } = await connectMcpClient(stdioConfig());
    clientsToClose.push(client);
    const out = await client.callTool("loud_stderr", {});
    expect(out.text).toBe("done chattering");
  });

  it('treats an explicit "error": null beside a real result as the success it is', async () => {
    // Rust's stdio arm reads ANY present `error` member as a failure, so this
    // shape came back as "tools/call failed: unknown error" while its own HTTP
    // arm filtered the null out — see mcpClient.ts's second DEVIATION note.
    const { client } = await connectMcpClient(stdioConfig());
    clientsToClose.push(client);
    expect((await client.callTool("null_error", {})).text).toBe("fine, actually");
  });

  it("times out a call the server never answers, using the client's own short deadline", async () => {
    const { client } = await connectMcpClient(stdioConfig(), { callTimeoutMs: 200 });
    clientsToClose.push(client);
    await expect(client.callTool("hang", {})).rejects.toThrow("Server timed out on tools/call.");
  });

  it("reports the server's stderr tail when it exits without answering", async () => {
    const { client } = await connectMcpClient(stdioConfig());
    clientsToClose.push(client);
    await expect(client.callTool("die_with_stderr", {})).rejects.toThrow(/Server exited:.*goodbye/s);
  });

  it("reports a clear error when the command cannot be started", async () => {
    const cfg: ServerConfig = {
      transport: { kind: "stdio", command: "this-command-does-not-exist-xyz", args: [], env: {} },
      disabled: false,
    };
    await expect(connectMcpClient(cfg)).rejects.toThrow(/Could not start "this-command-does-not-exist-xyz"/);
  });

  it("uses the injected PATH resolver and the downloaded-runtime prefix", async () => {
    // `cached_path_prefix()` (a runtime the app provisioned into its own data
    // folder) has to go FIRST, or the download button fetches 45 MB into a
    // folder nothing looks in.
    let resolved = 0;
    const { client } = await connectMcpClient(stdioConfig(), {
      resolvePath: async () => {
        resolved += 1;
        return "/usr/bin:/bin";
      },
      cachedPathPrefix: "/provisioned/bin",
    });
    clientsToClose.push(client);
    expect(resolved).toBe(1);
    const out = await client.callTool("echo", {});
    expect(JSON.parse(out.text)).toEqual({});
  });
});

// ----------------------------------------------------------- real http wire

interface HttpFixtureOptions {
  requireSession?: boolean;
  respondSse?: boolean;
  requireAuth?: boolean;
}

interface HttpFixture {
  url: string;
  server: Server;
  seenSessionIds: string[];
  seenHeaders: Array<Record<string, string | string[] | undefined>>;
}

function startHttpFixture(opts: HttpFixtureOptions = {}): Promise<HttpFixture> {
  const seenSessionIds: string[] = [];
  const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const SESSION_ID = "sess-abc-123";
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seenHeaders.push({ ...req.headers });
        const sid = req.headers["mcp-session-id"];
        if (typeof sid === "string") seenSessionIds.push(sid);
        if (opts.requireAuth === true && req.headers["authorization"] !== "Bearer good-token") {
          res.writeHead(401, {
            "www-authenticate": 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"',
          });
          res.end();
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // ignore
        }
        const { id, method, params } = body as { id?: number; method?: string; params?: Record<string, unknown> };
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (opts.requireSession === true) headers["Mcp-Session-Id"] = SESSION_ID;

        if (method === "notifications/initialized") {
          res.writeHead(202, headers);
          res.end();
          return;
        }
        let result: unknown;
        switch (method) {
          case "initialize":
            result = { protocolVersion: "2025-06-18", capabilities: {} };
            break;
          case "tools/list":
            result =
              params !== undefined && params["cursor"] !== undefined
                ? { tools: [{ name: "remote_add", description: "adds", inputSchema: { type: "object", properties: {} } }] }
                : {
                    tools: [
                      { name: "remote_echo", description: "echoes", inputSchema: { type: "object", properties: {} } },
                    ],
                    nextCursor: "p2",
                  };
            break;
          case "tools/call": {
            const name = params?.["name"] as string;
            const args = params?.["arguments"] ?? {};
            if (name === "remote_echo") {
              result = { content: [{ type: "text", text: JSON.stringify(args) }] };
            } else if (name === "remote_boom") {
              result = { content: [{ type: "text", text: "remote kaboom" }], isError: true };
            } else {
              result = { content: [] };
            }
            break;
          }
          default:
            result = {};
        }
        const payload = { jsonrpc: "2.0", id, result };
        if (opts.respondSse === true) {
          headers["Content-Type"] = "text/event-stream";
          res.writeHead(200, headers);
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        } else {
          res.writeHead(200, headers);
          res.end(JSON.stringify(payload));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, server, seenSessionIds, seenHeaders });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("http transport (real loopback server)", () => {
  it("connects over plain JSON responses and round-trips a call", async () => {
    const { url, server } = await startHttpFixture();
    try {
      const { client, tools } = await connectMcpClient({ transport: { kind: "http", url, headers: {} }, disabled: false });
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["remote_add", "remote_echo"]);
      const out = await client.callTool("remote_echo", { q: "hi" });
      expect(JSON.parse(out.text)).toEqual({ q: "hi" });
      await expect(client.callTool("remote_boom", {})).rejects.toThrow("remote kaboom");
    } finally {
      await closeServer(server);
    }
  });

  it("accepts a text/event-stream reply", async () => {
    const { url, server } = await startHttpFixture({ respondSse: true });
    try {
      const { client } = await connectMcpClient({ transport: { kind: "http", url, headers: {} }, disabled: false });
      const out = await client.callTool("remote_echo", { a: 1 });
      expect(JSON.parse(out.text)).toEqual({ a: 1 });
    } finally {
      await closeServer(server);
    }
  });

  it("captures the Mcp-Session-Id and echoes it on later requests", async () => {
    const { url, server, seenSessionIds, seenHeaders } = await startHttpFixture({ requireSession: true });
    try {
      const { client } = await connectMcpClient({ transport: { kind: "http", url, headers: {} }, disabled: false });
      await client.callTool("remote_echo", {});
      // initialize + notifications/initialized + tools/list + tools/call = 4
      // requests; only the ones AFTER the server first assigned the id can have
      // echoed it back.
      expect(seenSessionIds.length).toBeGreaterThan(0);
      expect(seenHeaders.slice(1).every((h) => h["mcp-session-id"] === "sess-abc-123")).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("sends configured headers on every request", async () => {
    const { url, server, seenHeaders } = await startHttpFixture();
    try {
      await connectMcpClient({
        transport: { kind: "http", url, headers: { Authorization: "Bearer configured-token" } },
        disabled: false,
      });
      expect(seenHeaders.length).toBeGreaterThan(0);
      expect(seenHeaders.every((h) => h["authorization"] === "Bearer configured-token")).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("turns a 401 with WWW-Authenticate into a sign-in message", async () => {
    const { url, server } = await startHttpFixture({ requireAuth: true });
    try {
      await expect(connectMcpClient({ transport: { kind: "http", url, headers: {} }, disabled: false })).rejects.toThrow(
        /sign in/
      );
      // …and the same connector WITH the token gets through.
      const { client } = await connectMcpClient({
        transport: { kind: "http", url, headers: { Authorization: "Bearer good-token" } },
        disabled: false,
      });
      expect((await client.callTool("remote_echo", { ok: true })).text).toContain("ok");
    } finally {
      await closeServer(server);
    }
  });

  it("reports a connect failure for an unreachable host", async () => {
    // Port 1 on loopback should refuse immediately rather than hang.
    await expect(
      connectMcpClient(
        { transport: { kind: "http", url: "http://127.0.0.1:1/mcp", headers: {} }, disabled: false },
        { connectTimeoutMs: 2000 }
      )
    ).rejects.toThrow();
  });
});
