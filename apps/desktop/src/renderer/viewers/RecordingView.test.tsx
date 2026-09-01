import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { act, createElement } = React;

const { api, listeners, recRetranscribe, recHighlightAdd } = vi.hoisted(() => {
  const listeners: Record<string, ((payload: never) => void)[]> = {};
  const unlisten = () => Promise.resolve(() => {});
  const subscribe = (name: string) => (listener: (payload: never) => void) => {
    (listeners[name] ??= []).push(listener);
    return unlisten();
  };
  const recRetranscribe = vi.fn();
  const recReadStart = vi.fn(() => Promise.resolve());
  const recHighlightAdd = vi.fn();
  const recTranslate = vi.fn();
  const saveGeneratedFile = vi.fn();
  return {
    listeners,
    recRetranscribe,
    recReadStart,
    recHighlightAdd,
    recTranslate,
    saveGeneratedFile,
    api: {
      recGet: vi.fn(),
      listJobs: vi.fn(() => Promise.resolve([])),
      recLiveStatus: vi.fn(() => Promise.resolve(null)),
      onRecSegment: subscribe("segment"),
      onRecSegmentDrop: subscribe("segmentDrop"),
      onRecPartial: subscribe("partial"),
      onRecRelabel: subscribe("relabel"),
      onRecReadDone: subscribe("readDone"),
      onRecLevel: subscribe("level"),
      onRecSource: subscribe("source"),
      onRecLiveTranslation: subscribe("translation"),
      onRecTranslateProgress: subscribe("translateProgress"),
      onRecRetranscribe: subscribe("retranscribeProgress"),
      recRetranscribe,
      recReadStart,
      recHighlightAdd,
      recTranslate,
      saveGeneratedFile,
      recSetSpeakerName: vi.fn(),
      recChapterAdd: vi.fn(),
      recItemDelete: vi.fn(),
      recExportClean: vi.fn(),
      recSetLiveTranslate: vi.fn(),
      recSetLiveStt: vi.fn(),
      recCorrectRange: vi.fn(),
      recDeleteRange: vi.fn(),
      recNoteAdd: vi.fn(),
    },
  };
});

vi.mock("../api", () => ({ api }));
vi.mock("../platform", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("../workspace/liveRec", () => ({
  liveSttOn: () => true,
  micMuted: () => false,
  noteLiveStt: vi.fn(),
  setMicMuted: vi.fn(),
}));
vi.mock("../rooms/helpers", () => ({ prefersReducedMotion: () => false }));
vi.mock("../icons", () => ({
  PauseIcon: () => null,
  PlayIcon: () => null,
  StopIcon: () => null,
}));
vi.mock("./Waveform", () => ({
  default: () => null,
  SPEAKER_TONES: ["rec-tone-one", "rec-tone-two"],
  WAVE_HEIGHT_LARGE: 160,
}));

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  HTMLMediaElement: globalThis.HTMLMediaElement,
  Event: globalThis.Event,
  React: Reflect.get(globalThis, "React"),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  CSS: Reflect.get(globalThis, "CSS"),
  requestAnimationFrame: Reflect.get(globalThis, "requestAnimationFrame"),
  cancelAnimationFrame: Reflect.get(globalThis, "cancelAnimationFrame"),
};

afterEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function meta(durationCs: number, segments: unknown[] = []) {
  return {
    durationCs,
    segments,
    cuts: [],
    maxSpeakers: 0,
    notes: [],
    highlights: [],
    chapters: [],
  };
}

function transcriptMeta() {
  return {
    ...meta(600, [
      {
        id: "seg-1",
        t0: 0,
        t1: 300,
        speaker: "Speaker 1",
        text: "Hello team",
        words: [
          { w: "Hello", t0: 0, t1: 100 },
          { w: "team", t0: 110, t1: 250 },
        ],
      },
    ]),
    speakerNames: { "Speaker 1": "Dana" },
    notes: [{ id: "note-1", kind: "decision", t0: 0, text: "Ship it", who: "Dana", by: "user" }],
    highlights: [{ id: "highlight-1", t0: 0, t1: 250, by: "room" }],
    chapters: [{ id: "chapter-1", t0: 0, title: "Intro", by: "user" }],
    readOf: { turns: 1, chars: 10 },
  };
}

function denseTranscriptMeta() {
  const first = transcriptMeta();
  return {
    ...first,
    durationCs: 1_000,
    cuts: [{ t0: 260, t1: 320 }],
    segments: [
      ...first.segments,
      {
        id: "seg-2",
        t0: 350,
        t1: 700,
        speaker: "You",
        text: "A deleted answer",
        words: [
          { w: "A", t0: 350, t1: 400 },
          { w: "deleted", t0: 410, t1: 500, del: true },
          { w: "answer", t0: 510, t1: 650 },
        ],
      },
      { id: "seg-3", t0: 750, t1: 900, speaker: "Speaker 2", text: "Plain text", words: [] },
    ],
    speakerNames: { "Speaker 1": "Dana", You: "Ben" },
    recognized: ["Dana"],
    notes: [
      { id: "decision", kind: "decision", t0: 0, text: "Ship it", who: "Dana", by: "user" },
      { id: "action", kind: "action", t0: 350, text: "Follow up", by: "room" },
      { id: "question", kind: "question", t0: 750, text: "Why?", by: "room" },
      { id: "point", kind: "point", t0: 750, text: "Context", by: "user" },
    ],
    highlights: [
      { id: "highlight-1", t0: 0, t1: 250, by: "room" },
      { id: "highlight-2", t0: 910, t1: 950, by: "user" },
    ],
    chapters: [{ id: "chapter-1", t0: 350, title: "Middle", by: "room" }],
    readOf: { turns: 1, chars: 1 },
  };
}

async function renderRecording(
  name: string,
  recordingMeta: unknown,
  live: { fileId: string; status: string } | null = null,
  options: {
    mediaToken?: string | null;
    saveProgress?: { stage: "transcribing" | "writing"; remaining: number } | null;
    jobs?: unknown[];
    liveStatus?: unknown;
    loadError?: Error;
  } = {},
) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLMediaElement", window.HTMLMediaElement);
  Reflect.set(window.HTMLElement.prototype, "scrollIntoView", vi.fn());
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "CSS", { escape: (value: string) => value });
  Reflect.set(globalThis, "requestAnimationFrame", (run: FrameRequestCallback) => window.setTimeout(run, 0));
  Reflect.set(globalThis, "cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  api.listJobs.mockResolvedValue((options.jobs ?? []) as never);
  api.recLiveStatus.mockResolvedValue((options.liveStatus ?? null) as never);
  if (options.loadError) api.recGet.mockRejectedValue(options.loadError);
  else api.recGet.mockResolvedValue({ name, meta: recordingMeta });

  const [{ createRoot }, { default: RecordingView }] = await Promise.all([
    import("react-dom/client"),
    import("./RecordingView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const onStart = vi.fn(() => Promise.resolve());
  const onPause = vi.fn(() => Promise.resolve());
  const onResume = vi.fn(() => Promise.resolve());
  const onStop = vi.fn(() => Promise.resolve());
  const pushToast = vi.fn();

  await act(async () => {
    root.render(
      createElement(RecordingView, {
        fileId: "rec-1",
        mediaToken: options.mediaToken ?? null,
        live,
        saveProgress: options.saveProgress ?? null,
        pushToast,
        onStart,
        onPause,
        onResume,
        onStop,
      }),
    );
    await Promise.resolve();
  });

  return { document, host, onStart, onPause, onResume, onStop, pushToast, root, window };
}

type View = Awaited<ReturnType<typeof renderRecording>>;

function reactHandler<T extends HTMLElement>(element: T, name: string) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey ? Reflect.get(element, propsKey) as Record<string, unknown> : undefined;
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`Missing ${name} handler`);
  return handler as (event: unknown) => void;
}

async function click(view: View, selector: string) {
  const element = view.document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => {
    element.dispatchEvent(new view.window.Event("click", { bubbles: true }));
    await Promise.resolve();
  });
  return element;
}

async function input(view: View, selector: string, value: string) {
  const element = view.document.querySelector<HTMLInputElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  const descriptor = Object.getOwnPropertyDescriptor(view.window.HTMLInputElement.prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
  await act(async () => {
    reactHandler(element, "onChange")({ target: { value } });
    await Promise.resolve();
  });
  return element;
}

async function emit(name: string, payload: unknown) {
  await act(async () => {
    for (const listener of listeners[name] ?? []) listener(payload as never);
    await Promise.resolve();
  });
}

function buttonWithText(view: View, text: string) {
  return [...view.document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === text);
}

async function setChecked(view: View, selector: string, checked: boolean) {
  const element = view.document.querySelector<HTMLInputElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  Object.defineProperty(element, "checked", { configurable: true, value: checked });
  await act(async () => {
    reactHandler(element, "onChange")({ target: { checked } });
    await Promise.resolve();
  });
}

async function key(view: View, selector: string, value: string) {
  const element = view.document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => {
    reactHandler(element, "onKeyDown")({ key: value, preventDefault: vi.fn() });
    await Promise.resolve();
  });
}

describe("RecordingView capture eligibility", () => {
  it("keeps a new WAV recording startable with its live-capture choices", async () => {
    const view = await renderRecording("meeting.wav", meta(0));

    expect(view.host.textContent).toContain("Start recording");
    expect(view.host.textContent).toContain("Include the Mac’s audio");
    const button = view.host.querySelector<HTMLButtonElement>(".rec-record");
    await act(async () => {
      button?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.onStart).toHaveBeenCalledWith("rec-1", { systemAudio: true, liveTranslate: null });

    await act(async () => view.root.unmount());
  });

  it("does not offer continuation for imported media and keeps write-up actionable", async () => {
    recRetranscribe.mockResolvedValue(meta(0));
    const view = await renderRecording("imported.mp3", meta(500));

    expect(view.host.querySelector(".rec-record")).toBeNull();
    const writeUp = view.document.querySelector<HTMLButtonElement>("[data-testid='rec-transcribe-empty']");
    expect(writeUp?.textContent).toContain("Write it up");
    await act(async () => {
      writeUp?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(recRetranscribe).toHaveBeenCalledWith("rec-1");

    await act(async () => view.root.unmount());
  });

  it("keeps the paused session state visible while the audio is still attached", async () => {
    const view = await renderRecording("meeting.wav", meta(500), { fileId: "rec-1", status: "paused" });

    expect(view.host.textContent).toContain("Paused at 0:05");
    expect(view.host.textContent).toContain("Stop & save");

    await act(async () => view.root.unmount());
  });

  it("opens the continuation preflight before starting a finished WAV", async () => {
    const view = await renderRecording("meeting.wav", meta(500));
    const record = view.document.querySelector<HTMLButtonElement>(".rec-record");
    await act(async () => {
      record?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    const continueButton = view.document.querySelector<HTMLButtonElement>("[data-testid='rec-preflight-start']");
    expect(continueButton?.textContent).toContain("Continue recording");
    await act(async () => {
      continueButton?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.onStart).toHaveBeenCalledWith("rec-1", { systemAudio: true, liveTranslate: null });
    await act(async () => view.root.unmount());
  });

  it("shows saving progress without offering capture actions", async () => {
    const view = await renderRecording(
      "meeting.wav",
      meta(500),
      { fileId: "rec-1", status: "saving" },
      { saveProgress: { stage: "transcribing", remaining: 2 } },
    );
    expect(view.host.textContent).toContain("Audio saved — finishing the transcript (2 to go)");
    expect(view.host.querySelector(".rec-record")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("explains an unread empty notes tab and starts the reading job", async () => {
    const onlyTranscript = transcriptMeta();
    onlyTranscript.notes = [];
    const view = await renderRecording("meeting.wav", onlyTranscript);
    const notes = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Notes"));
    await act(async () => {
      notes?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain("Nothing to note in this recording.");
    const read = view.document.querySelector<HTMLButtonElement>("[data-testid='rec-read-btn']");
    await act(async () => {
      read?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(api.recReadStart).toHaveBeenCalledWith("rec-1");
    await act(async () => view.root.unmount());
  });

  it("renders transcript turns and exposes reading tabs", async () => {
    const view = await renderRecording("meeting.wav", transcriptMeta());

    expect(view.host.textContent).toContain("Dana");
    expect(view.host.textContent).toContain("Hello team");
    const notes = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Notes"));
    await act(async () => {
      notes?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain("Ship it");
    expect(view.host.textContent).toContain("Read again");

    const highlights = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Highlights"));
    await act(async () => {
      highlights?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain("Hello team");

    const chapters = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Chapters"));
    await act(async () => {
      chapters?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain("Intro");

    await act(async () => view.root.unmount());
  });

  it("opens speaker editing and exposes transcript translation in the drawer", async () => {
    api.recSetSpeakerName.mockResolvedValue({ speakerNames: { "Speaker 1": "Dee" }, recognized: [] });
    api.recTranslate.mockResolvedValue({ name: "Translated.txt" });
    const view = await renderRecording("meeting.wav", transcriptMeta());
    const speaker = view.document.querySelector<HTMLButtonElement>("[data-testid='speaker-chip']");
    await act(async () => {
      speaker?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    const input = view.document.querySelector<HTMLInputElement>("[data-testid='speaker-input']");
    expect(input?.value).toBe("Dana");

    const translate = view.document.querySelector<HTMLInputElement>("[aria-label='Translate the transcript into']");
    expect(translate).not.toBeNull();
    const translateButton = [...view.document.querySelectorAll<HTMLButtonElement>(".rec-tools .nb-btn")]
      .find((button) => button.textContent === "Translate");
    expect(translateButton?.disabled).toBe(true);
    await act(async () => view.root.unmount());
  });

  it("searches transcript and marks a live moment", async () => {
    const view = await renderRecording("meeting.wav", transcriptMeta(), { fileId: "rec-1", status: "recording" });

    const mark = view.document.querySelector<HTMLButtonElement>("[data-testid='mark-now']");
    recHighlightAdd.mockResolvedValue({ highlights: [] });
    await act(async () => {
      mark?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(recHighlightAdd).toHaveBeenCalled();

    await act(async () => view.root.unmount());
  });
});

describe("RecordingView review controls", () => {
  it("plays, searches, exports, translates, and rebuilds an edited transcript", async () => {
    const recording = denseTranscriptMeta();
    api.recTranslate.mockResolvedValue({ name: "Spanish transcript.txt" });
    api.saveGeneratedFile.mockResolvedValue({ name: "Transcript.txt" });
    api.recExportClean.mockResolvedValue({ name: "Edited.wav" });
    recRetranscribe.mockResolvedValue(recording);
    const view = await renderRecording("meeting.wav", recording, null, { mediaToken: "media-1" });
    const audio = view.document.querySelector<HTMLAudioElement>("audio.rec-player");
    expect(audio).not.toBeNull();
    Object.defineProperties(audio!, {
      currentTime: { configurable: true, writable: true, value: 2.8 },
      duration: { configurable: true, writable: true, value: 10 },
      paused: { configurable: true, writable: true, value: true },
      volume: { configurable: true, writable: true, value: 1 },
      playbackRate: { configurable: true, writable: true, value: 1 },
      play: { configurable: true, value: vi.fn(() => Promise.resolve()) },
      pause: { configurable: true, value: vi.fn() },
    });
    await click(view, "[aria-label='Play the recording']");
    expect(audio?.play).toHaveBeenCalled();
    await act(async () => {
      Object.defineProperty(audio!, "paused", { configurable: true, value: false });
      reactHandler(audio!, "onPlay")({});
      reactHandler(audio!, "onTimeUpdate")({});
      audio!.currentTime = 3.5;
      reactHandler(audio!, "onTimeUpdate")({});
      reactHandler(audio!, "onLoadedMetadata")({ currentTarget: audio });
      reactHandler(audio!, "onVolumeChange")({ currentTarget: audio });
      reactHandler(audio!, "onRateChange")({ currentTarget: audio });
      reactHandler(audio!, "onPause")({});
      reactHandler(audio!, "onEnded")({});
      await Promise.resolve();
    });
    audio!.currentTime = 1;
    audio!.playbackRate = 1_000;
    await act(async () => {
      reactHandler(audio!, "onSeeked")({});
      await new Promise<void>((resolve) => view.window.setTimeout(resolve, 10));
      reactHandler(audio!, "onPlay")({});
    });
    Object.defineProperty(audio!, "paused", { configurable: true, value: false });
    await click(view, "[aria-label='Pause playback']");
    expect(audio?.pause).toHaveBeenCalled();
    await act(async () => {
      reactHandler(audio!, "onPause")({});
      await Promise.resolve();
    });
    await click(view, ".rec-stamp");
    Object.defineProperty(audio!, "play", { configurable: true, value: vi.fn(() => Promise.reject(new Error("blocked"))) });
    Object.defineProperty(audio!, "paused", { configurable: true, value: true });
    await click(view, "[aria-label='Play the recording']");
    await act(async () => {
      await Promise.resolve();
      reactHandler(audio!, "onError")({});
    });
    expect(view.host.textContent).toContain("This recording could not be played");
    await input(view, "[aria-label='Seek in the recording']", "500");
    await input(view, "[aria-label='Volume']", "0.5");
    const speed = view.document.querySelector<HTMLSelectElement>("[aria-label='Playback speed']");
    await act(async () => {
      reactHandler(speed!, "onChange")({ target: { value: "1.5" } });
      await Promise.resolve();
    });
    audio!.currentTime = 2.8;
    await act(async () => {
      reactHandler(audio!, "onTimeUpdate")({});
      await Promise.resolve();
    });
    expect(audio!.currentTime).toBeGreaterThan(3.2);

    await input(view, "[aria-label='Find in the transcript']", "absent");
    expect(view.document.querySelector("[data-testid='rec-find-none']")).not.toBeNull();
    await setChecked(view, ".rec-tabbar-end input[type='checkbox']", true);
    expect(view.host.textContent).toContain("deleted");

    await input(view, "[aria-label='Translate the transcript into']", "Spanish");
    await click(view, ".rec-tools .nb-btn");
    expect(api.recTranslate).toHaveBeenCalledWith("rec-1", "Spanish");

    const exportTranscript = buttonWithText(view, "Export transcript");
    expect(exportTranscript).toBeTruthy();
    await act(async () => {
      exportTranscript?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonWithText(view, "Export subtitles")?.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(api.saveGeneratedFile).toHaveBeenCalledTimes(2);
    expect(api.saveGeneratedFile).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^Transcript .+\.txt$/),
      "[0:00] Dana: Hello team\n[0:03] Ben: A answer\n[0:07] Speaker 2: Plain text",
    );
    expect(api.saveGeneratedFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^Transcript .+\.srt$/),
      "1\n00:00:00,000 --> 00:00:02,500\nDana: Hello team\n\n2\n00:00:02,900 --> 00:00:05,900\nBen: A answer\n\n3\n00:00:06,900 --> 00:00:08,400\nSpeaker 2: Plain text\n",
    );
    await click(view, "[title='Save a copy with the deleted words really cut out of the audio']");
    expect(api.recExportClean).toHaveBeenCalledWith("rec-1");

    await click(view, "[title^='Rebuild the transcript']");
    await click(view, ".rec-retrans-confirm .nb-btn-danger");
    expect(recRetranscribe).toHaveBeenCalledWith("rec-1");

    await act(async () => view.root.unmount());
  });

  it("edits selected words through mark, note, correction, deletion, and keep", async () => {
    const recording = denseTranscriptMeta();
    api.recHighlightAdd.mockResolvedValue({ highlights: recording.highlights });
    api.recNoteAdd.mockResolvedValue({ notes: recording.notes });
    api.recCorrectRange.mockResolvedValue(recording);
    api.recDeleteRange.mockResolvedValue(recording);
    const view = await renderRecording("meeting.wav", recording);
    Reflect.set(view.window, "getSelection", () => ({
      isCollapsed: false,
      getRangeAt: () => ({
        intersectsNode: (node: Node) => [...view.document.querySelectorAll<HTMLElement>("[data-t0]")]
          .includes(node as HTMLElement),
      }),
      removeAllRanges: vi.fn(),
    }));

    const selectWords = async () => {
      await act(async () => {
        const transcript = view.document.querySelector<HTMLElement>(".rec-transcript");
        if (!transcript) throw new Error("Missing transcript");
        reactHandler(transcript, "onMouseUp")({});
        await Promise.resolve();
      });
      expect(view.document.querySelector(".rec-selectbar")).not.toBeNull();
    };

    await selectWords();
    await click(view, "[data-testid='mark-selection']");
    expect(api.recHighlightAdd).toHaveBeenCalledWith("rec-1", 0, 650);

    await selectWords();
    await click(view, "[data-testid='note-selection']");
    await input(view, "[data-testid='note-input']", "Remember this");
    await click(view, ".rec-selectbar .nb-btn");
    expect(api.recNoteAdd).toHaveBeenCalledWith("rec-1", 0, "point", "Remember this");

    await selectWords();
    await click(view, "[title='Retype what this actually says. The audio is untouched.']");
    await input(view, "[aria-label='Corrected words']", "Actually said");
    await click(view, ".rec-selectbar .nb-btn");
    expect(api.recCorrectRange).toHaveBeenCalledWith("rec-1", 0, 650, "Actually said");

    await selectWords();
    await click(view, ".rec-selectbar .nb-btn-danger");
    expect(api.recDeleteRange).toHaveBeenCalledWith("rec-1", 0, 650);

    await selectWords();
    await click(view, ".rec-selectbar .nb-btn-quiet");
    expect(view.document.querySelector(".rec-selectbar")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("reads, seeks, jumps, removes findings, and adds a chapter", async () => {
    const recording = denseTranscriptMeta();
    api.recItemDelete.mockResolvedValue(recording);
    api.recChapterAdd.mockResolvedValue(recording);
    const view = await renderRecording("meeting.wav", recording);

    const clickTab = async (name: string) => {
      const tab = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
        .find((button) => button.textContent?.includes(name));
      if (!tab) throw new Error(`Missing ${name} tab`);
      await act(async () => {
        tab.click();
        await Promise.resolve();
      });
    };
    await act(async () => {
      await clickTab("Notes");
    });
    await click(view, "[data-testid='rec-found-remove']");
    expect(api.recItemDelete).toHaveBeenCalledWith("rec-1", "note", "decision");

    await clickTab("Highlights");
    await click(view, "[data-testid='rec-hl-jump']");
    expect(view.host.textContent).toContain("Hello team");

    await clickTab("Chapters");
    await click(view, "[data-testid='add-chapter']");
    await input(view, "[data-testid='chapter-input']", "Decisions");
    await key(view, "[data-testid='chapter-input']", "Enter");
    expect(api.recChapterAdd).toHaveBeenCalledWith("rec-1", 0, "Decisions");
    await act(async () => view.root.unmount());
  });

  it("accepts matching live events and keeps another recording's events out", async () => {
    const recording = denseTranscriptMeta();
    const view = await renderRecording("meeting.wav", recording, { fileId: "rec-1", status: "recording" });
    await emit("partial", { fileId: "other", source: "mic", text: "ignore" });
    await emit("partial", { fileId: "rec-1", source: "sys", text: "The room is speaking" });
    await emit("source", { fileId: "rec-1", source: "sys", status: "error", message: "Grant screen permission" });
    await emit("source", { fileId: "rec-1", source: "mic", status: "error", message: "Grant mic permission" });
    await emit("level", { fileId: "rec-1", mic: 0.2, sys: 0.1, durationCs: 1_200 });
    await emit("translation", { fileId: "rec-1", segId: "seg-1", text: "Hola equipo" });
    await emit("segment", {
      fileId: "rec-1",
      segment: { id: "seg-live", t0: 305, t1: 340, speaker: "Speaker 2", source: "sys", text: "Inserted", words: [] },
    });
    await emit("segmentDrop", { fileId: "rec-1", id: "seg-live" });
    await emit("relabel", {
      fileId: "rec-1",
      labels: [{ id: "seg-1", speaker: "Speaker 3" }],
      speakerNames: { "Speaker 3": "Dana" },
      recognized: ["Dana"],
    });
    await emit("translateProgress", { fileId: "rec-1", done: 1, total: 3 });
    await emit("translateProgress", { fileId: "rec-1", done: 3, total: 3 });
    await emit("retranscribeProgress", { fileId: "rec-1", doneCs: 200, totalCs: 400 });
    await emit("retranscribeProgress", { fileId: "rec-1", doneCs: 400, totalCs: 400 });
    await emit("readDone", { fileId: "rec-1" });
    expect(view.host.textContent).toContain("Grant screen permission");
    expect(view.host.textContent).toContain("Grant mic permission");
    expect(view.host.textContent).toContain("Hola equipo");
    expect(view.host.textContent).not.toContain("ignore");
    await act(async () => view.root.unmount());
  });

  it("persists speaker confirmation, supports escape, and cancels chapter entry", async () => {
    const recording = denseTranscriptMeta();
    api.recSetSpeakerName.mockResolvedValue({ speakerNames: { "Speaker 1": "Dana" }, recognized: [] });
    const view = await renderRecording("meeting.wav", recording);
    await click(view, "[data-testid='speaker-chip']");
    await key(view, "[data-testid='speaker-input']", "Enter");
    expect(api.recSetSpeakerName).toHaveBeenCalledWith("rec-1", "Speaker 1", "Dana");

    const chip = view.document.querySelector<HTMLButtonElement>("[data-testid='speaker-chip']");
    await act(async () => {
      chip?.click();
      await Promise.resolve();
    });
    await input(view, "[data-testid='speaker-input']", "Changed");
    await key(view, "[data-testid='speaker-input']", "Escape");
    expect(view.document.querySelector("[data-testid='speaker-input']")).toBeNull();

    const chapters = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Chapters"));
    await act(async () => {
      chapters?.click();
      await Promise.resolve();
    });
    await click(view, "[data-testid='add-chapter']");
    await input(view, "[data-testid='chapter-input']", "Ignore me");
    await key(view, "[data-testid='chapter-input']", "Escape");
    expect(view.document.querySelector("[data-testid='chapter-input']")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("explains unread empty tabs and reflects in-progress jobs and source recovery", async () => {
    const noWords = meta(0);
    const view = await renderRecording(
      "meeting.wav",
      noWords,
      { fileId: "rec-1", status: "recording" },
      {
        jobs: [{ kind: "rec_read", status: "running", plan: { file_id: "rec-1" } }],
        liveStatus: { fileId: "rec-1", sys: ["error", "Screen access failed"], mic: ["error", "Mic access failed"] },
      },
    );
    expect(view.host.textContent).toContain("Screen access failed");
    const notes = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Notes"));
    await act(async () => {
      notes?.click();
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain("Reading this recording…");
    await emit("source", { fileId: "rec-1", source: "sys", status: "ok", message: "" });
    await emit("source", { fileId: "rec-1", source: "mic", status: "ok", message: "" });
    expect(view.host.textContent).not.toContain("Screen access failed");
    await act(async () => view.root.unmount());
  });

  it("operates live session controls, commits live translation, and follows tab keys", async () => {
    const recording = denseTranscriptMeta();
    api.recHighlightAdd.mockResolvedValue({ highlights: recording.highlights });
    api.recSetLiveTranslate.mockResolvedValue(undefined as never);
    api.recSetLiveStt.mockResolvedValue(undefined as never);
    const view = await renderRecording("meeting.wav", recording, { fileId: "rec-1", status: "recording" });
    await click(view, "[aria-label='Pause recording']");
    await click(view, "[data-testid='mark-now']");
    await click(view, "[aria-label='Mute the microphone']");
    await setChecked(view, "input[type='checkbox']", false);
    await input(view, "input[list='rec-langs']", "French");
    await key(view, "input[list='rec-langs']", "Enter");
    expect(api.recSetLiveTranslate).toHaveBeenCalledWith("French");
    expect(api.recSetLiveStt).toHaveBeenCalledWith(false);

    await key(view, "[role='tab']", "End");
    expect(view.document.querySelector("[aria-selected='true']")?.textContent).toContain("Chapters");
    await key(view, "[role='tab']", "Home");
    expect(view.document.querySelector("[aria-selected='true']")?.textContent).toContain("Transcript");
    await act(async () => view.root.unmount());
  });

  it("reports errors from review tools without changing the displayed recording", async () => {
    const recording = denseTranscriptMeta();
    const failure = new Error("offline");
    api.recTranslate.mockRejectedValue(failure);
    api.saveGeneratedFile.mockRejectedValue(failure);
    api.recExportClean.mockRejectedValue(failure);
    recRetranscribe.mockRejectedValue(failure);
    api.recSetSpeakerName.mockRejectedValue(failure);
    api.recItemDelete.mockRejectedValue(failure);
    api.recChapterAdd.mockRejectedValue(failure);
    const view = await renderRecording("meeting.wav", recording, null, { mediaToken: "media-1" });
    await input(view, "[aria-label='Translate the transcript into']", "French");
    await key(view, "[aria-label='Translate the transcript into']", "Enter");
    await act(async () => {
      buttonWithText(view, "Export transcript")?.click();
      await Promise.resolve();
    });
    await click(view, "[title='Save a copy with the deleted words really cut out of the audio']");
    await click(view, "[title^='Rebuild the transcript']");
    await click(view, ".rec-retrans-confirm .nb-btn-danger");

    await click(view, "[data-testid='speaker-chip']");
    await input(view, "[data-testid='speaker-input']", "Different name");
    await key(view, "[data-testid='speaker-input']", "Enter");

    const notes = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Notes"));
    await act(async () => {
      notes?.click();
      await Promise.resolve();
    });
    await click(view, "[data-testid='rec-found-remove']");
    const chapters = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Chapters"));
    await act(async () => {
      chapters?.click();
      await Promise.resolve();
    });
    await click(view, "[data-testid='add-chapter']");
    await input(view, "[data-testid='chapter-input']", "Fails");
    await key(view, "[data-testid='chapter-input']", "Enter");
    const selectWords = async () => {
      const transcriptTab = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
        .find((button) => button.textContent?.includes("Transcript"));
      await act(async () => {
        transcriptTab?.click();
        await Promise.resolve();
      });
      Reflect.set(view.window, "getSelection", () => ({
        isCollapsed: false,
        getRangeAt: () => ({ intersectsNode: (node: Node) => [...view.document.querySelectorAll<HTMLElement>("[data-t0]")].includes(node as HTMLElement) }),
        removeAllRanges: vi.fn(),
      }));
      await act(async () => {
        view.document.dispatchEvent(new view.window.Event("selectionchange", { bubbles: true }));
        await new Promise<void>((resolve) => view.window.setTimeout(resolve, 0));
        const transcript = view.document.querySelector<HTMLElement>(".rec-transcript");
        reactHandler(transcript!, "onMouseUp")({});
        await Promise.resolve();
      });
    };
    api.recCorrectRange.mockRejectedValue(failure);
    await selectWords();
    await click(view, "[title='Retype what this actually says. The audio is untouched.']");
    await input(view, "[aria-label='Corrected words']", "Nope");
    await click(view, ".rec-selectbar .nb-btn");
    await click(view, ".rec-selectbar .nb-btn-quiet");
    api.recDeleteRange.mockRejectedValue(failure);
    await selectWords();
    await click(view, ".rec-selectbar .nb-btn-danger");
    api.recHighlightAdd.mockRejectedValue(failure);
    await selectWords();
    await click(view, "[data-testid='mark-selection']");
    api.recNoteAdd.mockRejectedValue(failure);
    await selectWords();
    await click(view, "[data-testid='note-selection']");
    await input(view, "[data-testid='note-input']", "Nope");
    await click(view, ".rec-selectbar .nb-btn");
    expect(view.pushToast).toHaveBeenCalledWith("error", "Error: offline");
    await act(async () => view.root.unmount());
  });

  it("renders transcript fallbacks, excerpt text, saved states, and standalone live voices", async () => {
    const empty = await renderRecording("meeting.wav", meta(0));
    const emptyNotes = [...empty.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Notes"));
    await act(async () => {
      emptyNotes?.click();
      await Promise.resolve();
    });
    expect(empty.host.textContent).toContain("Nothing has been transcribed yet");
    await act(async () => empty.root.unmount());

    const recording = denseTranscriptMeta();
    recording.highlights[0].t1 = 700;
    (recording.segments[0] as { words: { w: string }[] }).words[1].w = "team.";
    api.recSetSpeakerName.mockResolvedValue({ speakerNames: { "Speaker 2": "Kai" }, recognized: [] });
    const view = await renderRecording("meeting.wav", recording);
    const highlights = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Highlights"));
    await act(async () => {
      highlights?.click();
      await Promise.resolve();
    });
    expect(view.document.querySelector(".rec-hl-quote")).not.toBeNull();
    const transcript = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Transcript"));
    await act(async () => {
      transcript?.click();
      await Promise.resolve();
    });
    const speakerTwo = [...view.document.querySelectorAll<HTMLButtonElement>("[data-testid='speaker-chip']")]
      .find((button) => button.dataset.speaker === "Speaker 2");
    await act(async () => {
      speakerTwo?.click();
      await Promise.resolve();
    });
    await input(view, "[data-testid='speaker-input']", "Kai");
    await key(view, "[data-testid='speaker-input']", "Enter");
    expect(view.pushToast).toHaveBeenCalledWith("success", expect.stringContaining('"Kai"'));
    await act(async () => view.root.unmount());

    const writing = await renderRecording("meeting.wav", meta(10), { fileId: "rec-1", status: "saving" }, { saveProgress: { stage: "writing", remaining: 0 } });
    expect(writing.host.textContent).toContain("writing the recording");
    await act(async () => writing.root.unmount());
    const saving = await renderRecording("meeting.wav", meta(10), { fileId: "rec-1", status: "saving" });
    expect(saving.host.textContent).toContain("Saving…");
    await act(async () => saving.root.unmount());

    const live = await renderRecording("meeting.wav", recording, { fileId: "rec-1", status: "recording" });
    await emit("partial", { fileId: "rec-1", source: "mic", text: "I am speaking" });
    expect(live.host.textContent).toContain("Ben");
    await act(async () => live.root.unmount());
  });

  it("keeps recoverable error and cancellation paths visible", async () => {
    const failure = new Error("offline");
    const unloaded = await renderRecording("meeting.wav", meta(0), null, { loadError: failure });
    await emit("relabel", { fileId: "rec-1", labels: [], speakerNames: {}, recognized: [] });
    expect(unloaded.pushToast).toHaveBeenCalledWith("error", "Error: offline");
    await act(async () => unloaded.root.unmount());

    const readMeta = transcriptMeta();
    readMeta.notes = [];
    api.recReadStart.mockRejectedValue(failure);
    const readView = await renderRecording("meeting.wav", readMeta);
    const notes = [...readView.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Notes"));
    await act(async () => {
      notes?.click();
      await Promise.resolve();
    });
    await click(readView, "[data-testid='rec-read-btn']");
    expect(readView.pushToast).toHaveBeenCalledWith("error", "Error: offline");
    await act(async () => readView.root.unmount());

    const onlyDeleted = meta(100, [{ id: "gone", t0: 0, t1: 50, speaker: "Speaker 1", text: "", words: [{ w: "gone", t0: 0, t1: 50, del: true }] }]);
    const exportView = await renderRecording("meeting.wav", onlyDeleted);
    await act(async () => {
      buttonWithText(exportView, "Export transcript")?.click();
      await Promise.resolve();
    });
    expect(exportView.pushToast).toHaveBeenCalledWith("info", "There is nothing transcribed to export yet.");
    await act(async () => exportView.root.unmount());

    const live = await renderRecording("meeting.wav", denseTranscriptMeta(), { fileId: "rec-1", status: "recording" });
    api.recHighlightAdd.mockRejectedValue(failure);
    api.recSetLiveStt.mockRejectedValue(failure);
    api.recSetLiveTranslate.mockRejectedValue(failure);
    await click(live, "[data-testid='mark-now']");
    await setChecked(live, "input[type='checkbox']", false);
    await input(live, "input[list='rec-langs']", "French");
    await key(live, "input[list='rec-langs']", "Enter");
    expect(live.pushToast).toHaveBeenCalledWith("error", "Error: offline");
    await act(async () => live.root.unmount());

    api.recNoteAdd.mockRejectedValue(failure);
    api.recCorrectRange.mockRejectedValue(failure);
    const editing = await renderRecording("meeting.wav", denseTranscriptMeta());
    Reflect.set(editing.window, "getSelection", () => ({
      isCollapsed: false,
      getRangeAt: () => ({ intersectsNode: (node: Node) => [...editing.document.querySelectorAll<HTMLElement>("[data-t0]")].includes(node as HTMLElement) }),
      removeAllRanges: vi.fn(),
    }));
    await act(async () => {
      editing.document.querySelector(".rec-panel")?.dispatchEvent(new editing.window.Event("wheel"));
      reactHandler(editing.document.querySelector<HTMLElement>(".rec-transcript")!, "onMouseUp")({});
      await Promise.resolve();
    });
    await click(editing, "[data-testid='note-selection']");
    await input(editing, "[data-testid='note-input']", "Nope");
    await key(editing, "[data-testid='note-input']", "Enter");
    await click(editing, ".rec-selectbar .nb-btn-quiet");
    await click(editing, "[title='Retype what this actually says. The audio is untouched.']");
    await input(editing, "[aria-label='Corrected words']", "Nope");
    await key(editing, "[aria-label='Corrected words']", "Enter");
    await key(editing, "[aria-label='Corrected words']", "Escape");
    Reflect.set(editing.window, "getSelection", () => ({ isCollapsed: true }));
    await act(async () => {
      reactHandler(editing.document.querySelector<HTMLElement>(".rec-transcript")!, "onMouseUp")({});
      await Promise.resolve();
    });
    expect(editing.document.querySelector(".rec-selectbar")).toBeNull();
    await act(async () => editing.root.unmount());
  });

  it("keeps a late item deletion valid when the recording refresh clears its meta", async () => {
    const recording = denseTranscriptMeta();
    let finishDelete: ((value: typeof recording) => void) | undefined;
    api.recItemDelete.mockImplementation(() => new Promise((resolve) => {
      finishDelete = resolve as (value: typeof recording) => void;
    }));
    const view = await renderRecording("meeting.wav", recording);
    const notes = [...view.document.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent?.includes("Notes"));
    await act(async () => {
      notes?.click();
      await Promise.resolve();
    });
    await click(view, "[data-testid='rec-found-remove']");
    api.recGet.mockResolvedValue({ name: "meeting.wav", meta: null });
    await emit("readDone", { fileId: "rec-1" });
    await act(async () => {
      finishDelete?.(recording);
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain("Ship it");
    await act(async () => view.root.unmount());
  });
});
