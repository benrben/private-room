import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiStatus } from "../api";
import AdvisorsSection from "./AdvisorsSection";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function ai(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    defaultModel: "local",
    external: [],
    installed: true,
    models: ["local"],
    remoteRelay: false,
    running: true,
    ...overrides,
  };
}

function props(overrides: Partial<React.ComponentProps<typeof AdvisorsSection>> = {}) {
  return {
    ai: ai(),
    advisorsOn: false,
    onAdvisorsToggle: vi.fn(),
    advisorToolsOn: false,
    onAdvisorToolsToggle: vi.fn(),
    ENGINE_LABELS: { "claude-cli": "Claude Code", "codex-cli": "Codex" },
    AlertIcon: () => null,
    ...overrides,
  };
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(AdvisorsSection, input));
    await Promise.resolve();
  });
  return { host, input, root };
}

function onChange(input: Element) {
  const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React change handler missing");
  return (input as unknown as Record<string, { onChange: (event: { target: { checked: boolean } }) => void }>)[key].onChange;
}

async function close(view: Awaited<ReturnType<typeof render>>) {
  await act(async () => {
    view.root.unmount();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("AdvisorsSection", () => {
  it("does not offer advisors while the AI status is unavailable", async () => {
    const view = await render(props({ ai: null }));

    expect(view.host.textContent).toContain("No cloud AI CLIs");
    expect(view.host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    await close(view);
  });

  it("does not offer advisors when only a cloud key is configured", async () => {
    const view = await render(props({ ai: ai({ external: ["openrouter"] }) }));

    expect(view.host.textContent).toContain("No cloud AI CLIs");
    expect(view.host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    await close(view);
  });

  it("lists installed CLI advisors with their engine labels and forwards the master choice", async () => {
    const view = await render(props({ ai: ai({ external: ["openrouter", "claude-cli", "codex-cli"] }) }));
    const toggle = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!toggle) throw new Error("advisor toggle missing");

    expect(view.host.textContent).toContain("Enable AI advisors (Claude Code, Codex)");
    onChange(toggle)({ target: { checked: true } });
    expect(view.input.onAdvisorsToggle).toHaveBeenCalledWith(expect.objectContaining({ target: { checked: true } }));
    expect(view.host.textContent).not.toContain("use this room's tools");
    await close(view);
  });

  it("offers and forwards the tools choice only while advisors are enabled", async () => {
    const view = await render(props({
      advisorsOn: true,
      ai: ai({ external: ["claude-cli", "unknown-cli"] }),
    }));
    const toggles = view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    if (toggles.length !== 2) throw new Error("advisor controls missing");

    expect(view.host.textContent).toContain("Enable AI advisors (Claude Code, unknown-cli)");
    expect(view.host.textContent).toContain("Let a Claude advisor use this room's tools");
    onChange(toggles[1]!)({ target: { checked: true } });
    expect(view.input.onAdvisorToolsToggle).toHaveBeenCalledWith(expect.objectContaining({ target: { checked: true } }));
    await close(view);
  });
});
