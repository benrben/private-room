import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./MarkdownView", () => ({
  default: ({ text }: { text: string }) =>
    createElement("div", { "data-markdown": text }),
}));

const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLImageElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = Object.fromEntries(
  keys.map((key) => [key, Reflect.get(globalThis, key)]),
);

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function render(text: string) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLImageElement: window.HTMLImageElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Reflect.set(globalThis, key, value);
  const [{ createRoot }, { default: NotebookView }] = await Promise.all([
    import("react-dom/client"),
    import("./NotebookView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(NotebookView, { text }));
    await Promise.resolve();
  });
  return { host, close: async () => act(async () => root.unmount()) };
}

describe("NotebookView", () => {
  it("reports invalid and empty notebooks", async () => {
    const invalid = await render("{");
    expect(invalid.host.textContent).toContain("isn't valid notebook JSON");
    await invalid.close();
    const empty = await render('{"cells":[]}');
    expect(empty.host.textContent).toContain("has no cells");
    await empty.close();
  });

  it("renders markdown, raw, fenced code and output fallback modes", async () => {
    const view = await render(
      JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Heading"] },
          { cell_type: "raw", source: "raw text" },
          {
            cell_type: "code",
            execution_count: 2,
            source: "print(```)`",
            outputs: [
              { output_type: "stream", text: "plain" },
              { data: { "image/png": "png", "image/jpeg": "jpeg" } },
              {
                data: { "image/svg+xml": ["<svg/>"], "text/html": "<b>x</b>" },
              },
              { data: { "text/html": "<b>x</b>" } },
              {
                output_type: "error",
                ename: "ValueError",
                evalue: "bad",
                traceback: ["trace"],
              },
            ],
          },
        ],
      }),
    );
    expect(view.host.querySelectorAll("[data-markdown]")).toHaveLength(2);
    expect(view.host.textContent).toContain("raw text");
    expect(view.host.textContent).toContain("[2]");
    expect(view.host.querySelectorAll("img.nb-img")).toHaveLength(2);
    expect(view.host.querySelector("img[src*='image/svg+xml']")).not.toBeNull();
    expect(view.host.textContent).toContain("[HTML output — not rendered]");
    expect(view.host.textContent).toContain("trace");
    expect(
      view.host.querySelector("[data-markdown]")?.getAttribute("data-markdown"),
    ).toBe("# Heading");
    expect(
      view.host
        .querySelectorAll("[data-markdown]")[1]
        .getAttribute("data-markdown"),
    ).toContain("````python");
    await view.close();
  });

  it("falls back to error names and empty code gutters", async () => {
    const view = await render(
      JSON.stringify({
        cells: [
          {
            source: "",
            outputs: [
              { output_type: "error", ename: "Oops", evalue: "why" },
              { data: {} },
            ],
          },
        ],
      }),
    );
    expect(view.host.textContent).toContain("[ ]");
    expect(view.host.textContent).toContain("Oops: why");
    await view.close();
  });
});
