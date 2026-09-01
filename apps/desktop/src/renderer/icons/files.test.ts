import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { FileMeta } from "../api";

let FileTypeIcon: typeof import("./files").FileTypeIcon;

beforeAll(async () => {
  Reflect.set(globalThis, "React", React);
  ({ FileTypeIcon } = await import("./files"));
});

function file(name: string, overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id: "file-1",
    name,
    mimeType: "application/octet-stream",
    sizeBytes: 0,
    source: "library",
    hasText: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    folderId: null,
    partiallyIndexed: false,
    aiSummary: null,
    originDestination: "library",
    libraryVisibility: "linked",
    ...overrides,
  };
}

function iconMarkup(meta: FileMeta, size = 20) {
  return renderToStaticMarkup(createElement(FileTypeIcon, { file: meta, size }));
}

describe("FileTypeIcon", () => {
  it.each([
    [file("photo.bin", { mimeType: "image/jpeg" }), 'x="3.5" y="5"'],
    [file("draft.md", { source: "generated" }), 'fill="var(--accent)"'],
    [file("report.pdf"), 'd="M9.6 17.5l2.4-6 2.4 6"'],
    [file("letter.docx"), 'd="M8.6 12l1.1 5.5 2.3-4.6 2.3 4.6 1.1-5.5"'],
    [file("budget.csv"), 'x="8" y="11.5" width="8"'],
    [file("readme.md"), 'x="2.5" y="6"'],
    [file("page.html"), "<ellipse"],
    [file("notes.ts"), 'd="M8.5 12.5h7M8.5 15.3h7M8.5 18.1h4"'],
    [file("clip.wav", { mimeType: "audio/wav" }), 'fill="#e5484d"'],
  ])("uses the matching icon for %s", (meta, marker) => {
    const markup = iconMarkup(meta);

    expect(markup).toContain(marker);
    expect(markup).toContain('width="20"');
  });

  it("uses the generic document icon for an unknown file", () => {
    const markup = iconMarkup(file("archive.unknown"));

    expect(markup.match(/<path/g)).toHaveLength(2);
    expect(markup).toContain('width="20"');
  });

  it("keeps the default size for generated icons", () => {
    const markup = renderToStaticMarkup(
      createElement(FileTypeIcon, { file: file("draft.md", { source: "generated" }) }),
    );

    expect(markup).toContain('width="16"');
  });
});
