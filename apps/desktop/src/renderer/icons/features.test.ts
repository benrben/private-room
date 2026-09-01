import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as features from "./features";

Reflect.set(globalThis, "React", React);

describe("feature icons", () => {
  it.each([
    ["WorkflowsIcon", 'x="3" y="9.5" width="5"'],
    ["GraphIcon", 'cx="12" cy="12" r="2.1"'],
    ["TimeMachineIcon", "M3.5 12a8.5 8.5"],
    ["StudioIcon", 'x="7" y="8" width="13"'],
    ["PodcastIcon", 'x="9.5" y="2.5" width="5"'],
    ["ScriptIcon", "M6 3.5h8l4 4V20"],
    ["SunriseIcon", "M7 15a5 5 0 0 1 10 0"],
    ["InboxIcon", "M21 12.5h-5l-1.5 2.5"],
    ["CalendarCheckIcon", 'x="3.5" y="5" width="17"'],
    ["BookOpenIcon", "M12 6.5v13"],
    ["CompareIcon", 'cx="5.5" cy="6.5" r="2.6"'],
    ["FilesIcon", "M8.5 3.5H15l4.5 4.5"],
    ["ListFilterIcon", "M4 6.5h16M7 12h10"],
    ["CreateIcon", 'x="3.5" y="4.5" width="17"'],
    ["SketchIcon", "M14.8 4.9l4.3 4.3"],
  ] as const)("renders %s with its intended geometry and caller styling", (name, marker) => {
    const Icon = features[name];
    const markup = renderToStaticMarkup(
      createElement(Icon, { size: 14, className: "feature-icon" }),
    );

    expect(markup).toContain('width="14"');
    expect(markup).toContain('height="14"');
    expect(markup).toContain('class="feature-icon"');
    expect(markup).toContain(marker);
  });

  it("uses the shared default dimensions and stroke contract", () => {
    const markup = renderToStaticMarkup(createElement(features.WorkflowsIcon, {}));

    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('stroke-linecap="round"');
  });
});
