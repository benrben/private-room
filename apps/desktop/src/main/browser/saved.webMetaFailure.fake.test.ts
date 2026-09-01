import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  insertFileFromUrl: vi.fn(),
  setWebMeta: vi.fn(),
}));

vi.mock("../db-host/files.js", () => ({
  availableName: (_db: unknown, name: string) => name,
  currentDate: () => "2026-09-01",
  getFileMeta: vi.fn(),
  insertFileFromUrl: fakes.insertFileFromUrl,
  setFileExtractedText: vi.fn(),
  setWebMeta: fakes.setWebMeta,
}));
vi.mock("./article.js", () => ({ readPage: vi.fn() }));

import { captureAndSave } from "./saved.js";

describe("saved page metadata persistence", () => {
  it("keeps a successfully saved selection when optional web metadata storage fails", async () => {
    const journal = vi.fn();
    const scheduleAutoIndex = vi.fn();
    const schedulePrivacyScan = vi.fn();
    const emitFilesChanged = vi.fn();
    fakes.insertFileFromUrl.mockResolvedValue({ id: "saved-1", name: "Selected page (selection).md" });
    fakes.setWebMeta.mockImplementation(() => {
      throw new Error("fabricated metadata write refusal");
    });

    const reply = await captureAndSave(
      {
        browser: {
          call: vi.fn().mockResolvedValue({
            title: "Selected page",
            url: "https://example.invalid/page",
            text: "Selected words",
            html: "",
            truncated: false,
          }),
          journal,
        },
        db: {} as never,
        roomPath: "/fabricated/room.roomai",
        scheduleAutoIndex,
        schedulePrivacyScan,
        emitFilesChanged,
      },
      "selection",
    );

    expect(reply).toContain('"Selected page (selection).md"');
    expect(fakes.setWebMeta).toHaveBeenCalledOnce();
    expect(journal).toHaveBeenCalledWith(
      "save",
      "https://example.invalid/page",
      "Saved Selected page (selection).md",
    );
    expect(scheduleAutoIndex).toHaveBeenCalledWith("/fabricated/room.roomai");
    expect(schedulePrivacyScan).toHaveBeenCalledOnce();
    expect(emitFilesChanged).toHaveBeenCalledOnce();
  });
});
