import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomStorageUsage } from "../api";
import type { PrivacyScanProgress, PrivacyStatus } from "../apiTypes";
import CloudPrivacySection from "./CloudPrivacySection";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({
  privacyStatus: vi.fn(),
  roomStorageUsage: vi.fn(),
  onPrivacyScan: vi.fn(),
  setPrivacyRoom: vi.fn(),
  setPrivacyGlobal: vi.fn(),
  addPrivacyBlock: vi.fn(),
  removePrivacyEntity: vi.fn(),
  setPrivacyConcepts: vi.fn(),
  startPrivacyScan: vi.fn(),
}));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));

const status: PrivacyStatus = {
  globalDefaultOn: true,
  roomSetting: "off",
  effectiveOn: false,
  entities: [
    {
      id: "person-1",
      realText: "Ada Lovelace",
      placeholder: "[Person A]",
      category: "person",
      source: "user",
    },
    {
      id: "scan-1",
      realText: "Arcelle Labs",
      placeholder: "[Organization A]",
      category: "org",
      source: "scan",
    },
  ],
  concepts: ["health", "family"],
  pendingFiles: 2,
  scanning: false,
  lastScanError: null,
  connectorArgsMasked: false,
};

const workspaceUsage: RoomStorageUsage = {
  kind: "workspace",
  liveFileBytes: 0,
  databaseBytes: 0,
  privateHistoryBytes: 0,
  totalOnDiskBytes: 0,
};

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

let scanHandler: ((progress: PrivacyScanProgress) => void) | undefined;
let unsubscribe: ReturnType<typeof vi.fn>;

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.privacyStatus.mockResolvedValue(status);
  bridge.roomStorageUsage.mockResolvedValue(workspaceUsage);
  bridge.onPrivacyScan.mockImplementation(async (callback) => {
    scanHandler = callback;
    return unsubscribe;
  });
  bridge.setPrivacyRoom.mockResolvedValue(undefined);
  bridge.setPrivacyGlobal.mockResolvedValue(undefined);
  bridge.addPrivacyBlock.mockResolvedValue(undefined);
  bridge.removePrivacyEntity.mockResolvedValue(undefined);
  bridge.setPrivacyConcepts.mockResolvedValue(undefined);
  bridge.startPrivacyScan.mockResolvedValue(undefined);
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
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest" },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLSelectElement", window.HTMLSelectElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(CloudPrivacySection));
  });
  await flush();
  return { host, root, window };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

function button(host: Element, label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

async function change(node: Element, value: string | boolean) {
  await act(async () => {
    reactProps<{ onChange: (event: { target: Record<string, string | boolean> }) => void }>(node)
      .onChange({ target: { value, checked: value } });
  });
  await flush();
}

async function keyDown(node: Element, key: string, stopPropagation = vi.fn()) {
  await act(async () => {
    reactProps<{ onKeyDown: (event: { key: string; stopPropagation: () => void }) => void }>(node)
      .onKeyDown({ key, stopPropagation });
  });
  return stopPropagation;
}

async function blur(node: Element) {
  await act(async () => {
    reactProps<{ onBlur: () => void }>(node).onBlur();
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  unsubscribe = vi.fn();
  scanHandler = undefined;
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

describe("CloudPrivacySection", () => {
  it("shows the full policy and performs each successful control action", async () => {
    const view = await renderSection();
    expect(view.host.textContent).toContain("workspace folder are normal files");
    expect(view.host.textContent).toContain("The door is open");
    expect(view.host.textContent).toContain("One seam sends real values");
    expect(view.host.textContent).toContain("currently on");
    expect(view.host.textContent).toContain("Ada Lovelace");
    expect(view.host.textContent).toContain("found by scan");

    const toggles = view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await change(toggles[0]!, true);
    expect(bridge.setPrivacyRoom).toHaveBeenCalledWith("on");
    await click(button(view.host, "Follow the app default"), view.window);
    expect(bridge.setPrivacyRoom).toHaveBeenCalledWith("default");
    await change(toggles[1]!, false);
    expect(bridge.setPrivacyGlobal).toHaveBeenCalledWith(false);

    const item = view.host.querySelector<HTMLInputElement>('input[placeholder^="e.g."]');
    const category = view.host.querySelector<HTMLSelectElement>("select.cpv-cat");
    if (!item || !category) throw new Error("block-list controls missing");
    await change(item, " Ada ");
    await change(category, "address");
    await keyDown(item, "Space");
    await keyDown(item, "Enter");
    expect(bridge.addPrivacyBlock).toHaveBeenCalledWith("Ada", "address");
    await click(button(view.host, "Add"), view.window);
    expect(bridge.addPrivacyBlock).toHaveBeenCalledOnce();
    await click(view.host.querySelector<HTMLButtonElement>('button[title="Remove from the block list"]')!, view.window);
    await click(view.host.querySelector<HTMLButtonElement>('button[title="Not private — stop hiding this"]')!, view.window);
    expect(bridge.removePrivacyEntity).toHaveBeenNthCalledWith(1, "person-1");
    expect(bridge.removePrivacyEntity).toHaveBeenNthCalledWith(2, "scan-1");

    const topics = view.host.querySelector<HTMLTextAreaElement>("textarea.cpv-concepts");
    if (!topics) throw new Error("concepts box missing");
    await change(topics, " health \n\nfamily ");
    const stopped = await keyDown(topics, "Escape");
    expect(stopped).toHaveBeenCalledOnce();
    await blur(topics);
    expect(bridge.setPrivacyConcepts).toHaveBeenCalledWith(["health", "family"]);
    expect(view.host.textContent).toContain("Saved");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(view.host.textContent).not.toContain("Saved");

    await click(button(view.host, "Scan now"), view.window);
    expect(view.host.textContent).toContain("Starting the scan");
    if (!scanHandler) throw new Error("privacy scan listener missing");
    await act(async () => {
      scanHandler?.({ running: true, done: 3, total: 3, label: "report.pdf" });
    });
    expect(view.host.textContent).toContain("Scanning 3 of 3 — report.pdf");
    await act(async () => {
      scanHandler?.({ running: false, done: 3, total: 3, error: "scanner stopped" });
    });
    await flush();
    expect(view.host.textContent).toContain("2 files awaiting scan.");
    expect(view.host.textContent).toContain("scanner stopped");
    await act(async () => view.root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps every failed write visible and does not lose unsaved topics", async () => {
    bridge.roomStorageUsage.mockRejectedValue(new Error("usage unavailable"));
    const view = await renderSection();
    const toggles = view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    bridge.setPrivacyRoom.mockRejectedValueOnce(new Error("room denied"));
    await change(toggles[0]!, true);
    expect(view.host.textContent).toContain("room denied");
    bridge.setPrivacyRoom.mockRejectedValueOnce(new Error("default denied"));
    await click(button(view.host, "Follow the app default"), view.window);
    expect(view.host.textContent).toContain("default denied");
    bridge.setPrivacyGlobal.mockRejectedValueOnce(new Error("global denied"));
    await change(toggles[1]!, false);
    expect(view.host.textContent).toContain("global denied");

    const item = view.host.querySelector<HTMLInputElement>('input[placeholder^="e.g."]');
    if (!item) throw new Error("block-list input missing");
    await change(item, "Grace");
    bridge.addPrivacyBlock.mockRejectedValueOnce(new Error("add denied"));
    await click(button(view.host, "Add"), view.window);
    expect(view.host.textContent).toContain("add denied");
    bridge.removePrivacyEntity.mockRejectedValueOnce(new Error("remove denied"));
    await click(view.host.querySelector<HTMLButtonElement>('button[title="Remove from the block list"]')!, view.window);
    expect(view.host.textContent).toContain("remove denied");

    const topics = view.host.querySelector<HTMLTextAreaElement>("textarea.cpv-concepts");
    if (!topics) throw new Error("concepts box missing");
    await change(topics, "new private topic");
    bridge.setPrivacyConcepts.mockRejectedValueOnce(new Error("topics denied"));
    await blur(topics);
    expect(view.host.textContent).toContain("These topics were not saved: Error: topics denied");
    expect(topics.value).toBe("new private topic");

    bridge.startPrivacyScan.mockRejectedValueOnce(new Error("scan denied"));
    await click(button(view.host, "Scan now"), view.window);
    expect(view.host.textContent).toContain("scan denied");
    expect(view.host.textContent).toContain("2 files awaiting scan.");
    await act(async () => view.root.unmount());
  });

  it("uses defaults while the status is unavailable and honors the masked connector warning", async () => {
    bridge.privacyStatus.mockRejectedValueOnce(new Error("status unavailable"));
    bridge.roomStorageUsage.mockResolvedValue({ ...workspaceUsage, kind: "legacy" });
    const view = await renderSection();
    expect(view.host.textContent).toContain("All files scanned.");
    expect(view.host.textContent).toContain("this room follows it");
    const toggles = view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await change(toggles[0]!, false);
    await change(toggles[1]!, false);
    expect(bridge.setPrivacyRoom).not.toHaveBeenCalled();
    expect(bridge.setPrivacyGlobal).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());

    bridge.privacyStatus.mockResolvedValue({
      ...status,
      roomSetting: null,
      effectiveOn: false,
      entities: [],
      pendingFiles: 0,
      connectorArgsMasked: true,
      scanning: true,
    });
    const masked = await renderSection();
    expect(masked.host.textContent).toContain("One exception, and this switch does not control it");
    expect(masked.host.querySelector<HTMLButtonElement>('button.subtle')?.disabled).toBe(true);
    await act(async () => masked.root.unmount());
  });

  it("does not mark an older concept save as current after more typing", async () => {
    let resolveSave: (() => void) | undefined;
    bridge.setPrivacyConcepts.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    const view = await renderSection();
    const topics = view.host.querySelector<HTMLTextAreaElement>("textarea.cpv-concepts");
    if (!topics) throw new Error("concepts box missing");
    await change(topics, "old topic");
    await act(async () => {
      reactProps<{ onBlur: () => void }>(topics).onBlur();
    });
    await change(topics, "new topic");
    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
    });
    await flush();
    expect(bridge.setPrivacyConcepts).toHaveBeenCalledWith(["old topic"]);
    expect(topics.value).toBe("new topic");
    expect(view.host.textContent).not.toContain("Saved");
    await act(async () => view.root.unmount());
  });
});
