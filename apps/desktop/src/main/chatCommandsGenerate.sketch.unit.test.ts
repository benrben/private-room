import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactNote: vi.fn(),
  cmdWindows: vi.fn(),
  createToolEffects: vi.fn(),
  refsContext: vi.fn(),
}));

vi.mock("undici", () => ({ Agent: class Agent {} }));
vi.mock("./cancel.js", () => ({ CancelFlag: class CancelFlag {} }));
vi.mock("./artifactBuilder.js", () => ({ Artifact: { note: mocks.artifactNote } }));
vi.mock("./chatCommandsKnowledge.js", () => ({
  askQuiet: vi.fn(),
  cmdWindows: mocks.cmdWindows,
  digest: vi.fn(),
}));
vi.mock("./docsHtml.js", () => ({
  htmlDocument: vi.fn(),
  htmlEscape: vi.fn((value: string) => value),
  htmlNoteName: vi.fn(),
  refsContext: mocks.refsContext,
  refsFiles: vi.fn(),
}));
vi.mock("./db-host/files.js", () => ({
  availableName: vi.fn(),
  currentDate: vi.fn(),
  getFileFull: vi.fn(),
  listFileInventory: vi.fn(),
  setFileExtractedText: vi.fn(),
}));
vi.mock("./editMatchCells.js", () => ({ serializeDelim: vi.fn() }));
vi.mock("./editMatchExtraction.js", () => ({ extensionOf: vi.fn() }));
vi.mock("./execTool.js", () => ({ createToolEffects: mocks.createToolEffects }));
vi.mock("./ollamaGenerate.js", () => ({ chatStructured: vi.fn(), plainGenerateBody: vi.fn() }));
vi.mock("./turnContext.js", () => ({ isCliEngine: vi.fn() }));
vi.mock("./gatherContext.js", () => ({ webAccessEnabled: vi.fn() }));
vi.mock("./web.js", () => ({ blockedNote: vi.fn(), fetchReadable: vi.fn(), joinNames: vi.fn(), searchWeb: vi.fn() }));
vi.mock("./browser/saved.js", () => ({ linkFileName: vi.fn() }));
vi.mock("./workspace/roomContent.js", () => ({ createRoomFile: vi.fn(), readRoomFile: vi.fn() }));
vi.mock("./sidecarJsonCancellable.js", () => ({
  SIDECAR_DOWN: "sidecar down",
  sidecarErrorSentinel: vi.fn(),
}));
vi.mock("./sidecar.js", () => ({
  authedHeaders: vi.fn(),
  busy: vi.fn(),
  ensureUp: vi.fn(),
  splitCompleteLines: vi.fn(),
  waitForNextChunkOrCancel: vi.fn(),
}));
vi.mock("./privacy.js", () => ({ injectPolicy: vi.fn() }));
vi.mock("./providers.js", () => ({
  defaultProviderDeps: vi.fn(),
  ensureProviderCatalog: vi.fn(),
  injectProviderRuntime: vi.fn(),
}));

import { cmdSketch } from "./chatCommandsGenerate.js";

type Written = { meta: { id: string; name: string } };

type ArtifactFlow = {
  indexedAs: ReturnType<typeof vi.fn>;
  by: ReturnType<typeof vi.fn>;
  duringRun: ReturnType<typeof vi.fn>;
  fromFiles: ReturnType<typeof vi.fn>;
  cancelWith: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  commitToWorkspace: ReturnType<typeof vi.fn>;
};

function artifactFlow(written: Written): ArtifactFlow {
  const flow = {} as ArtifactFlow;
  flow.indexedAs = vi.fn(() => flow);
  flow.by = vi.fn(() => flow);
  flow.duringRun = vi.fn(() => flow);
  flow.fromFiles = vi.fn(() => flow);
  flow.cancelWith = vi.fn(() => flow);
  flow.commit = vi.fn(() => written);
  flow.commitToWorkspace = vi.fn(async () => written);
  mocks.artifactNote.mockReturnValue(flow);
  return flow;
}

function commandContext(options: {
  readonly responses: readonly string[];
  readonly workspace?: object;
  readonly emit?: (event: string, payload: unknown) => void;
  readonly layoutGraph?: ReturnType<typeof vi.fn>;
}) {
  const responses = [...options.responses];
  const step = vi.fn();
  return {
    args: "describe the login journey",
    cancel: { load: vi.fn(() => false) },
    chatStructured: vi.fn(async () => responses.shift() ?? "{}"),
    emit: options.emit,
    history: "",
    layoutGraph: options.layoutGraph,
    model: "fake-model",
    refs: ["brief-file"],
    rooms: {
      current: () => ({ db: { fake: true }, path: "/fake-room", workspace: options.workspace }),
    },
    send: vi.fn(),
    temperature: null,
    turn: { runId: "run-7", step },
    unread: { count: 0 },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.cmdWindows.mockReturnValue(["one fabricated source window"]);
  mocks.createToolEffects.mockReturnValue({ commands: [] });
  mocks.refsContext.mockReturnValue(["fabricated reference context", ["brief.md"]]);
});

describe("cmdSketch with fabricated command boundaries", () => {
  it("writes a one-pass sketch to the fake room DB and announces the saved artifact", async () => {
    const written = { meta: { id: "sketch-1", name: "Login journey.sketch" } };
    const artifact = artifactFlow(written);
    const events: Array<[string, unknown]> = [];
    const layoutGraph = vi.fn(() => ({ toJson: () => '{"fake":true}', extractedText: () => "login path" }));
    const ctx = commandContext({
      responses: [
        JSON.stringify({
          title: "Login journey",
          nodes: [
            { id: "start", label: "Start", kind: "start" },
            { id: "login", label: "Sign in", note: "The user enters credentials." },
          ],
          edges: [{ from: "start", to: "login", label: "opens" }],
        }),
      ],
      emit: (event, payload) => events.push([event, payload]),
      layoutGraph,
    });

    const result = await cmdSketch(ctx as Parameters<typeof cmdSketch>[0]);

    expect(ctx.chatStructured).toHaveBeenCalledWith(
      "fake-model",
      expect.arrayContaining([expect.objectContaining({ content: "Source:\none fabricated source window" })]),
      0.2,
      "30m",
      expect.any(Object),
      { cancel: ctx.cancel },
    );
    expect(layoutGraph).toHaveBeenCalledWith(
      [
        { id: "start", label: "Start", kind: "start" },
        { id: "login", label: "Sign in", note: "The user enters credentials." },
      ],
      [{ from: "start", to: "login", label: "opens" }],
    );
    expect(artifact.indexedAs).toHaveBeenCalledWith("login path");
    expect(artifact.by).toHaveBeenCalledWith("#sketch");
    expect(artifact.duringRun).toHaveBeenCalledWith("run-7");
    expect(artifact.fromFiles).toHaveBeenCalledWith(["brief-file"]);
    expect(artifact.cancelWith).toHaveBeenCalledWith(ctx.cancel);
    expect(artifact.commit).toHaveBeenCalledWith({ fake: true });
    expect(artifact.commitToWorkspace).not.toHaveBeenCalled();
    expect(events).toEqual([
      ["room-files-changed", undefined],
      ["agent-open-file", { id: "sketch-1" }],
    ]);
    expect(result).toMatchObject({
      content: expect.stringContaining("Drew **Login journey.sketch** — 2 box(es) and 1 connection(s)."),
      sources: ["brief.md"],
    });
    expect(ctx.turn.step).toHaveBeenNthCalledWith(1, ctx.send, "Working out what to draw…");
    expect(ctx.turn.step).toHaveBeenNthCalledWith(2, ctx.send, "Drawing it…");
  });

  it("merges multiple fake windows and writes through the fake workspace boundary", async () => {
    mocks.cmdWindows.mockReturnValue(["first part", "second part"]);
    const written = { meta: { id: "sketch-2", name: "Retry flow.sketch" } };
    const artifact = artifactFlow(written);
    const workspace = { fake: true };
    const layoutGraph = vi.fn(() => ({ toJson: () => "{}", extractedText: () => "retry flow" }));
    const ctx = commandContext({
      responses: [
        JSON.stringify({
          title: "Retry flow",
          explanation: "The first part receives a request.",
          nodes: [{ id: "request", label: "Request" }],
          edges: [],
        }),
        JSON.stringify({
          explanation: "The second part retries failures.",
          nodes: [{ id: "request", label: "Ignored duplicate" }, { id: "retry", label: "Retry" }],
          edges: [{ from: "request", to: "retry" }],
        }),
      ],
      workspace,
      layoutGraph,
    });

    const result = await cmdSketch(ctx as Parameters<typeof cmdSketch>[0]);

    expect(layoutGraph).toHaveBeenCalledWith(
      [{ id: "request", label: "Request" }, { id: "retry", label: "Retry" }],
      [{ from: "request", to: "retry" }],
    );
    expect(artifact.commit).not.toHaveBeenCalled();
    expect(artifact.commitToWorkspace).toHaveBeenCalledWith(workspace);
    expect(result.content).toContain("2 box(es) and 1 connection(s), read in 2 passes over the whole source.");
    expect(result.content).toContain("The first part receives a request. The second part retries failures.");
    expect(ctx.turn.step).toHaveBeenNthCalledWith(1, ctx.send, "Working out what to draw — part 1/2…");
    expect(ctx.turn.step).toHaveBeenNthCalledWith(2, ctx.send, "Working out what to draw — part 2/2…");
  });

  it("preserves the no-drawing refusal when fabricated model output has no usable nodes", async () => {
    const layoutGraph = vi.fn();
    const ctx = commandContext({
      responses: [JSON.stringify({ title: "Empty", nodes: [{ id: "", label: "Missing id" }] })],
      layoutGraph,
    });

    await expect(cmdSketch(ctx as Parameters<typeof cmdSketch>[0])).rejects.toThrow(
      "Couldn't find anything to draw in that source.",
    );
    expect(layoutGraph).not.toHaveBeenCalled();
    expect(mocks.artifactNote).not.toHaveBeenCalled();
  });
});
