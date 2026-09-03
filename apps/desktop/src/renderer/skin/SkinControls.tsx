import { useEffect, useState, type KeyboardEvent } from "react";
import type { SkinPalette, SkinPatch, SkinTheme } from "./skinModel";
import {
  setAgentMaySave,
  setSkinMode,
  previewSkinDraft,
  setSkinPreview,
  updateSkinDraft,
  useSkinWorkspace,
} from "./skinStore";

const PALETTE_FIELDS: Array<{ key: keyof SkinPalette; label: string }> = [
  { key: "page", label: "Page" },
  { key: "surface", label: "Surface" },
  { key: "surfaceRaised", label: "Raised" },
  { key: "ink", label: "Text" },
  { key: "inkStrong", label: "Strong text" },
  { key: "muted", label: "Muted text" },
  { key: "accent", label: "Accent" },
  { key: "accentLift", label: "Accent hover" },
  { key: "rule", label: "Rules" },
  { key: "ruleStrong", label: "Control edges" },
  { key: "success", label: "Success" },
  { key: "warning", label: "Warning" },
  { key: "danger", label: "Danger" },
  { key: "info", label: "Information" },
];

const FONT_PRESETS = [
  "Inter, ui-sans-serif, system-ui, sans-serif",
  "Figtree, ui-sans-serif, system-ui, sans-serif",
  "Avenir Next, Avenir, ui-sans-serif, system-ui, sans-serif",
  "Iowan Old Style, Charter, Georgia, serif",
  "Georgia, Times New Roman, serif",
  "Kalam, Bradley Hand, Noteworthy, cursive",
  "SFMono-Regular, Menlo, Monaco, monospace",
];

function RangeControl({ label, value, min, max, step, unit = "", onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="skin-range">
      <span>{label}<output>{value}{unit}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function SelectControl({ label, value, children, onChange }: {
  label: string;
  value: string;
  children: React.ReactNode;
  onChange: (value: string) => void;
}) {
  return <label className="skin-select"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select></label>;
}

function ModeControl() {
  const { draft } = useSkinWorkspace();
  const modes = [
    { id: "user", label: "User only" },
    { id: "agent", label: "Agent only" },
    { id: "together", label: "Together" },
  ] as const;
  return (
    <section className="skin-side-section skin-collaboration" data-agent-blocked>
      <div className="skin-side-heading"><span>Editing</span><small>Who may change the draft</small></div>
      <div className="skin-mode-switch" role="radiogroup" aria-label="Skin editors">
        {modes.map((mode) => (
          <button key={mode.id} type="button" role="radio" aria-checked={draft.mode === mode.id} onClick={() => setSkinMode(mode.id)}>{mode.label}</button>
        ))}
      </div>
      <label className="skin-check">
        <input type="checkbox" checked={draft.agentMaySave} onChange={(event) => setAgentMaySave(event.target.checked)} />
        <span><strong>Agent may save &amp; apply</strong><small>Otherwise it can propose drafts only.</small></span>
      </label>
    </section>
  );
}

type PatchDraft = (label: string, patch: SkinPatch) => boolean;

function BufferedInput({ value, type = "text", list, label, commit, preview }: {
  value: string;
  type?: "text" | "color";
  list?: string;
  label: string;
  commit: (value: string) => boolean;
  preview: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  useEffect(() => setDraftValue(value), [value]);
  const save = () => {
    if (draftValue === value) return;
    if (!commit(draftValue)) setDraftValue(value);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      setDraftValue(value);
      event.currentTarget.blur();
    }
  };
  return (
    <input
      aria-label={label}
      type={type}
      list={list}
      value={draftValue}
      onChange={(event) => {
        setDraftValue(event.target.value);
        preview(event.target.value);
      }}
      onBlur={save}
      onKeyDown={keyDown}
    />
  );
}

function PaletteControls({ theme, setTheme, onPatch }: {
  theme: SkinTheme;
  setTheme: (theme: SkinTheme) => void;
  onPatch: PatchDraft;
}) {
  const { draft } = useSkinWorkspace();
  const palette = draft.config.palette[theme];
  return (
    <details className="skin-side-section" open>
      <summary>Colours <small>{theme} palette</small></summary>
      <div className="skin-theme-switch" role="tablist" aria-label="Palette theme">
        {(["dark", "light"] as const).map((name) => <button key={name} type="button" role="tab" aria-selected={theme === name} onClick={() => setTheme(name)}>{name}</button>)}
      </div>
      <div className="skin-swatches">
        {PALETTE_FIELDS.map((field) => (
          <label className="skin-swatch" key={field.key}>
            <BufferedInput
              type="color"
              label={`${theme} ${field.label}`}
              value={palette[field.key]}
              preview={(value) => previewSkinDraft({ actor: "user", label: `Previewed ${theme} ${field.label.toLowerCase()}`, patch: { palette: { [theme]: { [field.key]: value } } } })}
              commit={(value) => onPatch(`Changed ${theme} ${field.label.toLowerCase()}`, { palette: { [theme]: { [field.key]: value } } })}
            />
            <span>{field.label}<code>{palette[field.key]}</code></span>
          </label>
        ))}
      </div>
    </details>
  );
}

function TypographyControls({ onPatch }: { onPatch: PatchDraft }) {
  const { typography } = useSkinWorkspace().draft.config;
  return (
    <details className="skin-side-section" open>
      <summary>Typography <small>Faces &amp; scale</small></summary>
      <label className="skin-text-field">UI font<BufferedInput label="UI font" list="skin-fonts" value={typography.uiFont} preview={(value) => previewSkinDraft({ actor: "user", label: "Previewed UI font", patch: { typography: { uiFont: value } } })} commit={(value) => onPatch("Changed UI font", { typography: { uiFont: value } })} /></label>
      <label className="skin-text-field">Display font<BufferedInput label="Display font" list="skin-fonts" value={typography.displayFont} preview={(value) => previewSkinDraft({ actor: "user", label: "Previewed display font", patch: { typography: { displayFont: value } } })} commit={(value) => onPatch("Changed display font", { typography: { displayFont: value } })} /></label>
      <label className="skin-text-field">User-written font<BufferedInput label="User-written font" list="skin-fonts" value={typography.userFont} preview={(value) => previewSkinDraft({ actor: "user", label: "Previewed user-written font", patch: { typography: { userFont: value } } })} commit={(value) => onPatch("Changed user-written font", { typography: { userFont: value } })} /></label>
      <label className="skin-text-field">Code font<BufferedInput label="Code font" list="skin-fonts" value={typography.monoFont} preview={(value) => previewSkinDraft({ actor: "user", label: "Previewed code font", patch: { typography: { monoFont: value } } })} commit={(value) => onPatch("Changed code font", { typography: { monoFont: value } })} /></label>
      <datalist id="skin-fonts">{FONT_PRESETS.map((font) => <option key={font} value={font} />)}</datalist>
      <RangeControl label="Body size" value={typography.bodySize} min={11} max={24} step={1} unit="px" onChange={(bodySize) => onPatch("Changed body size", { typography: { bodySize } })} />
      <RangeControl label="Heading scale" value={typography.scale} min={0.8} max={1.5} step={0.05} onChange={(scale) => onPatch("Changed heading scale", { typography: { scale } })} />
      <RangeControl label="Line height" value={typography.lineHeight} min={1.2} max={2} step={0.05} onChange={(lineHeight) => onPatch("Changed line height", { typography: { lineHeight } })} />
      <RangeControl label="Body tracking" value={typography.bodyTracking} min={-0.04} max={0.12} step={0.01} unit="em" onChange={(bodyTracking) => onPatch("Changed body tracking", { typography: { bodyTracking } })} />
      <RangeControl label="Heading tracking" value={typography.headingTracking} min={-0.08} max={0.08} step={0.01} unit="em" onChange={(headingTracking) => onPatch("Changed heading tracking", { typography: { headingTracking } })} />
      <RangeControl label="Number tracking" value={typography.numericTracking} min={-0.08} max={0.08} step={0.01} unit="em" onChange={(numericTracking) => onPatch("Changed number tracking", { typography: { numericTracking } })} />
    </details>
  );
}

function CanvasControls({ onPatch }: { onPatch: PatchDraft }) {
  const { canvas } = useSkinWorkspace().draft.config;
  return (
    <details className="skin-side-section" open>
      <summary>Canvas <small>Background &amp; material</small></summary>
      <SelectControl label="Texture" value={canvas.texture} onChange={(texture) => onPatch("Changed canvas texture", { canvas: { texture: texture as typeof canvas.texture } })}>
        <option value="off">Clean</option><option value="dots">Notebook dots</option><option value="grid">Grid</option>
      </SelectControl>
      <SelectControl label="Backdrop" value={canvas.backdrop} onChange={(backdrop) => onPatch("Changed canvas backdrop", { canvas: { backdrop: backdrop as typeof canvas.backdrop } })}>
        <option value="solid">Solid</option><option value="glow">Soft glow</option><option value="aurora">Aurora</option>
      </SelectControl>
      <RangeControl label="Intensity" value={canvas.intensity} min={0} max={1} step={0.05} onChange={(intensity) => onPatch("Changed backdrop intensity", { canvas: { intensity } })} />
      <RangeControl label="Grid spacing" value={canvas.gridGap} min={12} max={40} step={1} unit="px" onChange={(gridGap) => onPatch("Changed grid spacing", { canvas: { gridGap } })} />
      <RangeControl label="Surface opacity" value={canvas.surfaceOpacity} min={0.35} max={1} step={0.01} onChange={(surfaceOpacity) => onPatch("Changed surface opacity", { canvas: { surfaceOpacity } })} />
      <RangeControl label="Glass blur" value={canvas.blur} min={0} max={40} step={1} unit="px" onChange={(blur) => onPatch("Changed glass blur", { canvas: { blur } })} />
      <RangeControl label="Glass saturation" value={canvas.saturation} min={0.5} max={2} step={0.05} onChange={(saturation) => onPatch("Changed glass saturation", { canvas: { saturation } })} />
      <RangeControl label="Scroll-edge fade" value={canvas.scrollFade} min={0} max={48} step={1} unit="px" onChange={(scrollFade) => onPatch("Changed scroll-edge fade", { canvas: { scrollFade } })} />
    </details>
  );
}

function ShapeSpacingControls({ onPatch }: { onPatch: PatchDraft }) {
  const config = useSkinWorkspace().draft.config;
  return (
    <details className="skin-side-section">
      <summary>Shape &amp; rhythm <small>Edges, space, motion</small></summary>
      <RangeControl label="Corner radius" value={config.shape.radius} min={0} max={28} step={1} unit="px" onChange={(radius) => onPatch("Changed corner radius", { shape: { radius } })} />
      <RangeControl label="Border width" value={config.shape.borderWidth} min={0} max={3} step={0.5} unit="px" onChange={(borderWidth) => onPatch("Changed border width", { shape: { borderWidth } })} />
      <RangeControl label="Shadow" value={config.shape.shadow} min={0} max={1} step={0.05} onChange={(shadow) => onPatch("Changed shadow", { shape: { shadow } })} />
      <RangeControl label="Drawn-edge offset" value={config.shape.redrawOffset} min={0} max={6} step={1} unit="px" onChange={(redrawOffset) => onPatch("Changed drawn-edge offset", { shape: { redrawOffset } })} />
      <SelectControl label="Corner style" value={config.shape.cornerStyle} onChange={(cornerStyle) => onPatch("Changed corner style", { shape: { cornerStyle: cornerStyle as typeof config.shape.cornerStyle } })}>
        <option value="round">Round</option><option value="squircle">Continuous when supported</option>
      </SelectControl>
      <RangeControl label="Spacing" value={config.spacing.scale} min={0.75} max={1.4} step={0.05} onChange={(scale) => onPatch("Changed spacing", { spacing: { scale } })} />
      <RangeControl label="Motion speed" value={config.motion.speed} min={0.5} max={2} step={0.1} onChange={(speed) => onPatch("Changed motion speed", { motion: { speed } })} />
      <RangeControl label="Press depth" value={config.motion.pressScale} min={0.94} max={1} step={0.01} onChange={(pressScale) => onPatch("Changed press depth", { motion: { pressScale } })} />
      <SelectControl label="Motion curve" value={config.motion.curve} onChange={(curve) => onPatch("Changed motion curve", { motion: { curve: curve as typeof config.motion.curve } })}>
        <option value="calm">Calm</option><option value="snappy">Snappy</option><option value="spring">Spring</option>
      </SelectControl>
      <SelectControl label="Scroll edges" value={config.motion.overscroll} onChange={(overscroll) => onPatch("Changed scroll edges", { motion: { overscroll: overscroll as typeof config.motion.overscroll } })}>
        <option value="native">Native elasticity</option><option value="contained">Contained</option><option value="none">Locked</option>
      </SelectControl>
      <label className="skin-check"><input type="checkbox" checked={config.motion.reduce} onChange={(event) => onPatch("Changed reduced motion", { motion: { reduce: event.target.checked } })} /><span><strong>Reduce motion</strong><small>Removes design transitions.</small></span></label>
    </details>
  );
}

function AccessibilityControls({ onPatch }: { onPatch: PatchDraft }) {
  const { accessibility } = useSkinWorkspace().draft.config;
  return (
    <details className="skin-side-section">
      <summary>Accessibility <small>System preferences</small></summary>
      <SelectControl label="Transparency" value={accessibility.transparency} onChange={(transparency) => onPatch("Changed transparency preference", { accessibility: { transparency: transparency as typeof accessibility.transparency } })}>
        <option value="system">Follow system</option><option value="reduce">Reduced transparency</option><option value="allow">Always allow glass</option>
      </SelectControl>
      <SelectControl label="Contrast" value={accessibility.contrast} onChange={(contrast) => onPatch("Changed contrast preference", { accessibility: { contrast: contrast as typeof accessibility.contrast } })}>
        <option value="system">Follow system</option><option value="more">More contrast</option><option value="normal">Normal contrast</option>
      </SelectControl>
    </details>
  );
}

function LayoutControls({ onPatch }: { onPatch: PatchDraft }) {
  const { layout } = useSkinWorkspace().draft.config;
  return (
    <details className="skin-side-section">
      <summary>Layout <small>Pane proportions</small></summary>
      <RangeControl label="Rail" value={layout.railWidth} min={52} max={112} step={1} unit="px" onChange={(railWidth) => onPatch("Changed rail width", { layout: { railWidth } })} />
      <RangeControl label="Sidebar" value={layout.sidebarWidth} min={210} max={420} step={5} unit="px" onChange={(sidebarWidth) => onPatch("Changed sidebar width", { layout: { sidebarWidth } })} />
      <RangeControl label="Agent pane" value={layout.agentWidth} min={280} max={560} step={5} unit="px" onChange={(agentWidth) => onPatch("Changed agent pane width", { layout: { agentWidth } })} />
      <RangeControl label="Pane gap" value={layout.paneGap} min={0} max={24} step={1} unit="px" onChange={(paneGap) => onPatch("Changed pane gap", { layout: { paneGap } })} />
    </details>
  );
}

export function SkinControls() {
  const { draft } = useSkinWorkspace();
  const [theme, setTheme] = useState<SkinTheme>(() => document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [error, setError] = useState("");
  const userCanEdit = draft.mode !== "agent";
  useEffect(() => setError(""), [draft.config, draft.mode]);
  const patch = (label: string, change: SkinPatch) => {
    const result = updateSkinDraft({ actor: "user", label, patch: change });
    setError(result.ok ? "" : `Change rejected; draft unchanged. ${result.error}`);
    if (!result.ok) setSkinPreview(true);
    return result.ok;
  };
  return (
    <div className="skin-controls">
      <ModeControl />
      {!userCanEdit && <p className="skin-side-note">Manual controls are locked while the Design agent owns this draft. Change the editing mode above whenever you want to join in.</p>}
      <fieldset className="skin-control-fieldset" disabled={!userCanEdit}>
        <PaletteControls theme={theme} setTheme={setTheme} onPatch={patch} />
        <TypographyControls onPatch={patch} />
        <CanvasControls onPatch={patch} />
        <ShapeSpacingControls onPatch={patch} />
        <AccessibilityControls onPatch={patch} />
        <LayoutControls onPatch={patch} />
      </fieldset>
      {error && <p className="skin-control-error" role="alert">{error}</p>}
    </div>
  );
}
