import { describe, expect, it, vi } from "vitest";
import type { BrowserImportDeps } from "./browserSurfaceIpc";
import { importBytes } from "./browserSurfaceIpc";

type MutableDeps = BrowserImportDeps & Record<string, ReturnType<typeof vi.fn>>;

function deps(overrides: Partial<BrowserImportDeps> = {}): MutableDeps {
  const value = {
    afterImport: vi.fn(),
    availableName: vi.fn((_db: unknown, name: string) => `available-${name}`),
    createReadStream: vi.fn(() => ({ kind: "binary-stream" })),
    getFileMeta: vi.fn(() => ({ id: "saved", name: "saved.txt" })),
    guessDownloadMime: vi.fn(() => "text/plain"),
    insertFileFromUrl: vi.fn(() => ({ id: "legacy", name: "saved.txt" })),
    readBytes: vi.fn(async () => Buffer.from("café", "utf8")),
    readText: vi.fn(async () => "café"),
    safeFileName: vi.fn((name: string) => name),
    setFileExtractedText: vi.fn(),
    textStream: vi.fn(() => ({ kind: "text-stream" })),
    ...overrides,
  };
  return value as unknown as MutableDeps;
}

function room(workspace: unknown = undefined) {
  const run = vi.fn();
  const prepare = vi.fn(() => ({ run }));
  const open = { conn: { prepare }, workspace };
  return {
    room: open,
    prepare,
    run,
  };
}

describe("importBytes", () => {
  it("validates an open room before touching staged bytes or emitting file events", async () => {
    const d = deps();

    await expect(importBytes(null, "/staged/file", "note.txt", "https://example.test", d))
      .rejects.toThrow("No room is open.");

    expect(d.readBytes).not.toHaveBeenCalled();
    expect(d.afterImport).not.toHaveBeenCalled();
  });

  it("persists legacy text bytes with their UTF-8 extraction and reports the completed import", async () => {
    const { room: open } = room();
    const d = deps({
      safeFileName: vi.fn(() => "note.txt"),
      availableName: vi.fn(() => "note (2).txt"),
    });

    const meta = await importBytes(open as never, "/staged/note", "unsafe/name.txt", "https://example.test/note", d);

    expect(d.safeFileName).toHaveBeenCalledWith("unsafe/name.txt");
    expect(d.availableName).toHaveBeenCalledWith(open.conn, "note.txt");
    expect(d.readBytes).toHaveBeenCalledWith("/staged/note");
    expect(d.insertFileFromUrl).toHaveBeenCalledWith(
      open.conn,
      "note (2).txt",
      "text/plain",
      Buffer.from("café", "utf8"),
      "café",
      "web",
      "https://example.test/note",
    );
    expect(d.readText).not.toHaveBeenCalled();
    expect(d.afterImport).toHaveBeenCalledOnce();
    expect(meta).toEqual({ id: "legacy", name: "saved.txt" });
  });

  it("writes workspace text through its content stream before updating metadata and extraction", async () => {
    const createFile = vi.fn(async () => ({ fileId: "workspace-file" }));
    const { room: open, prepare, run } = room({ createFile });
    const d = deps();

    const meta = await importBytes(open as never, "/staged/note", "note.txt", "https://example.test/note", d);

    expect(d.readText).toHaveBeenCalledWith("/staged/note");
    expect(d.textStream).toHaveBeenCalledWith("café");
    expect(createFile).toHaveBeenCalledWith(
      "available-note.txt",
      expect.objectContaining({ kind: "text-stream" }),
      "web",
    );
    expect(prepare).toHaveBeenCalledWith(
      "UPDATE files SET mime_type = ?, origin_url = ? WHERE id = ?",
    );
    expect(run).toHaveBeenCalledWith("text/plain", "https://example.test/note", "workspace-file");
    expect(d.setFileExtractedText).toHaveBeenCalledWith(open.conn, "workspace-file", "café");
    expect(d.getFileMeta).toHaveBeenCalledWith(open.conn, "workspace-file");
    expect(d.afterImport).toHaveBeenCalledOnce();
    expect(meta).toEqual({ id: "saved", name: "saved.txt" });
  });

  it("streams binary workspace content without text extraction and does not emit on a failed write", async () => {
    const createFile = vi.fn(async () => ({ fileId: "workspace-file" }));
    const { room: open } = room({ createFile });
    const d = deps({ guessDownloadMime: vi.fn(() => "application/zip") });

    await importBytes(open as never, "/staged/archive", "archive.zip", "https://example.test/archive", d);

    expect(d.readText).not.toHaveBeenCalled();
    expect(d.createReadStream).toHaveBeenCalledWith("/staged/archive");
    expect(d.setFileExtractedText).not.toHaveBeenCalled();
    expect(d.afterImport).toHaveBeenCalledOnce();

    createFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(importBytes(open as never, "/staged/archive", "archive.zip", "https://example.test/archive", d))
      .rejects.toThrow("disk full");
    expect(d.afterImport).toHaveBeenCalledOnce();
  });
});
