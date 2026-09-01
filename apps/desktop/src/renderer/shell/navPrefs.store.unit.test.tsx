import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../icons", () => ({
  BookOpenIcon: () => null,
  CreateIcon: () => null,
  FolderIcon: () => null,
  GlobeIcon: () => null,
  GraphIcon: () => null,
  HomeIcon: () => null,
  LinkIcon: () => null,
  MemoryIcon: () => null,
  MicIcon: () => null,
  ScriptIcon: () => null,
  SketchIcon: () => null,
  WorkflowsIcon: () => null,
}));
vi.mock("../workspace/types", () => ({
  WORK_AREAS: [
    "home", "files", "recordings", "browser", "sketch", "create", "map",
    "workflows", "scripts", "skills", "connectors", "memory",
  ],
}));

import { defaultPrefs, useNavPrefs } from "./navPrefs";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "localStorage"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];

let values = new Map<string, string>();
let writeFails = false;
let removeFails = false;
const storage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  removeItem: vi.fn((key: string) => {
    if (removeFails) throw new Error("fabricated private storage");
    values.delete(key);
  }),
  setItem: vi.fn((key: string, value: string) => {
    if (writeFails) throw new Error("fabricated private storage");
    values.set(key, value);
  }),
};

function installDom(): void {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

async function render(): Promise<() => ReturnType<typeof useNavPrefs>> {
  const host = document.getElementById("root");
  if (!host) throw new Error("Fabricated navigation root missing.");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  roots.push(root);
  let current: ReturnType<typeof useNavPrefs> | null = null;
  function Probe(): null {
    current = useNavPrefs();
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  return () => {
    if (current === null) throw new Error("Fabricated navigation hook has not rendered.");
    return current;
  };
}

beforeEach(() => {
  installDom();
  values = new Map();
  writeFails = false;
  removeFails = false;
  storage.getItem.mockClear();
  storage.removeItem.mockClear();
  storage.setItem.mockClear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("navigation preferences store with fabricated local storage", () => {
  it("loads once, notifies hook callbacks, and keeps in-memory changes when storage writes fail", async () => {
    const stored = defaultPrefs();
    stored.pinned = ["home"];
    values.set("prNav:v1", JSON.stringify(stored));
    const current = await render();

    expect(current().pinned).toEqual(["home"]);
    expect(storage.getItem).toHaveBeenCalledWith("prNav:v1");

    await act(async () => current().togglePin("files"));
    expect(current().pinned).toEqual(["home", "files"]);
    expect(JSON.parse(values.get("prNav:v1") ?? "{}")).toMatchObject({ pinned: ["home", "files"] });

    await act(async () => current().move("files", -1));
    expect(current().prefs.order.slice(0, 2)).toEqual(["files", "home"]);
    const writesAfterMove = storage.setItem.mock.calls.length;
    await act(async () => current().move("files", -1));
    expect(storage.setItem).toHaveBeenCalledTimes(writesAfterMove);

    writeFails = true;
    await act(async () => current().togglePin("files"));
    expect(current().pinned).toEqual(["home"]);
    expect(storage.setItem).toHaveBeenCalledTimes(writesAfterMove + 1);

    writeFails = false;
    removeFails = true;
    await act(async () => current().reset());
    expect(current().prefs).toEqual(defaultPrefs());
    expect(storage.removeItem).toHaveBeenCalledWith("prNav:v1");
    expect(JSON.parse(values.get("prNav:v1") ?? "{}")).toEqual(defaultPrefs());
  });
});
