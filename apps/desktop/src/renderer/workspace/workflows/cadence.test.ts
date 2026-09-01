import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import type { Schedule, ScheduleArg } from "../../api";
import { CadenceNote, cadenceOf, type Cadence } from "./cadence";

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function storedSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "schedule-1",
    workflowId: "workflow-1",
    kind: "weekly",
    param: "5 16:00",
    enabled: true,
    catchUp: true,
    nextRunAt: null,
    lastRunAt: null,
    lastJobId: null,
    ...overrides,
  };
}

function argument(overrides: Partial<ScheduleArg>): ScheduleArg {
  return { kind: "daily", ...overrides };
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function renderNote(cadence: Cadence, countdown?: string) {
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
    root.render(createElement(CadenceNote, { cadence, countdown }));
    await Promise.resolve();
  });
  return { close: async () => act(async () => root.unmount()), host };
}

describe("cadenceOf", () => {
  it("gives file binding precedence and explains absent or paused schedules", () => {
    expect(cadenceOf(storedSchedule(), { scope: "file" })).toEqual({
      mark: "nb-mark-pink",
      note: "when you run it on a file",
      exact: null,
    });
    expect(cadenceOf(null)).toEqual({
      mark: "",
      note: "only when you run it",
      exact: null,
    });
    expect(cadenceOf(storedSchedule({ enabled: false }))).toEqual({
      mark: "",
      note: "schedule paused",
      exact: null,
    });
  });

  it("formats daily and weekly schedules from trimmed exact values", () => {
    expect(cadenceOf(argument({ kind: "daily", param: " 08:00 " }))).toEqual({
      mark: "nb-mark-yellow",
      note: "every day at",
      exact: "08:00",
    });
    expect(cadenceOf(argument({ kind: "weekly", param: "5 16:00" }))).toEqual({
      mark: "nb-mark-blue",
      note: "every Fri at",
      exact: "16:00",
    });
    expect(cadenceOf(argument({ kind: "weekly", param: "9" }))).toEqual({
      mark: "nb-mark-blue",
      note: "every week",
      exact: null,
    });
  });

  it("keeps omitted ScheduleArg enabled and handles blank/unknown values", () => {
    expect(cadenceOf(argument({ kind: "daily", param: "" }))).toEqual({
      mark: "nb-mark-yellow",
      note: "every day",
      exact: null,
    });
    expect(cadenceOf(argument({ kind: "interval", param: " 30 " }))).toEqual({
      mark: "nb-mark-green",
      note: "on a timer, every",
      exact: "30 min",
    });
    expect(cadenceOf(argument({ kind: "interval", param: "" }))).toEqual({
      mark: "nb-mark-green",
      note: "on a timer",
      exact: null,
    });
    expect(
      cadenceOf(argument({ kind: "new_backend", param: "  raw  " })),
    ).toEqual({
      mark: "",
      note: "new_backend",
      exact: "raw",
    });
  });
});

describe("CadenceNote", () => {
  it("renders semantic note, exact value, and countdown only when supplied", async () => {
    const detailed = await renderNote(
      { mark: "nb-mark-yellow", note: "every day at", exact: "08:00" },
      "in 4h",
    );
    expect(detailed.host.querySelector(".wf-cadence-note")?.textContent).toBe(
      "every day at",
    );
    expect(detailed.host.querySelector(".wf-cadence-at")?.textContent).toBe(
      "08:00",
    );
    expect(detailed.host.querySelector(".wf-cadence-in")?.textContent).toBe(
      "in 4h",
    );
    await detailed.close();

    const minimal = await renderNote({
      mark: "",
      note: "only when you run it",
      exact: null,
    });
    expect(minimal.host.textContent).toBe("only when you run it");
    expect(
      minimal.host.querySelector(".wf-cadence-at, .wf-cadence-in"),
    ).toBeNull();
    await minimal.close();
  });
});
