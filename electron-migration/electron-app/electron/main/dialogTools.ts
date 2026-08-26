/**
 * `arcelle.dialog` — the real handlers behind `dialog_open` / `dialog_save` /
 * `dialog_message`, over Electron's own `dialog` module.
 *
 * The renderer-facing surface these three back is `preload/index.ts`'s
 * `arcelle.dialog`, which reproduces `@tauri-apps/plugin-dialog`'s five JS
 * functions (`open`/`save`/`message`/`ask`/`confirm`) so a frontend port
 * changes an import rather than a call shape. `ask` and `confirm` are NOT
 * channels of their own — they are client-side sugar over `dialog_message` in
 * the real plugin (`index.js`'s `ask()`/`confirm()` both call the one
 * `messageCommand`) and client-side sugar over it here, for the same reason.
 *
 * Same "accept the Electron primitive as an injected, typed-but-never-imported-
 * at-runtime PARAMETER" convention every `registerXIpc` module in this tree
 * uses for `IpcMain` (`recIpc.ts`, `sttTools.ts`, …) and `index.ts` uses for
 * the whole `BootstrapElectron`: {@link DialogDeps.dialog} is typed against the
 * real `Electron.Dialog`, narrowed with `Pick` to exactly the three methods
 * called, so this file resolves under plain vitest/Node with no Electron
 * process and a test drives it with a plain object of `vi.fn()`s.
 *
 * ============================================================================
 * THE BUTTON TABLE IS A PORT, NOT AN INVENTION
 * ============================================================================
 * The real plugin describes a button set as a Rust-serde tagged union
 * (`buttonsToRust()` → `'YesNo'` | `{OkCancelCustom: [ok, cancel]}` | …) and
 * gets back a `MessageDialogResult`: one of `'Yes' | 'No' | 'Ok' | 'Cancel'`
 * for a preset set, or the clicked button's own label for a custom one.
 * Electron describes the same thing as `buttons: string[]` + `defaultId` +
 * `cancelId`, and answers with a `response` INDEX.
 * {@link resolveMessageButtons} is the whole translation, and it keeps the two
 * halves separate on purpose:
 *
 *   - `labels` is what the user SEES (`"OK"`, macOS's own capitalization);
 *   - `resultFor(index)` is what the caller is TOLD (`"Ok"`, the plugin's
 *     result token).
 *
 * Collapsing those two into one — answering with the clicked label directly —
 * type-checks, shows an identical dialog, and silently breaks `confirm()`:
 * its whole contract is `result === okLabel` with `okLabel` defaulting to
 * `"Ok"`, so a handler answering `"OK"` makes every un-customized confirm
 * return `false` no matter which button the user pressed. (Found in one of this
 * batch's two merge candidates, which shipped exactly that; `confirm` is what
 * six real frontend call sites use to guard a delete.) `resolveMessageButtons`
 * is exported so that table is pinned directly by tests rather than only
 * through a `showMessageBox` round trip.
 *
 * ============================================================================
 * FIELDS DROPPED FROM THE REAL OPTIONS TYPES
 * ============================================================================
 * `recursive`, `pickerMode`, `fileAccessMode` — see `ipc-contract.ts`'s own
 * note: the plugin documents all three as mobile-only, this app is Mac-only,
 * and Electron's dialogs have no counterpart for any of them.
 * `canCreateDirectories` (real, macOS-only, on by default in the plugin) maps
 * onto Electron's `properties: ['createDirectory']`, the one option both
 * `OpenDialogOptions` and `SaveDialogOptions` carry for exactly this.
 */

import type {
  BaseWindow,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  OpenDialogOptions as ElectronOpenDialogOptions,
  SaveDialogOptions as ElectronSaveDialogOptions,
} from "electron";
import type {
  Commands,
  MessageDialogButtons,
  MessageDialogKind,
  MessageDialogResult,
} from "../shared/ipc-contract.js";

/** The window a dialog is attached to as a macOS sheet. `BaseWindow` (not
 * `BrowserWindow`) because that is the real `Dialog` methods' own declared
 * parameter type, and every `BrowserWindow` already is one. Deliberately NOT
 * reusing `menu.ts`'s `MainWindowLike`: that seam exists to send on
 * `webContents`, this one exists to be handed to Electron as a parent, and one
 * type that happens to fit both today would tie two unrelated things
 * together. */
export type DialogWindowLike = BaseWindow;

export interface DialogDeps {
  /** Electron's real `dialog`, narrowed to what this file calls. Both overloads
   * of each method (with and without a parent window) come along with the
   * `Pick`, so neither shape is re-declared here. */
  dialog: Pick<Dialog, "showOpenDialog" | "showSaveDialog" | "showMessageBox">;
  /** The app's one main window, or `null`/`undefined` when there is none (very
   * early boot, or after the window is gone). A dialog is then shown
   * UNATTACHED rather than refused — the same thing a native menu row would do
   * with no document window focused. */
  getMainWindow: () => DialogWindowLike | null | undefined;
}

// ============================================================================
// dialog_message's button table
// ============================================================================

export interface ResolvedButtons {
  /** What Electron renders, in order. */
  labels: string[];
  defaultId: number;
  /** The button Electron treats as "dismissed" (Esc, the window's close
   * control) — the LAST one in every shape below, which is where Cancel/No sits
   * in each of the plugin's own orderings. */
  cancelId: number;
  /** Electron's `response` index → the plugin's `MessageDialogResult` for that
   * button. */
  resultFor(index: number): MessageDialogResult;
}

/**
 * The plugin's five button shapes, as Electron labels plus the result token
 * each index answers with. See the module doc for why `labels` and `resultFor`
 * are not the same list.
 */
export function resolveMessageButtons(buttons: MessageDialogButtons | undefined): ResolvedButtons {
  if (buttons === undefined || buttons === "Ok") {
    return { labels: ["OK"], defaultId: 0, cancelId: 0, resultFor: () => "Ok" };
  }
  if (buttons === "OkCancel") {
    return {
      labels: ["OK", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      resultFor: (i) => (i === 0 ? "Ok" : "Cancel"),
    };
  }
  if (buttons === "YesNo") {
    return {
      labels: ["Yes", "No"],
      defaultId: 0,
      cancelId: 1,
      resultFor: (i) => (i === 0 ? "Yes" : "No"),
    };
  }
  if (buttons === "YesNoCancel") {
    return {
      labels: ["Yes", "No", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      resultFor: (i) => (i === 0 ? "Yes" : i === 1 ? "No" : "Cancel"),
    };
  }
  if ("yes" in buttons) {
    const { yes, no, cancel } = buttons;
    return {
      labels: [yes, no, cancel],
      defaultId: 0,
      cancelId: 2,
      resultFor: (i) => (i === 0 ? yes : i === 1 ? no : cancel),
    };
  }
  if ("cancel" in buttons) {
    const { ok, cancel } = buttons;
    return {
      labels: [ok, cancel],
      defaultId: 0,
      cancelId: 1,
      resultFor: (i) => (i === 0 ? ok : cancel),
    };
  }
  const { ok } = buttons;
  return { labels: [ok], defaultId: 0, cancelId: 0, resultFor: () => ok };
}

// ============================================================================
// The three handlers, as plain exported functions
// ============================================================================
//
// Exported (rather than living inside the `ipcMain.handle` closures) so every
// branch is driven directly by `dialogTools.test.ts` — the same shape
// `shellTools.ts` uses, and the reason neither file needs a fake `ipcMain` to
// test its actual behavior.

export async function dialogOpen(
  deps: DialogDeps,
  args: Commands["dialog_open"]["args"]
): Promise<Commands["dialog_open"]["result"]> {
  const properties: NonNullable<ElectronOpenDialogOptions["properties"]> = [
    args.directory === true ? "openDirectory" : "openFile",
  ];
  if (args.room === true && !properties.includes("openDirectory")) properties.push("openDirectory");
  if (args.multiple === true) {
    properties.push("multiSelections");
  }
  if (args.canCreateDirectories !== false) {
    properties.push("createDirectory");
  }
  const options: ElectronOpenDialogOptions = {
    title: args.title,
    defaultPath: args.defaultPath,
    filters: args.filters,
    properties,
  };
  const win = deps.getMainWindow();
  const result = win
    ? await deps.dialog.showOpenDialog(win, options)
    : await deps.dialog.showOpenDialog(options);
  // `canceled` is Electron's own answer; the empty-list check is the same
  // answer arrived at a second way, and matters because a `multiple` open that
  // came back with nothing selected must not resolve to an empty array a
  // caller would read as "the user picked zero files on purpose".
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return args.multiple === true ? result.filePaths : (result.filePaths[0] ?? null);
}

export async function dialogSave(
  deps: DialogDeps,
  args: Commands["dialog_save"]["args"]
): Promise<Commands["dialog_save"]["result"]> {
  const options: ElectronSaveDialogOptions = {
    title: args.title,
    defaultPath: args.defaultPath,
    filters: args.filters,
    properties: args.canCreateDirectories === false ? [] : ["createDirectory"],
  };
  const win = deps.getMainWindow();
  const result = win
    ? await deps.dialog.showSaveDialog(win, options)
    : await deps.dialog.showSaveDialog(options);
  return result.canceled || result.filePath === "" ? null : result.filePath;
}

export async function dialogMessage(
  deps: DialogDeps,
  args: Commands["dialog_message"]["args"]
): Promise<Commands["dialog_message"]["result"]> {
  const resolved = resolveMessageButtons(args.buttons);
  const options: MessageBoxOptions = {
    message: args.message,
    title: args.title,
    type: args.kind ?? "info",
    buttons: resolved.labels,
    defaultId: resolved.defaultId,
    cancelId: resolved.cancelId,
  };
  const win = deps.getMainWindow();
  const { response } = win
    ? await deps.dialog.showMessageBox(win, options)
    : await deps.dialog.showMessageBox(options);
  return resolved.resultFor(response);
}

// ============================================================================
// registerDialogIpc
// ============================================================================

/**
 * DECIDED FAILURE BEHAVIOUR for a malformed payload: REFUSE, never coerce —
 * the same call this registry already makes for `set_unsaved_edits`. IPC args
 * are renderer-supplied data, and the contract's types vanish at runtime; a
 * `dialog_message` with a missing `message` reaching `showMessageBox` pops a
 * real, modal, empty dialog at the user, which is worse in every way than a
 * rejected promise at the call site that sent it.
 */
export function registerDialogIpc(ipcMain: Pick<IpcMain, "handle">, deps: DialogDeps): void {
  ipcMain.handle("dialog_open", (_event: IpcMainInvokeEvent, args: unknown) =>
    dialogOpen(deps, readOpenArgs(args))
  );

  ipcMain.handle("dialog_save", (_event: IpcMainInvokeEvent, args: unknown) =>
    dialogSave(deps, readSaveArgs(args))
  );

  ipcMain.handle("dialog_message", (_event: IpcMainInvokeEvent, args: unknown) => {
    const raw = asRecord(args);
    if (typeof raw.message !== "string") {
      throw new Error("dialog_message needs a string `message`.");
    }
    return dialogMessage(deps, {
      message: raw.message,
      title: typeof raw.title === "string" ? raw.title : undefined,
      kind: readKind(raw.kind),
      buttons: readButtons(raw.buttons),
    });
  });
}

/** `args` as a plain property bag, with no prototype-chain surprises: reading
 * `raw.message` off `null`/a string/a number would throw or lie. Never indexed
 * with an externally-controlled key — every read below is a fixed literal. */
function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

function readKind(kind: unknown): MessageDialogKind | undefined {
  return kind === "info" || kind === "warning" || kind === "error" ? kind : undefined;
}

/** The plugin's `buttons` union, validated rather than cast: an unrecognized
 * value becomes `undefined`, which {@link resolveMessageButtons} already reads
 * as the `Ok` default. A cast would let `{ok: 42}` through to Electron, whose
 * `buttons` must be strings. */
function readButtons(buttons: unknown): MessageDialogButtons | undefined {
  if (
    buttons === "Ok" ||
    buttons === "OkCancel" ||
    buttons === "YesNo" ||
    buttons === "YesNoCancel"
  ) {
    return buttons;
  }
  if (typeof buttons !== "object" || buttons === null) {
    return undefined;
  }
  const b = buttons as Record<string, unknown>;
  if (typeof b.yes === "string" && typeof b.no === "string" && typeof b.cancel === "string") {
    return { yes: b.yes, no: b.no, cancel: b.cancel };
  }
  if (typeof b.ok === "string" && typeof b.cancel === "string") {
    return { ok: b.ok, cancel: b.cancel };
  }
  if (typeof b.ok === "string") {
    return { ok: b.ok };
  }
  return undefined;
}

/** `DialogFilter[]`, validated the same way — a filter whose `extensions` is
 * not an array of strings is dropped rather than handed to a native panel. */
function readFilters(filters: unknown): Commands["dialog_open"]["args"]["filters"] {
  if (!Array.isArray(filters)) {
    return undefined;
  }
  const out: NonNullable<Commands["dialog_open"]["args"]["filters"]> = [];
  for (const entry of filters) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const f = entry as Record<string, unknown>;
    if (typeof f.name !== "string" || !Array.isArray(f.extensions)) {
      continue;
    }
    const extensions = f.extensions.filter((e): e is string => typeof e === "string");
    out.push({ name: f.name, extensions });
  }
  return out.length === 0 ? undefined : out;
}

function readOpenArgs(args: unknown): Commands["dialog_open"]["args"] {
  const raw = asRecord(args);
  return {
    title: typeof raw.title === "string" ? raw.title : undefined,
    defaultPath: typeof raw.defaultPath === "string" ? raw.defaultPath : undefined,
    filters: readFilters(raw.filters),
    multiple: raw.multiple === true,
    directory: raw.directory === true,
    // The plugin's own default is `true`, so only an explicit `false` counts.
    canCreateDirectories: raw.canCreateDirectories !== false,
  };
}

function readSaveArgs(args: unknown): Commands["dialog_save"]["args"] {
  const raw = asRecord(args);
  return {
    title: typeof raw.title === "string" ? raw.title : undefined,
    defaultPath: typeof raw.defaultPath === "string" ? raw.defaultPath : undefined,
    filters: readFilters(raw.filters),
    canCreateDirectories: raw.canCreateDirectories !== false,
  };
}
