import * as net from "node:net";
import { asciiByteBetween, errMessage } from "./mcpOauthModel.js";

const CALLBACK_READ_TIMEOUT_MS = 10_000;
/** Cap on the bytes read looking for the request line. Far above any real
 * authorization code, and small enough that a local process cannot stream
 * memory into us. */
const MAX_CALLBACK_REQUEST = 64 * 1024;

/** Bind a loopback listener and return `(redirectUri, server)`. The port is
 * ephemeral so nothing needs to be reserved. Ported from `bind_callback`.
 * Exported so a test can drive the real listener over real TCP. */
export async function bindCallback(): Promise<{ redirectUri: string; server: net.Server }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e) => reject(new Error(`could not bind the callback listener: ${errMessage(e)}`)));
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { redirectUri: `http://127.0.0.1:${port}/callback`, server };
}

/** The request target ("/callback?code=…") of one connection, read with its own
 * timeout and a bounded buffer. `null` for a connection that sends nothing in
 * time, closes early, or overruns the cap — none of those is the callback.
 * Ported from `read_request_target`. */
function readRequestTarget(socket: net.Socket): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onClose);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onClose);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(0x0a); // '\n'
      if (idx !== -1) {
        const line = buf.subarray(0, idx).toString("utf8");
        // The request LINE is "GET /callback?code=…&state=… HTTP/1.1\r" — only
        // the SECOND whitespace-separated token (the request target itself) is
        // what the rest of this flow wants. Ported verbatim from
        // `read_request_target`'s `line.split_whitespace().nth(1)`; without it
        // the trailing " HTTP/1.1\r" stayed glued onto the last query value,
        // corrupting `state` and reading every real callback as a mismatched
        // sign-in.
        finish(line.split(/\s+/).filter((s) => s.length > 0)[1] ?? null);
        return;
      }
      if (buf.length >= MAX_CALLBACK_REQUEST) {
        finish(null);
      }
    };
    const onClose = (): void => finish(null);
    const timer = setTimeout(() => finish(null), CALLBACK_READ_TIMEOUT_MS);
    socket.on("data", onData);
    socket.on("end", onClose);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}

/** The "you can close this tab" page. Always HTTP 200, success or not, matching
 * `write_callback_page` — the STATUS is not how the user is told what happened;
 * the page is. */
async function writeCallbackPage(socket: net.Socket, ok: boolean): Promise<void> {
  const page = ok
    ? "<h2>Signed in.</h2><p>You can close this tab and return to Arcelle.</p>"
    : "<h2>Sign-in failed.</h2><p>Return to Arcelle and try again.</p>";
  const body = `HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${Buffer.byteLength(page)}\r\n\r\n${page}`;
  await new Promise<void>((resolve) => {
    socket.write(body, () => resolve());
  });
}

function hexVal(b: number): number | null {
  if (asciiByteBetween(b, 0x30, 0x39)) return b - 0x30;
  if (asciiByteBetween(b, 0x61, 0x66)) return b - 0x61 + 10;
  if (asciiByteBetween(b, 0x41, 0x46)) return b - 0x41 + 10;
  return null;
}

/** Percent-decode a query value, byte by byte — never by re-slicing the string
 * at a fixed offset, mirroring the Rust source's own hard-won fix (re-slicing
 * through a multi-byte escape used to panic the whole sign-in task, leaving the
 * drawer waiting for a browser that had already answered). This runs on
 * anything a local process can send the loopback port. Ported verbatim from
 * `urldecode`. */
function urldecode(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === 0x2b) {
      out.push(0x20); // '+' -> space
    } else if (b === 0x25) {
      const escaped = percentDecodedByte(bytes, i);
      if (escaped !== null) {
        out.push(escaped);
        i += 3;
        continue;
      }
      out.push(b); // not an escape after all — keep the byte as it arrived
    } else {
      out.push(b);
    }
    i += 1;
  }
  return Buffer.from(out).toString("utf8");
}

function percentDecodedByte(bytes: Buffer, index: number): number | null {
  if (index + 2 >= bytes.length) return null;
  const high = hexVal(bytes[index + 1]!);
  if (high === null) return null;
  const low = hexVal(bytes[index + 2]!);
  if (low === null) return null;
  return high * 16 + low;
}

/** Every `k=v` pair of a request target's query, values percent-decoded. */
function callbackParams(target: string): Map<string, string> {
  const q = target.includes("?") ? target.slice(target.indexOf("?") + 1) : "";
  const out = new Map<string, string>();
  for (const pair of q.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out.set(pair.slice(0, eq), urldecode(pair.slice(eq + 1)));
  }
  return out;
}

/** Pull `code` and `state` out of a `/callback?code=…&state=…` request target.
 * Ported verbatim from `parse_callback_query`. */
export function parseCallbackQuery(target: string): { code: string; state: string } {
  const params = callbackParams(target);
  return { code: params.get("code") ?? "", state: params.get("state") ?? "" };
}

/** The provider's own refusal off a callback target, `error_description` for
 * preference. Ported verbatim from `callback_error`. */
export function callbackError(target: string): string | null {
  const params = callbackParams(target);
  const error = params.get("error");
  if (error === undefined || error === "") return null;
  const description = params.get("error_description");
  return description !== undefined && description !== "" ? `${error} — ${description}` : error;
}

/**
 * Serve the browser's redirect, extract `?code=&state=`, and show the user a
 * "you can close this tab" page.
 *
 * Every connection until the deadline gets a look, not just the first one.
 * Browsers open speculative connections and close them again, and serving
 * exactly one accepted socket lost real sign-ins to them: a socket that sent
 * nothing blocked the read forever, and one that closed immediately consumed
 * the single accept and reported failure for a sign-in the user had completed
 * correctly. Only a request that carries a `code` — or the provider's own
 * `error` — ends the wait. A persistent `connection` listener queues sockets
 * that arrive while an earlier one is still being read, since a dropped Node
 * event is the equivalent failure. Ported from `await_callback`; exported so a
 * test can drive it over real TCP.
 */
export async function awaitCallback(server: net.Server, expectedState: string, timeoutMs: number): Promise<string> {
  const sockets = callbackSocketQueue(server);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const socket = await nextCallbackSocket(sockets, deadline);
      const answer = await callbackAnswer(socket, expectedState);
      if (answer.kind === "code") return answer.code;
      if (answer.kind === "refusal") throw new Error(`the provider refused the sign-in: ${answer.reason}`);
    }
  } finally {
    sockets.close();
  }
}

interface CallbackSocketQueue {
  next(remaining: number): Promise<net.Socket | null>;
  close(): void;
}

function callbackSocketQueue(server: net.Server): CallbackSocketQueue {
  const pending: net.Socket[] = [];
  let waiter: ((s: net.Socket) => void) | null = null;
  const onConnection = (s: net.Socket): void => {
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(s);
    } else {
      pending.push(s);
    }
  };
  server.on("connection", onConnection);
  const next = (remaining: number): Promise<net.Socket | null> => {
    const queued = pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiter = null;
        resolve(null);
      }, remaining);
      waiter = (s): void => {
        clearTimeout(timer);
        resolve(s);
      };
    });
  };
  return {
    next,
    close: () => {
      server.removeListener("connection", onConnection);
      // Anything still queued was never answered; `server.close()` does not
      // touch established sockets, and a live one would keep the process (or
      // a test runner) waiting on nothing.
      for (const socket of pending.splice(0)) socket.destroy();
    },
  };
}

async function nextCallbackSocket(sockets: CallbackSocketQueue, deadline: number): Promise<net.Socket> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw callbackTimeout();
  const socket = await sockets.next(remaining);
  if (socket === null) throw callbackTimeout();
  return socket;
}

function callbackTimeout(): Error {
  return new Error("timed out waiting for the browser sign-in");
}

type CallbackAnswer = { kind: "skip" } | { kind: "refusal"; reason: string } | { kind: "code"; code: string };

async function callbackAnswer(socket: net.Socket, expectedState: string): Promise<CallbackAnswer> {
  const target = await readRequestTarget(socket);
  if (target === null) {
    socket.destroy();
    return { kind: "skip" };
  }
  const reason = callbackError(target);
  if (reason !== null) {
    await writeCallbackPage(socket, false);
    socket.end();
    return { kind: "refusal", reason };
  }
  const { code, state } = parseCallbackQuery(target);
  if (code === "") {
    // A speculative connection, a favicon request, anything that is not the
    // redirect: leave the wait open for the real one.
    socket.destroy();
    return { kind: "skip" };
  }
  const matchesState = state === expectedState;
  await writeCallbackPage(socket, matchesState);
  socket.end();
  if (!matchesState) {
    throw new Error("the sign-in did not complete (the browser sent back a different sign-in's state)");
  }
  return { kind: "code", code };
}

// ---------------------------------------------------------- authorize flow
