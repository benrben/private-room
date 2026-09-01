import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  askQuiet: vi.fn(),
  availableName: vi.fn(),
  blockedNote: vi.fn(),
  createRoomFile: vi.fn(),
  createToolEffects: vi.fn(),
  currentDate: vi.fn(),
  digest: vi.fn(),
  fetchReadable: vi.fn(),
  generateStream: vi.fn(),
  getFileFull: vi.fn(),
  joinNames: vi.fn(),
  linkFileName: vi.fn(),
  listFileInventory: vi.fn(),
  plainGenerateBody: vi.fn(),
  prepare: vi.fn(),
  run: vi.fn(),
  searchWeb: vi.fn(),
  setFileExtractedText: vi.fn(),
  step: vi.fn(),
  emit: vi.fn(),
  webAccessEnabled: vi.fn(),
}));

vi.mock("./chatCommandsKnowledge.js", () => ({
  askQuiet: fakes.askQuiet,
  cmdWindows: vi.fn(),
  digest: fakes.digest,
}));
vi.mock("./gatherContext.js", () => ({ webAccessEnabled: fakes.webAccessEnabled }));
vi.mock("./web.js", () => ({
  blockedNote: fakes.blockedNote,
  fetchReadable: fakes.fetchReadable,
  joinNames: fakes.joinNames,
  searchWeb: fakes.searchWeb,
}));
vi.mock("./db-host/files.js", () => ({
  availableName: fakes.availableName,
  currentDate: fakes.currentDate,
  getFileFull: fakes.getFileFull,
  listFileInventory: fakes.listFileInventory,
  setFileExtractedText: fakes.setFileExtractedText,
}));
vi.mock("./workspace/roomContent.js", () => ({
  createRoomFile: fakes.createRoomFile,
  readRoomFile: vi.fn(),
}));
vi.mock("./browser/saved.js", () => ({ linkFileName: fakes.linkFileName }));
vi.mock("./execTool.js", () => ({ createToolEffects: fakes.createToolEffects }));
vi.mock("./ollamaGenerate.js", () => ({
  chatStructured: vi.fn(),
  plainGenerateBody: fakes.plainGenerateBody,
}));

import { cmdResearch, type CmdCtx } from "./chatCommandsGenerate.js";

const emptySearch = { hits: [], merged: 0, tookMs: 0, cached: false, failed: [] };
const fakeDb = { prepare: fakes.prepare };

function context(overrides: Partial<CmdCtx> = {}): CmdCtx {
  return {
    rooms: { current: () => ({ db: fakeDb, path: "/fabricated/room" }) },
    send: vi.fn(),
    emit: fakes.emit,
    turn: { step: fakes.step, emit: fakes.emit },
    model: "fabricated-model",
    refs: [],
    args: "fabricated research question",
    history: "",
    cancel: { load: () => false },
    unread: { count: 0 },
    temperature: null,
    generateStream: fakes.generateStream,
    ...overrides,
  } as unknown as CmdCtx;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.prepare.mockReturnValue({ run: fakes.run });
  fakes.webAccessEnabled.mockReturnValue(true);
  fakes.searchWeb.mockResolvedValue(emptySearch);
  fakes.blockedNote.mockReturnValue(null);
  fakes.joinNames.mockImplementation((names: readonly string[]) => names.join(" and "));
  fakes.fetchReadable.mockResolvedValue({ title: "Fabricated source", text: "Fabricated evidence" });
  fakes.currentDate.mockReturnValue("2026-09-01");
  fakes.linkFileName.mockImplementation((title: string) => `${title}.md`);
  fakes.availableName.mockImplementation((_db: unknown, name: string) => name);
  fakes.createRoomFile.mockImplementation(async (_room: unknown, name: string) => ({ id: `saved-${name}`, name }));
  fakes.digest.mockImplementation(async (_ctx: unknown, text: string) => text);
  fakes.plainGenerateBody.mockReturnValue({ fabricated: true });
  fakes.generateStream.mockResolvedValue("Answer from fabricated sources.");
  fakes.createToolEffects.mockReturnValue({ fabricated: true });
});

describe("cmdResearch with fabricated boundaries", () => {
  it("rejects a missing question before opening a room or searching", async () => {
    await expect(cmdResearch(context({ args: "  " }))).rejects.toThrow("Usage: #research <question>");

    expect(fakes.webAccessEnabled).not.toHaveBeenCalled();
    expect(fakes.searchWeb).not.toHaveBeenCalled();
  });

  it("rejects a valid question when no fabricated room is open", async () => {
    await expect(cmdResearch(context({ rooms: { current: () => null } } as never))).rejects.toThrow("No room is open.");

    expect(fakes.webAccessEnabled).not.toHaveBeenCalled();
    expect(fakes.searchWeb).not.toHaveBeenCalled();
  });

  it("refuses research while fabricated web access is disabled", async () => {
    fakes.webAccessEnabled.mockReturnValue(false);

    await expect(cmdResearch(context())).resolves.toMatchObject({
      content: expect.stringContaining("Web access is off in this room."),
      sources: [],
    });
    expect(fakes.searchWeb).not.toHaveBeenCalled();
  });

  it("reports a fabricated unavailable search without reading or saving anything", async () => {
    fakes.searchWeb.mockResolvedValue({ ...emptySearch, failed: ["Fabricated Search"] });
    fakes.blockedNote.mockReturnValue("A fabricated failure note");

    await expect(cmdResearch(context({ args: "history of fabrications" }))).resolves.toMatchObject({
      content: expect.stringContaining("did not run"),
      sources: [],
    });
    expect(fakes.fetchReadable).not.toHaveBeenCalled();
    expect(fakes.createRoomFile).not.toHaveBeenCalled();
    expect(fakes.generateStream).not.toHaveBeenCalled();
  });

  it("refuses to answer when every fabricated page is unreadable", async () => {
    fakes.searchWeb.mockResolvedValue({
      ...emptySearch,
      hits: [{ title: "Blocked page", url: "https://fabricated.test/blocked", engines: ["fake"], score: 1 }],
    });
    fakes.fetchReadable.mockRejectedValueOnce(new Error("fabricated page refusal"));

    await expect(cmdResearch(context())).resolves.toMatchObject({
      content: expect.stringContaining("couldn't save any readable copies"),
      sources: [],
    });
    expect(fakes.createRoomFile).not.toHaveBeenCalled();
    expect(fakes.generateStream).not.toHaveBeenCalled();
  });

  it("saves unique fabricated sources and answers only from their fabricated context", async () => {
    fakes.searchWeb.mockResolvedValue({
      ...emptySearch,
      hits: [
        { title: "First source", url: "https://fabricated.test/first", engines: ["fake"], score: 2 },
        { title: "Repeated source", url: "https://fabricated.test/first", engines: ["fake"], score: 1 },
        { title: "Second source", url: "https://fabricated.test/second", engines: ["fake"], score: 1 },
      ],
    });
    fakes.fetchReadable.mockImplementation(async (url: string) => (
      url.endsWith("first")
        ? { title: "First saved", text: "First fabricated evidence" }
        : { title: "Second saved", text: "Second fabricated evidence" }
    ));

    await expect(cmdResearch(context({ args: "what did the fabricated sources say" }))).resolves.toMatchObject({
      content: "Answer from fabricated sources.",
      sources: ["First saved.md", "Second saved.md"],
    });
    expect(fakes.fetchReadable).toHaveBeenCalledTimes(2);
    expect(fakes.createRoomFile.mock.calls.map(([, name]) => name)).toEqual(["First saved.md", "Second saved.md"]);
    expect(fakes.generateStream).toHaveBeenCalledOnce();
    expect(fakes.emit).toHaveBeenCalledWith("room-files-changed", undefined);
  });
});
