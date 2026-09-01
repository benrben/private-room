import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

let shell: typeof import("./shell");

beforeAll(async () => {
  Reflect.set(globalThis, "React", React);
  shell = await import("./shell");
});

describe("shell icons", () => {
  it.each([
    ["HomeIcon", "M4 11l8-7 8 7"],
    ["PanelLeftIcon", "M9.5 4.5v15"],
    ["PanelCenterIcon", "M8.5 4.5v15M15.5 4.5v15"],
    ["PanelRightIcon", "M14.5 4.5v15"],
    ["FocusIcon", "M20 4l-6.5 6.5"],
    ["ToolsIcon", 'width="7" height="7"'],
    ["CollapseLeftIcon", "M13 6l-6 6 6 6"],
    ["CollapseRightIcon", "M11 6l6 6-6 6"],
    ["LayoutResetIcon", 'opacity="0"'],
    ["ThemeIcon", "M12 7a5 5 0 0 1 0 10z"],
    ["SettingsIcon", 'cx="12" cy="12" r="3"'],
    ["ShieldIcon", "M12 3l7 3v5"],
    ["ActivityIcon", "M10 17.5h10"],
    ["ChatBubbleIcon", "M8 9h8M8 12.5h5"],
    ["DatabaseIcon", 'cx="12" cy="6" rx="7.5"'],
    ["CloudOffIcon", "M4.5 4.5l15 15"],
  ] as const)("renders %s with its shell-specific geometry", (name, marker) => {
    const Icon = shell[name];
    const markup = renderToStaticMarkup(createElement(Icon, { size: 16, className: "shell-icon" }));

    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
    expect(markup).toContain('class="shell-icon"');
    expect(markup).toContain(marker);
  });
});
