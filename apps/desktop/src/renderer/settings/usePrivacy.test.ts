import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePrivacy } from "./usePrivacy";

const mocks = vi.hoisted(() => ({
  hasRecoveryKey: vi.fn(),
  api: {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    roomInfo: vi.fn(),
    touchIdHas: vi.fn(),
    changePassword: vi.fn(),
    listStrandedCheckpoints: vi.fn(),
    touchIdDisable: vi.fn(),
    touchIdEnable: vi.fn(),
    roomStorageUsage: vi.fn(),
    chooseSavePath: vi.fn(),
    duplicateRoom: vi.fn(),
    compactRoom: vi.fn(),
  },
}));

vi.mock("../api", () => ({ api: mocks.api, hasRecoveryKey: mocks.hasRecoveryKey }));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Privacy = ReturnType<typeof usePrivacy>;

let privacy: Privacy | null = null;

function PrivacyProbe() {
  privacy = usePrivacy();
  return null;
}

function current(): Privacy {
  if (!privacy) throw new Error("Privacy hook has not rendered.");
  return privacy;
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderHook() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const timers: Array<() => void> = [];
  Reflect.set(window, "setTimeout", (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  });
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
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
    root.render(createElement(PrivacyProbe));
    await Promise.resolve();
  });
  await flush();
  return {
    close: async () => act(async () => root.unmount()),
    runTimers: async () => act(async () => timers.splice(0).forEach((callback) => callback())),
  };
}

async function setPassword(currentPassword: string, next: string, repeat: string) {
  await act(async () => {
    current().setPwCurrent(currentPassword);
    current().setPwNew(next);
    current().setPwRepeat(repeat);
  });
  await flush();
}

function configureMocks() {
  mocks.hasRecoveryKey.mockReset().mockResolvedValue(false);
  mocks.api.getSetting.mockReset().mockResolvedValue("60");
  mocks.api.setSetting.mockReset().mockResolvedValue(undefined);
  mocks.api.roomInfo.mockReset().mockResolvedValue({ path: "/rooms/Private", name: "Private" });
  mocks.api.touchIdHas.mockReset().mockResolvedValue(true);
  mocks.api.changePassword.mockReset().mockResolvedValue("new-recovery-code");
  mocks.api.listStrandedCheckpoints.mockReset().mockResolvedValue([]);
  mocks.api.touchIdDisable.mockReset().mockResolvedValue(undefined);
  mocks.api.touchIdEnable.mockReset().mockResolvedValue(undefined);
  mocks.api.roomStorageUsage.mockReset().mockResolvedValue({ kind: "workspace" });
  mocks.api.chooseSavePath.mockReset().mockResolvedValue("/copies/Private copy");
  mocks.api.duplicateRoom.mockReset().mockResolvedValue(undefined);
  mocks.api.compactRoom.mockReset().mockResolvedValue("Reclaimed 12 MB.");
}

beforeEach(() => {
  privacy = null;
  configureMocks();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("usePrivacy", () => {
  it("loads room privacy state and performs its ordinary setting commands through mocks", async () => {
    const view = await renderHook();
    expect(current().autolock).toBe("60");
    expect(current().roomName).toBe("Private");
    expect(current().touchIdOn).toBe(true);

    await act(async () => { current().changeAutolock("5"); });
    expect(current().autolock).toBe("5");
    expect(mocks.api.setSetting).toHaveBeenCalledWith("autolock_minutes", "5");

    await act(async () => { await current().toggleTouchId(); });
    expect(mocks.api.touchIdDisable).toHaveBeenCalledWith("/rooms/Private");
    expect(current().touchIdOn).toBe(false);
    await act(async () => { await current().toggleTouchId(); });
    expect(mocks.api.touchIdEnable).toHaveBeenCalledOnce();
    expect(current().touchIdOn).toBe(true);

    await act(async () => { await current().chooseDupDest(); });
    expect(mocks.api.chooseSavePath).toHaveBeenCalledWith({
      title: "Choose destination workspace folder",
      defaultPath: "Copy of Private",
    });
    expect(current().dupDest).toBe("/copies/Private copy");

    await act(async () => { await current().compact(); });
    expect(current().compactMsg).toBe("Reclaimed 12 MB.");
    expect(current().compacting).toBe(false);
    await view.close();
  });

  it("keeps every password-change warning visible while syncing lost Touch ID state", async () => {
    mocks.hasRecoveryKey.mockResolvedValue(true);
    mocks.api.changePassword.mockResolvedValue(null);
    mocks.api.listStrandedCheckpoints.mockResolvedValue(["checkpoint-7"]);
    mocks.api.touchIdHas.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
    const view = await renderHook();
    await setPassword("old password", "New password 123!", "New password 123!");

    await act(async () => { await current().changePassword(); });
    expect(mocks.hasRecoveryKey).toHaveBeenCalledWith("/rooms/Private");
    expect(mocks.api.changePassword).toHaveBeenCalledWith("old password", "New password 123!");
    expect(current().pwCurrent).toBe("");
    expect(current().pwNew).toBe("");
    expect(current().pwRepeat).toBe("");
    expect(current().pwSaved).toBe(true);
    expect(current().pwRecoveryCode).toBeNull();
    expect(current().pwError).toContain("recovery key could not be re-issued");
    expect(current().pwError).toContain("checkpoint-7");
    expect(current().touchIdOn).toBe(false);
    expect(current().touchIdErr).toContain("Touch ID unlock was turned off");

    await view.runTimers();
    expect(current().pwSaved).toBe(false);
    await view.close();
  });

  it("reports validation and mocked command failures without claiming completion", async () => {
    const view = await renderHook();

    await act(async () => { await current().changePassword(); });
    expect(current().pwError).toContain("at least 8 characters");
    expect(mocks.api.changePassword).not.toHaveBeenCalled();

    await setPassword("old password", "New password 123!", "New password 123!");
    mocks.api.changePassword.mockRejectedValueOnce(new Error("old password rejected"));
    await act(async () => { await current().changePassword(); });
    expect(current().pwError).toContain("old password rejected");

    mocks.api.touchIdDisable.mockRejectedValueOnce(new Error("keychain unavailable"));
    await act(async () => { await current().toggleTouchId(); });
    expect(current().touchIdErr).toContain("keychain unavailable");

    mocks.api.roomStorageUsage.mockResolvedValueOnce({ kind: "legacy" });
    mocks.api.chooseSavePath.mockRejectedValueOnce(new Error("save panel failed"));
    await act(async () => { await current().chooseDupDest(); });
    expect(current().dupError).toContain("save panel failed");
    expect(mocks.api.chooseSavePath).toHaveBeenCalledWith({
      title: "Save duplicated Arcelle room",
      defaultPath: "Copy of Private.arcelle",
      filters: [{ name: "Arcelle Legacy Room", extensions: ["arcelle", "roomai"] }],
    });

    await act(async () => { await current().duplicate(); });
    expect(current().dupError).toContain("Choose where to save");
    await act(async () => { await current().chooseDupDest(); });
    await act(async () => {
      current().setDupPassword("short");
      current().setDupRepeat("different");
    });
    await flush();
    await act(async () => { await current().duplicate(); });
    expect(current().dupError).toContain("do not match");

    await act(async () => {
      current().setDupPassword("Copy password 123!");
      current().setDupRepeat("Copy password 123!");
    });
    await flush();
    mocks.api.duplicateRoom.mockRejectedValueOnce(new Error("destination occupied"));
    await act(async () => { await current().duplicate(); });
    expect(current().dupError).toContain("destination occupied");
    await act(async () => { await current().duplicate(); });
    expect(mocks.api.duplicateRoom).toHaveBeenLastCalledWith(
      "/copies/Private copy",
      "Copy password 123!",
    );
    expect(current().dupDone).toBe(true);
    await view.runTimers();
    expect(current().dupDone).toBe(false);

    mocks.api.compactRoom.mockRejectedValueOnce(new Error("compact failed"));
    await act(async () => { await current().compact(); });
    expect(current().compactErr).toContain("compact failed");
    expect(current().compacting).toBe(false);
    await view.close();
  });
});
