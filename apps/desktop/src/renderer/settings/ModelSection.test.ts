import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModelSection from "./ModelSection";

const { act, createElement } = React;

vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));
vi.mock("./ToolBadgeIcon", () => ({ default: () => createElement("i", null, "tool") }));
vi.mock("../workspace/EngineModelPicker", () => ({
  default: ({ onSelect, renderLocalExtra }: { onSelect: (model: string) => void; renderLocalExtra: (name: string) => React.ReactNode }) =>
    createElement("div", { "data-testid": "picker" },
      createElement("button", { onClick: () => onSelect("selected") }, "Select model"),
      renderLocalExtra("selected"), renderLocalExtra("cloud:cloud")),
}));
vi.mock("../workspace/DeleteControl", () => ({
  default: ({ k, askConfirm, cancelConfirm, onConfirm }: { k: string; askConfirm: (name: string) => void; cancelConfirm: () => void; onConfirm: () => void }) =>
    createElement("span", null, createElement("button", { onClick: () => askConfirm(k) }, `Ask delete ${k}`), createElement("button", { onClick: cancelConfirm }, "Cancel delete"), createElement("button", { onClick: onConfirm }, "Confirm delete")),
}));

const globalKeys = ["document", "window", "navigator", "HTMLElement", "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function props(overrides: Record<string, unknown> = {}) {
  const Icon = () => null;
  return {
    ai: { running: false, remoteRelay: false, external: [] }, model: "selected",
    onModelChange: vi.fn(), caps: [{ name: "selected", tools: false, vision: true }, { name: "cloud:cloud", tools: true, vision: false }],
    confirmModel: null, confirmRemoveModel: vi.fn(), cancelRemoveModel: vi.fn(), askRemoveModel: vi.fn(),
    pullName: "", setPullName: vi.fn(), pulling: false, pull: vi.fn(), stopPull: vi.fn(), stoppingPull: false, pullStatus: "", pullPercent: null,
    stt: { installed: false, downloading: false, sizeMb: 574 }, removeStt: vi.fn(), sttPercent: null, downloadStt: vi.fn(), cancelStt: vi.fn(), sttErr: "",
    dictTranslate: false, onDictTranslateChange: vi.fn(), dictMode: "off", onDictModeChange: vi.fn(),
    AlertIcon: Icon, EyeIcon: Icon, TrashIcon: Icon, DownloadIcon: Icon,
    ...overrides,
  } as unknown as React.ComponentProps<typeof ModelSection>;
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

async function renderModel(sectionProps = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window); Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Vitest" } });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement); Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement); Reflect.set(globalThis, "Event", window.Event); Reflect.set(globalThis, "React", React); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client"); const host = document.getElementById("root"); if (!host) throw new Error("test root missing"); const root = createRoot(host);
  await act(async () => root.render(createElement(ModelSection, sectionProps))); await flush(); return { host, root, window, sectionProps };
}

function button(host: Element, label: string) { const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label)); if (!found) throw new Error(`button not found: ${label}`); return found; }
async function click(node: Element, window: Window & typeof globalThis) { await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true }))); await flush(); }
function reactProps<T>(node: Element): T { const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps")); if (!key) throw new Error("React props missing"); return (node as unknown as Record<string, unknown>)[key] as T; }
async function change(node: HTMLInputElement | HTMLSelectElement, value: string, checked?: boolean) { await act(async () => reactProps<{ onChange: (event: { target: { value: string; checked: boolean } }) => void }>(node).onChange({ target: { value, checked: checked ?? false } })); await flush(); }
async function pressEnter(node: HTMLInputElement) { await act(async () => reactProps<{ onKeyDown: (event: { key: string }) => void }>(node).onKeyDown({ key: "Enter" })); await flush(); }

afterEach(() => { for (const [key, value] of Object.entries(originalGlobals)) { if (key === "navigator") { Reflect.deleteProperty(globalThis, key); if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor); continue; } if (value === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, value); } });

describe("ModelSection", () => {
  it("connects model inventory, capability warnings, model download, and voice download controls", async () => {
    const sectionProps = props({ sttErr: "voice failed" }); const view = await renderModel(sectionProps);
    expect(view.host.textContent).toContain("can't control the app"); expect(view.host.textContent).toContain("cloud · leaves this Mac");
    await click(button(view.host, "Select model"), view.window); await click(button(view.host, "Ask delete cloud:cloud"), view.window); await click(button(view.host, "Cancel delete"), view.window); await click(button(view.host, "Confirm delete"), view.window);
    const chooser = view.host.querySelector<HTMLSelectElement>('[data-testid="download-model-choice"]'); const input = view.host.querySelector<HTMLInputElement>('input[placeholder^="Download a model"]'); if (!chooser || !input) throw new Error("model controls missing"); await change(chooser, "qwen3.5:2b"); await change(input, "gemma3:4b"); await pressEnter(input); await click(button(view.host, "Download"), view.window); await click(button(view.host, "Download voice model"), view.window);
    expect(sectionProps.onModelChange).toHaveBeenCalledWith("selected"); expect(sectionProps.askRemoveModel).toHaveBeenCalledWith("cloud:cloud"); expect(sectionProps.confirmRemoveModel).toHaveBeenCalledWith("cloud:cloud"); expect(sectionProps.cancelRemoveModel).toHaveBeenCalled(); expect(sectionProps.setPullName).toHaveBeenCalled(); expect(sectionProps.pull).toHaveBeenCalled(); expect(sectionProps.downloadStt).toHaveBeenCalled(); await act(async () => view.root.unmount());
  });

  it("shows remote, active-download, and voice-download states", async () => {
    const sectionProps = props({ ai: { running: true, remoteRelay: true, external: ["cloud"] }, pulling: true, stoppingPull: false, pullName: "qwen3.5:2b", pullStatus: "Pulling", pullPercent: 42, stt: { installed: false, downloading: true, sizeMb: 574 }, sttPercent: 70 }); const view = await renderModel(sectionProps);
    expect(view.host.textContent).toContain("another machine on your network"); expect(view.host.textContent).toContain("Cloud engines send"); expect(view.host.textContent).toContain("Pulling — 42%"); expect(view.host.textContent).toContain("Downloading voice model — 70%"); const stops = [...view.host.querySelectorAll("button")].filter((node) => node.textContent?.trim() === "Stop"); if (stops.length < 2) throw new Error("voice stop missing"); await click(stops[0], view.window); expect(sectionProps.stopPull).toHaveBeenCalled(); await click(stops[1], view.window); expect(sectionProps.cancelStt).toHaveBeenCalled(); await act(async () => view.root.unmount());
  });

  it("keeps installed voice controls and dictation preferences usable without a catalog", async () => {
    const sectionProps = props({ ai: null, stt: { installed: true, downloading: false, sizeMb: 574 }, dictTranslate: true, dictMode: "notes" }); const view = await renderModel(sectionProps);
    expect(view.host.querySelector('[data-testid="picker"]')).toBeNull(); expect(view.host.textContent).toContain("Voice model installed"); const checkbox = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]'); const mode = [...view.host.querySelectorAll<HTMLSelectElement>("select")].find((node) => node.value === "notes"); if (!checkbox || !mode) throw new Error("dictation controls missing"); await click(view.host.querySelector('[aria-label="Delete the dictation model from disk"]')!, view.window); await change(checkbox, "on", true); await change(mode, "email"); expect(sectionProps.removeStt).toHaveBeenCalled(); expect(sectionProps.onDictTranslateChange).toHaveBeenCalled(); expect(sectionProps.onDictModeChange).toHaveBeenCalled(); await act(async () => view.root.unmount());
  });
});
