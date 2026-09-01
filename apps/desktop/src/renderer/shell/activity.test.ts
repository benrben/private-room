import { describe, expect, it } from "vitest";

import { summaryPending } from "./activity";

function state(summaryStarting: boolean, jobs: Array<{ kind: string; status: string }>) {
  return { jobs, summaryStarting } as Parameters<typeof summaryPending>[0];
}

describe("summaryPending", () => {
  it("keeps the optimistic summary visible until a fabricated active summary job exists", () => {
    expect(summaryPending(state(true, []))).toBe(true);
    expect(summaryPending(state(true, [
      { kind: "file_index", status: "running" },
      { kind: "deep_summary", status: "done" },
    ]))).toBe(true);
  });

  it("does not add an optimistic card when a fabricated summary is queued or running", () => {
    expect(summaryPending(state(true, [{ kind: "deep_summary", status: "queued" }]))).toBe(false);
    expect(summaryPending(state(true, [{ kind: "deep_summary", status: "running" }]))).toBe(false);
    expect(summaryPending(state(false, [{ kind: "deep_summary", status: "running" }]))).toBe(false);
  });
});
