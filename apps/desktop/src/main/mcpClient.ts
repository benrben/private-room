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
function parseMcpConfigJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (e) {
    throw new Error(`Config is not valid JSON: ${errMessage(e)}`);
  }
}

function mcpServers(root: unknown): Record<string, unknown> {
  if (!isPlainObject(root) || !isPlainObject(root["mcpServers"])) {
    throw new Error('Config needs a top-level "mcpServers" object.');
  }
  return root["mcpServers"];
}

function remoteMcpServer(server: Record<string, unknown>): boolean {
  const type = typeof server["type"] === "string" ? server["type"] : "";
  return type === "http" || type === "streamable-http" || type === "sse" || typeof server["url"] === "string";
}

function remoteTransport(name: string, server: Record<string, unknown>): Transport {
  const url = server["url"];
  if (typeof url !== "string") {
    throw new Error(`Remote server "${name}" is missing "url".`);
  }
  return { kind: "http", url, headers: stringMap(server["headers"]) };
}

function localTransport(name: string, server: Record<string, unknown>): Transport {
  const command = server["command"];
  if (typeof command !== "string") {
    throw new Error(`Server "${name}" needs a "command" (local) or a "url" (remote).`);
  }
  const rawArgs = server["args"];
  const args = Array.isArray(rawArgs) ? rawArgs.filter((value): value is string => typeof value === "string") : [];
  return { kind: "stdio", command, args, env: stringMap(server["env"]) };
}

function parsedMcpServer(name: string, raw: unknown): ServerConfig {
  const server = isPlainObject(raw) ? raw : {};
  const transport = remoteMcpServer(server) ? remoteTransport(name, server) : localTransport(name, server);
  return { transport, disabled: server["disabled"] === true };
}

export function parseMcpConfig(json: string): Array<[string, ServerConfig]> {
  const servers = mcpServers(parseMcpConfigJson(json));
  const out: Array<[string, ServerConfig]> = [];
  for (const [name, raw] of Object.entries(servers)) {
    // Remote if it declares an http/https type OR simply carries a url. A
    // "command" present alongside a url still means remote — the url wins,
    // matching how Claude Desktop treats `"type": "http"`.
    out.push([name, parsedMcpServer(name, raw)]);
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

interface FlattenedToolOutput {
  readonly parts: string[];
  readonly images: string[];
}

function addTextBlock(block: Record<string, unknown>, output: FlattenedToolOutput): void {
  const text = block["text"];
  if (typeof text === "string") output.parts.push(text);
}

function addImageBlock(block: Record<string, unknown>, output: FlattenedToolOutput): void {
  const mime = asStr(block["mimeType"]).toLowerCase();
  if (!TOOL_IMAGE_MIMES.has(mime)) {
    output.parts.push(`[image omitted: unsupported format "${mime}"]`);
    return;
  }
  const data = asStr(block["data"]);
  if (data.length > MAX_TOOL_IMAGE_B64) {
    output.parts.push("[image omitted: too large to attach]");
    return;
  }
  if (output.images.length >= MAX_TOOL_IMAGES) {
    output.parts.push("[further images omitted]");
    return;
  }
  output.images.push(data);
}

function resourceContent(resource: Record<string, unknown>): string {
  const uri = asStr(resource["uri"]);
  const name = uri === "" ? "resource" : uri;
  if (typeof resource["text"] === "string") return resource["text"];
  if (typeof resource["blob"] === "string") {
    const mime = typeof resource["mimeType"] === "string" ? resource["mimeType"] : "unknown type";
    return `[binary resource omitted: ${name} (${mime})]`;
  }
  return `[resource omitted: ${name} carried no content]`;
}

function addResourceBlock(block: Record<string, unknown>, output: FlattenedToolOutput): void {
  output.parts.push(resourceContent(asRecord(block["resource"])));
}

function addResourceLinkBlock(block: Record<string, unknown>, output: FlattenedToolOutput): void {
  const uri = asStr(block["uri"]);
  output.parts.push(uri !== "" ? `[resource link: ${uri}]` : "[resource link omitted: no uri]");
}

const CALL_RESULT_BLOCK_HANDLERS = new Map<string, (block: Record<string, unknown>, output: FlattenedToolOutput) => void>([
  ["text", addTextBlock],
  ["image", addImageBlock],
  ["resource", addResourceBlock],
  ["resource_link", addResourceLinkBlock],
]);

function addCallResultBlock(raw: unknown, output: FlattenedToolOutput): void {
  const block = asRecord(raw);
  const type = block["type"];
  if (typeof type !== "string") return;
  const handler = CALL_RESULT_BLOCK_HANDLERS.get(type);
  if (handler !== undefined) {
    handler(block, output);
    return;
  }
  output.parts.push(`[${type} content omitted]`);
}

function flattenedContent(result: Record<string, unknown>): FlattenedToolOutput {
  const output: FlattenedToolOutput = { parts: [], images: [] };
  for (const raw of asArray(result["content"])) addCallResultBlock(raw, output);
  if (output.parts.length === 0 && output.images.length === 0 && "structuredContent" in result) {
    output.parts.push(JSON.stringify(result["structuredContent"]));
  }
  return output;
}

function throwToolError(result: Record<string, unknown>, text: string): void {
  if (result["isError"] === true) throw new Error(text === "" ? "Tool failed." : text);
}

function defaultToolText(text: string, images: readonly string[]): string {
  return text === "" && images.length === 0 ? "(no output)" : text;
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
  const record = asRecord(result);
  const output = flattenedContent(record);
  const text = output.parts.join("\n");
  throwToolError(record, text);
  return { text: defaultToolText(text, output.images), images: output.images };
}

function toolSchema(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : { type: "object", properties: {} };
}

function toolAnnotations(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function toolFromResult(value: unknown): Tool | null {
  const record = asRecord(value);
  if (typeof record["name"] !== "string") return null;
  return {
    name: record["name"],
    description: asStr(record["description"]),
    schema: toolSchema(record["inputSchema"]),
    annotations: toolAnnotations(record["annotations"]),
  };
}

function nextToolCursor(result: Record<string, unknown>): string | null {
  return typeof result["nextCursor"] === "string" ? result["nextCursor"] : null;
}

/** Collect `tools/list` records (one page) into `tools`. Shared by both
 * transports; returns the `nextCursor` for pagination. Ported verbatim from
 * `collect_tools`. */
export function collectTools(result: unknown, into: Tool[]): string | null {
  const record = asRecord(result);
  for (const raw of asArray(record["tools"])) {
    const tool = toolFromResult(raw);
    if (tool !== null) into.push(tool);
  }
  return nextToolCursor(record);
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
import { StdioClient } from "./mcpStdioClient.js";
export { lineReaderEofSequenceForTests, STDERR_TAIL_MAX, pushStderrLine, loginShellPath, resetLoginShellPathCacheForTests } from "./mcpStdioClient.js";
export type { StdioConnectOptions } from "./mcpStdioClient.js";

export { authErrorMessage, parseHttpMessage, connectMcpClient } from "./mcpHttpClient.js";
export type { HttpConnectOptions, ConnectMcpClientOptions } from "./mcpHttpClient.js";


export { CLIENT_VERSION, PROTOCOL_VERSION, StdioClient, asRecord, errMessage, isPlainObject, jsonRpcError };
