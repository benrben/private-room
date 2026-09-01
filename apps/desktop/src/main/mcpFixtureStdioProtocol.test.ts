import { describe, expect, it } from "vitest";
import { createStdioFixtureHandler, toolsPage } from "./mcpFixtureStdioProtocol.mjs";

interface CapturedFixture {
  stdout: string[];
  stderr: string[];
  exits: number[];
  handle(raw: string): void;
}

function fixture(): CapturedFixture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const processLike = {
    stdout: { write: (text: string): void => { stdout.push(text); } },
    stderr: { write: (text: string): void => { stderr.push(text); } },
    exit: (code: number): void => { exits.push(code); },
  };
  return { stdout, stderr, exits, handle: createStdioFixtureHandler(processLike) };
}

function request(id: string, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

function replies(stdout: readonly string[]): Array<Record<string, unknown>> {
  return stdout.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("mcpFixtureStdioProtocol", () => {
  it("describes both tool-list pages", () => {
    expect(toolsPage(undefined).nextCursor).toBe("page2");
    expect(toolsPage("page2").tools.map((tool) => tool.name)).toEqual([
      "boom",
      "picture",
      "junk_then_ok",
      "ping_me",
      "loud_stderr",
      "hang",
      "die_with_stderr",
      "null_error",
      "unknown_error",
      "unsupported_request",
    ]);
  });

  it("handles lifecycle, valid tools, junk, ping, errors, stderr, and exits", () => {
    const f = fixture();
    f.handle("not json");
    f.handle(request("init", "initialize"));
    f.handle(request("notice", "notifications/initialized"));
    f.handle(request("list-1", "tools/list"));
    f.handle(request("list-2", "tools/list", { cursor: "page2" }));
    f.handle(request("echo-empty", "tools/call", { name: "echo" }));
    f.handle(request("echo", "tools/call", { name: "echo", arguments: { answer: 42 } }));
    f.handle(request("boom", "tools/call", { name: "boom" }));
    f.handle(request("picture", "tools/call", { name: "picture" }));
    f.handle(request("junk", "tools/call", { name: "junk_then_ok" }));
    f.handle(request("ping", "tools/call", { name: "ping_me" }));
    f.handle(JSON.stringify({ jsonrpc: "2.0", id: "srv-ping-1", result: {} }));
    f.handle(request("loud", "tools/call", { name: "loud_stderr" }));
    f.handle(request("null", "tools/call", { name: "null_error" }));
    f.handle(request("malformed", "tools/call", { name: "unknown_error" }));
    f.handle(request("unsupported", "tools/call", { name: "unsupported_request" }));
    f.handle(JSON.stringify({ jsonrpc: "2.0", id: "srv-unsupported-1", error: { code: -32601 } }));
    f.handle(request("hang", "tools/call", { name: "hang" }));
    f.handle(request("missing", "tools/call", { name: "missing" }));
    f.handle(request("unknown", "made/up"));
    f.handle(JSON.stringify({ jsonrpc: "2.0", method: "notification/unknown" }));
    f.handle(request("die", "tools/call", { name: "die_with_stderr" }));
    f.handle(JSON.stringify({ jsonrpc: "2.0", id: "srv-ping-1", result: {} }));

    const byId = new Map(replies(f.stdout).map((reply) => [reply.id, reply]));
    expect(byId.get("init")?.result).toMatchObject({ protocolVersion: "2025-06-18" });
    expect((byId.get("list-1")?.result as { tools: unknown[] }).tools).toHaveLength(1);
    expect((byId.get("list-2")?.result as { tools: unknown[] }).tools).toHaveLength(10);
    expect(byId.get("echo-empty")?.result).toMatchObject({ content: [{ text: "{}" }] });
    expect(byId.get("echo")?.result).toMatchObject({ content: [{ text: '{"answer":42}' }] });
    expect(byId.get("boom")?.result).toMatchObject({ isError: true });
    expect(byId.get("picture")?.result).toMatchObject({ content: [{ type: "text" }, { type: "image" }] });
    expect(f.stdout).toContain("this line is not json at all\n");
    expect(byId.get("junk")?.result).toMatchObject({ content: [{ text: "ok after junk" }] });
    expect(byId.get("srv-ping-1")).toMatchObject({ method: "ping" });
    expect(byId.get("ping")?.result).toMatchObject({ content: [{ text: "answered after pong" }] });
    expect(byId.get("loud")?.result).toMatchObject({ content: [{ text: "done chattering" }] });
    expect(byId.get("null")).toMatchObject({ error: null, result: { content: [{ text: "fine, actually" }] } });
    expect(byId.get("malformed")).toEqual({
      jsonrpc: "2.0",
      id: "malformed",
      error: "malformed error payload",
    });
    expect(byId.get("srv-unsupported-1")).toMatchObject({ method: "roots/list" });
    expect(byId.get("unsupported")?.result).toMatchObject({
      content: [{ text: "client refused unsupported request" }],
    });
    expect(byId.has("hang")).toBe(false);
    expect(byId.get("missing")?.error).toMatchObject({ code: -32602 });
    expect(byId.get("unknown")?.error).toMatchObject({ code: -32601 });
    expect(f.stderr).toHaveLength(7);
    expect(f.exits).toEqual([1]);
  });
});
