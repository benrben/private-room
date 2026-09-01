import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyQuoteHighlight: vi.fn(),
  clearQuoteHighlight: vi.fn(),
  initialRich: null as null | { remarkPlugins: unknown[]; rehypePlugins: unknown[] },
  latestParserProps: null as null | Record<string, any>,
  linkHref: "https://example.test/reference" as string | null,
  loadRichPlugins: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../platform", () => ({ openUrl: mocks.openUrl }));
vi.mock("./highlight", () => ({
  applyQuoteHighlight: mocks.applyQuoteHighlight,
  clearQuoteHighlight: mocks.clearQuoteHighlight,
}));
vi.mock("./Mermaid", () => ({
  default: ({ source }: { source: string }) => React.createElement("div", { "data-mermaid-source": source }),
}));
vi.mock("./markdownRich", () => ({
  loadRichPlugins: mocks.loadRichPlugins,
  richPluginsIfLoaded: () => mocks.initialRich,
}));
vi.mock("remark-gfm", () => ({ default: "gfm-plugin" }));
vi.mock("react-markdown", () => ({
  default: (props: Record<string, any>) => {
    mocks.latestParserProps = props;
    const components = props.components as {
      code: (input: { className?: string; children?: React.ReactNode }) => React.ReactNode;
      table: (input: { children?: React.ReactNode }) => React.ReactNode;
    };
    return React.createElement(
      "article",
      null,
      components.code({ className: "language-mermaid", children: "flowchart TD" }),
      components.code({ className: "language-mermaid" }),
      components.code({ className: "language-typescript", children: "const answer = 42;" }),
      components.code({}),
      components.table({ children: React.createElement("tbody", null, React.createElement("tr", null)) }),
      React.createElement("a", mocks.linkHref === null ? null : { href: mocks.linkHref }, "reference"),
    );
  },
}));

import MarkdownView from "./MarkdownView";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

const richPlugins = {
  remarkPlugins: ["math-plugin"],
  rehypePlugins: ["highlight-plugin"],
};

async function render(input: React.ComponentProps<typeof MarkdownView>) {
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
    root.render(createElement(MarkdownView, input));
    await Promise.resolve();
  });
  return {
    host,
    rerender: async (next: React.ComponentProps<typeof MarkdownView>) => {
      await act(async () => {
        root.render(createElement(MarkdownView, next));
        await Promise.resolve();
      });
    },
    root,
    window,
  };
}

async function close(view: Awaited<ReturnType<typeof render>>) {
  await act(async () => {
    view.root.unmount();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.applyQuoteHighlight.mockReset();
  mocks.clearQuoteHighlight.mockReset();
  mocks.initialRich = null;
  mocks.latestParserProps = null;
  mocks.linkHref = "https://example.test/reference";
  mocks.loadRichPlugins.mockReset().mockResolvedValue(richPlugins);
  mocks.openUrl.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("MarkdownView", () => {
  it("renders Mermaid, left-to-right code, and scrollable tables through the parser boundary", async () => {
    mocks.initialRich = richPlugins;
    const view = await render({ text: "# Note" });

    expect(view.host.querySelector('[data-mermaid-source="flowchart TD"]')).not.toBeNull();
    expect(view.host.querySelectorAll('[data-mermaid-source=""]')).toHaveLength(1);
    const code = view.host.querySelector('code[class="language-typescript"]');
    expect(code?.getAttribute("dir")).toBe("ltr");
    expect(code?.textContent).toBe("const answer = 42;");
    expect(view.host.querySelector(".md-table-scroll > table")).not.toBeNull();
    expect(mocks.latestParserProps?.remarkPlugins).toEqual(["gfm-plugin", "math-plugin"]);
    expect(mocks.latestParserProps?.rehypePlugins).toEqual(["highlight-plugin"]);
    expect(mocks.loadRichPlugins).not.toHaveBeenCalled();
    await close(view);
  });

  it("upgrades a plain render when rich plugins arrive and reapplies quote highlighting after text changes", async () => {
    let resolvePlugins: ((plugins: typeof richPlugins) => void) | undefined;
    mocks.loadRichPlugins.mockReturnValueOnce(new Promise<typeof richPlugins>((resolve) => {
      resolvePlugins = resolve;
    }));
    const view = await render({ text: "First quote", target: { quote: "First quote" } });

    expect(mocks.loadRichPlugins).toHaveBeenCalledOnce();
    expect(mocks.latestParserProps?.remarkPlugins).toEqual(["gfm-plugin"]);
    const body = view.host.querySelector(".md-body");
    expect(mocks.applyQuoteHighlight).toHaveBeenCalledWith(body, "First quote");
    if (!resolvePlugins) throw new Error("rich plugin load did not start");
    await act(async () => {
      resolvePlugins?.(richPlugins);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.latestParserProps?.remarkPlugins).toEqual(["gfm-plugin", "math-plugin"]);

    await view.rerender({ text: "Second quote", target: { quote: "Second quote" } });
    expect(mocks.clearQuoteHighlight).toHaveBeenCalledOnce();
    expect(mocks.applyQuoteHighlight).toHaveBeenLastCalledWith(body, "Second quote");
    await close(view);
    expect(mocks.clearQuoteHighlight).toHaveBeenCalledTimes(2);
  });

  it("hands supported links to the system browser while keeping unsupported and plain clicks in place", async () => {
    const view = await render({ text: "[reference](https://example.test/reference)" });
    const link = view.host.querySelector("a");
    const body = view.host.querySelector(".md-body");
    if (!link || !body) throw new Error("markdown link fixture missing");

    const external = new view.window.Event("click", { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(external);
      await Promise.resolve();
    });
    expect(external.defaultPrevented).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledWith("https://example.test/reference");

    mocks.linkHref = "file:///private-room/note.md";
    await view.rerender({ text: "[file](file:///private-room/note.md)" });
    const localLink = view.host.querySelector("a");
    if (!localLink) throw new Error("unsupported link fixture missing");
    const unsupported = new view.window.Event("click", { bubbles: true, cancelable: true });
    await act(async () => {
      localLink.dispatchEvent(unsupported);
      await Promise.resolve();
    });
    expect(unsupported.defaultPrevented).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledOnce();

    mocks.linkHref = null;
    await view.rerender({ text: "[missing href]" });
    const missingHrefLink = view.host.querySelector("a");
    if (!missingHrefLink) throw new Error("missing-href link fixture missing");
    const missingHref = new view.window.Event("click", { bubbles: true, cancelable: true });
    await act(async () => {
      missingHrefLink.dispatchEvent(missingHref);
      await Promise.resolve();
    });
    expect(missingHref.defaultPrevented).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledOnce();

    const plain = new view.window.Event("click", { bubbles: true, cancelable: true });
    await act(async () => {
      body.dispatchEvent(plain);
      await Promise.resolve();
    });
    expect(plain.defaultPrevented).toBe(false);
    await close(view);
  });
});
