import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessCapabilities } from "../api";

const mocks = vi.hoisted(() => ({ harnessCapabilities: vi.fn() }));
vi.mock("../api", () => ({ api: { harnessCapabilities: mocks.harnessCapabilities } }));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function report(overrides: Partial<HarnessCapabilities> = {}): HarnessCapabilities {
  return {
    flags: {},
    roomFormat: "workspace-folder",
    outsideWorkspaceIsolation: true,
    providers: {
      codex: { enabled: true, installed: true, reason: null, harness: "legacy-cli" },
      claude: { enabled: false, installed: true, reason: "sandbox missing", harness: "legacy-cli" },
      other: { enabled: false, installed: false, reason: null, harness: null },
    },
    ...overrides,
  };
}

async function render() {
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
  const [{ createRoot }, { default: HarnessDiagnosticsSection }] = await Promise.all([
    import("react-dom/client"),
    import("./HarnessDiagnosticsSection"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(HarnessDiagnosticsSection));
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, close: async () => act(async () => root.unmount()) };
}

async function reactClick(element: Element) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  await act(async () => {
    (element as unknown as Record<string, Record<string, () => void>>)[key].onClick();
    await Promise.resolve();
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => mocks.harnessCapabilities.mockReset());
afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("HarnessDiagnosticsSection", () => {
  it("shows the capability report and retries through the mocked bridge", async () => {
    mocks.harnessCapabilities.mockResolvedValue(report());
    const view = await render();
    expect(view.host.textContent).toContain("normal folder");
    expect(view.host.textContent).toContain("Codex restricted CLI");
    expect(view.host.textContent).toContain("Claude restricted CLI");
    expect(view.host.textContent).toContain("Ready");
    expect(view.host.textContent).toContain("Blocked");
    expect(view.host.textContent).toContain("Missing");
    const button = view.host.querySelector("button");
    if (!button) throw new Error("retry action missing");
    await reactClick(button);
    await flush();
    expect(mocks.harnessCapabilities).toHaveBeenCalledTimes(2);
    await view.close();
  });

  it("shows a failed capability probe and recovers on retry", async () => {
    mocks.harnessCapabilities
      .mockRejectedValueOnce(new Error("fabricated sandbox probe failure"))
      .mockResolvedValueOnce(report({
        roomFormat: "sealed-db",
        providers: {
          custom: { enabled: false, installed: false, reason: null, harness: "legacy-cli" },
        },
      }));
    const view = await render();
    expect(view.host.querySelector("[role='alert']")?.textContent).toContain("fabricated sandbox probe failure");
    const button = view.host.querySelector("button");
    if (!button) throw new Error("retry action missing");

    await reactClick(button);
    await flush();

    expect(view.host.textContent).toContain("legacy encrypted database");
    expect(view.host.textContent).toContain("custom restricted CLI");
    expect(view.host.querySelector("[role='alert']")).toBeNull();
    await view.close();
  });

  it("labels an absent room without inventing a format", async () => {
    mocks.harnessCapabilities.mockResolvedValue(report({ roomFormat: null }));
    const view = await render();

    expect(view.host.textContent).toContain("no open room");
    await view.close();
  });

});
