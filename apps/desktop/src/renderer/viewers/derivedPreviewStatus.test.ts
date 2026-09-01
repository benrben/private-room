import { describe, expect, it } from "vitest";

import { derivedPreviewCaption } from "./derivedPreviewStatus";

describe("derivedPreviewCaption", () => {
  it("identifies a fabricated macOS snapshot and its display limitation", () => {
    expect(derivedPreviewCaption({ kind: "stored-snapshot", originalMime: "image/heic" })).toContain(
      "macOS drew this picture",
    );
    expect(derivedPreviewCaption({ kind: "stored-snapshot", originalMime: "image/heic" })).toContain(
      "Export saves the original file unchanged.",
    );
  });

  it("identifies a fabricated extracted or converted preview", () => {
    expect(derivedPreviewCaption({ kind: "stored-preview", originalMime: "application/pdf" })).toContain(
      "extracted or converted this view",
    );
    expect(derivedPreviewCaption({ kind: "stored-preview", originalMime: "application/pdf" })).toContain(
      "may not contain every page or detail",
    );
  });
});
