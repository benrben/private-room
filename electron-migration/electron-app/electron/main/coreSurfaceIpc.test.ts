import { describe, expect, it } from "vitest";
import type { McpRoute } from "./toolSpecs.js";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import { McpManager } from "./mcpClient.js";
import {
  specialistEffectiveToolNames,
  specialistMcpRoutes,
  specialistServedToolNames,
} from "./coreSurfaceIpc.js";

function route(): McpRoute {
  return {
    catalogName: "notes_lookup",
    toolName: "lookup",
    serverName: "notes",
    remote: false,
    spec: {
      type: "function",
      function: {
        name: "notes_lookup",
        description: "Look up a note.",
        parameters: { type: "object", properties: {} },
      },
    },
  };
}

describe("specialist roster bridge catalog", () => {
  it("keeps web and connector specialists unreachable when their capabilities are off", () => {
    const names = specialistServedToolNames("qwen3.5:4b", false, []);
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("browse_open");
    expect(names).not.toContain("search_mcp_tools");
    expect(names).not.toContain("run_mcp_tool");
  });

  it("adds the connector proxy pair only when a live route exists", () => {
    const withoutConnector = specialistServedToolNames("qwen3.5:4b", true, []);
    const withConnector = specialistServedToolNames("qwen3.5:4b", true, [route()]);

    expect(withoutConnector).not.toContain("search_mcp_tools");
    expect(withoutConnector).not.toContain("run_mcp_tool");
    expect(withConnector).toContain("search_mcp_tools");
    expect(withConnector).toContain("run_mcp_tool");
    expect(withConnector).toContain("web_search");
    expect(withConnector).toContain("browse_open");
  });

  it("removes direct mutation tools only for cloud providers under Cloud Privacy", () => {
    const cloud = specialistEffectiveToolNames("minimax-m3:cloud", true, [], true);
    expect(cloud).not.toContain("draw");
    expect(cloud).not.toContain("organize_files");
    expect(cloud).toContain("read_drawing");

    const local = specialistEffectiveToolNames("qwen3.5:4b", true, [], true);
    expect(local).toContain("draw");
    expect(local).toContain("organize_files");
  });

  it("reads connected connector tools from the live manager at roster time", () => {
    const manager = new McpManager();
    const state = { room: null } as RoomManagerState;
    const deps = { userDataDir: "/tmp/unused", mcp: manager } as RoomManagerDeps;

    expect(specialistMcpRoutes(state, deps)).toEqual([]);
    manager.servers.push({
      name: "notes",
      status: "connected",
      error: null,
      tools: [{
        name: "lookup",
        description: "Look up a note.",
        schema: { type: "object", properties: {} },
        annotations: null,
      }],
      remote: false,
      client: { callTool: async () => ({ text: "", images: [] }), close: () => undefined },
      configKey: "notes-v1",
    });

    const routes = specialistMcpRoutes(state, deps);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      catalogName: "notes_lookup",
      toolName: "lookup",
      serverName: "notes",
    });
    expect(specialistServedToolNames("qwen3.5:4b", false, routes)).toEqual(
      expect.arrayContaining(["search_mcp_tools", "run_mcp_tool"]),
    );

    manager.servers[0]!.status = "disabled";
    expect(specialistMcpRoutes(state, deps)).toEqual([]);
  });
});
