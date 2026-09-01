import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorFormatApi } from "./CodeEditor";

type FakeCodeEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  registerFormat?: (api: EditorFormatApi | null) => void;
};

const mocks = vi.hoisted(() => ({
  codeProps: null as FakeCodeEditorProps | null,
  markdownText: "",
  format: {
    wrap: vi.fn(),
    linePrefix: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("./CodeEditor", () => ({
  default: (props: FakeCodeEditorProps) => {
    mocks.codeProps = props;
    props.registerFormat?.(mocks.format);
    return null;
  },
}));
vi.mock("./MarkdownView", () => ({
  default: ({ text }: { text: string }) => {
    mocks.markdownText = text;
    return null;
  },
}));

import MarkdownEditor from "./MarkdownEditor";

const { act, createElement } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type Props = React.ComponentProps<typeof MarkdownEditor>;

function props(overrides: Partial<Props> = {}): Props {
  return { value: "# Draft", onSave: vi.fn(), ...overrides };
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(MarkdownEditor, input)));
  const editor = host.querySelector(".mde");
  if (!editor) throw new Error("Markdown editor missing");
  return { host, editor, root };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
}

function reactHandler(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React prop ${name} missing`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key]![name]!;
}

async function click(host: Element, label: string) {
  const target = button(host, label);
  await act(async () => reactHandler(target, "onClick")({ currentTarget: target, target }));
  return target;
}

beforeEach(() => {
  mocks.codeProps = null;
  mocks.markdownText = "";
  mocks.format.wrap.mockReset();
  mocks.format.linePrefix.mockReset();
  mocks.format.insert.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("MarkdownEditor with fabricated editor and preview APIs", () => {
  it("keeps the fake editor mounted while switching every layout and carries live text to preview", async () => {
    const view = await render(props({ banner: "fake banner", find: "Draft" }));

    expect(view.editor.getAttribute("data-layout")).toBe("split");
    expect(mocks.codeProps).toMatchObject({ value: "# Draft" });
    expect(mocks.markdownText).toBe("# Draft");
    expect(button(view.host, "Source").title).toBe("Just the Markdown");
    expect(button(view.host, "Split").title).toBe("Markdown and the page, side by side");
    expect(button(view.host, "Preview").title).toBe("Just the page");

    await click(view.host, "Source");
    expect(view.editor.getAttribute("data-layout")).toBe("source");
    expect(view.editor.querySelector(".mde-preview")).toBeNull();
    expect(mocks.codeProps).not.toBeNull();

    await act(async () => mocks.codeProps?.onChange?.("# Live fake text"));
    await click(view.host, "Preview");
    expect(view.editor.getAttribute("data-layout")).toBe("preview");
    expect(mocks.markdownText).toBe("# Live fake text");
    await act(async () => view.root.unmount());
  });

  it("sends every formatting button to the fabricated format API and keeps pointer focus", async () => {
    const view = await render();
    const mouseDown = vi.fn();
    reactHandler(button(view.host, "Bold"), "onMouseDown")({ preventDefault: mouseDown });

    for (const label of ["Bold", "Italic", "Code", "Link", "Title", "Heading", "Subheading", "Bulleted list", "Numbered list", "Checklist", "Quote", "Divider", "Table"]) {
      await click(view.host, label);
    }

    expect(mouseDown).toHaveBeenCalledOnce();
    expect(mocks.format.wrap.mock.calls).toEqual([
      ["**", "**"], ["_", "_"], ["`", "`"], ["[", "](https://)"],
    ]);
    expect(mocks.format.linePrefix.mock.calls).toEqual([
      ["# "], ["## "], ["### "], ["- "], ["1. "], ["- [ ] "], ["> "],
    ]);
    expect(mocks.format.insert.mock.calls).toEqual([
      ["\n\n---\n\n"], ["\n| Column | Column |\n| --- | --- |\n|  |  |\n|  |  |\n"],
    ]);
    await act(async () => view.root.unmount());
  });

  it("unmounts tools in focus mode and restores them without losing the fabricated formatter", async () => {
    const view = await render();

    await click(view.host, "Focus");
    expect(view.editor.getAttribute("data-focus")).toBe("on");
    expect(view.editor.querySelector(".mde-tools")).toBeNull();
    expect(view.editor.querySelectorAll(".mde-tool")).toHaveLength(0);

    await click(view.host, "Focus");
    expect(view.editor.getAttribute("data-focus")).toBe("off");
    await click(view.host, "Bold");
    expect(mocks.format.wrap).toHaveBeenCalledWith("**", "**");
    await act(async () => view.root.unmount());
  });
});
