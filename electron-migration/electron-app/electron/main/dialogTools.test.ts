/**
 * Tests for `dialogTools.ts` — the three `arcelle.dialog` handlers, driven
 * against a fake `Electron.dialog` (the module never imports the real one; see
 * its own doc's injected-primitive convention).
 *
 * The sharpest test in this file is `resolveMessageButtons`'s LABEL-vs-RESULT
 * split: `preload/index.ts`'s `confirm()` resolves `result === okLabel` with
 * `okLabel` defaulting to `"Ok"`, so a handler that answered with the button's
 * displayed label (`"OK"`) would make every un-customized confirm in the app
 * return false — a delete prompt the user accepts and nothing happens. That is
 * not hypothetical: one of this batch's two merge candidates shipped exactly
 * that, with a green test suite of its own that only ever exercised custom
 * labels and `YesNo` (where the two spellings happen to coincide).
 */

import { describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  dialogMessage,
  dialogOpen,
  dialogSave,
  registerDialogIpc,
  resolveMessageButtons,
  type DialogDeps,
  type DialogWindowLike,
} from "./dialogTools.js";

// ---------------------------------------------------------------- fakes ----

interface FakeDialogResults {
  open?: { canceled: boolean; filePaths: string[] };
  save?: { canceled: boolean; filePath: string };
  message?: { response: number; checkboxChecked: boolean };
}

/** A window is a bare token here: `dialogTools.ts` reads nothing off it, it
 * only forwards it to Electron's parent-window overload. */
const FAKE_WINDOW = { id: "the-main-window" } as unknown as DialogWindowLike;

function fakeDeps(
  results?: FakeDialogResults,
  window: DialogWindowLike | null = FAKE_WINDOW
): DialogDeps & {
  showOpenDialog: ReturnType<typeof vi.fn>;
  showSaveDialog: ReturnType<typeof vi.fn>;
  showMessageBox: ReturnType<typeof vi.fn>;
} {
  const showOpenDialog = vi.fn(() =>
    Promise.resolve(results?.open ?? { canceled: false, filePaths: ["/tmp/one.txt"] })
  );
  const showSaveDialog = vi.fn(() =>
    Promise.resolve(results?.save ?? { canceled: false, filePath: "/tmp/out.txt" })
  );
  const showMessageBox = vi.fn(() =>
    Promise.resolve(results?.message ?? { response: 0, checkboxChecked: false })
  );
  return {
    dialog: { showOpenDialog, showSaveDialog, showMessageBox } as unknown as DialogDeps["dialog"],
    getMainWindow: () => window,
    showOpenDialog,
    showSaveDialog,
    showMessageBox,
  };
}

/** The options object a fake `showX` was called with, whichever overload was
 * used. */
function optionsOf(fn: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const args = (fn.mock.calls[call] ?? []) as unknown[];
  return (args.length === 1 ? args[0] : args[1]) as Record<string, unknown>;
}

const fakeEvent = {} as IpcMainInvokeEvent;

function fakeIpcMain(): {
  ipcMain: Pick<IpcMain, "handle">;
  handlers: Map<string, (event: IpcMainInvokeEvent, args?: unknown) => unknown>;
} {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, args?: unknown) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
        handlers.set(channel, listener as (event: IpcMainInvokeEvent, args?: unknown) => unknown);
      },
    } as Pick<IpcMain, "handle">,
  };
}

// ---------------------------------------------------------------- tests ----

describe("resolveMessageButtons", () => {
  it("defaults to one OK button answering with the plugin's 'Ok' token", () => {
    const r = resolveMessageButtons(undefined);
    expect(r.labels).toEqual(["OK"]);
    expect(r.defaultId).toBe(0);
    expect(r.cancelId).toBe(0);
    expect(r.resultFor(0)).toBe("Ok");
  });

  it("'Ok' behaves identically to no buttons at all", () => {
    const r = resolveMessageButtons("Ok");
    expect(r.labels).toEqual(["OK"]);
    expect(r.resultFor(0)).toBe("Ok");
  });

  it("THE LABEL AND THE RESULT ARE NOT THE SAME STRING for the OkCancel preset", () => {
    // The regression guard named in this file's header. macOS spells the button
    // "OK"; the plugin's result token is "Ok"; `confirm()` compares against the
    // token. Answering with the label makes every plain `confirm(...)` false.
    const r = resolveMessageButtons("OkCancel");
    expect(r.labels).toEqual(["OK", "Cancel"]);
    expect(r.resultFor(0)).toBe("Ok");
    expect(r.resultFor(0)).not.toBe(r.labels[0]);
    expect(r.resultFor(1)).toBe("Cancel");
    expect(r.cancelId).toBe(1);
  });

  it("'YesNo' — index 0 is Yes, index 1 is No, Esc dismisses as No", () => {
    const r = resolveMessageButtons("YesNo");
    expect(r.labels).toEqual(["Yes", "No"]);
    expect(r.resultFor(0)).toBe("Yes");
    expect(r.resultFor(1)).toBe("No");
    expect(r.cancelId).toBe(1);
  });

  it("'YesNoCancel' — three buttons, Esc dismisses as the LAST one", () => {
    const r = resolveMessageButtons("YesNoCancel");
    expect(r.labels).toEqual(["Yes", "No", "Cancel"]);
    expect([r.resultFor(0), r.resultFor(1), r.resultFor(2)]).toEqual(["Yes", "No", "Cancel"]);
    expect(r.cancelId).toBe(2);
  });

  it("a custom {yes,no,cancel} answers with the caller's own labels", () => {
    const r = resolveMessageButtons({ yes: "Keep", no: "Drop", cancel: "Wait" });
    expect(r.labels).toEqual(["Keep", "Drop", "Wait"]);
    expect([r.resultFor(0), r.resultFor(1), r.resultFor(2)]).toEqual(["Keep", "Drop", "Wait"]);
    expect(r.cancelId).toBe(2);
  });

  it("a custom {ok,cancel}", () => {
    const r = resolveMessageButtons({ ok: "Quit and discard", cancel: "Stay" });
    expect(r.labels).toEqual(["Quit and discard", "Stay"]);
    expect(r.resultFor(0)).toBe("Quit and discard");
    expect(r.cancelId).toBe(1);
  });

  it("a custom {ok} — one button, its own label as the answer", () => {
    const r = resolveMessageButtons({ ok: "Got it" });
    expect(r.labels).toEqual(["Got it"]);
    expect(r.resultFor(0)).toBe("Got it");
    expect(r.cancelId).toBe(0);
  });
});

describe("dialogOpen", () => {
  it("attaches to the main window when there is one", async () => {
    const deps = fakeDeps();
    await dialogOpen(deps, { title: "Pick" });
    expect(deps.showOpenDialog.mock.calls[0]?.[0]).toBe(FAKE_WINDOW);
    expect(optionsOf(deps.showOpenDialog).title).toBe("Pick");
  });

  it("shows unattached when there is no window (start screen, password gate)", async () => {
    const deps = fakeDeps(undefined, null);
    await dialogOpen(deps, {});
    expect(deps.showOpenDialog.mock.calls[0]?.length).toBe(1);
  });

  it("returns null on cancel", async () => {
    const deps = fakeDeps({ open: { canceled: true, filePaths: [] } });
    expect(await dialogOpen(deps, {})).toBeNull();
  });

  it("returns null on an empty selection even when canceled is false", async () => {
    const deps = fakeDeps({ open: { canceled: false, filePaths: [] } });
    expect(await dialogOpen(deps, {})).toBeNull();
    expect(await dialogOpen(deps, { multiple: true })).toBeNull();
  });

  it("returns ONE path without multiple, the whole array with it", async () => {
    const deps = fakeDeps({ open: { canceled: false, filePaths: ["/a", "/b"] } });
    expect(await dialogOpen(deps, {})).toBe("/a");
    expect(await dialogOpen(deps, { multiple: true })).toEqual(["/a", "/b"]);
  });

  it("multiple adds multiSelections; directory swaps openFile for openDirectory", async () => {
    const deps = fakeDeps();
    await dialogOpen(deps, { multiple: true, directory: true });
    expect(optionsOf(deps.showOpenDialog).properties).toEqual([
      "openDirectory",
      "multiSelections",
      "createDirectory",
    ]);
  });

  it("createDirectory is on by default (the plugin's own default) and off only when explicitly false", async () => {
    const deps = fakeDeps();
    await dialogOpen(deps, {});
    expect(optionsOf(deps.showOpenDialog, 0).properties).toEqual(["openFile", "createDirectory"]);
    await dialogOpen(deps, { canCreateDirectories: false });
    expect(optionsOf(deps.showOpenDialog, 1).properties).toEqual(["openFile"]);
  });

  it("forwards filters and defaultPath untouched", async () => {
    const deps = fakeDeps();
    const filters = [{ name: "Image", extensions: ["png", "jpeg"] }];
    await dialogOpen(deps, { filters, defaultPath: "/tmp" });
    expect(optionsOf(deps.showOpenDialog).filters).toEqual(filters);
    expect(optionsOf(deps.showOpenDialog).defaultPath).toBe("/tmp");
  });
});

describe("dialogSave", () => {
  it("returns the chosen path", async () => {
    expect(await dialogSave(fakeDeps(), {})).toBe("/tmp/out.txt");
  });

  it("returns null on cancel, and on an empty filePath even when canceled is false", async () => {
    expect(await dialogSave(fakeDeps({ save: { canceled: true, filePath: "" } }), {})).toBeNull();
    expect(await dialogSave(fakeDeps({ save: { canceled: false, filePath: "" } }), {})).toBeNull();
  });

  it("createDirectory on by default, dropped when explicitly disabled", async () => {
    const deps = fakeDeps();
    await dialogSave(deps, {});
    expect(optionsOf(deps.showSaveDialog, 0).properties).toEqual(["createDirectory"]);
    await dialogSave(deps, { canCreateDirectories: false });
    expect(optionsOf(deps.showSaveDialog, 1).properties).toEqual([]);
  });

  it("attaches to the window when there is one, and not when there isn't", async () => {
    const attached = fakeDeps();
    await dialogSave(attached, {});
    expect(attached.showSaveDialog.mock.calls[0]?.[0]).toBe(FAKE_WINDOW);

    const detached = fakeDeps(undefined, null);
    await dialogSave(detached, {});
    expect(detached.showSaveDialog.mock.calls[0]?.length).toBe(1);
  });
});

describe("dialogMessage", () => {
  it("passes message/title through and defaults kind to info", async () => {
    const deps = fakeDeps();
    await dialogMessage(deps, { message: "All done", title: "Arcelle" });
    expect(optionsOf(deps.showMessageBox)).toMatchObject({
      message: "All done",
      title: "Arcelle",
      type: "info",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it("kind maps straight onto Electron's own type", async () => {
    const deps = fakeDeps();
    await dialogMessage(deps, { message: "Careful", kind: "warning" });
    expect(optionsOf(deps.showMessageBox).type).toBe("warning");
  });

  it("answers with the plugin's result token for the button that was pressed", async () => {
    expect(
      await dialogMessage(fakeDeps({ message: { response: 0, checkboxChecked: false } }), {
        message: "?",
        buttons: "OkCancel",
      })
    ).toBe("Ok");
    expect(
      await dialogMessage(fakeDeps({ message: { response: 1, checkboxChecked: false } }), {
        message: "?",
        buttons: "OkCancel",
      })
    ).toBe("Cancel");
    expect(
      await dialogMessage(fakeDeps({ message: { response: 1, checkboxChecked: false } }), {
        message: "?",
        buttons: { ok: "Replace", cancel: "Keep both" },
      })
    ).toBe("Keep both");
  });
});

describe("registerDialogIpc", () => {
  it("registers exactly the three dialog channels", () => {
    const { ipcMain, handlers } = fakeIpcMain();
    registerDialogIpc(ipcMain, fakeDeps());
    expect([...handlers.keys()].sort()).toEqual(["dialog_message", "dialog_open", "dialog_save"]);
  });

  it("dialog_message REFUSES a payload with no message, never popping an empty dialog", () => {
    // Decided failure behavior: refuse, never coerce. A modal with no content
    // is worse than a rejected promise at the call site that sent it.
    const { ipcMain, handlers } = fakeIpcMain();
    const deps = fakeDeps();
    registerDialogIpc(ipcMain, deps);
    expect(() => handlers.get("dialog_message")!(fakeEvent, {})).toThrow("needs a string");
    expect(() => handlers.get("dialog_message")!(fakeEvent, { message: 7 })).toThrow(
      "needs a string"
    );
    expect(() => handlers.get("dialog_message")!(fakeEvent, undefined)).toThrow("needs a string");
    expect(deps.showMessageBox).not.toHaveBeenCalled();
  });

  it("a wrong-shaped buttons value falls back to the Ok default rather than reaching Electron", async () => {
    // `buttons` is renderer-supplied, and the contract's types are gone at
    // runtime. `{ok: 42}` cast straight through would hand `showMessageBox` a
    // non-string button.
    const { ipcMain, handlers } = fakeIpcMain();
    const deps = fakeDeps();
    registerDialogIpc(ipcMain, deps);
    await handlers.get("dialog_message")!(fakeEvent, { message: "hi", buttons: { ok: 42 } });
    expect(optionsOf(deps.showMessageBox).buttons).toEqual(["OK"]);
  });

  it("a wrong-shaped filter entry is dropped rather than handed to a native panel", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const deps = fakeDeps();
    registerDialogIpc(ipcMain, deps);
    await handlers.get("dialog_open")!(fakeEvent, {
      filters: [{ name: "Good", extensions: ["png", 7] }, { name: "No extensions" }, "nonsense"],
    });
    expect(optionsOf(deps.showOpenDialog).filters).toEqual([{ name: "Good", extensions: ["png"] }]);
  });

  it("dialog_open and dialog_save tolerate a missing args object entirely", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const deps = fakeDeps();
    registerDialogIpc(ipcMain, deps);
    expect(await handlers.get("dialog_open")!(fakeEvent, undefined)).toBe("/tmp/one.txt");
    expect(await handlers.get("dialog_save")!(fakeEvent, null)).toBe("/tmp/out.txt");
  });

  it("registered handlers really reach the injected dialog module", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const deps = fakeDeps();
    registerDialogIpc(ipcMain, deps);
    await handlers.get("dialog_open")!(fakeEvent, { multiple: true });
    await handlers.get("dialog_save")!(fakeEvent, {});
    await handlers.get("dialog_message")!(fakeEvent, { message: "hi" });
    expect(deps.showOpenDialog).toHaveBeenCalledOnce();
    expect(deps.showSaveDialog).toHaveBeenCalledOnce();
    expect(deps.showMessageBox).toHaveBeenCalledOnce();
  });
});
