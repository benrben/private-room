import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomRole } from "./types";
import RoleSection from "./RoleSection";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

const roles: RoomRole[] = [
  { id: "writer", name: "Writer", blurb: "Writes clean drafts.", instructions: "", prompts: [], commands: [] },
  { id: "critic", name: "Critic", blurb: "Finds gaps.", instructions: "", prompts: [], commands: [] },
];

async function render(props: React.ComponentProps<typeof RoleSection>) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(RoleSection, props)));
  return { host, root };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

const roots: Array<{ unmount(): void }> = [];

describe("RoleSection", () => {
  it("renders the selected fabricated role and forwards its radio change", async () => {
    const changeRole = vi.fn();
    const view = await render({ roles, role: "writer", changeRole, roleError: "" });
    roots.push(view.root);
    const radios = [...view.host.querySelectorAll<HTMLInputElement>('input[name="room-role"]')];

    expect(view.host.querySelector("#set-role")?.textContent).toContain("Room role");
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true);
    expect(radios[0].closest("label")?.className).toContain("active");
    expect(radios[1].checked).toBe(false);
    expect(view.host.textContent).toContain("Writes clean drafts.");

    await act(async () => reactProps<{ onChange(): void }>(radios[1]).onChange());
    expect(changeRole).toHaveBeenCalledWith("critic");
  });

  it("shows unavailable and save-error states without fabricating a role", async () => {
    const view = await render({
      roles: [],
      role: "writer",
      changeRole: vi.fn(),
      roleError: "The fake role save failed.",
    });
    roots.push(view.root);

    expect(view.host.querySelectorAll('input[name="room-role"]')).toHaveLength(0);
    expect(view.host.textContent).toContain("Roles aren't available right now.");
    expect(view.host.querySelector(".gate-error")?.textContent).toBe("The fake role save failed.");
  });
});
