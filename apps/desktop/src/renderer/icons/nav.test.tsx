import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

let nav: typeof import("./nav");

beforeAll(async () => {
  Reflect.set(globalThis, "React", React);
  nav = await import("./nav");
});

describe("navigation icons", () => {
  it("keeps the logomark's themed and monochrome colour contracts distinct", () => {
    const themed = renderToStaticMarkup(createElement(nav.Logomark, { size: 30, className: "brand" }));
    const mono = renderToStaticMarkup(createElement(nav.Logomark, { mono: true }));

    expect(themed).toContain('width="30"');
    expect(themed).toContain('class="brand"');
    expect(themed).toContain('color:var(--ink)');
    expect(themed).toContain('fill="var(--mk-yellow)"');
    expect(mono).toContain('width="24"');
    expect(mono).toContain('fill="currentColor"');
    expect(mono).not.toContain('color:var(--ink)');
  });

  it("renders the wordmark with its readable text and proportional top padding", () => {
    const markup = renderToStaticMarkup(createElement(nav.Wordmark, { size: 30, className: "wordmark" }));

    expect(markup).toContain("Arcelle");
    expect(markup).toContain('class="wordmark"');
    expect(markup).toContain('font-size:30px');
    expect(markup).toContain('padding-top:3px');
  });

  it.each([
    ["CloseIcon", "M6 6l12 12M18 6L6 18"],
    ["FolderIcon", "M3 6.5A1.5 1.5"],
    ["LinkIcon", "M10 13.5a3.5"],
    ["GlobeIcon", 'cx="12" cy="12" r="9"'],
    ["ChevronDownIcon", "M6 9.5l6 6 6-6"],
    ["ChevronUpIcon", "M6 14.5l6-6 6 6"],
    ["ChevronLeftIcon", "M14.5 6l-6 6 6 6"],
    ["ChevronRightIcon", "M9.5 6l6 6-6 6"],
    ["SearchIcon", "M20 20l-4.2-4.2"],
  ] as const)("renders %s as its distinct navigation glyph", (name, marker) => {
    const Icon = nav[name];
    const markup = renderToStaticMarkup(createElement(Icon, { size: 14, className: "nav-icon" }));

    expect(markup).toContain('width="14"');
    expect(markup).toContain('class="nav-icon"');
    expect(markup).toContain(marker);
  });
});
