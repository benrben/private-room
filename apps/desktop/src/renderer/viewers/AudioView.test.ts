import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { act, createElement } = React;

const mocks = vi.hoisted(() => ({
  grabFrame: vi.fn(),
  probeVideoMeta: vi.fn(),
  retranscribeFile: vi.fn(),
  saveVideoFrame: vi.fn(),
  videoTrim: vi.fn(),
  waveformProps: null as Record<string, any> | null,
}));

vi.mock("../api", () => ({
  api: {
    probeVideoMeta: mocks.probeVideoMeta,
    retranscribeFile: mocks.retranscribeFile,
    saveVideoFrame: mocks.saveVideoFrame,
    videoTrim: mocks.videoTrim,
  },
}));
vi.mock("../icons", () => ({ RefreshIcon: () => null }));
vi.mock("./frameGrab", () => ({ grabFrame: mocks.grabFrame }));
vi.mock("./Waveform", () => ({
  default: (props: Record<string, any>) => {
    mocks.waveformProps = props;
    return createElement("button", { className: "waveform", onClick: () => props.onSeek?.(4) }, "waveform");
  },
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
};

afterEach(() => {
  vi.clearAllMocks();
  mocks.waveformProps = null;
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function props(overrides: Record<string, unknown> = {}) {
  return {
    kind: "audio",
    fileId: "audio-1",
    mime: "audio/m4a",
    dataB64: "AQ==",
    mediaToken: "media-token",
    text: null,
    ...overrides,
  } as Record<string, any>;
}

async function renderAudio(initial = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLMediaElement", window.HTMLMediaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const [{ createRoot }, { default: AudioView }] = await Promise.all([
    import("react-dom/client"),
    import("./AudioView"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next = initial) => act(async () => {
    root.render(createElement(AudioView, next as never));
    await Promise.resolve();
  });
  await draw();
  return { document, draw, host, root, window };
}

function media(view: Awaited<ReturnType<typeof renderAudio>>) {
  const element = view.host.querySelector("audio, video") as HTMLMediaElement | null;
  if (!element) throw new Error("media element missing");
  return element;
}

function setMedia(element: HTMLMediaElement, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(element, key, { configurable: true, value, writable: true });
  }
}

async function event(view: Awaited<ReturnType<typeof renderAudio>>, element: Element, type: string) {
  await act(async () => {
    element.dispatchEvent(new view.window.Event(type, { bubbles: true }));
    await Promise.resolve();
  });
}

function reactProp(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key][name];
}

async function click(view: Awaited<ReturnType<typeof renderAudio>>, text: string) {
  const button = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  await event(view, button, "click");
  return button;
}

describe("AudioView", () => {
  it("keeps Transcribe actionable when an eligible CAF file cannot play", async () => {
    mocks.retranscribeFile.mockResolvedValueOnce(undefined);
    const view = await renderAudio(props({ fileId: "caf-file", mime: "application/octet-stream" }));
    await event(view, media(view), "error");
    const button = view.host.querySelector<HTMLButtonElement>(".audio-retranscribe");
    expect(button?.textContent).toContain("Transcribe");
    expect(button?.disabled).toBe(false);
    expect(view.host.textContent).toContain("Playback and on-device transcription use different decoders");
    await event(view, button!, "click");
    expect(mocks.retranscribeFile).toHaveBeenCalledWith("caf-file");
    await act(async () => view.root.unmount());
  });

  it("plays, seeks, follows, and groups timestamped speaker transcript rows", async () => {
    const view = await renderAudio(props({
      text: "provenance\n\n[00:02] Dana: hello world\n[00:04] Dana: still here\n[01:02:03] Ira: bye\n[00:06] Question? not a speaker",
      target: { quote: "hello world" },
    }));
    const player = media(view);
    const play = vi.fn(() => Promise.resolve());
    setMedia(player, { currentTime: 0, duration: 12, play, readyState: 1 });
    await event(view, player, "loadedmetadata");
    expect(view.host.textContent).toContain("Length 0:12");
    expect(view.host.textContent).toContain("Transcript ready");
    expect(view.host.querySelector(".audio-speaker")?.textContent).toContain("Dana");
    expect(mocks.waveformProps?.regions).toEqual([
      { start: 2, end: 3723, speaker: "Dana" },
      { start: 3723, end: 12, speaker: "Ira" },
    ]);
    await click(view, "hello world");
    expect(play).toHaveBeenCalledOnce();
    setMedia(player, { currentTime: 4 });
    await event(view, player, "timeupdate");
    expect(view.host.querySelectorAll(".audio-line.active")).toHaveLength(1);
    await click(view, "waveform");
    setMedia(player, { currentTime: 0, duration: Infinity });
    await event(view, player, "loadedmetadata");
    expect(player.currentTime).toBe(1e101);
    setMedia(player, { duration: 20 });
    await event(view, player, "durationchange");
    expect(player.currentTime).toBe(4);
    await act(async () => view.root.unmount());
  });

  it("reports transcript stages and retranscription failures without hiding playback", async () => {
    const view = await renderAudio(props({ sttStage: "model-missing" }));
    expect(view.host.textContent).toContain("No speech model");
    expect(view.host.textContent).toContain("Install one");
    await view.draw(props({ sttStage: "none" }));
    expect(view.host.textContent).toContain("held no speech");
    await view.draw(props({ sttStage: "failed: no decoder" }));
    expect(view.host.textContent).toContain("couldn’t be transcribed: no decoder");
    await view.draw(props({ transcribing: true }));
    expect(view.host.textContent).toContain("Transcribing on this Mac");
    mocks.retranscribeFile.mockImplementationOnce(() => new Promise<void>(() => {}));
    await view.draw(props({ sttStage: "waiting" }));
    await click(view, "Transcribe");
    expect(view.host.textContent).toContain("Queued for transcription");
    await view.draw(props({ sttStage: "processing" }));
    expect(view.host.textContent).toContain("No transcript yet");
    mocks.retranscribeFile.mockRejectedValueOnce(new Error("transcribe failed"));
    await click(view, "Transcribe");
    expect(view.host.textContent).toContain("Error: transcribe failed");
    await view.draw(props({ text: "[00:00] ." }));
    expect(view.host.textContent).toContain("appears to be silent");
    await act(async () => view.root.unmount());
  });

  it("probes video facts and preserves trim, frame, and action error outcomes", async () => {
    mocks.probeVideoMeta.mockResolvedValueOnce({ width: 1920, height: 1080, durationSecs: 8, hasAudio: true, audioCodec: "aac", videoCodec: "h264", frameRate: 30 });
    mocks.videoTrim.mockResolvedValueOnce({ name: "cut.mp4" });
    mocks.saveVideoFrame.mockResolvedValueOnce({ name: "still.png" });
    mocks.grabFrame.mockResolvedValueOnce({ imageB64: "shot", width: 100, height: 50, atSeconds: 3, sha256: "hash" });
    const view = await renderAudio(props({ kind: "video", fileId: "video-1", mime: "video/mp4", text: "[00:03] Alex: frame", mediaMeta: null }));
    const player = media(view);
    setMedia(player, { currentTime: 2, duration: 8, readyState: 1, play: vi.fn(() => Promise.resolve()) });
    await event(view, player, "loadedmetadata");
    expect(view.host.querySelector("video")).not.toBeNull();
    expect(view.host.textContent).toContain("1920 × 1080");
    await click(view, "Set start");
    setMedia(player, { currentTime: 5 });
    await click(view, "Set end");
    await click(view, "Trim 0:02 → 0:05");
    expect(view.host.textContent).toContain("Saved “cut.mp4”");
    setMedia(player, { currentTime: 3 });
    await click(view, "Save frame");
    expect(mocks.grabFrame).toHaveBeenCalledWith("media-token", "video/mp4", 3, Infinity);
    expect(view.host.textContent).toContain("Saved “still.png” (100 × 50)");
    mocks.videoTrim.mockRejectedValueOnce(new Error("trim failed"));
    await click(view, "Trim 0:02 → 0:05");
    expect(view.host.textContent).toContain("Error: trim failed");
    mocks.grabFrame.mockResolvedValueOnce({ error: "no frame" });
    await click(view, "Save frame");
    expect(view.host.textContent).toContain("no frame");
    mocks.grabFrame.mockRejectedValueOnce(new Error("grab failed"));
    await click(view, "Save frame");
    expect(view.host.textContent).toContain("Error: grab failed");
    await act(async () => view.root.unmount());
  });

  it("handles unavailable frames, media resets, blob fallback, and inert action guards", async () => {
    const view = await renderAudio(props({ kind: "video", mediaToken: null, mime: "", dataB64: "AQ==", mediaMeta: { hasAudio: false } }));
    const player = media(view);
    setMedia(player, { currentTime: 0, duration: 0, readyState: 0, play: vi.fn(() => Promise.reject(new Error("blocked"))) });
    await event(view, player, "loadedmetadata");
    expect(view.host.textContent).toContain("couldn't be played");
    await view.draw(props({ kind: "video", mediaToken: null, mime: "audio/aac", dataB64: "AQ==", mediaMeta: { hasAudio: false } }));
    await click(view, "Save frame");
    expect(view.host.textContent).toContain("isn't streaming");
    const trim = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Trim");
    if (!trim) throw new Error("trim button missing");
    await act(async () => reactProp(trim, "onClick")({}));
    await view.draw(props({ mediaToken: null, mime: "audio/wav", dataB64: "AQ==" }));
    expect(media(view).getAttribute("src") ?? "").toContain("blob:");
    await act(async () => view.root.unmount());
  });
});
