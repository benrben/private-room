import type { SkinConfig, SkinPalette, SkinTheme } from "./skinModel";

const PALETTE_KEYS = [
  "page", "surface", "surfaceRaised", "ink", "inkStrong", "muted", "accent",
  "accentLift", "rule", "ruleStrong", "success", "warning", "danger", "info",
] as const;

export function validateSkin(config: SkinConfig): string[] {
  const issues: string[] = [];
  for (const theme of ["dark", "light"] as const) validatePalette(config.palette[theme], theme, issues);
  validateTypography(config, issues);
  validateCanvas(config, issues);
  validateShape(config, issues);
  validateMotionAndAccessibility(config, issues);
  validateLayout(config, issues);
  return issues;
}

function validateTypography(config: SkinConfig, issues: string[]): void {
  validateRange(config.typography.bodySize, 11, 24, "Body size", issues);
  validateRange(config.typography.scale, 0.8, 1.5, "Type scale", issues);
  validateRange(config.typography.lineHeight, 1.2, 2, "Line height", issues);
  validateRange(config.typography.bodyTracking, -0.04, 0.12, "Body tracking", issues);
  validateRange(config.typography.headingTracking, -0.08, 0.08, "Heading tracking", issues);
  validateRange(config.typography.numericTracking, -0.08, 0.08, "Numeric tracking", issues);
  validateFont(config.typography.uiFont, "UI font", issues);
  validateFont(config.typography.displayFont, "Display font", issues);
  validateFont(config.typography.userFont, "User-written font", issues);
  validateFont(config.typography.monoFont, "Mono font", issues);
}

function validateCanvas(config: SkinConfig, issues: string[]): void {
  if (!["off", "dots", "grid"].includes(config.canvas.texture)) issues.push("Canvas texture is not supported.");
  if (!["solid", "glow", "aurora"].includes(config.canvas.backdrop)) issues.push("Canvas backdrop is not supported.");
  validateRange(config.canvas.intensity, 0, 1, "Backdrop intensity", issues);
  validateRange(config.canvas.gridGap, 12, 40, "Grid gap", issues);
  validateRange(config.canvas.surfaceOpacity, 0.35, 1, "Surface opacity", issues);
  validateRange(config.canvas.blur, 0, 40, "Glass blur", issues);
  validateRange(config.canvas.saturation, 0.5, 2, "Glass saturation", issues);
  validateRange(config.canvas.scrollFade, 0, 48, "Scroll fade", issues);
}

function validateShape(config: SkinConfig, issues: string[]): void {
  validateRange(config.shape.radius, 0, 28, "Corner radius", issues);
  validateRange(config.shape.borderWidth, 0, 3, "Border width", issues);
  validateRange(config.shape.shadow, 0, 1, "Shadow", issues);
  validateRange(config.shape.redrawOffset, 0, 6, "Redraw offset", issues);
  if (!["round", "squircle"].includes(config.shape.cornerStyle)) issues.push("Corner style is not supported.");
  validateRange(config.spacing.scale, 0.75, 1.4, "Spacing scale", issues);
}

function validateMotionAndAccessibility(config: SkinConfig, issues: string[]): void {
  validateRange(config.motion.speed, 0.5, 2, "Motion speed", issues);
  if (typeof config.motion.reduce !== "boolean") issues.push("Reduced motion must be true or false.");
  validateRange(config.motion.pressScale, 0.94, 1, "Press scale", issues);
  if (!["calm", "snappy", "spring"].includes(config.motion.curve)) issues.push("Motion curve is not supported.");
  if (!["native", "contained", "none"].includes(config.motion.overscroll)) issues.push("Overscroll behavior is not supported.");
  if (!["system", "reduce", "allow"].includes(config.accessibility.transparency)) issues.push("Transparency preference is not supported.");
  if (!["system", "more", "normal"].includes(config.accessibility.contrast)) issues.push("Contrast preference is not supported.");
}

function validateLayout(config: SkinConfig, issues: string[]): void {
  validateRange(config.layout.railWidth, 52, 112, "Rail width", issues);
  validateRange(config.layout.sidebarWidth, 210, 420, "Sidebar width", issues);
  validateRange(config.layout.agentWidth, 280, 560, "Agent pane width", issues);
  validateRange(config.layout.paneGap, 0, 24, "Pane gap", issues);
}

function validatePalette(palette: SkinPalette, theme: SkinTheme, issues: string[]): void {
  validatePaletteColors(palette, theme, issues);
  if (!hexColor(palette.ink) || !hexColor(palette.inkStrong)) return;
  validatePaletteContrast(palette, theme, issues);
}

function validatePaletteColors(palette: SkinPalette, theme: SkinTheme, issues: string[]): void {
  for (const key of PALETTE_KEYS) {
    if (!hexColor(palette[key])) issues.push(`${theme} ${key} must be a six-digit hex color.`);
  }
}

function validatePaletteContrast(palette: SkinPalette, theme: SkinTheme, issues: string[]): void {
  for (const [surfaceName, surface] of [["page", palette.page], ["surface", palette.surface], ["raised surface", palette.surfaceRaised]] as const) {
    if (!hexColor(surface)) continue;
    if (contrast(surface, palette.ink) < 4.5) issues.push(`${theme} body text on ${surfaceName} must have at least 4.5:1 contrast.`);
    if (contrast(surface, palette.inkStrong) < 4.5) issues.push(`${theme} strong text on ${surfaceName} must have at least 4.5:1 contrast.`);
  }
}

function validateRange(value: number, min: number, max: number, label: string, issues: string[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) issues.push(`${label} must be between ${min} and ${max}.`);
}

function validateFont(value: string, label: string, issues: string[]): void {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[{};]/.test(value)) issues.push(`${label} is not a safe font stack.`);
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function hexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}
