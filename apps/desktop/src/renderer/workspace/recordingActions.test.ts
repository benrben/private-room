import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRecordingActions } from "./recordingActions";

const mocks = vi.hoisted(() => {
  const api = {
    aiStatus: vi.fn(),
    dictStart: vi.fn(),
    getSetting: vi.fn(),
    shapeText: vi.fn(),
    recStart: vi.fn(),
    recLiveStatus: vi.fn(),
    listFiles: vi.fn(),
    recPause: vi.fn(),
    recResume: vi.fn(),
    recStop: vi.fn(),
    cancelAsk: vi.fn(),
    pullModel: vi.fn(),
    openOllama: vi.fn(),
    importAudioBytes: vi.fn(),
    getFileContent: vi.fn(),
    updateFileContent: vi.fn(),
    saveGeneratedFile: vi.fn(),
    createFolder: vi.fn(),
    moveFileToFolder: vi.fn(),
    listFolders: vi.fn(),
  };
  return {
    api,
    acquireMic: vi.fn(),
    attachMicTap: vi.fn(),
    createPcmTap: vi.fn(),
    micConstraints: vi.fn(),
    noteLiveStt: vi.fn(),
    stopMicTap: vi.fn(),
    startRecordingTransport: vi.fn(),
    closeRecordingTransport: vi.fn(),
    connectDictSession: vi.fn(),
    base64ToBytes: vi.fn(),
    fileToBase64: vi.fn(),
    openUrl: vi.fn(),
  };
});

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("../platform", () => ({ openUrl: mocks.openUrl }));
vi.mock("./composer", () => ({ fileToBase64: mocks.fileToBase64 }));
vi.mock("./liveRec", () => ({
  acquireMic: mocks.acquireMic,
  attachMicTap: mocks.attachMicTap,
  createPcmTap: mocks.createPcmTap,
  micConstraints: mocks.micConstraints,
  noteLiveStt: mocks.noteLiveStt,
  stopMicTap: mocks.stopMicTap,
}));
vi.mock("./recordingTransport", () => ({
  closeRecordingTransport: mocks.closeRecordingTransport,
  startRecordingTransport: mocks.startRecordingTransport,
}));
vi.mock("../viewers/util", () => ({ base64ToBytes: mocks.base64ToBytes }));
vi.mock("./dictSession", () => ({ connectDictSession: mocks.connectDictSession }));

const originalGlobals = {
  MediaRecorder: Reflect.get(globalThis, "MediaRecorder"),
  navigator: Reflect.get(globalThis, "navigator"),
  window: Reflect.get(globalThis, "window"),
};

function resetMocks() {
  for (const value of Object.values(mocks.api)) value.mockReset();
  [
    mocks.acquireMic,
    mocks.attachMicTap,
    mocks.createPcmTap,
    mocks.micConstraints,
    mocks.noteLiveStt,
    mocks.stopMicTap,
    mocks.startRecordingTransport,
    mocks.closeRecordingTransport,
    mocks.connectDictSession,
    mocks.base64ToBytes,
    mocks.fileToBase64,
    mocks.openUrl,
  ].forEach((mock) => mock.mockReset());
}

function mediaStream() {
  const stop = vi.fn();
  return { getTracks: () => [{ stop }] } as unknown as MediaStream & { stop: ReturnType<typeof vi.fn> };
}

function state(overrides: Record<string, unknown> = {}) {
  const s: Record<string, any> = {
    dictState: "idle", dictOwner: null, recLive: null, handsFree: false,
    files: [], folders: [], openFile: null, openFileRef: { current: null },
    recorderRef: { current: null }, dictChunksRef: { current: [] }, dictStreamRef: { current: null },
    pullingModel: false, pullingModelRef: { current: null }, recheckTimer: { current: 0 },
    setDictState: vi.fn((value) => { s.dictState = value; }),
    setDictOwner: vi.fn((value) => { s.dictOwner = value; }),
    setDictPartial: vi.fn(),
    setRecLive: vi.fn((value) => { s.recLive = typeof value === "function" ? value(s.recLive) : value; }),
    setFiles: vi.fn((value) => { s.files = value; }),
    setFolders: vi.fn((value) => { s.folders = value; }),
    setAi: vi.fn(), setModel: vi.fn(), setShowSettings: vi.fn(), pushToast: vi.fn(),
    setPullingModel: vi.fn(), setPullError: vi.fn(), setPullStatus: vi.fn(), setPullPercent: vi.fn(),
    ...overrides,
  };
  return s;
}

function installMediaRecorder() {
  class FakeMediaRecorder {
    static isTypeSupported = vi.fn(() => true);
    mimeType = "audio/mp4";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => Promise<void>) | null = null;
    start = vi.fn();
    stop = vi.fn();
  }
  Reflect.set(globalThis, "MediaRecorder", FakeMediaRecorder);
  return FakeMediaRecorder;
}

function installNavigator(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { mediaDevices: { getUserMedia } },
  });
}

function installIntervalWindow() {
  const callbacks: Array<() => Promise<void>> = [];
  const clearInterval = vi.fn();
  const setInterval = vi.fn((callback: () => Promise<void>) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { clearInterval, setInterval },
  });
  return { callbacks, clearInterval, setInterval };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeEach(() => {
  resetMocks();
  mocks.micConstraints.mockReturnValue({ echoCancellation: true });
  mocks.api.listFiles.mockResolvedValue([]);
  mocks.api.recLiveStatus.mockResolvedValue({ sys: ["on"] });
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
  vi.clearAllMocks();
});

describe("recording actions", () => {
  it("reports each microphone state to its owner and blocks every other control", () => {
    const s = state();
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });
    const owner = "composer";

    const ownerStates = [
      ["recording", "Stop recording"],
      ["busy", "Transcribing…"],
      ["preparing", "Preparing the microphone…"],
      ["idle", "Dictate (transcribed on this Mac)"],
    ];
    for (const [dictState, title] of ownerStates) {
      s.dictState = dictState;
      s.dictOwner = owner;
      expect(actions.micState(owner)).toEqual({ cls: dictState, title, disabled: false });
    }

    s.dictState = "recording";
    s.dictOwner = owner;
    expect(actions.micState("journal")).toEqual({
      cls: "idle",
      title: "Dictate (transcribed on this Mac)",
      disabled: true,
    });
    expect(mocks.acquireMic).not.toHaveBeenCalled();
  });

  it("appends a fabricated journal dictation to the current daily entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    try {
      const name = "Journal 2026-09-01.md";
      const s = state({ files: [{ id: "journal-1", name }] });
      const ready = deferred<void>();
      const finished = deferred<void>();
      const stream = mediaStream();
      const session = { push: vi.fn(), stop: vi.fn().mockResolvedValue("Morning reflection"), cancel: vi.fn() };
      mocks.acquireMic.mockResolvedValue(stream);
      mocks.api.dictStart.mockResolvedValue({ url: "ws://fake" });
      mocks.connectDictSession.mockResolvedValue(session);
      mocks.createPcmTap.mockResolvedValue(vi.fn().mockResolvedValue(undefined));
      mocks.api.getSetting.mockResolvedValue(null);
      mocks.api.getFileContent.mockResolvedValue({ text: "Yesterday's note  \n" });
      mocks.api.listFiles.mockResolvedValue([{ id: "journal-1", name }]);
      s.setDictState = vi.fn((value) => {
        s.dictState = value;
        if (value === "recording") ready.resolve();
        if (value === "idle") finished.resolve();
      });
      s.pushToast = vi.fn();
      const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

      actions.dictateJournal();
      await ready.promise;
      s.dictStreamRef.current?.();
      await finished.promise;

      expect(mocks.api.getFileContent).toHaveBeenCalledWith("journal-1");
      expect(mocks.api.updateFileContent).toHaveBeenCalledWith(
        "journal-1",
        "Yesterday's note\n\nMorning reflection\n",
      );
      expect(mocks.api.saveGeneratedFile).not.toHaveBeenCalled();
      expect(s.setFiles).toHaveBeenCalledWith([{ id: "journal-1", name }]);
      expect(s.dictState).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fabricated existing journal entry from empty content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    try {
      const name = "Journal 2026-09-01.md";
      const s = state({ files: [{ id: "journal-1", name }] });
      const ready = deferred<void>();
      const finished = deferred<void>();
      const session = { push: vi.fn(), stop: vi.fn().mockResolvedValue("Only words"), cancel: vi.fn() };
      mocks.acquireMic.mockResolvedValue(mediaStream());
      mocks.api.dictStart.mockResolvedValue({ url: "ws://fake" });
      mocks.connectDictSession.mockResolvedValue(session);
      mocks.createPcmTap.mockResolvedValue(vi.fn().mockResolvedValue(undefined));
      mocks.api.getSetting.mockResolvedValue(null);
      mocks.api.getFileContent.mockResolvedValue({ text: null });
      mocks.api.listFiles.mockResolvedValue([{ id: "journal-1", name }]);
      s.setDictState = vi.fn((value) => {
        s.dictState = value;
        if (value === "recording") ready.resolve();
        if (value === "idle") finished.resolve();
      });
      const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

      actions.dictateJournal();
      await ready.promise;
      s.dictStreamRef.current?.();
      await finished.promise;

      expect(mocks.api.updateFileContent).toHaveBeenCalledWith("journal-1", "\n\nOnly words\n");
      expect(mocks.api.saveGeneratedFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads and appends a fabricated file dictation at write time", async () => {
    vi.useFakeTimers();
    try {
      const s = state({ openFile: { id: "note-1" } });
      const ready = deferred<void>();
      const finished = deferred<void>();
      const session = { push: vi.fn(), stop: vi.fn().mockResolvedValue("New dictated words"), cancel: vi.fn() };
      mocks.acquireMic.mockResolvedValue(mediaStream());
      mocks.api.dictStart.mockResolvedValue({ url: "ws://fake" });
      mocks.connectDictSession.mockResolvedValue(session);
      mocks.createPcmTap.mockResolvedValue(vi.fn().mockResolvedValue(undefined));
      mocks.api.getSetting.mockResolvedValue(null);
      mocks.api.getFileContent.mockResolvedValue({ text: "Current text  \n" });
      mocks.api.listFiles.mockResolvedValue([]);
      s.setDictState = vi.fn((value) => {
        s.dictState = value;
        if (value === "recording") ready.resolve();
        if (value === "idle") finished.resolve();
      });
      const viewFile = vi.fn().mockResolvedValue(undefined);
      const actions = makeRecordingActions(s as never, { viewFile, changeModel: vi.fn() });

      actions.dictateIntoFile();
      await ready.promise;
      s.dictStreamRef.current?.();
      await finished.promise;

      expect(mocks.api.updateFileContent).toHaveBeenCalledWith("note-1", "Current text\n\nNew dictated words\n");
      expect(viewFile).toHaveBeenCalledWith("note-1");
      expect(s.pushToast).toHaveBeenCalledWith("success", "Added your words to the file.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates the daily journal and its folder for a fabricated first entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    try {
      const name = "Journal 2026-09-01.md";
      const saved = { id: "journal-1", name };
      const journalFolder = { id: "folder-1", name: "Journal" };
      const s = state();
      const ready = deferred<void>();
      const finished = deferred<void>();
      const session = { push: vi.fn(), stop: vi.fn().mockResolvedValue("First reflection"), cancel: vi.fn() };
      mocks.acquireMic.mockResolvedValue(mediaStream());
      mocks.api.dictStart.mockResolvedValue({ url: "ws://fake" });
      mocks.connectDictSession.mockResolvedValue(session);
      mocks.createPcmTap.mockResolvedValue(vi.fn().mockResolvedValue(undefined));
      mocks.api.getSetting.mockResolvedValue(null);
      mocks.api.saveGeneratedFile.mockResolvedValue(saved);
      mocks.api.createFolder.mockResolvedValue(journalFolder);
      mocks.api.listFolders.mockResolvedValue([journalFolder]);
      mocks.api.listFiles.mockResolvedValue([saved]);
      s.setDictState = vi.fn((value) => {
        s.dictState = value;
        if (value === "recording") ready.resolve();
        if (value === "idle") finished.resolve();
      });
      s.pushToast = vi.fn();
      const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

      actions.dictateJournal();
      await ready.promise;
      s.dictStreamRef.current?.();
      await finished.promise;

      expect(mocks.api.saveGeneratedFile).toHaveBeenCalledWith(
        name,
        "# Journal — 2026-09-01\n\nFirst reflection\n",
      );
      expect(mocks.api.createFolder).toHaveBeenCalledWith("Journal");
      expect(mocks.api.moveFileToFolder).toHaveBeenCalledWith("journal-1", "folder-1");
      expect(s.setFolders).toHaveBeenCalledWith([journalFolder]);
      expect(s.setFiles).toHaveBeenCalledWith([saved]);
      expect(s.dictState).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles fake batch microphone failures, owned recording toggles, and recorder completion", async () => {
    const getUserMedia = vi.fn().mockRejectedValue({ name: "NotFoundError" });
    installNavigator(getUserMedia);
    const s = state();
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.beginRecording("note", vi.fn());
    expect(s.dictState).toBe("idle");
    expect(s.pushToast).toHaveBeenCalledWith("error", "No microphone found — plug one in or check your input device.");

    const Recorder = installMediaRecorder();
    const stream = mediaStream();
    getUserMedia.mockResolvedValue(stream);
    const onDone = vi.fn();
    await actions.beginRecording("note", onDone);
    const recorder = s.recorderRef.current as InstanceType<typeof Recorder>;
    expect(recorder.start).toHaveBeenCalledOnce();
    recorder.ondataavailable?.({ data: new Blob(["audio"]) });
    await recorder.onstop?.();
    expect(onDone).toHaveBeenCalledWith(expect.any(Blob), "m4a");
    expect(s.dictState).toBe("idle");

    s.dictState = "recording";
    s.dictOwner = "note";
    await actions.beginRecording("note", vi.fn());
    expect(recorder.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["NotReadableError", "The microphone is busy in another app — close it and try again."],
    ["AbortError", "The microphone is busy in another app — close it and try again."],
    ["NotAllowedError", "Microphone blocked — allow Arcelle in System Settings → Privacy & Security → Microphone, then reopen the app."],
  ])("explains the fabricated %s microphone refusal", async (name, message) => {
    installNavigator(vi.fn().mockRejectedValue({ name }));
    const s = state();
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.beginRecording("note", vi.fn());

    expect(s.pushToast).toHaveBeenCalledWith("error", message);
    expect(s.dictState).toBe("idle");
    expect(s.dictOwner).toBeNull();
  });

  it("keeps only nonempty fabricated recorder chunks and cleans up tracks after a successful callback", async () => {
    const Recorder = installMediaRecorder();
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installNavigator(getUserMedia);
    const s = state();
    const onDone = vi.fn(async () => undefined);

    await makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() })
      .beginRecording("note", onDone);
    const recorder = s.recorderRef.current as InstanceType<typeof Recorder>;
    recorder.mimeType = "audio/webm";
    recorder.ondataavailable?.({ data: new Blob([]) });
    recorder.ondataavailable?.({ data: new Blob(["fake audio"]) });
    await recorder.onstop?.();

    const [blob, ext] = onDone.mock.calls[0] as unknown as [Blob, string];
    expect(blob.size).toBe(new Blob(["fake audio"]).size);
    expect(ext).toBe("webm");
    expect(trackStop).toHaveBeenCalledOnce();
    expect(s.setDictState).toHaveBeenCalledWith("busy");
    expect(s.dictState).toBe("idle");
    expect(s.dictOwner).toBeNull();

    Recorder.isTypeSupported.mockReturnValueOnce(false);
    await makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() })
      .beginRecording("note", onDone);
    const fallback = s.recorderRef.current as InstanceType<typeof Recorder>;
    fallback.mimeType = "";
    await fallback.onstop?.();
    const [fallbackBlob, fallbackExt] = onDone.mock.calls.at(-1) as unknown as [Blob, string];
    expect(fallbackBlob.type).toBe("audio/mp4");
    expect(fallbackExt).toBe("m4a");
  });

  it("reports fabricated batch callback failures and always releases recorder state", async () => {
    const Recorder = installMediaRecorder();
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream());
    installNavigator(getUserMedia);
    const s = state();
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.beginRecording("note", async () => { throw new Error("STT_MODEL_MISSING"); });
    const missing = s.recorderRef.current as InstanceType<typeof Recorder>;
    await missing.onstop?.();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "Download the voice model first, in Settings → Model → Dictation.",
      expect.objectContaining({ label: "Open Settings", run: expect.any(Function) }),
    );
    const openSettings = s.pushToast.mock.calls.at(-1)?.[2] as { run: () => void };
    openSettings.run();
    expect(s.setShowSettings).toHaveBeenCalledWith(true);
    expect(s.dictState).toBe("idle");
    expect(s.dictOwner).toBeNull();

    await actions.beginRecording("note", async () => { throw new Error("fake transcription failure"); });
    const failed = s.recorderRef.current as InstanceType<typeof Recorder>;
    await failed.onstop?.();
    expect(s.pushToast).toHaveBeenLastCalledWith(
      "error",
      "Dictation failed: Error: fake transcription failure",
    );
    expect(s.dictState).toBe("idle");
    expect(s.dictOwner).toBeNull();
  });

  it("streams fake dictation through shaping and leaves setup and microphone failures visible", async () => {
    const s = state();
    const stream = mediaStream();
    const session = { push: vi.fn(), stop: vi.fn().mockResolvedValue(" raw words "), cancel: vi.fn() };
    const tapDown = vi.fn().mockResolvedValue(undefined);
    mocks.acquireMic.mockResolvedValue(stream);
    mocks.api.dictStart.mockResolvedValue({ url: "ws://fake" });
    mocks.connectDictSession.mockResolvedValue(session);
    mocks.createPcmTap.mockResolvedValue(tapDown);
    mocks.api.getSetting.mockImplementation((name: string) => Promise.resolve(name === "dict_translate" ? "on" : "off"));
    mocks.api.shapeText.mockResolvedValue(" shaped words ");
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });
    const sink = vi.fn();

    actions.dictateTo("composer", sink);
    await settle();
    expect(s.dictState).toBe("recording");
    const pcmPush = mocks.createPcmTap.mock.calls[0]?.[1] as (rate: number, b64: string) => Promise<void>;
    await pcmPush(16_000, "samples");
    expect(session.push).toHaveBeenCalledWith(16_000, "samples");
    s.dictStreamRef.current?.();
    await settle();
    expect(tapDown).toHaveBeenCalledOnce();
    expect(session.stop).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("shaped words");

    mocks.acquireMic.mockRejectedValueOnce(new Error("mic denied"));
    actions.dictateTo("journal", vi.fn());
    await settle();
    expect(s.pushToast).toHaveBeenCalledWith("error", "mic denied");

    mocks.acquireMic.mockResolvedValueOnce(mediaStream());
    mocks.api.dictStart.mockRejectedValueOnce(new Error("STT_MODEL_MISSING"));
    actions.dictateTo("journal", vi.fn());
    await settle();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "Download the voice model first, in Settings → Model → Dictation.",
      expect.objectContaining({ label: "Open Settings" }),
    );
    const missingToast = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[1] === "Download the voice model first, in Settings → Model → Dictation.",
    )?.[2] as { run?: () => void } | undefined;
    missingToast?.run?.();
    expect(s.setShowSettings).toHaveBeenCalledWith(true);
  });

  it("publishes fabricated partials and cancels a connected session when tap setup fails", async () => {
    const s = state();
    const stream = mediaStream();
    const session = { push: vi.fn(), stop: vi.fn(), cancel: vi.fn() };
    mocks.acquireMic.mockResolvedValue(stream);
    mocks.api.dictStart.mockResolvedValue({ url: "ws://fake" });
    mocks.connectDictSession.mockImplementation(async (
      _info: unknown,
      _onPartial: (text: string) => void,
    ) => {
      return session;
    });
    mocks.createPcmTap.mockRejectedValueOnce(new Error("fabricated tap setup failure"));
    const onPartial = vi.fn();
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    actions.dictateTo("composer", vi.fn(), onPartial);
    await settle();
    const publishPartial = mocks.connectDictSession.mock.calls[0]?.[1] as
      | ((text: string) => void)
      | undefined;
    if (!publishPartial) throw new Error("dictation partial callback missing");
    publishPartial("fabricated partial");

    expect(s.setDictPartial).toHaveBeenCalledWith("fabricated partial");
    expect(onPartial).toHaveBeenCalledWith("fabricated partial");
    expect(stream.getTracks()[0]?.stop).toHaveBeenCalledOnce();
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "Dictation failed: Error: fabricated tap setup failure",
    );
  });

  it("clears fabricated partials for silence and failures, and preserves raw text when shaping fails", async () => {
    const s = state();
    const onPartial = vi.fn();
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    const launch = async (session: { push: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }) => {
      mocks.acquireMic.mockResolvedValueOnce(mediaStream());
      mocks.api.dictStart.mockResolvedValueOnce({ url: "ws://fake" });
      mocks.connectDictSession.mockResolvedValueOnce(session);
      mocks.createPcmTap.mockResolvedValueOnce(vi.fn().mockResolvedValue(undefined));
      actions.dictateTo("composer", vi.fn(), onPartial);
      await settle();
      s.dictStreamRef.current?.();
      await settle();
    };

    await launch({ push: vi.fn(), stop: vi.fn().mockResolvedValue("   "), cancel: vi.fn() });
    expect(onPartial).toHaveBeenCalledWith("");
    expect(s.pushToast).toHaveBeenCalledWith("info", "No speech detected.");

    await launch({ push: vi.fn(), stop: vi.fn().mockRejectedValue(new Error("fake stop failure")), cancel: vi.fn() });
    expect(s.pushToast).toHaveBeenCalledWith("error", "Dictation failed: Error: fake stop failure");

    const sink = vi.fn();
    mocks.acquireMic.mockResolvedValueOnce(mediaStream());
    mocks.api.dictStart.mockResolvedValueOnce({ url: "ws://fake" });
    mocks.connectDictSession.mockResolvedValueOnce({
      push: vi.fn(),
      stop: vi.fn().mockResolvedValue("exact fabricated words"),
      cancel: vi.fn(),
    });
    mocks.createPcmTap.mockResolvedValueOnce(vi.fn().mockResolvedValue(undefined));
    mocks.api.getSetting.mockRejectedValueOnce(new Error("fake settings failure"));
    actions.dictateTo("composer", sink, onPartial);
    await settle();
    s.dictStreamRef.current?.();
    await settle();
    expect(sink).toHaveBeenCalledWith("exact fabricated words");
    expect(s.pushToast).toHaveBeenCalledWith(
      "info",
      "Kept the exact transcript — Error: fake settings failure",
    );
  });

  it("only lets the current fabricated dictation owner stop an active stream", () => {
    const stopCurrentStream = vi.fn();
    const busy = state({ dictState: "busy" });
    makeRecordingActions(busy as never, { viewFile: vi.fn(), changeModel: vi.fn() })
      .dictateTo("composer", vi.fn());
    expect(busy.setDictOwner).not.toHaveBeenCalled();
    expect(busy.setDictState).not.toHaveBeenCalled();

    const current = state({
      dictState: "recording",
      dictOwner: "composer",
      dictStreamRef: { current: stopCurrentStream },
    });
    const currentActions = makeRecordingActions(current as never, { viewFile: vi.fn(), changeModel: vi.fn() });
    currentActions.dictateTo("composer", vi.fn());
    currentActions.dictateTo("journal", vi.fn());
    expect(stopCurrentStream).toHaveBeenCalledOnce();
    expect(current.setDictState).not.toHaveBeenCalled();
  });

  it("ends hands-free dictation once after fabricated speech is followed by enough quiet PCM", async () => {
    vi.useFakeTimers();
    try {
      const s = state({ handsFree: true });
      const stream = mediaStream();
      const session = { push: vi.fn(), stop: vi.fn().mockResolvedValue("hands free words"), cancel: vi.fn() };
      const tapDown = vi.fn().mockResolvedValue(undefined);
      mocks.acquireMic.mockResolvedValue(stream);
      mocks.api.dictStart.mockResolvedValue({ url: "ws://fake" });
      mocks.connectDictSession.mockResolvedValue(session);
      mocks.createPcmTap.mockResolvedValue(tapDown);
      mocks.api.getSetting.mockResolvedValue("off");
      mocks.base64ToBytes.mockImplementation((batch: string) => new Uint8Array(
        new Float32Array([batch === "loud" ? 0.1 : 0]).buffer,
      ));
      const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });
      const sink = vi.fn();

      actions.dictateTo("composer", sink);
      await settle();
      const pushPcm = mocks.createPcmTap.mock.calls[0]?.[1] as (rate: number, batch: string) => Promise<void>;
      await pushPcm(16_000, "loud");
      await vi.advanceTimersByTimeAsync(899);
      await pushPcm(16_000, "quiet");
      expect(session.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pushPcm(16_000, "quiet");
      await settle();
      await pushPcm(16_000, "quiet");

      expect(session.push).toHaveBeenCalledTimes(4);
      expect(session.stop).toHaveBeenCalledOnce();
      expect(tapDown).toHaveBeenCalledOnce();
      expect(sink).toHaveBeenCalledWith("hands free words");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops fabricated Ollama checks when it starts or reaches the visible retry limit", async () => {
    const timers = installIntervalWindow();
    const ready = state();
    mocks.api.openOllama.mockResolvedValue(undefined);
    mocks.api.aiStatus.mockResolvedValueOnce({ running: true, defaultModel: "fake" });
    const readyActions = makeRecordingActions(ready as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await readyActions.openOllamaApp();
    await timers.callbacks[0]?.();

    expect(ready.setAi).toHaveBeenCalledWith({ running: true, defaultModel: "fake" });
    expect(timers.clearInterval).toHaveBeenCalledWith(1);

    const waiting = state();
    mocks.api.aiStatus.mockResolvedValue({ running: false, defaultModel: "fake" });
    const waitingActions = makeRecordingActions(waiting as never, { viewFile: vi.fn(), changeModel: vi.fn() });
    await waitingActions.openOllamaApp();
    const poll = timers.callbacks[1];
    if (!poll) throw new Error("Ollama poll was not registered");
    for (let attempt = 0; attempt < 20; attempt += 1) await poll();

    expect(waiting.pushToast).toHaveBeenCalledWith(
      "info",
      "Ollama still isn't answering after 30 seconds. It may still be starting — press Open Ollama again to keep checking.",
    );
    expect(timers.clearInterval).toHaveBeenCalledWith(2);
  });

  it("reports exhausted fabricated Ollama probe failures without leaving the timer active", async () => {
    const timers = installIntervalWindow();
    const s = state();
    mocks.api.openOllama.mockResolvedValue(undefined);
    mocks.api.aiStatus.mockRejectedValue(new Error("fabricated probe failure"));
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.openOllamaApp();
    const poll = timers.callbacks[0];
    if (!poll) throw new Error("Ollama poll was not registered");
    for (let attempt = 0; attempt < 20; attempt += 1) await poll();

    expect(s.pushToast).toHaveBeenCalledWith(
      "info",
      "Couldn't tell whether Ollama started. Press Open Ollama again to check.",
    );
    expect(timers.clearInterval).toHaveBeenCalledWith(1);
  });

  it("refreshes fabricated AI status after a completed model download and clears its progress state", async () => {
    const s = state();
    const status = { running: true, defaultModel: "small-fake-model" };
    mocks.api.pullModel.mockResolvedValue(undefined);
    mocks.api.aiStatus.mockResolvedValue(status);
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.downloadModel("small-fake-model");

    expect(mocks.api.pullModel).toHaveBeenCalledWith("small-fake-model");
    expect(mocks.api.aiStatus).toHaveBeenCalledOnce();
    expect(s.setAi).toHaveBeenCalledWith(status);
    expect(s.setModel).toHaveBeenCalledWith(expect.any(Function));
    expect(s.setModel.mock.calls[0]?.[0]("")).toBe("small-fake-model");
    expect(s.setPullingModel.mock.calls.map((call: unknown[]) => call[0])).toEqual([true, false]);
    expect(s.setPullStatus).toHaveBeenCalledWith("starting…");
    expect(s.pullingModelRef.current).toBeNull();
    expect(s.setPullPercent.mock.calls.map((call: unknown[]) => call[0])).toEqual([null, null]);
  });

  it("does not start a second fabricated model download while one is already active", async () => {
    const s = state({ pullingModel: true, pullingModelRef: { current: "already-pulling" } });
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.downloadModel("small-fake-model");

    expect(mocks.api.pullModel).not.toHaveBeenCalled();
    expect(s.setPullingModel).not.toHaveBeenCalled();
    expect(s.pullingModelRef.current).toBe("already-pulling");
  });

  it("stops only the current fabricated model pull and safely ignores a raced cancellation", async () => {
    const idle = state();
    await makeRecordingActions(idle as never, { viewFile: vi.fn(), changeModel: vi.fn() }).stopModelPull();
    expect(mocks.api.cancelAsk).not.toHaveBeenCalled();
    expect(idle.setPullStatus).not.toHaveBeenCalled();

    const active = state({ pullingModelRef: { current: "fake-voice-model" } });
    mocks.api.cancelAsk.mockResolvedValueOnce(undefined);
    await makeRecordingActions(active as never, { viewFile: vi.fn(), changeModel: vi.fn() }).stopModelPull();
    expect(active.setPullStatus).toHaveBeenCalledWith("stopping…");
    expect(mocks.api.cancelAsk).toHaveBeenCalledWith("pull:fake-voice-model");

    const raced = state({ pullingModelRef: { current: "already-finished" } });
    mocks.api.cancelAsk.mockRejectedValueOnce(new Error("fake cancel already gone"));
    await expect(makeRecordingActions(raced as never, { viewFile: vi.fn(), changeModel: vi.fn() }).stopModelPull())
      .resolves.toBeUndefined();
    expect(raced.setPullStatus).toHaveBeenCalledWith("stopping…");
    expect(raced.pushToast).not.toHaveBeenCalled();
  });

  it("treats a fabricated cancelled download as stopped rather than an error", async () => {
    const s = state();
    mocks.api.pullModel.mockRejectedValueOnce(new Error("download was cancelled by the user"));
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.downloadModel("small-fake-model");

    expect(s.setPullStatus).toHaveBeenCalledWith("Download stopped. Nothing was installed.");
    expect(s.setPullError).toHaveBeenCalledWith("");
    expect(s.setPullError).toHaveBeenCalledTimes(1);
    expect(s.setPullingModel.mock.calls.map((call: unknown[]) => call[0])).toEqual([true, false]);
  });

  it("keeps a fabricated download failure visible and still clears active progress", async () => {
    const s = state();
    mocks.api.pullModel.mockRejectedValueOnce(new Error("disk full"));
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.downloadModel("small-fake-model");

    expect(s.setPullError).toHaveBeenCalledWith("Error: disk full");
    expect(s.setPullStatus).toHaveBeenCalledWith("");
    expect(s.pullingModelRef.current).toBeNull();
    expect(s.setPullingModel.mock.calls.map((call: unknown[]) => call[0])).toEqual([true, false]);
    expect(s.setPullPercent.mock.calls.map((call: unknown[]) => call[0])).toEqual([null, null]);
  });

  it("starts, resumes, and stops a live recording with fake media and preserves partial-failure receipts", async () => {
    const s = state();
    const viewFile = vi.fn().mockResolvedValue(undefined);
    const actions = makeRecordingActions(s as never, { viewFile, changeModel: vi.fn() });

    s.recLive = { fileId: "already", status: "recording" };
    await actions.startLiveRecording();
    expect(viewFile).toHaveBeenCalledWith("already");

    s.recLive = null;
    mocks.acquireMic.mockRejectedValueOnce(new Error("mic unavailable"));
    mocks.api.recStart.mockResolvedValue({ sessionUrl: "ws://fake", fileId: "recording-1" });
    mocks.api.recLiveStatus.mockResolvedValueOnce({ sys: ["error"] });
    await actions.startLiveRecording(undefined, { systemAudio: false });
    expect(mocks.startRecordingTransport).toHaveBeenCalledWith("ws://fake", "recording-1");
    expect(mocks.noteLiveStt).toHaveBeenCalledWith(true);
    expect(s.recLive).toEqual({ fileId: "recording-1", status: "recording" });
    expect(s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("nothing at all is being captured"));

    s.recLive = null;
    const attachStream = mediaStream();
    mocks.acquireMic.mockResolvedValueOnce(attachStream);
    mocks.api.recStart.mockResolvedValueOnce({ sessionUrl: "ws://second", fileId: "recording-2" });
    mocks.attachMicTap.mockRejectedValueOnce(new Error("tap failed"));
    await actions.startLiveRecording();
    expect(s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("microphone could not be attached"));

    s.recLive = null;
    const stoppedOnStart = mediaStream();
    mocks.acquireMic.mockResolvedValueOnce(stoppedOnStart);
    mocks.api.recStart.mockRejectedValueOnce(new Error("STT_MODEL_MISSING"));
    await actions.startLiveRecording();
    expect(mocks.startRecordingTransport).toHaveBeenCalledTimes(2);

    mocks.acquireMic.mockRejectedValueOnce(new Error("resume mic unavailable"));
    mocks.api.recLiveStatus.mockResolvedValueOnce({ sys: ["on"] });
    mocks.api.recResume.mockResolvedValue(undefined);
    await actions.resumeLiveRecording();
    expect(s.pushToast).toHaveBeenCalledWith("error", "resume mic unavailable (the Mac's audio keeps recording)");

    s.recLive = { fileId: "recording-2", status: "recording" };
    s.openFileRef.current = { id: "recording-2" };
    mocks.api.recStop.mockResolvedValue({ segments: [] });
    await actions.stopLiveRecording();
    expect(mocks.closeRecordingTransport).toHaveBeenCalledOnce();
    expect(s.recLive).toBeNull();
    expect(s.pushToast).toHaveBeenCalledWith("success", expect.stringContaining("No transcript was written"), expect.any(Object));
    expect(viewFile).toHaveBeenCalledWith("recording-2");
  });

  it("stops a fabricated mic after a non-model start failure", async () => {
    const s = state();
    const stream = mediaStream();
    mocks.acquireMic.mockResolvedValueOnce(stream);
    mocks.api.recStart.mockRejectedValueOnce(new Error("fake engine refusal"));
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.startLiveRecording();
    expect(stream.getTracks()[0]?.stop).toHaveBeenCalledOnce();
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fake engine refusal");
    expect(mocks.startRecordingTransport).not.toHaveBeenCalled();
  });

  it("reports that fabricated system audio survives a missing microphone", async () => {
    const s = state();
    mocks.acquireMic.mockRejectedValueOnce(new Error("fake microphone refusal"));
    mocks.api.recStart.mockResolvedValueOnce({ sessionUrl: "ws://fake", fileId: "recording-1" });
    mocks.api.recLiveStatus.mockResolvedValueOnce({ sys: ["on"] });
    mocks.api.listFiles.mockResolvedValueOnce([]);
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn().mockResolvedValue(undefined), changeModel: vi.fn() });

    await actions.startLiveRecording(undefined, { systemAudio: true });
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "fake microphone refusal (the Mac's audio keeps recording)",
    );
  });

  it("keeps a started fabricated recording alive when refreshing its room fails", async () => {
    const s = state();
    mocks.acquireMic.mockResolvedValueOnce(mediaStream());
    mocks.attachMicTap.mockResolvedValueOnce(undefined);
    mocks.api.recStart.mockResolvedValueOnce({ sessionUrl: "ws://fake", fileId: "recording-1" });
    mocks.api.listFiles.mockRejectedValueOnce(new Error("fake list failure"));
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.startLiveRecording();
    expect(s.recLive).toEqual({ fileId: "recording-1", status: "recording" });
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "The recording started, but the room could not be refreshed: Error: fake list failure",
    );
  });

  it("cleans up fabricated resume and stop failures and reports a failed final refresh", async () => {
    const s = state({ recLive: { fileId: "recording-1", status: "recording" } });
    const resumeStream = mediaStream();
    mocks.acquireMic.mockResolvedValueOnce(resumeStream);
    mocks.api.recResume.mockRejectedValueOnce(new Error("fake resume failure"));
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.resumeLiveRecording();
    expect(resumeStream.getTracks()[0]?.stop).toHaveBeenCalledOnce();
    expect(s.pushToast).toHaveBeenCalledWith("error", "fake resume failure");

    mocks.acquireMic.mockRejectedValueOnce(new Error("fake missing mic"));
    mocks.api.recLiveStatus.mockResolvedValueOnce({ sys: ["off"] });
    mocks.api.recResume.mockResolvedValueOnce(undefined);
    await actions.resumeLiveRecording();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "fake missing mic — and the Mac's audio is not being recorded, so nothing at all is being captured.",
    );

    mocks.api.recStop.mockRejectedValueOnce(new Error("fake stop failure"));
    mocks.api.listFiles.mockRejectedValueOnce(new Error("fake refresh failure"));
    await actions.stopLiveRecording();
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fake stop failure");
    expect(mocks.closeRecordingTransport).toHaveBeenCalledOnce();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "The recording was saved, but the room could not be refreshed: Error: fake refresh failure",
    );
  });

  it("pauses fabricated live recording, exposes its receipt, and reports pause failures", async () => {
    const s = state({ recLive: { fileId: "recording-1", status: "recording" } });
    const viewFile = vi.fn().mockResolvedValue(undefined);
    mocks.api.recPause.mockResolvedValueOnce(undefined);
    mocks.api.recStop.mockResolvedValueOnce({ segments: [{ text: "spoken" }] });
    mocks.api.listFiles.mockResolvedValueOnce([]);
    const actions = makeRecordingActions(s as never, { viewFile, changeModel: vi.fn() });

    await actions.pauseLiveRecording();
    expect(mocks.stopMicTap).toHaveBeenCalledOnce();
    expect(mocks.api.recPause).toHaveBeenCalledOnce();

    await actions.stopLiveRecording();
    const receipt = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[0] === "success" && call[1] === "Recording saved — transcript included.",
    )?.[2] as { run?: () => void } | undefined;
    receipt?.run?.();
    await settle();
    expect(viewFile).toHaveBeenCalledWith("recording-1");

    mocks.api.recPause.mockRejectedValueOnce(new Error("fake pause refusal"));
    await actions.pauseLiveRecording();
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fake pause refusal");
  });

  it("records a fabricated voice note and refreshes only the fake file list", async () => {
    const Recorder = installMediaRecorder();
    installNavigator(vi.fn().mockResolvedValue(mediaStream()));
    const saved = { id: "voice-note", name: "Voice note.m4a" };
    mocks.fileToBase64.mockResolvedValueOnce("fake-audio-base64");
    mocks.api.importAudioBytes.mockResolvedValueOnce(saved);
    mocks.api.listFiles.mockResolvedValueOnce([saved]);
    const s = state();
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    actions.recordVoiceNote();
    await settle();
    const recorder = s.recorderRef.current as InstanceType<typeof Recorder>;
    recorder.ondataavailable?.({ data: new Blob(["fake voice"]) });
    await recorder.onstop?.();

    expect(mocks.fileToBase64).toHaveBeenCalledWith(expect.any(File));
    expect(mocks.api.importAudioBytes).toHaveBeenCalledWith(
      expect.stringMatching(/^Voice note .+\.m4a$/),
      "fake-audio-base64",
    );
    expect(s.setFiles).toHaveBeenCalledWith([saved]);
    expect(s.pushToast).toHaveBeenCalledWith(
      "success",
      "Voice note saved — transcript is being written…",
    );
  });

  it("selects and downloads fake models while keeping the Ollama link failure visible", async () => {
    const s = state();
    const changeModel = vi.fn().mockResolvedValue(undefined);
    mocks.api.pullModel.mockResolvedValueOnce(undefined);
    mocks.api.aiStatus.mockResolvedValueOnce({ running: true, defaultModel: "fake-model" });
    mocks.openUrl.mockResolvedValueOnce(undefined);
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel });

    await actions.pickAndDownload("fake-model");
    expect(changeModel).toHaveBeenCalledWith("fake-model");
    expect(mocks.api.pullModel).toHaveBeenCalledWith("fake-model");

    await actions.getOllama();
    expect(mocks.openUrl).toHaveBeenCalledWith("https://ollama.com/download");

    mocks.openUrl.mockRejectedValueOnce(new Error("fake open refusal"));
    await actions.getOllama();
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fake open refusal");

    const alreadyPulling = state({ pullingModel: true });
    await makeRecordingActions(alreadyPulling as never, { viewFile: vi.fn(), changeModel }).pickAndDownload("ignored");
    expect(changeModel).toHaveBeenCalledTimes(1);
  });

  it("keeps a fabricated Open Ollama refusal visible without starting a poll", async () => {
    const timers = installIntervalWindow();
    const s = state();
    mocks.api.openOllama.mockRejectedValueOnce(new Error("fake launch refusal"));
    const actions = makeRecordingActions(s as never, { viewFile: vi.fn(), changeModel: vi.fn() });

    await actions.openOllamaApp();
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fake launch refusal");
    expect(timers.setInterval).not.toHaveBeenCalled();
  });
});
