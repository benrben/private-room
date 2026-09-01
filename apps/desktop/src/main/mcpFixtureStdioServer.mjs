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
import { createStdioFixtureHandler } from "./mcpFixtureStdioProtocol.mjs";

if (process.argv.includes("--exit-immediately")) process.exit(0);

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", createStdioFixtureHandler(process));
