/**
 * Minimal MCP (Model Context Protocol) CLIENT — two transports. Ported from
 * `src-tauri/src/mcp.rs` (1146 lines).
 *
 * THIS IS ARCELLE ACTING AS AN MCP CLIENT reaching third-party MCP servers the
 * user configured (the "connector marketplace"). It is the opposite direction
 * from `mcpBridge.ts`/`bridgeDispatcher.ts`, where Arcelle is the MCP SERVER
 * for `claude -p`/`codex exec` — that pair never appears in this file, and this
 * file's `McpClient`/`McpManager` never appear in theirs. The only place the
 * two meet is `execTool.ts`'s connector-route arm (`execConnectorRoute`), which
 * calls a connected client's `callTool` through an injected
 * `ExecToolDeps.callConnectorTool` seam.
 *
 * A configured server is reached one of two ways:
 * - **Stdio**: a child process speaking newline-delimited JSON-RPC 2.0 on
 *   stdin/stdout. Runs on this Mac. Node's `child_process.spawn` stands in for
 *   `tokio::process::Command`.
 * - **Http** (the "marketplace"): a *remote* server reached over streamable
 *   HTTP (JSON-RPC POST, JSON or `text/event-stream` reply). This one leaves
 *   the Mac. Global `fetch` (Node 18+/undici) stands in for `reqwest` — MCP
 *   responses are bounded (one JSON-RPC message or a short SSE burst), unlike
 *   `sidecar.ts`'s long-lived NDJSON `/run` stream, so no `UndiciAgent` with
 *   disabled body timeouts is needed here.
 *
 * Just the client half is implemented: initialize, tools/list and tools/call.
 * Remote auth is header-based (a `Bearer` token in `headers`); `mcpOauth.ts`
 * populates that same header slot after an interactive sign-in.
 *
 * DEVIATION (documented, not a port slip): Rust's `StdioClient::request` reads
 * lines through a `tokio::time::timeout_at` whose underlying `next_line()`
 * future is DROPPED on timeout — any bytes already buffered by `BufReader` stay
 * available for the next read. This port's {@link LineReader} cannot un-arm a
 * settled `Promise`, so a line that arrives from the child AFTER this port's
 * client-side timeout has already fired is delivered to whichever `nextLine()`
 * call is active at that moment (typically the NEXT request) rather than being
 * replayed to the one that timed out. A server behaving normally enough to hit
 * this window is already failing its connect/call timeout and the connector
 * shows Failed either way, so this does not change any user-visible outcome —
 * it is called out here because it is the one place this port cannot be
 * bit-for-bit with `tokio`'s cancel-safety.
 *
 * DEVIATION (deliberate, one-line): a JSON-RPC reply carrying an explicit
 * `"error": null` alongside a real `result` is treated as a SUCCESS on both
 * transports. Rust's HTTP arm already filters that case
 * (`.filter(|e| !e.is_null())`); its stdio arm does not, and would fail an
 * otherwise-good connect with "initialize failed: unknown error". The two arms
 * are made to agree here, in the direction the HTTP one already chose.
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";

// ------------------------------------------------------------------- config

/** First connect may run `uvx`/`npx`, which downloads the server package. */
export const CONNECT_TIMEOUT_MS = 60_000;
/** Web searches and page fetches are legitimately slow. */
export const CALL_TIMEOUT_MS = 90_000;
const PROTOCOL_VERSION = "2025-06-18";
/** Stand-in for Rust's `env!("CARGO_PKG_VERSION")` — this migration has no
 * package-version plumbing into this file yet; a fixed literal is a faithful
 * "identify ourselves" value and never load-bearing for protocol behavior. */
const CLIENT_VERSION = "0.0.0-electron-migration";

/** How a configured server is reached. `disabled` lives on {@link ServerConfig}
 * because it is transport-independent. A tagged union stands in for Rust's
 * `enum Transport`. */
export type Transport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string> };

/** True for a remote endpoint — the seam where room data leaves the Mac.
 * Ported verbatim from `Transport::is_remote`. */
export function isRemoteTransport(t: Transport): boolean {
  return t.kind === "http";
}

export interface ServerConfig {
  transport: Transport;
  disabled: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A `{string: string}` map, dropping non-string values. Shared by `env`
 * (stdio) and `headers` (http) parsing. Ported from `string_map`. */
function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string") out[k] = val;
    }
  }
  return out;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A stable fingerprint of ONE server's transport — everything that decides
 * where a call goes and how. Two configs with the same key reach the same place
 * the same way, so an already-connected client can be carried across a config
 * apply instead of being torn down and dialled again. Without it, flipping one
 * connector's switch restarted every other connector. Ported verbatim from
 * `config_key`.
 */
export function configKey(cfg: ServerConfig): string {
  const pairs = (map: Record<string, string>): string => {
    const kv = Object.entries(map).map(([k, v]) => `${k}=${v}`);
    kv.sort(); // object key order is not a stable fingerprint input
    return kv.join("\u001e");
  };
  if (cfg.transport.kind === "stdio") {
    const { command, args, env } = cfg.transport;
    return `stdio\u001f${command}\u001f${args.join("\u001e")}\u001f${pairs(env)}`;
  }
  const { url, headers } = cfg.transport;
  return `http\u001f${url}\u001f${pairs(headers)}`;
}

/**
 * Parse the de-facto standard `{"mcpServers": {name: {…}}}` format used by
 * Claude Desktop and Cursor, so users can paste configs straight from any MCP
 * server's README. Two server shapes are accepted:
 * - **local**: `{"command": "uvx", "args": [...], "env": {...}}`
 * - **remote**: `{"type": "http", "url": "https://…", "headers": {...}}`
 *   (`type` is optional — a bare `"url"` is enough to mark it remote).
 * Extra key accepted on either: `"disabled"`.
 *
 * Throws with the Rust source's own wording on any malformed input — matching
 * this codebase's `Result<T, String>` → `throw new Error(String)` convention
 * (see `db-host/skills.ts`).
 *
 * Ported verbatim from `parse_config`.
 */
export function parseMcpConfig(json: string): Array<[string, ServerConfig]> {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (e) {
    throw new Error(`Config is not valid JSON: ${errMessage(e)}`);
  }
  const servers = isPlainObject(root) && isPlainObject(root["mcpServers"]) ? root["mcpServers"] : null;
  if (servers === null) {
    throw new Error('Config needs a top-level "mcpServers" object.');
  }
  const out: Array<[string, ServerConfig]> = [];
  for (const [name, raw] of Object.entries(servers)) {
    const s = isPlainObject(raw) ? raw : {};
    const disabled = s["disabled"] === true;
    // Remote if it declares an http/https type OR simply carries a url. A
    // "command" present alongside a url still means remote — the url wins,
    // matching how Claude Desktop treats `"type": "http"`.
    const ty = typeof s["type"] === "string" ? s["type"] : "";
    const hasUrl = typeof s["url"] === "string";
    let transport: Transport;
    if (ty === "http" || ty === "streamable-http" || ty === "sse" || hasUrl) {
      const url = s["url"];
      if (typeof url !== "string") {
        throw new Error(`Remote server "${name}" is missing "url".`);
      }
      transport = { kind: "http", url, headers: stringMap(s["headers"]) };
    } else {
      const command = s["command"];
      if (typeof command !== "string") {
        throw new Error(`Server "${name}" needs a "command" (local) or a "url" (remote).`);
      }
      const rawArgs = s["args"];
      const args = Array.isArray(rawArgs) ? rawArgs.filter((x): x is string => typeof x === "string") : [];
      transport = { kind: "stdio", command, args, env: stringMap(s["env"]) };
    }
    out.push([name, { transport, disabled }]);
  }
  return out;
}

/** Ollama tool names must stay plain for small local models: keep
 * `[a-zA-Z0-9_]`, replace the rest. Iterates by CODE POINT (`Array.from`), not
 * UTF-16 code unit, so one astral character (an emoji in a connector's tool
 * name) becomes exactly one `_`, matching Rust's per-`char` mapping rather than
 * replacing each surrogate half separately. Ported verbatim from
 * `sanitize_tool_name`. */
export function sanitizeToolName(s: string): string {
  return Array.from(s)
    .map((c) => (/^[a-zA-Z0-9_]$/.test(c) ? c : "_"))
    .join("");
}

// ------------------------------------------------------------------- state

export type Status = "connecting" | "connected" | "failed" | "disabled";

export interface Tool {
  name: string;
  description: string;
  schema: unknown;
  /** Standard MCP safety hints supplied by the connector. The room bridge
   * preserves these when it re-exports connected tools to an external agent;
   * without them non-interactive Codex rejects even read-only calls. */
  annotations: Record<string, unknown> | null;
}

export interface ServerStatus {
  name: string;
  status: Status;
  error: string | null;
  tools: string[];
  /** Surfaced to the UI so a connected server still reads as local vs remote. */
  remote: boolean;
}

export interface ManagerServerEntry {
  name: string;
  status: Status;
  error: string | null;
  tools: Tool[];
  remote: boolean;
  client: McpClient | null;
  /** {@link configKey} of the config this entry was built from, so a later
   * apply can tell "same server, untouched" from "same name, different
   * target". */
  configKey: string;
}

/**
 * Live connector bookkeeping. Ported from `Manager` — MINUS the
 * `std::sync::Mutex` wrapper: this migration has no cross-thread AppState to
 * guard against yet (Node's single-threaded event loop means the concurrency
 * hazard `Manager` guards against in Rust — two threads racing on the `servers`
 * Vec — does not exist here), so a caller integrating this into a larger
 * app-state object supplies its own guard if concurrent mutation ever becomes
 * possible (e.g. two IPC handlers awaited out of order).
 */
export class McpManager {
  servers: ManagerServerEntry[] = [];
  /** Bumped on every config apply so stale background connects from a previous
   * config can tell they lost the race and discard themselves. */
  generation = 0;

  statuses(): ServerStatus[] {
    return this.servers.map((s) => ({
      name: s.name,
      status: s.status,
      error: s.error,
      tools: s.tools.map((t) => t.name),
      remote: s.remote,
    }));
  }
}

// ------------------------------------------------------------------ client

/** What one connector tool call produced. Ported from `ToolOutput`. */
export interface ToolOutput {
  text: string;
  /** Standard base64 (no `data:` prefix) for each usable `image` block, in the
   * order the server sent them. */
  images: string[];
}

/** A connected client, over whichever transport its config chose. The public
 * surface (`callTool`) is transport-agnostic so callers in `mcpConfig.ts`/
 * `execTool.ts` never branch on it. Mirrors Rust's `enum Client`. */
export interface McpClient {
  callTool(name: string, args: unknown): Promise<ToolOutput>;
  /** Tear down the underlying transport (kill the child process / nothing to do
   * for HTTP). Not in the Rust source, which relies on `Drop` +
   * `kill_on_drop(true)`; Node has no destructor, so callers that stop using a
   * client (a config apply that drops it, a test's cleanup) must call this
   * explicitly or a stdio child leaks. */
  close(): void;
}

/** How many pictures one connector call may hand over. A screenshot tool
 * answers with one; a contact sheet could answer with forty, and every one of
 * them costs a vision round. */
export const MAX_TOOL_IMAGES = 2;

/** Largest base64 payload accepted for one picture (~3 MB of PNG). Past this a
 * connector is not sending a screenshot, it is sending a file — and the
 * conversation it would land in has a context window. */
export const MAX_TOOL_IMAGE_B64 = 4 * 1024 * 1024;

/** Image MIME types the perception path can actually decode. Anything else is
 * reported as omitted rather than handed on as pixels that will fail later. */
const TOOL_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

function asRecord(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Normalize a `tools/call` result (or throw when the tool reported `isError`).
 * Shared by both transports — `structuredContent` is a fallback, and empty
 * output becomes `(no output)`.
 *
 * `image` blocks are CARRIED, not dropped — see the Rust source's own extensive
 * comment on `flatten_call_result` for why (Arcelle's own room tools pass
 * pixels over this very protocol). Bounded on purpose (count, size, MIME): what
 * a connector sends is not ours to trust, and anything refused is still SAID
 * rather than silently dropped, so the model never treats a picture it did not
 * get as one it did.
 *
 * Ported verbatim from `flatten_call_result`, with the `Result<T, String>` →
 * throw convention this codebase uses (see module doc). A block whose `type` is
 * not a string is skipped rather than described, matching Rust's
 * `block["type"].as_str()` returning `None`.
 */
export function flattenCallResult(result: unknown): ToolOutput {
  const r = asRecord(result);
  const parts: string[] = [];
  const images: string[] = [];
  for (const raw of asArray(r["content"])) {
    const block = asRecord(raw);
    const type = typeof block["type"] === "string" ? block["type"] : undefined;
    switch (type) {
      case "text": {
        const t = block["text"];
        if (typeof t === "string") parts.push(t);
        break;
      }
      case "image": {
        const mime = asStr(block["mimeType"]).toLowerCase();
        const data = asStr(block["data"]);
        if (!TOOL_IMAGE_MIMES.has(mime)) {
          parts.push(`[image omitted: unsupported format "${mime}"]`);
        } else if (data.length > MAX_TOOL_IMAGE_B64) {
          parts.push("[image omitted: too large to attach]");
        } else if (images.length >= MAX_TOOL_IMAGES) {
          parts.push("[further images omitted]");
        } else {
          images.push(data);
        }
        break;
      }
      // An embedded resource CARRIES its payload: `text` for a text resource,
      // base64 `blob` for a binary one. Flattening it to "[resource content
      // omitted]" threw away the very answer.
      case "resource": {
        const resource = asRecord(block["resource"]);
        const uri = asStr(resource["uri"]);
        const named = uri === "" ? "resource" : uri;
        if (typeof resource["text"] === "string") {
          parts.push(resource["text"]);
        } else if (typeof resource["blob"] === "string") {
          const mime = typeof resource["mimeType"] === "string" ? resource["mimeType"] : "unknown type";
          parts.push(`[binary resource omitted: ${named} (${mime})]`);
        } else {
          parts.push(`[resource omitted: ${named} carried no content]`);
        }
        break;
      }
      // A link has no payload of its own; its uri IS the content.
      case "resource_link": {
        const uri = asStr(block["uri"]);
        parts.push(uri !== "" ? `[resource link: ${uri}]` : "[resource link omitted: no uri]");
        break;
      }
      case undefined:
        break;
      default:
        parts.push(`[${type} content omitted]`);
    }
  }
  if (parts.length === 0 && images.length === 0 && "structuredContent" in r) {
    parts.push(JSON.stringify(r["structuredContent"]));
  }
  let text = parts.join("\n");
  if (r["isError"] === true) {
    throw new Error(text === "" ? "Tool failed." : text);
  }
  if (text === "" && images.length === 0) {
    text = "(no output)";
  }
  return { text, images };
}

/** Collect `tools/list` records (one page) into `tools`. Shared by both
 * transports; returns the `nextCursor` for pagination. Ported verbatim from
 * `collect_tools`. */
export function collectTools(result: unknown, into: Tool[]): string | null {
  const r = asRecord(result);
  for (const raw of asArray(r["tools"])) {
    const t = asRecord(raw);
    if (typeof t["name"] === "string") {
      into.push({
        name: t["name"],
        description: typeof t["description"] === "string" ? t["description"] : "",
        schema: isPlainObject(t["inputSchema"]) ? t["inputSchema"] : { type: "object", properties: {} },
        annotations: isPlainObject(t["annotations"]) ? t["annotations"] : null,
      });
    }
  }
  return typeof r["nextCursor"] === "string" ? r["nextCursor"] : null;
}

/** Whether a JSON-RPC reply carries a real `error` member. An explicit
 * `"error": null` beside a real `result` is NOT one — see the module doc's
 * second DEVIATION note. */
function jsonRpcError(msg: Record<string, unknown>): string | null {
  const err = msg["error"];
  if (err === undefined || err === null) return null;
  const m = asRecord(err)["message"];
  return typeof m === "string" ? m : "unknown error";
}

// -------------------------------------------------------------- line reader

/**
 * Reassembles newline-delimited bytes off a readable stream into whole lines,
 * one at a time — Node's analogue of `tokio::io::BufReader::lines()`. Only ONE
 * `nextLine()` call is ever outstanding at a time in this file's own usage
 * (each client serializes its own requests), which is what makes the
 * single-slot `waiter` below sufficient. See the module doc's first DEVIATION
 * note for the one cancel-safety gap this simplification has relative to tokio.
 */
class LineReader {
  private buffer = "";
  private queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private ended = false;

  constructor(stream: NodeJS.ReadableStream) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.deliver(line);
      }
    });
    const onEnd = (): void => {
      this.ended = true;
      this.deliver(null);
    };
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    stream.on("error", onEnd);
  }

  private deliver(line: string | null): void {
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(line);
    } else if (line !== null) {
      this.queue.push(line);
    }
  }

  /** Next full line, or `null` at EOF. Mirrors `Lines::next_line()`'s
   * `Option<String>`. */
  nextLine(): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.ended) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

/** Race one `nextLine()` read against an absolute deadline. Throws
 * `"__timeout__"` on expiry, which callers translate into the Rust source's own
 * wording (`"Server timed out on {method}."`). */
async function nextLineWithDeadline(reader: LineReader, deadlineAt: number): Promise<string | null> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new Error("__timeout__");
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("__timeout__")), remaining);
  });
  try {
    return await Promise.race([reader.nextLine(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ------------------------------------------------------------ stderr tail

/** How much of a stdio server's stderr we keep for its error message, in UTF-8
 * bytes (matching Rust's byte-length cap). */
export const STDERR_TAIL_MAX = 2000;

/**
 * Append one stderr line to the retained tail, keeping the last
 * {@link STDERR_TAIL_MAX} UTF-8 bytes and landing the cut on a character
 * boundary — the JS analogue of the Rust source's own `is_char_boundary` walk,
 * whose doc explains the panic-and-deadlock a raw byte cut caused (a reader task
 * that panics leaves the mutex poisoned AND stops draining the pipe, so a chatty
 * child then blocks mid-write and the connector never leaves "Connecting…"). A
 * JS string slice cannot panic the way a raw byte slice did, but a naive cut CAN
 * still mangle a character; skipping UTF-8 continuation bytes (`0b10xxxxxx`) is
 * the same rule, done in one pass. Ported from `push_stderr_line`.
 */
export function pushStderrLine(tail: string, line: string): string {
  const next = tail + line + "\n";
  const bytes = Buffer.from(next, "utf8");
  if (bytes.length <= STDERR_TAIL_MAX) return next;
  let cut = bytes.length - STDERR_TAIL_MAX;
  while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut += 1;
  return bytes.subarray(cut).toString("utf8");
}

// ------------------------------------------------------------- login shell

let cachedLoginPath: string | null = null;

/** GUI apps on macOS get a bare PATH, so `npx`/`uvx` from a server config would
 * not be found. Ask a login shell once, like `detect_external` does. Ported
 * from `login_shell_path` (the synchronous `spawn_blocking` body, called from
 * an async context here instead — Node has no blocking-pool distinction to
 * preserve). */
export async function loginShellPath(): Promise<string> {
  if (cachedLoginPath !== null) {
    return cachedLoginPath;
  }
  const fromShell = await new Promise<string>((resolve) => {
    execFile("zsh", ["-lc", 'printf %s "$PATH"'], (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
  const inherited = process.env["PATH"] ?? "";
  const home = process.env["HOME"] ?? "";
  cachedLoginPath = `${fromShell}:${inherited}:/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin:${home}/.cargo/bin`;
  return cachedLoginPath;
}

/** Test-only: forget the cached login-shell PATH so a test can observe a fresh
 * resolution. Not part of the Rust source (whose `OnceLock` is never reset
 * either) — added because this port's tests run in the same process. */
export function resetLoginShellPathCacheForTests(): void {
  cachedLoginPath = null;
}

// ------------------------------------------------------------- stdio client

export interface StdioConnectOptions {
  /** Stand-in for `crate::commands::cached_path_prefix()` — the downloaded-
   * runtime PATH prefix (`uvx`/`npx` the app provisioned itself). That
   * subsystem (`commands/runtimes.rs`) has no port in this migration yet, so
   * this is injected; the default (empty prefix) means only what is already on
   * the resolved login-shell PATH is found, exactly like an install that has
   * provisioned nothing. */
  cachedPathPrefix?: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Override for {@link loginShellPath} — tests inject a fixed PATH instead of
   * spawning a real login shell. */
  resolvePath?: () => Promise<string>;
}

class StdioClient implements McpClient {
  private nextId = 0;
  private stderrTail = "";
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly stdout: LineReader,
    private readonly callTimeoutMs: number
  ) {
    child.on("exit", () => {
      this.closed = true;
    });
    const stderr = new LineReader(child.stderr);
    void (async () => {
      for (;;) {
        const line = await stderr.nextLine();
        if (line === null) return;
        this.stderrTail = pushStderrLine(this.stderrTail, line);
      }
    })();
  }

  static async connect(
    command: string,
    args: readonly string[],
    env: Record<string, string>,
    opts: StdioConnectOptions
  ): Promise<{ client: StdioClient; tools: Tool[] }> {
    const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
    const loginPath = opts.resolvePath !== undefined ? await opts.resolvePath() : await loginShellPath();
    // A runtime the app downloaded for this user lives under the app's data
    // folder, which is on no shell PATH — so without this prefix a provisioned
    // `uvx`/`npx` is never found. First, so a provisioned tool wins over a
    // broken system one.
    const prefix = opts.cachedPathPrefix ?? "";
    const path = prefix === "" ? loginPath : `${prefix}:${loginPath}`;

    const child = spawn(command, [...args], {
      env: { ...process.env, ...env, PATH: path },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A spawn failure (a command that is not on PATH) surfaces as an 'error'
    // event, never a throw; waiting for whichever of the two fires is what
    // turns it into Rust's own `Could not start "{command}": {e}`.
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.removeListener("error", onError);
        child.removeListener("spawn", onSpawn);
      };
      const onError = (e: Error): void => {
        cleanup();
        reject(new Error(`Could not start "${command}": ${e.message}`));
      };
      const onSpawn = (): void => {
        cleanup();
        // Mid-life errors surface through a closed stdout/EOF instead, but an
        // unhandled 'error' event would take the whole process down.
        child.on("error", () => undefined);
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });

    const stdout = new LineReader(child.stdout);
    const client = new StdioClient(child, stdout, callTimeoutMs);

    await client.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Arcelle", version: CLIENT_VERSION },
      },
      connectTimeoutMs
    );
    await client.notify("notifications/initialized", {});

    const tools: Tool[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params = cursor !== null ? { cursor } : {};
      const result = await client.request("tools/list", params, connectTimeoutMs);
      cursor = collectTools(result, tools);
      if (cursor === null) break;
    }
    return { client, tools };
  }

  async callTool(name: string, args: unknown): Promise<ToolOutput> {
    const a = isPlainObject(args) ? args : {};
    const result = await this.request("tools/call", { name, arguments: a }, this.callTimeoutMs);
    return flattenCallResult(result);
  }

  close(): void {
    if (!this.closed) {
      this.child.kill();
      this.closed = true;
    }
  }

  private async send(msg: unknown): Promise<void> {
    const line = JSON.stringify(msg) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, (err) => {
        if (err) reject(new Error(`Server stdin closed: ${err.message}`));
        else resolve();
      });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  /** Send a request and read lines until its response arrives. Server
   * notifications are ignored; server→client requests get a stub reply so
   * well-behaved servers don't hang (pings get a real pong). Ported verbatim
   * from `StdioClient::request`. */
  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.nextId += 1;
    const id = this.nextId;
    await this.send({ jsonrpc: "2.0", id, method, params });

    const deadlineAt = Date.now() + timeoutMs;
    for (;;) {
      let line: string | null;
      try {
        line = await nextLineWithDeadline(this.stdout, deadlineAt);
      } catch {
        throw new Error(`Server timed out on ${method}.`);
      }
      if (line === null) {
        const tail = this.stderrTail.trim();
        throw new Error(tail === "" ? "Server exited." : `Server exited: ${tail}`);
      }
      let v: unknown;
      try {
        v = JSON.parse(line.trim());
      } catch {
        continue; // servers sometimes log to stdout — skip
      }
      const msg = asRecord(v);
      if (msg["id"] === id && msg["method"] === undefined) {
        const err = jsonRpcError(msg);
        if (err !== null) {
          throw new Error(`${method} failed: ${err}`);
        }
        return msg["result"];
      }
      if (msg["id"] !== undefined && typeof msg["method"] === "string") {
        const reply =
          msg["method"] === "ping"
            ? { jsonrpc: "2.0", id: msg["id"], result: {} }
            : {
                jsonrpc: "2.0",
                id: msg["id"],
                error: { code: -32601, message: "Not supported by this client." },
              };
        await this.send(reply);
      }
    }
  }
}

// -------------------------------------------------------------- http client

/** The message shown when a remote server answers with 401/403. An OAuth
 * challenge (a `WWW-Authenticate` header, RFC 9728) means "sign in" — telling
 * the user to "check the token in this connector's headers" when the connector
 * actually uses OAuth is the confusing case hit in the wild. A bare 401 with no
 * challenge really is a bad/missing token. Ported verbatim from
 * `auth_error_message`. */
export function authErrorMessage(method: string, status: number, wwwAuthenticate: string | null): string {
  if (wwwAuthenticate !== null) {
    return (
      `${method}: this connector needs you to sign in (HTTP ${status}). ` +
      `Open it under Connectors and click “Connect account” to authorize.`
    );
  }
  return (
    `${method}: the remote server rejected the request (HTTP ${status}). ` +
    `This connector needs a valid token — add one under its auth headers, ` +
    `or use “Connect account” if it supports sign-in.`
  );
}

/** Pull the JSON-RPC response with id `id` out of an HTTP reply body — either a
 * plain JSON object or an SSE stream of `data:` frames (streamable HTTP).
 * Ported verbatim from `parse_http_message`. */
export function parseHttpMessage(ctype: string, body: string, id: number): unknown {
  if (ctype.includes("text/event-stream") || body.trimStart().startsWith("event:")) {
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trimStart();
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (data === "") continue;
      try {
        const v: unknown = JSON.parse(data);
        const r = asRecord(v);
        if (r["method"] === undefined && r["id"] === id) {
          return v;
        }
      } catch {
        // not JSON — keep scanning
      }
    }
    return undefined;
  }
  try {
    return JSON.parse(body.trim());
  } catch {
    return undefined;
  }
}

export interface HttpConnectOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/**
 * A remote MCP server reached over streamable HTTP (JSON-RPC POST). The reply
 * is either `application/json` (one response) or `text/event-stream` (SSE
 * frames) — both are accepted. A server may hand back an `Mcp-Session-Id` on
 * `initialize`; it is echoed on every later request. Ported from `HttpClient`.
 */
class HttpClient implements McpClient {
  private nextId = 0;
  private sessionId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly callTimeoutMs: number
  ) {}

  static async connect(
    url: string,
    headers: Record<string, string>,
    opts: HttpConnectOptions
  ): Promise<{ client: HttpClient; tools: Tool[] }> {
    const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
    const client = new HttpClient(url, headers, callTimeoutMs);
    await client.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Arcelle", version: CLIENT_VERSION },
      },
      connectTimeoutMs
    );
    await client.notify("notifications/initialized", {}, connectTimeoutMs);

    const tools: Tool[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params = cursor !== null ? { cursor } : {};
      const result = await client.request("tools/list", params, connectTimeoutMs);
      cursor = collectTools(result, tools);
      if (cursor === null) break;
    }
    return { client, tools };
  }

  async callTool(name: string, args: unknown): Promise<ToolOutput> {
    const a = isPlainObject(args) ? args : {};
    const result = await this.request("tools/call", { name, arguments: a }, this.callTimeoutMs);
    return flattenCallResult(result);
  }

  close(): void {
    // Nothing to tear down: every request is its own HTTP round trip.
  }

  /** POST one JSON body, applying the configured headers, the protocol version,
   * and the captured session id. On the way back, capture any `Mcp-Session-Id`
   * the server assigns and any `WWW-Authenticate` header (an OAuth challenge).
   * Ported from `HttpClient::post`. */
  private async post(
    body: unknown,
    timeoutMs: number
  ): Promise<{ status: number; contentType: string; text: string; wwwAuthenticate: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          ...this.headers,
          ...(this.sessionId !== null ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error("Remote server timed out.");
      }
      throw new Error(`Could not reach the remote server: ${errMessage(e)}`);
    } finally {
      clearTimeout(timer);
    }
    const sid = resp.headers.get("mcp-session-id");
    if (sid !== null) {
      this.sessionId = sid;
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const wwwAuthenticate = resp.headers.get("www-authenticate");
    const text = await resp.text();
    return { status: resp.status, contentType, text, wwwAuthenticate };
  }

  private async notify(method: string, params: unknown, timeoutMs: number): Promise<void> {
    const { status, wwwAuthenticate } = await this.post({ jsonrpc: "2.0", method, params }, timeoutMs);
    // 200 or 202 (Accepted, empty body) are both fine for a notification.
    if (status === 401 || status === 403) {
      throw new Error(authErrorMessage(method, status, wwwAuthenticate));
    }
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.nextId += 1;
    const id = this.nextId;
    const { status, contentType, text, wwwAuthenticate } = await this.post(
      { jsonrpc: "2.0", id, method, params },
      timeoutMs
    );
    if (status === 401 || status === 403) {
      throw new Error(authErrorMessage(method, status, wwwAuthenticate));
    }
    if (status < 200 || status >= 300) {
      const snippet = Array.from(text).slice(0, 200).join("");
      throw new Error(`${method}: remote server returned HTTP ${status} ${snippet}`);
    }
    const msg = parseHttpMessage(contentType, text, id);
    if (msg === undefined) {
      throw new Error(`${method}: no JSON-RPC response in the reply`);
    }
    const r = asRecord(msg);
    const err = jsonRpcError(r);
    if (err !== null) {
      throw new Error(`${method} failed: ${err}`);
    }
    return r["result"];
  }
}

// --------------------------------------------------------------- top-level

export interface ConnectMcpClientOptions extends StdioConnectOptions, HttpConnectOptions {}

/** Spawn/open the server, run the initialize handshake and list its tools.
 * Ported from `Client::connect`. */
export async function connectMcpClient(
  config: ServerConfig,
  opts: ConnectMcpClientOptions = {}
): Promise<{ client: McpClient; tools: Tool[] }> {
  if (config.transport.kind === "stdio") {
    const { command, args, env } = config.transport;
    return StdioClient.connect(command, args, env, opts);
  }
  const { url, headers } = config.transport;
  return HttpClient.connect(url, headers, opts);
}
