import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("./platform", () => platform);

import { api, fileKind, fileKindLabel, formatSize, isRecordingFile, type FileMeta } from "./api";

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

describe("fileKind", () => {
  it("keeps image, recording, and generated metadata ahead of filename routing", () => {
    expect(fileKind(file("camera.wav", { mimeType: "image/jpeg", source: "recording" }))).toBe("image");
    expect(fileKind(file("clip.pdf", { mimeType: "audio/wav", source: "generated" }))).toBe("recording");
    expect(fileKind(file("photo.png", { source: "recording" }))).toBe("recording");
    expect(fileKind(file("draft.md", { source: "generated" }))).toBe("generated");
  });

  it.each([
    ["report.PDF", "pdf"],
    ["logo.ai", "pdf"],
    ["letter.doc", "docx"],
    ["letter.docx", "docx"],
    ["budget.xls", "sheet"],
    ["budget.xlsx", "sheet"],
    ["budget.ods", "sheet"],
    ["budget.csv", "sheet"],
    ["budget.tsv", "sheet"],
    ["readme.md", "markdown"],
    ["readme.markdown", "markdown"],
    ["source.ts", "text"],
    ["message.eml", "text"],
    ["message.msg", "text"],
    ["captions.srt", "text"],
    ["captions.vtt", "text"],
    ["page.html", "web"],
    ["page.htm", "web"],
    ["diagram.svg", "web"],
    ["slides.pptx", "docx"],
    ["slides.ppt", "docx"],
    ["slides.odp", "docx"],
    ["book.epub", "docx"],
    ["book.mobi", "docx"],
    ["book.azw", "docx"],
    ["book.azw3", "docx"],
    ["book.fb2", "docx"],
    ["book.cbz", "docx"],
    ["notes.ipynb", "docx"],
  ] as const)("routes %s to %s", (name, kind) => {
    expect(fileKind(file(name))).toBe(kind);
  });

  it("leaves filenames without a supported extension as generic files", () => {
    expect(fileKind(file("README"))).toBe("file");
    expect(fileKind(file("archive.unknown"))).toBe("file");
    expect(fileKind(file("trailing."))).toBe("file");
  });

  it("formats human sizes and consistently labels metadata-first file kinds", () => {
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");

    expect(isRecordingFile(file("recording.txt", { source: "recording" }))).toBe(true);
    expect(isRecordingFile(file("voice.bin", { mimeType: "audio/ogg" }))).toBe(true);
    expect(isRecordingFile(file("clip.bin", { mimeType: "video/mp4" }))).toBe(true);
    expect(isRecordingFile(file("plain.txt", { mimeType: "text/plain" }))).toBe(false);

    expect(fileKindLabel(file("voice.ogg", { mimeType: "audio/ogg" }))).toBe("recording");
    expect(fileKindLabel(file("photo.bin", { mimeType: "image/png" }))).toBe("image");
    expect(fileKindLabel(file("report.bin", { mimeType: "application/pdf" }))).toBe("PDF");
    expect(fileKindLabel(file("notes.md", { mimeType: "text/markdown" }))).toBe("note");
    expect(fileKindLabel(file("archive.unknown"))).toBe("file");
  });
});

describe("recording API payloads", () => {
  it("starts a fresh recording with explicit nullable options", async () => {
    platform.invoke.mockResolvedValueOnce({ fileId: "recording-1", sessionUrl: "ws://fake" });

    await expect(api.recStart({ systemAudio: true })).resolves.toEqual({
      fileId: "recording-1",
      sessionUrl: "ws://fake",
    });

    expect(platform.invoke).toHaveBeenCalledWith("rec_start", {
      fileId: null,
      liveTranslate: null,
      systemAudio: true,
    });
  });

  it("passes an existing recording and live-translation choice through unchanged", async () => {
    platform.invoke.mockResolvedValueOnce({ fileId: "recording-2", sessionUrl: "ws://fake" });

    await api.recStart({ fileId: "recording-2", liveTranslate: "fr", systemAudio: false });

    expect(platform.invoke).toHaveBeenLastCalledWith("rec_start", {
      fileId: "recording-2",
      liveTranslate: "fr",
      systemAudio: false,
    });
  });
});
