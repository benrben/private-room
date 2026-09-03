import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApi } from "../shell/useLayout";
import {
  activateSavedSkin,
  resetSkinRuntimeForTests,
  resetSkinWorkspace,
  saveAndApplySkin,
  setAgentMaySave,
  setDraftName,
  setSkinMode,
  skinSnapshot,
  updateSkinDraft,
} from "./skinStore";
import { DEFAULT_SKIN, serializeSkinDocument } from "./skinModel";

const { act, createElement, Fragment } = React;
const globalKeys = [
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement",
  "HTMLTextAreaElement", "HTMLSelectElement", "Event", "CustomEvent",
  "MutationObserver", "Blob", "URL", "React", "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

let testWindow: Window & typeof globalThis;
let testDocument: Document;

function installDom(): void {
  const parsed = parseHTML("<html data-theme='dark'><body><div id='root'></div></body></html>");
  testWindow = parsed.window as unknown as Window & typeof globalThis;
  testDocument = parsed.document as unknown as Document;
  Object.defineProperty(testWindow, "localStorage", { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(testWindow.URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:skin") });
  Object.defineProperty(testWindow.URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  for (const key of globalKeys) {
    if (key === "React" || key === "IS_REACT_ACT_ENVIRONMENT") continue;
    Reflect.set(globalThis, key, Reflect.get(testWindow, key));
  }
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
}

function button(label: string): HTMLButtonElement {
  const buttons = [...testDocument.querySelectorAll("button")];
  const found = buttons.find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label)
    ?? buttons.find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found as HTMLButtonElement;
}

function reactHandler<T>(element: Element, name: string): T {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  const handler = key ? (element as unknown as Record<string, Record<string, T>>)[key]?.[name] : undefined;
  if (!handler) throw new Error(`Missing React ${name} handler.`);
  return handler;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    reactHandler<() => void>(element, "onClick")();
    await Promise.resolve();
  });
}

async function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    reactHandler<(event: { target: { value: string } }) => void>(element, "onChange")({ target: { value } });
    await Promise.resolve();
  });
}

async function blur(element: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    reactHandler<() => void>(element, "onBlur")();
    await Promise.resolve();
  });
}

async function keyDown(element: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    reactHandler<(event: { key: string; currentTarget: HTMLInputElement }) => void>(element, "onKeyDown")({ key, currentTarget: element });
    await Promise.resolve();
  });
}

async function toggle(element: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    reactHandler<(event: { target: { checked: boolean } }) => void>(element, "onChange")({ target: { checked } });
    await Promise.resolve();
  });
}

beforeEach(() => {
  installDom();
  resetSkinRuntimeForTests();
  resetSkinWorkspace();
});

afterEach(() => {
  resetSkinRuntimeForTests();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("Skin Studio", () => {
  it("drives manual, collaborative, saved, portable, layout, and agent workflows", async () => {
    const { SkinControls } = await import("./SkinControls");
    const { SkinStudio } = await import("./SkinStudio");
    const applyPreset = vi.fn();
    const setQuestion = vi.fn();
    const showAgent = vi.fn();
    const layout = { applyPreset } as unknown as LayoutApi;
    const host = testDocument.getElementById("root");
    if (!host) throw new Error("Test root missing.");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);
    const render = (question: string) => root.render(createElement(Fragment, null,
      createElement(SkinControls),
      createElement(SkinStudio, { layout, question, setQuestion, showAgent }),
    ));

    await act(async () => {
      render("Existing question");
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Skin Studio");
    expect(host.textContent).toContain("User-written font");
    expect(host.textContent).toContain("Heading tracking");
    expect(host.textContent).toContain("Surface opacity");
    expect(host.textContent).toContain("Press depth");
    expect(host.textContent).toContain("Reduced transparency");
    expect(host.textContent).toContain("Valid draft");
    expect(host.textContent).toContain("safe skin document");
    expect(host.textContent).toContain("Move a control or ask the Design agent");
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
    expect(button("Discard").disabled).toBe(true);
    expect(button("Save & apply").disabled).toBe(false);
    expect(button("dark").getAttribute("aria-selected")).toBe("true");
    expect(button("light").getAttribute("aria-selected")).toBe("false");
    expect(button("Together").getAttribute("aria-checked")).toBe("true");
    expect(button("User only").getAttribute("aria-checked")).toBe("false");

    await click(button("User only"));
    expect(button("User only").getAttribute("aria-checked")).toBe("true");
    const userOnlyHandoff = testDocument.querySelector(".skin-agent-handoff textarea") as HTMLTextAreaElement;
    expect(userOnlyHandoff.disabled).toBe(true);
    expect(button("Open in Assistant").disabled).toBe(true);
    expect(testDocument.querySelector(".skin-agent-handoff")?.textContent).toContain("User-only mode");
    await click(button("Agent only"));
    expect(host.textContent).toContain("Manual controls are locked");
    expect(host.textContent).toContain("Agent only");
    expect(button("Undo").disabled).toBe(true);
    expect(testDocument.querySelector(".skin-mode-chip")?.textContent).toContain("Agent only");
    await click(button("Together"));
    expect(button("Together").getAttribute("aria-checked")).toBe("true");
    const permission = testDocument.querySelector(".skin-collaboration input[type='checkbox']") as HTMLInputElement;
    await toggle(permission, true);

    const draftName = testDocument.querySelector(".skin-studio-bar input") as HTMLInputElement;
    await change(draftName, "Test skin");
    await click(button("light"));
    expect(button("light").getAttribute("aria-selected")).toBe("true");
    expect(button("dark").getAttribute("aria-selected")).toBe("false");
    const colors = [...testDocument.querySelectorAll(".skin-swatch input")] as HTMLInputElement[];
    await change(colors[0], "#f0f0f0");
    await blur(colors[0]);
    await change(colors[3], "#f0f0f0");
    await blur(colors[3]);
    expect(testDocument.querySelector("[role='alert']")?.textContent).toContain("Change rejected; draft unchanged");
    expect(testDocument.querySelector("[role='alert']")?.textContent).toContain("contrast");
    expect(button("Save & apply").disabled).toBe(false);
    await act(async () => activateSavedSkin("arcelle-default"));
    expect(testDocument.querySelector("[role='alert']")).toBeNull();
    await click(button("light"));
    const refreshedColors = [...testDocument.querySelectorAll(".skin-swatch input")] as HTMLInputElement[];
    await change(refreshedColors[3], "#303030");
    await blur(refreshedColors[3]);

    const textFields = [...testDocument.querySelectorAll(".skin-text-field input")] as HTMLInputElement[];
    const blurSpy = vi.spyOn(textFields[0]!, "blur").mockImplementation(() => undefined);
    await keyDown(textFields[0]!, "Enter");
    expect(blurSpy).toHaveBeenCalledTimes(1);
    await keyDown(textFields[0]!, "Escape");
    expect(blurSpy).toHaveBeenCalledTimes(2);
    await keyDown(textFields[0]!, "ArrowDown");
    expect(blurSpy).toHaveBeenCalledTimes(2);
    blurSpy.mockRestore();
    const historyBeforeFont = skinSnapshot().draft.history.length;
    await change(textFields[0], "F");
    await change(textFields[0], "Figtree, sans-serif");
    expect(skinSnapshot().draft.history).toHaveLength(historyBeforeFont);
    await blur(textFields[0]);
    expect(skinSnapshot().draft.history).toHaveLength(historyBeforeFont + 1);
    await change(textFields[1], "Georgia, serif");
    await blur(textFields[1]);
    await change(textFields[2], "Kalam, cursive");
    await blur(textFields[2]);
    await change(textFields[3], "Menlo, monospace");
    await blur(textFields[3]);

    const selects = [...testDocument.querySelectorAll(".skin-select select")] as HTMLSelectElement[];
    await change(selects[0], "grid");
    await change(selects[1], "aurora");
    await change(selects[2], "squircle");
    await change(selects[3], "spring");
    await change(selects[4], "contained");
    await change(selects[5], "reduce");
    await change(selects[6], "more");
    const rangeValues = ["16", "1.1", "1.6", "0.01", "-0.03", "-0.02", "0.4", "24", "0.75", "24", "1.5", "20", "14", "1.5", "0.3", "2", "1.1", "1.2", "0.96", "90", "280", "360", "10"];
    const ranges = [...testDocument.querySelectorAll("input[type='range']")] as HTMLInputElement[];
    expect(ranges).toHaveLength(rangeValues.length);
    for (const [index, range] of ranges.entries()) await change(range, rangeValues[index] ?? range.value);
    expect(button("Undo").disabled).toBe(false);
    expect(button("Discard").disabled).toBe(false);
    const reduceMotion = [...testDocument.querySelectorAll(".skin-check input[type='checkbox']")][1] as HTMLInputElement;
    await toggle(reduceMotion, true);

    await click(button("Undo"));
    expect(button("Redo").disabled).toBe(false);
    await click(button("Agent only"));
    expect(button("Redo").disabled).toBe(true);
    expect(testDocument.querySelector(".skin-mode-chip")?.textContent).toContain("Agent only");
    await click(button("Together"));
    await click(button("Redo"));
    await change(draftName, " ");
    await click(button("Save & apply"));
    expect(testDocument.querySelector("[role='status']")?.textContent).toContain("Skin names");
    await click(button("Dismiss message"));
    await change(draftName, "Test skin");
    await click(button("Save & apply"));
    expect(host.textContent).toContain("Saved and applied");
    expect(testDocument.querySelector(".skin-history-list")?.textContent).toContain("You");
    const userActor = testDocument.querySelector(".skin-history-list .skin-actor.is-user");
    const userActorIcon = userActor?.innerHTML;
    expect(userActorIcon).toBeTruthy();
    expect(userActor?.querySelector("path")?.getAttribute("d")).toBe("M17 3.5a2.3 2.3 0 0 1 3.3 3.3L7.5 19.8l-4.2 1 1-4.2L17 3.5z");

    await act(async () => {
      activateSavedSkin("arcelle-default");
      setSkinMode("agent");
      setAgentMaySave(true);
      setDraftName("Agent skin");
      updateSkinDraft({ actor: "agent", expectedRevision: 0, label: "Agent contrast", patch: { shape: { radius: 18 } } });
      saveAndApplySkin("agent", "Agent skin", 1);
    });
    expect(testDocument.querySelector(".skin-history-list")?.textContent).toContain("Design agent");
    const agentActor = testDocument.querySelector(".skin-history-list .skin-actor.is-agent");
    expect(agentActor?.innerHTML).not.toBe(userActorIcon);
    expect(agentActor?.querySelector("path")?.getAttribute("d")).toBe("M11 4.5 12.4 8.6 16.5 10 12.4 11.4 11 15.5 9.6 11.4 5.5 10 9.6 8.6z");
    await click(button("Arcelle default"));
    expect(host.textContent).toContain("Saved by agent");
    expect(host.textContent).toContain("Saved by you");
    await click(button("Test skin"));
    expect(host.textContent).toContain("Built in");
    await click(button("Delete Test skin"));

    await click(button("Canvas focus"));
    await click(button("Research"));
    await click(button("Review"));
    expect(applyPreset.mock.calls.map(([name]) => name)).toEqual(["focus", "research", "review"]);

    const textarea = testDocument.querySelector(".skin-agent-handoff textarea") as HTMLTextAreaElement;
    await change(textarea, "Make it warmer");
    await click(button("Open in Assistant"));
    expect(setQuestion).toHaveBeenCalledWith("Existing question\n\n*design Make it warmer");
    expect(showAgent).toHaveBeenCalled();
    await act(async () => render(""));
    const nextTextarea = testDocument.querySelector(".skin-agent-handoff textarea") as HTMLTextAreaElement;
    await change(nextTextarea, "Use quiet blue");
    await click(button("Open in Assistant"));
    expect(setQuestion).toHaveBeenCalledWith("*design Use quiet blue");

    const importInput = testDocument.querySelector("input[type='file']") as HTMLInputElement;
    const clickSpy = vi.spyOn(importInput, "click");
    await click(button("Import JSON"));
    expect(clickSpy).toHaveBeenCalled();
    const imported = structuredClone(DEFAULT_SKIN);
    imported.canvas.texture = "off";
    const validFile = { text: vi.fn(async () => serializeSkinDocument({ name: "Imported skin", config: imported })) } as unknown as File;
    Object.defineProperty(importInput, "files", { configurable: true, value: [validFile] });
    await act(async () => {
      reactHandler<(event: { target: HTMLInputElement }) => void>(importInput, "onChange")({ target: importInput });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Skin imported as a draft");
    const invalidFile = { text: vi.fn(async () => "not json") } as unknown as File;
    Object.defineProperty(importInput, "files", { configurable: true, value: [invalidFile] });
    await act(async () => {
      reactHandler<(event: { target: HTMLInputElement }) => void>(importInput, "onChange")({ target: importInput });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("valid JSON");
    Object.defineProperty(importInput, "files", { configurable: true, value: [] });
    await act(async () => reactHandler<(event: { target: HTMLInputElement }) => void>(importInput, "onChange")({ target: importInput }));

    await click(button("Export JSON"));
    expect(testWindow.URL.createObjectURL).toHaveBeenCalled();
    Object.defineProperty(testWindow.URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => { throw new Error("export blocked"); }),
    });
    await click(button("Export JSON"));
    expect(host.textContent).toContain("export blocked");
    await click(button("Dismiss message"));

    await act(async () => {
      skinSnapshot().draft.config.typography.bodySize = 2;
      setDraftName("Invalid live draft");
    });
    expect(button("Save & apply").disabled).toBe(true);
    await act(async () => {
      skinSnapshot().draft.config.typography.bodySize = DEFAULT_SKIN.typography.bodySize;
      setDraftName("Test skin");
    });

    await act(async () => {
      setSkinMode("together");
      activateSavedSkin("arcelle-default");
      updateSkinDraft({ actor: "user", label: "Discard me", patch: { shape: { radius: 9 } } });
    });
    await click(button("Discard"));
    expect(host.textContent).toContain("Draft discarded");
    expect(host.textContent).toContain("allow-list; arbitrary CSS and scripts are rejected");
    expect(host.textContent).toContain("allow-listed patch, explain it, and validate contrast");
    await act(async () => root.unmount());
  });
});
