import { useEffect } from "react";
import { type DragDropPayload } from "../platform";
import {
  api,
  RoomInfo,
  type AgentOpenFilePayload,
  type JobProgress,
} from "../api";
import * as voice from "./voice";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** How many of the assistant's organization changes Activity keeps. A record of
 * this session, not an archive — the transcript is where every one of them is
 * written down in full. */
export const MAX_ORGANIZED = 25;

export type WorkspaceKeyboardState = Pick<
  WSState,
  | "ctxMenuRef"
  | "showSearchRef"
  | "showSettingsRef"
  | "showMapRef"
  | "showWorkflowsRef"
  | "showScriptsRef"
  | "openFileRef"
  | "setCtxMenu"
  | "setShowSearch"
  | "setShowMap"
  | "setShowWorkflows"
  | "setShowScripts"
  | "setSearchSel"
  | "setShowSettings"
  | "setOpenMenu"
  | "setShowShortcuts"
  | "setOpenFile"
>;

export type WorkspaceKeyboardActions = Pick<
  WSActions,
  "newChat" | "handleLock" | "guardLeave"
>;

export type WorkspaceJobState = Pick<
  WSState,
  "setJobProgress" | "setStudioStep" | "askingRef" | "pushToast"
>;

export type WorkspaceJobActions = Pick<WSActions, "refreshJobs" | "viewFile">;

export type WorkspaceDropState = Pick<
  WSState,
  | "internalDragRef"
  | "setDragOver"
  | "setImportProgress"
  | "setFiles"
  | "pushToast"
>;

export type WorkspaceDropActions = Pick<WSActions, "reportImport">;

export type WorkspaceOpenFileState = Pick<WSState, "openFileRef">;

export type WorkspaceOpenFileActions = Pick<WSActions, "viewFile">;

export type WorkspaceVoiceState = Pick<WSState, "setAutoSpeak" | "setHandsFree">;

export type WorkspaceAutolockState = Pick<
  WSState,
  "autolockRef" | "askingRef" | "recLiveRef" | "lastActivityRef" | "pushToast"
>;

export type VoiceSettings = [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
];

export function closeEscapePopover(
  event: KeyboardEvent,
  state: WorkspaceKeyboardState,
): boolean {
  if (state.ctxMenuRef.current) {
    event.preventDefault();
    state.setCtxMenu(null);
    return true;
  }
  if (state.showSearchRef.current) {
    event.preventDefault();
    state.setShowSearch(false);
    return true;
  }
  return false;
}

export function settingsOwnsEscape(state: WorkspaceKeyboardState): boolean {
  return state.showSettingsRef.current;
}

export function closeEscapePane(
  event: KeyboardEvent,
  state: WorkspaceKeyboardState,
): boolean {
  if (state.showMapRef.current) {
    event.preventDefault();
    state.setShowMap(false);
    return true;
  }
  if (state.showWorkflowsRef.current) {
    event.preventDefault();
    state.setShowWorkflows(false);
    return true;
  }
  if (state.showScriptsRef.current) {
    event.preventDefault();
    state.setShowScripts(false);
    return true;
  }
  return false;
}

export function typingOutsideNoteEditor(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".monaco-editor") !== null) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA";
}

export function closeOpenFileOnEscape(
  event: KeyboardEvent,
  state: WorkspaceKeyboardState,
  actions: WorkspaceKeyboardActions,
): void {
  if (typingOutsideNoteEditor(event.target)) return;
  if (state.openFileRef.current === null) return;
  event.preventDefault();
  actions.guardLeave("Closing this file", () => state.setOpenFile(null));
}

export function handleWorkspaceEscape(
  event: KeyboardEvent,
  state: WorkspaceKeyboardState,
  actions: WorkspaceKeyboardActions,
): void {
  if (closeEscapePopover(event, state)) return;
  if (settingsOwnsEscape(state)) return;
  if (closeEscapePane(event, state)) return;
  closeOpenFileOnEscape(event, state, actions);
}

export function searchShortcut(
  key: string,
  alreadyHandled: boolean,
  state: WorkspaceKeyboardState,
): (() => void) | null {
  if (key === "k") return () => openWorkspaceSearch(state);
  if (key === "f" && !alreadyHandled) return () => openWorkspaceSearch(state);
  return null;
}

export function openWorkspaceSearch(state: WorkspaceKeyboardState): void {
  state.setSearchSel(0);
  state.setShowSearch(true);
}

export function standardShortcut(
  key: string,
  state: WorkspaceKeyboardState,
  actions: WorkspaceKeyboardActions,
): (() => void) | null {
  const shortcuts: Record<string, () => void> = {
    n: actions.newChat,
    l: actions.handleLock,
    ",": () => state.setShowSettings(true),
    j: () =>
      state.setOpenMenu((menu) => (menu === "workflows" ? null : "workflows")),
    "/": () => state.setShowShortcuts((open) => !open),
  };
  return shortcuts[key] ?? null;
}

export function handleWorkspaceMetaShortcut(
  event: KeyboardEvent,
  state: WorkspaceKeyboardState,
  actions: WorkspaceKeyboardActions,
): void {
  if (!event.metaKey) return;
  const key = event.key.toLowerCase();
  const action =
    searchShortcut(key, event.defaultPrevented, state) ??
    standardShortcut(key, state, actions);
  if (action === null) return;
  event.preventDefault();
  action();
}

export function handleWorkspaceKey(
  event: KeyboardEvent,
  state: WorkspaceKeyboardState,
  actions: WorkspaceKeyboardActions,
): void {
  if (event.key === "Escape") {
    handleWorkspaceEscape(event, state, actions);
    return;
  }
  handleWorkspaceMetaShortcut(event, state, actions);
}

export function useWorkspaceKeyboardShortcuts(
  state: WorkspaceKeyboardState,
  actions: WorkspaceKeyboardActions,
  eventTarget: Pick<
    Window,
    "addEventListener" | "removeEventListener"
  > = window,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) =>
      handleWorkspaceKey(event, state, actions);
    eventTarget.addEventListener("keydown", onKey);
    return () => eventTarget.removeEventListener("keydown", onKey);
  }, []);
}

export function isTerminalJob(progress: JobProgress): boolean {
  return Boolean(progress.finished || progress.paused || progress.failed);
}

export function removeJobProgress(
  state: WorkspaceJobState,
  progress: JobProgress,
): void {
  state.setJobProgress((jobs) => {
    const next = { ...jobs };
    delete next[progress.jobId];
    return next;
  });
  state.setStudioStep({ text: "", local: true });
}

export function finishedJobAction(
  progress: JobProgress,
  actions: WorkspaceJobActions,
): (() => void) | null {
  return progress.fileId
    ? () => void actions.viewFile(progress.fileId as string)
    : null;
}

export function announceFinishedJob(
  state: WorkspaceJobState,
  progress: JobProgress,
  actions: WorkspaceJobActions,
): void {
  const open = finishedJobAction(progress, actions);
  const midTurn = state.askingRef.current;
  state.pushToast(
    "success",
    progress.label || "Background job finished.",
    open && midTurn ? { label: "Open", run: open } : undefined,
  );
  if (open && !midTurn) open();
}

export function announceTerminalJob(
  state: WorkspaceJobState,
  progress: JobProgress,
  actions: WorkspaceJobActions,
): void {
  if (progress.finished) {
    announceFinishedJob(state, progress, actions);
    return;
  }
  if (progress.paused) {
    state.pushToast("info", "Paused — resume it any time from the sidebar.");
    return;
  }
  if (progress.failed) {
    state.pushToast("error", progress.label || "Background job failed.");
  }
}

export function updateRunningJob(
  state: WorkspaceJobState,
  actions: WorkspaceJobActions,
  seenJobs: Set<string>,
  progress: JobProgress,
): void {
  if (!seenJobs.has(progress.jobId)) {
    seenJobs.add(progress.jobId);
    void actions.refreshJobs();
  }
  state.setJobProgress((jobs) => ({
    ...jobs,
    [progress.jobId]: {
      label: progress.label,
      done: progress.done,
      total: progress.total,
    },
  }));
}

export function handleJobProgress(
  state: WorkspaceJobState,
  actions: WorkspaceJobActions,
  seenJobs: Set<string>,
  progress: JobProgress,
): void {
  if (!isTerminalJob(progress)) {
    updateRunningJob(state, actions, seenJobs, progress);
    return;
  }
  removeJobProgress(state, progress);
  void actions.refreshJobs();
  announceTerminalJob(state, progress, actions);
}

export function setDragBoundary(
  state: WorkspaceDropState,
  type: DragDropPayload["type"],
): boolean {
  if (type === "enter" || type === "over") {
    state.setDragOver(true);
    return true;
  }
  if (type === "leave") {
    state.setDragOver(false);
    return true;
  }
  return false;
}

export function startMultiFileImport(
  state: WorkspaceDropState,
  paths: string[],
): void {
  if (paths.length > 1) {
    state.setImportProgress({
      done: 0,
      total: paths.length,
      name: "Starting…",
    });
  }
}

async function importDroppedFiles(
  state: WorkspaceDropState,
  actions: WorkspaceDropActions,
  paths: string[],
): Promise<void> {
  startMultiFileImport(state, paths);
  try {
    const report = await api.importFiles(paths);
    state.setFiles(await api.listFiles());
    actions.reportImport(report);
  } catch (error) {
    state.pushToast("error", String(error));
  } finally {
    state.setImportProgress(null);
  }
}

export async function handleWorkspaceDrop(
  state: WorkspaceDropState,
  actions: WorkspaceDropActions,
  payload: DragDropPayload,
): Promise<void> {
  if (state.internalDragRef.current || setDragBoundary(state, payload.type))
    return;
  state.setDragOver(false);
  if (payload.paths.length > 0)
    await importDroppedFiles(state, actions, payload.paths);
}

export function openFileId(payload: AgentOpenFilePayload): string {
  return typeof payload === "string" ? payload : payload.id;
}

export function hasOpenFileHint(payload: AgentOpenFilePayload): boolean {
  return (
    typeof payload !== "string" &&
    (payload.page != null || payload.cell != null || payload.find != null)
  );
}

export function openFileTarget(payload: Exclude<AgentOpenFilePayload, string>) {
  return {
    page: payload.page ?? undefined,
    cell: payload.cell ?? undefined,
    range: payload.cell ?? undefined,
    find: payload.find ?? undefined,
    quote: payload.find ?? undefined,
  };
}

export function handleAgentOpenFile(
  state: WorkspaceOpenFileState,
  actions: WorkspaceOpenFileActions,
  payload: AgentOpenFilePayload,
): void {
  const id = openFileId(payload);
  const hinted = hasOpenFileHint(payload);
  const current = state.openFileRef.current;
  if (!hinted && current?.id === id && current.target) return;
  if (typeof payload === "string" || !hinted) {
    actions.viewFile(id);
    return;
  }
  actions.viewFile(payload.id, openFileTarget(payload));
}

export function parseVoiceParams(value: string | null): voice.VoiceParams | null {
  try {
    return value ? (JSON.parse(value) as voice.VoiceParams) : null;
  } catch {
    return null;
  }
}

export function savedVoiceArchetype(value: string | null): voice.VoiceArchetype {
  return (value as voice.VoiceArchetype) || "off";
}

export function configureSavedVoice(
  state: WorkspaceVoiceState,
  [arch, params, auto, hands, neuralId]: VoiceSettings,
): void {
  const archetype = savedVoiceArchetype(arch);
  voice.configure({
    archetype,
    params:
      parseVoiceParams(params) ??
      voice.ARCHETYPE_DEFAULTS[archetype === "custom" ? "off" : archetype],
    autoSpeak: auto === "1",
    neuralVoiceId: neuralId || null,
  });
  state.setAutoSpeak(auto === "1");
  state.setHandsFree(hands === "1");
}

export function loadSavedVoice(state: WorkspaceVoiceState): void {
  void Promise.all([
    api.getSetting("voice_archetype"),
    api.getSetting("voice_params"),
    api.getSetting("voice_autospeak"),
    api.getSetting("voice_handsfree"),
    api.getSetting("voice_neural_id"),
  ])
    .then((settings) => configureSavedVoice(state, settings))
    .catch(() => {});
}

export function autoLockLimit(setting: string): number | null {
  if (setting === "off") return null;
  const limit = Number(setting) * 60_000;
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

export function isActiveOutsideWorkspace(
  state: WorkspaceAutolockState,
  now: number,
): boolean {
  if (state.askingRef.current) return true;
  if (state.recLiveRef.current || voice.isSpeaking()) {
    state.lastActivityRef.current = now;
    return true;
  }
  return false;
}

export function triggerAutoLock(
  state: WorkspaceAutolockState,
  onLock: () => void | Promise<void>,
): void {
  voice.cancelAll();
  void Promise.resolve(onLock()).catch(() =>
    state.pushToast("error", "Auto-lock failed — this room is still open."),
  );
}

export function runAutoLockTick(
  state: WorkspaceAutolockState,
  onLock: () => void | Promise<void>,
  previousTick: number,
): number {
  const now = Date.now();
  const limit = autoLockLimit(state.autolockRef.current);
  if (limit === null || isActiveOutsideWorkspace(state, now)) return now;
  const gap = now - previousTick;
  const idle = now - state.lastActivityRef.current;
  if (idle >= limit || (gap > 45_000 && gap >= limit)) {
    triggerAutoLock(state, onLock);
  }
  return now;
}

/** Narrow event-handler seam: each helper is exercised independently from the
 * mount-time subscription wiring, whose job is only to subscribe and clean up. */
export const workspaceEffectsTestables = {
  handleAgentOpenFile,
  handleJobProgress,
  handleWorkspaceDrop,
  configureSavedVoice,
  loadSavedVoice,
  runAutoLockTick,
};

/** All of Workspace's effects: the mount-time backend-event wiring (which
 * dispatches agent-open-file → viewFile, agent-annotate → the open viewer, MCP
 * approvals, sync warning), plus the smaller orchestration effects. Kept in one
 * place because they call across the hooks. Dependency arrays are unchanged. */

import { useWorkspaceSubscriptions } from "./workspaceSubscriptions";
import { useWorkspaceOrchestration } from "./workspaceOrchestration";

export function useWorkspaceEffects(s: WSState, a: WSActions, info: RoomInfo, onLock: () => void | Promise<void>) {
  useWorkspaceSubscriptions(s, a, info);
  useWorkspaceOrchestration(s, a, info, onLock);
}
