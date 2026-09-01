import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  getFileMeta: vi.fn(),
  readRoomFile: vi.fn(),
  writeRoomFile: vi.fn(),
}));

vi.mock("./db-host/files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db-host/files.js")>()),
  getFileMeta: fake.getFileMeta,
}));
vi.mock("./workspace/roomContent.js", () => ({
  readRoomFile: fake.readRoomFile,
  writeRoomFile: fake.writeRoomFile,
}));

import { updateDocxTextInRoom } from "./docxEdit.js";

beforeEach(() => vi.clearAllMocks());

describe("workspace Word edit preconditions", () => {
  const open = { db: { marker: "db" }, path: "/fake/room" } as never;

  it("refuses a Word file with no readable text", async () => {
    fake.readRoomFile.mockResolvedValue({ name: "broken.docx", bytes: Buffer.from("zip"), extractedText: null });

    await expect(updateDocxTextInRoom(open, "file-1", "new text")).rejects.toThrow(
      '"broken.docx" has no readable text',
    );
    expect(fake.writeRoomFile).not.toHaveBeenCalled();
  });

  it("returns existing metadata for an unchanged workspace document", async () => {
    const meta = { id: "file-1", name: "empty.docx" };
    fake.readRoomFile.mockResolvedValue({ name: "empty.docx", bytes: Buffer.from("zip"), extractedText: "" });
    fake.getFileMeta.mockReturnValue(meta);

    await expect(updateDocxTextInRoom(open, "file-1", "")).resolves.toBe(meta);
    expect(fake.getFileMeta).toHaveBeenCalledWith(open.db, "file-1");
    expect(fake.writeRoomFile).not.toHaveBeenCalled();
  });
});
