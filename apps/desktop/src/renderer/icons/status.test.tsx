import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

let status: typeof import("./status");

beforeAll(async () => {
  Reflect.set(globalThis, "React", React);
  status = await import("./status");
});

describe("status icons", () => {
  it.each([
    ["LockIcon", 'width="14" height="9.5"'],
    ["EyeIcon", "M2.5 12S6 5.5"],
    ["CloudIcon", "M7 18a4 4 0 0 1-.5-7.97"],
    ["MemoryIcon", "M6.5 4.5h11"],
    ["DotsIcon", 'cx="19" cy="12" r="1.4"'],
    ["AlertIcon", "M12 4.5l8.5 15h-17z"],
    ["CircleCheckIcon", "m8.5 12 2.4 2.4 4.6-4.8"],
    ["StopIcon", 'width="11" height="11"'],
    ["PauseIcon", "M9 5v14M15 5v14"],
  ] as const)("renders %s as its distinct status glyph", (name, marker) => {
    const Icon = status[name];
    const markup = renderToStaticMarkup(createElement(Icon, { size: 12, className: "status-icon" }));

    expect(markup).toContain('width="12"');
    expect(markup).toContain('height="12"');
    expect(markup).toContain('class="status-icon"');
    expect(markup).toContain(marker);
  });
});
