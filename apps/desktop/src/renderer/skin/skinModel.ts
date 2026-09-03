import { validateSkin } from "./skinValidation";

export { validateSkin } from "./skinValidation";

export type SkinMode = "user" | "agent" | "together";
export type SkinActor = "user" | "agent";
export type SkinTheme = "dark" | "light";

export interface SkinPalette {
  page: string;
  surface: string;
  surfaceRaised: string;
  ink: string;
  inkStrong: string;
  muted: string;
  accent: string;
  accentLift: string;
  rule: string;
  ruleStrong: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export interface SkinConfig {
  palette: Record<SkinTheme, SkinPalette>;
  typography: {
    uiFont: string;
    displayFont: string;
    userFont: string;
    monoFont: string;
    bodySize: number;
    scale: number;
    lineHeight: number;
    bodyTracking: number;
    headingTracking: number;
    numericTracking: number;
  };
  canvas: {
    texture: "off" | "dots" | "grid";
    backdrop: "solid" | "glow" | "aurora";
    intensity: number;
    gridGap: number;
    surfaceOpacity: number;
    blur: number;
    saturation: number;
    scrollFade: number;
  };
  shape: {
    radius: number;
    borderWidth: number;
    shadow: number;
    redrawOffset: number;
    cornerStyle: "round" | "squircle";
  };
  spacing: {
    scale: number;
  };
  motion: {
    speed: number;
    reduce: boolean;
    pressScale: number;
    curve: "calm" | "snappy" | "spring";
    overscroll: "native" | "contained" | "none";
  };
  accessibility: {
    transparency: "system" | "reduce" | "allow";
    contrast: "system" | "more" | "normal";
  };
  layout: {
    railWidth: number;
    sidebarWidth: number;
    agentWidth: number;
    paneGap: number;
  };
}

export interface SkinPatch {
  palette?: {
    dark?: Partial<SkinPalette>;
    light?: Partial<SkinPalette>;
  };
  typography?: Partial<SkinConfig["typography"]>;
  canvas?: Partial<SkinConfig["canvas"]>;
  shape?: Partial<SkinConfig["shape"]>;
  spacing?: Partial<SkinConfig["spacing"]>;
  motion?: Partial<SkinConfig["motion"]>;
  accessibility?: Partial<SkinConfig["accessibility"]>;
  layout?: Partial<SkinConfig["layout"]>;
}

export interface SkinHistoryEntry {
  actor: SkinActor;
  label: string;
  revision: number;
  before: SkinConfig;
  after: SkinConfig;
}

export interface SkinDraft {
  mode: SkinMode;
  agentMaySave: boolean;
  revision: number;
  config: SkinConfig;
  savedConfig: SkinConfig;
  history: SkinHistoryEntry[];
  future: SkinHistoryEntry[];
  dirty: boolean;
}

export interface SavedSkin {
  id: string;
  version: 1;
  name: string;
  config: SkinConfig;
  savedAt: string;
  savedBy: SkinActor;
}

export interface SkinDocument {
  version: 1;
  name: string;
  config: SkinConfig;
}

export interface SkinMutation {
  actor: SkinActor;
  label: string;
  expectedRevision?: number;
  patch: SkinPatch;
}

type SkinFailureCode =
  | "actor_not_allowed"
  | "revision_conflict"
  | "invalid_skin"
  | "nothing_to_undo"
  | "nothing_to_redo"
  | "save_not_allowed"
  | "invalid_name";

export type SkinResult<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: SkinFailureCode;
      error: string;
      currentRevision?: number;
      issues?: string[];
    };

export const DEFAULT_SKIN: SkinConfig = {
  palette: {
    dark: {
      page: "#151716",
      surface: "#1b1e1c",
      surfaceRaised: "#232724",
      ink: "#d8d4c8",
      inkStrong: "#f2eee2",
      muted: "#8e9189",
      accent: "#b6df56",
      accentLift: "#d3f282",
      rule: "#343a35",
      ruleStrong: "#505950",
      success: "#7fcf8c",
      warning: "#e8bd62",
      danger: "#ef7770",
      info: "#73a8d8",
    },
    light: {
      page: "#f4f1e8",
      surface: "#fbf8ef",
      surfaceRaised: "#ffffff",
      ink: "#34372f",
      inkStrong: "#191b17",
      muted: "#73776d",
      accent: "#547d16",
      accentLift: "#41630d",
      rule: "#d8d4c8",
      ruleStrong: "#aaa99f",
      success: "#2d7c42",
      warning: "#8a5d0a",
      danger: "#a43d39",
      info: "#346f9f",
    },
  },
  typography: {
    uiFont: "Inter, ui-sans-serif, system-ui, sans-serif",
    displayFont: "Iowan Old Style, Charter, Georgia, serif",
    userFont: "Kalam, Bradley Hand, Noteworthy, cursive",
    monoFont: "SFMono-Regular, Menlo, Monaco, monospace",
    bodySize: 15,
    scale: 1,
    lineHeight: 1.5,
    bodyTracking: 0,
    headingTracking: -0.02,
    numericTracking: -0.02,
  },
  canvas: {
    texture: "dots",
    backdrop: "glow",
    intensity: 0.5,
    gridGap: 22,
    surfaceOpacity: 0.86,
    blur: 18,
    saturation: 1.4,
    scrollFade: 18,
  },
  shape: {
    radius: 12,
    borderWidth: 1,
    shadow: 0.45,
    redrawOffset: 2,
    cornerStyle: "round",
  },
  spacing: { scale: 1 },
  motion: { speed: 1, reduce: false, pressScale: 0.97, curve: "calm", overscroll: "native" },
  accessibility: { transparency: "system", contrast: "system" },
  layout: { railWidth: 84, sidebarWidth: 260, agentWidth: 340, paneGap: 8 },
};

const ROOT_KEYS = ["palette", "typography", "canvas", "shape", "spacing", "motion", "accessibility", "layout"] as const;
const PALETTE_KEYS = [
  "page", "surface", "surfaceRaised", "ink", "inkStrong", "muted", "accent",
  "accentLift", "rule", "ruleStrong", "success", "warning", "danger", "info",
] as const;
const TYPOGRAPHY_KEYS = ["uiFont", "displayFont", "userFont", "monoFont", "bodySize", "scale", "lineHeight", "bodyTracking", "headingTracking", "numericTracking"] as const;
const CANVAS_KEYS = ["texture", "backdrop", "intensity", "gridGap", "surfaceOpacity", "blur", "saturation", "scrollFade"] as const;
const SHAPE_KEYS = ["radius", "borderWidth", "shadow", "redrawOffset", "cornerStyle"] as const;
const SPACING_KEYS = ["scale"] as const;
const MOTION_KEYS = ["speed", "reduce", "pressScale", "curve", "overscroll"] as const;
const ACCESSIBILITY_KEYS = ["transparency", "contrast"] as const;
const LAYOUT_KEYS = ["railWidth", "sidebarWidth", "agentWidth", "paneGap"] as const;
const PATCH_SECTIONS = [
  ["typography", TYPOGRAPHY_KEYS, "typography patch"],
  ["canvas", CANVAS_KEYS, "canvas patch"],
  ["shape", SHAPE_KEYS, "shape patch"],
  ["spacing", SPACING_KEYS, "spacing patch"],
  ["motion", MOTION_KEYS, "motion patch"],
  ["accessibility", ACCESSIBILITY_KEYS, "accessibility patch"],
  ["layout", LAYOUT_KEYS, "layout patch"],
] as const;

export function createSkinDraft(
  config: SkinConfig = DEFAULT_SKIN,
  mode: SkinMode = "together",
  agentMaySave = false,
): SkinDraft {
  const clean = cloneSkin(config);
  return {
    mode,
    agentMaySave,
    revision: 0,
    config: clean,
    savedConfig: cloneSkin(clean),
    history: [],
    future: [],
    dirty: false,
  };
}

export function applySkinPatch(state: SkinDraft, mutation: SkinMutation): SkinResult<{ state: SkinDraft }> {
  const permission = actorFailure(state, mutation.actor);
  if (permission) return permission;
  if (mutation.actor === "agent" && mutation.expectedRevision !== state.revision) {
    return {
      ok: false,
      code: "revision_conflict",
      error: `The skin changed after revision ${String(mutation.expectedRevision)}. Read it again before editing.`,
      currentRevision: state.revision,
    };
  }
  const next = mergeSkinPatch(state.config, mutation.patch);
  const issues = validateSkin(next);
  if (issues.length > 0) {
    return { ok: false, code: "invalid_skin", error: issues.join(" "), issues };
  }
  const revision = state.revision + 1;
  const entry: SkinHistoryEntry = {
    actor: mutation.actor,
    label: cleanLabel(mutation.label),
    revision,
    before: cloneSkin(state.config),
    after: cloneSkin(next),
  };
  return {
    ok: true,
    state: {
      ...state,
      revision,
      config: next,
      history: [...state.history, entry],
      future: [],
      dirty: !sameSkin(next, state.savedConfig),
    },
  };
}

export function undoSkinChange(state: SkinDraft, actor: SkinActor): SkinResult<{ state: SkinDraft }> {
  const permission = actorFailure(state, actor);
  if (permission) return permission;
  const entry = state.history.at(-1);
  if (!entry) return { ok: false, code: "nothing_to_undo", error: "There is no skin change to undo." };
  const config = cloneSkin(entry.before);
  return {
    ok: true,
    state: {
      ...state,
      revision: state.revision + 1,
      config,
      history: state.history.slice(0, -1),
      future: [entry, ...state.future],
      dirty: !sameSkin(config, state.savedConfig),
    },
  };
}

export function redoSkinChange(state: SkinDraft, actor: SkinActor): SkinResult<{ state: SkinDraft }> {
  const permission = actorFailure(state, actor);
  if (permission) return permission;
  const entry = state.future[0];
  if (!entry) return { ok: false, code: "nothing_to_redo", error: "There is no skin change to redo." };
  const config = cloneSkin(entry.after);
  return {
    ok: true,
    state: {
      ...state,
      revision: state.revision + 1,
      config,
      history: [...state.history, entry],
      future: state.future.slice(1),
      dirty: !sameSkin(config, state.savedConfig),
    },
  };
}

export function saveSkinDraft(
  state: SkinDraft,
  actor: SkinActor,
  name: string,
): SkinResult<{ state: SkinDraft; saved: SavedSkin }> {
  const permission = savePermissionFailure(state, actor);
  if (permission) return permission;
  const issues = validateSkin(state.config);
  if (issues.length > 0) {
    return {
      ok: false,
      code: "invalid_skin",
      error: `This draft cannot be saved: ${issues.join(" ")}`,
      issues,
    };
  }
  const cleanedName = name.trim();
  if (!cleanedName || cleanedName.length > 80) {
    return { ok: false, code: "invalid_name", error: "Skin names must be between 1 and 80 characters." };
  }
  const config = cloneSkin(state.config);
  const saved: SavedSkin = {
    id: skinId(cleanedName),
    version: 1,
    name: cleanedName,
    config,
    savedAt: new Date().toISOString(),
    savedBy: actor,
  };
  return {
    ok: true,
    saved,
    state: { ...state, savedConfig: cloneSkin(config), dirty: false },
  };
}

export function serializeSkinDocument(input: Omit<SkinDocument, "version">): string {
  const issues = validateSkin(input.config);
  if (issues.length > 0) throw new Error(`Cannot export an invalid skin: ${issues.join(" ")}`);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error("Skin names must be between 1 and 80 characters.");
  return JSON.stringify({ version: 1, name, config: input.config }, null, 2);
}

export function parseSkinDocument(source: string): SkinDocument {
  const root = record(parseJsonDocument(source), "Skin document");
  exactKeys(root, ["version", "name", "config"], "skin document");
  if (root.version !== 1) throw new Error("Skin document version is not supported.");
  const name = skinDocumentName(root.name);
  const config = parseConfig(root.config);
  assertValidImportedSkin(config);
  return { version: 1, name, config };
}

export function parseSkinPatch(value: unknown): SkinPatch {
  const root = record(value, "Skin patch");
  allowedKeys(root, ROOT_KEYS, "skin patch");
  const patch: SkinPatch = {};
  if ("palette" in root) patch.palette = parsePalettePatch(root.palette);
  const writable = patch as Record<string, unknown>;
  for (const [key, keys, label] of PATCH_SECTIONS) {
    if (key in root) writable[key] = partialSection(root[key], keys, label);
  }
  return patch;
}

function parsePalettePatch(value: unknown): NonNullable<SkinPatch["palette"]> {
  const palette = record(value, "Palette patch");
  allowedKeys(palette, ["dark", "light"], "palette patch");
  const patch: NonNullable<SkinPatch["palette"]> = {};
  if ("dark" in palette) patch.dark = partialSection(palette.dark, PALETTE_KEYS, "dark palette patch") as Partial<SkinPalette>;
  if ("light" in palette) patch.light = partialSection(palette.light, PALETTE_KEYS, "light palette patch") as Partial<SkinPalette>;
  return patch;
}

function parseJsonDocument(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Skin import must be valid JSON.");
  }
}

function skinDocumentName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 80) {
    throw new Error("Skin document name must be between 1 and 80 characters.");
  }
  return value.trim();
}

function assertValidImportedSkin(config: SkinConfig): void {
  const issues = validateSkin(config);
  if (issues.length > 0) throw new Error(`Skin document is invalid: ${issues.join(" ")}`);
}

function actorFailure(state: SkinDraft, actor: SkinActor): SkinResult<never> | null {
  const allowed = state.mode === "together" || state.mode === actor;
  if (allowed) return null;
  return {
    ok: false,
    code: "actor_not_allowed",
    error: `${actor === "agent" ? "Agent" : "User"} editing is disabled in ${state.mode}-only mode.`,
  };
}

/** Editing ownership never takes the final Apply control away from the room
 * owner. The agent needs both edit ownership and the separate save grant. */
function savePermissionFailure(state: SkinDraft, actor: SkinActor): SkinResult<never> | null {
  if (actor !== "agent") return null;
  const permission = actorFailure(state, actor);
  if (permission) return permission;
  if (state.agentMaySave) return null;
  return {
    ok: false,
    code: "save_not_allowed",
    error: "The user allows agent drafts, but has not allowed the agent to save and apply them.",
  };
}

function mergeSkinPatch(config: SkinConfig, patch: SkinPatch): SkinConfig {
  return {
    palette: {
      dark: { ...config.palette.dark, ...patch.palette?.dark },
      light: { ...config.palette.light, ...patch.palette?.light },
    },
    typography: { ...config.typography, ...patch.typography },
    canvas: { ...config.canvas, ...patch.canvas },
    shape: { ...config.shape, ...patch.shape },
    spacing: { ...config.spacing, ...patch.spacing },
    motion: { ...config.motion, ...patch.motion },
    accessibility: { ...config.accessibility, ...patch.accessibility },
    layout: { ...config.layout, ...patch.layout },
  };
}

function parseConfig(value: unknown): SkinConfig {
  const config = record(value, "Skin config");
  allowedKeys(config, ROOT_KEYS, "skin config");
  const missingRoot = ROOT_KEYS.find((key) => key !== "accessibility" && !(key in config));
  if (missingRoot) throw new Error(`skin config is missing field "${missingRoot}".`);
  const palette = record(config.palette, "Palette");
  exactKeys(palette, ["dark", "light"], "palette");
  return {
    palette: {
      dark: parsePalette(palette.dark, "dark palette"),
      light: parsePalette(palette.light, "light palette"),
    },
    typography: parseExtendedSection(config.typography, TYPOGRAPHY_KEYS, ["userFont", "bodyTracking", "headingTracking", "numericTracking"], DEFAULT_SKIN.typography, "typography") as unknown as SkinConfig["typography"],
    canvas: parseExtendedSection(config.canvas, CANVAS_KEYS, ["gridGap", "surfaceOpacity", "blur", "saturation", "scrollFade"], DEFAULT_SKIN.canvas, "canvas") as unknown as SkinConfig["canvas"],
    shape: parseExtendedSection(config.shape, SHAPE_KEYS, ["redrawOffset", "cornerStyle"], DEFAULT_SKIN.shape, "shape") as unknown as SkinConfig["shape"],
    spacing: parseSection(config.spacing, SPACING_KEYS, "spacing") as unknown as SkinConfig["spacing"],
    motion: parseExtendedSection(config.motion, MOTION_KEYS, ["pressScale", "curve", "overscroll"], DEFAULT_SKIN.motion, "motion") as unknown as SkinConfig["motion"],
    accessibility: "accessibility" in config
      ? parseSection(config.accessibility, ACCESSIBILITY_KEYS, "accessibility") as unknown as SkinConfig["accessibility"]
      : { ...DEFAULT_SKIN.accessibility },
    layout: parseSection(config.layout, LAYOUT_KEYS, "layout") as unknown as SkinConfig["layout"],
  };
}

function parsePalette(value: unknown, label: string): SkinPalette {
  return parseSection(value, PALETTE_KEYS, label) as unknown as SkinPalette;
}

function parseSection(value: unknown, keys: readonly string[], label: string): Record<string, never> {
  const section = record(value, label);
  exactKeys(section, keys, label);
  return { ...section } as Record<string, never>;
}

function parseExtendedSection(value: unknown, keys: readonly string[], optional: readonly string[], defaults: object, label: string): Record<string, unknown> {
  const section = record(value, label);
  allowedKeys(section, keys, label);
  const missing = keys.find((key) => !(key in section) && !optional.includes(key));
  if (missing) throw new Error(`${label} is missing field "${missing}".`);
  return { ...defaults, ...section };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  allowedKeys(value, keys, label);
  const missing = keys.find((key) => !(key in value));
  if (missing) throw new Error(`${label} is missing field "${missing}".`);
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  if (unknown) throw new Error(`${label} has unknown field "${unknown}".`);
}

function partialSection(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const section = record(value, label);
  allowedKeys(section, keys, label);
  return { ...section };
}

function cleanLabel(label: string): string {
  const cleaned = label.trim().slice(0, 120);
  return cleaned || "Updated skin";
}

function sameSkin(a: SkinConfig, b: SkinConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneSkin(config: SkinConfig): SkinConfig {
  return structuredClone(config);
}

function skinId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "skin";
  return `${slug}-${Date.now().toString(36)}`;
}
