import { describe, expect, it } from "vitest";
import type { FileMeta } from "../api";
import { isLibraryVisible, libraryFiles, libraryStatus, sectionLabel } from "./fileVisibility";

function file(originDestination: string, libraryVisibility: "linked" | "sectionOnly" | undefined = undefined): FileMeta {
  return { originDestination, libraryVisibility } as FileMeta;
}

describe("file visibility rules", () => {
  it("labels every section-only origin and keeps the Library fallback honest", () => {
    expect(sectionLabel("sketch")).toBe("Sketches");
    expect(sectionLabel("create")).toBe("Creations");
    expect(sectionLabel("recordings")).toBe("Recordings");
    expect(sectionLabel("library")).toBe("the Library");
    expect(sectionLabel("future-origin")).toBe("the Library");
  });

  it("filters only section-only files and describes promotable visibility", () => {
    const ordinary = file("library");
    const linkedSketch = file("sketch", "linked");
    const hiddenRecording = file("recordings", "sectionOnly");

    expect(isLibraryVisible(ordinary)).toBe(true);
    expect(isLibraryVisible(linkedSketch)).toBe(true);
    expect(isLibraryVisible(hiddenRecording)).toBe(false);
    expect(libraryFiles([ordinary, linkedSketch, hiddenRecording])).toEqual([ordinary, linkedSketch]);
    expect(libraryStatus(ordinary)).toBeNull();
    expect(libraryStatus(linkedSketch)).toEqual({ linked: true, label: "In Library", where: "Sketches" });
    expect(libraryStatus(hiddenRecording)).toEqual({
      linked: false,
      label: "Section only",
      where: "Recordings",
    });
  });
});
