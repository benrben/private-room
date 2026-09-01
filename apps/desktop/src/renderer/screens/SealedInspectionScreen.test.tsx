import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ formatSize: (bytes: number) => `${bytes} bytes` }));

import { SealedInspectionScreen } from "./SealedInspectionScreen";

const { act, createElement } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
type ScreenProps = React.ComponentProps<typeof SealedInspectionScreen>;

function props(overrides: Partial<ScreenProps> = {}): ScreenProps {
  return {
    path: "/backups/journal.sealed",
    inspection: {
      version: 1,
      purpose: "archive",
      createdAt: "not a date",
      roomId: "room-1",
      fileCount: 2,
      objectCount: 4,
      files: [
        { fileId: "first", relativePath: "notes/one.txt", sizeBytes: 3, sha256: "one" },
        { fileId: "second", relativePath: "notes/two.txt", sizeBytes: 5, sha256: "two" },
      ],
    },
    busy: false,
    error: "",
    onExtract: vi.fn(),
    onImport: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(screenProps: ScreenProps) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(SealedInspectionScreen, screenProps)));
  await flush();
  return { host, root, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("SealedInspectionScreen", () => {
  it("shows inspection metadata, reports errors, and extracts exactly the selected files", async () => {
    const screenProps = props({ error: "The archive is unreadable." });
    const view = await render(screenProps);
    expect(view.host.textContent).toContain("journal.sealed");
    expect(view.host.textContent).toContain("not a date");
    expect(view.host.textContent).toContain("5 bytes");
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("unreadable");
    const inputs = view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(inputs).toHaveLength(2);
    await act(async () => reactProps<{ onChange: () => void }>(inputs[0]!).onChange());
    await flush();
    await click(button(view.host, "Extract selected"), view.window);
    expect(screenProps.onExtract).toHaveBeenCalledWith(["second"]);
    await act(async () => reactProps<{ onChange: () => void }>(inputs[0]!).onChange());
    await flush();
    await click(button(view.host, "Extract selected"), view.window);
    expect(screenProps.onExtract).toHaveBeenLastCalledWith(["second", "first"]);
    await click(button(view.host, "Import as workspace"), view.window);
    await click(button(view.host, "Back"), view.window);
    expect(screenProps.onImport).toHaveBeenCalledOnce();
    expect(screenProps.onBack).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("clears and restores the selection through the toolbar", async () => {
    const screenProps = props();
    const view = await render(screenProps);
    await click(button(view.host, "Clear selection"), view.window);
    expect(button(view.host, "Extract selected").disabled).toBe(true);
    await click(button(view.host, "Select all"), view.window);
    await click(button(view.host, "Extract selected"), view.window);
    expect(screenProps.onExtract).toHaveBeenCalledWith(["first", "second"]);
    await act(async () => view.root.unmount());
  });

  it("makes an empty or busy inspection non-interactive", async () => {
    const empty = await render(props({ inspection: { ...props().inspection, fileCount: 0, files: [] }, busy: true }));
    expect(empty.host.textContent).toContain("This backup contains no normal files.");
    expect(button(empty.host, "Select all").disabled).toBe(true);
    expect(button(empty.host, "Working").disabled).toBe(true);
    expect(empty.host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    await act(async () => empty.root.unmount());
  });
});
