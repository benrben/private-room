import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomInfo } from "../api";
import type { LayoutApi } from "../shell/useLayout";
import type { WSActions } from "./actions";
import type { WSState } from "./state";
import TopBar from "./TopBar";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({
  renameRoom: vi.fn(),
  createRoomCheckpoint: vi.fn(),
  revealItemInDir: vi.fn(),
  toggleTheme: vi.fn(),
  pickerSelect: vi.fn(),
}));

vi.mock("../api", () => ({
  api: bridge,
  ENGINE_LABELS: { "codex-cli": "Codex" },
  splitExternalModel: (model: string) => model.split(":", 3),
}));
vi.mock("../platform", () => ({ revealItemInDir: bridge.revealItemInDir }));
vi.mock("../theme", () => ({ toggleTheme: bridge.toggleTheme }));
vi.mock("../icons", () => ({
  ChevronDownIcon: () => null,
  CloudIcon: () => null,
  DotsIcon: () => null,
  LockIcon: () => null,
  Logomark: () => null,
  PlayIcon: () => null,
  ScriptIcon: () => null,
  SearchIcon: () => null,
  SparkIcon: () => null,
  WorkflowsIcon: () => null,
}));
vi.mock("./RecordingsPage", () => ({ saveDetail: () => "Saving recording" }));
vi.mock("./workflows/workflowGlyph", () => ({ WorkflowGlyph: () => null }));
vi.mock("./markup", () => ({
  isCloudRoute: (model: string) => model.includes("cloud"),
  isExternalEngine: (model: string) => model.startsWith("codex-cli:"),
  isModelReady: (_ai: unknown, model: string) => model === "ready-model",
  trustState: (cloud: boolean, privacyOn: boolean) => ({
    tone: cloud ? "cloud" : "local",
    title: privacyOn ? "privacy is on" : "privacy is off",
    label: cloud ? "Cloud route" : "On this Mac",
  }),
}));
vi.mock("./EngineModelPicker", () => ({
  default: ({ onSelect }: { onSelect: (model: string) => void }) =>
    createElement("button", { onClick: () => onSelect("codex-cli:fast") }, "Pick fast model"),
}));
vi.mock("./LayoutMenu", () => ({
  default: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) =>
    createElement("button", { onClick: () => onOpenChange(true) }, "Layout"),
}));
vi.mock("./QuickActions", () => ({
  QuickActionsMenu: ({
    actions,
    onOpenChange,
    buttonLabel,
    footer,
  }: {
    actions: Array<{ label: string; onRun: () => void }>;
    onOpenChange: (open: boolean) => void;
    buttonLabel: string;
    footer?: { label: string; onClick: () => void };
  }) => createElement(
    "div",
    null,
    createElement("button", { onClick: () => onOpenChange(true) }, buttonLabel),
    ...actions.map((action) => createElement("button", { key: action.label, onClick: action.onRun }, action.label)),
    footer && createElement("button", { onClick: footer.onClick }, footer.label),
  ),
}));

const info: RoomInfo = {
  name: "Private room",
  path: "/rooms/private.roomai",
  fileCount: 0,
  messageCount: 0,
  synced: false,
  pendingMcp: null,
};

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function workspaceState(overrides: Record<string, unknown> = {}) {
  return {
    ai: {
      running: true,
      installed: true,
      models: ["ready-model"],
      defaultModel: "ready-model",
      external: ["codex-cli"],
      remoteRelay: false,
    },
    model: "ready-model",
    openMenu: null,
    setOpenMenu: vi.fn(),
    pushToast: vi.fn(),
    workflows: [
      {
        id: "flow-1",
        name: "Pinned flow",
        emoji: "⚡",
        pinned: true,
        status: "active",
        binding: { scope: "general" },
      },
      { id: "ignored", name: "Ignored", emoji: "", pinned: false, status: "active", binding: { scope: "general" } },
    ],
    scripts: [
      { fileId: "script-1", name: "Global script", shortcut: "global" },
      { fileId: "other", name: "Other", shortcut: "none" },
    ],
    engineModels: {
      "codex-cli": [{ slug: "fast", efforts: ["low"], label: "Fast" }],
    },
    recLive: null,
    recSave: null,
    files: [],
    privacyOn: true,
    setSearchSel: vi.fn(),
    setShowSearch: vi.fn(),
    setShowShortcuts: vi.fn(),
    setShowFeedback: vi.fn(),
    ...overrides,
  } as unknown as WSState;
}

function workspaceActions(overrides: Record<string, unknown> = {}) {
  return {
    viewFile: vi.fn(),
    runWorkflowNow: vi.fn(),
    runScript: vi.fn(),
    openWorkflows: vi.fn(),
    openScripts: vi.fn(),
    refreshAi: vi.fn(),
    engineLabelOf: vi.fn((model: string) => `Engine ${model}`),
    recordEngineModels: vi.fn(),
    changeModel: vi.fn(),
    exportAllFiles: vi.fn(),
    handleLock: vi.fn(),
    ...overrides,
  } as unknown as WSActions;
}

function workspaceLayout(overrides: Record<string, unknown> = {}) {
  return {
    visible: ["center"],
    togglePane: vi.fn(),
    ...overrides,
  } as unknown as LayoutApi;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

type ViewProps = {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  sidebarTitle: string;
  onRenamed: ReturnType<typeof vi.fn>;
  approvals: number;
  running: number;
};

function defaultProps(): ViewProps {
  return {
    s: workspaceState(),
    a: workspaceActions(),
    info,
    layout: workspaceLayout(),
    sidebarTitle: "Library",
    onRenamed: vi.fn(),
    approvals: 0,
    running: 0,
  };
}

async function renderTopBar(overrides: Partial<ViewProps> = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Vitest" } });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  let props = { ...defaultProps(), ...overrides };
  const update = async (next: Partial<ViewProps>) => {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(TopBar, props)));
    await flush();
  };
  await update({});
  return { host, root, window, props, update };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

function button(host: Element, label: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    reactProps<{ onChange: (event: { target: { value: string } }) => void }>(input).onChange({ target: { value } });
  });
  await flush();
}

async function keyDown(node: Element, key: string) {
  await act(async () => {
    reactProps<{ onKeyDown: (event: { key: string }) => void }>(node).onKeyDown({ key });
  });
  await flush();
}

beforeEach(() => {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.renameRoom.mockResolvedValue({ ...info, name: "Renamed room" });
  bridge.createRoomCheckpoint.mockResolvedValue({ name: "Checkpoint" });
  bridge.revealItemInDir.mockResolvedValue(undefined);
});

afterEach(() => {
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

describe("TopBar", () => {
  it("renames rooms, opens search, runs shortcuts, and controls the assistant", async () => {
    const view = await renderTopBar({ approvals: 2 });
    await click(button(view.host, "Private room"), view.window);
    const input = view.host.querySelector<HTMLInputElement>('input[aria-label="Room name"]');
    if (!input) throw new Error("room name input missing");
    await changeInput(input, " Renamed room ");
    await keyDown(input, "Enter");
    expect(bridge.renameRoom).toHaveBeenCalledWith("Renamed room");
    expect(view.props.onRenamed).toHaveBeenCalledWith({ ...info, name: "Renamed room" });
    expect(view.props.s.pushToast).toHaveBeenCalledWith("success", "This room is now called “Renamed room”.");

    await click(button(view.host, "Search room"), view.window);
    expect(view.props.s.setSearchSel).toHaveBeenCalledWith(0);
    expect(view.props.s.setShowSearch).toHaveBeenCalledWith(true);
    await click(button(view.host, "Pinned flow"), view.window);
    await click(button(view.host, "Global script"), view.window);
    expect(view.props.a.runWorkflowNow).toHaveBeenCalledWith("flow-1");
    expect(view.props.a.runScript).toHaveBeenCalledWith("script-1");
    await click(button(view.host, "All workflows"), view.window);
    await click(button(view.host, "All scripts"), view.window);
    expect(view.props.a.openWorkflows).toHaveBeenCalledOnce();
    expect(view.props.a.openScripts).toHaveBeenCalledOnce();

    const assistant = view.host.querySelector<HTMLButtonElement>('[data-testid="assistant-toggle"]');
    if (!assistant) throw new Error("assistant toggle missing");
    expect(assistant.getAttribute("aria-label")).toContain("2 things need your approval");
    expect(view.host.textContent).toContain("2");
    await click(assistant, view.window);
    expect(view.props.layout.togglePane).toHaveBeenCalledWith("ai");
    await click(button(view.host, "Lock"), view.window);
    expect(view.props.a.handleLock).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("handles rename cancellation and failures without pretending the name changed", async () => {
    const view = await renderTopBar();
    await click(button(view.host, "Private room"), view.window);
    const input = view.host.querySelector<HTMLInputElement>('input[aria-label="Room name"]');
    if (!input) throw new Error("room name input missing");
    await keyDown(input, "Escape");
    expect(view.host.querySelector('input[aria-label="Room name"]')).toBeNull();
    await click(button(view.host, "Private room"), view.window);
    const retry = view.host.querySelector<HTMLInputElement>('input[aria-label="Room name"]');
    if (!retry) throw new Error("room name input missing");
    await changeInput(retry, "   ");
    await keyDown(retry, "Enter");
    expect(bridge.renameRoom).not.toHaveBeenCalled();

    await click(button(view.host, "Private room"), view.window);
    const failing = view.host.querySelector<HTMLInputElement>('input[aria-label="Room name"]');
    if (!failing) throw new Error("room name input missing");
    await changeInput(failing, "Failure room");
    bridge.renameRoom.mockRejectedValueOnce(new Error("rename denied"));
    await keyDown(failing, "Enter");
    expect(view.props.s.pushToast).toHaveBeenCalledWith("error", "Could not rename this room: Error: rename denied");
    await act(async () => view.root.unmount());
  });

  it("shows recording, model, route, room-menu and Escape behaviors", async () => {
    const s = workspaceState({
      openMenu: "model",
      model: "codex-cli:fast",
      recLive: { fileId: "recording-1", status: "recording" },
      files: [{ id: "file-1" }],
    });
    const a = workspaceActions();
    const view = await renderTopBar({ s, a, running: 1 });
    expect(view.host.textContent).toContain("Recording");
    expect(view.host.textContent).toContain("On this Mac");
    const escape = new view.window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    view.window.dispatchEvent(escape);
    expect(s.setOpenMenu).toHaveBeenCalledWith(null);
    (s.setOpenMenu as unknown as { mockClear: () => void }).mockClear();
    await click(button(view.host, "Recording"), view.window);
    expect(a.viewFile).toHaveBeenCalledWith("recording-1");
    await click(button(view.host, "Pick fast model"), view.window);
    expect(a.changeModel).toHaveBeenCalledWith("codex-cli:fast");
    expect(s.setOpenMenu).not.toHaveBeenCalledWith(null);

    await view.update({ s: workspaceState({ ...s, openMenu: "room", files: [{ id: "file-1" }] }) });
    await click(button(view.host, "Theme"), view.window);
    expect(bridge.toggleTheme).toHaveBeenCalledOnce();
    await click(button(view.host, "Save a checkpoint"), view.window);
    expect(bridge.createRoomCheckpoint).toHaveBeenCalledWith("");
    await flush();
    expect(view.props.s.pushToast).toHaveBeenCalledWith("success", expect.stringContaining("Checkpoint"));
    await click(button(view.host, "Export all files"), view.window);
    expect(view.props.a.exportAllFiles).toHaveBeenCalledOnce();
    await click(button(view.host, "Reveal in Finder"), view.window);
    expect(bridge.revealItemInDir).toHaveBeenCalledWith(info.path);
    await click(button(view.host, "Keyboard shortcuts"), view.window);
    await click(button(view.host, "Send feedback"), view.window);
    expect(view.props.s.setShowShortcuts).toHaveBeenCalledWith(true);
    expect(view.props.s.setShowFeedback).toHaveBeenCalledWith(true);

    await view.update({ s: workspaceState({ ai: null, recLive: { fileId: "paused-1", status: "paused" } }) });
    expect(view.host.textContent).toContain("Recording paused");
    expect(button(view.host, "Recording paused").getAttribute("title")).toContain("microphone is closed");
    await click(button(view.host, "Check AI"), view.window);
    expect(view.props.a.refreshAi).toHaveBeenCalledOnce();
    await view.update({ s: workspaceState({ recLive: { fileId: "saving-1", status: "saving" } }) });
    expect(view.host.textContent).toContain("Saving…");
    expect(button(view.host, "Saving").getAttribute("title")).toContain("Saving recording");

    await act(async () => view.root.unmount());
  });
});
