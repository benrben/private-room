import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ writeRecoveryKey: vi.fn() }));

vi.mock("../api", () => ({ writeRecoveryKey: bridge.writeRecoveryKey }));

import { useRecovery } from "./useRecovery";

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type Recovery = ReturnType<typeof useRecovery>;
let recovery: Recovery | null = null;

function RecoveryProbe() {
  recovery = useRecovery();
  return null;
}

function current(): Recovery {
  if (recovery === null) throw new Error("Recovery hook has not rendered.");
  return recovery;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function renderHook() {
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
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("Recovery hook test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(RecoveryProbe));
    await Promise.resolve();
  });
  return { close: async () => act(async () => root.unmount()) };
}

beforeEach(() => {
  recovery = null;
  bridge.writeRecoveryKey.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useRecovery", () => {
  it("marks creation busy then replaces a fabricated old code with the new recovery key", async () => {
    const pending = deferred<string>();
    bridge.writeRecoveryKey.mockReturnValueOnce(pending.promise);
    const view = await renderHook();
    await act(async () => {
      current().setRecoveryCode("old-fabricated-code");
      current().setRecoveryCopied(true);
    });
    let creating: Promise<void> | null = null;

    await act(async () => {
      creating = current().createRecoveryKey();
      await Promise.resolve();
    });
    expect(current().recoveryBusy).toBe(true);
    expect(current().recoveryCode).toBe("old-fabricated-code");

    await act(async () => {
      pending.resolve("new-fabricated-code");
      await creating;
    });
    expect(bridge.writeRecoveryKey).toHaveBeenCalledOnce();
    expect(current()).toMatchObject({
      recoveryBusy: false,
      recoveryCode: "new-fabricated-code",
      recoveryCopied: false,
      recoveryErr: "",
    });
    await view.close();
  });

  it("keeps the existing fabricated code and exposes a recovery-key failure", async () => {
    bridge.writeRecoveryKey.mockRejectedValueOnce(new Error("fabricated recovery write failure"));
    const view = await renderHook();
    await act(async () => {
      current().setRecoveryCode("old-fabricated-code");
      current().setRecoveryCopied(true);
      await current().createRecoveryKey();
    });

    expect(current()).toMatchObject({
      recoveryBusy: false,
      recoveryCode: "old-fabricated-code",
      recoveryCopied: true,
      recoveryErr: "Error: fabricated recovery write failure",
    });
    await view.close();
  });

  it("surfaces a fabricated cancellation value and clears busy state", async () => {
    bridge.writeRecoveryKey.mockRejectedValueOnce("fabricated cancellation");
    const view = await renderHook();

    await act(async () => {
      await current().createRecoveryKey();
    });

    expect(current().recoveryBusy).toBe(false);
    expect(current().recoveryErr).toBe("fabricated cancellation");
    await view.close();
  });
});
