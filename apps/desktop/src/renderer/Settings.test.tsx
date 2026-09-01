import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "./Settings";
import type { Props } from "./settings/types";

const { act, createElement } = React;

const state = vi.hoisted(() => ({
  bestModel: "mock-local" as string | null,
  closetDirty: false,
  modelError: "",
  tuningDirty: false,
  voiceDirty: false,
  webDirty: false,
}));

const cross = vi.hoisted(() => ({
  changePassword: vi.fn(),
  createRecoveryKey: vi.fn(),
  setPwRecoveryCode: vi.fn(),
  setRecoveryCode: vi.fn(),
}));

const focusTrap = vi.hoisted(() => ({
  keyDown: vi.fn(),
  refocusModal: vi.fn(),
  modalRef: { current: null as HTMLDivElement | null },
}));

vi.mock("./api", () => ({ ENGINE_LABELS: {} }));
vi.mock("./icons", () => ({
  AlertIcon: () => null,
  CloseIcon: () => null,
  DownloadIcon: () => null,
  EyeIcon: () => null,
  TrashIcon: () => null,
}));
vi.mock("./workspace/constants", () => ({ RECOMMENDED_MODELS: [{ name: "recommended" }] }));
vi.mock("./workspace/localModel", () => ({ bestLocalModel: vi.fn(() => state.bestModel) }));
vi.mock("./settings/useFocusTrap", () => ({
  useFocusTrap: () => focusTrap,
}));
vi.mock("./settings/useModelManagement", () => ({
  useModelManagement: () => ({ error: state.modelError, setError: vi.fn() }),
}));
vi.mock("./settings/useBehaviorSettings", () => ({
  useBehaviorSettings: () => ({ tuningDirty: state.tuningDirty }),
}));
vi.mock("./settings/useVoiceSettings", () => ({
  useVoiceSettings: () => ({ voiceDirty: state.voiceDirty }),
}));
vi.mock("./settings/usePrivacy", () => ({ usePrivacy: () => ({
  changePassword: cross.changePassword,
  setPwRecoveryCode: cross.setPwRecoveryCode,
}) }));
vi.mock("./settings/useCheckpoints", () => ({ useCheckpoints: () => ({}) }));
vi.mock("./settings/useOnlineSearch", () => ({ useOnlineSearch: () => ({ webDirty: state.webDirty }) }));
vi.mock("./settings/useAdvisors", () => ({ useAdvisors: () => ({}) }));
vi.mock("./settings/useRemoteAi", () => ({ useRemoteAi: () => ({ closetDirty: state.closetDirty }) }));
vi.mock("./settings/useRoomServer", () => ({ useRoomServer: () => ({}) }));
vi.mock("./settings/useRoles", () => ({ useRoles: () => ({}) }));
vi.mock("./settings/useRecovery", () => ({ useRecovery: () => ({
  createRecoveryKey: cross.createRecoveryKey,
  setRecoveryCode: cross.setRecoveryCode,
}) }));

vi.mock("./settings/ModelSection", () => ({ default: () => null }));
vi.mock("./settings/BehaviorSection", () => ({ default: () => null }));
vi.mock("./settings/VoiceSection", () => ({ default: () => null }));
vi.mock("./settings/MicSection", () => ({ default: () => null }));
vi.mock("./settings/SavedVoicesSection", () => ({ default: () => null }));
vi.mock("./settings/CloudPrivacySection", () => ({
  default: () => <section id="set-cloud-privacy" />,
}));
vi.mock("./settings/PrivacySection", () => ({
  default: ({ changePassword }: { changePassword: () => void }) => (
    <button data-testid="change-password" onClick={changePassword}>Change password</button>
  ),
}));
vi.mock("./settings/CheckpointsSection", () => ({ default: () => null }));
vi.mock("./settings/OnlineSection", () => ({ default: () => null }));
vi.mock("./settings/AdvisorsSection", () => ({ default: () => null }));
vi.mock("./settings/RemoteAiSection", () => ({ default: () => null }));
vi.mock("./settings/RoomServerSection", () => ({ default: () => null }));
vi.mock("./settings/RoleSection", () => ({ default: () => null }));
vi.mock("./settings/HelpersSection", () => ({ default: () => null }));
vi.mock("./settings/SupportMatrixSection", () => ({ default: () => null }));
vi.mock("./settings/HarnessDiagnosticsSection", () => ({ default: () => null }));
vi.mock("./settings/RecoverySection", () => ({
  default: ({ createRecoveryKey }: { createRecoveryKey: () => void }) => (
    <button data-testid="create-recovery" onClick={createRecoveryKey}>Create recovery</button>
  ),
}));
vi.mock("./settings/AboutSection", () => ({ default: () => null }));
vi.mock("./settings/AppearanceSection", () => ({ default: () => null }));
vi.mock("./settings/InterfaceSection", () => ({ default: () => null }));
vi.mock("./settings/AiProvidersSection", () => ({
  default: ({ fallbackModel }: { fallbackModel: string }) => (
    <output data-testid="fallback-model">{fallbackModel}</output>
  ),
}));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLDivElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const roots: Array<{ unmount(): void }> = [];
let scrollIntoView = vi.fn();

function installDom() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  scrollIntoView = vi.fn();
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest" },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLButtonElement", window.HTMLButtonElement);
  Reflect.set(globalThis, "HTMLDivElement", window.HTMLDivElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
}

function resetState() {
  Object.assign(state, {
    bestModel: "mock-local",
    closetDirty: false,
    modelError: "",
    tuningDirty: false,
    voiceDirty: false,
    webDirty: false,
  });
  focusTrap.keyDown.mockReset();
  focusTrap.refocusModal.mockReset();
  focusTrap.modalRef.current = null;
  for (const mock of Object.values(cross)) mock.mockReset();
}

async function renderSettings(props: Partial<Props> = {}) {
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  roots.push(root);
  const defaults: Props = {
    ai: null,
    busy: false,
    model: "model",
    onClose: vi.fn(),
    onModelChange: vi.fn(),
    onModelsChanged: vi.fn(),
  };
  await act(async () => {
    root.render(createElement(Settings, { ...defaults, ...props }));
  });
  return { host, root };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

async function navigate(node: Element, key: string) {
  const preventDefault = vi.fn();
  await act(async () => {
    reactProps<{ onKeyDown(event: { key: string; preventDefault(): void }): void }>(node)
      .onKeyDown({ key, preventDefault });
  });
  return preventDefault;
}

function selectedTab(host: Element): string | null {
  return host.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("id") ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  installDom();
  resetState();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.useRealTimers();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (key === "navigator") {
      Reflect.deleteProperty(globalThis, key);
      if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor);
    } else if (value === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Reflect.set(globalThis, key, value);
    }
  }
});

describe("Settings", () => {
  it("routes a section deep-link to its page and flashes the target", async () => {
    const view = await renderSettings({ initialSection: "set-cloud-privacy" });
    expect(selectedTab(view.host)).toBe("settings-tab-privacy");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    const target = view.host.querySelector("#set-cloud-privacy");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(target?.classList.contains("settings-section-flash")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(target?.classList.contains("settings-section-flash")).toBe(false);
  });

  it("moves the page rail with every supported keyboard navigation key", async () => {
    const view = await renderSettings();
    const rail = view.host.querySelector('[role="tablist"]');
    if (!rail) throw new Error("settings page rail missing");

    await navigate(rail, "ArrowDown");
    expect(selectedTab(view.host)).toBe("settings-tab-voice");
    await navigate(rail, "ArrowUp");
    expect(selectedTab(view.host)).toBe("settings-tab-ai");
    await navigate(rail, "End");
    expect(selectedTab(view.host)).toBe("settings-tab-app");
    await navigate(rail, "Home");
    expect(selectedTab(view.host)).toBe("settings-tab-ai");
    expect(await navigate(rail, "PageDown")).not.toHaveBeenCalled();
  });

  it("warns before discarding deferred work and exposes dirty pages", async () => {
    state.tuningDirty = true;
    state.voiceDirty = true;
    state.webDirty = true;
    state.closetDirty = true;
    const onClose = vi.fn();
    const view = await renderSettings({ onClose });
    expect(view.host.querySelectorAll(".settings-nav-flag")).toHaveLength(3);

    const close = view.host.querySelector<HTMLButtonElement>('[aria-label="Close settings"]');
    if (!close) throw new Error("close button missing");
    await click(close);
    expect(onClose).not.toHaveBeenCalled();
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("haven't been saved");

    const keepEditing = [...view.host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Keep editing"));
    if (!keepEditing) throw new Error("keep editing button missing");
    await click(keepEditing);
    expect(view.host.querySelector(".settings-unsaved")).toBeNull();

    await click(close);
    const discard = [...view.host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Discard"));
    if (!discard) throw new Error("discard button missing");
    await click(discard);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("treats a repeated close or backdrop click as keeping unsaved work open", async () => {
    state.tuningDirty = true;
    const onClose = vi.fn();
    const view = await renderSettings({ onClose });
    const close = view.host.querySelector<HTMLButtonElement>('[aria-label="Close settings"]');
    const backdrop = view.host.querySelector(".settings-backdrop");
    if (!close || !backdrop) throw new Error("settings close controls missing");

    await click(close);
    await click(close);
    expect(view.host.querySelector(".settings-unsaved")).toBeNull();
    expect(focusTrap.refocusModal).toHaveBeenCalledOnce();

    await click(backdrop);
    expect(view.host.querySelector(".settings-unsaved")).not.toBeNull();
    expect(focusTrap.refocusModal).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders model errors and uses the local fallback-model selection", async () => {
    state.modelError = "Model installation failed";
    const view = await renderSettings({
      ai: {
        running: true,
        installed: true,
        models: [],
        defaultModel: "",
        external: [],
        remoteRelay: false,
      },
    });
    expect(view.host.querySelector(".gate-error")?.textContent).toBe("Model installation failed");
    expect(view.host.querySelector('[data-testid="fallback-model"]')?.textContent).toBe("mock-local");
  });

  it("falls back to the recommended model when no installed local model qualifies", async () => {
    state.bestModel = null;
    const onClose = vi.fn();
    const view = await renderSettings({ ai: { running: false, installed: false, models: [], defaultModel: "", external: [], remoteRelay: false }, onClose });

    expect(view.host.querySelector('[data-testid="fallback-model"]')?.textContent).toBe("recommended");
    const close = view.host.querySelector('[aria-label="Close settings"]');
    if (!close) throw new Error("close button missing");
    await click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps recovery-code sheets mutually exclusive across password and recovery actions", async () => {
    const view = await renderSettings({ initialSection: "set-cloud-privacy" });
    const changePassword = view.host.querySelector('[data-testid="change-password"]');
    const createRecovery = view.host.querySelector('[data-testid="create-recovery"]');
    if (!changePassword || !createRecovery) throw new Error("privacy actions missing");

    await click(changePassword);
    await click(createRecovery);

    expect(cross.setRecoveryCode).toHaveBeenCalledWith(null);
    expect(cross.changePassword).toHaveBeenCalledOnce();
    expect(cross.setPwRecoveryCode).toHaveBeenCalledWith(null);
    expect(cross.createRecoveryKey).toHaveBeenCalledOnce();
  });
});
