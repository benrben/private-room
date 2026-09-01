/** Loopback HTTP transport for the room MCP JSON-RPC protocol. */

import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import {
  authorize,
  declaredBodySize,
  dispatchJsonRpc,
  EMPTY_JSON_OBJECT,
  MAX_REQUEST_BODY,
  type CancelFlagLike,
  type ToolDispatcher,
  type ToolScope,
} from "./mcpBridgeProtocol.js";

const OVERSIZE_LINGER_IDLE_MS = 500;
const OVERSIZE_LINGER_MAX_MS = 10_000;

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

type BodyRead =
  | { ok: true; body: Buffer }
  | { ok: false; reason: "oversize" }
  | { ok: false; reason: "aborted" };

function readCappedBody(req: IncomingMessage, cap: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const finish = (result: BodyRead): void => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onAborted);
      req.removeListener("aborted", onAborted);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > cap) {
        chunks.length = 0;
        finish({ ok: false, reason: "oversize" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks) });
    const onAborted = (): void => finish({ ok: false, reason: "aborted" });

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onAborted);
    req.on("aborted", onAborted);
  });
}

export interface McpBridgeOptions {
  token: string;
  scope: ToolScope;
  dispatcher: ToolDispatcher;
  cancelFlag?: CancelFlagLike;
  serverVersion?: string;
}

export class McpBridge {
  private readonly server: Server;
  private readonly serverVersion: string;
  private stopped = false;

  constructor(private readonly opts: McpBridgeOptions) {
    this.serverVersion = opts.serverVersion ?? "0.0.0";
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  get port(): number | null {
    const address = this.server.address();
    return address === null || typeof address === "string" ? null : address.port;
  }

  get url(): string {
    const port = this.port;
    if (port === null) {
      throw new Error("McpBridge is not listening yet");
    }
    return `http://127.0.0.1:${port}/mcp`;
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once("error", onError);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        resolve(this.port as number);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }

  private rejectPreflightRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const declared = declaredBodySize(req.headers["content-length"]);
    if (declared !== null && declared > MAX_REQUEST_BODY) {
      this.refuseOversize(req, res);
      return true;
    }
    if (!authorize(headerValue(req.headers, "authorization"), this.opts.token)) {
      this.write(res, 401, EMPTY_JSON_OBJECT);
      return true;
    }
    if (req.method !== "POST") {
      this.write(res, 405, EMPTY_JSON_OBJECT);
      return true;
    }
    return false;
  }

  private async readRequestBody(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Buffer | undefined> {
    const read = await readCappedBody(req, MAX_REQUEST_BODY);
    if (read.ok) return read.body;
    this.rejectUnreadableBody(req, res, read.reason);
    return undefined;
  }

  private rejectUnreadableBody(
    req: IncomingMessage,
    res: ServerResponse,
    reason: Exclude<BodyRead, { ok: true }>["reason"],
  ): void {
    if (reason === "oversize") {
      this.refuseOversize(req, res);
      return;
    }
    req.socket.destroy();
  }

  private async dispatchResponse(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const { status, body: responseBody } = await dispatchJsonRpc(
      body,
      this.opts.scope,
      this.opts.dispatcher,
      this.opts.cancelFlag,
      this.serverVersion,
    );
    if (this.stopped) {
      req.socket.destroy();
      return;
    }
    this.write(res, status, responseBody);
  }

  private writeInternalError(res: ServerResponse): void {
    if (res.headersSent) return;
    this.write(res, 500, EMPTY_JSON_OBJECT);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.rejectPreflightRequest(req, res)) return;
      const body = await this.readRequestBody(req, res);
      if (body === undefined) return;
      await this.dispatchResponse(req, res, body);
    } catch {
      this.writeInternalError(res);
    }
  }

  private write(res: ServerResponse, status: number, body: Buffer): void {
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(body.length),
    });
    res.end(body);
  }

  private refuseOversize(req: IncomingMessage, res: ServerResponse): void {
    this.drainRefusedBody(req);
    res.writeHead(413, {
      "content-type": "application/json",
      "content-length": String(EMPTY_JSON_OBJECT.length),
    });
    res.end(EMPTY_JSON_OBJECT);
  }

  private drainRefusedBody(req: IncomingMessage): void {
    const socket = req.socket;
    let idle: NodeJS.Timeout | undefined;
    const stopDraining = (): void => {
      clearTimeout(hard);
      clearTimeout(idle);
      req.removeListener("data", discard);
      req.removeListener("end", drained);
    };
    const sever = (): void => {
      stopDraining();
      socket.destroy();
    };
    const armIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(sever, OVERSIZE_LINGER_IDLE_MS);
      idle.unref();
    };
    const discard = (): void => armIdle();
    const drained = (): void => stopDraining();
    const hard = setTimeout(sever, OVERSIZE_LINGER_MAX_MS);
    hard.unref();
    req.on("data", discard);
    req.once("end", drained);
    armIdle();
    req.resume();
  }
}
