import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import SubtitleView from "./SubtitleView";

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

const srt = `1
00:00:00,000 --> 00:00:05,000
First line

2
00:00:01,000 --> 00:00:02,000
Second line
`;

function props(overrides: Record<string, unknown> = {}) {
  return {
    text: srt,
    name: "captions.srt",
    onSave: undefined,
    ...overrides,
  } as React.ComponentProps<typeof SubtitleView>;
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(SubtitleView, input));
    await Promise.resolve();
  });
  return {
    host,
    input,
    rerender: async (next: React.ComponentProps<typeof SubtitleView>) => act(async () => {
      root.render(createElement(SubtitleView, next));
      await Promise.resolve();
      await Promise.resolve();
    }),
    close: async () => act(async () => root.unmount()),
  };
}

function reactHandler(element: Element, name: string) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, Record<string, (event?: unknown) => void>>)[key][name];
}

async function save(button: Element) {
  await act(async () => {
    reactHandler(button, "onClick")();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function saveButton(host: Element) {
  const button = host.querySelector("button");
  if (!button) throw new Error("save button missing");
  return button;
}

async function editFirstCue(view: Awaited<ReturnType<typeof render>>, text: string) {
  const textarea = view.host.querySelector("textarea");
  if (!textarea) throw new Error("subtitle editor missing");
  await act(async () => reactHandler(textarea, "onChange")({ target: { value: text } }));
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("SubtitleView", () => {
  it("renders a read-only timed transcript using the latest cue end time", async () => {
    const view = await render();
    expect(view.host.textContent).toContain("2 cues · 0:05 long");
    expect(view.host.textContent).toContain("First line");
    expect(view.host.querySelector("textarea")).toBeNull();
    expect(view.host.querySelector("button")).toBeNull();
    await view.close();
  });

  it("shows the empty-file explanation when no cue can be parsed", async () => {
    const view = await render(props({ text: "not a subtitle file" }));
    expect(view.host.textContent).toContain("No subtitle cues could be read");
    await view.close();
  });

  it("edits and saves SRT cues in their original dialect", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const view = await render(props({ onSave }));
    await editFirstCue(view, "Corrected line");
    const button = saveButton(view.host);
    expect(button.hasAttribute("disabled")).toBe(false);
    await save(button);
    expect(onSave).toHaveBeenCalledWith(expect.stringContaining("Corrected line"));
    expect(onSave).toHaveBeenCalledWith(expect.stringContaining("00:00:05,000"));
    expect(view.host.querySelector("button")?.textContent).toBe("Save");
    await view.rerender(props({ text: onSave.mock.calls[0][0], onSave }));
    expect(view.host.querySelector("button")?.textContent).toBe("Saved");
    expect(view.host.querySelector("button")?.hasAttribute("disabled")).toBe(true);
    await view.close();
  });

  it("reports refused and thrown writes while preserving the editable VTT cue", async () => {
    const refused = vi.fn().mockResolvedValue(false);
    const vtt = `WEBVTT

id-one
00:00.000 --> 00:01.000 line:90%
Original`;
    const view = await render(props({ text: vtt, name: "captions.vtt", onSave: refused }));
    await editFirstCue(view, "Still here");
    await save(saveButton(view.host));
    expect(refused).toHaveBeenCalledWith(expect.stringContaining("WEBVTT"));
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
    expect(view.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Still here");
    await view.close();

    const rejected = vi.fn().mockRejectedValue(new Error("disk full"));
    const rejectedView = await render(props({ onSave: rejected }));
    await editFirstCue(rejectedView, "Retry me");
    await save(saveButton(rejectedView.host));
    expect(rejectedView.host.querySelector('[role="alert"]')?.textContent).toContain("disk full");
    await rejectedView.close();
  });
});
