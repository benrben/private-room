import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerStatus } from "../api";
import ConnectorsView from "./ConnectorsView";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({
  mcpGetToolPrefs: vi.fn<() => Promise<Record<string, string[]>>>(),
  mcpSetToolEnabled: vi.fn<(server: string, tool: string, enabled: boolean) => Promise<Record<string, string[]>>>(),
  mcpOauthStatus: vi.fn<(server: string) => Promise<boolean>>(),
  onMcpOauthUrl: vi.fn<(handler: (event: { server: string; url: string }) => void) => Promise<() => void>>(),
  mcpOauthAuthorize: vi.fn<(server: string) => Promise<unknown>>(),
  mcpOauthSignOut: vi.fn<(server: string) => Promise<unknown>>(),
}));

const config = vi.hoisted(() => ({ current: {} as Record<string, any> }));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../settings/useMcpConfig", () => ({ useMcpConfig: () => config.current }));
vi.mock("../settings/McpMarketplace", () => ({
  default: ({ installedNames }: { installedNames: string[] }) => createElement("div", { className: "marketplace" }, `marketplace:${installedNames.join(",")}`),
}));
vi.mock("../icons", () => ({
  AlertIcon: () => null,
  CloudIcon: () => null,
  TrashIcon: () => null,
}));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

let oauthUrlHandler: ((event: { server: string; url: string }) => void) | undefined;

function server(name: string, overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    name,
    status: "connected",
    error: null,
    tools: ["search", "write"],
    remote: false,
    ...overrides,
  };
}

function resetConfig(overrides: Record<string, unknown> = {}) {
  config.current = {
    mcpConfig: "{\"mcpServers\":{}}",
    setMcpConfig: vi.fn(),
    mcpStatuses: [] as McpServerStatus[],
    mcpError: "",
    applyMcp: vi.fn(async () => {}),
    installServer: vi.fn(async () => []),
    setServerEnabled: vi.fn(async () => {}),
    removeServer: vi.fn(async () => {}),
    autoApprove: false,
    setAutoApprove: vi.fn(async () => {}),
    outboundUnmask: false,
    setOutboundUnmask: vi.fn(async () => {}),
    connectorPowers: {},
    setConnectorPower: vi.fn(async () => {}),
    installedNames: [],
    ...overrides,
  };
}

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.mcpGetToolPrefs.mockResolvedValue({});
  bridge.mcpSetToolEnabled.mockResolvedValue({});
  bridge.mcpOauthStatus.mockResolvedValue(false);
  bridge.onMcpOauthUrl.mockImplementation(async (handler) => {
    oauthUrlHandler = handler;
    return () => {};
  });
  bridge.mcpOauthAuthorize.mockResolvedValue(undefined);
  bridge.mcpOauthSignOut.mockResolvedValue(undefined);
}

beforeEach(() => {
  resetBridge();
  resetConfig();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function renderConnectors() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLSelectElement", window.HTMLSelectElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async () => act(async () => {
    root.render(createElement(ConnectorsView));
    await Promise.resolve();
    await Promise.resolve();
  });
  await draw();
  return { document, draw, host, root, window };
}

function reactProp<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element) {
  await act(async () => reactProp<{ onClick: () => void }>(node).onClick());
}

async function change(node: Element, target: Record<string, unknown>) {
  await act(async () => reactProp<{ onChange: (event: { target: Record<string, unknown> }) => void }>(node).onChange({ target }));
}

function byLabel(host: Element, label: string) {
  const node = host.querySelector(`[aria-label="${label}"]`);
  if (!node) throw new Error(`missing ${label}`);
  return node;
}

function button(host: Element, text: string) {
  const node = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!node) throw new Error(`missing button ${text}`);
  return node;
}

describe("ConnectorsView", () => {
  it("renders every connector state and keeps configuration, consent, removal, and tool actions wired", async () => {
    resetConfig({
      autoApprove: false,
      outboundUnmask: true,
      installedNames: ["remote", "local", "disabled", "failed", "waiting"],
      mcpError: "save failed",
      connectorPowers: {
        remote: { auto_approve: true, outbound_unmask: false },
        local: { auto_approve: false },
      },
      mcpStatuses: [
        server("connector setup", { error: "The config is unreadable", tools: [] }),
        server("remote", { remote: true }),
        server("local", { tools: ["read"] }),
        server("disabled", { status: "disabled", tools: [] }),
        server("failed", { status: "failed", error: "dial failed", remote: true, tools: [] }),
        server("waiting", { status: "connecting", tools: [] }),
      ],
    });
    bridge.mcpGetToolPrefs.mockResolvedValue({ remote: ["write"] });
    const view = await renderConnectors();

    expect(view.host.textContent).toContain("The config is unreadable");
    expect(view.host.textContent).toContain("5 connectors");
    expect(view.host.textContent).toContain("1 of 2 tools on");
    expect(view.host.textContent).toContain("connecting…");
    expect(view.host.textContent).toContain("dial failed");
    expect(view.host.textContent).toContain("turn it off and on again");
    expect(view.host.textContent).toContain("it runs on your Mac");
    expect(view.host.textContent).toContain("save failed");
    expect(view.host.textContent).toContain("Add more");

    await change(byLabel(view.host, "Turn remote off"), { checked: false });
    await change(byLabel(view.host, "Run remote tools without asking"), { value: "off" });
    await change(byLabel(view.host, "Send remote real values"), { value: "follow" });
    await change(byLabel(view.host, "Run local tools without asking"), { value: "on" });
    const toolSwitches = [...view.host.querySelectorAll(".conn-tool input")];
    await change(toolSwitches[0], { checked: false });
    await change(toolSwitches[1], { checked: true });
    await click(byLabel(view.host, "Remove remote"));
    await click(button(view.host, "Keep"));
    await click(byLabel(view.host, "Remove remote"));
    await click(button(view.host, "Remove"));
    await change(byLabel(view.host, "Raw mcpServers config"), { value: "{\"mcpServers\":{\"x\":{}}}" });
    await click(button(view.host, "Save & Connect"));
    const permissionSwitches = [...view.host.querySelectorAll(".conn-powers input")];
    await change(permissionSwitches[0], { checked: true });
    await change(permissionSwitches[1], { checked: false });

    expect(config.current.setServerEnabled).toHaveBeenCalledWith("remote", false);
    expect(config.current.setConnectorPower).toHaveBeenCalledWith("remote", "auto_approve", false);
    expect(config.current.setConnectorPower).toHaveBeenCalledWith("remote", "outbound_unmask", null);
    expect(config.current.setConnectorPower).toHaveBeenCalledWith("local", "auto_approve", true);
    expect(bridge.mcpSetToolEnabled).toHaveBeenCalledWith("remote", "search", false);
    expect(bridge.mcpSetToolEnabled).toHaveBeenCalledWith("remote", "write", true);
    expect(config.current.removeServer).toHaveBeenCalledWith("remote");
    expect(config.current.setMcpConfig).toHaveBeenCalledWith("{\"mcpServers\":{\"x\":{}}}");
    expect(config.current.applyMcp).toHaveBeenCalled();
    expect(config.current.setAutoApprove).toHaveBeenCalledWith(true);
    expect(config.current.setOutboundUnmask).toHaveBeenCalledWith(false);
  });

  it("shows OAuth progress, URL, failures, sign-out state, and a successful retry", async () => {
    const slowAuthorize = new Promise<void>(() => {});
    bridge.mcpOauthAuthorize
      .mockReturnValueOnce(slowAuthorize)
      .mockRejectedValueOnce(new Error("authorise failed"))
      .mockResolvedValueOnce(undefined);
    bridge.mcpOauthSignOut.mockRejectedValueOnce(new Error("sign out failed"));
    resetConfig({ mcpStatuses: [server("remote", { remote: true, tools: [] })] });
    const view = await renderConnectors();

    await click(button(view.host, "Connect account"));
    expect(view.host.textContent).toContain("Waiting for your browser…");
    await act(async () => oauthUrlHandler?.({ server: "remote", url: "https://auth.example.test" }));
    expect(view.host.querySelector("a[href='https://auth.example.test']")).not.toBeNull();
    await click(button(view.host, "Cancel"));

    await click(button(view.host, "Connect account"));
    expect(view.host.textContent).toContain("Error: authorise failed");
    await click(button(view.host, "Connect account"));
    expect(view.host.textContent).toContain("Account connected");
    await click(button(view.host, "Sign out"));
    expect(view.host.textContent).toContain("Error: sign out failed");
    expect(bridge.mcpOauthStatus).toHaveBeenCalledWith("remote");
  });

  it("names read and write tool-preference failures without redrawing an invented setting", async () => {
    bridge.mcpGetToolPrefs.mockRejectedValueOnce(new Error("read failed"));
    bridge.mcpSetToolEnabled.mockRejectedValueOnce(new Error("write failed"));
    resetConfig({ mcpStatuses: [server("local", { tools: ["read"] })] });
    const view = await renderConnectors();
    expect(view.host.textContent).toContain("Couldn't read which connector tools are turned off");
    const input = view.host.querySelector(".conn-tool input");
    if (!input) throw new Error("tool switch missing");
    await change(input, { checked: false });
    expect(view.host.textContent).toContain("Couldn't change local's read");
  });

  it("uses the marketplace heading when no connector is installed and tolerates unavailable OAuth probes", async () => {
    bridge.mcpOauthStatus.mockRejectedValueOnce(new Error("status unavailable"));
    const empty = await renderConnectors();
    expect(empty.host.textContent).toContain("Marketplace");
    expect(empty.host.textContent).not.toContain("Installed");

    resetConfig({ mcpStatuses: [server("remote", { remote: true, tools: [] })] });
    await empty.draw();
    expect(empty.host.textContent).toContain("Connect account (sign in)");
  });

  it("cleans up both settled and late fabricated OAuth subscriptions", async () => {
    const unlisten = vi.fn();
    bridge.onMcpOauthUrl.mockResolvedValueOnce(unlisten);
    resetConfig({
      autoApprove: true,
      mcpStatuses: [server("remote", { remote: true, tools: [] })],
    });
    const settled = await renderConnectors();
    expect(settled.host.textContent).toContain("runs connector tools without asking you");
    await act(async () => settled.root.unmount());
    expect(unlisten).toHaveBeenCalledOnce();

    let resolveStatus: ((value: boolean) => void) | null = null;
    let resolveSubscription: ((value: () => void) => void) | null = null;
    const lateUnlisten = vi.fn();
    bridge.mcpOauthStatus.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveStatus = resolve; }),
    );
    bridge.onMcpOauthUrl.mockImplementationOnce(
      () => new Promise<() => void>((resolve) => { resolveSubscription = resolve; }),
    );
    const late = await renderConnectors();
    await act(async () => late.root.unmount());
    await act(async () => {
      resolveStatus?.(true);
      resolveSubscription?.(lateUnlisten);
      await Promise.resolve();
    });
    expect(lateUnlisten).toHaveBeenCalledOnce();
  });
});
