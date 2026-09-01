import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceOperationProgressEvent } from "../api";
import { WorkspaceOperationProgress } from "./WorkspaceOperationProgress";

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
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function operation(
  overrides: Partial<WorkspaceOperationProgressEvent> = {}
): WorkspaceOperationProgressEvent {
  return {
    operationId: "operation-1",
    operation: "workspace-checkpoint",
    phase: "copying-files",
    status: "running",
    completed: 1,
    total: 10,
    unit: "files",
    ...overrides,
  };
}

async function render(operations: readonly WorkspaceOperationProgressEvent[]) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(WorkspaceOperationProgress, { operations })));
  return { host, root };
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("WorkspaceOperationProgress", () => {
  it("renders nothing while no workspace operation is active", async () => {
    const view = await render([]);
    expect(view.host.querySelector("section")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("renders overlapping operation states with determinate, indeterminate, and terminal progress", async () => {
    const view = await render([
      operation({
        operationId: "upper-bound",
        operation: "sealed-package-create",
        completed: 15,
        total: 10,
      }),
      operation({ operationId: "lower-bound", completed: -4, total: 2 }),
      operation({ operationId: "unknown-total", phase: "scanning", total: null }),
      operation({ operationId: "zero-total", phase: "planning", total: 0 }),
      operation({ operationId: "completed", status: "completed", phase: "completed" }),
      operation({ operationId: "failed", status: "failed", phase: "failed" }),
    ]);

    const section = view.host.querySelector("section");
    expect(section?.getAttribute("aria-label")).toBe("Workspace operation progress");
    expect(section?.getAttribute("aria-live")).toBe("polite");
    expect(section?.getAttribute("aria-relevant")).toBe("additions text");

    const rows = view.host.querySelectorAll('[role="status"]');
    expect(rows).toHaveLength(6);
    expect(rows[0]?.className).toContain("running");
    expect(rows[4]?.className).toContain("completed");
    expect(rows[5]?.className).toContain("failed");
    expect(rows[0]?.textContent).toContain("Creating sealed backup");
    expect(rows[0]?.textContent).toContain("Copying files — 10 of 10 files");
    expect(rows[4]?.textContent).toContain("Complete");
    expect(rows[5]?.textContent).toContain("Failed");

    const progress = view.host.querySelectorAll("progress");
    expect(progress).toHaveLength(4);
    expect(progress[0]?.getAttribute("max")).toBe("10");
    expect(progress[0]?.getAttribute("value")).toBe("10");
    expect(progress[1]?.getAttribute("max")).toBe("2");
    expect(progress[1]?.getAttribute("value")).toBe("0");
    expect(progress[2]?.getAttribute("max")).toBeNull();
    expect(progress[2]?.getAttribute("value")).toBeNull();
    expect(progress[3]?.getAttribute("max")).toBeNull();
    expect(progress[3]?.getAttribute("value")).toBeNull();
    expect(progress[2]?.getAttribute("aria-label")).toBe("Saving checkpoint: Scanning files…");
    expect(progress[3]?.getAttribute("aria-label")).toBe("Saving checkpoint: Planning…");
    expect(rows[4]?.querySelector("progress")).toBeNull();
    expect(rows[5]?.querySelector("progress")).toBeNull();
    await act(async () => view.root.unmount());
  });
});
