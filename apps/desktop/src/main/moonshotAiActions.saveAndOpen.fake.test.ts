import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  commit: vi.fn(),
  commitToWorkspace: vi.fn(),
  getFileExtractedText: vi.fn(),
  getFileName: vi.fn(),
  resolveStructuredModel: vi.fn(),
}));

vi.mock("./artifactBuilder.js", () => ({
  Artifact: class FakeArtifact {
    static new() {
      return new FakeArtifact();
    }
    by() {
      return this;
    }
    commit(db: unknown) {
      return fakes.commit(db);
    }
    commitToWorkspace(workspace: unknown) {
      return fakes.commitToWorkspace(workspace);
    }
  },
}));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: () => true }));
vi.mock("./db-host/files.js", () => ({
  getFileExtractedText: fakes.getFileExtractedText,
  getFileName: fakes.getFileName,
  listFiles: vi.fn(),
}));
vi.mock("./moonshotCmds.js", () => ({ resolveStructuredModel: fakes.resolveStructuredModel }));

import { createCancelState } from "./cancel.js";
import { aiAction } from "./moonshotAiActions.js";

describe("AI action workspace save and open", () => {
  it("commits through the workspace and emits refresh/open only after the write succeeds", async () => {
    const workspace = { tag: "fabricated-workspace" };
    const db = { tag: "fabricated-db" };
    const send = vi.fn();
    const meta = { id: "generated-1", name: "Summarize - Source.md" };
    fakes.getFileName.mockReturnValue("Source.md");
    fakes.getFileExtractedText.mockReturnValue("Readable source text");
    fakes.resolveStructuredModel.mockResolvedValue("fake-model");
    fakes.commitToWorkspace.mockResolvedValue({ meta, versioned: false });

    await expect(
      aiAction(
        {
          rooms: {
            currentRoom: () => ({ db, path: "/fake/room", name: "Fake room", workspace }) as never,
          },
          cancelState: createCancelState(),
          send,
          post: vi.fn().mockResolvedValue({ kind: "value", value: { markdown: "# Summary" } }),
        },
        "summarize",
        "source-1",
        null,
        null,
        null,
        null,
      ),
    ).resolves.toEqual(meta);

    expect(fakes.commitToWorkspace).toHaveBeenCalledWith(workspace);
    expect(fakes.commit).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("room-files-changed", undefined);
    expect(send).toHaveBeenCalledWith("agent-open-file", { id: "generated-1" });
  });

  it("commits through the encrypted database when no workspace runtime is present", async () => {
    const db = { tag: "fabricated-db" };
    const meta = { id: "generated-db-1", name: "Summarize - Source.md" };
    fakes.getFileName.mockReturnValue("Source.md");
    fakes.getFileExtractedText.mockReturnValue("Readable source text");
    fakes.resolveStructuredModel.mockResolvedValue("fake-model");
    fakes.commit.mockReturnValue({ meta, versioned: false });

    await expect(
      aiAction(
        {
          rooms: { currentRoom: () => ({ db, path: "/fake/room", name: "Fake room" }) as never },
          cancelState: createCancelState(),
          send: vi.fn(),
          post: vi.fn().mockResolvedValue({ kind: "value", value: { markdown: "# Summary" } }),
        },
        "summarize",
        "source-1",
        null,
        null,
        null,
        null,
      ),
    ).resolves.toEqual(meta);

    expect(fakes.commit).toHaveBeenCalledWith(db);
  });
});
