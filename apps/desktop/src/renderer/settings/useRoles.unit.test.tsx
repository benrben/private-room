import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomRole } from "./types";

const bridge = vi.hoisted(() => ({
  getSetting: vi.fn(),
  listRoles: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { getSetting: bridge.getSetting, setSetting: bridge.setSetting },
  listRoles: bridge.listRoles,
}));

import { useRoles } from "./useRoles";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];

const writer: RoomRole = {
  blurb: "Fabricated drafts.",
  commands: [],
  id: "writer",
  instructions: "",
  name: "Writer",
  prompts: [],
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(): Promise<() => ReturnType<typeof useRoles>> {
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
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("Fabricated hook root missing.");
  const root = createRoot(host);
  roots.push(root);
  let current: ReturnType<typeof useRoles> | null = null;
  function Probe(): null {
    current = useRoles();
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  return () => {
    if (current === null) throw new Error("Fabricated role hook has not rendered.");
    return current;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  bridge.getSetting.mockResolvedValue("writer");
  bridge.listRoles.mockResolvedValue([writer]);
  bridge.setSetting.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useRoles with a fabricated settings bridge", () => {
  it("loads roles and persists a successful role change through the typed API", async () => {
    const current = await render();
    await flush();

    expect(current()).toMatchObject({ roles: [writer], role: "writer", roleError: "" });
    await act(async () => { await current().changeRole("critic"); });

    expect(bridge.listRoles).toHaveBeenCalledOnce();
    expect(bridge.getSetting).toHaveBeenCalledWith("room_role");
    expect(bridge.setSetting).toHaveBeenCalledWith("room_role", "critic");
    expect(current()).toMatchObject({ role: "critic", roleError: "" });
  });

  it("keeps the previous role and exposes the save failure when fabricated requests reject", async () => {
    bridge.listRoles.mockRejectedValueOnce(new Error("fabricated role list failure"));
    bridge.getSetting.mockResolvedValueOnce("");
    bridge.setSetting.mockRejectedValueOnce("fabricated write failure");
    const current = await render();
    await flush();

    expect(current()).toMatchObject({ roles: [], role: "default", roleError: "" });
    await act(async () => { await current().changeRole("critic"); });

    expect(bridge.setSetting).toHaveBeenCalledWith("room_role", "critic");
    expect(current()).toMatchObject({
      role: "default",
      roleError: "Could not save that stance (fabricated write failure) — the room is still using “default”.",
    });
  });
});
