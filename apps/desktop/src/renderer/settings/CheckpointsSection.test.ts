import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointMeta, RoomStorageUsage, WorkspaceWatcherStatus } from "../api";
import CheckpointsSection from "./CheckpointsSection";

const mocks = vi.hoisted(() => ({
  formatSize: vi.fn((bytes: number) => `${bytes} B`),
  formatWhen: vi.fn((when: string) => `when ${when}`),
}));

vi.mock("../api", () => ({ formatSize: mocks.formatSize }));
vi.mock("../workspace/composer", () => ({ formatWhen: mocks.formatWhen }));

const { act, createElement } = React;
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
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Props = React.ComponentProps<typeof CheckpointsSection>;
type View = Awaited<ReturnType<typeof renderSection>>;

function checkpoint(overrides: Partial<CheckpointMeta> = {}): CheckpointMeta {
  return {
    id: "checkpoint-1",
    name: "Before cleanup",
    createdAt: "2026-08-31 12:00:00",
    sizeBytes: 40,
    auto: false,
    ...overrides,
  };
}

function storageUsage(overrides: Partial<RoomStorageUsage> = {}): RoomStorageUsage {
  return {
    kind: "workspace",
    liveFileBytes: 10,
    databaseBytes: 20,
    privateHistoryBytes: 30,
    totalOnDiskBytes: 60,
    ...overrides,
  };
}

function watcherStatus(overrides: Partial<WorkspaceWatcherStatus> = {}): WorkspaceWatcherStatus {
  return {
    state: "healthy",
    lastReconciledAt: null,
    lastError: null,
    polling: false,
    ...overrides,
  };
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    checkpoints: [],
    totalBytes: 0,
    storageUsage: null,
    watcherStatus: null,
    rescanning: false,
    rescanRoom: vi.fn(),
    changingPolling: false,
    setWatcherPolling: vi.fn(),
    ckName: "",
    setCkName: vi.fn(),
    creating: false,
    ckError: "",
    ckNotice: "",
    confirmRollback: null,
    setConfirmRollback: vi.fn(),
    rollingBack: false,
    createCheckpoint: vi.fn(),
    deleteCheckpoint: vi.fn(),
    rollback: vi.fn(),
    busy: false,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSection(overrides: Partial<Props> = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
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
  let current = props(overrides);
  const update = async (next: Partial<Props>) => {
    current = { ...current, ...next };
    await act(async () => {
      root.render(createElement(CheckpointsSection, current));
      await Promise.resolve();
    });
    await flush();
  };
  await update({});
  return { close: async () => act(async () => root.unmount()), host, props: () => current, update, window };
}

function reactProps<T>(node: Element): T {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(view: View, element: Element) {
  await act(async () => {
    element.dispatchEvent(new view.window.Event("click", { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
}

async function change(element: Element, value: string | boolean) {
  await act(async () => {
    reactProps<{ onChange: (event: { target: { value: string; checked: boolean } }) => void }>(element)
      .onChange({ target: { value: String(value), checked: Boolean(value) } });
    await Promise.resolve();
  });
  await flush();
}

async function keyDown(element: Element, key: string) {
  await act(async () => {
    reactProps<{ onKeyDown: (event: { key: string }) => void }>(element).onKeyDown({ key });
    await Promise.resolve();
  });
  await flush();
}

function button(view: View, text: string): HTMLButtonElement {
  const element = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === text,
  );
  if (!element) throw new Error(`button not found: ${text}`);
  return element as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formatSize.mockImplementation((bytes) => `${bytes} B`);
  mocks.formatWhen.mockImplementation((when) => `when ${when}`);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("CheckpointsSection", () => {
  it("renders storage and watcher status while preserving rescan and polling controls", async () => {
    const rescanRoom = vi.fn();
    const setWatcherPolling = vi.fn();
    const view = await renderSection({
      storageUsage: storageUsage(),
      watcherStatus: watcherStatus({ state: "error", lastError: "watcher stopped" }),
      rescanRoom,
      setWatcherPolling,
    });
    expect(view.host.textContent).toContain("Current files · 10 B");
    expect(view.host.textContent).toContain("Encrypted Arcelle database · 20 B");
    expect(view.host.textContent).toContain("Private encrypted history · 30 B");
    expect(view.host.textContent).toContain("Total managed disk use is 60 B");
    expect(view.host.querySelector(".gate-error")?.textContent).toContain("File watcher: error — watcher stopped");
    const polling = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!polling) throw new Error("polling checkbox missing");
    await change(polling, true);
    expect(setWatcherPolling).toHaveBeenCalledWith(true);
    await click(view, button(view, "Rescan room"));
    expect(rescanRoom).toHaveBeenCalledOnce();
    await view.update({ rescanning: true, changingPolling: true });
    expect(button(view, "Rescanning…").disabled).toBe(true);
    expect(polling.disabled).toBe(true);
    await view.update({
      changingPolling: false,
      rescanning: false,
      storageUsage: storageUsage({ kind: "legacy" }),
      watcherStatus: null,
    });
    expect(view.host.textContent).toContain("This legacy room uses 60 B in one encrypted database file");
    expect(view.host.textContent).not.toContain("File watcher:");
    await view.update({ watcherStatus: watcherStatus({ polling: true }) });
    expect([...view.host.querySelectorAll(".settings-hint")].find((item) => item.textContent?.includes("File watcher"))?.textContent).toContain("File watcher: healthy");
    expect(view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    await view.close();
  });

  it("keeps checkpoint creation, feedback, empty state, and disabled states observable", async () => {
    const createCheckpoint = vi.fn();
    const setCkName = vi.fn();
    const view = await renderSection({
      ckError: "checkpoint failed",
      ckName: "Before upgrade",
      ckNotice: "Saved checkpoint “Before upgrade”.",
      createCheckpoint,
      setCkName,
    });
    const input = view.host.querySelector<HTMLInputElement>('input[type="text"]');
    if (!input) throw new Error("checkpoint input missing");
    await change(input, "Changed name");
    await keyDown(input, "x");
    await keyDown(input, "Enter");
    await click(view, button(view, "Create checkpoint"));
    expect(setCkName).toHaveBeenCalledWith("Changed name");
    expect(createCheckpoint).toHaveBeenCalledTimes(2);
    expect(view.host.querySelector(".ckpt-notice")?.textContent).toContain("Saved checkpoint");
    expect(view.host.querySelector(".gate-error")?.textContent).toContain("checkpoint failed");
    expect([...view.host.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["Room storage", "Checkpoints"]);
    expect(view.host.textContent).not.toContain("checkpoint ·");
    await view.update({ creating: true });
    expect(input.disabled).toBe(true);
    expect(button(view, "Saving…").disabled).toBe(true);
    await view.update({ creating: false, rollingBack: true });
    expect(button(view, "Create checkpoint").disabled).toBe(true);
    expect(view.host.textContent).toContain("Rolling back — reopening the room…");
    await view.close();
  });

  it("orders checkpoint rows and confirmation actions while respecting busy and rollback disables", async () => {
    const events: string[] = [];
    const deleteCheckpoint = vi.fn((id: string) => events.push(`delete:${id}`));
    const rollback = vi.fn((id: string) => events.push(`rollback:${id}`));
    const setConfirmRollback = vi.fn((id: string | null) => events.push(`confirm:${id}`));
    const first = checkpoint({ auto: true, id: "auto", name: "Before rollback" });
    const second = checkpoint({ id: "manual", name: "Named checkpoint", sizeBytes: 80 });
    const view = await renderSection({
      checkpoints: [first, second],
      totalBytes: 1024 * 1024 * 1024 + 1,
      deleteCheckpoint,
      rollback,
      setConfirmRollback,
    });
    expect(view.host.textContent).toContain("2 checkpoints · 1073741825 B on disk");
    expect(view.host.querySelector(".ckpt-warn")?.textContent).toContain("using a lot of disk");
    expect(view.host.querySelector(".ckpt-dot.auto")?.getAttribute("title")).toBe("Automatic pre-rollback copy");
    expect(view.host.querySelector(".ckpt-dot:not(.auto)")?.getAttribute("title")).toBe("Checkpoint");
    expect(mocks.formatWhen).toHaveBeenCalledWith("2026-08-31T12:00:00Z");
    const deleteButtons = [...view.host.querySelectorAll("button")].filter((item) => item.textContent?.trim() === "Delete");
    await click(view, deleteButtons[0]!);
    expect(view.host.textContent).toContain("Delete “Before rollback” (40 B)?");
    await click(view, button(view, "Cancel"));
    await click(view, [...view.host.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Delete")!);
    await click(view, button(view, "Delete"));
    expect(events).toEqual(["delete:auto"]);

    const rollBack = [...view.host.querySelectorAll("button")].find((item) =>
      item.textContent?.trim() === "Roll back",
    );
    if (!rollBack) throw new Error("rollback button missing");
    await click(view, rollBack);
    expect(events).toEqual(["delete:auto", "confirm:auto"]);
    await view.update({ confirmRollback: "auto" });
    expect(view.host.textContent).toContain("Roll the whole room back to “Before rollback”?");
    await click(view, button(view, "Roll back"));
    expect(events).toEqual(["delete:auto", "confirm:auto", "rollback:auto"]);
    await view.update({ confirmRollback: "auto" });
    await click(view, button(view, "Cancel"));
    expect(events.at(-1)).toBe("confirm:null");

    await view.update({ busy: true, confirmRollback: null, rollingBack: true });
    const actions = [...view.host.querySelectorAll("button")].filter((item) =>
      item.textContent?.trim() === "Roll back" || item.textContent?.trim() === "Delete",
    );
    expect(actions.every((item) => item.disabled)).toBe(true);
    expect(actions.find((item) => item.textContent?.trim() === "Roll back")?.title).toBe("Finish or stop running work first");
    await view.close();

    const singular = await renderSection({
      checkpoints: [checkpoint({ createdAt: "2026-08-31T12:00:00Z" })],
      totalBytes: 40,
    });
    expect(singular.host.textContent).toContain("1 checkpoint · 40 B on disk");
    expect(singular.host.querySelector(".ckpt-warn")).toBeNull();
    expect(mocks.formatWhen).toHaveBeenCalledWith("2026-08-31T12:00:00Z");
    await singular.close();
  });
});
