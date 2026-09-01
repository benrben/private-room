import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

let actions: typeof import("./actions");

beforeAll(async () => {
  Reflect.set(globalThis, "React", React);
  actions = await import("./actions");
});

describe("action icons", () => {
  it.each([
    ["DownloadIcon", "M12 4v10M8 10.5l4 4 4-4"],
    ["RefreshIcon", "M19 5.5v5h-5"],
    ["MicIcon", 'width="6" height="11"'],
    ["SpeakerIcon", "M4 9.5v5h3.5"],
    ["HandsFreeIcon", "M18.5 18v3M18.5 21h-3"],
    ["UndoIcon", "M9 14 4 9l5-5"],
    ["PaperclipIcon", "M21.44 11.05l-9.19 9.19"],
    ["TrashIcon", "M3.5 6.5h17"],
    ["SendIcon", "M22 2L11 13"],
    ["SaveIcon", "M19 21H5a2 2 0 0 1-2-2V5"],
    ["PencilIcon", "M17 3.5a2.3 2.3 0 0 1 3.3 3.3"],
    ["CheckIcon", "M4.5 12.5l5 5 10-11"],
    ["PlusIcon", "M12 5v14M5 12h14"],
    ["PlayIcon", "M7 5.5l11 6.5-11 6.5V5.5z"],
    ["ClockIcon", 'cx="12" cy="12" r="8.5"'],
    ["SparklesIcon", "M11 4.5 12.4 8.6"],
    ["PinIcon", "M12 16v5"],
    ["CalendarClockIcon", 'cx="17" cy="16.5" r="4.5"'],
  ] as const)("renders %s with its intended geometry and caller styling", (name, marker) => {
    const Icon = actions[name];
    const markup = renderToStaticMarkup(createElement(Icon, { size: 14, className: "action-icon" }));

    expect(markup).toContain('width="14"');
    expect(markup).toContain('height="14"');
    expect(markup).toContain('class="action-icon"');
    expect(markup).toContain(marker);
  });

  it("uses the shared default size when callers omit a size", () => {
    const markup = renderToStaticMarkup(createElement(actions.DownloadIcon, {}));

    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
    expect(markup).toContain('stroke-linecap="round"');
  });
});
