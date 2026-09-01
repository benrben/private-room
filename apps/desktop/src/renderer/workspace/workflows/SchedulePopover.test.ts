import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schedule } from "../../api";
import { SchedulePopover, scheduleProblem } from "./SchedulePopover";

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

type View = Awaited<ReturnType<typeof renderPopover>>;

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

async function renderPopover({
  schedule = null,
  disabled = false,
}: {
  schedule?: Schedule | null;
  disabled?: boolean;
} = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const events: string[] = [];
  const onSave = vi.fn((value) => events.push(`save:${JSON.stringify(value)}`));
  const onClose = vi.fn(() => events.push("close"));
  await act(async () => {
    root.render(createElement(SchedulePopover, { schedule, disabled, onSave, onClose }));
    await Promise.resolve();
  });
  const close = async () => act(async () => root.unmount());
  return { close, document, events, host, onClose, onSave, window };
}

function reactProp(
  element: Element,
  name: string,
): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (
    element as unknown as Record<
      string,
      Record<string, (event: Record<string, unknown>) => void>
    >
  )[key][name];
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () => {
    reactProp(element, name)({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    });
    await Promise.resolve();
  });
}

async function setValue(element: Element, value: string) {
  await invoke(element, "onChange", { target: { value } });
}

async function setChecked(element: Element, checked: boolean) {
  await invoke(element, "onChange", { target: { checked } });
}

function button(view: View, text: string) {
  const element = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!element) throw new Error(`button not found: ${text}`);
  return element;
}

function select(view: View, index = 0) {
  const element = view.host.querySelectorAll("select")[index];
  if (!element) throw new Error(`select ${index} missing`);
  return element;
}

function textInput(view: View) {
  const element = view.host.querySelector("input[type=text]");
  if (!element) throw new Error("text input missing");
  return element;
}

describe("scheduleProblem", () => {
  it("accepts only a positive whole interval and real daily or weekly clock times", () => {
    expect(scheduleProblem("interval", "", "", "")).toBe(
      "Minutes must be a whole number above zero.",
    );
    expect(scheduleProblem("interval", "1.5", "", "")).toBe(
      "Minutes must be a whole number above zero.",
    );
    expect(scheduleProblem("interval", "0", "", "")).toBe(
      "Minutes must be a whole number above zero.",
    );
    expect(scheduleProblem("interval", "30", "", "")).toBeNull();
    expect(scheduleProblem("daily", "", "24:00", "")).toContain("HH:MM");
    expect(scheduleProblem("daily", "", "08:60", "")).toContain("HH:MM");
    expect(scheduleProblem("daily", "", " 8:05 ", "")).toBeNull();
    expect(scheduleProblem("weekly", "", "", "wrong")).toContain("HH:MM");
    expect(scheduleProblem("weekly", "", "", "17:30")).toBeNull();
    expect(scheduleProblem("newer_backend_kind", "", "", "")).toBeNull();
  });
});

describe("SchedulePopover", () => {
  it("explains the file-scoped disabled state and only closes when asked", async () => {
    const view = await renderPopover({ disabled: true });
    expect(view.host.textContent).toContain("can't be scheduled");
    expect(view.host.querySelector("select")).toBeNull();
    await invoke(button(view, "Close"));
    expect(view.events).toEqual(["close"]);
    await view.close();
  });

  it("clears an off schedule and preserves save-before-close ordering", async () => {
    const view = await renderPopover();
    expect(view.host.querySelector("input")).toBeNull();
    await invoke(button(view, "Save"));
    expect(view.onSave).toHaveBeenCalledWith({ kind: "" });
    expect(view.events).toEqual(['save:{"kind":""}', "close"]);
    await view.close();
  });

  it("keeps invalid input open, filters interval typing, and saves the selected toggles", async () => {
    const view = await renderPopover();
    await setValue(select(view), "interval");
    await setValue(textInput(view), "0");
    expect(view.host.querySelector("[role=alert]")?.textContent).toContain("whole number");
    expect(button(view, "Save").hasAttribute("disabled")).toBe(true);
    await invoke(button(view, "Save"));
    expect(view.events).toEqual([]);
    await setValue(textInput(view), "30 minutes!");
    expect((textInput(view) as HTMLInputElement).value).toBe("30");
    expect(view.host.textContent).toContain("on a timer, every");
    const toggles = view.host.querySelectorAll("input[type=checkbox]");
    await setChecked(toggles[0], false);
    await setChecked(toggles[1], false);
    expect(view.host.textContent).toContain("schedule paused");
    await invoke(button(view, "Save"));
    expect(view.onSave).toHaveBeenCalledWith({
      kind: "interval",
      param: "30",
      enabled: false,
      catchUp: false,
    });
    expect(view.events.at(-1)).toBe("close");
    await view.close();
  });

  it("uses stored weekly defaults and saves valid daily and weekly parameters", async () => {
    const daily = await renderPopover({ schedule: storedSchedule({ kind: "daily", param: "08:00" }) });
    expect(daily.host.textContent).toContain("every day at");
    await setValue(textInput(daily), "25:00");
    expect(daily.host.querySelector("[role=alert]")?.textContent).toContain("HH:MM");
    await setValue(textInput(daily), "09:15");
    await invoke(button(daily, "Save"));
    expect(daily.onSave).toHaveBeenCalledWith({
      kind: "daily",
      param: "09:15",
      enabled: true,
      catchUp: true,
    });
    await daily.close();

    const weekly = await renderPopover({ schedule: storedSchedule({ param: "2 06:45" }) });
    expect((select(weekly, 1) as HTMLSelectElement).value).toBe("2");
    expect((textInput(weekly) as HTMLInputElement).value).toBe("06:45");
    await setValue(select(weekly, 1), "6");
    await setValue(textInput(weekly), "07:30");
    expect(weekly.host.textContent).toContain("every Sat at");
    await invoke(button(weekly, "Save"));
    expect(weekly.onSave).toHaveBeenCalledWith({
      kind: "weekly",
      param: "6 07:30",
      enabled: true,
      catchUp: true,
    });
    await weekly.close();

    const interval = await renderPopover({ schedule: storedSchedule({ kind: "interval", param: "15" }) });
    expect((textInput(interval) as HTMLInputElement).value).toBe("15");
    await interval.close();

    const newerKind = await renderPopover({
      schedule: storedSchedule({ kind: "newer_backend_kind" as never, param: "ignored" }),
    });
    expect(newerKind.host.querySelector("input[type=text]")).toBeNull();
    await invoke(button(newerKind, "Save"));
    expect(newerKind.onSave).toHaveBeenCalledWith({
      kind: "newer_backend_kind",
      param: "5 16:00",
      enabled: true,
      catchUp: true,
    });
    await newerKind.close();
  });
});
