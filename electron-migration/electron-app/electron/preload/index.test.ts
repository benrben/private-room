/**
 * Tests for `preload/index.ts`'s testable half — `createArcelleApi`,
 * `installArcelleBridge`, and the two channel guards — driven against fakes,
 * exactly like `recIpc.test.ts` fakes `ipcMain` rather than importing real
 * Electron. The module's real-`electron` tail (guarded by
 * `process.versions.electron`) is deliberately NOT exercised here: plain
 * vitest/Node never sets that property, so importing this file under vitest
 * never touches the real `electron` module at all. The real preload path is
 * proven instead by `electron/main/index.electron.test.ts`, which launches an
 * actual Electron process with this file as its real preload script.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createArcelleApi,
  installArcelleBridge,
  UnknownChannelError,
  type ContextBridgeLike,
  type IpcRendererLike,
} from "./index.js";
import { ALL_COMMAND_NAMES, ALL_EVENT_NAMES } from "../shared/channelAllowlist.js";

function fakeIpcRenderer(): IpcRendererLike & { calls: { invoke: unknown[][] } } {
  const calls = { invoke: [] as unknown[][] };
  return {
    calls,
    invoke: vi.fn((channel: string, args?: unknown) => {
      calls.invoke.push([channel, args]);
      return Promise.resolve({ echoed: channel });
    }) as unknown as IpcRendererLike["invoke"],
    on: vi.fn() as unknown as IpcRendererLike["on"],
    removeListener: vi.fn() as unknown as IpcRendererLike["removeListener"],
  };
}

describe("createArcelleApi.invoke", () => {
  it("forwards a known command channel to the real ipcRenderer.invoke", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    expect(await api.invoke("room_info", {})).toEqual({ echoed: "room_info" });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("room_info", {});
  });

  it("forwards every real command channel without refusing any of them", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    for (const name of ALL_COMMAND_NAMES) {
      await expect(api.invoke(name, {})).resolves.toBeDefined();
    }
    expect(ipcRenderer.calls.invoke.length).toBe(ALL_COMMAND_NAMES.length);
  });

  it("REJECTS an unknown channel rather than throwing synchronously", () => {
    // The distinction matters: a call site written as
    // `arcelle.invoke(ch, a).catch(handle)` — no await, no enclosing async —
    // catches a rejection and does NOT catch a synchronous throw. `invoke`
    // must fail exactly one way. This test would pass on a sync-throwing
    // implementation if it used `await`, so it deliberately does not.
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = api.invoke("drop_table_files", {});
    }).not.toThrow();
    expect(returned).toBeInstanceOf(Promise);
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    return expect(returned).rejects.toBeInstanceOf(UnknownChannelError);
  });

  it("refuses an unknown channel BEFORE calling ipcRenderer.invoke at all", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await expect(api.invoke("drop_table_files", {})).rejects.toThrow(UnknownChannelError);
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it("refuses prototype-pollution-shaped channel strings", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    for (const junk of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
      await expect(api.invoke(junk, {})).rejects.toThrow(UnknownChannelError);
    }
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it("refuses an EVENT channel on the invoke side", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await expect(api.invoke("ask-delta", {})).rejects.toThrow(UnknownChannelError);
  });

  it("the refusal error carries the channel name for debugging", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await expect(api.invoke("not_a_real_command", {})).rejects.toThrow('"not_a_real_command"');
  });
});

describe("createArcelleApi.on", () => {
  it("subscribes a known event channel and unwraps the payload", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    const received: unknown[] = [];
    api.on("room-files-changed", (payload) => received.push(payload));
    expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [, registeredListener] = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void,
    ];
    registeredListener({ fakeElectronEvent: true }, { some: "payload" });
    expect(received).toEqual([{ some: "payload" }]);
  });

  it("accepts every real event channel", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    for (const name of ALL_EVENT_NAMES) {
      expect(() => api.on(name, () => undefined)).not.toThrow();
    }
    expect(ipcRenderer.on).toHaveBeenCalledTimes(ALL_EVENT_NAMES.length);
  });

  it("returns an unsubscribe function that calls removeListener with the SAME listener", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    const unsubscribe = api.on("file-updated", () => undefined);
    const [, registeredListener] = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown,
    ];
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith("file-updated", registeredListener);
  });

  it("THROWS on an unknown event channel — there is no promise to reject", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    expect(() => api.on("totally-made-up-event", () => undefined)).toThrow(UnknownChannelError);
    expect(ipcRenderer.on).not.toHaveBeenCalled();
  });

  it("refuses a COMMAND channel on the on() side", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    expect(() => api.on("create_room", () => undefined)).toThrow(UnknownChannelError);
  });

  it("refuses prototype-pollution-shaped event channels", () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    for (const junk of ["__proto__", "constructor", "hasOwnProperty"]) {
      expect(() => api.on(junk, () => undefined)).toThrow(UnknownChannelError);
    }
    expect(ipcRenderer.on).not.toHaveBeenCalled();
  });
});

describe("installArcelleBridge", () => {
  it("exposes exactly one 'arcelle' key on the context bridge", () => {
    const ipcRenderer = fakeIpcRenderer();
    const exposed = new Map<string, unknown>();
    const contextBridge: ContextBridgeLike = {
      exposeInMainWorld: (key, api) => exposed.set(key, api),
    };
    installArcelleBridge(contextBridge, ipcRenderer);
    expect(exposed.size).toBe(1);
    expect(exposed.has("arcelle")).toBe(true);
    const api = exposed.get("arcelle") as { invoke: unknown; on: unknown };
    expect(typeof api.invoke).toBe("function");
    expect(typeof api.on).toBe("function");
  });

  it("the exposed api round-trips a real invoke through the fake ipcRenderer", async () => {
    const ipcRenderer = fakeIpcRenderer();
    let exposedApi: { invoke: (channel: string, args?: unknown) => Promise<unknown> } | undefined;
    const contextBridge: ContextBridgeLike = {
      exposeInMainWorld: (_key, api) => {
        exposedApi = api as typeof exposedApi;
      },
    };
    installArcelleBridge(contextBridge, ipcRenderer);
    expect(await exposedApi!.invoke("list_roles", {})).toEqual({ echoed: "list_roles" });
  });

  it("exposes the dialog and shell namespaces alongside invoke/on", () => {
    const ipcRenderer = fakeIpcRenderer();
    const exposed = new Map<string, unknown>();
    installArcelleBridge({ exposeInMainWorld: (k, a) => exposed.set(k, a) }, ipcRenderer);
    const api = exposed.get("arcelle") as {
      dialog: Record<string, unknown>;
      shell: Record<string, unknown>;
    };
    expect(Object.keys(api.dialog).sort()).toEqual([
      "ask",
      "confirm",
      "message",
      "open",
      "save",
    ]);
    expect(Object.keys(api.shell).sort()).toEqual(["openPath", "openUrl", "revealItemInDir"]);
  });
});

// ============================================================================
// arcelle.dialog — the real plugin's client-side functions, reproduced
// ============================================================================

/** An `ipcRenderer` whose `dialog_message` answers with a chosen result. */
function messageAnswering(result: string): IpcRendererLike & { calls: { invoke: unknown[][] } } {
  const fake = fakeIpcRenderer();
  fake.invoke = vi.fn((channel: string, args?: unknown) => {
    fake.calls.invoke.push([channel, args]);
    return Promise.resolve(channel === "dialog_message" ? result : { echoed: channel });
  }) as unknown as IpcRendererLike["invoke"];
  return fake;
}

describe("arcelle.dialog", () => {
  it("open/save forward their options flat, and an absent options object becomes {}", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await api.dialog.open({ multiple: true, directory: true });
    await api.dialog.save();
    expect(ipcRenderer.calls.invoke).toEqual([
      ["dialog_open", { multiple: true, directory: true }],
      ["dialog_save", {}],
    ]);
  });

  it("message accepts a bare TITLE STRING in place of options, like the real plugin", async () => {
    const ipcRenderer = messageAnswering("Ok");
    const api = createArcelleApi(ipcRenderer);
    await api.dialog.message("Tauri is awesome", "Arcelle");
    expect(ipcRenderer.calls.invoke[0]).toEqual([
      "dialog_message",
      { message: "Tauri is awesome", title: "Arcelle", kind: undefined, buttons: undefined },
    ]);
  });

  it("message passes the friendly buttons union straight through", async () => {
    const ipcRenderer = messageAnswering("Keep both");
    const api = createArcelleApi(ipcRenderer);
    const result = await api.dialog.message("Name taken", {
      kind: "warning",
      buttons: { ok: "Replace", cancel: "Keep both" },
    });
    expect(ipcRenderer.calls.invoke[0]?.[1]).toMatchObject({
      kind: "warning",
      buttons: { ok: "Replace", cancel: "Keep both" },
    });
    expect(result).toBe("Keep both");
  });

  it("ask defaults to YesNo and is true only for Yes", async () => {
    const yes = createArcelleApi(messageAnswering("Yes"));
    const no = createArcelleApi(messageAnswering("No"));
    expect(await yes.dialog.ask("Sure?")).toBe(true);
    expect(await no.dialog.ask("Sure?")).toBe(false);
  });

  it("confirm defaults to OkCancel and is true only for Ok", async () => {
    // THE regression this whole split exists for: `confirm()` compares against
    // the plugin's `"Ok"` TOKEN, while the button on screen reads "OK". A main
    // process answering with the label would make this false for a user who
    // pressed OK — and `confirm` is what guards eight real delete/discard
    // prompts in this app.
    const ipcRenderer = messageAnswering("Ok");
    const api = createArcelleApi(ipcRenderer);
    expect(await api.dialog.confirm("Delete this?")).toBe(true);
    expect(ipcRenderer.calls.invoke[0]?.[1]).toMatchObject({ buttons: "OkCancel" });
    expect(await createArcelleApi(messageAnswering("Cancel")).dialog.confirm("Delete this?")).toBe(
      false
    );
  });

  it("a custom okLabel switches to a custom button pair and is compared against", async () => {
    const ipcRenderer = messageAnswering("Quit and discard");
    const api = createArcelleApi(ipcRenderer);
    const go = await api.dialog.confirm("This file has edits you haven't saved yet.", {
      title: "Unsaved edits",
      kind: "warning",
      okLabel: "Quit and discard",
    });
    expect(go).toBe(true);
    expect(ipcRenderer.calls.invoke[0]?.[1]).toMatchObject({
      buttons: { ok: "Quit and discard", cancel: "Cancel" },
    });
  });

  it("a custom cancelLabel alone still switches to custom buttons, keeping the default ok", async () => {
    const ipcRenderer = messageAnswering("Ok");
    const api = createArcelleApi(ipcRenderer);
    await api.dialog.confirm("Update?", { cancelLabel: "Skip this version" });
    expect(ipcRenderer.calls.invoke[0]?.[1]).toMatchObject({
      buttons: { ok: "Ok", cancel: "Skip this version" },
    });
  });

  it("an EMPTY okLabel keeps the real plugin's own odd || / ?? mix, quirk and all", async () => {
    // The real `ask()` uses `||` to decide whether the buttons are custom, but
    // `??` to pick the label it compares against. With `okLabel: ""` those
    // disagree: the buttons stay the `YesNo` preset (`""` is falsy) while the
    // label compared against stays `""` (`??` does not replace an empty
    // string), so pressing Yes answers FALSE. Measured against the installed
    // plugin source, not guessed — and reproduced rather than "fixed", because
    // a port that silently improves on its original is a port nothing can be
    // checked against. No call site passes an empty label; if one ever does,
    // this test is where the decision to diverge gets made.
    const ipcRenderer = messageAnswering("Yes");
    const api = createArcelleApi(ipcRenderer);
    expect(await api.dialog.ask("Sure?", { okLabel: "" })).toBe(false);
    expect(ipcRenderer.calls.invoke[0]?.[1]).toMatchObject({ buttons: "YesNo" });
  });

  it("every dialog call goes through the SAME allowlist as invoke — no second door", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    // A sanity check on the wiring rather than on the guard itself: the sugar
    // reaches ipcRenderer only via `call`, so a channel it names that was ever
    // removed from `Commands` would reject here rather than being forwarded.
    await api.dialog.open();
    expect((ipcRenderer.calls.invoke[0] ?? [])[0]).toBe("dialog_open");
  });
});

describe("arcelle.shell", () => {
  it("openUrl/openPath send the plugin's own `with` field name", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await api.shell.openUrl("https://example.com/x", "Firefox");
    await api.shell.openPath("/tmp/movie.mkv", "VLC");
    expect(ipcRenderer.calls.invoke).toEqual([
      ["open_url", { url: "https://example.com/x", with: "Firefox" }],
      ["open_path", { path: "/tmp/movie.mkv", with: "VLC" }],
    ]);
  });

  it("revealItemInDir normalizes one path or many into the wire's { paths } shape", async () => {
    const ipcRenderer = fakeIpcRenderer();
    const api = createArcelleApi(ipcRenderer);
    await api.shell.revealItemInDir("/a/one");
    await api.shell.revealItemInDir(["/a/one", "/b/two"]);
    expect(ipcRenderer.calls.invoke).toEqual([
      ["reveal_item_in_dir", { paths: ["/a/one"] }],
      ["reveal_item_in_dir", { paths: ["/a/one", "/b/two"] }],
    ]);
  });

  it("resolves undefined rather than the raw invoke result — the plugin's void contract", async () => {
    const api = createArcelleApi(fakeIpcRenderer());
    expect(await api.shell.openUrl("https://example.com/x")).toBeUndefined();
  });
});
