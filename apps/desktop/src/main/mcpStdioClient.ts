import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CALL_TIMEOUT_MS, CLIENT_VERSION, CONNECT_TIMEOUT_MS, McpClient, PROTOCOL_VERSION, Tool, ToolOutput, asRecord, collectTools, flattenCallResult, isPlainObject, jsonRpcError } from "./mcpClient.js";

export

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


/** Test seam for the stream EOF state transition. Real child-process shutdown
 * races the child's exit event, so callers cannot deterministically observe a
 * second read after EOF without controlling when the stream ends. */
export async function lineReaderEofSequenceForTests(
  stream: NodeJS.ReadableStream,
  end: () => void,
): Promise<readonly [string | null, string | null]> {
  const reader = new LineReader(stream);
  const pending = reader.nextLine();
  end();
  return [await pending, await reader.nextLine()];
}
export

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
export

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
export interface StdioConnectionSettings {
  readonly connectTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly path: string;
}
export async function stdioConnectionSettings(opts: StdioConnectOptions): Promise<StdioConnectionSettings> {
  const loginPath = await resolvedStdioPath(opts);
  const prefix = opts.cachedPathPrefix ?? "";
  return {
    connectTimeoutMs: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    callTimeoutMs: opts.callTimeoutMs ?? CALL_TIMEOUT_MS,
    path: prefix === "" ? loginPath : `${prefix}:${loginPath}`,
  };
}
export async function resolvedStdioPath(opts: StdioConnectOptions): Promise<string> {
  if (opts.resolvePath !== undefined) return opts.resolvePath();
  return loginShellPath();
}
export function waitForStdioSpawn(child: ChildProcessWithoutNullStreams, command: string): Promise<void> {
  // A spawn failure (a command that is not on PATH) surfaces as an 'error'
  // event, never a throw; waiting for whichever of the two fires is what
  // turns it into Rust's own `Could not start "{command}": {e}`.
  return new Promise<void>((resolve, reject) => {
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
}
export type StdioMessageOutcome =
  | { readonly kind: "ignore" }
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "server_request"; readonly reply: Record<string, unknown> };
export function parsedStdioMessage(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line.trim()));
  } catch {
    return null; // servers sometimes log to stdout — skip
  }
}
export function matchingStdioResponse(
  msg: Record<string, unknown>,
  id: number,
  method: string,
): StdioMessageOutcome | null {
  if (msg["id"] !== id || msg["method"] !== undefined) return null;
  const err = jsonRpcError(msg);
  if (err !== null) throw new Error(`${method} failed: ${err}`);
  return { kind: "result", result: msg["result"] };
}
export function serverRequestOutcome(msg: Record<string, unknown>): StdioMessageOutcome | null {
  const method = msg["method"];
  if (msg["id"] === undefined || typeof method !== "string") return null;
  return { kind: "server_request", reply: serverRequestReply(msg["id"], method) };
}
export function serverRequestReply(id: unknown, method: string): Record<string, unknown> {
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Not supported by this client." },
  };
}
export function stdioMessageOutcome(msg: Record<string, unknown>, id: number, method: string): StdioMessageOutcome {
  return matchingStdioResponse(msg, id, method) ?? serverRequestOutcome(msg) ?? { kind: "ignore" };
}
export class StdioClient implements McpClient {
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
    const settings = await stdioConnectionSettings(opts);
    // A runtime the app downloaded for this user lives under the app's data
    // folder, which is on no shell PATH — so without this prefix a provisioned
    // `uvx`/`npx` is never found. First, so a provisioned tool wins over a
    // broken system one.
    const child = spawn(command, [...args], {
      env: { ...process.env, ...env, PATH: settings.path },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForStdioSpawn(child, command);

    const stdout = new LineReader(child.stdout);
    const client = new StdioClient(child, stdout, settings.callTimeoutMs);
    const tools = await client.initializeAndListTools(settings.connectTimeoutMs);
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

  private async initializeAndListTools(connectTimeoutMs: number): Promise<Tool[]> {
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Arcelle", version: CLIENT_VERSION },
      },
      connectTimeoutMs
    );
    await this.notify("notifications/initialized", {});
    return this.listTools(connectTimeoutMs);
  }

  private async listTools(connectTimeoutMs: number): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params = cursor !== null ? { cursor } : {};
      const result = await this.request("tools/list", params, connectTimeoutMs);
      cursor = collectTools(result, tools);
      if (cursor === null) return tools;
    }
  }

  /** Send a request and read lines until its response arrives. Server
   * notifications are ignored; server→client requests get a stub reply so
   * well-behaved servers don't hang (pings get a real pong). Ported verbatim
   * from `StdioClient::request`. */
  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.nextId += 1;
    const id = this.nextId;
    await this.send({ jsonrpc: "2.0", id, method, params });
    return this.readRequestResult(method, id, Date.now() + timeoutMs);
  }

  private async readRequestResult(method: string, id: number, deadlineAt: number): Promise<unknown> {
    for (;;) {
      const line = await this.nextResponseLine(method, deadlineAt);
      const msg = parsedStdioMessage(line);
      if (msg === null) continue;
      const outcome = stdioMessageOutcome(msg, id, method);
      if (outcome.kind === "result") return outcome.result;
      if (outcome.kind === "server_request") await this.send(outcome.reply);
    }
  }

  private async nextResponseLine(method: string, deadlineAt: number): Promise<string> {
    try {
      const line = await nextLineWithDeadline(this.stdout, deadlineAt);
      if (line !== null) return line;
    } catch {
      throw new Error(`Server timed out on ${method}.`);
    }
    const tail = this.stderrTail.trim();
    throw new Error(tail === "" ? "Server exited." : `Server exited: ${tail}`);
  }
}
