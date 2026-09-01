import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  docxReplaceText: vi.fn(),
  isUnicodeWhitespace: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({ getFileFull: vi.fn(), getFileMeta: vi.fn() }));
vi.mock("./editMatchExtraction.js", () => ({
  extensionOf: vi.fn(),
  isUnicodeWhitespace: mocks.isUnicodeWhitespace,
}));
vi.mock("./editMatch.js", () => ({ extractText: vi.fn(), storeFileBytes: vi.fn() }));
vi.mock("./editMatchDocx.js", () => ({ docxReplaceText: mocks.docxReplaceText }));
vi.mock("./workspace/roomContent.js", () => ({ readRoomFile: vi.fn(), writeRoomFile: vi.fn() }));

import { applyParagraphEdits, openDb, trimUnicode, type RoomSource } from "./docxEdit.js";

const NEL = String.fromCharCode(0x85);
const BOM = String.fromCharCode(0xfeff);

describe("applyParagraphEdits Unicode paragraph trimming with fabricated DOCX replacement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isUnicodeWhitespace.mockImplementation((value: string) => value === " " || value === "\t" || value === NEL);
    mocks.docxReplaceText.mockImplementation((bytes: Uint8Array) => ({
      ok: true,
      count: 1,
      bytes: Buffer.concat([Buffer.from(bytes), Buffer.from("-patched")]),
    }));
  });

  it("ignores NEL and ordinary-whitespace-only lines without touching fabricated DOCX bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);

    expect(applyParagraphEdits(bytes, "Alpha", `Alpha\n${NEL}\n  \t`)).toBeNull();
    expect(mocks.docxReplaceText).not.toHaveBeenCalled();
  });

  it("retains a BOM paragraph after trimming leading Unicode whitespace and routes its edit through the fake matcher", () => {
    const bytes = new Uint8Array([4, 5]);
    const before = `${NEL}${BOM}\nAlpha`;
    const after = "Heading\nAlpha";

    const patched = applyParagraphEdits(bytes, before, after);

    expect(patched).toEqual(Buffer.from([4, 5, ...Buffer.from("-patched")]));
    expect(mocks.docxReplaceText).toHaveBeenCalledWith(bytes, `${NEL}${BOM}`, "Heading");
    expect(mocks.isUnicodeWhitespace).toHaveBeenCalledWith(NEL);
    expect(mocks.isUnicodeWhitespace).toHaveBeenCalledWith(BOM);
  });

  it("does not silently drop a BOM-only paragraph as whitespace", () => {
    const bytes = new Uint8Array([6]);

    expect(() => applyParagraphEdits(bytes, `${BOM}\nAlpha`, "Alpha"))
      .toThrow("the document has 2 and the edited text has 1");
    expect(mocks.docxReplaceText).not.toHaveBeenCalled();
  });
});

describe("trimUnicode", () => {
  it("trims both ends using the fabricated Rust-compatible whitespace predicate", () => {
    expect(trimUnicode(`${NEL}\tHeading ${NEL}`)).toBe("Heading");
  });

  it("keeps a BOM because the fabricated predicate does not classify it as whitespace", () => {
    expect(trimUnicode(`${NEL}${BOM}${NEL}`)).toBe(BOM);
  });
});

describe("openDb", () => {
  it("returns the exact fabricated database from the current room", () => {
    const db = { label: "in-memory database" };
    const currentRoom = vi.fn(() => ({ db } as never));
    const room: RoomSource = { currentRoom };

    expect(openDb(room)).toBe(db);
    expect(currentRoom).toHaveBeenCalledOnce();
  });

  it("refuses a fabricated absent room without reaching a database boundary", () => {
    const currentRoom = vi.fn(() => null);
    const room: RoomSource = { currentRoom };

    expect(() => openDb(room)).toThrow("No room is open.");
    expect(currentRoom).toHaveBeenCalledOnce();
  });
});
