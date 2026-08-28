import type { DerivedPreviewStatus } from "../api";

/** Persistent, honest provenance for an image backed by a hidden preview file. */
export function derivedPreviewCaption(status: DerivedPreviewStatus): string {
  if (status.kind === "stored-snapshot") {
    return (
      "Stored snapshot preview — Arcelle could not display the original directly, so macOS drew this picture. " +
      "The original may be damaged or may simply use a format this Mac cannot display; this preview cannot " +
      "distinguish those cases. Export saves the original file unchanged."
    );
  }
  return (
    "Stored preview — Arcelle extracted or converted this view from the original file. It may not contain every " +
    "page or detail. Export saves the original file unchanged."
  );
}
