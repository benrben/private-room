import { describe, expect, it } from "vitest";
import { isCheckpointManifest, isCheckpointMeta } from "./checkpoints.js";

describe("checkpoint manifest shapes", () => {
  it("accepts only complete fabricated checkpoint entries", () => {
    const complete = {
      id: "checkpoint-1",
      name: "Before fabrication",
      createdAt: "2026-01-01T00:00:00Z",
      sizeBytes: 42,
      auto: false,
    };
    expect(isCheckpointMeta(complete)).toBe(true);
    for (const invalid of [
      null,
      [],
      "not-an-entry",
      { ...complete, id: 7 },
      { ...complete, name: null },
      { ...complete, createdAt: false },
      { ...complete, sizeBytes: "42" },
      { ...complete, auto: "false" },
    ]) {
      expect(isCheckpointMeta(invalid)).toBe(false);
    }
  });

  it("accepts only fabricated manifests with numeric versions and complete entry arrays", () => {
    const entry = {
      id: "checkpoint-1",
      name: "Before fabrication",
      createdAt: "2026-01-01T00:00:00Z",
      sizeBytes: 42,
      auto: true,
    };
    expect(isCheckpointManifest({ v: 1, entries: [entry] })).toBe(true);
    for (const invalid of [
      null,
      [],
      "not-a-manifest",
      { entries: [] },
      { v: "1", entries: [] },
      { v: 1, entries: {} },
      { v: 1, entries: [{ ...entry, auto: null }] },
    ]) {
      expect(isCheckpointManifest(invalid)).toBe(false);
    }
  });
});
