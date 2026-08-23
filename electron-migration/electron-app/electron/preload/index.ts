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
 *   - `dialog`/`shell`/`app` extras the plan sometimes lists are NOT built
 *     here: there is no renderer yet to call them, and inventing their shape
 *     with no real call site to validate against would be guessing. `invoke`
 *     and `on` are the two primitives everything in `api.ts` was already built
 *     out of; the rest is additive once a real renderer exists.
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
}

/**
 * Build the {@link ArcelleApi} over an already-resolved `ipcRenderer`. Pure and
 * synchronous — no `electron` import, no side effects — so it is directly unit
 * testable against a fake. {@link installArcelleBridge} calls this with the
 * REAL `ipcRenderer` when this file runs as an actual preload script.
 */
export function createArcelleApi(ipcRenderer: IpcRendererLike): ArcelleApi {
  return {
    invoke(channel: string, args?: unknown): Promise<unknown> {
      if (!isKnownCommandChannel(channel)) {
        return Promise.reject(new UnknownChannelError("command", channel));
      }
      return ipcRenderer.invoke(channel, args);
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
  ipcRenderer: IpcRendererLike
): void {
  contextBridge.exposeInMainWorld("arcelle", createArcelleApi(ipcRenderer));
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
  };
  installArcelleBridge(electron.contextBridge, electron.ipcRenderer);
}
