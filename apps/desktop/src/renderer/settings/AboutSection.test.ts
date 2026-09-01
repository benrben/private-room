import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  autoUpdateCheckEnabled: vi.fn(),
  checkForUpdate: vi.fn(),
  getVersion: vi.fn(),
  installUpdate: vi.fn(),
  revealLogs: vi.fn(),
  setAutoUpdateCheck: vi.fn(),
}));

vi.mock("../platform", () => ({
  checkForUpdate: bridge.checkForUpdate,
  getVersion: bridge.getVersion,
  installUpdate: bridge.installUpdate,
}));
vi.mock("../api", () => ({ api: { revealLogs: bridge.revealLogs } }));
vi.mock("../updater", () => ({
  autoUpdateCheckEnabled: bridge.autoUpdateCheckEnabled,
  setAutoUpdateCheck: bridge.setAutoUpdateCheck,
}));
vi.mock("../icons", () => ({
  AlertIcon: () => null,
  CircleCheckIcon: () => null,
  DownloadIcon: () => null,
  FolderIcon: () => null,
  Logomark: () => null,
  Wordmark: () => null,
}));

import AboutSection, { aboutSectionTestables } from "./AboutSection";

const { act, createElement } = React;

const globalKeys = [
  "document",
  "window",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.autoUpdateCheckEnabled.mockReturnValue(true);
  bridge.checkForUpdate.mockResolvedValue(null);
  bridge.getVersion.mockResolvedValue("1.2.3");
  bridge.installUpdate.mockResolvedValue(undefined);
  bridge.revealLogs.mockResolvedValue("/tmp/arcelle-logs");
  bridge.setAutoUpdateCheck.mockImplementation((enabled: boolean) => enabled);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSection() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(AboutSection)));
  await flush();
  return { host, root, window };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

async function changeCheckbox(node: HTMLInputElement, checked: boolean) {
  await act(async () => {
    reactProps<{ onChange: (event: { target: { checked: boolean } }) => void }>(
      node,
    ).onChange({ target: { checked } });
  });
  await flush();
}

beforeEach(resetBridge);

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("AboutSection", () => {
  it("formats download and updater failure statuses", () => {
    expect(aboutSectionTestables.downloadMessage(null)).toBe(
      "Downloading the update…",
    );
    expect(aboutSectionTestables.downloadMessage(42)).toBe(
      "Downloading the update… 42%",
    );
    expect(aboutSectionTestables.downloadMessage(100)).toBe(
      "Installing… the app will relaunch.",
    );
    expect(aboutSectionTestables.errText("offline")).toContain(
      "Couldn't reach the release server",
    );
    expect(aboutSectionTestables.errText(new Error("specific failure"))).toBe(
      "specific failure",
    );
    expect(aboutSectionTestables.errText("")).toBe(
      "The update check failed. Please try again.",
    );
  });

  it("loads its version, reflects the persisted update preference, and checks when asked", async () => {
    bridge.setAutoUpdateCheck.mockReturnValue(false);
    const view = await renderSection();
    expect(view.host.textContent).toContain("Current version v1.2.3");
    expect(view.host.textContent).toContain("It checks quietly on launch;");
    const autoCheck = view.host.querySelector<HTMLInputElement>(
      '[aria-label="Check for updates automatically on launch"]',
    );
    if (!autoCheck) throw new Error("update preference toggle missing");
    await changeCheckbox(autoCheck, false);
    expect(bridge.setAutoUpdateCheck).toHaveBeenCalledWith(false);
    expect(view.host.textContent).toContain(
      "OFF — Arcelle never contacts GitHub",
    );
    await click(button(view.host, "Check for updates"), view.window);
    expect(bridge.checkForUpdate).toHaveBeenCalledOnce();
    expect(view.host.textContent).toContain("You're on the latest version.");
    await act(async () => view.root.unmount());
  });

  it("keeps version and manual-check failures visible with a connection-safe message", async () => {
    bridge.getVersion.mockRejectedValue(new Error("version unavailable"));
    bridge.checkForUpdate.mockRejectedValue(new Error("network timeout"));
    const view = await renderSection();
    expect(view.host.textContent).toContain("Current version …");
    await click(button(view.host, "Check for updates"), view.window);
    expect(view.host.textContent).toContain(
      "Couldn't reach the release server — check your connection and try again.",
    );
    await act(async () => view.root.unmount());
  });

  it("shows an available update, its download state, and an install failure", async () => {
    let rejectInstall: ((error: Error) => void) | undefined;
    bridge.checkForUpdate.mockResolvedValue({ version: "2.0.0" });
    bridge.installUpdate.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInstall = reject;
        }),
    );
    const view = await renderSection();
    await click(button(view.host, "Check for updates"), view.window);
    expect(view.host.textContent).toContain("Download & install v2.0.0");
    await click(button(view.host, "Download & install"), view.window);
    expect(view.host.textContent).toContain("Downloading the update…");
    if (!rejectInstall) throw new Error("install promise missing");
    await act(async () => rejectInstall?.(new Error("disk full")));
    await flush();
    expect(view.host.textContent).toContain("disk full");
    await act(async () => view.root.unmount());
  });

  it("reports successful and failed log-folder reveals without claiming a failed path opened", async () => {
    const view = await renderSection();
    const reveal = button(view.host, "Reveal logs");
    await click(reveal, view.window);
    expect(view.host.textContent).toContain("Opened /tmp/arcelle-logs");

    bridge.revealLogs.mockRejectedValueOnce("Finder denied access");
    await click(reveal, view.window);
    expect(view.host.textContent).not.toContain("Opened /tmp/arcelle-logs");
    expect(view.host.textContent).toContain("Finder denied access");

    bridge.revealLogs.mockRejectedValueOnce(new Error("not shown"));
    await click(reveal, view.window);
    expect(view.host.textContent).toContain(
      "The logs folder could not be opened.",
    );
    await act(async () => view.root.unmount());
  });
});
