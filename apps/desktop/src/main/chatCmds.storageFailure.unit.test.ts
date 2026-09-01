import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ createRoomFile: vi.fn() }));

vi.mock("./workspace/roomContent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace/roomContent.js")>()),
  createRoomFile: fake.createRoomFile,
}));
vi.mock("./db-host/files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db-host/files.js")>()),
  availableName: (_db: unknown, name: string) => name,
}));

import { importAudioBytesHybrid, importImageBytesHybrid } from "./chatCmds.js";

const bytes = Buffer.from([1, 2, 3]).toString("base64");

function state() {
  return {
    room: {
      conn: {},
      path: "/fabricated/missing-room",
      workspace: {},
    },
    roomEpoch: 4,
  } as never;
}

describe("workspace paste storage failures", () => {
  it("humanizes image and audio write failures without enqueueing audio", async () => {
    const writeFailure = Object.assign(new Error("ENOSPC fabricated write"), { code: "ENOSPC" });
    fake.createRoomFile.mockRejectedValue(writeFailure);
    const enqueueStt = vi.fn();

    await expect(importImageBytesHybrid(state(), "photo.png", bytes)).rejects.toThrow(
      /ENOSPC fabricated write/,
    );
    await expect(importAudioBytesHybrid(state(), { enqueueStt }, "note.m4a", bytes)).rejects.toThrow(
      /ENOSPC fabricated write/,
    );
    expect(enqueueStt).not.toHaveBeenCalled();
  });
});
