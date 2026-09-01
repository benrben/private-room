import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportMatrix } from "../apiTypes";

const bridge = vi.hoisted(() => ({
  engineSupportMatrix: vi.fn<() => Promise<SupportMatrix>>(),
}));

vi.mock("../api", () => ({ api: bridge }));

import SupportMatrixSection from "./SupportMatrixSection";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function matrix(overrides: Partial<SupportMatrix> = {}): SupportMatrix {
  return {
    agents: [
      { id: "writer", label: "Writer" },
      { id: "researcher", label: "Researcher" },
    ],
    providers: [
      {
        engine: "local", label: "Local", model: "fake-local", local: true,
        available: true, agents: ["writer", "researcher"],
        streaming: "yes", toolCalling: "no", vision: "unknown", structuredOutput: "yes",
        chat: "yes", imageGeneration: "no", videoGeneration: "no",
        contextWindow: null, tier: "fake", imageReaches: true,
      },
      {
        engine: "cloud", label: "Cloud", model: "fake-cloud", local: false,
        available: false, agents: ["writer"],
        streaming: "unknown", toolCalling: "yes", vision: "no", structuredOutput: "unknown",
        chat: "yes", imageGeneration: "yes", videoGeneration: "no",
        contextWindow: 2_048, tier: "fake", imageReaches: false,
      },
    ],
    agentsKnown: true,
    agentsError: null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(SupportMatrixSection)));
  return { host, root };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

beforeEach(() => {
  bridge.engineSupportMatrix.mockReset().mockResolvedValue(matrix());
});

describe("SupportMatrixSection with a fabricated desktop bridge", () => {
  it("shows checking first, then the provider and agent grids without guessing capabilities", async () => {
    let resolve!: (value: SupportMatrix) => void;
    bridge.engineSupportMatrix.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const view = await render();

    expect(view.host.textContent).toContain("Checking…");
    resolve(matrix());
    await flush();

    expect(bridge.engineSupportMatrix).toHaveBeenCalledOnce();
    expect(view.host.textContent).toContain("Local");
    expect(view.host.textContent).toContain("This Mac");
    expect(view.host.textContent).toContain("Cloud — not set up on this Mac");
    expect(view.host.textContent).toContain("The cloud");
    expect(view.host.textContent).toContain("2 of 2");
    expect(view.host.textContent).toContain("1 of 2");
    expect(view.host.querySelector("tr.cap-unavailable")).not.toBeNull();
    expect(view.host.querySelectorAll("td.cap-yes")).toHaveLength(6);
    expect(view.host.querySelectorAll("td.cap-no")).toHaveLength(3);
    expect(view.host.querySelectorAll("td.cap-unknown")).toHaveLength(3);
    expect(view.host.querySelector('td.cap-yes[title="Yes"]')?.textContent).toContain("✓");
    expect(view.host.querySelector('td.cap-no[title="No"]')?.textContent).toContain("✕");
    expect(view.host.querySelector('td.cap-unknown')?.textContent).toContain("Varies by model");
    expect(view.host.querySelector("details")?.textContent).toContain("Which agents each provider can run");
    expect(view.host.textContent).toContain("Writer");
    expect(view.host.textContent).toContain("Researcher");
    await act(async () => view.root.unmount());
  });

  it("makes an unreached agent sidecar explicit, with and without its error detail", async () => {
    bridge.engineSupportMatrix.mockResolvedValueOnce(matrix({ agentsKnown: false, agentsError: "fake bridge offline" }));
    const detailed = await render();
    await flush();
    expect(detailed.host.querySelector("details")).toBeNull();
    expect(detailed.host.textContent).toContain("not known");
    expect(detailed.host.textContent).toContain("could not be reached: fake bridge offline");
    await act(async () => detailed.root.unmount());

    bridge.engineSupportMatrix.mockResolvedValueOnce(matrix({ agentsKnown: false, agentsError: null }));
    const generic = await render();
    await flush();
    expect(generic.host.textContent).toContain("could not be reached. The capability columns");
    await act(async () => generic.root.unmount());
  });

  it("keeps an IPC failure visible and ignores a fabricated response after unmount", async () => {
    bridge.engineSupportMatrix.mockRejectedValueOnce(new Error("fake IPC failure"));
    const failed = await render();
    await flush();
    expect(failed.host.textContent).toContain("The support matrix could not be built: Error: fake IPC failure");
    await act(async () => failed.root.unmount());

    let resolve!: (value: SupportMatrix) => void;
    bridge.engineSupportMatrix.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const stale = await render();
    await act(async () => stale.root.unmount());
    resolve(matrix());
    await flush();
    expect(stale.host.textContent).toBe("");
  });
});
