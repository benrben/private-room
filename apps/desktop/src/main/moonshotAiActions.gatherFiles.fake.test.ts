import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

const fakes = vi.hoisted(() => ({
  clampBytes: vi.fn(),
  getFileExtractedText: vi.fn(),
  getFileName: vi.fn(),
  names: new Map<string, string>(),
  texts: new Map<string, string | null>(),
  titleFromName: vi.fn(),
}));

vi.mock("./artifactBuilder.js", () => ({ Artifact: class FakeArtifact {} }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: vi.fn() }));
vi.mock("./cancel.js", () => ({
  CancelFlag: class FakeCancelFlag {},
  childOfRun: vi.fn(),
  forget: vi.fn(),
  guardCommit: vi.fn(),
  remember: vi.fn(),
}));
vi.mock("./db-host/files.js", () => ({
  getFileExtractedText: fakes.getFileExtractedText,
  getFileName: fakes.getFileName,
  listFiles: vi.fn(),
}));
vi.mock("./db-host/messages.js", () => ({ listMessages: vi.fn() }));
vi.mock("./db-host/retrieval.js", () => ({ stripMarkupBlocks: vi.fn() }));
vi.mock("./docsHtml.js", () => ({ titleFromName: fakes.titleFromName }));
vi.mock("./engineRouting.js", () => ({ resolvedBaseUrl: vi.fn() }));
vi.mock("./moonshotCmds.js", () => ({ resolveStructuredModel: vi.fn() }));
vi.mock("./sidecarJsonCancellable.js", () => ({ sidecarErrorSentinel: vi.fn(), sidecarJsonCancellable: vi.fn() }));
vi.mock("./summarizeTools.js", () => ({ isSummaryFile: vi.fn() }));
vi.mock("./textClamp.js", () => ({ clampBytes: fakes.clampBytes }));
vi.mock("./turnNotices.js", () => ({ isFailureNotice: vi.fn() }));
vi.mock("./turn.js", () => ({ emitUnowned: vi.fn() }));

import { gatherFilesText } from "./moonshotAiActions.js";

const db = {} as Database.Database;

function addFakeFile(id: string, name: string, text: string | null): void {
  fakes.names.set(id, name);
  fakes.texts.set(id, text);
}

beforeEach(() => {
  fakes.names.clear();
  fakes.texts.clear();
  fakes.getFileName.mockImplementation((_db: unknown, id: string) => {
    const name = fakes.names.get(id);
    if (name === undefined) throw new Error(`Missing fake file ${id}`);
    return name;
  });
  fakes.getFileExtractedText.mockImplementation((_db: unknown, id: string) => fakes.texts.get(id) ?? null);
  fakes.clampBytes.mockImplementation((text: string, max: number) => text.slice(0, max));
  fakes.titleFromName.mockImplementation((name: string) => name.replace(/\.[^.]+$/, ""));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("gatherFilesText", () => {
  it("gathers a readable mentioned file under its display name and per-file cap", () => {
    const body = "a".repeat(3_001);
    addFakeFile("report", "Report.md", body);

    const [label, text] = gatherFilesText(db, ["report"]);

    expect(label).toBe("Report");
    expect(text).toBe(`## Report.md\n${"a".repeat(3_000)}\n\n`);
    expect(fakes.clampBytes).toHaveBeenCalledWith(body, 3_000);
  });

  it("skips missing and unreadable mentions while stopping before a fifth capped file", () => {
    addFakeFile("null-text", "Null.md", null);
    addFakeFile("blank-text", "Blank.md", "   ");
    for (const id of ["one", "two", "three", "four", "five"]) {
      addFakeFile(id, `${id}.md`, id.repeat(1_500));
    }

    const [label, text] = gatherFilesText(db, ["missing", "null-text", "blank-text", "one", "two", "three", "four", "five"]);

    expect(label).toBe("4 files");
    expect(text).toContain("## one.md");
    expect(text).toContain("## four.md");
    expect(text).not.toContain("## five.md");
    expect(fakes.clampBytes).not.toHaveBeenCalledWith("five".repeat(1_500), 3_000);
  });

  it("reports when no mentioned fake file has readable text", () => {
    addFakeFile("empty", "Empty.md", "\n\t");
    addFakeFile("null", "Null.md", null);

    expect(() => gatherFilesText(db, ["missing", "empty", "null"])).toThrow(
      "The files you mentioned have no readable text to work with."
    );
  });
});
