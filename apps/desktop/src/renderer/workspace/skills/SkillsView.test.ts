import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomInfo, SkillBundle, SkillResourceContent } from "../../api";
import type { WSActions } from "../actions";
import type { WSState } from "../state";
import SkillsView from "./SkillsView";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({
  getSkill: vi.fn<(id: string) => Promise<SkillBundle>>(),
  onSkillsChanged: vi.fn<(listener: () => void) => Promise<() => void>>(),
  skillAgentIds: vi.fn<() => Promise<string[]>>(),
  composeSkill: vi.fn<(prompt: string, sourceIds: string[]) => Promise<string>>(),
  chooseOpenPath: vi.fn<(options: unknown) => Promise<string | string[] | null>>(),
  skillImportConflict: vi.fn<(path: string) => Promise<string | null>>(),
  importSkillFolder: vi.fn<(path: string, replace: boolean) => Promise<string>>(),
  exportSkillFolder: vi.fn<(id: string, destination: string) => Promise<void>>(),
  createSkill: vi.fn<(name: string, description: string, instructions: string, agent: string) => Promise<string>>(),
  updateSkill: vi.fn<(id: string, name: string, description: string, instructions: string, agent?: string) => Promise<void>>(),
  setSkillEnabled: vi.fn<(id: string, on: boolean) => Promise<void>>(),
  deleteSkill: vi.fn<(id: string) => Promise<void>>(),
  getSkillResource: vi.fn<(id: string, path: string) => Promise<SkillResourceContent>>(),
  saveSkillResource: vi.fn<(id: string, path: string, contents: { text: string }) => Promise<void>>(),
  deleteSkillResource: vi.fn<(id: string, path: string) => Promise<void>>(),
}));
const confirmMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock("../../api", () => ({ api: bridge, formatSize: (bytes: number) => `${bytes} B` }));
vi.mock("../../platform", () => ({ confirm: confirmMock }));
vi.mock("../../icons", () => ({
  BookOpenIcon: () => null,
  DownloadIcon: () => null,
  FileTypeIcon: () => null,
  FolderIcon: () => null,
  PaperclipIcon: () => null,
  PlusIcon: () => null,
  SaveIcon: () => null,
  SparklesIcon: () => null,
  TrashIcon: () => null,
}));
vi.mock("../composer", () => ({ displayName: (name: string) => name }));
vi.mock("../adaptiveText", () => ({ useAdaptiveText: () => null }));

const summary = {
  id: "skill-1",
  name: "review-contracts",
  description: "Review contracts when a supplier agreement is shared.",
  enabled: false,
  createdBy: "user" as const,
  agent: "legal",
  resourceCount: 2,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const bundle: SkillBundle = {
  skill: { ...summary, instructions: "Read the contract." },
  resources: [
    { path: "references/policy.md", kind: "reference", sizeBytes: 12, text: true, updatedAt: "2026-01-01" },
    { path: "assets/checklist.pdf", kind: "asset", sizeBytes: 24, text: false, updatedAt: "2026-01-01" },
  ],
};

const globalKeys = ["document", "window", "HTMLElement", "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.getSkill.mockResolvedValue(bundle);
  bridge.onSkillsChanged.mockResolvedValue(() => {});
  bridge.skillAgentIds.mockResolvedValue(["legal", "research"]);
  bridge.composeSkill.mockResolvedValue("created-by-ai");
  bridge.chooseOpenPath.mockResolvedValue(null);
  bridge.skillImportConflict.mockResolvedValue(null);
  bridge.importSkillFolder.mockResolvedValue("imported");
  bridge.exportSkillFolder.mockResolvedValue(undefined);
  bridge.createSkill.mockResolvedValue("created");
  bridge.updateSkill.mockResolvedValue(undefined);
  bridge.setSkillEnabled.mockResolvedValue(undefined);
  bridge.deleteSkill.mockResolvedValue(undefined);
  bridge.getSkillResource.mockImplementation(async (_id, path) => ({ path, kind: path.endsWith(".pdf") ? "asset" : "reference", text: path.endsWith(".pdf") ? null : "policy text", dataB64: null }));
  bridge.saveSkillResource.mockResolvedValue(undefined);
  bridge.deleteSkillResource.mockResolvedValue(undefined);
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
}

function state(selectedSkillId: string | null, skills = [summary]): WSState {
  return {
    selectedSkillId,
    skills,
    files: [
      { id: "file-1", name: "contract.pdf", mimeType: "application/pdf", sizeBytes: 20, hasText: true },
      { id: "file-2", name: "image.png", mimeType: "image/png", sizeBytes: 30, hasText: false },
    ],
    setSelectedSkillId: vi.fn(),
    pushToast: vi.fn(),
  } as unknown as WSState;
}

function actions(): WSActions {
  return { refreshSkills: vi.fn(async () => {}), openSkill: vi.fn() } as unknown as WSActions;
}

async function renderSkills(
  selectedSkillId: string | null = null,
  skills = [summary],
  files = state(null).files,
) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const s = state(selectedSkillId, skills);
  s.files = files;
  const a = actions();
  const render = async () => {
    await act(async () => {
      root.render(createElement(SkillsView, { s, a, info: { path: "/room" } as RoomInfo }));
    });
    await act(async () => {});
  };
  await render();
  return { a, host, render, root, s, window };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(host: Element, window: Window & typeof globalThis, label: string) {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => button.dispatchEvent(new window.Event("click", { bubbles: true })));
}

async function clickSelector(host: Element, window: Window & typeof globalThis, selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`button not found: ${selector}`);
  await act(async () => button.dispatchEvent(new window.Event("click", { bubbles: true })));
}

async function change(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    reactProps<{ onChange: (event: { target: { value: string } }) => void }>(input).onChange({ target: { value } });
  });
}

function sourceFiles(count: number): WSState["files"] {
  const template = state(null).files[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `source-${index + 1}`,
    name: `source-${index + 1}.md`,
    mimeType: "text/markdown",
    sizeBytes: index + 1,
    hasText: true,
  }));
}

beforeEach(resetBridge);
afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("SkillsView", () => {
  it("shows the empty-folder example and imports a replacement after consent", async () => {
    bridge.chooseOpenPath.mockResolvedValue("/imported-skill");
    bridge.skillImportConflict.mockResolvedValue("review-contracts");
    const view = await renderSkills(null, []);
    expect(view.host.textContent).toContain("No skills yet");
    expect(view.host.textContent).toContain("Not installed");
    await click(view.host, view.window, "Import folder");
    expect(bridge.importSkillFolder).toHaveBeenCalledWith("/imported-skill", true);
    await act(async () => view.root.unmount());
  });

  it("labels enabled, incomplete, and unknown-owner skills", async () => {
    const flagged = { ...summary, enabled: true, description: "", agent: "retired-agent" };
    const view = await renderSkills(null, [flagged]);
    expect(view.host.textContent).toContain("Enabled");
    expect(view.host.textContent).toContain("Incomplete");
    expect(view.host.textContent).toContain("Unknown owner");
    await act(async () => view.root.unmount());
  });

  it("browses skills and builds a draft from selected room files", async () => {
    const view = await renderSkills();
    expect(view.host.textContent).toContain("review-contracts");
    await click(view.host, view.window, "Add room files");
    const checkboxes = [...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => reactProps<{ onChange: () => void }>(checkboxes[0]!).onChange());
    expect(view.host.textContent).toContain("1 source");
    const composer = view.host.querySelector<HTMLTextAreaElement>(".sk-compose textarea");
    if (!composer) throw new Error("composer missing");
    await change(composer, "Build a contract reviewer");
    await click(view.host, view.window, "Build with AI");
    expect(bridge.composeSkill).toHaveBeenCalledWith("Build a contract reviewer", ["file-1"]);
    await click(view.host, view.window, "New skill");
    const inputs = [...view.host.querySelectorAll<HTMLInputElement>(".sk-field input")];
    await change(inputs[0]!, "Review Contracts");
    const description = view.host.querySelector<HTMLTextAreaElement>(".sk-field textarea");
    if (!description) throw new Error("description missing");
    await change(description, "Review a contract.");
    await click(view.host, view.window, "Save SKILL.md");
    expect(bridge.createSkill).toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("edits metadata, resources, enablement, export, and delete actions", async () => {
    const view = await renderSkills("skill-1");
    expect(view.host.textContent).toContain("Folder contents");
    bridge.chooseOpenPath.mockResolvedValueOnce("/export");
    await click(view.host, view.window, "Export folder");
    expect(bridge.exportSkillFolder).toHaveBeenCalledWith("skill-1", expect.any(String));
    const metadataName = view.host.querySelector<HTMLInputElement>(".sk-field input");
    if (!metadataName) throw new Error("metadata name missing");
    await change(metadataName, "review-contracts-updated");
    await clickSelector(view.host, view.window, ".sk-editor-head button.primary");
    expect(bridge.updateSkill).toHaveBeenCalledWith("skill-1", "review-contracts-updated", expect.any(String), expect.any(String), undefined);
    const enabled = view.host.querySelector<HTMLInputElement>(".sk-enable input");
    if (!enabled) throw new Error("enable switch missing");
    await act(async () => reactProps<{ onChange: (event: { target: { checked: boolean } }) => void }>(enabled).onChange({ target: { checked: true } }));
    expect(bridge.setSkillEnabled).toHaveBeenCalledWith("skill-1", true);
    await click(view.host, view.window, "policy.md");
    const resource = view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="references/policy.md contents"]');
    if (!resource) throw new Error("resource editor missing");
    await change(resource, "changed policy");
    await clickSelector(view.host, view.window, ".sk-file button.primary");
    expect(bridge.saveSkillResource).toHaveBeenCalledWith("skill-1", "references/policy.md", { text: "changed policy" });
    await click(view.host, view.window, "Remove");
    expect(bridge.deleteSkillResource).toHaveBeenCalledWith("skill-1", "references/policy.md");
    const newPath = view.host.querySelector<HTMLInputElement>('input[aria-label="New file path"]');
    if (!newPath) throw new Error("new resource input missing");
    await change(newPath, "scripts/check.py");
    await clickSelector(view.host, view.window, '.sk-res-add button[aria-label="Add this file"]');
    expect(bridge.saveSkillResource).toHaveBeenCalledWith("skill-1", "scripts/check.py", { text: "" });
    await click(view.host, view.window, "Delete skill");
    await click(view.host, view.window, "Delete permanently");
    expect(bridge.deleteSkill).toHaveBeenCalledWith("skill-1");
    await act(async () => view.root.unmount());
  });

  it("keeps the editor coherent when a selection changes or the open skill is deleted", async () => {
    const view = await renderSkills("skill-1");
    const metadataName = view.host.querySelector<HTMLInputElement>(".sk-field input");
    if (!metadataName) throw new Error("metadata name missing");
    await change(metadataName, "unsaved-name");
    view.s.selectedSkillId = "skill-2";
    confirmMock.mockResolvedValueOnce(false);
    await view.render();
    expect(view.s.setSelectedSkillId).toHaveBeenCalledWith("skill-1");

    view.s.selectedSkillId = null;
    view.s.skills = [];
    await view.render();
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("was deleted"));
    expect(view.host.textContent).toContain("Deleted elsewhere");
    await act(async () => view.root.unmount());
  });

  it("clears a clean editor for a normal selection change or a foreign deletion", async () => {
    const view = await renderSkills("skill-1");
    view.s.selectedSkillId = null;
    await view.render();
    expect(view.host.textContent).toContain("Skills");

    view.s.selectedSkillId = "skill-1";
    await view.render();
    view.s.selectedSkillId = null;
    view.s.skills = [];
    await view.render();
    expect(view.s.pushToast).toHaveBeenCalledWith("info", expect.stringContaining("was deleted"));
    await act(async () => view.root.unmount());
  });

  it("loads the newly selected skill after confirming that draft changes may be discarded", async () => {
    const view = await renderSkills("skill-1");
    const metadataName = view.host.querySelector<HTMLInputElement>(".sk-field input");
    if (!metadataName) throw new Error("metadata name missing");
    await change(metadataName, "discard-this-name");
    view.s.selectedSkillId = "skill-2";
    bridge.getSkill.mockResolvedValueOnce({ ...bundle, skill: { ...bundle.skill, id: "skill-2", name: "second-skill" } });
    confirmMock.mockResolvedValueOnce(true);
    await view.render();
    expect(bridge.getSkill).toHaveBeenLastCalledWith("skill-2");
    await act(async () => view.root.unmount());
  });

  it("refreshes a clean editor from skill changes and unregisters its listener", async () => {
    let changed: (() => void) | undefined;
    const unregister = vi.fn();
    bridge.onSkillsChanged.mockImplementation(async (listener) => {
      changed = listener;
      return unregister;
    });
    const view = await renderSkills("skill-1");
    await click(view.host, view.window, "policy.md");
    const refreshed = {
      ...bundle,
      skill: { ...bundle.skill, description: "New policy description" },
    };
    bridge.getSkill.mockResolvedValueOnce(refreshed);
    bridge.getSkillResource.mockResolvedValueOnce({ path: "references/policy.md", kind: "reference", text: "fresh policy", dataB64: null });
    await act(async () => {
      changed?.();
      await Promise.resolve();
    });
    const resource = view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="references/policy.md contents"]');
    expect(resource?.value).toBe("fresh policy");

    bridge.getSkill.mockResolvedValueOnce({ ...refreshed, resources: [] });
    await act(async () => {
      changed?.();
      await Promise.resolve();
    });
    expect(view.host.querySelector('textarea[aria-label="references/policy.md contents"]')).toBeNull();

    bridge.getSkill.mockRejectedValueOnce(new Error("background refresh failed"));
    await act(async () => {
      changed?.();
      await Promise.resolve();
    });
    expect(view.s.pushToast).not.toHaveBeenCalledWith("error", expect.stringContaining("background refresh failed"));
    await act(async () => view.root.unmount());
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("reports skill API failures while keeping their editors available", async () => {
    bridge.skillAgentIds.mockRejectedValueOnce(new Error("agents failed"));
    const browse = await renderSkills();
    await act(async () => {});
    expect(browse.s.pushToast).not.toHaveBeenCalled();
    bridge.composeSkill.mockRejectedValueOnce(new Error("compose failed"));
    const composer = browse.host.querySelector<HTMLTextAreaElement>(".sk-compose textarea");
    if (!composer) throw new Error("composer missing");
    await change(composer, "Build a reviewer");
    await click(browse.host, browse.window, "Build with AI");
    expect(browse.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("compose failed"));
    bridge.chooseOpenPath.mockResolvedValueOnce("/bad-import");
    bridge.importSkillFolder.mockRejectedValueOnce(new Error("import failed"));
    await click(browse.host, browse.window, "Import folder");
    expect(browse.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("import failed"));
    await act(async () => browse.root.unmount());

    bridge.getSkill.mockRejectedValueOnce(new Error("load failed"));
    const failedLoad = await renderSkills("skill-1");
    expect(failedLoad.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("load failed"));
    await act(async () => failedLoad.root.unmount());

    const view = await renderSkills("skill-1");
    bridge.chooseOpenPath.mockResolvedValueOnce("/export");
    bridge.exportSkillFolder.mockRejectedValueOnce(new Error("export failed"));
    await click(view.host, view.window, "Export folder");
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("export failed"));
    const enabled = view.host.querySelector<HTMLInputElement>(".sk-enable input");
    if (!enabled) throw new Error("enable switch missing");
    bridge.setSkillEnabled.mockRejectedValueOnce(new Error("toggle failed"));
    await act(async () => reactProps<{ onChange: (event: { target: { checked: boolean } }) => void }>(enabled).onChange({ target: { checked: true } }));
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("toggle failed"));
    await click(view.host, view.window, "Delete skill");
    bridge.deleteSkill.mockRejectedValueOnce(new Error("delete failed"));
    await click(view.host, view.window, "Delete permanently");
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("delete failed"));
    await act(async () => view.root.unmount());
  });

  it("reports metadata and resource write failures without discarding typed content", async () => {
    const view = await renderSkills("skill-1");
    const metadataName = view.host.querySelector<HTMLInputElement>(".sk-field input");
    if (!metadataName) throw new Error("metadata name missing");
    await change(metadataName, "will-not-save");
    bridge.getSkill.mockResolvedValueOnce({ ...bundle, skill: { ...bundle.skill, name: "remote-name" } });
    confirmMock.mockResolvedValueOnce(true);
    bridge.updateSkill.mockRejectedValueOnce(new Error("metadata failed"));
    await clickSelector(view.host, view.window, ".sk-editor-head button.primary");
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("metadata failed"));
    expect(metadataName.value).toBe("will-not-save");

    bridge.getSkillResource.mockRejectedValueOnce(new Error("open failed"));
    await click(view.host, view.window, "policy.md");
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("open failed"));
    bridge.getSkillResource.mockResolvedValueOnce({ path: "references/policy.md", kind: "reference", text: "policy text", dataB64: null });
    await click(view.host, view.window, "policy.md");
    const resource = view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="references/policy.md contents"]');
    if (!resource) throw new Error("resource editor missing");
    await change(resource, "pending policy");
    bridge.getSkillResource.mockResolvedValueOnce({ path: "references/policy.md", kind: "reference", text: "outside edit", dataB64: null });
    confirmMock.mockResolvedValueOnce(false);
    await clickSelector(view.host, view.window, ".sk-file button.primary");
    expect(bridge.saveSkillResource).not.toHaveBeenCalledWith("skill-1", "references/policy.md", { text: "pending policy" });
    bridge.getSkillResource.mockResolvedValueOnce({ path: "references/policy.md", kind: "reference", text: "pending policy", dataB64: null });
    bridge.saveSkillResource.mockRejectedValueOnce(new Error("resource save failed"));
    await clickSelector(view.host, view.window, ".sk-file button.primary");
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("resource save failed"));

    confirmMock.mockResolvedValueOnce(true);
    bridge.deleteSkillResource.mockRejectedValueOnce(new Error("resource delete failed"));
    await click(view.host, view.window, "Remove");
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("resource delete failed"));
    await act(async () => view.root.unmount());
  });

  it("covers discard, resource reload, and new-draft validation paths", async () => {
    const view = await renderSkills("skill-1");
    await click(view.host, view.window, "policy.md");
    await clickSelector(view.host, view.window, ".sk-res > button.sk-res-row");
    expect(view.host.querySelector('textarea[aria-label="references/policy.md contents"]')).toBeNull();

    const path = view.host.querySelector<HTMLInputElement>('input[aria-label="New file path"]');
    if (!path) throw new Error("new resource input missing");
    await change(path, "references/reload.md");
    bridge.getSkill.mockRejectedValueOnce(new Error("reload failed"));
    await clickSelector(view.host, view.window, '.sk-res-add button[aria-label="Add this file"]');
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("reload failed"));
    await change(path, "references/save.md");
    bridge.saveSkillResource.mockRejectedValueOnce(new Error("new resource failed"));
    await clickSelector(view.host, view.window, '.sk-res-add button[aria-label="Add this file"]');
    expect(view.s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("new resource failed"));
    await click(view.host, view.window, "All skills");
    await act(async () => view.root.unmount());

    const draft = await renderSkills();
    await click(draft.host, draft.window, "New skill");
    const name = draft.host.querySelector<HTMLInputElement>(".sk-field input");
    if (!name) throw new Error("new skill name missing");
    await change(name, ".");
    expect(draft.host.textContent).toContain("Skill names must be");
    await act(async () => draft.root.unmount());
  });

  it("handles source-picker keyboard paths, limits sources, and preserves a cancelled resource switch", async () => {
    const view = await renderSkills(null, [summary], sourceFiles(13));
    await click(view.host, view.window, "Add room files");
    const picker = view.host.querySelector('[aria-label="Choose source files"]');
    if (!picker) throw new Error("source picker missing");
    await act(async () => reactProps<{ onKeyDown: (event: { key: string; stopPropagation: () => void }) => void }>(picker).onKeyDown({ key: "Escape", stopPropagation: vi.fn() }));
    expect(view.host.querySelector('[aria-label="Choose source files"]')).toBeNull();
    await click(view.host, view.window, "Add room files");
    const checkboxes = [...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    for (const checkbox of checkboxes.slice(0, 12)) {
      await act(async () => reactProps<{ onChange: () => void }>(checkbox).onChange());
    }
    await act(async () => reactProps<{ onChange: () => void }>(checkboxes[12]!).onChange());
    expect(view.s.pushToast).toHaveBeenCalledWith("error", "Choose at most 12 source files for one skill.");
    await act(async () => view.root.unmount());

    const editor = await renderSkills("skill-1");
    await click(editor.host, editor.window, "policy.md");
    const resource = editor.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="references/policy.md contents"]');
    if (!resource) throw new Error("resource editor missing");
    await change(resource, "unsaved policy");
    confirmMock.mockResolvedValueOnce(false);
    await click(editor.host, editor.window, "SKILL.md");
    expect(editor.host.querySelector('textarea[aria-label="references/policy.md contents"]')).not.toBeNull();
    await act(async () => editor.root.unmount());

    const composer = await renderSkills(null, [summary, { ...summary, id: "skill-2", name: "summarize", createdAt: "2027-01-01" }]);
    const prompt = composer.host.querySelector<HTMLTextAreaElement>(".sk-compose textarea");
    if (!prompt) throw new Error("composer missing");
    await change(prompt, "Build with enter");
    let prevented = false;
    await act(async () => reactProps<{ onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => void }>(prompt).onKeyDown({ key: "Enter", shiftKey: false, preventDefault: () => { prevented = true; } }));
    expect(prevented).toBe(true);
    expect(bridge.composeSkill).toHaveBeenCalledWith("Build with enter", []);
    await act(async () => composer.root.unmount());
  });
});
