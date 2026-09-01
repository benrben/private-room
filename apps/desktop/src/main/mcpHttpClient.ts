import { CALL_TIMEOUT_MS, CLIENT_VERSION, CONNECT_TIMEOUT_MS, McpClient, PROTOCOL_VERSION, ServerConfig, StdioClient, StdioConnectOptions, Tool, ToolOutput, asRecord, collectTools, errMessage, flattenCallResult, isPlainObject, jsonRpcError } from "./mcpClient.js";



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
  if (isSseHttpReply(ctype, body)) return sseHttpMessage(body, id);
  return parsedHttpJson(body);
}
export function isSseHttpReply(ctype: string, body: string): boolean {
  return ctype.includes("text/event-stream") || body.trimStart().startsWith("event:");
}
export function sseHttpMessage(body: string, id: number): unknown {
  for (const rawLine of body.split("\n")) {
    const message = sseLineMessage(rawLine, id);
    if (message !== undefined) return message;
  }
  return undefined;
}
export function sseLineMessage(rawLine: string, id: number): unknown {
  const data = sseLineData(rawLine);
  if (data === null) return undefined;
  try {
    const value: unknown = JSON.parse(data);
    const record = asRecord(value);
    if (record["method"] !== undefined || record["id"] !== id) return undefined;
    return value;
  } catch {
    // not JSON — keep scanning
    return undefined;
  }
}
export function sseLineData(rawLine: string): string | null {
  const line = rawLine.trimStart();
  if (!line.startsWith("data:")) return null;
  const data = line.slice("data:".length).trim();
  return data === "" ? null : data;
}
export function parsedHttpJson(body: string): unknown {
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
export

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
    const resp = await this.postWithDeadline(body, timeoutMs);
    this.rememberSessionId(resp);
    return httpResponseDetails(resp);
  }

  private async postWithDeadline(body: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: this.requestHeaders(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw remoteFetchError(e);
    } finally {
      clearTimeout(timer);
    }
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...this.headers,
    };
    if (this.sessionId !== null) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private rememberSessionId(resp: Response): void {
    const sid = resp.headers.get("mcp-session-id");
    if (sid !== null) {
      this.sessionId = sid;
    }
  }

  private async notify(method: string, params: unknown, timeoutMs: number): Promise<void> {
    const response = await this.post({ jsonrpc: "2.0", method, params }, timeoutMs);
    // 200 or 202 (Accepted, empty body) are both fine for a notification.
    throwForHttpAuthorization(method, response);
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.nextId += 1;
    const id = this.nextId;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    throwForHttpAuthorization(method, response);
    throwForHttpStatus(method, response);
    return httpRequestResult(method, response, id);
  }
}
export interface HttpResponseDetails {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
  readonly wwwAuthenticate: string | null;
}
export function remoteFetchError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return new Error("Remote server timed out.");
  return new Error(`Could not reach the remote server: ${errMessage(error)}`);
}
export async function httpResponseDetails(resp: Response): Promise<HttpResponseDetails> {
  const contentType = resp.headers.get("content-type") ?? "";
  const wwwAuthenticate = resp.headers.get("www-authenticate");
  const text = await resp.text();
  return { status: resp.status, contentType, text, wwwAuthenticate };
}
export function throwForHttpAuthorization(method: string, response: HttpResponseDetails): void {
  if (response.status !== 401 && response.status !== 403) return;
  throw new Error(authErrorMessage(method, response.status, response.wwwAuthenticate));
}
export function throwForHttpStatus(method: string, response: HttpResponseDetails): void {
  if (response.status >= 200 && response.status < 300) return;
  const snippet = Array.from(response.text).slice(0, 200).join("");
  throw new Error(`${method}: remote server returned HTTP ${response.status} ${snippet}`);
}
export function httpRequestResult(method: string, response: HttpResponseDetails, id: number): unknown {
  const message = parseHttpMessage(response.contentType, response.text, id);
  if (message === undefined) throw new Error(`${method}: no JSON-RPC response in the reply`);
  const record = asRecord(message);
  const error = jsonRpcError(record);
  if (error !== null) throw new Error(`${method} failed: ${error}`);
  return record["result"];
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
