/** JSON-RPC protocol behavior for the stdio fixture server. Kept separate
 * from the process wiring so the same real child-process fixture can also be
 * exercised directly without spawning an extra process for every branch. */

export function toolsPage(cursor) {
  if (cursor === undefined || cursor === null) {
    return {
      tools: [{ name: "echo", description: "Echoes its arguments", inputSchema: { type: "object", properties: {} } }],
      nextCursor: "page2",
    };
  }
  return {
    tools: [
      { name: "boom", description: "Always fails", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: "picture", description: "Returns an image", inputSchema: { type: "object", properties: {} } },
      { name: "junk_then_ok", description: "Logs junk first", inputSchema: { type: "object", properties: {} } },
      { name: "ping_me", description: "Pings the client first", inputSchema: { type: "object", properties: {} } },
      { name: "loud_stderr", description: "Chatters on stderr", inputSchema: { type: "object", properties: {} } },
      { name: "hang", description: "Never answers", inputSchema: { type: "object", properties: {} } },
      { name: "die_with_stderr", description: "Exits mid-call", inputSchema: { type: "object", properties: {} } },
      { name: "null_error", description: "Sends error:null beside a result", inputSchema: { type: "object", properties: {} } },
      { name: "unknown_error", description: "Sends a malformed JSON-RPC error", inputSchema: { type: "object", properties: {} } },
      { name: "unsupported_request", description: "Asks the client for an unsupported capability", inputSchema: { type: "object", properties: {} } },
    ],
  };
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function callResult(id, text, extra = {}) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] }, ...extra };
}

function callArguments(message) {
  return message.params && message.params.arguments ? message.params.arguments : {};
}

function sendInit(message, transport) {
  transport.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "0" } } });
}

function sendToolList(message, transport) {
  transport.send({ jsonrpc: "2.0", id: message.id, result: toolsPage(message.params && message.params.cursor) });
}

function echoTool(message, transport) {
  transport.send(callResult(message.id, JSON.stringify(callArguments(message))));
  return null;
}

function boomTool(message, transport) {
  transport.send(callResult(message.id, "kaboom", { result: { content: [{ type: "text", text: "kaboom" }], isError: true } }));
  return null;
}

function pictureTool(message, transport) {
  transport.send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "a picture" }, { type: "image", data: "AAAA", mimeType: "image/png" }] } });
  return null;
}

function junkTool(message, transport) {
  transport.writeStdout("this line is not json at all\n");
  transport.send(callResult(message.id, "ok after junk"));
  return null;
}

function pingTool(message, transport) {
  transport.send({ jsonrpc: "2.0", id: "srv-ping-1", method: "ping", params: {} });
  return () => transport.send(callResult(message.id, "answered after pong"));
}

function loudStderrTool(message, transport) {
  for (let index = 0; index < 5; index += 1) transport.writeStderr(`chatter line ${index} héllo 🚀\n`);
  transport.send(callResult(message.id, "done chattering"));
  return null;
}

function nullErrorTool(message, transport) {
  transport.send(callResult(message.id, "fine, actually", { error: null }));
  return null;
}

function unknownErrorTool(message, transport) {
  transport.send({ jsonrpc: "2.0", id: message.id, error: "malformed error payload" });
  return null;
}

function unsupportedRequestTool(message, transport) {
  transport.send({ jsonrpc: "2.0", id: "srv-unsupported-1", method: "roots/list", params: {} });
  return () => transport.send(callResult(message.id, "client refused unsupported request"));
}

function hangTool() {
  return null;
}

function dieTool(_message, transport) {
  transport.writeStderr("fatal: about to exit\n");
  transport.writeStderr("goodbye\n");
  transport.exit(1);
  return null;
}

const TOOLS = { echo: echoTool, boom: boomTool, picture: pictureTool, junk_then_ok: junkTool, ping_me: pingTool, loud_stderr: loudStderrTool, hang: hangTool, die_with_stderr: dieTool, null_error: nullErrorTool, unknown_error: unknownErrorTool, unsupported_request: unsupportedRequestTool };

function handleToolCall(message, transport) {
  const handler = TOOLS[message.params && message.params.name];
  if (handler === undefined) {
    transport.send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${message.params && message.params.name}` } });
    return null;
  }
  return handler(message, transport);
}

function unknownMethod(message, transport) {
  if (message.id !== undefined) transport.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
}

function handleRequest(message, transport) {
  if (message.method === "initialize") {
    sendInit(message, transport);
    return null;
  }
  if (message.method === "notifications/initialized") return null;
  if (message.method === "tools/list") {
    sendToolList(message, transport);
    return null;
  }
  if (message.method === "tools/call") return handleToolCall(message, transport);
  unknownMethod(message, transport);
  return null;
}

function isServerRequestReply(message) {
  return (message.id === "srv-ping-1" || message.id === "srv-unsupported-1") &&
    (message.result !== undefined || message.error !== undefined);
}

export function createFixtureHandler(transport) {
  let pendingPong = null;
  return (raw) => {
    const message = parseMessage(raw);
    if (message === null) return;
    if (isServerRequestReply(message)) {
      const response = pendingPong;
      pendingPong = null;
      if (response) response();
      return;
    }
    pendingPong = handleRequest(message, transport);
  };
}

export function createStdioFixtureHandler(processLike) {
  return createFixtureHandler({
    send: (message) => processLike.stdout.write(`${JSON.stringify(message)}\n`),
    writeStdout: (text) => processLike.stdout.write(text),
    writeStderr: (text) => processLike.stderr.write(text),
    exit: (code) => processLike.exit(code),
  });
}
