/**
 * Renderer-facing host bridge.
 *
 * The application UI imports this module instead of importing Tauri.  The
 * implementation is intentionally tiny: Electron's isolated preload owns the
 * privileged objects and exposes only the typed operations used here.
 */

export type UnlistenFn = () => void;

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  filters?: DialogFilter[];
  defaultPath?: string;
  multiple?: boolean;
  directory?: boolean;
  room?: boolean;
  canCreateDirectories?: boolean;
}

export interface SaveDialogOptions {
  title?: string;
  filters?: DialogFilter[];
  defaultPath?: string;
  canCreateDirectories?: boolean;
}

export type DialogKind = "info" | "warning" | "error";

export interface ConfirmDialogOptions {
  title?: string;
  kind?: DialogKind;
  okLabel?: string;
  cancelLabel?: string;
}

export interface MessageDialogOptions {
  title?: string;
  kind?: DialogKind;
}

interface ArcelleHost {
  invoke(channel: string, args?: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): UnlistenFn;
  dialog: {
    open(options?: OpenDialogOptions): Promise<string | string[] | null>;
    save(options?: SaveDialogOptions): Promise<string | null>;
    message(message: string, options?: string | MessageDialogOptions): Promise<unknown>;
    ask(message: string, options?: string | ConfirmDialogOptions): Promise<boolean>;
    confirm(message: string, options?: string | ConfirmDialogOptions): Promise<boolean>;
  };
  shell: {
    openUrl(url: string, openWith?: string): Promise<void>;
    openPath(path: string, openWith?: string): Promise<void>;
    revealItemInDir(path: string | string[]): Promise<void>;
  };
  files?: {
    paths(files: readonly File[]): string[];
  };
}

function host(): ArcelleHost {
  const value = (window as Window & { arcelle?: ArcelleHost }).arcelle;
  if (!value) {
    throw new Error("Arcelle's Electron preload bridge is unavailable.");
  }
  return value;
}

export function invoke<T>(channel: string, args?: unknown): Promise<T> {
  return host().invoke(channel, args) as Promise<T>;
}

const localListeners = new Map<string, Set<(payload: unknown) => void>>();

/** Deliver renderer-owned transport events through the same subscription
 * surface as preload events. Direct recording sockets use this so existing UI
 * listeners do not care which side of the process boundary produced an event. */
export function emitLocal(channel: string, payload: unknown): void {
  for (const callback of localListeners.get(channel) ?? []) callback(payload);
}

/** Keep the Tauri-era listener return shape while the UI call sites migrate:
 * subscriptions are installed synchronously, then exposed as a resolved
 * promise containing their teardown function. */
export function listen<T>(
  channel: string,
  callback: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  const local = (payload: unknown) => callback({ payload: payload as T });
  const bucket = localListeners.get(channel) ?? new Set<(payload: unknown) => void>();
  bucket.add(local);
  localListeners.set(channel, bucket);
  const unlistenHost = host().on(channel, local);
  return Promise.resolve(() => {
    unlistenHost();
    bucket.delete(local);
    if (bucket.size === 0) localListeners.delete(channel);
  });
}

export const open = (options?: OpenDialogOptions) => host().dialog.open(options);
export const save = (options?: SaveDialogOptions) => host().dialog.save(options);
export const message = (text: string, options?: string | MessageDialogOptions) =>
  host().dialog.message(text, options);
export const ask = (text: string, options?: string | ConfirmDialogOptions) =>
  host().dialog.ask(text, options);
export const confirm = (text: string, options?: string | ConfirmDialogOptions) =>
  host().dialog.confirm(text, options);

export const openUrl = (url: string, openWith?: string) => host().shell.openUrl(url, openWith);
export const openPath = (path: string, openWith?: string) => host().shell.openPath(path, openWith);
export const revealItemInDir = (path: string | string[]) => host().shell.revealItemInDir(path);

export function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  return Promise.resolve();
}

export function closeWindow(): Promise<void> {
  window.close();
  return Promise.resolve();
}

export interface AvailableUpdate {
  version: string;
  notes?: string;
}

export const getVersion = () => invoke<string>("app_version", {});
export const checkForUpdate = () => invoke<AvailableUpdate | null>("updater_check", {});
export const installUpdate = () => invoke<void>("updater_install", {});

export function droppedFilePaths(files: readonly File[]): string[] {
  return host().files?.paths(files) ?? [];
}

export type DragDropPayload =
  | { type: "enter" | "over" | "leave"; paths: string[] }
  | { type: "drop"; paths: string[] };

/** Electron uses standard HTML drag events.  This adapter preserves the
 * event shape the workspace already consumes and resolves native paths only
 * through the preload's narrow `webUtils.getPathForFile` wrapper. */
export function onDragDropEvent(
  callback: (event: { payload: DragDropPayload }) => void | Promise<void>,
): Promise<UnlistenFn> {
  const handlers: Array<[keyof WindowEventMap, EventListener]> = [];
  const add = (name: keyof WindowEventMap, fn: EventListener) => {
    window.addEventListener(name, fn);
    handlers.push([name, fn]);
  };
  const emit = (type: DragDropPayload["type"], paths: string[] = []) => {
    void callback({ payload: { type, paths } as DragDropPayload });
  };
  add("dragenter", ((event: DragEvent) => {
    event.preventDefault();
    emit("enter");
  }) as EventListener);
  add("dragover", ((event: DragEvent) => {
    event.preventDefault();
    emit("over");
  }) as EventListener);
  add("dragleave", ((event: DragEvent) => {
    event.preventDefault();
    emit("leave");
  }) as EventListener);
  add("drop", ((event: DragEvent) => {
    event.preventDefault();
    emit("drop", droppedFilePaths(Array.from(event.dataTransfer?.files ?? [])));
  }) as EventListener);
  return Promise.resolve(() => {
    for (const [name, fn] of handlers) window.removeEventListener(name, fn);
  });
}
