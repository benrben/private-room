import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomInfo } from "./api";
import App, { unlockMessage } from "./App";

const { act, createElement } = React;

const listeners = vi.hoisted(() => ({
  open: undefined as undefined | ((path: string) => void),
  rolledBack: undefined as undefined | ((room: RoomInfo) => void),
  operation: undefined as undefined | ((event: { operationId: string; status: "running" | "completed" | "failed" }) => void),
}));

const bridge = vi.hoisted(() => ({
  listRecent: vi.fn(), roomInfo: vi.fn(), closeRoom: vi.fn(), takePendingOpen: vi.fn(),
  onOpenRoomFile: vi.fn(), onRoomRolledBack: vi.fn(), onWorkspaceOperationProgress: vi.fn(),
  touchIdHas: vi.fn(), removeRecent: vi.fn(), trashRoom: vi.fn(), clearRecent: vi.fn(),
  chooseOpenPath: vi.fn(), chooseSavePath: vi.fn(), createRoom: vi.fn(), setSetting: vi.fn(),
  addMemory: vi.fn(), saveGeneratedFile: vi.fn(), openRoom: vi.fn(), convertLegacyRoom: vi.fn(),
  inspectSealedPackage: vi.fn(), extractSealedFiles: vi.fn(), importSealedPackage: vi.fn(),
  touchIdOpen: vi.fn(), listRoles: vi.fn(), writeRecoveryKey: vi.fn(), hasRecoveryKey: vi.fn(),
  openRoomWithRecovery: vi.fn(), confirm: vi.fn(), message: vi.fn(), setWindowTitle: vi.fn(),
  forgetSavedLayout: vi.fn(), forgetSavedLayouts: vi.fn(),
  updateWorkspaceOperations: vi.fn(), removeWorkspaceOperation: vi.fn(),
}));
const settings = vi.hoisted(() => ({ reduced: true }));

vi.mock("./api", () => ({
  api: bridge,
  listRoles: bridge.listRoles,
  writeRecoveryKey: bridge.writeRecoveryKey,
  hasRecoveryKey: bridge.hasRecoveryKey,
  openRoomWithRecovery: bridge.openRoomWithRecovery,
}));
vi.mock("./platform", () => ({
  confirm: bridge.confirm,
  message: bridge.message,
  setWindowTitle: bridge.setWindowTitle,
}));
vi.mock("./rooms/helpers", () => ({ prefersReducedMotion: () => settings.reduced }));
vi.mock("./shell/useLayout", () => ({
  forgetSavedLayout: bridge.forgetSavedLayout,
  forgetSavedLayouts: bridge.forgetSavedLayouts,
}));
vi.mock("./workspaceOperationProgress", () => ({
  updateWorkspaceOperations: bridge.updateWorkspaceOperations,
  removeWorkspaceOperation: bridge.removeWorkspaceOperation,
}));
vi.mock("./icons", () => ({ Logomark: () => null }));
vi.mock("./Workspace", () => ({
  default: ({ onLock, onRenamed, info }: { onLock: () => Promise<void>; onRenamed: (info: RoomInfo) => void; info: RoomInfo }) =>
    createElement("div", { "data-screen": "workspace" },
      createElement("span", null, info.name),
      createElement("button", { onClick: () => { void onLock().catch(() => {}); } }, "Lock workspace"),
      createElement("button", { onClick: () => onRenamed({ ...info, name: "Renamed workspace" }) }, "Rename workspace")),
}));
vi.mock("./screens/StartScreen", () => ({
  StartScreen: (props: {
    recent: Array<{ path: string; name: string }>;
    onCreate: () => void; onOpen: () => void; onDemo: () => void; onOpenRecent: (path: string) => void;
    onRemoveRecent: (path: string) => void; onTrashRoom: (room: { path: string; name: string }) => void; onClearRecent: () => void;
  }) => createElement("div", { "data-screen": "start" },
    createElement("button", { onClick: props.onCreate }, "Create"),
    createElement("button", { onClick: props.onOpen }, "Open"),
    createElement("button", { onClick: props.onDemo }, "Demo"),
    createElement("button", { onClick: () => props.onOpenRecent("/recent") }, "Open recent"),
    createElement("button", { onClick: () => props.onOpenRecent("/missing") }, "Open missing"),
    createElement("button", { onClick: () => props.onRemoveRecent("/recent") }, "Remove recent"),
    createElement("button", { onClick: () => props.onTrashRoom({ path: "/recent", name: "Recent" }) }, "Trash recent"),
    createElement("button", { onClick: props.onClearRecent }, "Clear recent"),
    createElement("span", null, props.recent.map((room) => room.name).join(","))),
}));
vi.mock("./screens/CreateScreen", () => ({
  CreateScreen: (props: {
    roomName: string; setRoomName: (value: string) => void; templateKey: string; setTemplateKey: (value: string) => void;
    roles: Array<{ id: string }>; roleId: string; setRoleId: (value: string) => void;
    password: string; setPassword: (value: string) => void; confirm: string; setConfirm: (value: string) => void;
    error: string; setError: (value: string) => void; busy: boolean; onSubmit: () => void; onBack: () => void;
  }) => createElement("div", { "data-screen": "create" },
    createElement("input", { "aria-label": "room name", value: props.roomName, onChange: (e: { target: { value: string } }) => props.setRoomName(e.target.value) }),
    createElement("input", { "aria-label": "template", value: props.templateKey, onChange: (e: { target: { value: string } }) => props.setTemplateKey(e.target.value) }),
    createElement("input", { "aria-label": "role", value: props.roleId, onChange: (e: { target: { value: string } }) => props.setRoleId(e.target.value) }),
    createElement("input", { "aria-label": "create password", value: props.password, onChange: (e: { target: { value: string } }) => props.setPassword(e.target.value) }),
    createElement("input", { "aria-label": "create confirm", value: props.confirm, onChange: (e: { target: { value: string } }) => props.setConfirm(e.target.value) }),
    createElement("button", { onClick: props.onSubmit }, "Submit create"),
    createElement("button", { onClick: props.onBack }, "Back"),
    createElement("button", { onClick: () => props.setError("manual error") }, "Set create error"),
    createElement("span", { role: "alert" }, props.error)),
}));
vi.mock("./screens/UnlockScreen", () => ({
  UnlockScreen: (props: {
    password: string; setPassword: (value: string) => void; recoveryInput: string; setRecoveryInput: (value: string) => void; error: string;
    onUnlock: () => void; onRecoveryUnlock: () => void; onTouchId: () => void; onConvertLegacy: () => void; onInspectSealed: () => void;
    onEnterRecoveryMode: () => void; onExitRecoveryMode: () => void; onBack: () => void;
  }) => createElement("div", { "data-screen": "unlock" },
    createElement("input", { "aria-label": "unlock password", value: props.password, onChange: (e: { target: { value: string } }) => props.setPassword(e.target.value) }),
    createElement("input", { "aria-label": "recovery code", value: props.recoveryInput, onChange: (e: { target: { value: string } }) => props.setRecoveryInput(e.target.value) }),
    createElement("button", { onClick: props.onUnlock }, "Unlock"),
    createElement("button", { onClick: props.onRecoveryUnlock }, "Recovery unlock"),
    createElement("button", { onClick: props.onTouchId }, "Touch ID"),
    createElement("button", { onClick: props.onConvertLegacy }, "Convert"),
    createElement("button", { onClick: props.onInspectSealed }, "Inspect"),
    createElement("button", { onClick: props.onEnterRecoveryMode }, "Enter recovery"),
    createElement("button", { onClick: props.onExitRecoveryMode }, "Exit recovery"),
    createElement("button", { onClick: props.onBack }, "Back"),
    createElement("span", { role: "alert" }, props.error)),
}));
vi.mock("./screens/SealedInspectionScreen", () => ({
  SealedInspectionScreen: (props: { onExtract: (ids: string[]) => void; onImport: () => void; onBack: () => void; error: string }) =>
    createElement("div", { "data-screen": "sealed" },
      createElement("button", { onClick: () => props.onExtract(["file-1"]) }, "Extract"),
      createElement("button", { onClick: props.onImport }, "Import"),
      createElement("button", { onClick: props.onBack }, "Back inspection"),
      createElement("span", { role: "alert" }, props.error)),
}));
vi.mock("./screens/RecoveryModal", () => ({
  RecoveryModal: (props: { recoveryCode: string; onDismiss: () => void; setRecoveryCopied: (copied: boolean) => void }) =>
    createElement("div", { "data-screen": "recovery" },
      createElement("span", null, props.recoveryCode),
      createElement("button", { onClick: () => props.setRecoveryCopied(true) }, "Copy recovery"),
      createElement("button", { onClick: props.onDismiss }, "Dismiss recovery")),
}));
vi.mock("./screens/WorkspaceOperationProgress", () => ({ WorkspaceOperationProgress: () => null }));
vi.mock("./screens/SealOverlay", () => ({ SealLockingOverlay: () => null, SealUnlockingOverlay: () => null }));

const info: RoomInfo = { name: "Room", path: "/room", fileCount: 0, messageCount: 0, synced: false, pendingMcp: null };
const globalKeys = ["document", "window", "navigator", "HTMLElement", "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.listRecent.mockResolvedValue([{ path: "/recent", name: "Recent", missing: false }]);
  bridge.roomInfo.mockResolvedValue(null); bridge.closeRoom.mockResolvedValue(undefined); bridge.takePendingOpen.mockResolvedValue(null);
  bridge.onOpenRoomFile.mockImplementation((listener: (path: string) => void) => {
    listeners.open = listener;
    return Promise.resolve(() => { listeners.open = undefined; });
  });
  bridge.onRoomRolledBack.mockImplementation((listener: (room: RoomInfo) => void) => {
    listeners.rolledBack = listener;
    return Promise.resolve(() => { listeners.rolledBack = undefined; });
  });
  bridge.onWorkspaceOperationProgress.mockImplementation((listener: (event: { operationId: string; status: "running" | "completed" | "failed" }) => void) => {
    listeners.operation = listener;
    return Promise.resolve(() => { listeners.operation = undefined; });
  });
  bridge.touchIdHas.mockResolvedValue(false); bridge.hasRecoveryKey.mockResolvedValue(false); bridge.listRoles.mockResolvedValue([]);
  bridge.chooseOpenPath.mockResolvedValue(null); bridge.chooseSavePath.mockResolvedValue(null); bridge.createRoom.mockResolvedValue(info);
  bridge.setSetting.mockResolvedValue(undefined); bridge.addMemory.mockResolvedValue(undefined); bridge.saveGeneratedFile.mockResolvedValue(undefined);
  bridge.openRoom.mockResolvedValue(info); bridge.convertLegacyRoom.mockResolvedValue({ convertedFiles: 1, renamed: [], skipped: [] });
  bridge.inspectSealedPackage.mockResolvedValue({ fileCount: 1, files: [] }); bridge.extractSealedFiles.mockResolvedValue({ fileCount: 1 });
  bridge.importSealedPackage.mockResolvedValue(undefined); bridge.touchIdOpen.mockResolvedValue(info); bridge.writeRecoveryKey.mockResolvedValue("RECOVERY");
  bridge.openRoomWithRecovery.mockResolvedValue(info); bridge.confirm.mockResolvedValue(true); bridge.message.mockResolvedValue(undefined); bridge.setWindowTitle.mockResolvedValue(undefined);
  bridge.removeRecent.mockResolvedValue(undefined); bridge.trashRoom.mockResolvedValue(undefined); bridge.clearRecent.mockResolvedValue(undefined);
  bridge.updateWorkspaceOperations.mockImplementation((current: unknown[], event: unknown) => [...current, event]); bridge.removeWorkspaceOperation.mockImplementation((current: unknown[]) => current);
  settings.reduced = true;
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

async function renderApp() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window); Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Vitest" } });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement); Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event); Reflect.set(globalThis, "React", React); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client"); const host = document.getElementById("root"); if (!host) throw new Error("test root missing");
  const root = createRoot(host); await act(async () => root.render(createElement(App))); await flush(); return { host, root, window };
}

function reactProps<T>(node: Element): T { const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps")); if (!key) throw new Error("React props missing"); return (node as unknown as Record<string, unknown>)[key] as T; }
function button(host: Element, label: string) { const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label)); if (!found) throw new Error(`button not found: ${label}`); return found; }
async function click(node: Element, window: Window & typeof globalThis) { await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true }))); await flush(); }
async function change(input: HTMLInputElement, value: string) { await act(async () => reactProps<{ onChange: (event: { target: { value: string } }) => void }>(input).onChange({ target: { value } })); await flush(); }

beforeEach(resetBridge);
afterEach(() => { vi.useRealTimers(); for (const [key, value] of Object.entries(originalGlobals)) { if (key === "navigator") { Reflect.deleteProperty(globalThis, key); if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor); continue; } if (value === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, value); } });

describe("App", () => {
  it("creates, seeds, reveals recovery, and enters a room", async () => {
    bridge.listRoles.mockResolvedValue([{ id: "role", instructions: "Role instructions" }]);
    bridge.chooseSavePath.mockResolvedValue("/created");
    const view = await renderApp();
    await click(button(view.host, "Create"), view.window);
    const name = view.host.querySelector<HTMLInputElement>('[aria-label="room name"]'); const template = view.host.querySelector<HTMLInputElement>('[aria-label="template"]'); const role = view.host.querySelector<HTMLInputElement>('[aria-label="role"]'); const password = view.host.querySelector<HTMLInputElement>('[aria-label="create password"]'); const confirm = view.host.querySelector<HTMLInputElement>('[aria-label="create confirm"]');
    if (!name || !template || !role || !password || !confirm) throw new Error("create controls missing");
    await change(password, "short"); await click(button(view.host, "Submit create"), view.window); expect(view.host.textContent).toContain("Please use at least");
    await change(password, "password1"); await change(confirm, "different"); await click(button(view.host, "Submit create"), view.window); expect(view.host.textContent).toContain("Passwords do not match");
    await change(name, "Journal/2026"); await change(template, "demo"); await change(role, "role"); await change(confirm, "password1"); await click(button(view.host, "Submit create"), view.window);
    expect(bridge.chooseSavePath).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "Journal-2026" }));
    expect(bridge.createRoom).toHaveBeenCalledWith("/created", "password1", "Journal/2026", "workspace-folder");
    expect(bridge.setSetting).toHaveBeenCalledWith("room_role", "role"); expect(bridge.addMemory).toHaveBeenCalled(); expect(bridge.saveGeneratedFile).toHaveBeenCalled();
    expect(view.host.querySelector('[data-screen="recovery"]')).not.toBeNull(); await click(button(view.host, "Copy recovery"), view.window); await click(button(view.host, "Dismiss recovery"), view.window);
    expect(view.host.querySelector('[data-screen="workspace"]')).not.toBeNull(); await act(async () => view.root.unmount());
  });

  it("routes unlock, recovery, Touch ID, conversion, sealed operations and errors", async () => {
    bridge.chooseOpenPath.mockResolvedValue("/legacy.roomai");
    const view = await renderApp(); await click(button(view.host, "Open"), view.window);
    const password = view.host.querySelector<HTMLInputElement>('[aria-label="unlock password"]'); if (!password) throw new Error("unlock password missing");
    await click(button(view.host, "Unlock"), view.window); expect(view.host.textContent).toContain("Enter your password");
    await change(password, "password1"); bridge.openRoom.mockRejectedValueOnce(new Error("WRONG_PASSWORD")); await click(button(view.host, "Unlock"), view.window); expect(view.host.textContent).toContain("That password didn't work");
    await click(button(view.host, "Touch ID"), view.window); expect(bridge.touchIdOpen).toHaveBeenCalledWith("/legacy.roomai");
    await click(button(view.host, "Lock workspace"), view.window); await click(button(view.host, "Open"), view.window); const emptyNoticePassword = view.host.querySelector<HTMLInputElement>('[aria-label="unlock password"]'); if (!emptyNoticePassword) throw new Error("unlock password missing"); await change(emptyNoticePassword, "password1"); bridge.chooseSavePath.mockResolvedValue("/converted-empty"); bridge.convertLegacyRoom.mockResolvedValueOnce({ convertedFiles: 1, renamed: [], skipped: ["missing"] }); await click(button(view.host, "Convert"), view.window); expect(bridge.message).toHaveBeenCalledWith(expect.stringContaining("legacy row"), expect.objectContaining({ title: "Conversion complete" }));
    await click(button(view.host, "Lock workspace"), view.window); await click(button(view.host, "Open"), view.window);
    const converted = view.host.querySelector<HTMLInputElement>('[aria-label="unlock password"]'); if (!converted) throw new Error("unlock password missing"); await change(converted, "password1"); bridge.chooseSavePath.mockResolvedValue("/converted"); bridge.convertLegacyRoom.mockResolvedValueOnce({ convertedFiles: 2, renamed: ["x"], skipped: [] }); await click(button(view.host, "Convert"), view.window); expect(bridge.message).toHaveBeenCalledWith(expect.stringContaining("2 files converted"), expect.anything());
    await click(button(view.host, "Lock workspace"), view.window); await click(button(view.host, "Open"), view.window); const inspectPassword = view.host.querySelector<HTMLInputElement>('[aria-label="unlock password"]'); if (!inspectPassword) throw new Error("unlock password missing"); await change(inspectPassword, "password1"); await click(button(view.host, "Inspect"), view.window); expect(view.host.querySelector('[data-screen="sealed"]')).not.toBeNull();
    bridge.chooseSavePath.mockResolvedValue("/extracted"); await click(button(view.host, "Extract"), view.window); expect(bridge.extractSealedFiles).toHaveBeenCalled();
    bridge.chooseSavePath.mockResolvedValue("/imported"); await click(button(view.host, "Import"), view.window); expect(bridge.importSealedPackage).toHaveBeenCalled(); await act(async () => view.root.unmount());
  });

  it("keeps start actions recoverable and classifies unlock messages", async () => {
    bridge.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true); bridge.trashRoom.mockRejectedValueOnce(new Error("trash denied")); bridge.clearRecent.mockRejectedValueOnce(new Error("clear denied"));
    const view = await renderApp(); await click(button(view.host, "Remove recent"), view.window); expect(bridge.removeRecent).toHaveBeenCalledWith("/recent"); await click(button(view.host, "Trash recent"), view.window); expect(bridge.trashRoom).not.toHaveBeenCalled(); await click(button(view.host, "Trash recent"), view.window); expect(bridge.message).toHaveBeenCalledWith(expect.stringContaining("trash denied"), expect.anything()); await click(button(view.host, "Clear recent"), view.window); expect(bridge.message).toHaveBeenCalledWith(expect.stringContaining("clear denied"), expect.anything());
    await click(button(view.host, "Trash recent"), view.window); expect(bridge.forgetSavedLayout).toHaveBeenCalledWith("/recent"); await click(button(view.host, "Clear recent"), view.window); expect(bridge.forgetSavedLayouts).toHaveBeenCalled();
    expect(unlockMessage("Error: readonly volume")).toContain("read-only disk"); expect(unlockMessage("File not found.")).toBe("File not found."); expect(unlockMessage("sql failure")).toContain("couldn't be opened"); expect(unlockMessage("malformed database")).toContain("looks damaged"); expect(unlockMessage("database is locked")).toContain("another copy"); expect(unlockMessage("sqlcipher error")).toContain("couldn't be unlocked"); await act(async () => view.root.unmount());
  });

  it("keeps create setup and recovery failures visible without losing the new room", async () => {
    bridge.chooseSavePath.mockResolvedValue("/created"); bridge.addMemory.mockRejectedValueOnce(new Error("seed failed")); bridge.writeRecoveryKey.mockRejectedValueOnce(new Error("key failed")); bridge.message.mockRejectedValueOnce(new Error("dialog unavailable"));
    const view = await renderApp(); bridge.listRoles.mockRejectedValueOnce(new Error("roles unavailable")); await click(button(view.host, "Create"), view.window);
    const password = view.host.querySelector<HTMLInputElement>('[aria-label="create password"]'); const confirm = view.host.querySelector<HTMLInputElement>('[aria-label="create confirm"]'); const template = view.host.querySelector<HTMLInputElement>('[aria-label="template"]');
    if (!password || !confirm || !template) throw new Error("create controls missing");
    await change(template, "demo"); await change(password, "password1"); await change(confirm, "password1"); await click(button(view.host, "Submit create"), view.window);
    expect(bridge.addMemory).toHaveBeenCalled(); expect(bridge.message).toHaveBeenCalledWith(expect.stringContaining("recovery code could not be written"), expect.anything()); expect(view.host.querySelector('[data-screen="workspace"]')).not.toBeNull(); await act(async () => view.root.unmount());
  });

  it("surfaces creation, conversion, inspection, sealed, recovery and Touch ID errors", async () => {
    const view = await renderApp(); await click(button(view.host, "Create"), view.window);
    const createPassword = view.host.querySelector<HTMLInputElement>('[aria-label="create password"]'); const createConfirm = view.host.querySelector<HTMLInputElement>('[aria-label="create confirm"]'); if (!createPassword || !createConfirm) throw new Error("create controls missing");
    await change(createPassword, "password1"); await change(createConfirm, "password1"); bridge.chooseSavePath.mockResolvedValueOnce("/bad-create"); bridge.createRoom.mockRejectedValueOnce(new Error("create denied")); await click(button(view.host, "Submit create"), view.window); expect(view.host.textContent).toContain("create denied"); await click(button(view.host, "Back"), view.window);
    bridge.chooseOpenPath.mockResolvedValue("/sealed.roomai"); bridge.touchIdHas.mockRejectedValueOnce(new Error("no biometric")); bridge.hasRecoveryKey.mockRejectedValueOnce(new Error("no sidecar")); await click(button(view.host, "Open"), view.window);
    await click(button(view.host, "Convert"), view.window); expect(view.host.textContent).toContain("Enter the room password before converting"); await click(button(view.host, "Inspect"), view.window); expect(view.host.textContent).toContain("Enter the sealed backup password before inspecting");
    const password = view.host.querySelector<HTMLInputElement>('[aria-label="unlock password"]'); if (!password) throw new Error("unlock password missing"); await change(password, "password1");
    bridge.chooseSavePath.mockResolvedValueOnce("/converted"); bridge.convertLegacyRoom.mockRejectedValueOnce(new Error("convert denied")); await click(button(view.host, "Convert"), view.window); expect(view.host.textContent).toContain("couldn't be opened");
    bridge.inspectSealedPackage.mockRejectedValueOnce(new Error("inspect denied")); await click(button(view.host, "Inspect"), view.window); expect(view.host.textContent).toContain("couldn't be opened");
    bridge.inspectSealedPackage.mockResolvedValueOnce({ fileCount: 2, files: [] }); await click(button(view.host, "Inspect"), view.window); expect(view.host.querySelector('[data-screen="sealed"]')).not.toBeNull();
    bridge.chooseSavePath.mockResolvedValueOnce("/extracted"); bridge.extractSealedFiles.mockRejectedValueOnce(new Error("extract denied")); await click(button(view.host, "Extract"), view.window); expect(view.host.textContent).toContain("couldn't be opened");
    bridge.chooseSavePath.mockRejectedValueOnce(new Error("save denied")); await click(button(view.host, "Import"), view.window); expect(view.host.textContent).toContain("couldn't be opened");
    bridge.chooseSavePath.mockResolvedValueOnce("/imported"); bridge.importSealedPackage.mockRejectedValueOnce(new Error("import denied")); await click(button(view.host, "Import"), view.window); expect(view.host.textContent).toContain("couldn't be opened"); await click(button(view.host, "Back inspection"), view.window);
    bridge.touchIdOpen.mockRejectedValueOnce(new Error("touch denied")); await click(button(view.host, "Touch ID"), view.window); expect(view.host.textContent).toContain("couldn't be opened");
    await click(button(view.host, "Enter recovery"), view.window); const recovery = view.host.querySelector<HTMLInputElement>('[aria-label="recovery code"]'); if (!recovery) throw new Error("recovery control missing"); await change(recovery, " code "); bridge.openRoomWithRecovery.mockRejectedValueOnce(new Error("recovery code rejected")); await click(button(view.host, "Recovery unlock"), view.window); expect(view.host.textContent).toContain("That recovery code didn't work"); bridge.openRoomWithRecovery.mockRejectedValueOnce(new Error("disk unavailable")); await click(button(view.host, "Recovery unlock"), view.window); expect(view.host.textContent).toContain("couldn't be opened"); await click(button(view.host, "Exit recovery"), view.window); await click(button(view.host, "Enter recovery"), view.window); const successfulRecovery = view.host.querySelector<HTMLInputElement>('[aria-label="recovery code"]'); if (!successfulRecovery) throw new Error("recovery control missing"); await change(successfulRecovery, "valid code"); bridge.openRoomWithRecovery.mockResolvedValueOnce(info); await click(button(view.host, "Recovery unlock"), view.window); expect(view.host.querySelector('[data-screen="workspace"]')).not.toBeNull(); await act(async () => view.root.unmount());
  });

  it("handles desktop events, missing recent rooms, and non-reduced seal timing", async () => {
    vi.useFakeTimers(); settings.reduced = false; bridge.listRecent.mockResolvedValue([{ path: "/missing", name: "Missing", missing: true }]); bridge.chooseOpenPath.mockResolvedValue("/picked");
    const view = await renderApp(); await click(button(view.host, "Open missing"), view.window); expect(view.host.querySelector('[data-screen="unlock"]')).not.toBeNull(); await click(button(view.host, "Back"), view.window); await click(button(view.host, "Open recent"), view.window); expect(view.host.querySelector('[data-screen="unlock"]')).not.toBeNull();
    await act(async () => { listeners.open?.("/event"); }); await flush(); expect(bridge.closeRoom).toHaveBeenCalled();
    await act(async () => { listeners.rolledBack?.(info); }); await flush(); expect(view.host.querySelector('[data-screen="workspace"]')).not.toBeNull();
    await act(async () => { listeners.operation?.({ operationId: "save", status: "completed" }); listeners.operation?.({ operationId: "save", status: "running" }); listeners.operation?.({ operationId: "export", status: "failed" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1900); }); expect(bridge.removeWorkspaceOperation).toHaveBeenCalled();
    await click(button(view.host, "Lock workspace"), view.window); await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(view.host.querySelector('[data-screen="start"]')).not.toBeNull(); await click(button(view.host, "Demo"), view.window); expect(view.host.querySelector('[data-screen="create"]')).not.toBeNull(); await click(button(view.host, "Back"), view.window); await act(async () => { listeners.operation?.({ operationId: "cleanup", status: "completed" }); });
    bridge.roomInfo.mockResolvedValueOnce(info); const second = await renderApp(); await flush(); bridge.closeRoom.mockRejectedValueOnce(new Error("close denied")); await click(button(second.host, "Lock workspace"), second.window); expect(second.host.querySelector('[data-screen="workspace"]')).not.toBeNull(); await act(async () => second.root.unmount());
    bridge.chooseOpenPath.mockResolvedValue("/animated"); const third = await renderApp(); await click(button(third.host, "Open"), third.window); const animatedPassword = third.host.querySelector<HTMLInputElement>('[aria-label="unlock password"]'); if (!animatedPassword) throw new Error("unlock password missing"); await change(animatedPassword, "password1"); await click(button(third.host, "Unlock"), third.window); expect(third.host.querySelector('.entering')).not.toBeNull(); await click(button(third.host, "Back"), third.window); expect(third.host.querySelector('[data-screen="start"]')).not.toBeNull(); await click(button(third.host, "Open"), third.window); const finalPassword = third.host.querySelector<HTMLInputElement>('[aria-label="unlock password"]'); if (!finalPassword) throw new Error("unlock password missing"); await change(finalPassword, "password1"); await click(button(third.host, "Unlock"), third.window); await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(third.host.querySelector('[data-screen="workspace"]')).not.toBeNull(); await act(async () => { third.root.unmount(); view.root.unmount(); });
  });
});
