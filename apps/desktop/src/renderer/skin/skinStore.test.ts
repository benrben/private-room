import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SKIN, applySkinPatch, createSkinDraft, serializeSkinDocument } from "./skinModel";
import {
  DEFAULT_SKIN_ID,
  SKIN_STORAGE_KEY,
  activeSkinConfig,
  activateSavedSkin,
  applySkinVariables,
  defaultSkinWorkspace,
  deleteSavedSkin,
  discardSkinDraft,
  exportSkin,
  importSkin,
  initSkin,
  loadSkinWorkspace,
  persistSkinWorkspace,
  previewSkinDraft,
  redoDraft,
  resetSkinRuntimeForTests,
  resetSkinWorkspace,
  saveAndApplySkin,
  setAgentMaySave,
  setDraftName,
  setSkinMode,
  setSkinPreview,
  skinCssVariables,
  skinSnapshot,
  skinValidationSummary,
  undoDraft,
  updateSkinDraft,
} from "./skinStore";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

beforeEach(() => resetSkinRuntimeForTests());

describe("skin workspace persistence", () => {
  it("recovers an autosaved dirty draft but keeps the last saved skin active", () => {
    const storage = new MemoryStorage();
    const original = loadSkinWorkspace(storage);
    const changed = applySkinPatch(original.draft, {
      actor: "user",
      label: "Draft purple accent",
      patch: { palette: { dark: { accent: "#a78bfa" } } },
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    persistSkinWorkspace(storage, { ...original, draft: changed.state });
    const recovered = loadSkinWorkspace(storage);

    expect(recovered.draft.dirty).toBe(true);
    expect(recovered.draft.history).toHaveLength(1);
    expect(recovered.draft.history[0]?.label).toBe("Draft purple accent");
    expect(recovered.draft.config.palette.dark.accent).toBe("#a78bfa");
    expect(activeSkinConfig(recovered).palette.dark.accent).toBe(DEFAULT_SKIN.palette.dark.accent);
  });

  it("falls back safely when persisted data is corrupted", () => {
    const storage = new MemoryStorage();
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({ version: 99, draft: "bad" }));

    expect(loadSkinWorkspace(storage)).toMatchObject({
      version: 1,
      activeSkinId: "arcelle-default",
      draft: { revision: 0, dirty: false },
    });
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({ version: 1, draft: "bad" }));
    expect(loadSkinWorkspace(storage).activeSkinId).toBe(DEFAULT_SKIN_ID);
  });

  it("decodes saved skins, bounded history, and missing optional fields", () => {
    const storage = new MemoryStorage();
    const base = defaultSkinWorkspace();
    const config = structuredClone(DEFAULT_SKIN);
    config.shape.radius = 18;
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({
      ...base,
      activeSkinId: "saved-one",
      draftName: "x".repeat(90),
      draft: {
        ...base.draft,
        revision: -2,
        config,
        history: [{ actor: "agent", label: "x".repeat(140), revision: 3, before: DEFAULT_SKIN, after: config }],
        future: null,
      },
      saved: [{ id: "saved-one", version: 1, name: "Saved one", config, savedBy: "system" }],
    }));

    const loaded = loadSkinWorkspace(storage);
    expect(loaded.activeSkinId).toBe("saved-one");
    expect(loaded.draftName).toHaveLength(80);
    expect(loaded.draft.revision).toBe(0);
    expect(loaded.draft.history[0]).toMatchObject({ actor: "agent", revision: 3 });
    expect(loaded.saved[0]).toMatchObject({ savedBy: "user", savedAt: new Date(0).toISOString() });
    expect(activeSkinConfig(loaded).shape.radius).toBe(18);

    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({ ...base, activeSkinId: "missing", saved: [] }));
    expect(loadSkinWorkspace(storage).activeSkinId).toBe(DEFAULT_SKIN_ID);
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({ ...base, saved: [{ version: 1 }] }));
    expect(loadSkinWorkspace(storage).activeSkinId).toBe(DEFAULT_SKIN_ID);
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({ ...base, draft: { ...base.draft, history: [{}] } }));
    expect(loadSkinWorkspace(storage).draft.history).toEqual([]);
  });

  it("keeps working when persistence throws", () => {
    const storage = new MemoryStorage();
    Object.defineProperty(storage, "setItem", { value: () => { throw new Error("full"); } });
    expect(() => persistSkinWorkspace(storage, defaultSkinWorkspace())).not.toThrow();
  });
});

describe("skin runtime variables", () => {
  it("maps the allow-listed config to existing design tokens and layout variables", () => {
    const config = createSkinDraft(DEFAULT_SKIN).config;
    const vars = skinCssVariables(config, "dark");

    expect(vars["--page"]).toBe(DEFAULT_SKIN.palette.dark.page);
    expect(vars["--accent"]).toBe(DEFAULT_SKIN.palette.dark.accent);
    expect(vars["--font-ui"]).toContain("Inter");
    expect(vars["--font-user"]).toContain("Kalam");
    expect(vars["--hand"]).toContain("Kalam");
    expect(vars["--mk-yellow"]).toBe(DEFAULT_SKIN.palette.dark.warning);
    expect(vars["--mk-green-ink"]).toBe(DEFAULT_SKIN.palette.dark.success);
    expect(vars["--mk-blue"]).toBe(DEFAULT_SKIN.palette.dark.info);
    expect(vars["--mk-red-ink"]).toBe(DEFAULT_SKIN.palette.dark.danger);
    expect(vars["--grid-gap"]).toBe("22px");
    expect(vars["--redraw"]).toBe("2px");
    expect(vars["--fs-meta"]).toBe("14px");
    expect(vars["--fs-micro"]).toBe("13px");
    expect(vars["--fs-hand"]).toBe("16px");
    expect(vars["--fs-hand-lg"]).toBe("24px");
    expect(vars["--lh-hand"]).toBe("1.45");
    expect(vars["--sp-5"]).toBe("1.25rem");
    expect(vars["--skin-surface-opacity"]).toBe("86%");
    expect(vars["--surface-glass"]).toContain("var(--skin-surface-opacity)");
    expect(vars["--raised-glass"]).toContain("var(--skin-raised-opacity)");
    expect(vars["--glass-blur"]).toBe("18px");
    expect(vars["--glass-saturation"]).toBe("1.4");
    expect(vars["--scroll-fade"]).toBe("18px");
    expect(vars["--tracking-body"]).toBe("0em");
    expect(vars["--tracking-heading"]).toBe("-0.02em");
    expect(vars["--tracking-numeric"]).toBe("-0.02em");
    expect(vars["--press-scale"]).toBe("0.97");
    expect(vars["--motion-ease"]).toContain("cubic-bezier");
    expect(vars["--skin-overscroll"]).toBe("auto");
    expect(vars["--skin-sidebar-width"]).toBe("260px");
    expect(vars["--skin-space-scale"]).toBe("1");
    expect(vars["--shadow"]).toBe("rgba(0, 0, 0, 0.315)");
    expect(vars["--accent-ink"]).toBe("#151716");
    const lightVars = skinCssVariables(config, "light");
    expect(lightVars["--shadow"]).toBe("rgba(0, 0, 0, 0.108)");
    expect(lightVars["--accent-ink"]).toBe("#fbfaf4");
    const boundaryAccent = structuredClone(config);
    boundaryAccent.palette.dark.accent = "#b8b8b8";
    expect(skinCssVariables(boundaryAccent, "dark")["--accent-ink"]).toBe("#151716");
    expect(Object.keys(vars)).not.toContain("arbitraryCss");
  });

  it("applies light, reduced-motion variables to an element", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const config = structuredClone(DEFAULT_SKIN);
    config.motion.reduce = true;
    config.shape.radius = 2;
    config.shape.cornerStyle = "squircle";
    config.accessibility.transparency = "reduce";
    config.accessibility.contrast = "more";
    applySkinVariables(document.documentElement as unknown as HTMLElement, config, "light");
    expect(document.documentElement.dataset).toMatchObject({
      skin: "custom",
      skinTexture: "dots",
      skinBackdrop: "glow",
      skinMotion: "reduced",
      skinCorners: "squircle",
      skinTransparency: "reduce",
      skinContrast: "more",
    });
    expect(document.documentElement.style.getPropertyValue("--dur")).toBe("0ms");
    expect(document.documentElement.style.getPropertyValue("--accent-ink")).toBeTruthy();
  });

  it("previews a valid gesture without persisting it and restores after invalid input", () => {
    const parsed = parseHTML("<html data-theme='dark'><body></body></html>");
    const originals = { window: Reflect.get(globalThis, "window"), document: Reflect.get(globalThis, "document") };
    Object.defineProperty(parsed.window, "localStorage", { configurable: true, value: new MemoryStorage() });
    Reflect.set(globalThis, "window", parsed.window);
    Reflect.set(globalThis, "document", parsed.document);
    try {
      resetSkinRuntimeForTests();
      resetSkinWorkspace();
      expect(previewSkinDraft({ actor: "user", label: "Preview blue", patch: { palette: { dark: { accent: "#5aa0dc" } } } })).toMatchObject({ ok: true });
      expect(parsed.document.documentElement.style.getPropertyValue("--accent")).toBe("#5aa0dc");
      expect(skinSnapshot().draft).toMatchObject({ revision: 0, history: [] });

      expect(previewSkinDraft({ actor: "user", label: "Unsafe", patch: { typography: { uiFont: "bad; font" } } })).toMatchObject({ ok: false, code: "invalid_skin" });
      expect(parsed.document.documentElement.style.getPropertyValue("--accent")).toBe(DEFAULT_SKIN.palette.dark.accent);
      expect(skinSnapshot().draft.revision).toBe(0);
    } finally {
      resetSkinRuntimeForTests();
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) Reflect.deleteProperty(globalThis, key);
        else Reflect.set(globalThis, key, value);
      }
    }
  });
});

describe("skin workspace commands", () => {
  it("supports the complete draft, save, activation, deletion, import, and discard lifecycle", () => {
    expect(skinSnapshot()).toMatchObject({ activeSkinId: DEFAULT_SKIN_ID });
    resetSkinWorkspace();
    setSkinMode("together");
    setAgentMaySave(true);
    setDraftName("First skin");
    setSkinPreview(true);

    expect(undoDraft("user")).toMatchObject({ code: "nothing_to_undo" });
    expect(redoDraft("user")).toMatchObject({ code: "nothing_to_redo" });
    expect(updateSkinDraft({ actor: "user", label: "Invalid", patch: { shape: { radius: 99 } } })).toMatchObject({ code: "invalid_skin" });
    expect(updateSkinDraft({ actor: "user", label: "Rounded", patch: { shape: { radius: 16 } } })).toMatchObject({ ok: true });
    expect(undoDraft("agent", 0)).toMatchObject({ code: "revision_conflict" });
    expect(undoDraft("user")).toMatchObject({ ok: true });
    expect(redoDraft("user")).toMatchObject({ ok: true });

    const first = saveAndApplySkin("user");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = first.saved.id;
    expect(activateSavedSkin(DEFAULT_SKIN_ID)).toBe(true);
    expect(activateSavedSkin(firstId)).toBe(true);
    expect(activateSavedSkin("missing")).toBe(false);
    expect(deleteSavedSkin(DEFAULT_SKIN_ID)).toBe(false);
    expect(deleteSavedSkin("missing")).toBe(false);

    setDraftName("Second skin");
    expect(updateSkinDraft({ actor: "user", label: "Larger", patch: { typography: { bodySize: 16 } } }).ok).toBe(true);
    const second = saveAndApplySkin("user");
    expect(second.ok).toBe(true);
    expect(deleteSavedSkin(firstId)).toBe(true);
    if (!second.ok) return;
    expect(skinSnapshot().activeSkinId).toBe(second.saved.id);
    expect(deleteSavedSkin(second.saved.id)).toBe(true);
    expect(skinSnapshot().activeSkinId).toBe(DEFAULT_SKIN_ID);

    const importedConfig = structuredClone(DEFAULT_SKIN);
    importedConfig.canvas.texture = "grid";
    const source = serializeSkinDocument({ name: "Imported", config: importedConfig });
    expect(importSkin(source)).toMatchObject({ ok: true });
    expect(skinSnapshot().draft).toMatchObject({ revision: 1, dirty: true });
    expect(exportSkin()).toContain('"name": "Imported"');
    expect(importSkin("bad json")).toMatchObject({ code: "invalid_skin" });
    discardSkinDraft();
    expect(skinValidationSummary()).toEqual({ valid: true, issues: [] });
  });

  it("updates a same-named skin instead of creating indistinguishable duplicates", () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    resetSkinWorkspace();
    setDraftName("Night reading");
    expect(updateSkinDraft({ actor: "user", label: "Round it", patch: { shape: { radius: 16 } } }).ok).toBe(true);
    const first = saveAndApplySkin("user");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    skinSnapshot().saved.push(
      { ...first.saved, id: "unrelated", name: "Other skin" },
      { ...first.saved, id: "old-duplicate" },
    );
    expect(updateSkinDraft({ actor: "user", label: "Round it more", patch: { shape: { radius: 20 } } }).ok).toBe(true);
    setDraftName("  NIGHT READING  ");
    const second = saveAndApplySkin("user");

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.saved.id).toBe(first.saved.id);
    expect(skinSnapshot().saved).toHaveLength(2);
    expect(skinSnapshot().saved.map((skin) => skin.id)).toEqual([first.saved.id, "unrelated"]);
    expect(skinSnapshot().saved[0]).toMatchObject({ id: first.saved.id, name: "NIGHT READING" });
    expect(skinSnapshot().saved[0]?.config.shape.radius).toBe(20);
    now.mockRestore();
  });

  it("initializes from browser storage, observes theme changes, and emits layout details", async () => {
    const parsed = parseHTML("<html data-theme='dark'><body></body></html>");
    const storage = new MemoryStorage();
    const originals = {
      window: Reflect.get(globalThis, "window"),
      document: Reflect.get(globalThis, "document"),
      MutationObserver: Reflect.get(globalThis, "MutationObserver"),
    };
    Object.defineProperty(parsed.window, "localStorage", { configurable: true, value: storage });
    Reflect.set(globalThis, "window", parsed.window);
    Reflect.set(globalThis, "document", parsed.document);
    Reflect.set(globalThis, "MutationObserver", parsed.window.MutationObserver);
    const details: unknown[] = [];
    parsed.window.addEventListener("arcelle-skin-layout", (event) => details.push((event as CustomEvent).detail));

    try {
      resetSkinRuntimeForTests();
      initSkin();
      expect(details.at(-1)).toMatchObject({ enabled: false, layout: DEFAULT_SKIN.layout });
      parsed.document.documentElement.setAttribute("data-theme", "light");
      await Promise.resolve();
      expect(parsed.document.documentElement.style.getPropertyValue("--page")).toBe(DEFAULT_SKIN.palette.light.page);
      initSkin();
      setSkinPreview(true);
      expect(parsed.document.documentElement.style.getPropertyValue("--page")).toBe(DEFAULT_SKIN.palette.light.page);
      expect(details.at(-1)).toMatchObject({ enabled: true, layout: DEFAULT_SKIN.layout });
    } finally {
      resetSkinRuntimeForTests();
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) Reflect.deleteProperty(globalThis, key);
        else Reflect.set(globalThis, key, value);
      }
    }
  });

  it("decodes collaboration flags strictly", () => {
    const storage = new MemoryStorage();
    const base = defaultSkinWorkspace();
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({
      ...base,
      draft: { ...base.draft, mode: "agent", agentMaySave: 1 },
    }));
    expect(loadSkinWorkspace(storage).draft).toMatchObject({ mode: "agent", agentMaySave: false });
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify({
      ...base,
      draft: { ...base.draft, mode: "user", agentMaySave: true },
    }));
    expect(loadSkinWorkspace(storage).draft).toMatchObject({ mode: "user", agentMaySave: true });
  });
});
