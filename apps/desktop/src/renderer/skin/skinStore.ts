import { useSyncExternalStore } from "react";
import {
  DEFAULT_SKIN,
  applySkinPatch,
  createSkinDraft,
  parseSkinDocument,
  redoSkinChange,
  saveSkinDraft,
  serializeSkinDocument,
  undoSkinChange,
  validateSkin,
  type SavedSkin,
  type SkinActor,
  type SkinConfig,
  type SkinDraft,
  type SkinHistoryEntry,
  type SkinMode,
  type SkinMutation as ModelSkinMutation,
  type SkinPatch,
  type SkinResult,
  type SkinTheme,
} from "./skinModel";

export const SKIN_STORAGE_KEY = "prSkinWorkspaceV1";
export const DEFAULT_SKIN_ID = "arcelle-default";
export const SKIN_LAYOUT_EVENT = "arcelle-skin-layout";

export interface SkinWorkspace {
  version: 1;
  activeSkinId: string;
  draftName: string;
  draft: SkinDraft;
  saved: SavedSkin[];
}

export type SkinMutation = ModelSkinMutation;

const listeners = new Set<() => void>();
let cache: SkinWorkspace | null = null;
let previewing = false;
let themeObserver: MutationObserver | null = null;

export function defaultSkinWorkspace(): SkinWorkspace {
  return {
    version: 1,
    activeSkinId: DEFAULT_SKIN_ID,
    draftName: "My skin",
    draft: createSkinDraft(DEFAULT_SKIN, "together"),
    saved: [],
  };
}

export function loadSkinWorkspace(storage: Storage): SkinWorkspace {
  try {
    const raw = storage.getItem(SKIN_STORAGE_KEY);
    if (!raw) return defaultSkinWorkspace();
    return decodeWorkspace(JSON.parse(raw));
  } catch {
    return defaultSkinWorkspace();
  }
}

export function persistSkinWorkspace(storage: Storage, workspace: SkinWorkspace): void {
  try {
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify(workspace));
  } catch {
    /* A live draft still works when private mode or a full disk blocks persistence. */
  }
}

export function activeSkinConfig(workspace: SkinWorkspace): SkinConfig {
  if (workspace.activeSkinId === DEFAULT_SKIN_ID) return clone(DEFAULT_SKIN);
  return clone(workspace.saved.find((skin) => skin.id === workspace.activeSkinId)?.config ?? DEFAULT_SKIN);
}

export function skinCssVariables(config: SkinConfig, theme: SkinTheme): Record<string, string> {
  const palette = config.palette[theme];
  const spacing = config.spacing.scale;
  const bodySize = config.typography.bodySize;
  const duration = (ms: number) => `${Math.round(ms / config.motion.speed)}ms`;
  const rem = (px: number) => `${Math.round((px * spacing / 16) * 1000) / 1000}rem`;
  const motionEase = {
    calm: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    snappy: "cubic-bezier(0.2, 0.9, 0.3, 1)",
    spring: "cubic-bezier(0.2, 1.35, 0.4, 1)",
  }[config.motion.curve];
  const overscroll = { native: "auto", contained: "contain", none: "none" }[config.motion.overscroll];
  const shadowAlpha = (config.shape.shadow * (theme === "dark" ? 0.7 : 0.24)).toFixed(3);
  return {
    "--page": palette.page,
    "--surface": palette.surface,
    "--raised": palette.surfaceRaised,
    "--ink": palette.ink,
    "--ink-strong": palette.inkStrong,
    "--ink-2": palette.muted,
    "--ink-muted": palette.muted,
    "--sketch": palette.ruleStrong,
    "--rule": palette.rule,
    "--rule-strong": palette.ruleStrong,
    "--grid-dot": `color-mix(in srgb, ${palette.ruleStrong} 42%, transparent)`,
    "--grid-gap": `${config.canvas.gridGap}px`,
    "--line-soft": `color-mix(in srgb, ${palette.rule} 62%, transparent)`,
    "--skin-surface-opacity": `${Math.round(config.canvas.surfaceOpacity * 100)}%`,
    "--skin-raised-opacity": `${Math.min(100, Math.round(config.canvas.surfaceOpacity * 100) + 8)}%`,
    "--surface-glass": `color-mix(in srgb, ${palette.surface} var(--skin-surface-opacity), transparent)`,
    "--raised-glass": `color-mix(in srgb, ${palette.surfaceRaised} var(--skin-raised-opacity), transparent)`,
    "--hover": `color-mix(in srgb, ${palette.ink} 9%, transparent)`,
    "--hover-glass": `color-mix(in srgb, ${palette.ink} 9%, transparent)`,
    "--selected": `color-mix(in srgb, ${palette.accent} 20%, transparent)`,
    "--selected-strong": `color-mix(in srgb, ${palette.accent} 32%, transparent)`,
    "--mk-berry": palette.accent,
    "--mk-berry-ink": palette.accent,
    "--mk-yellow": palette.warning,
    "--mk-yellow-ink": palette.warning,
    "--mk-green": palette.success,
    "--mk-green-ink": palette.success,
    "--mk-blue": palette.info,
    "--mk-blue-ink": palette.info,
    "--mk-red": palette.danger,
    "--mk-red-ink": palette.danger,
    "--accent": palette.accent,
    "--accent-2": palette.accentLift,
    "--accent-fill": palette.accent,
    "--accent-soft": `color-mix(in srgb, ${palette.accent} 18%, transparent)`,
    "--accent-ghost": `color-mix(in srgb, ${palette.accent} 9%, transparent)`,
    "--accent-ink": readableInk(palette.accent),
    "--btn-ink": palette.ink,
    "--btn-ink-text": palette.page,
    "--green": palette.success,
    "--amber": palette.warning,
    "--red": palette.danger,
    "--blue": palette.info,
    "--sem-saved": palette.accent,
    "--sem-saved-fill": palette.accent,
    "--sem-done": palette.success,
    "--sem-done-fill": palette.success,
    "--sem-pending": palette.warning,
    "--sem-pending-fill": palette.warning,
    "--sem-urgent": palette.danger,
    "--sem-urgent-fill": palette.danger,
    "--sem-linked": palette.info,
    "--sem-linked-fill": palette.info,
    "--tok-system": palette.info,
    "--tok-history": palette.success,
    "--tok-tools": palette.accent,
    "--tok-skills": palette.warning,
    "--tok-files": palette.ruleStrong,
    "--eng-duckduckgo": palette.info,
    "--eng-brave": palette.accent,
    "--eng-mojeek": palette.success,
    "--eng-marginalia": palette.warning,
    "--eng-wikipedia": palette.ruleStrong,
    "--eng-ddgia": palette.danger,
    "--eng-news": palette.muted,
    "--font-ui": config.typography.uiFont,
    "--font-display": config.typography.displayFont,
    "--font-user": config.typography.userFont,
    "--font-mono": config.typography.monoFont,
    "--sans": config.typography.uiFont,
    "--display": config.typography.displayFont,
    "--hand": config.typography.userFont,
    "--mono": config.typography.monoFont,
    "--fs-body": `${bodySize}px`,
    "--fs-meta": `${Math.max(11, Math.round(bodySize - 1))}px`,
    "--fs-micro": `${Math.max(10, Math.round(bodySize - 2))}px`,
    "--fs-hand": `${Math.round(bodySize * 1.07)}px`,
    "--fs-hand-lg": `${Math.round(bodySize * 1.6 * config.typography.scale)}px`,
    "--fs-lead": `${Math.round(bodySize * 1.14 * config.typography.scale)}px`,
    "--fs-section": `${Math.round(bodySize * 1.72 * config.typography.scale)}px`,
    "--fs-page": `${Math.round(bodySize * 2.9 * config.typography.scale)}px`,
    "--lh-body": String(config.typography.lineHeight),
    "--lh-hand": String(Math.max(1.2, config.typography.lineHeight - 0.05)),
    "--tracking-body": `${config.typography.bodyTracking}em`,
    "--tracking-heading": `${config.typography.headingTracking}em`,
    "--tracking-numeric": `${config.typography.numericTracking}em`,
    "--stroke-w": `${config.shape.borderWidth}px`,
    "--redraw": `${config.shape.redrawOffset}px`,
    "--radius-xs": `${Math.max(0, config.shape.radius - 6)}px`,
    "--radius-sm": `${Math.max(0, config.shape.radius - 3)}px`,
    "--radius": `${config.shape.radius}px`,
    "--radius-lg": `${Math.min(36, config.shape.radius + 4)}px`,
    "--sp-1": rem(4),
    "--sp-2": rem(8),
    "--sp-3": rem(12),
    "--sp-4": rem(16),
    "--sp-5": rem(20),
    "--sp-6": rem(24),
    "--sp-8": rem(32),
    "--dur-fast": config.motion.reduce ? "0ms" : duration(160),
    "--dur": config.motion.reduce ? "0ms" : duration(200),
    "--dur-slow": config.motion.reduce ? "0ms" : duration(260),
    "--motion-ease": motionEase,
    "--ease-pen": motionEase,
    "--press-scale": String(config.motion.pressScale),
    "--skin-overscroll": overscroll,
    "--glass-blur": `${config.canvas.blur}px`,
    "--glass-saturation": String(config.canvas.saturation),
    "--scroll-fade": `${config.canvas.scrollFade}px`,
    "--shadow": `rgba(0, 0, 0, ${shadowAlpha})`,
    "--shadow-lift": `rgba(0, 0, 0, ${(Number(shadowAlpha) * 0.74).toFixed(3)})`,
    "--skin-rail-width": `${config.layout.railWidth}px`,
    "--skin-sidebar-width": `${config.layout.sidebarWidth}px`,
    "--skin-agent-width": `${config.layout.agentWidth}px`,
    "--skin-pane-gap": `${config.layout.paneGap}px`,
    "--skin-space-scale": String(spacing),
    "--skin-backdrop-intensity": String(config.canvas.intensity),
    "--skin-accent-glow": `color-mix(in srgb, ${palette.accent} ${Math.round(config.canvas.intensity * 16)}%, transparent)`,
    "--skin-success-glow": `color-mix(in srgb, ${palette.success} ${Math.round(config.canvas.intensity * 10)}%, transparent)`,
  };
}

export function applySkinVariables(root: HTMLElement, config: SkinConfig, theme: SkinTheme): void {
  const variables = skinCssVariables(config, theme);
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  root.style.backgroundColor = config.palette[theme].page;
  root.dataset.skin = "custom";
  root.dataset.skinTexture = config.canvas.texture;
  root.dataset.skinBackdrop = config.canvas.backdrop;
  root.dataset.skinMotion = config.motion.reduce ? "reduced" : "full";
  root.dataset.skinCorners = config.shape.cornerStyle;
  root.dataset.skinTransparency = config.accessibility.transparency;
  root.dataset.skinContrast = config.accessibility.contrast;
}

export function initSkin(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  cache = loadSkinWorkspace(window.localStorage);
  applyCurrentSkin();
  themeObserver?.disconnect();
  themeObserver = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "data-theme")) applyCurrentSkin();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

export function useSkinWorkspace(): SkinWorkspace {
  return useSyncExternalStore(subscribeSkin, skinSnapshot, skinSnapshot);
}

export function skinSnapshot(): SkinWorkspace {
  if (!cache) cache = browserWorkspace();
  return cache;
}

export function setSkinPreview(active: boolean): void {
  previewing = active;
  applyCurrentSkin();
}

export function setSkinMode(mode: SkinMode): void {
  commit({ ...skinSnapshot(), draft: { ...skinSnapshot().draft, mode } });
}

export function setAgentMaySave(allowed: boolean): void {
  commit({ ...skinSnapshot(), draft: { ...skinSnapshot().draft, agentMaySave: allowed } });
}

export function setDraftName(name: string): void {
  commit({ ...skinSnapshot(), draftName: name.slice(0, 80) });
}

export function updateSkinDraft(mutation: SkinMutation): SkinResult<{ state: SkinDraft }> {
  const result = applySkinPatch(skinSnapshot().draft, mutation);
  if (result.ok) {
    previewing = true;
    commit({ ...skinSnapshot(), draft: result.state });
  }
  return result;
}

/** Paint a manual control's in-progress value without persisting it or adding
 * history. The matching blur/Enter commit still crosses the normal mutation
 * boundary, so one editing gesture becomes one attributable revision. */
export function previewSkinDraft(mutation: SkinMutation): SkinResult<{ state: SkinDraft }> {
  const result = applySkinPatch(skinSnapshot().draft, mutation);
  if (result.ok) applyRenderedSkin(result.state.config, true);
  else applyCurrentSkin();
  return result;
}

export function undoDraft(actor: SkinActor, expectedRevision?: number): SkinResult<{ state: SkinDraft }> {
  const conflict = revisionConflict(actor, expectedRevision);
  if (conflict) return conflict;
  const result = undoSkinChange(skinSnapshot().draft, actor);
  if (result.ok) commit({ ...skinSnapshot(), draft: result.state });
  return result;
}

export function redoDraft(actor: SkinActor, expectedRevision?: number): SkinResult<{ state: SkinDraft }> {
  const conflict = revisionConflict(actor, expectedRevision);
  if (conflict) return conflict;
  const result = redoSkinChange(skinSnapshot().draft, actor);
  if (result.ok) commit({ ...skinSnapshot(), draft: result.state });
  return result;
}

export function saveAndApplySkin(actor: SkinActor, name = skinSnapshot().draftName, expectedRevision?: number): SkinResult<{ state: SkinDraft; saved: SavedSkin }> {
  const conflict = revisionConflict(actor, expectedRevision);
  if (conflict) return conflict;
  const result = saveSkinDraft(skinSnapshot().draft, actor, name);
  if (!result.ok) return result;
  const workspace = skinSnapshot();
  const nameKey = normalizedSkinName(result.saved.name);
  const matching = workspace.saved.filter((skin) => normalizedSkinName(skin.name) === nameKey);
  const existing = matching.find((skin) => skin.id === workspace.activeSkinId) ?? matching[0];
  const applied = existing ? { ...result.saved, id: existing.id } : result.saved;
  let replaced = false;
  const saved = workspace.saved.flatMap((skin) => {
    if (normalizedSkinName(skin.name) !== nameKey) return [skin];
    if (!replaced && skin.id === existing?.id) {
      replaced = true;
      return [applied];
    }
    return [];
  });
  if (!replaced) saved.push(applied);
  previewing = false;
  commit({
    ...workspace,
    activeSkinId: applied.id,
    draftName: applied.name,
    draft: result.state,
    saved,
  });
  return { ...result, saved: applied };
}

export function discardSkinDraft(): void {
  const workspace = skinSnapshot();
  previewing = false;
  commit({
    ...workspace,
    draft: createSkinDraft(activeSkinConfig(workspace), workspace.draft.mode, workspace.draft.agentMaySave),
  });
}

export function resetSkinWorkspace(): void {
  previewing = false;
  commit(defaultSkinWorkspace());
}

/** Clears module-lifetime browser state so isolated renderer tests can model a
 * fresh app launch without replacing the production persistence path. */
export function resetSkinRuntimeForTests(): void {
  themeObserver?.disconnect();
  themeObserver = null;
  cache = null;
  previewing = false;
  listeners.clear();
}

export function activateSavedSkin(id: string): boolean {
  const workspace = skinSnapshot();
  const selected = id === DEFAULT_SKIN_ID
    ? { name: "Arcelle default", config: DEFAULT_SKIN }
    : workspace.saved.find((skin) => skin.id === id);
  if (!selected) return false;
  previewing = false;
  commit({
    ...workspace,
    activeSkinId: id,
    draftName: selected.name,
    draft: createSkinDraft(selected.config, workspace.draft.mode, workspace.draft.agentMaySave),
  });
  return true;
}

export function deleteSavedSkin(id: string): boolean {
  if (id === DEFAULT_SKIN_ID) return false;
  const workspace = skinSnapshot();
  if (!workspace.saved.some((skin) => skin.id === id)) return false;
  const saved = workspace.saved.filter((skin) => skin.id !== id);
  if (workspace.activeSkinId !== id) {
    commit({ ...workspace, saved });
    return true;
  }
  previewing = false;
  commit({
    ...workspace,
    saved,
    activeSkinId: DEFAULT_SKIN_ID,
    draftName: "My skin",
    draft: createSkinDraft(DEFAULT_SKIN, workspace.draft.mode, workspace.draft.agentMaySave),
  });
  return true;
}

export function importSkin(source: string): SkinResult<{ state: SkinDraft }> {
  try {
    const imported = parseSkinDocument(source);
    const workspace = skinSnapshot();
    const active = activeSkinConfig(workspace);
    const draft: SkinDraft = {
      ...createSkinDraft(active, workspace.draft.mode, workspace.draft.agentMaySave),
      revision: 1,
      config: clone(imported.config),
      dirty: JSON.stringify(imported.config) !== JSON.stringify(active),
      history: [{
        actor: "user",
        label: `Imported ${imported.name}`,
        revision: 1,
        before: clone(active),
        after: clone(imported.config),
      }],
    };
    previewing = true;
    commit({ ...workspace, draftName: imported.name, draft });
    return { ok: true, state: draft };
  } catch (error) {
    return { ok: false, code: "invalid_skin", error: error instanceof Error ? error.message : String(error) };
  }
}

export function exportSkin(): string {
  const workspace = skinSnapshot();
  return serializeSkinDocument({ name: workspace.draftName || "My skin", config: workspace.draft.config });
}

function subscribeSkin(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(next: SkinWorkspace): void {
  cache = next;
  if (typeof window !== "undefined") persistSkinWorkspace(window.localStorage, next);
  applyCurrentSkin();
  listeners.forEach((listener) => listener());
}

function browserWorkspace(): SkinWorkspace {
  if (typeof window === "undefined") return defaultSkinWorkspace();
  return loadSkinWorkspace(window.localStorage);
}

function applyCurrentSkin(): void {
  if (typeof document === "undefined") return;
  const workspace = skinSnapshot();
  const config = previewing ? workspace.draft.config : activeSkinConfig(workspace);
  applyRenderedSkin(config, previewing || workspace.activeSkinId !== DEFAULT_SKIN_ID);
}

function applyRenderedSkin(config: SkinConfig, layoutEnabled: boolean): void {
  if (typeof document === "undefined") return;
  applySkinVariables(document.documentElement, config, currentTheme());
  if (typeof window !== "undefined" && typeof window.CustomEvent === "function") {
    window.dispatchEvent(new window.CustomEvent(SKIN_LAYOUT_EVENT, {
      detail: {
        layout: clone(config).layout,
        enabled: layoutEnabled,
      },
    }));
  }
}

function currentTheme(): SkinTheme {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function normalizedSkinName(name: string): string {
  return name.trim().toLowerCase();
}

function decodeWorkspace(value: unknown): SkinWorkspace {
  const root = asRecord(value);
  if (!root || root.version !== 1) throw new Error("Unsupported skin workspace.");
  const saved = decodeSavedSkins(root.saved);
  const draft = decodeDraft(root.draft);
  return {
    version: 1,
    activeSkinId: decodedActiveSkinId(root.activeSkinId, saved),
    draftName: decodedDraftName(root.draftName),
    draft,
    saved,
  };
}

function decodeSavedSkins(value: unknown): SavedSkin[] {
  return Array.isArray(value) ? value.map(decodeSavedSkin) : [];
}

function decodedActiveSkinId(value: unknown, saved: SavedSkin[]): string {
  const requested = typeof value === "string" ? value : DEFAULT_SKIN_ID;
  if (requested === DEFAULT_SKIN_ID) return requested;
  return saved.some((skin) => skin.id === requested) ? requested : DEFAULT_SKIN_ID;
}

function decodedDraftName(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 80) : "My skin";
}

function decodeDraft(value: unknown): SkinDraft {
  const root = asRecord(value);
  if (!root) throw new Error("Skin draft is missing.");
  const config = decodeConfig(root.config);
  const savedConfig = decodeConfig(root.savedConfig);
  const draft = createSkinDraft(
    savedConfig,
    root.mode === "user" || root.mode === "agent" || root.mode === "together" ? root.mode : "together",
    root.agentMaySave === true,
  );
  return {
    ...draft,
    revision: finiteInteger(root.revision),
    config,
    savedConfig,
    history: decodeHistory(root.history),
    future: decodeHistory(root.future),
    dirty: JSON.stringify(config) !== JSON.stringify(savedConfig),
  };
}

function decodeHistory(value: unknown): SkinHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).map((entry) => {
    const root = asRecord(entry);
    if (!root || (root.actor !== "user" && root.actor !== "agent") || typeof root.label !== "string") {
      throw new Error("Skin history is malformed.");
    }
    return {
      actor: root.actor,
      label: root.label.slice(0, 120),
      revision: finiteInteger(root.revision),
      before: decodeConfig(root.before),
      after: decodeConfig(root.after),
    };
  });
}

function decodeSavedSkin(value: unknown): SavedSkin {
  const root = asRecord(value);
  if (!root || root.version !== 1) throw new Error("Saved skin is malformed.");
  const id = requiredSavedSkinString(root.id);
  const name = requiredSavedSkinString(root.name);
  return {
    id,
    version: 1,
    name: name.slice(0, 80),
    config: decodeConfig(root.config),
    savedAt: typeof root.savedAt === "string" ? root.savedAt : new Date(0).toISOString(),
    savedBy: root.savedBy === "agent" ? "agent" : "user",
  };
}

function requiredSavedSkinString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Saved skin is malformed.");
  return value;
}

function decodeConfig(value: unknown): SkinConfig {
  return parseSkinDocument(JSON.stringify({ version: 1, name: "Stored skin", config: value })).config;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function clone(config: SkinConfig): SkinConfig {
  return structuredClone(config);
}

function readableInk(hex: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const luminance = channels.reduce((sum, value, index) => {
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  return luminance > 0.46 ? "#151716" : "#fbfaf4";
}

function revisionConflict(actor: SkinActor, expectedRevision: number | undefined): SkinResult<never> | null {
  if (actor !== "agent" || expectedRevision === skinSnapshot().draft.revision) return null;
  return {
    ok: false,
    code: "revision_conflict",
    error: `The skin changed after revision ${String(expectedRevision)}. Read it again before editing.`,
    currentRevision: skinSnapshot().draft.revision,
  };
}

export function skinValidationSummary(): { valid: boolean; issues: string[] } {
  const issues = validateSkin(skinSnapshot().draft.config);
  return { valid: issues.length === 0, issues };
}

export type { SkinPatch };
