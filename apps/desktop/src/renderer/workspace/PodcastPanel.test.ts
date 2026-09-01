import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeuralVoiceInfo, Podcast, PodcastHost } from "../api";
import type { WSActions } from "./actions";
import type { WSState } from "./state";

const mocks = vi.hoisted(() => ({
  audioInstances: [] as Array<{ onended: (() => void) | null; pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; url: string }>,
  createObjectURL: vi.fn(() => "blob:preview"),
  getPodcast: vi.fn(),
  groupVoices: vi.fn(),
  loadVoiceCatalog: vi.fn(),
  previewPodcastVoice: vi.fn(),
  revokeObjectURL: vi.fn(),
  setPodcastCast: vi.fn(),
  startPodcastAudioJob: vi.fn(),
  suggestDistinctVoices: vi.fn(),
  castNeedsVoices: vi.fn(),
  base64ToBytes: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock("../api", () => ({
  api: {
    getPodcast: mocks.getPodcast,
    previewPodcastVoice: mocks.previewPodcastVoice,
    setPodcastCast: mocks.setPodcastCast,
    startPodcastAudioJob: mocks.startPodcastAudioJob,
  },
}));
vi.mock("../icons", () => ({
  CircleCheckIcon: () => null,
  MicIcon: () => null,
  PlayIcon: () => null,
  StopIcon: () => null,
}));
vi.mock("../settings/voiceCatalog", () => ({
  castNeedsVoices: mocks.castNeedsVoices,
  groupVoices: mocks.groupVoices,
  languageLabel: (locale: string) => locale,
  loadVoiceCatalog: mocks.loadVoiceCatalog,
  optionLabel: (voice: NeuralVoiceInfo) => voice.id,
  suggestDistinctVoices: mocks.suggestDistinctVoices,
  voiceName: (id: string) => id.replace(/.*-/, ""),
}));
vi.mock("../viewers/util", () => ({ base64ToBytes: mocks.base64ToBytes }));

import PodcastPanel from "./PodcastPanel";

const globalKeys = [
  "Audio",
  "document",
  "Event",
  "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT",
  "navigator",
  "React",
  "URL",
  "window",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

const voiceA: NeuralVoiceInfo = {
  gender: "Female",
  id: "en-US-AdaMultilingualNeural",
  locale: "en-US",
};
const voiceB: NeuralVoiceInfo = {
  gender: "Male",
  id: "he-IL-BenNeural",
  locale: "he-IL",
};

function host(name: string, voice = ""): PodcastHost {
  return { name, voice, rate: "", pitch: "" };
}

function podcast(overrides: Partial<Podcast> = {}): Podcast {
  return {
    audioFileId: null,
    cast: [host("Ada", voiceA.id), host("Ben", voiceB.id)],
    createdAt: "2026-08-31T12:00:00Z",
    fileId: "script-1",
    title: "A private episode",
    turns: [
      { speaker: "Ada", line: "Hello from the real script." },
      { speaker: "Ben", line: "A second voice." },
    ],
    ...overrides,
  };
}

function workspaceState(overrides: Record<string, unknown> = {}): WSState {
  return { privacyOn: false, pushToast: vi.fn(), webOn: true, ...overrides } as unknown as WSState;
}

function workspaceActions(overrides: Record<string, unknown> = {}): WSActions {
  return { refreshJobs: vi.fn().mockResolvedValue(undefined), viewFile: vi.fn(), ...overrides } as unknown as WSActions;
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

function reactHandler(element: Element, name: string): (event: Record<string, unknown>) => unknown {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React ${name} props missing`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => unknown>>)[key][name];
}

async function click(element: Element) {
  await act(async () => {
    reactHandler(element, "onClick")({ currentTarget: element, preventDefault: vi.fn() });
    await Promise.resolve();
  });
  await flush();
}

async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    reactHandler(element, "onChange")({ currentTarget: element, target: { value } });
    await Promise.resolve();
  });
  await flush();
}

function button(view: View, text: string): HTMLButtonElement {
  const found = [...view.host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Button ${text} missing`);
  return found as HTMLButtonElement;
}

function aria(view: View, label: string): HTMLInputElement | HTMLSelectElement | HTMLButtonElement {
  const found = view.host.querySelector(`[aria-label="${label}"]`);
  if (!found) throw new Error(`Control ${label} missing`);
  return found as HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
}

class FakeAudio {
  onended: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);

  constructor(readonly url: string) {
    mocks.audioInstances.push(this);
  }
}

type View = Awaited<ReturnType<typeof renderPanel>>;

async function renderPanel({
  a = workspaceActions(),
  fileId = "script-1",
  s = workspaceState(),
}: {
  a?: WSActions;
  fileId?: string;
  s?: WSState;
} = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "Audio", FakeAudio);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "URL", {
    createObjectURL: mocks.createObjectURL,
    revokeObjectURL: mocks.revokeObjectURL,
  });
  Reflect.set(globalThis, "window", window);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(PodcastPanel, { a, fileId, s }));
    await Promise.resolve();
  });
  await flush();
  return {
    a,
    close: async () => act(async () => root.unmount()),
    document,
    host,
    root,
    s,
    window,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audioInstances.length = 0;
  mocks.castNeedsVoices.mockReturnValue(false);
  mocks.getPodcast.mockResolvedValue(podcast());
  mocks.groupVoices.mockImplementation((voices: NeuralVoiceInfo[]) => ({
    byLanguage: voices.filter((voice) => !voice.id.includes("Multilingual")).length ? [["Hebrew", [voiceB]]] : [],
    multilingual: voices.filter((voice) => voice.id.includes("Multilingual")),
  }));
  mocks.loadVoiceCatalog.mockResolvedValue([voiceA, voiceB]);
  mocks.previewPodcastVoice.mockResolvedValue("AQID");
  mocks.setPodcastCast.mockImplementation(async (_fileId: string, cast: PodcastHost[]) => podcast({ cast }));
  mocks.startPodcastAudioJob.mockResolvedValue("job-1");
  mocks.suggestDistinctVoices.mockReturnValue([voiceA.id, voiceB.id]);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("PodcastPanel loading states", () => {
  it("shows loading, a read failure, and the no-script recovery guidance", async () => {
    let resolvePodcast: ((value: Podcast | null) => void) | undefined;
    mocks.getPodcast.mockImplementation(() => new Promise((resolve) => { resolvePodcast = resolve; }));
    const loading = await renderPanel();
    expect(loading.host.textContent).toContain("Loading the script…");
    resolvePodcast?.(podcast());
    await flush();
    expect(loading.host.textContent).toContain("A private episode");
    await loading.close();

    mocks.getPodcast.mockRejectedValue(new Error("database offline"));
    const failed = await renderPanel();
    expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain("database offline");
    await failed.close();

    mocks.getPodcast.mockResolvedValue(null);
    const absent = await renderPanel();
    expect(absent.host.textContent).toContain("has no script attached");
    await absent.close();
  });

  it("states privacy, offline, saved-voice, and catalog failure conditions without hiding the script", async () => {
    mocks.getPodcast.mockResolvedValue(podcast({ audioFileId: "recording-1", cast: [host("Ada", "retired-voice")] }));
    mocks.loadVoiceCatalog.mockRejectedValue(new Error("offline"));
    const s = workspaceState({ privacyOn: true, webOn: false });
    const a = workspaceActions();
    const view = await renderPanel({ a, s });

    expect(view.host.textContent).toContain("privacy door is on");
    expect(view.host.textContent).toContain("This room is offline");
    expect(view.host.textContent).toContain("voice list couldn't be loaded");
    expect((aria(view, "Voice for Ada") as HTMLSelectElement).textContent).toContain("saved voice");
    expect(button(view, "Suggest voices").disabled).toBe(true);
    expect(button(view, "Record again").disabled).toBe(true);
    await click(button(view, "Open the recording"));
    expect(a.viewFile).toHaveBeenCalledWith("recording-1");
    await view.close();
  });
});

describe("PodcastPanel cast and recording actions", () => {
  it("suggests, edits, trims and saves the cast before recording", async () => {
    const s = workspaceState();
    const a = workspaceActions();
    const view = await renderPanel({ a, s });

    mocks.suggestDistinctVoices.mockReturnValue([voiceB.id, voiceA.id]);
    await click(button(view, "Suggest voices"));
    expect(mocks.suggestDistinctVoices).toHaveBeenLastCalledWith([voiceA, voiceB], 2);
    expect(button(view, "Save cast").disabled).toBe(false);
    expect(button(view, "Record the episode").disabled).toBe(true);
    await change(aria(view, "Host 1 name") as HTMLInputElement, " Ada ");
    await change(aria(view, "Speaking speed for  Ada ") as HTMLSelectElement, "+15%");
    await change(aria(view, "Pitch for  Ada ") as HTMLSelectElement, "+6Hz");
    await change(aria(view, "Voice for  Ada ") as HTMLSelectElement, voiceB.id);
    await click(button(view, "Save cast"));

    expect(mocks.setPodcastCast).toHaveBeenCalledWith("script-1", [
      { name: "Ada", pitch: "+6Hz", rate: "+15%", voice: voiceB.id },
      host("Ben", voiceA.id),
    ]);
    expect(button(view, "Saved").disabled).toBe(true);
    expect(button(view, "Record the episode").disabled).toBe(false);
    await click(button(view, "Record the episode"));
    expect(mocks.startPodcastAudioJob).toHaveBeenCalledWith("script-1");
    expect(a.refreshJobs).toHaveBeenCalledOnce();
    expect((s.pushToast as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "info",
      "Recording in the background — the episode opens itself when it's ready.",
    );
    await view.close();
  });

  it("reports cast-save and recording failures", async () => {
    const s = workspaceState();
    const view = await renderPanel({ s });
    await change(aria(view, "Host 1 name") as HTMLInputElement, "Grace");
    mocks.setPodcastCast.mockRejectedValue(new Error("save failed"));
    await click(button(view, "Save cast"));
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: save failed");

    mocks.setPodcastCast.mockResolvedValue(podcast({ cast: [host("Grace", voiceA.id), host("Ben", voiceB.id)] }));
    await click(button(view, "Save cast"));
    mocks.startPodcastAudioJob.mockRejectedValue(new Error("record failed"));
    await click(button(view, "Record the episode"));
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: record failed");
    await view.close();
  });

  it("fills an uncast multi-host script from a loaded catalog without saving it", async () => {
    mocks.getPodcast.mockResolvedValue(podcast({ cast: [host("Ada"), host("Ben")] }));
    mocks.castNeedsVoices.mockReturnValue(true);
    const view = await renderPanel();

    expect(mocks.suggestDistinctVoices).toHaveBeenCalledWith([voiceA, voiceB], 2, undefined);
    expect(button(view, "Save cast").disabled).toBe(false);
    await view.close();
  });
});

describe("PodcastPanel voice previews", () => {
  it("previews an actual host line, stops it, and releases its blob URL", async () => {
    const view = await renderPanel();
    await click(aria(view, "Preview Ada") as HTMLButtonElement);

    expect(mocks.previewPodcastVoice).toHaveBeenCalledWith(
      "Hello from the real script.",
      voiceA.id,
      "",
      "",
    );
    expect(mocks.audioInstances).toHaveLength(1);
    expect(mocks.audioInstances[0].play).toHaveBeenCalledOnce();
    await click(aria(view, "Preview Ada") as HTMLButtonElement);
    expect(mocks.audioInstances[0].pause).toHaveBeenCalledOnce();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    await view.close();
  });

  it("uses a fallback greeting, ignores stale replies, clears on audio end, and reports preview failures", async () => {
    const resolvePreviews: Array<(value: string) => void> = [];
    mocks.getPodcast.mockResolvedValue(podcast({ turns: [{ speaker: "Someone else", line: "Other words" }] }));
    mocks.previewPodcastVoice.mockImplementation(() => new Promise((resolve) => { resolvePreviews.push(resolve); }));
    const s = workspaceState();
    const view = await renderPanel({ s });
    await click(aria(view, "Preview Ada") as HTMLButtonElement);
    await click(aria(view, "Preview Ben") as HTMLButtonElement);
    resolvePreviews[0]("AQID");
    await flush();
    expect(mocks.audioInstances).toHaveLength(0);

    mocks.previewPodcastVoice.mockResolvedValue("AQID");
    await click(aria(view, "Preview Ada") as HTMLButtonElement);
    expect(mocks.previewPodcastVoice).toHaveBeenLastCalledWith("Hello, I'm Ada.", voiceA.id, "", "");
    await act(async () => {
      mocks.audioInstances[0].onended?.();
      await Promise.resolve();
    });
    await flush();
    expect(mocks.audioInstances[0].pause).toHaveBeenCalled();

    mocks.previewPodcastVoice.mockRejectedValue(new Error("speaker unavailable"));
    await click(aria(view, "Preview Ada") as HTMLButtonElement);
    expect(s.pushToast).toHaveBeenCalledWith("error", "Could not play that voice: Error: speaker unavailable");
    await view.close();
  });
});
