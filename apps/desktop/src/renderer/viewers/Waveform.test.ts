import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { act, createElement } = React;

const mocks = vi.hoisted(() => ({
  audioPeaks: vi.fn(),
  create: vi.fn(),
  hoverCreate: vi.fn(),
  observers: [] as { callback: MutationCallback; disconnect: ReturnType<typeof vi.fn> }[],
}));

vi.mock("../api", () => ({ api: { audioPeaks: mocks.audioPeaks } }));
vi.mock("wavesurfer.js", () => ({ default: { create: mocks.create } }));
vi.mock("wavesurfer.js/dist/plugins/hover.esm.js", () => ({ default: { create: mocks.hoverCreate } }));

const originalGlobals: Record<string, unknown> = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  HTMLMediaElement: globalThis.HTMLMediaElement,
  Event: globalThis.Event,
  MutationObserver: globalThis.MutationObserver,
  getComputedStyle: globalThis.getComputedStyle,
  React: Reflect.get(globalThis, "React"),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};

afterEach(() => {
  vi.clearAllMocks();
  mocks.observers.length = 0;
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function installDom() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  class FakeMutationObserver {
    disconnect = vi.fn();

    constructor(callback: MutationCallback) {
      this.callback = callback;
      mocks.observers.push(this);
    }

    callback: MutationCallback;

    observe() {}
  }
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLMediaElement", window.HTMLMediaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "MutationObserver", FakeMutationObserver);
  Reflect.set(globalThis, "getComputedStyle", () => ({ getPropertyValue: () => "" }));
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  return { document, window };
}

function fakeWave() {
  const handlers = new Map<string, () => void>();
  const wave = {
    on: vi.fn((event: string, callback: () => void) => handlers.set(event, callback)),
    getCurrentTime: vi.fn(() => 4.5),
    unAll: vi.fn(),
    destroy: vi.fn(),
    setOptions: vi.fn(),
  };
  mocks.create.mockReturnValue(wave);
  return { handlers, wave };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderWaveform(overrides: Record<string, unknown> = {}) {
  const { document, window } = installDom();
  const media = document.createElement("audio") as unknown as HTMLMediaElement;
  const [{ createRoot }, { default: Waveform }] = await Promise.all([
    import("react-dom/client"),
    import("./Waveform"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next: Record<string, unknown> = {}) => {
    await act(async () => {
      root.render(createElement(Waveform, {
        fileId: "audio-1",
        media,
        ...overrides,
        ...next,
      }));
      await flush();
    });
  };
  await draw();
  return { document, draw, host, media, root, window };
}

describe("Waveform", () => {
  it("draws its host envelope, decorations, and speaker lanes with fake WaveSurfer events", async () => {
    const seek = vi.fn();
    const { handlers, wave } = fakeWave();
    mocks.hoverCreate.mockReturnValue({});
    mocks.audioPeaks.mockResolvedValue({ peaks: [0, 0.5, 1], duration: 10, silent: false });

    const view = await renderWaveform({
      height: 80,
      lanes: true,
      regions: [
        { start: 0, end: 3, speaker: "Ada" },
        { start: 4, end: 10, speaker: "Bea" },
      ],
      mark: { start: 2, end: 4 },
      marks: [{ start: 5, end: 5 }],
      chapters: [{ at: 6, title: "Review" }],
      onSeek: seek,
    });

    expect(mocks.audioPeaks).toHaveBeenCalledWith("audio-1");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      container: view.host.querySelector(".waveform-canvas"),
      media: view.media,
      height: 80,
      peaks: [[0, 0.5, 1]],
      duration: 10,
      normalize: false,
    }));
    expect(view.host.querySelectorAll(".waveform-axis .waveform-tick").length).toBeGreaterThan(0);
    expect(view.host.querySelectorAll(".waveform-saved-mark")).toHaveLength(1);
    expect(view.host.querySelector(".waveform-chapter-label")?.textContent).toBe("Review");
    expect(view.host.querySelectorAll(".waveform-band")).toHaveLength(1);
    expect(view.host.querySelectorAll(".waveform-lane")).toHaveLength(2);
    expect(view.host.textContent).toContain("Ada");
    handlers.get("interaction")?.();
    expect(seek).toHaveBeenCalledWith(4.5);
    await act(async () => {
      mocks.observers[0]?.callback([], {} as MutationObserver);
      await flush();
    });
    expect(wave.setOptions).toHaveBeenCalledWith(expect.objectContaining({
      waveColor: "#787e77",
      progressColor: "#c87b91",
    }));

    await act(async () => view.root.unmount());
    expect(wave.unAll).toHaveBeenCalledOnce();
    expect(wave.destroy).toHaveBeenCalledOnce();
    expect(mocks.observers[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a silent track informative, renders the mixed ribbon, and turns WaveSurfer errors into a failure", async () => {
    const { handlers } = fakeWave();
    mocks.hoverCreate.mockReturnValue({});
    mocks.audioPeaks.mockResolvedValue({ peaks: [0, 0], duration: 8, silent: true });

    const view = await renderWaveform({
      regions: [
        { start: 0, end: 2, speaker: "Ada" },
        { start: 3, end: 8, speaker: "Bea" },
      ],
    });

    expect(view.host.querySelectorAll(".waveform-ribbon .waveform-turn")).toHaveLength(2);
    expect(view.host.querySelectorAll(".waveform-legend li")).toHaveLength(2);
    expect(view.host.textContent).toContain("No audio signal — this track is silent.");
    await act(async () => {
      handlers.get("error")?.();
      await flush();
    });
    expect(view.host.querySelector(".waveform-failed")?.textContent).toContain("could not be drawn");
    await act(async () => view.root.unmount());
  });

  it("does not decode a known no-audio file and reports empty or rejected host envelopes", async () => {
    const noAudio = await renderWaveform({ hasAudioTrack: false });
    expect(mocks.audioPeaks).not.toHaveBeenCalled();
    expect(noAudio.host.textContent).toContain("This file has no audio track.");
    await act(async () => noAudio.root.unmount());

    mocks.audioPeaks.mockResolvedValueOnce({ peaks: [], duration: 0, silent: false });
    const empty = await renderWaveform({ fileId: "empty" });
    expect(empty.host.querySelector(".waveform-failed")?.textContent).toContain("no readable audio");
    await act(async () => empty.root.unmount());

    mocks.audioPeaks.mockRejectedValueOnce(new Error("peak decoder unavailable"));
    const rejected = await renderWaveform({ fileId: "bad" });
    expect(rejected.host.querySelector(".waveform-failed")?.textContent).toContain("peak decoder unavailable");
    await act(async () => rejected.root.unmount());
  });

  it("uses the largest readable tick step for an exceptionally long recording", async () => {
    fakeWave();
    mocks.hoverCreate.mockReturnValue({});
    mocks.audioPeaks.mockResolvedValue({ peaks: [0, 1], duration: 100_000, silent: false });

    const view = await renderWaveform();

    expect(view.host.querySelectorAll(".waveform-axis .waveform-tick").length).toBeGreaterThan(0);
    await act(async () => view.root.unmount());
  });

  it("tolerates a WaveSurfer already torn down during repaint and unmount", async () => {
    const { wave } = fakeWave();
    wave.setOptions.mockImplementation(() => {
      throw new Error("already destroyed");
    });
    wave.unAll.mockImplementation(() => {
      throw new Error("already destroyed");
    });
    mocks.hoverCreate.mockReturnValue({});
    mocks.audioPeaks.mockResolvedValue({ peaks: [0, 1], duration: 4, silent: false });
    const view = await renderWaveform();

    expect(() => mocks.observers[0]?.callback([], {} as MutationObserver)).not.toThrow();
    await expect(act(async () => view.root.unmount())).resolves.toBeUndefined();
  });
});
