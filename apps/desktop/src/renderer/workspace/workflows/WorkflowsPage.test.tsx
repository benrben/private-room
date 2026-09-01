import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WSActions } from "../actions";
import type { WSState } from "../state";

const mocks = vi.hoisted(() => ({
  detailProps: null as null | Record<string, unknown>,
  libraryProps: null as null | Record<string, unknown>,
}));

vi.mock("../../icons", () => ({ CloseIcon: () => null, WorkflowsIcon: () => null }));
vi.mock("./WorkflowDetail", () => ({
  WorkflowDetail: (props: Record<string, unknown>) => {
    mocks.detailProps = props;
    return null;
  },
}));
vi.mock("./WorkflowLibrary", () => ({
  WorkflowLibrary: (props: Record<string, unknown>) => {
    mocks.libraryProps = props;
    return null;
  },
}));

import { WorkflowsPage } from "./WorkflowsPage";

const { act, createElement } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function state(overrides: Record<string, unknown> = {}): WSState {
  return {
    wfDetailId: null,
    workflows: [],
    setShowWorkflows: vi.fn(),
    ...overrides,
  } as unknown as WSState;
}

function actions(): WSActions {
  return {} as WSActions;
}

async function render(s: WSState, a: WSActions) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(WorkflowsPage, { s, a })));
  return { host, root, window };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

beforeEach(() => {
  mocks.detailProps = null;
  mocks.libraryProps = null;
});

describe("WorkflowsPage", () => {
  it("shows the workflows library and closes the full-page view on request", async () => {
    const s = state();
    const a = actions();
    const view = await render(s, a);
    expect(view.host.textContent).toContain("Workflows");
    expect(mocks.libraryProps).toMatchObject({ s, a });
    expect(mocks.detailProps).toBeNull();
    const close = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Close");
    if (!close) throw new Error("workflows close button missing");
    await act(async () => close.dispatchEvent(new view.window.Event("click", { bubbles: true })));
    expect(s.setShowWorkflows).toHaveBeenCalledWith(false);
    await act(async () => view.root.unmount());
  });

  it("routes the selected workflow to its detail view instead of rendering the library", async () => {
    const workflow = { id: "workflow-1", name: "Daily notes" };
    const s = state({ wfDetailId: "workflow-1", workflows: [workflow] });
    const a = actions();
    const view = await render(s, a);
    expect(mocks.detailProps).toMatchObject({ s, a, workflow });
    expect(mocks.libraryProps).toBeNull();
    expect(view.host.querySelector(".wf-page")).toBeNull();
    await act(async () => view.root.unmount());
  });
});
