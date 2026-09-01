import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogEntry,
  McpServerStatus,
  RuntimeStatus,
} from "../apiTypes";
import McpMarketplace from "./McpMarketplace";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({
  mcpRegistryOptinStatus: vi.fn<() => Promise<boolean>>(),
  setMcpRegistryOptin: vi.fn<(enabled: boolean) => Promise<void>>(),
  mcpRegistrySearch: vi.fn<(query?: string, limit?: number) => Promise<CatalogEntry[]>>(),
  getMcpAutoApprove: vi.fn<() => Promise<boolean>>(),
  getMcpOutboundUnmask: vi.fn<() => Promise<boolean>>(),
  mcpOauthStatus: vi.fn<(server: string) => Promise<boolean>>(),
  mcpRuntimeForCommand: vi.fn<(command: string) => Promise<RuntimeStatus>>(),
  onRuntimeProgress: vi.fn<(callback: (progress: { kind: string; phase: string; got: number; total: number }) => void) => Promise<() => void>>(),
  mcpStatus: vi.fn<() => Promise<McpServerStatus[]>>(),
  onMcpStatus: vi.fn<(callback: (statuses: McpServerStatus[]) => void) => Promise<() => void>>(),
  mcpProvisionRuntime: vi.fn<(kind: string) => Promise<void>>(),
  onMcpOauthUrl: vi.fn<(callback: (payload: { server: string; url: string }) => void) => Promise<() => void>>(),
  mcpOauthAuthorize: vi.fn<(server: string) => Promise<McpServerStatus[]>>(),
  mcpOauthSignOut: vi.fn<(server: string) => Promise<McpServerStatus[]>>(),
}));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));

const localEntry: CatalogEntry = {
  id: "local-id",
  name: "local-tools",
  title: "Local Tools",
  icon: null,
  description: "Local connector",
  publisher: "arcelle",
  verified: true,
  remote: false,
  transport: "stdio",
  repository: "https://example.test/source",
  install: { kind: "stdio", command: "uvx", args: ["local-tools"], envKeys: ["LOCAL_TOKEN"] },
  altInstall: { kind: "http", url: "https://cloud.example.test/mcp", headerKeys: ["Authorization"] },
};

const remoteEntry: CatalogEntry = {
  id: "remote-id",
  name: "remote-tools",
  title: null,
  icon: null,
  description: "Remote connector",
  publisher: "community",
  verified: false,
  remote: true,
  transport: "http",
  repository: null,
  install: { kind: "http", url: "https://remote.example.test/mcp", headerKeys: [] },
  altInstall: null,
};

const badEntry: CatalogEntry = {
  ...remoteEntry,
  id: "bad-id",
  name: "bad-tools",
  title: "Bad endpoint",
  install: { kind: "http", url: "ftp://bad.example.test", headerKeys: [] },
};

const connectedStatus: McpServerStatus = {
  name: "local-tools",
  status: "connected",
  error: null,
  tools: ["one", "two"],
  remote: false,
};

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

let runtimeProgressHandler: ((progress: { kind: string; phase: string; got: number; total: number }) => void) | undefined;
let statusHandler: ((statuses: McpServerStatus[]) => void) | undefined;
let oauthUrlHandler: ((payload: { server: string; url: string }) => void) | undefined;

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.mcpRegistryOptinStatus.mockResolvedValue(true);
  bridge.setMcpRegistryOptin.mockResolvedValue(undefined);
  bridge.mcpRegistrySearch.mockResolvedValue([localEntry, remoteEntry, badEntry]);
  bridge.getMcpAutoApprove.mockResolvedValue(false);
  bridge.getMcpOutboundUnmask.mockResolvedValue(false);
  bridge.mcpOauthStatus.mockResolvedValue(false);
  bridge.mcpRuntimeForCommand.mockResolvedValue({ available: false, kind: "uv", provisionable: true, note: "uv is missing" });
  bridge.onRuntimeProgress.mockImplementation(async (callback) => {
    runtimeProgressHandler = callback;
    return () => {};
  });
  bridge.mcpStatus.mockResolvedValue([]);
  bridge.onMcpStatus.mockImplementation(async (callback) => {
    statusHandler = callback;
    return () => {};
  });
  bridge.mcpProvisionRuntime.mockResolvedValue(undefined);
  bridge.onMcpOauthUrl.mockImplementation(async (callback) => {
    oauthUrlHandler = callback;
    return () => {};
  });
  bridge.mcpOauthAuthorize.mockResolvedValue([]);
  bridge.mcpOauthSignOut.mockResolvedValue([]);
}

async function renderMarketplace(installedNames: string[] = []) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest", clipboard: { writeText: vi.fn(async () => {}) } },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const installServer = vi.fn(async (name: string) => [{ ...connectedStatus, name }]);
  await act(async () => {
    root.render(createElement(McpMarketplace, { installServer, installedNames }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  return { host, installServer, root, window };
}

async function click(host: Element, window: Window & typeof globalThis, label: string) {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

async function clickAria(host: Element, window: Window & typeof globalThis, label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`aria button not found: ${label}`);
  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing from node");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    reactProps<{ onChange: (event: { target: { value: string } }) => void }>(input).onChange({ target: { value } });
  });
}

async function changeCheckbox(input: HTMLInputElement, checked: boolean) {
  await act(async () => {
    reactProps<{ onChange: (event: { target: { checked: boolean } }) => void }>(input).onChange({ target: { checked } });
  });
}

async function openCard(
  view: Awaited<ReturnType<typeof renderMarketplace>>,
  accessibleName: string,
) {
  const card = view.host.querySelector<HTMLButtonElement>(`button[aria-label="${accessibleName}"]`);
  if (!card) throw new Error(`catalog card missing: ${accessibleName}`);
  await act(async () => card.dispatchEvent(new view.window.Event("click", { bubbles: true })));
}

async function pressEscape(window: Window & typeof globalThis) {
  const event = new window.Event("keydown", { bubbles: true });
  Object.defineProperty(event, "key", { value: "Escape" });
  await act(async () => {
    window.dispatchEvent(event);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetBridge();
});

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (key === "navigator") {
      Reflect.deleteProperty(globalThis, key);
      if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor);
      continue;
    }
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("McpMarketplace", () => {
  it("opts into the catalog, filters entries, and installs a local connector after confirmation", async () => {
    bridge.mcpRegistryOptinStatus.mockResolvedValue(false);
    const view = await renderMarketplace();
    expect(view.host.textContent).toContain("Browse the connector marketplace");
    await click(view.host, view.window, "Turn on registry browsing");
    expect(bridge.setMcpRegistryOptin).toHaveBeenCalledWith(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(view.host.textContent).toContain("Local Tools");
    const card = view.host.querySelector<HTMLButtonElement>('button[aria-label="Local Tools by arcelle"]');
    if (!card) throw new Error("local card missing");
    await act(async () => card.dispatchEvent(new view.window.Event("click", { bubbles: true })));
    expect(view.host.textContent).toContain("uv is missing");
    await click(view.host, view.window, "Download uv for me");
    expect(bridge.mcpProvisionRuntime).toHaveBeenCalledWith("uv");
    const secret = view.host.querySelector<HTMLInputElement>('input[placeholder="value for LOCAL_TOKEN"]');
    if (!secret) throw new Error("secret input missing");
    await changeInput(secret, "  local-secret  ");
    await click(view.host, view.window, "Install to this room");
    expect(view.host.textContent).toContain("Start this program on your Mac now?");
    await click(view.host, view.window, "Yes, start it now");
    expect(view.installServer).toHaveBeenCalledWith("local-tools", { command: "uvx", args: ["local-tools"], env: { LOCAL_TOKEN: "local-secret" } });
    expect(view.host.textContent).toContain("Added to this room");
    await act(async () => view.root.unmount());
  });

  it("switches to cloud installation and supports catalog, install, OAuth, and endpoint failures", async () => {
    const view = await renderMarketplace(["remote-tools"]);
    const localCard = view.host.querySelector<HTMLButtonElement>('button[aria-label="Local Tools by arcelle"]');
    if (!localCard) throw new Error("local card missing");
    await act(async () => localCard.dispatchEvent(new view.window.Event("click", { bubbles: true })));
    await click(view.host, view.window, "Run locally");
    await click(view.host, view.window, "Use cloud");
    expect(view.host.textContent).toContain("This connector runs in the cloud.");
    const header = view.host.querySelector<HTMLInputElement>('input[placeholder="Bearer …"]');
    if (!header) throw new Error("header input missing");
    await changeInput(header, "Bearer cloud-token");
    await click(view.host, view.window, "Review & connect");
    await click(view.host, view.window, "Yes, connect now");
    expect(view.installServer).toHaveBeenCalledWith("local-tools", { type: "http", url: "https://cloud.example.test/mcp", headers: { Authorization: "Bearer cloud-token" } });
    await click(view.host, view.window, "Connect account (sign in)");
    expect(bridge.mcpOauthAuthorize).toHaveBeenCalledWith("local-tools");
    expect(view.host.textContent).toContain("Signed in");
    await click(view.host, view.window, "Sign out");
    expect(bridge.mcpOauthSignOut).toHaveBeenCalledWith("local-tools");
    await clickAria(view.host, view.window, "Close");
    const badCard = view.host.querySelector<HTMLButtonElement>('button[aria-label="Bad endpoint by community"]');
    if (!badCard) throw new Error("bad card missing");
    await act(async () => badCard.dispatchEvent(new view.window.Event("click", { bubbles: true })));
    expect(view.host.textContent).toContain("not a usable http(s) URL");
    await click(view.host, view.window, "Turn off browsing");
    expect(bridge.setMcpRegistryOptin).toHaveBeenCalledWith(false);
    await act(async () => view.root.unmount());
  });

  it("reports registry failures and supports search, clear, filters, retries, and opting back out", async () => {
    bridge.mcpRegistryOptinStatus.mockRejectedValueOnce(new Error("status unavailable"));
    bridge.setMcpRegistryOptin.mockRejectedValueOnce(new Error("cannot opt in"));
    const view = await renderMarketplace();
    expect(view.host.textContent).toContain("Browse the connector marketplace");
    await click(view.host, view.window, "Turn on registry browsing");
    expect(view.host.textContent).toContain("cannot opt in");

    await click(view.host, view.window, "Turn on registry browsing");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const search = view.host.querySelector<HTMLInputElement>(".mkt-search-input");
    if (!search) throw new Error("search input missing");
    await changeInput(search, "search");
    await act(async () => {
      reactProps<{ onKeyDown: (event: { key: string; stopPropagation: () => void }) => void }>(search).onKeyDown({
        key: "Escape",
        stopPropagation: vi.fn(),
      });
    });
    await clickAria(view.host, view.window, "Clear the search");

    const filters = [...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await changeCheckbox(filters[0]!, true);
    await changeCheckbox(filters[1]!, true);
    await changeCheckbox(filters[2]!, true);
    expect(view.host.textContent).toContain("No connectors match");
    await changeCheckbox(filters[2]!, false);
    await changeCheckbox(filters[0]!, false);
    expect(view.host.textContent).toContain("2 hidden by filters");

    bridge.mcpRegistrySearch.mockRejectedValueOnce(new Error("catalog unavailable"));
    await changeInput(search, "broken");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(view.host.textContent).toContain("catalog unavailable");
    await click(view.host, view.window, "Retry");
    expect(view.host.textContent).toContain("Local Tools");

    bridge.mcpRegistrySearch.mockResolvedValueOnce([]);
    await changeInput(search, "empty");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(view.host.textContent).toContain("The registry returned nothing");
    bridge.setMcpRegistryOptin.mockRejectedValueOnce(new Error("cannot opt out"));
    await click(view.host, view.window, "Turn off browsing");
    expect(view.host.textContent).toContain("cannot opt out");
    await click(view.host, view.window, "Turn off browsing");
    expect(view.host.textContent).toContain("Browse the connector marketplace");
    await act(async () => view.root.unmount());
  });

  it("reports local installation failures and closes the drawer with Escape", async () => {
    const view = await renderMarketplace();
    await openCard(view, "Local Tools by arcelle");
    if (!runtimeProgressHandler) throw new Error("runtime progress listener missing");
    await act(async () => runtimeProgressHandler?.({ kind: "uv", phase: "download", got: 0, total: 0 }));
    bridge.mcpProvisionRuntime.mockRejectedValueOnce(new Error("download failed"));
    await click(view.host, view.window, "Download uv for me");
    expect(view.host.textContent).toContain("download failed");
    await click(view.host, view.window, "Install to this room");
    await click(view.host, view.window, "Not now");
    await click(view.host, view.window, "Install to this room");
    bridge.mcpProvisionRuntime.mockResolvedValue(undefined);
    view.installServer.mockRejectedValueOnce(new Error("install failed"));
    await click(view.host, view.window, "Yes, start it now");
    expect(view.host.textContent).toContain("install failed");
    await pressEscape(view.window);
    expect(view.host.querySelector(".mkt-drawer")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("keeps remote OAuth recoverable and renders every reported connection status", async () => {
    let resolveOauth: ((statuses: McpServerStatus[]) => void) | undefined;
    bridge.mcpOauthAuthorize.mockImplementation(() => new Promise((resolve) => {
      resolveOauth = resolve;
    }));
    bridge.getMcpAutoApprove.mockResolvedValue(true);
    bridge.getMcpOutboundUnmask.mockResolvedValue(true);
    const view = await renderMarketplace(["remote-tools"]);
    await openCard(view, "remote-tools by community");
    expect(view.host.textContent).toContain("runs connector tools without asking you");
    expect(view.host.textContent).toContain("sends it this room's real values");
    await click(view.host, view.window, "Connect account (sign in)");
    if (!oauthUrlHandler) throw new Error("OAuth URL listener missing");
    await act(async () => oauthUrlHandler?.({ server: "remote-tools", url: "https://sign-in.example.test" }));
    expect(view.host.textContent).toContain("Open sign-in page");
    await click(view.host, view.window, "Copy link");
    await act(async () => { await Promise.resolve(); });
    expect(view.host.textContent).toContain("Copied");
    await click(view.host, view.window, "Cancel");
    resolveOauth?.([]);
    await act(async () => {});

    if (!statusHandler) throw new Error("status listener missing");
    await act(async () => statusHandler?.([{ ...connectedStatus, name: "remote-tools", status: "connecting", remote: true }]));
    expect(view.host.textContent).toContain("Connecting");
    await act(async () => statusHandler?.([{ ...connectedStatus, name: "remote-tools", status: "disabled", remote: true }]));
    expect(view.host.textContent).toContain("Added, but switched off");
    await act(async () => statusHandler?.([{ ...connectedStatus, name: "remote-tools", status: "failed", error: "remote failed", remote: true }]));
    expect(view.host.textContent).toContain("remote failed");
    await act(async () => statusHandler?.([{ ...connectedStatus, name: "remote-tools", status: "unknown" as McpServerStatus["status"], remote: true }]));

    bridge.mcpOauthAuthorize.mockRejectedValueOnce(new Error("oauth failed"));
    await click(view.host, view.window, "Connect account (sign in)");
    expect(view.host.textContent).toContain("oauth failed");
    bridge.mcpOauthAuthorize.mockResolvedValueOnce([]);
    await click(view.host, view.window, "Connect account (sign in)");
    expect(view.host.textContent).toContain("Signed in");
    bridge.mcpOauthSignOut.mockRejectedValueOnce(new Error("sign out failed"));
    await click(view.host, view.window, "Sign out");
    expect(view.host.textContent).toContain("sign out failed");
    await act(async () => view.root.unmount());
  });

  it("releases a status subscription that resolves after the drawer closes", async () => {
    let resolveSubscription: ((unsubscribe: () => void) => void) | undefined;
    const unsubscribe = vi.fn();
    bridge.onMcpStatus.mockImplementation(() => new Promise((resolve) => {
      resolveSubscription = resolve;
    }));
    const view = await renderMarketplace(["remote-tools"]);
    await openCard(view, "remote-tools by community");
    await act(async () => view.root.unmount());
    await act(async () => {
      resolveSubscription?.(unsubscribe);
      await Promise.resolve();
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
