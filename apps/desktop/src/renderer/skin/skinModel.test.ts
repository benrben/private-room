import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKIN,
  applySkinPatch,
  createSkinDraft,
  parseSkinDocument,
  parseSkinPatch,
  redoSkinChange,
  saveSkinDraft,
  serializeSkinDocument,
  undoSkinChange,
  validateSkin,
} from "./skinModel";

describe("skin draft collaboration", () => {
  it("starts from a valid, versioned skin", () => {
    const draft = createSkinDraft(DEFAULT_SKIN, "together");

    expect(draft.revision).toBe(0);
    expect(draft.dirty).toBe(false);
    expect(validateSkin(draft.config)).toEqual([]);
  });

  it("allows only the selected editors and attributes every accepted change", () => {
    const userOnly = createSkinDraft(DEFAULT_SKIN, "user");
    const rejectedAgent = applySkinPatch(userOnly, {
      actor: "agent",
      expectedRevision: 0,
      label: "Try violet ink",
      patch: { palette: { dark: { accent: "#8b5cf6" } } },
    });
    expect(rejectedAgent).toMatchObject({ ok: false, code: "actor_not_allowed" });

    const agentOnly = createSkinDraft(DEFAULT_SKIN, "agent");
    const rejectedUser = applySkinPatch(agentOnly, {
      actor: "user",
      label: "Try larger type",
      patch: { typography: { bodySize: 17 } },
    });
    expect(rejectedUser).toMatchObject({ ok: false, code: "actor_not_allowed" });

    const together = createSkinDraft(DEFAULT_SKIN, "together");
    const userEdit = applySkinPatch(together, {
      actor: "user",
      label: "Larger type",
      patch: { typography: { bodySize: 17 } },
    });
    expect(userEdit.ok).toBe(true);
    if (!userEdit.ok) return;
    const agentEdit = applySkinPatch(userEdit.state, {
      actor: "agent",
      expectedRevision: 1,
      label: "Softer corners",
      patch: { shape: { radius: 16 } },
    });
    expect(agentEdit.ok).toBe(true);
    if (!agentEdit.ok) return;
    expect(agentEdit.state.history.map((entry) => entry.actor)).toEqual(["user", "agent"]);
    expect(agentEdit.state.revision).toBe(2);
  });

  it("rejects stale agent edits rather than overwriting a newer user change", () => {
    const initial = createSkinDraft(DEFAULT_SKIN, "together");
    const userEdit = applySkinPatch(initial, {
      actor: "user",
      label: "Warm paper",
      patch: { palette: { light: { page: "#fff8e7" } } },
    });
    expect(userEdit.ok).toBe(true);
    if (!userEdit.ok) return;

    expect(applySkinPatch(userEdit.state, {
      actor: "agent",
      expectedRevision: 0,
      label: "Outdated proposal",
      patch: { palette: { light: { page: "#ffffff" } } },
    })).toMatchObject({ ok: false, code: "revision_conflict", currentRevision: 1 });
  });

  it("validates patches before changing the draft", () => {
    const draft = createSkinDraft(DEFAULT_SKIN, "together");
    const invalid = applySkinPatch(draft, {
      actor: "user",
      label: "Unreadably tiny",
      patch: { typography: { bodySize: 5 } },
    });

    expect(invalid).toMatchObject({ ok: false, code: "invalid_skin" });
    expect(draft.revision).toBe(0);
    expect(draft.config.typography.bodySize).toBe(DEFAULT_SKIN.typography.bodySize);
  });

  it("undoes and redoes without losing attribution", () => {
    const draft = createSkinDraft(DEFAULT_SKIN, "together");
    const changed = applySkinPatch(draft, {
      actor: "agent",
      expectedRevision: 0,
      label: "Compact spacing",
      patch: { spacing: { scale: 0.82 } },
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    const undone = undoSkinChange(changed.state, "user");
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.config.spacing.scale).toBe(DEFAULT_SKIN.spacing.scale);
    expect(undone.state.revision).toBe(2);
    expect(undone.state.dirty).toBe(false);
    expect(undone.state.future).toHaveLength(1);

    const redone = redoSkinChange(undone.state, "user");
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(redone.state.config.spacing.scale).toBe(0.82);
    expect(redone.state.revision).toBe(3);
    expect(redone.state.dirty).toBe(true);
    expect(redone.state.history.at(-1)?.actor).toBe("agent");
  });

  it("requires explicit permission before an agent can save", () => {
    const draft = createSkinDraft(DEFAULT_SKIN, "agent", false);
    expect(saveSkinDraft(draft, "agent", "Midnight violet")).toMatchObject({
      ok: false,
      code: "save_not_allowed",
    });

    const allowed = { ...draft, agentMaySave: true };
    const saved = saveSkinDraft(allowed, "agent", "Midnight violet");
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.saved.name).toBe("Midnight violet");
    expect(saved.saved.id).toMatch(/^midnight-violet-/);
    expect(saved.state.dirty).toBe(false);
    const numbered = saveSkinDraft(allowed, "agent", "Studio 2026");
    expect(numbered.ok && numbered.saved.id).toMatch(/^studio-2026-/);
  });

  it("refuses to save an invalid draft even when a caller bypasses the UI", () => {
    const draft = createSkinDraft(DEFAULT_SKIN, "user");
    draft.config.typography.bodySize = 2;

    const result = saveSkinDraft(draft, "user", "Broken skin");

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_skin",
      issues: ["Body size must be between 11 and 24."],
    });
  });

  it("returns explicit terminal failures and keeps user acceptance available", () => {
    const initial = createSkinDraft(DEFAULT_SKIN, "together");
    expect(undoSkinChange(initial, "user")).toMatchObject({ code: "nothing_to_undo" });
    expect(redoSkinChange(initial, "user")).toMatchObject({ code: "nothing_to_redo" });
    expect(undoSkinChange(createSkinDraft(DEFAULT_SKIN, "agent"), "user")).toMatchObject({ code: "actor_not_allowed" });
    expect(redoSkinChange(createSkinDraft(DEFAULT_SKIN, "user"), "agent")).toMatchObject({ code: "actor_not_allowed" });
    expect(saveSkinDraft(createSkinDraft(DEFAULT_SKIN, "user"), "agent", "No access")).toMatchObject({ code: "actor_not_allowed" });
    expect(saveSkinDraft(initial, "user", " ")).toMatchObject({ code: "invalid_name" });
    expect(saveSkinDraft(initial, "user", "x".repeat(81))).toMatchObject({ code: "invalid_name" });

    const unnamed = applySkinPatch(initial, { actor: "user", label: " ", patch: { shape: { radius: 13 } } });
    expect(unnamed.ok).toBe(true);
    if (!unnamed.ok) return;
    expect(unnamed.state.history[0]?.label).toBe("Updated skin");
    const saved = saveSkinDraft(unnamed.state, "user", "!!!");
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.saved.id).toMatch(/^skin-/);
  });
});

describe("skin document format", () => {
  it("round-trips a named skin and rejects unknown or malformed documents", () => {
    const encoded = serializeSkinDocument({
      name: "Soft graphite",
      config: DEFAULT_SKIN,
    });
    expect(parseSkinDocument(encoded)).toEqual({
      version: 1,
      name: "Soft graphite",
      config: DEFAULT_SKIN,
    });

    expect(() => parseSkinDocument("not json")).toThrow("valid JSON");
    expect(() => parseSkinDocument(JSON.stringify({
      version: 1,
      name: "Unsafe",
      config: { ...DEFAULT_SKIN, arbitraryCss: "body { display: none }" },
    }))).toThrow("unknown field");
  });

  it("rejects unknown agent patch fields instead of silently ignoring them", () => {
    expect(() => parseSkinPatch({ arbitraryCss: "hide everything" })).toThrow("unknown field");
    expect(parseSkinPatch({ shape: { radius: 14 }, canvas: { texture: "grid" } })).toEqual({
      shape: { radius: 14 },
      canvas: { texture: "grid" },
    });
  });

  it("parses every allow-listed patch section", () => {
    expect(parseSkinPatch({
      palette: { dark: { page: "#101010" }, light: { page: "#fafafa" } },
      typography: { bodySize: 16, userFont: "Kalam, cursive", bodyTracking: 0.01, headingTracking: -0.02, numericTracking: -0.03 },
      canvas: { texture: "off", gridGap: 24, surfaceOpacity: 0.82, blur: 20, saturation: 1.6, scrollFade: 24 },
      shape: { radius: 10, redrawOffset: 2, cornerStyle: "squircle" },
      spacing: { scale: 0.9 },
      motion: { reduce: true, pressScale: 0.97, curve: "spring", overscroll: "native" },
      accessibility: { transparency: "system", contrast: "more" },
      layout: { paneGap: 4 },
    })).toMatchObject({
      palette: { dark: { page: "#101010" }, light: { page: "#fafafa" } },
      typography: { bodySize: 16, userFont: "Kalam, cursive", headingTracking: -0.02 },
      canvas: { texture: "off", gridGap: 24, surfaceOpacity: 0.82, blur: 20, saturation: 1.6, scrollFade: 24 },
      shape: { radius: 10, redrawOffset: 2, cornerStyle: "squircle" },
      motion: { reduce: true, pressScale: 0.97, curve: "spring", overscroll: "native" },
      accessibility: { transparency: "system", contrast: "more" },
      layout: { paneGap: 4 },
    });
    expect(() => parseSkinPatch(null)).toThrow("must be an object");
    expect(() => parseSkinPatch({ palette: { sepia: {} } })).toThrow("unknown field");
  });

  it("upgrades older skin documents with the new global token defaults", () => {
    const legacy = structuredClone(DEFAULT_SKIN) as unknown as Record<string, Record<string, unknown>>;
    delete legacy.typography?.userFont;
    delete legacy.typography?.bodyTracking;
    delete legacy.typography?.headingTracking;
    delete legacy.typography?.numericTracking;
    delete legacy.canvas?.gridGap;
    delete legacy.canvas?.surfaceOpacity;
    delete legacy.canvas?.blur;
    delete legacy.canvas?.saturation;
    delete legacy.canvas?.scrollFade;
    delete legacy.shape?.redrawOffset;
    delete legacy.shape?.cornerStyle;
    delete legacy.motion?.pressScale;
    delete legacy.motion?.curve;
    delete legacy.motion?.overscroll;
    delete legacy.accessibility;

    const parsed = parseSkinDocument(JSON.stringify({ version: 1, name: "Legacy", config: legacy }));

    expect(parsed.config.typography.userFont).toBe(DEFAULT_SKIN.typography.userFont);
    expect(parsed.config.typography.headingTracking).toBe(DEFAULT_SKIN.typography.headingTracking);
    expect(parsed.config.canvas.gridGap).toBe(DEFAULT_SKIN.canvas.gridGap);
    expect(parsed.config.canvas.surfaceOpacity).toBe(DEFAULT_SKIN.canvas.surfaceOpacity);
    expect(parsed.config.shape.redrawOffset).toBe(DEFAULT_SKIN.shape.redrawOffset);
    expect(parsed.config.shape.cornerStyle).toBe(DEFAULT_SKIN.shape.cornerStyle);
    expect(parsed.config.motion.pressScale).toBe(DEFAULT_SKIN.motion.pressScale);
    expect(parsed.config.accessibility).toEqual(DEFAULT_SKIN.accessibility);
  });

  it("reports malformed names, versions, fields, values, and unsafe exports", () => {
    const invalid = structuredClone(DEFAULT_SKIN) as typeof DEFAULT_SKIN & Record<string, unknown>;
    invalid.palette.dark = { ...invalid.palette.dark, ink: "bad", page: "bad" };
    invalid.palette.light = {
      ...invalid.palette.light,
      page: "#ffffff",
      surface: "#ffffff",
      surfaceRaised: "#ffffff",
      ink: "#ffffff",
      inkStrong: "#ffffff",
    };
    invalid.typography = { ...invalid.typography, bodySize: 2, scale: 9, lineHeight: 0, bodyTracking: 1, headingTracking: -1, numericTracking: 1, uiFont: "x;{}", displayFont: "", userFont: "bad; font", monoFont: "x".repeat(181) };
    invalid.canvas = { texture: "noise", backdrop: "photo", intensity: 8, gridGap: 2, surfaceOpacity: 0, blur: 99, saturation: 9, scrollFade: 99 } as unknown as typeof invalid.canvas;
    invalid.shape = { radius: -1, borderWidth: 9, shadow: 4, redrawOffset: 9, cornerStyle: "sharp" as "round" };
    invalid.spacing = { scale: 4 };
    invalid.motion = { speed: 0, reduce: "no" as unknown as boolean, pressScale: 0.2, curve: "linear" as "calm", overscroll: "bounce" as "native" };
    invalid.accessibility = { transparency: "sometimes" as "system", contrast: "extreme" as "system" };
    invalid.layout = { railWidth: 1, sidebarWidth: 1, agentWidth: 1, paneGap: 99 };

    expect(validateSkin(invalid)).toEqual(expect.arrayContaining([
      expect.stringContaining("dark ink"),
      expect.stringContaining("contrast"),
      expect.stringContaining("Body size"),
      expect.stringContaining("User-written font"),
      expect.stringContaining("Grid gap"),
      expect.stringContaining("Surface opacity"),
      expect.stringContaining("Glass blur"),
      expect.stringContaining("Heading tracking"),
      expect.stringContaining("Press scale"),
      expect.stringContaining("Transparency preference"),
      expect.stringContaining("Redraw offset"),
      expect.stringContaining("Reduced motion"),
    ]));
    expect(() => serializeSkinDocument({ name: "Invalid", config: invalid })).toThrow("Cannot export");
    expect(() => serializeSkinDocument({ name: " ", config: DEFAULT_SKIN })).toThrow("Skin names");
    expect(() => parseSkinDocument("[]")).toThrow("must be an object");
    expect(() => parseSkinDocument(JSON.stringify({ version: 1 }))).toThrow("missing field");
    expect(() => parseSkinDocument(JSON.stringify({ version: 2, name: "Future", config: DEFAULT_SKIN }))).toThrow("version");
    expect(() => parseSkinDocument(JSON.stringify({ version: 1, name: " ", config: DEFAULT_SKIN }))).toThrow("name");
    expect(() => parseSkinDocument(JSON.stringify({ version: 1, name: "x".repeat(81), config: DEFAULT_SKIN }))).toThrow("name");
    expect(() => parseSkinDocument(JSON.stringify({ version: 1, name: "Invalid", config: invalid }))).toThrow("invalid");
  });

  it("enforces contrast at the 4.5:1 boundary", () => {
    const passing = structuredClone(DEFAULT_SKIN);
    passing.palette.light = {
      ...passing.palette.light,
      page: "#767676",
      surface: "#767676",
      surfaceRaised: "#767676",
      ink: "#000000",
      inkStrong: "#000000",
    };
    expect(validateSkin(passing).filter((issue) => issue.includes("light") && issue.includes("contrast"))).toEqual([]);

    const failing = structuredClone(passing);
    failing.palette.light.page = "#777777";
    failing.palette.light.surface = "#777777";
    failing.palette.light.surfaceRaised = "#777777";
    failing.palette.light.ink = "#ffffff";
    failing.palette.light.inkStrong = "#ffffff";
    expect(validateSkin(failing).filter((issue) => issue.includes("light") && issue.includes("contrast"))).toHaveLength(6);
  });
});
