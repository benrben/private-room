import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";

const { checkForUpdate, confirm, installUpdate, message } = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  confirm: vi.fn(),
  installUpdate: vi.fn(),
  message: vi.fn(),
}));

vi.mock("./platform", () => ({ checkForUpdate, confirm, installUpdate, message }));

import { autoUpdateCheckEnabled, checkForUpdatesQuietly, setAutoUpdateCheck } from "./updater";

const globalKeys = ["window", "document", "localStorage"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

const values = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  removeItem: vi.fn((key: string) => values.delete(key)),
};

function installDom() {
  const parsed = parseHTML("<html><body></body></html>");
  Reflect.set(globalThis, "window", parsed.window);
  Reflect.set(globalThis, "document", parsed.document);
  Reflect.set(globalThis, "localStorage", storage);
  return parsed.document as unknown as Document;
}

beforeEach(() => {
  values.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  installDom();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("updater", () => {
  it("honors the device-wide launch preference and preserves it through the setting helper", async () => {
    expect(autoUpdateCheckEnabled()).toBe(true);
    expect(setAutoUpdateCheck(false)).toBe(false);
    await checkForUpdatesQuietly();
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(setAutoUpdateCheck(true)).toBe(true);
    expect(values.has("prUpdateCheck")).toBe(false);
  });

  it("stays quiet for unavailable, skipped, and dialog-unavailable releases", async () => {
    checkForUpdate.mockResolvedValueOnce(null);
    await checkForUpdatesQuietly();
    expect(confirm).not.toHaveBeenCalled();

    values.set("prSkippedUpdate", "2.0.0");
    checkForUpdate.mockResolvedValueOnce({ version: "2.0.0" });
    await checkForUpdatesQuietly();
    expect(confirm).not.toHaveBeenCalled();

    checkForUpdate.mockResolvedValueOnce({ version: "2.1.0" });
    confirm.mockRejectedValueOnce(new Error("dialog unavailable"));
    await checkForUpdatesQuietly();
    expect(installUpdate).not.toHaveBeenCalled();
    expect(values.get("prSkippedUpdate")).toBe("2.0.0");
  });

  it("remembers a declined version but still asks about a newer release", async () => {
    checkForUpdate.mockResolvedValueOnce({ version: "2.0.0" });
    confirm.mockResolvedValueOnce(false);
    await checkForUpdatesQuietly();
    expect(values.get("prSkippedUpdate")).toBe("2.0.0");
    expect(installUpdate).not.toHaveBeenCalled();

    checkForUpdate.mockResolvedValueOnce({ version: "2.1.0" });
    confirm.mockResolvedValueOnce(true);
    installUpdate.mockResolvedValueOnce(undefined);
    await checkForUpdatesQuietly();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(installUpdate).toHaveBeenCalledOnce();
  });

  it("shows and removes the download banner around a successful install", async () => {
    checkForUpdate.mockResolvedValueOnce({ version: "3.0.0" });
    confirm.mockResolvedValueOnce(true);
    installUpdate.mockImplementationOnce(async () => {
      const banner = document.querySelector(".update-progress");
      expect(banner?.textContent).toContain("Downloading Arcelle 3.0.0");
      expect(banner?.querySelector<HTMLElement>(".update-progress-track")?.style.display).toBe("none");
    });
    await checkForUpdatesQuietly();
    expect(document.querySelector(".update-progress")).toBeNull();
    expect(message).not.toHaveBeenCalled();
  });

  it("reports an install failure and removes the banner even when its error dialog fails", async () => {
    checkForUpdate.mockResolvedValueOnce({ version: "4.0.0" });
    confirm.mockResolvedValueOnce(true);
    installUpdate.mockRejectedValueOnce(new Error("disk full"));
    message.mockRejectedValueOnce(new Error("dialog unavailable"));
    await expect(checkForUpdatesQuietly()).resolves.toBeUndefined();
    expect(message).toHaveBeenCalledWith(expect.stringContaining("disk full"), {
      title: "Update failed",
      kind: "error",
    });
    expect(document.querySelector(".update-progress")).toBeNull();
  });

  it("uses safe preference defaults when device storage is unavailable", async () => {
    storage.getItem.mockImplementationOnce(() => {
      throw new Error("storage blocked");
    });
    expect(autoUpdateCheckEnabled()).toBe(true);

    storage.setItem.mockImplementationOnce(() => {
      throw new Error("storage blocked");
    });
    expect(setAutoUpdateCheck(false)).toBe(true);

    storage.getItem
      .mockImplementationOnce(() => null)
      .mockImplementationOnce(() => {
        throw new Error("storage blocked");
      });
    checkForUpdate.mockResolvedValueOnce({ version: "5.0.0" });
    confirm.mockResolvedValueOnce(false);
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("storage blocked");
    });
    await expect(checkForUpdatesQuietly()).resolves.toBeUndefined();
  });

  it("logs a failed launch check without presenting a dialog", async () => {
    checkForUpdate.mockRejectedValueOnce(new Error("offline"));

    await expect(checkForUpdatesQuietly()).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      "[updater] check failed (offline or no release yet):",
      expect.any(Error),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("still installs when the progress banner cannot be constructed", async () => {
    checkForUpdate.mockResolvedValueOnce({ version: "6.0.0" });
    confirm.mockResolvedValueOnce(true);
    installUpdate.mockResolvedValueOnce(undefined);
    vi.spyOn(document, "createElement").mockImplementationOnce(() => {
      throw new Error("DOM unavailable");
    });

    await expect(checkForUpdatesQuietly()).resolves.toBeUndefined();

    expect(installUpdate).toHaveBeenCalledOnce();
  });
});
