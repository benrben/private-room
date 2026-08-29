import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { act, createElement } = React;

const { retranscribeFile } = vi.hoisted(() => ({
  retranscribeFile: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("../api", () => ({
  api: {
    retranscribeFile,
  },
}));

vi.mock("../icons", () => ({
  RefreshIcon: () => null,
}));

// WaveSurfer needs browser layout/audio APIs that are irrelevant to this
// contract. Keep the child boundary real enough to prove AudioView renders,
// while the test drives AudioView's own media-error event and action.
vi.mock("./Waveform", () => ({
  default: () => null,
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
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("AudioView decoder failure", () => {
  it("keeps Transcribe actionable when an eligible CAF file cannot play", async () => {
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    const document = parsed.document as unknown as Document;
    const window = parsed.window as unknown as Window & typeof globalThis;
    Reflect.set(globalThis, "window", window);
    Reflect.set(globalThis, "document", document);
    Reflect.set(globalThis, "navigator", window.navigator);
    Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
    Reflect.set(globalThis, "HTMLMediaElement", window.HTMLMediaElement);
    Reflect.set(globalThis, "Event", window.Event);
    // Vitest's Node transform uses the classic JSX runtime for imported TSX.
    Reflect.set(globalThis, "React", React);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

    // Import after installing the DOM: ReactDOM decides whether event handling
    // is available when its client module is evaluated.
    const [{ createRoot }, { default: AudioView }] = await Promise.all([
      import("react-dom/client"),
      import("./AudioView"),
    ]);
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(AudioView, {
        kind: "audio",
        fileId: "caf-file",
        mime: "application/octet-stream",
        dataB64: "",
        mediaToken: "caf-token",
        text: null,
      }));
    });

    const media = host.querySelector("audio");
    expect(media).not.toBeNull();
    await act(async () => {
      media?.dispatchEvent(new window.Event("error"));
    });

    const button = host.querySelector<HTMLButtonElement>(".audio-retranscribe");
    expect(button?.textContent).toContain("Transcribe");
    expect(button?.disabled).toBe(false);
    expect(host.textContent).toContain("Playback and on-device transcription use different decoders");
    expect(host.textContent).not.toContain("there is no audio to transcribe");

    await act(async () => {
      button?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(retranscribeFile).toHaveBeenCalledOnce();
    expect(retranscribeFile).toHaveBeenCalledWith("caf-file");

    await act(async () => root.unmount());
  });
});
