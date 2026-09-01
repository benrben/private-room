import { describe, expect, it } from "vitest";
import { jobMeter } from "./jobProgress.js";

describe("jobMeter", () => {
  it("keeps a running job indeterminate until it reports a usable total", () => {
    expect(jobMeter("running", 2, 5, undefined)).toEqual({
      indeterminate: true,
      figure: null,
      percent: 0,
    });
    expect(jobMeter("running", 0, 0, { label: "Starting", done: 0, total: 0 })).toEqual({
      indeterminate: true,
      figure: null,
      percent: 0,
    });
  });

  it("does not invent progress for a queued or parked job without a total", () => {
    expect(jobMeter("queued", 0, 0, undefined)).toEqual({
      indeterminate: false,
      figure: null,
      percent: 0,
    });
  });

  it("uses live progress when present and clamps an over-count to the planned total", () => {
    expect(jobMeter("paused", 1, 4, undefined)).toEqual({
      indeterminate: false,
      figure: { done: 1, total: 4 },
      percent: 25,
    });
    expect(jobMeter("running", 1, 4, { label: "Writing", done: 13, total: 12 })).toEqual({
      indeterminate: false,
      figure: { done: 12, total: 12 },
      percent: 100,
    });
  });
});
