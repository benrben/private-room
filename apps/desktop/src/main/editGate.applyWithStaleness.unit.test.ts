import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commitPlans: vi.fn(),
  getFileBytes: vi.fn(),
  getFileName: vi.fn(),
  hashBytes: vi.fn(),
  setFileExtractedText: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  getFileBytes: mocks.getFileBytes,
  getFileName: mocks.getFileName,
  setFileExtractedText: mocks.setFileExtractedText,
}));
vi.mock("./db-host/settings.js", () => ({ getSetting: vi.fn() }));
vi.mock("./editMatch.js", () => ({
  EditError: class EditError extends Error {
    readonly outcome: string;

    constructor(message: string, outcome: string) {
      super(message);
      this.name = "EditError";
      this.outcome = outcome;
    }
  },
  commitPlans: mocks.commitPlans,
  extractText: vi.fn(),
  hashBytes: mocks.hashBytes,
}));

import { applyWithStaleness } from "./editGate.js";

const fakeDb = {} as Parameters<typeof applyWithStaleness>[0];

function hashFor(bytes: Buffer): Buffer {
  return Buffer.from(`fake-hash:${bytes.toString("utf8")}`);
}

function plan(staleness: Buffer | null = hashFor(Buffer.from("before"))) {
  return {
    after: "after",
    before: "before",
    clipped: false,
    count: 1,
    fileId: "file-1",
    method: "exact",
    newBytes: Buffer.from("after"),
    realName: "plan.md",
    renameTo: null,
    staleness,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getFileName.mockReturnValue("plan.md");
  mocks.getFileBytes.mockReturnValue(Buffer.from("before"));
  mocks.hashBytes.mockImplementation(hashFor);
});

describe("applyWithStaleness with fabricated file and commit seams", () => {
  it("commits a plan only after its current identity and byte hash still match", () => {
    const plans = [plan()];

    applyWithStaleness(fakeDb, plans, "fabricated AI edit");

    expect(mocks.getFileName).toHaveBeenCalledWith(fakeDb, "file-1");
    expect(mocks.getFileBytes).toHaveBeenCalledWith(fakeDb, "file-1");
    expect(mocks.commitPlans).toHaveBeenCalledWith(fakeDb, plans, "fabricated AI edit");
  });

  it("refuses a renamed file before looking at its bytes or committing", () => {
    mocks.getFileName.mockReturnValue("renamed.md");

    expect(() => applyWithStaleness(fakeDb, [plan()], "fabricated AI edit")).toThrow(
      '"plan.md" was renamed or removed while the approval was pending',
    );
    expect(mocks.getFileBytes).not.toHaveBeenCalled();
    expect(mocks.commitPlans).not.toHaveBeenCalled();
  });

  it("refuses changed bytes while leaving the fabricated commit boundary untouched", () => {
    mocks.getFileBytes.mockReturnValue(Buffer.from("changed since preview"));

    expect(() => applyWithStaleness(fakeDb, [plan()], "fabricated AI edit")).toThrow(
      '"plan.md" changed while the approval was pending',
    );
    expect(mocks.commitPlans).not.toHaveBeenCalled();
  });

  it("treats a byte-read failure as empty for a matching empty staleness token", () => {
    mocks.getFileBytes.mockImplementation(() => {
      throw new Error("fabricated byte read failure");
    });
    const plans = [plan(hashFor(Buffer.alloc(0)))];

    applyWithStaleness(fakeDb, plans, "fabricated AI edit");

    expect(mocks.commitPlans).toHaveBeenCalledWith(fakeDb, plans, "fabricated AI edit");
  });

  it("preserves rename-only plans and wraps a fabricated commit failure as an edit error", () => {
    const renameOnly = plan(null);
    mocks.commitPlans.mockImplementation(() => {
      throw new Error("fabricated commit failure");
    });

    expect(() => applyWithStaleness(fakeDb, [renameOnly], "fabricated AI edit")).toThrow(
      "fabricated commit failure",
    );
    expect(mocks.getFileBytes).not.toHaveBeenCalled();
  });
});
