import { describe, expect, it } from "vitest";
import type { FileMeta, ScriptInfo } from "../api";
import {
  areaHoldsFile,
  isCreationFile,
  isSketchFile,
  isWorkArea,
} from "./types";

function file(id: string, name: string, overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id,
    name,
    mimeType: "text/plain",
    sizeBytes: 1,
    source: "library",
    hasText: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    folderId: null,
    partiallyIndexed: false,
    aiSummary: null,
    originDestination: "library",
    libraryVisibility: "linked",
    ...overrides,
  };
}

function script(fileId: string): ScriptInfo {
  return { fileId } as ScriptInfo;
}

describe("workspace area file ownership", () => {
  it("keeps library, home, and map files visible without metadata", () => {
    for (const area of ["files", "home", "map"] as const)
      expect(areaHoldsFile(area, "missing", [], [])).toBe(true);
  });

  it("recognizes each specialized area by its own classifier", () => {
    const files = [
      file("recording", "meeting.txt", { source: "recording" }),
      file("audio", "voice.bin", { mimeType: "audio/wav" }),
      file("sketch", "Plan.SKETCH"),
      file("creation", "image.png", { originDestination: "create" }),
      file("ordinary", "notes.txt"),
    ];

    expect(areaHoldsFile("recordings", "recording", files, [])).toBe(true);
    expect(areaHoldsFile("recordings", "audio", files, [])).toBe(true);
    expect(areaHoldsFile("recordings", "ordinary", files, [])).toBe(false);
    expect(areaHoldsFile("sketch", "sketch", files, [])).toBe(true);
    expect(areaHoldsFile("sketch", "ordinary", files, [])).toBe(false);
    expect(areaHoldsFile("create", "creation", files, [])).toBe(true);
    expect(areaHoldsFile("create", "ordinary", files, [])).toBe(false);
    expect(areaHoldsFile("memory", "ordinary", files, [])).toBe(false);
    expect(areaHoldsFile("create", "missing", files, [])).toBe(false);
  });

  it("uses script records independently from file metadata", () => {
    expect(areaHoldsFile("scripts", "script-file", [], [script("script-file")])).toBe(true);
    expect(areaHoldsFile("scripts", "missing", [], [script("script-file")])).toBe(false);
  });

  it("keeps runtime area and file classifiers precise", () => {
    expect(isWorkArea("browser")).toBe(true);
    expect(isWorkArea("skin")).toBe(true);
    expect(isWorkArea("retired-area")).toBe(false);
    expect(isSketchFile(file("sketch", "drawing.sketch"))).toBe(true);
    expect(isCreationFile(file("creation", "image.png", { originDestination: "create" }))).toBe(true);
  });
});
