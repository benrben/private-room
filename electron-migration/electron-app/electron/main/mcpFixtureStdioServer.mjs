#!/usr/bin/env node
/**
 * A tiny, real MCP stdio server used ONLY by `mcpClient.test.ts` to prove
 * `mcpClient.ts`'s stdio transport against an actual child process speaking
 * newline-delimited JSON-RPC 2.0 — not an in-process mock of the protocol.
 *
 * Understands: initialize, notifications/initialized, tools/list (two pages,
 * paginated by `cursor`), and tools/call for a handful of named tools that
 * each exercise one thing the real port has to get right:
 *
 * - "echo"          -> text content echoing its arguments (the ordinary path)
 * - "boom"          -> isError:true (the client must throw, not return text)
 * - "picture"       -> a text block plus one image block (image carrying)
 * - "junk_then_ok"  -> writes one non-JSON line to stdout FIRST (a server
 *                      logging to stdout by mistake), then the real response
 *                      -- the client must skip the junk line, not choke on it
 * - "ping_me"       -> sends the CLIENT an unsolicited server->client
 *                      "ping" request before answering, and only answers
 *                      the tools/call once it has read back the client's
 *                      pong -- exercises the stub-reply-to-server-requests path
 * - "loud_stderr"   -> writes several stderr lines (including non-ASCII) then
 *                      answers normally -- proves stderr capture coexists
 *                      with a normal reply
 * - "hang"          -> never responds (client-side timeout test)
 * - "die_with_stderr" -> writes stderr lines then exits without responding
 *                        (the "Server exited: <tail>" path)
 * - "null_error"    -> answers with a real `result` AND an explicit
 *                      "error": null, the shape Rust's stdio arm would have
 *                      reported as "tools/call failed: unknown error" while
 *                      its own HTTP arm filtered it out -- see mcpClient.ts's
 *                      second DEVIATION note
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function toolsPage(cursor) {
  if (cursor === undefined || cursor === null) {
    return {
      tools: [
        { name: "echo", description: "Echoes its arguments", inputSchema: { type: "object", properties: {} } },
      ],
      nextCursor: "page2",
    };
  }
  return {
    tools: [
      {
        name: "boom",
        description: "Always fails",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      { name: "picture", description: "Returns an image", inputSchema: { type: "object", properties: {} } },
      { name: "junk_then_ok", description: "Logs junk first", inputSchema: { type: "object", properties: {} } },
      { name: "ping_me", description: "Pings the client first", inputSchema: { type: "object", properties: {} } },
      { name: "loud_stderr", description: "Chatters on stderr", inputSchema: { type: "object", properties: {} } },
      { name: "hang", description: "Never answers", inputSchema: { type: "object", properties: {} } },
      { name: "die_with_stderr", description: "Exits mid-call", inputSchema: { type: "object", properties: {} } },
      { name: "null_error", description: "Sends error:null beside a result", inputSchema: { type: "object", properties: {} } },
    ],
  };
}

let pendingPong = null;

rl.on("line", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return; // mirrors a real server: never emit malformed JSON of its own
  }

  // A reply FROM the client to a server-initiated request (our "ping_me" flow).
  if (msg.id === "srv-ping-1" && msg.result !== undefined) {
    if (pendingPong) {
      const respond = pendingPong;
      pendingPong = null;
      respond();
    }
    return;
  }

  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "0" } } });
      return;
    case "notifications/initialized":
      return; // notification: no reply
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: toolsPage(params && params.cursor) });
      return;
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      switch (name) {
        case "echo":
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(args) }] } });
          return;
        case "boom":
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "kaboom" }], isError: true } });
          return;
        case "picture":
          send({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                { type: "text", text: "a picture" },
                { type: "image", data: "AAAA", mimeType: "image/png" },
              ],
            },
          });
          return;
        case "junk_then_ok":
          process.stdout.write("this line is not json at all\n");
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok after junk" }] } });
          return;
        case "ping_me":
          pendingPong = () => {
            send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "answered after pong" }] } });
          };
          send({ jsonrpc: "2.0", id: "srv-ping-1", method: "ping", params: {} });
          return;
        case "loud_stderr":
          for (let i = 0; i < 5; i++) {
            process.stderr.write(`chatter line ${i} héllo 🚀\n`);
          }
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done chattering" }] } });
          return;
        case "null_error":
          send({
            jsonrpc: "2.0",
            id,
            error: null,
            result: { content: [{ type: "text", text: "fine, actually" }] },
          });
          return;
        case "hang":
          return; // deliberately never responds
        case "die_with_stderr":
          process.stderr.write("fatal: about to exit\n");
          process.stderr.write("goodbye\n");
          process.exit(1);
          return;
        default:
          send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } });
          return;
      }
    }
    default:
      // An unrecognized server->client-shaped request would be answered by
      // OUR client with -32601; here we are the server, and an unrecognized
      // METHOD FROM the client just gets a generic error.
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
      }
  }
});
