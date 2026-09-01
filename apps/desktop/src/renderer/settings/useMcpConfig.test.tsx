import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerStatus } from "../api";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
  api: {
    getMcpAutoApprove: vi.fn(),
    getMcpOutboundUnmask: vi.fn(),
    mcpApplyConfig: vi.fn(),
    mcpGetConfig: vi.fn(),
    mcpGetConnectorPowers: vi.fn(),
    mcpRemoveServer: vi.fn(),
    mcpSetServerEnabled: vi.fn(),
    mcpSetConnectorPower: vi.fn(),
    mcpStatus: vi.fn(),
    setMcpAutoApprove: vi.fn(),
    setMcpOutboundUnmask: vi.fn(),
  },
}));

vi.mock("../platform", () => ({ listen: mocks.listen }));
vi.mock("../api", () => ({ api: mocks.api }));

import { useMcpConfig } from "./useMcpConfig";

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type McpConfig = ReturnType<typeof useMcpConfig>;
let mcpConfig: McpConfig | null = null;

function McpConfigProbe() {
  mcpConfig = useMcpConfig();
  return null;
}

function current(): McpConfig {
  if (!mcpConfig) throw new Error("MCP config hook has not rendered.");
  return mcpConfig;
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderHook() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(McpConfigProbe)));
  await flush();
  return { close: async () => { await act(async () => root.unmount()); await flush(); } };
}

function status(name: string): McpServerStatus {
  return { name, status: "connected", error: null, tools: ["search"], remote: true };
}

function configureMocks(config = "") {
  mcpConfig = null;
  mocks.listen.mockReset().mockResolvedValue(mocks.unlisten);
  mocks.unlisten.mockReset();
  mocks.api.getMcpAutoApprove.mockReset().mockResolvedValue(false);
  mocks.api.getMcpOutboundUnmask.mockReset().mockResolvedValue(false);
  mocks.api.mcpApplyConfig.mockReset().mockResolvedValue([status("installed")]);
  mocks.api.mcpGetConfig.mockReset().mockResolvedValue(config);
  mocks.api.mcpGetConnectorPowers.mockReset().mockResolvedValue({});
  mocks.api.mcpRemoveServer.mockReset().mockResolvedValue([status("remaining")]);
  mocks.api.mcpSetServerEnabled.mockReset().mockResolvedValue([status("updated")]);
  mocks.api.mcpSetConnectorPower.mockReset().mockResolvedValue({});
  mocks.api.mcpStatus.mockReset().mockResolvedValue([]);
  mocks.api.setMcpAutoApprove.mockReset().mockResolvedValue(undefined);
  mocks.api.setMcpOutboundUnmask.mockReset().mockResolvedValue(undefined);
}

beforeEach(() => configureMocks());

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useMcpConfig installServer", () => {
  it("merges an entry into the room's current config and exposes the fabricated applied statuses", async () => {
    const existing = { command: "uvx", args: ["existing"], env: { Authorization: "Bearer preserved" } };
    configureMocks(JSON.stringify({ name: "Room tools", mcpServers: { existing } }));
    const view = await renderHook();
    const entry = { type: "http", url: "https://tools.example.test/mcp", headers: { Authorization: "Bearer new" } };

    const installed = await act(async () => current().installServer("weather", entry));
    const appliedJson = mocks.api.mcpApplyConfig.mock.calls[0]?.[0];
    expect(JSON.parse(appliedJson)).toEqual({ name: "Room tools", mcpServers: { existing, weather: entry } });
    expect(installed).toEqual([status("installed")]);
    expect(current().mcpConfig).toBe(JSON.stringify({ name: "Room tools", mcpServers: { existing, weather: entry } }, null, 2));
    expect(current().mcpStatuses).toEqual([status("installed")]);
    expect(current().installedNames).toEqual(["installed"]);
    await view.close();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("rejects an invalid current config before any fabricated apply call", async () => {
    configureMocks("{ current config is not json }");
    const view = await renderHook();

    await act(async () => {
      await expect(current().installServer("weather", { type: "http" })).rejects.toThrow(
        "The current config isn't valid JSON",
      );
    });
    expect(mocks.api.mcpApplyConfig).not.toHaveBeenCalled();
    expect(current().mcpError).toBe("");
    await view.close();
  });

  it("keeps the merged config visible while propagating a fabricated apply failure", async () => {
    configureMocks("");
    mocks.api.mcpApplyConfig.mockRejectedValueOnce(new Error("connector validation failed"));
    const view = await renderHook();

    await act(async () => {
      await expect(current().installServer("weather", { type: "http", url: "https://tools.example.test/mcp" })).rejects.toThrow(
        "connector validation failed",
      );
    });
    expect(current().mcpConfig).toBe(JSON.stringify({ mcpServers: { weather: { type: "http", url: "https://tools.example.test/mcp" } } }, null, 2));
    expect(current().mcpStatuses).toEqual([]);
    expect(current().mcpError).toBe("");
    await view.close();
  });
});

describe("useMcpConfig applyMcp", () => {
  it("applies the edited fabricated config and exposes the returned statuses", async () => {
    configureMocks(JSON.stringify({ mcpServers: {} }));
    const view = await renderHook();
    await act(async () => {
      current().setMcpConfig(JSON.stringify({ mcpServers: { weather: { url: "https://tools.example.test" } } }));
    });

    await act(async () => {
      await current().applyMcp();
    });
    expect(mocks.api.mcpApplyConfig).toHaveBeenCalledWith(
      JSON.stringify({ mcpServers: { weather: { url: "https://tools.example.test" } } }),
    );
    expect(current().mcpStatuses).toEqual([status("installed")]);
    expect(current().mcpError).toBe("");
    await view.close();
  });

  it("refuses to erase a current fabricated connector sign-in", async () => {
    configureMocks(JSON.stringify({ mcpServers: { calendar: { headers: { Authorization: "Bearer preserved" } } } }));
    const view = await renderHook();
    await act(async () => {
      current().setMcpConfig(JSON.stringify({ mcpServers: { calendar: { headers: {} } } }));
    });

    await act(async () => {
      await current().applyMcp();
    });
    expect(mocks.api.mcpApplyConfig).not.toHaveBeenCalled();
    expect(current().mcpError).toContain("would drop that sign-in");
    await view.close();
  });

  it("keeps an apply failure visible", async () => {
    configureMocks(JSON.stringify({ mcpServers: {} }));
    mocks.api.mcpApplyConfig.mockRejectedValueOnce(new Error("fabricated rejected config"));
    const view = await renderHook();

    await act(async () => {
      await current().applyMcp();
    });
    expect(current().mcpError).toContain("fabricated rejected config");
    await view.close();
  });
});

describe("useMcpConfig setConnectorPower", () => {
  it("uses the fabricated stored power map and reloads it after a rejected update", async () => {
    const view = await renderHook();
    const saved = { calendar: { auto_approve: true } };
    mocks.api.mcpSetConnectorPower.mockResolvedValueOnce(saved);

    await act(async () => {
      await current().setConnectorPower("calendar", "auto_approve", true);
    });
    expect(mocks.api.mcpSetConnectorPower).toHaveBeenCalledWith("calendar", "auto_approve", true);
    expect(current().connectorPowers).toEqual(saved);
    expect(current().mcpError).toBe("");

    const restored = { calendar: { outbound_unmask: false } };
    mocks.api.mcpSetConnectorPower.mockRejectedValueOnce(new Error("fabricated permission failure"));
    mocks.api.mcpGetConnectorPowers.mockResolvedValueOnce(restored);
    await act(async () => {
      await current().setConnectorPower("calendar", "outbound_unmask", null);
    });
    await flush();
    expect(mocks.api.mcpSetConnectorPower).toHaveBeenLastCalledWith("calendar", "outbound_unmask", null);
    expect(current().mcpError).toBe("Error: fabricated permission failure");
    expect(current().connectorPowers).toEqual(restored);
    await view.close();
  });
});

describe("useMcpConfig connection controls", () => {
  it("reflects fabricated status events and persists both global connector powers", async () => {
    const view = await renderHook();
    const listener = mocks.listen.mock.calls[0]?.[1] as
      | ((event: { payload: McpServerStatus[] }) => void)
      | undefined;
    if (!listener) throw new Error("MCP status listener was not registered");

    await act(async () => listener({ payload: [status("live")] }));
    expect(current().installedNames).toEqual(["live"]);

    await act(async () => current().setAutoApprove(true));
    await act(async () => current().setOutboundUnmask(true));
    expect(mocks.api.setMcpAutoApprove).toHaveBeenCalledWith(true);
    expect(mocks.api.setMcpOutboundUnmask).toHaveBeenCalledWith(true);
    expect(current().autoApprove).toBe(true);
    expect(current().outboundUnmask).toBe(true);
    await view.close();
  });

  it("restores both global powers after fabricated persistence failures", async () => {
    mocks.api.setMcpAutoApprove.mockRejectedValueOnce(new Error("fake auto-approve failure"));
    mocks.api.getMcpAutoApprove.mockResolvedValueOnce(false);
    mocks.api.setMcpOutboundUnmask.mockRejectedValueOnce(new Error("fake unmask failure"));
    mocks.api.getMcpOutboundUnmask.mockResolvedValueOnce(false);
    const view = await renderHook();

    await act(async () => current().setAutoApprove(true));
    await act(async () => current().setOutboundUnmask(true));
    await flush();
    expect(current().autoApprove).toBe(false);
    expect(current().outboundUnmask).toBe(false);
    await view.close();
  });

  it("enables and removes fabricated servers while refreshing the editable config", async () => {
    mocks.api.mcpGetConfig
      .mockResolvedValueOnce("initial")
      .mockResolvedValueOnce("after enable")
      .mockResolvedValueOnce("after removal");
    const view = await renderHook();

    await act(async () => current().setServerEnabled("calendar", false));
    expect(mocks.api.mcpSetServerEnabled).toHaveBeenCalledWith("calendar", false);
    expect(current().mcpConfig).toBe("after enable");
    expect(current().installedNames).toEqual(["updated"]);

    await act(async () => current().removeServer("calendar"));
    expect(mocks.api.mcpRemoveServer).toHaveBeenCalledWith("calendar");
    expect(current().mcpConfig).toBe("after removal");
    expect(current().installedNames).toEqual(["remaining"]);
    await view.close();
  });

  it("surfaces fabricated enable and removal failures without replacing status", async () => {
    const view = await renderHook();
    mocks.api.mcpSetServerEnabled.mockRejectedValueOnce(new Error("fake enable failure"));
    await act(async () => current().setServerEnabled("calendar", true));
    expect(current().mcpError).toBe("Error: fake enable failure");

    mocks.api.mcpRemoveServer.mockRejectedValueOnce(new Error("fake removal failure"));
    await act(async () => current().removeServer("calendar"));
    expect(current().mcpError).toBe("Error: fake removal failure");
    await view.close();
  });
});
