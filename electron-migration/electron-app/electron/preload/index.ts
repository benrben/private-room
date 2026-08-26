/**
 * THE PRELOAD BRIDGE — the one file that runs between the isolated renderer
 * world and the real `electron` module, per D10: `contextBridge` only, no
 * `nodeIntegration`, no raw `ipcRenderer` handed to the page.
 *
 * ============================================================================
 * NAMING: `window.arcelle.invoke` / `window.arcelle.on`
 * ============================================================================
 * The migration plan is internally inconsistent about this surface — it spells
 * the event-subscribe method `on` in two places
 * (`arcelle.{invoke,on,dialog,shell,app}`) and `listen` in one (a directory
 * listing comment). This file picks ONE and says why:
 *
 *   - Namespace: `window.arcelle`. Every spelling in the plan agrees on this.
 *   - Command surface: `invoke(channel, args)` — matches Tauri's own
 *     `invoke()` that the pre-migration frontend's `api.ts` already calls, so a
 *     future renderer port of that file changes its import, not the shape of
 *     its ~296 call sites.
 *   - Event surface: `on(channel, callback)`, returning an unsubscribe
 *     function. Chosen over `listen` because (1) it is the majority spelling in
 *     the plan's own text, (2) it matches `ipcRenderer.on` — the API this
 *     wraps one layer down — and `EventEmitter#on` in Node's standard library,
 *     which every other host-side module here already assumes (`turn.ts`'s
 *     `EventSender`, `RoomManagerDeps.emit`).
 *   - `dialog`/`shell`: BUILT (see "THE TWO PLUGIN NAMESPACES" below). They
 *     were left out of the first cut of this file because "inventing their
 *     shape with no real call site to validate against would be guessing" —
 *     the call sites turned out to exist all along, in the pre-migration
 *     frontend: `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-opener` are
 *     imported by eleven files under `src/`. Their shape is READ from those
 *     plugins' installed source, not guessed.
 *   - `app`: still NOT built. The plan lists it, but the only thing the
 *     frontend ever used `@tauri-apps/plugin-process` for is `exit(0)` to
 *     finish a held quit, and that is answered by the `quit_guard_confirm`
 *     COMMAND (`quitDoor.ts`) rather than by a general-purpose "the renderer
 *     may exit the process" method. A narrower door for the one real need.
 *
 * ============================================================================
 * CHANNEL ALLOWLIST (D10: "reject unknown channels rather than blindly
 * forwarding any string the renderer sends")
 * ============================================================================
 * Both directions are validated against `electron/shared/channelAllowlist.ts`
 * — `Set`-backed checks derived from the SAME compile-checked `keyof Commands`
 * / `keyof EventPayloads` lists `electron/main/ipc/registry.ts` uses for its
 * completeness assertion, imported from shared code rather than re-declared
 * here. A channel not on the list is refused BEFORE `ipcRenderer` is ever
 * touched.
 *
 * The two refusals deliberately differ in SHAPE, because their return types
 * do:
 *   - `invoke` returns a `Promise`, so an unknown channel REJECTS. It never
 *     throws synchronously: a call site written as
 *     `arcelle.invoke(ch, a).catch(showError)` (no `await`, no enclosing
 *     `async`) would not catch a synchronous throw, and a function whose type
 *     says `Promise<unknown>` failing two different ways is the classic
 *     "release Zalgo" trap. One failure mode, always.
 *   - `on` returns an unsubscribe function, so there is no promise to reject
 *     and an unknown channel THROWS. Swallowing it would leave the caller
 *     holding a subscription that can never fire, which is worse than a loud
 *     programming error at the call site.
 *
 * ============================================================================
 * THE TWO PLUGIN NAMESPACES — `arcelle.dialog` / `arcelle.shell`
 * ============================================================================
 * `invoke`/`on` are the two primitives `api.ts` is built out of, but the
 * pre-migration frontend also calls two Tauri PLUGINS directly, as plain JS
 * imports rather than through `invoke`: `@tauri-apps/plugin-dialog`
 * (`open`/`save`/`message`/`ask`/`confirm` — 8 files) and
 * `@tauri-apps/plugin-opener` (`openUrl`/`openPath`/`revealItemInDir` — 5
 * files). Those imports have nothing to resolve to after the cutover, so this
 * bridge supplies them, deliberately mirroring the plugins' own client-side
 * function signatures — including the `options` argument that may be a bare
 * title STRING, and `ask`/`confirm`'s label defaulting — so a renderer port
 * changes an import line rather than every call.
 *
 * WHY THE SUGAR LIVES HERE AND NOT IN MAIN. This is the same layer the real
 * plugins put it in: their `ask()`/`confirm()` are wrappers over ONE
 * `plugin:dialog|message` command, differing only in which buttons they ask
 * for and which answer counts as yes. `dialogTools.ts` backs the one command;
 * these three functions are its `index.js`. The port of that logic is
 * byte-faithful, `||`-truthiness included: the real `ask`/`confirm` treat
 * `okLabel: ""` as "no custom label", and this reproduces that rather than
 * quietly "fixing" it to `!== undefined`.
 *
 * `message()`'s deprecated `okLabel` (the real plugin folds it into `buttons`
 * for back-compat) is NOT carried: the plugin's own type marks it
 * `@deprecated`, `ipc-contract.ts` therefore does not accept it, and every one
 * of this app's ~10 `okLabel` call sites is on `confirm`/`ask`, where the
 * option is current rather than deprecated. Nothing to be compatible with.
 *
 * ============================================================================
 * TESTABILITY — the same seam convention as every `registerXIpc` module
 * ============================================================================
 * `electron` is imported for its TYPES only; the runtime module is reached
 * exactly once, in the guarded tail at the bottom. {@link createArcelleApi}
 * and {@link installArcelleBridge} take an already-resolved
 * `ipcRenderer`/`contextBridge` as parameters, so the whole bridge is unit
 * testable under plain Node/vitest — the same "accept it as a parameter, type
 * it against the real module, never import it at module scope" convention
 * `recIpc.ts`/`sttTools.ts`/every other ported module uses for `IpcMain`.
 * Requiring `'electron'` OUTSIDE a real Electron process resolves to a bare
 * path STRING, so a top-level `import { contextBridge } from "electron"` would
 * make this file unimportable from a test at all.
 */

import { createRequire } from "node:module";
import type { IpcRenderer } from "electron";
import { isKnownCommandChannel, isKnownEventChannel } from "../shared/channelAllowlist.js";
import type {
  Commands,
  MessageDialogButtons,
  MessageDialogKind,
  MessageDialogResult,
} from "../shared/ipc-contract.js";

/** Thrown (by `on`) or rejected with (by `invoke`) for a channel string that
 * is not on the respective allowlist. A distinct, named error so a caller — or
 * a test — can recognize "the preload refused this" without string-matching a
 * message. */
export class UnknownChannelError extends Error {
  constructor(kind: "command" | "event", channel: string) {
    super(
      `arcelle.${kind === "command" ? "invoke" : "on"}: "${channel}" is not a known IPC ` +
        `${kind} channel — refused before reaching ipcRenderer.`
    );
    this.name = "UnknownChannelError";
  }
}

/** The minimal slice of Electron's real `ipcRenderer` this bridge needs —
 * typed against the real module without importing it at runtime. */
export type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

/** The shape exposed on `window.arcelle`. `invoke`'s return type is `unknown`
 * — this bridge does not (and structurally cannot) re-derive per-channel
 * result types at the isolated-world boundary; a renderer port of `api.ts`
 * supplies the per-command generic wrapper one layer up, exactly as the old
 * Tauri `invoke<ResultType>(...)` callers did over the raw `@tauri-apps/api`
 * `invoke`. */
export interface ArcelleApi {
  /** Call a main-process command. Rejects with {@link UnknownChannelError} for
   * a channel that is not a real `Commands` key — never throws synchronously
   * (see the module doc). */
  invoke(channel: string, args?: unknown): Promise<unknown>;
  /** Subscribe to a main→renderer event; returns an unsubscribe function.
   * `callback` receives only the payload — never the raw `IpcRendererEvent`,
   * which carries a `sender` the renderer has no business touching. Throws
   * {@link UnknownChannelError} for a channel that is not a real
   * `EventPayloads` key. */
  on(channel: string, callback: (payload: unknown) => void): () => void;
  /** `@tauri-apps/plugin-dialog`'s five functions — see the module doc. */
  dialog: ArcelleDialogApi;
  /** `@tauri-apps/plugin-opener`'s three functions — see the module doc. */
  shell: ArcelleShellApi;
  /** Resolve renderer `File` objects to native paths without exposing
   * Electron's `webUtils` object or any filesystem primitive. */
  files: ArcelleFilesApi;
}

export interface ArcelleFilesApi {
  paths(files: readonly unknown[]): string[];
}

// ============================================================================
// arcelle.dialog
// ============================================================================

/** The real plugin's `OpenDialogOptions`/`SaveDialogOptions`, as this
 * contract carries them. Aliased off `Commands` rather than re-declared, so the
 * renderer-facing signature cannot drift from the wire. */
export type OpenDialogOptions = Commands["dialog_open"]["args"];
export type SaveDialogOptions = Commands["dialog_save"]["args"];

/** The real plugin's `MessageDialogOptions`, minus the deprecated `okLabel` —
 * see the module doc. */
export interface MessageDialogOptions {
  title?: string;
  kind?: MessageDialogKind;
  buttons?: MessageDialogButtons;
}

/** The real plugin's `ConfirmDialogOptions` — `ask`/`confirm` take labels
 * rather than a button set, and `okLabel` is current (not deprecated) here. */
export interface ConfirmDialogOptions {
  title?: string;
  kind?: MessageDialogKind;
  okLabel?: string;
  cancelLabel?: string;
}

export interface ArcelleDialogApi {
  open(options?: OpenDialogOptions): Promise<string | string[] | null>;
  save(options?: SaveDialogOptions): Promise<string | null>;
  message(message: string, options?: string | MessageDialogOptions): Promise<MessageDialogResult>;
  /** `Yes`/`No`, or a custom pair. Resolves true when the affirmative button
   * was chosen. */
  ask(message: string, options?: string | ConfirmDialogOptions): Promise<boolean>;
  /** `OK`/`Cancel`, or a custom pair. Resolves true when the affirmative button
   * was chosen. */
  confirm(message: string, options?: string | ConfirmDialogOptions): Promise<boolean>;
}

// ============================================================================
// arcelle.shell
// ============================================================================

export interface ArcelleShellApi {
  /** `openWith` names an application to open with; omitted, the system default
   * handles it. Rejects for a URL outside the app's scope (`shellTools.ts`). */
  openUrl(url: string, openWith?: string): Promise<void>;
  openPath(path: string, openWith?: string): Promise<void>;
  /** One path or many — normalized here exactly as the real plugin's own
   * wrapper does, so the wire always carries `{ paths }`. */
  revealItemInDir(path: string | string[]): Promise<void>;
}

/**
 * Build the {@link ArcelleApi} over an already-resolved `ipcRenderer`. Pure and
 * synchronous — no `electron` import, no side effects — so it is directly unit
 * testable against a fake. {@link installArcelleBridge} calls this with the
 * REAL `ipcRenderer` when this file runs as an actual preload script.
 */
export function createArcelleApi(
  ipcRenderer: IpcRendererLike,
  getPathForFile: (file: unknown) => string = () => ""
): ArcelleApi {
  /** Every `arcelle.dialog`/`arcelle.shell` call goes through the SAME
   * allowlist check the public `invoke` does — the namespaces are sugar over
   * this bridge, never a second way past it. */
  const call = (channel: string, args?: unknown): Promise<unknown> => {
    if (!isKnownCommandChannel(channel)) {
      return Promise.reject(new UnknownChannelError("command", channel));
    }
    return ipcRenderer.invoke(channel, args);
  };

  /** `message`/`ask`/`confirm` all accept a bare title string in place of an
   * options object — the real plugin's own `typeof options === 'string'`
   * convenience. */
  const asOptions = <T extends { title?: string }>(options: string | T | undefined): T | undefined =>
    typeof options === "string" ? ({ title: options } as T) : options;

  const messageCommand = (
    message: string,
    opts: { title?: string; kind?: MessageDialogKind; buttons?: MessageDialogButtons }
  ): Promise<MessageDialogResult> =>
    call("dialog_message", {
      message,
      title: opts.title,
      kind: opts.kind,
      buttons: opts.buttons,
    }) as Promise<MessageDialogResult>;

  const dialog: ArcelleDialogApi = {
    open: (options) => call("dialog_open", options ?? {}) as Promise<string | string[] | null>,
    save: (options) => call("dialog_save", options ?? {}) as Promise<string | null>,
    message: (message, options) => {
      const opts = asOptions<MessageDialogOptions>(options);
      return messageCommand(message, {
        title: opts?.title,
        kind: opts?.kind,
        buttons: opts?.buttons,
      });
    },
    ask: async (message, options) => {
      // `ask()`, line for line: `YesNo` unless a label was customized, and
      // `||` rather than `??` — an empty label string counts as no custom
      // label in the real plugin, and this keeps that.
      const opts = asOptions<ConfirmDialogOptions>(options);
      const customButtons = Boolean(opts?.okLabel) || Boolean(opts?.cancelLabel);
      const okLabel = opts?.okLabel ?? "Yes";
      const result = await messageCommand(message, {
        title: opts?.title,
        kind: opts?.kind,
        buttons: customButtons ? { ok: okLabel, cancel: opts?.cancelLabel ?? "No" } : "YesNo",
      });
      return result === okLabel;
    },
    confirm: async (message, options) => {
      // `confirm()`, same shape with `OkCancel`'s defaults.
      const opts = asOptions<ConfirmDialogOptions>(options);
      const customButtons = Boolean(opts?.okLabel) || Boolean(opts?.cancelLabel);
      const okLabel = opts?.okLabel ?? "Ok";
      const result = await messageCommand(message, {
        title: opts?.title,
        kind: opts?.kind,
        buttons: customButtons ? { ok: okLabel, cancel: opts?.cancelLabel ?? "Cancel" } : "OkCancel",
      });
      return result === okLabel;
    },
  };

  const shell: ArcelleShellApi = {
    openUrl: async (url, openWith) => {
      await call("open_url", { url, with: openWith });
    },
    openPath: async (path, openWith) => {
      await call("open_path", { path, with: openWith });
    },
    revealItemInDir: async (path) => {
      await call("reveal_item_in_dir", { paths: typeof path === "string" ? [path] : path });
    },
  };

  return {
    dialog,
    shell,
    files: {
      paths: (files) => files.map((file) => getPathForFile(file)).filter((path) => path.length > 0),
    },
    invoke(channel: string, args?: unknown): Promise<unknown> {
      return call(channel, args);
    },
    on(channel: string, callback: (payload: unknown) => void): () => void {
      if (!isKnownEventChannel(channel)) {
        throw new UnknownChannelError("event", channel);
      }
      const listener = (_event: unknown, payload: unknown): void => callback(payload);
      ipcRenderer.on(channel, listener as Parameters<IpcRendererLike["on"]>[1]);
      return () => {
        ipcRenderer.removeListener(channel, listener as Parameters<IpcRendererLike["on"]>[1]);
      };
    },
  };
}

/** The minimal slice of `contextBridge` this needs — typed against the real
 * module without importing it at runtime, matching {@link IpcRendererLike}. */
export interface ContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}

/**
 * Install `window.arcelle` for real. Takes `contextBridge`/`ipcRenderer` as
 * parameters (rather than importing `electron` itself) purely for testability
 * — see the module doc.
 */
export function installArcelleBridge(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
  getPathForFile?: (file: unknown) => string
): void {
  contextBridge.exposeInMainWorld("arcelle", createArcelleApi(ipcRenderer, getPathForFile));
}

// ============================================================================
// Real preload entrypoint
// ============================================================================
//
// The only part of this file that touches the real `electron` module, GUARDED
// to run only inside a real Electron process (`process.versions.electron` is
// set by Electron in every one of its processes — main, renderer, and the
// preload realm — and is `undefined` under plain Node/vitest).
//
// `createRequire` + a synchronous `require("electron")`, rather than a static
// top-level `import`, is deliberate: requiring `'electron'` OUTSIDE a real
// Electron process resolves to a bare path STRING, and a static ESM import of
// named bindings off a CJS module whose `module.exports` is a string has no
// named exports for Node's ESM loader to find — it would throw at MODULE LOAD
// time, before this guard ever ran, breaking every test that imports the
// testable exports above. A synchronous `require`, entered only when the guard
// is true, avoids that entirely and (unlike a dynamic `import()`) installs the
// bridge with no microtask deferral — `contextBridge.exposeInMainWorld` runs
// during this module's own synchronous evaluation, which is when Electron
// expects it, not after an awaited step.
if (typeof process !== "undefined" && process.versions?.electron !== undefined) {
  const nodeRequire = createRequire(import.meta.url);
  const electron = nodeRequire("electron") as {
    contextBridge: ContextBridgeLike;
    ipcRenderer: IpcRendererLike;
    webUtils: { getPathForFile(file: unknown): string };
  };
  installArcelleBridge(
    electron.contextBridge,
    electron.ipcRenderer,
    (file) => electron.webUtils.getPathForFile(file)
  );
}
