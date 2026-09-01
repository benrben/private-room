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
function oneButton(label: string, result: MessageDialogResult): ResolvedButtons {
  return { labels: [label], defaultId: 0, cancelId: 0, resultFor: () => result };
}

function twoButtons(
  labels: [string, string],
  results: [MessageDialogResult, MessageDialogResult],
): ResolvedButtons {
  return {
    labels,
    defaultId: 0,
    cancelId: 1,
    resultFor: (index) => (index === 0 ? results[0] : results[1]),
  };
}

function threeButtons(
  labels: [string, string, string],
  results: [MessageDialogResult, MessageDialogResult, MessageDialogResult],
): ResolvedButtons {
  return {
    labels,
    defaultId: 0,
    cancelId: 2,
    resultFor: (index) => (index === 0 ? results[0] : index === 1 ? results[1] : results[2]),
  };
}

function presetButtons(buttons: MessageDialogButtons | undefined): ResolvedButtons | undefined {
  switch (buttons) {
    case undefined:
    case "Ok":
      return oneButton("OK", "Ok");
    case "OkCancel":
      return twoButtons(["OK", "Cancel"], ["Ok", "Cancel"]);
    case "YesNo":
      return twoButtons(["Yes", "No"], ["Yes", "No"]);
    case "YesNoCancel":
      return threeButtons(["Yes", "No", "Cancel"], ["Yes", "No", "Cancel"]);
    default:
      return undefined;
  }
}

function resolveCustomButtons(buttons: Exclude<MessageDialogButtons, string>): ResolvedButtons {
  if ("yes" in buttons) {
    return threeButtons([buttons.yes, buttons.no, buttons.cancel], [buttons.yes, buttons.no, buttons.cancel]);
  }
  if ("cancel" in buttons) {
    return twoButtons([buttons.ok, buttons.cancel], [buttons.ok, buttons.cancel]);
  }
  return oneButton(buttons.ok, buttons.ok);
}

export function resolveMessageButtons(buttons: MessageDialogButtons | undefined): ResolvedButtons {
  const preset = presetButtons(buttons);
  if (preset !== undefined) return preset;
  return resolveCustomButtons(buttons as Exclude<MessageDialogButtons, string>);
}

// ============================================================================
// The three handlers, as plain exported functions
// ============================================================================
//
// Exported (rather than living inside the `ipcMain.handle` closures) so every
// branch is driven directly by `dialogTools.test.ts` — the same shape
// `shellTools.ts` uses, and the reason neither file needs a fake `ipcMain` to
// test its actual behavior.

function openProperties(
  args: Commands["dialog_open"]["args"],
): NonNullable<ElectronOpenDialogOptions["properties"]> {
  const properties: NonNullable<ElectronOpenDialogOptions["properties"]> = [
    args.directory === true ? "openDirectory" : "openFile",
  ];
  if (args.room === true && !properties.includes("openDirectory")) properties.push("openDirectory");
  if (args.multiple === true) properties.push("multiSelections");
  if (args.canCreateDirectories !== false) properties.push("createDirectory");
  return properties;
}

function openDialogOptions(args: Commands["dialog_open"]["args"]): ElectronOpenDialogOptions {
  return {
    title: args.title,
    defaultPath: args.defaultPath,
    message: args.message,
    buttonLabel: args.buttonLabel,
    filters: args.filters,
    properties: openProperties(args),
  };
}

interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

async function showOpenDialog(
  deps: DialogDeps,
  options: ElectronOpenDialogOptions,
): Promise<OpenDialogResult> {
  const win = deps.getMainWindow();
  if (win) return deps.dialog.showOpenDialog(win, options);
  return deps.dialog.showOpenDialog(options);
}

function selectedOpenPath(
  result: OpenDialogResult,
  multiple: boolean | undefined,
): Commands["dialog_open"]["result"] {
  // `canceled` is Electron's own answer; the empty-list check is the same
  // answer arrived at a second way, and matters because a `multiple` open that
  // came back with nothing selected must not resolve to an empty array a
  // caller would read as "the user picked zero files on purpose".
  if (result.canceled || result.filePaths.length === 0) return null;
  return multiple === true ? result.filePaths : (result.filePaths[0] ?? null);
}

export async function dialogOpen(
  deps: DialogDeps,
  args: Commands["dialog_open"]["args"]
): Promise<Commands["dialog_open"]["result"]> {
  const result = await showOpenDialog(deps, openDialogOptions(args));
  return selectedOpenPath(result, args.multiple);
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
function presetButtonValue(buttons: unknown): MessageDialogButtons | undefined {
  switch (buttons) {
    case "Ok":
    case "OkCancel":
    case "YesNo":
    case "YesNoCancel":
      return buttons;
    default:
      return undefined;
  }
}

function buttonRecord(buttons: unknown): Record<string, unknown> | undefined {
  return typeof buttons === "object" && buttons !== null ? buttons as Record<string, unknown> : undefined;
}

function threeCustomButtons(buttons: Record<string, unknown>): MessageDialogButtons | undefined {
  if (typeof buttons.yes !== "string" || typeof buttons.no !== "string" || typeof buttons.cancel !== "string") {
    return undefined;
  }
  return { yes: buttons.yes, no: buttons.no, cancel: buttons.cancel };
}

function okCancelCustomButtons(buttons: Record<string, unknown>): MessageDialogButtons | undefined {
  if (typeof buttons.ok !== "string" || typeof buttons.cancel !== "string") return undefined;
  return { ok: buttons.ok, cancel: buttons.cancel };
}

function oneCustomButton(buttons: Record<string, unknown>): MessageDialogButtons | undefined {
  return typeof buttons.ok === "string" ? { ok: buttons.ok } : undefined;
}

function readCustomButtons(buttons: Record<string, unknown>): MessageDialogButtons | undefined {
  return threeCustomButtons(buttons)
    ?? okCancelCustomButtons(buttons)
    ?? oneCustomButton(buttons);
}

function readButtons(buttons: unknown): MessageDialogButtons | undefined {
  const preset = presetButtonValue(buttons);
  if (preset !== undefined) return preset;
  const custom = buttonRecord(buttons);
  return custom === undefined ? undefined : readCustomButtons(custom);
}

/** `DialogFilter[]`, validated the same way — a filter whose `extensions` is
 * not an array of strings is dropped rather than handed to a native panel. */
type DialogFilters = NonNullable<Commands["dialog_open"]["args"]["filters"]>;
type DialogFilter = DialogFilters[number];

function readFilter(entry: unknown): DialogFilter | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const filter = entry as Record<string, unknown>;
  if (typeof filter.name !== "string" || !Array.isArray(filter.extensions)) return undefined;
  return {
    name: filter.name,
    extensions: filter.extensions.filter((extension): extension is string => typeof extension === "string"),
  };
}

function definedFilter(filter: DialogFilter | undefined): filter is DialogFilter {
  return filter !== undefined;
}

function readFilters(filters: unknown): Commands["dialog_open"]["args"]["filters"] {
  if (!Array.isArray(filters)) return undefined;
  const valid = filters.map(readFilter).filter(definedFilter);
  return valid.length === 0 ? undefined : valid;
}

function readOpenArgs(args: unknown): Commands["dialog_open"]["args"] {
  const raw = asRecord(args);
  return {
    title: typeof raw.title === "string" ? raw.title : undefined,
    defaultPath: typeof raw.defaultPath === "string" ? raw.defaultPath : undefined,
    message: typeof raw.message === "string" ? raw.message : undefined,
    buttonLabel: typeof raw.buttonLabel === "string" ? raw.buttonLabel : undefined,
    filters: readFilters(raw.filters),
    multiple: raw.multiple === true,
    directory: raw.directory === true,
    room: raw.room === true,
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
