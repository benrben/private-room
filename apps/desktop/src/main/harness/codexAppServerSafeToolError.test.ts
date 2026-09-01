import { describe, expect, it } from "vitest";
import { safeToolError } from "./codexAppServer.js";

describe("safeToolError", () => {
  it("ignores completed items without an error", () => {
    expect(safeToolError({ status: "completed" })).toBeUndefined();
  });

  it.each([
    ["read-only workspace", "The provider treated this tool as read-only."],
    ["no file at the requested path", "The requested workspace file was not found."],
    ["invalid input schema", "The provider rejected the tool arguments."],
    ["permission denied", "The provider denied the tool permission request."],
    ["HTTP 429 rate limited", "The Room MCP call failed with HTTP 429."],
    ["MCP transport ended", "The provider reported a Room MCP transport failure."],
    ["could not connect to server", "The provider could not complete the Room MCP call."],
    ["unclassified failure", "Codex tool failed. Provider diagnostics were omitted to protect room data."],
  ])("normalizes %s", (message, expected) => {
    expect(safeToolError({ status: "failed", error: { message } })).toBe(expected);
  });

  it("normalizes items that provide an error without a failed status", () => {
    expect(safeToolError({ error: { message: "HTTP 503" } })).toBe("The Room MCP call failed with HTTP 503.");
  });
});
