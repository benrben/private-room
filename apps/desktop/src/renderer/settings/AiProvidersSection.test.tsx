import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiProviderStatus } from "../api";

const bridge = vi.hoisted(() => ({
  listAiProviders: vi.fn<() => Promise<AiProviderStatus[]>>(),
  connectAiProvider: vi.fn<(provider: string, key: string) => Promise<number>>(),
  disconnectAiProvider: vi.fn<(provider: string) => Promise<void>>(),
}));
const dialog = vi.hoisted(() => ({
  confirm: vi.fn<(text: string, options?: unknown) => Promise<boolean>>(),
}));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../platform", () => ({ confirm: dialog.confirm }));
vi.mock("../icons", () => ({ CheckIcon: () => null, CloseIcon: () => null }));

import AiProvidersSection from "./AiProvidersSection";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type ProviderProps = React.ComponentProps<typeof AiProvidersSection>;

function provider(connected: boolean): AiProviderStatus {
  return { id: "openrouter", label: "OpenRouter", connected };
}

function props(overrides: Partial<ProviderProps> = {}): ProviderProps {
  return {
    model: "local::default",
    fallbackModel: "local::fallback",
    onModelChange: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(AiProvidersSection, input));
  });
  await flush();
  return { host, input, close: async () => act(async () => root.unmount()) };
}

function handler<T>(element: Element, name: string): T {
  const key = Object.getOwnPropertyNames(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React ${name} handler missing`);
  return (element as unknown as Record<string, Record<string, T>>)[key]![name]!;
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function change(input: Element, value: string) {
  await act(async () => {
    handler<(event: { target: { value: string } }) => void>(input, "onChange")({
      target: { value },
    });
  });
  await flush();
}

async function invoke(element: Element, name = "onClick", event?: { key: string }) {
  await act(async () => {
    await handler<(input?: { key: string }) => unknown>(element, name)(event);
  });
  await flush();
}

beforeEach(() => {
  bridge.listAiProviders.mockReset().mockResolvedValue([provider(false)]);
  bridge.connectAiProvider.mockReset().mockResolvedValue(1_234);
  bridge.disconnectAiProvider.mockReset().mockResolvedValue(undefined);
  dialog.confirm.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("AiProvidersSection", () => {
  it("loads the provider state and connects only a nonblank key", async () => {
    const view = await render();
    const key = view.host.querySelector<HTMLInputElement>('input[aria-label="OpenRouter API key"]');
    if (!key) throw new Error("provider key input missing");
    const connect = button(view.host, "Connect");
    expect(view.host.textContent).toContain("Not connected");
    expect(connect.disabled).toBe(true);
    await invoke(connect);
    expect(bridge.connectAiProvider).not.toHaveBeenCalled();

    await change(key, " key-with-spaces ");
    await invoke(connect);
    expect(bridge.connectAiProvider).toHaveBeenCalledWith("openrouter", " key-with-spaces ");
    expect(view.input.onChanged).toHaveBeenCalledOnce();
    expect(view.host.textContent).toContain("Connected — 1,234 models available.");
    expect(key.value).toBe("");
    expect(bridge.listAiProviders).toHaveBeenCalledTimes(2);
    await view.close();
  });

  it("keeps a failed connect visible, including one started with Enter", async () => {
    bridge.connectAiProvider.mockRejectedValueOnce(new Error("key rejected"));
    const view = await render();
    const key = view.host.querySelector<HTMLInputElement>('input[aria-label="OpenRouter API key"]');
    if (!key) throw new Error("provider key input missing");
    await change(key, "invalid-key");
    await invoke(key, "onKeyDown", { key: "Enter" });
    expect(bridge.connectAiProvider).toHaveBeenCalledWith("openrouter", "invalid-key");
    expect(view.input.onChanged).not.toHaveBeenCalled();
    expect(view.host.querySelector(".provider-message")?.textContent).toBe("Error: key rejected");
    await view.close();
  });

  it("does not disconnect until confirmed, then restores an OpenRouter model fallback", async () => {
    bridge.listAiProviders.mockResolvedValue([provider(true)]);
    dialog.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = await render(props({ model: "openrouter::anthropic/claude", fallbackModel: "local::safe" }));
    const disconnect = button(view.host, "Disconnect");
    expect(view.host.textContent).toContain("Connected");
    await invoke(disconnect);
    expect(bridge.disconnectAiProvider).not.toHaveBeenCalled();

    await invoke(disconnect);
    expect(bridge.disconnectAiProvider).toHaveBeenCalledWith("openrouter");
    expect(view.input.onModelChange).toHaveBeenCalledWith("local::safe");
    expect(view.input.onChanged).toHaveBeenCalledOnce();
    expect(view.host.textContent).toContain("OpenRouter disconnected. The API key was removed from Keychain.");
    await view.close();
  });

  it("reports provider loading and disconnect failures without changing the selected model", async () => {
    bridge.listAiProviders.mockRejectedValueOnce(new Error("catalog offline"));
    const unavailable = await render();
    expect(unavailable.host.textContent).toContain("Not connected");
    await unavailable.close();

    bridge.listAiProviders.mockResolvedValue([provider(true)]);
    bridge.disconnectAiProvider.mockRejectedValueOnce(new Error("disconnect denied"));
    const view = await render(props({ model: "openrouter::model" }));
    await invoke(button(view.host, "Disconnect"));
    expect(view.input.onModelChange).not.toHaveBeenCalled();
    expect(view.input.onChanged).not.toHaveBeenCalled();
    expect(view.host.querySelector(".provider-message")?.textContent).toBe("Error: disconnect denied");
    await view.close();
  });
});
