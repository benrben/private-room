import { describe, expect, it, vi } from "vitest";

vi.mock("./db-host/workflows.js", () => ({
  dueSchedules: vi.fn(),
  markScheduleRun: vi.fn(),
  setScheduleNextRun: vi.fn(),
}));

import { nextRunAfter } from "./jobScheduler.js";

function local(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute);
}

describe("nextRunAfter without a scheduler runtime", () => {
  it("routes interval, daily, and weekly schedules through their matching calculation", () => {
    const after = local(2026, 7, 18, 10, 0);

    expect(nextRunAfter("interval", "30", after)).toEqual(local(2026, 7, 18, 10, 30));
    expect(nextRunAfter("daily", "12:15", after)).toEqual(local(2026, 7, 18, 12, 15));
    expect(nextRunAfter("weekly", "5 16:00", after)).toEqual(local(2026, 7, 24, 16, 0));
  });

  it("rejects malformed, unknown, and unrepresentable schedule parameters", () => {
    const after = local(2026, 7, 18, 10, 0);

    expect(nextRunAfter("interval", "0", after)).toBeNull();
    expect(nextRunAfter("daily", "24:00", after)).toBeNull();
    expect(nextRunAfter("weekly", "7 08:00", after)).toBeNull();
    expect(nextRunAfter("interval", "999999999999", after)).toBeNull();
    expect(nextRunAfter("monthly", "1", after)).toBeNull();
  });
});
