import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  getFileExtractedText: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  availableName: vi.fn(),
  currentDate: vi.fn(),
  getFileExtractedText: files.getFileExtractedText,
  getFileMeta: vi.fn(),
  inTransaction: vi.fn(),
  insertFile: vi.fn(),
  listFilesBrief: vi.fn(),
  newSourceFileCount: vi.fn(),
  setFileAiSummary: vi.fn(),
  setFileExtractedText: vi.fn(),
  updateFileContent: vi.fn(),
}));

import { appendedWorkspaceContent } from "./workflowEngine.js";

const fakeDb = {} as never;

beforeEach(() => {
  files.getFileExtractedText.mockReset();
});

describe("appendedWorkspaceContent with a fabricated workspace row", () => {
  it("preserves markdown text and joins the new workflow input with one blank line", () => {
    files.getFileExtractedText.mockReturnValue("existing markdown");

    expect(appendedWorkspaceContent(
      fakeDb,
      "fake-file",
      { name: "Log.md", mime: "text/markdown", extension: "md", content: "unused" },
      "new workflow content",
    )).toBe("existing markdown\n\nnew workflow content");
    expect(files.getFileExtractedText).toHaveBeenCalledWith(fakeDb, "fake-file");
  });

  it("uses an empty markdown prefix when the fabricated extracted text is absent", () => {
    files.getFileExtractedText.mockReturnValue(null);

    expect(appendedWorkspaceContent(
      fakeDb,
      "fake-file",
      { name: "Log.md", mime: "text/markdown", extension: "md", content: "unused" },
      "new workflow content",
    )).toBe("\n\nnew workflow content");
  });

  it("inserts html workflow output into the existing document rather than duplicating it", () => {
    files.getFileExtractedText.mockReturnValue("<!doctype html><main><p>old</p></main></html>");

    const appended = appendedWorkspaceContent(
      fakeDb,
      "fake-file",
      { name: "Report.html", mime: "text/html", extension: "html", content: "unused" },
      " <p>new</p> ",
    );

    expect(appended).toBe("<!doctype html><main><p>old</p>\n<hr/>\n<p>new</p>\n</main></html>");
    expect((appended.match(/<!doctype html>/g) ?? [])).toHaveLength(1);
  });
});
