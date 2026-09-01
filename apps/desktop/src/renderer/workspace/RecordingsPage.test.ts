import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileMeta, RoomInfo } from "../api";
import type { WSActions } from "./actions";
import type { WSState } from "./state";
import {
  attentionReason,
  captureDetail,
  captureNow,
  saveDetail,
  shelfChip,
  transcribedPhrase,
} from "./RecordingsPage";

vi.mock("../api", () => ({
  formatSize: (size: number) => `${size} B`,
  isRecordingFile: (file: FileMeta) => file.mimeType.startsWith("audio/"),
}));
vi.mock("./composer", () => ({
  displayName: (name: string) => `shown ${name}`,
  formatWhen: (when: string) => `when ${when}`,
}));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function file(
  id: string,
  {
    hasText = false,
    createdAt = "2026-08-31T12:00:00.000Z",
  }: Partial<Pick<FileMeta, "hasText" | "createdAt">> = {},
): FileMeta {
  return {
    id,
    name: `${id}.m4a`,
    mimeType: "audio/mp4",
    sizeBytes: 10,
    source: "recording",
    hasText,
    createdAt,
    folderId: null,
    partiallyIndexed: false,
    aiSummary: null,
    originDestination: "recordings",
    libraryVisibility: "linked",
  };
}

function state(overrides: Record<string, unknown> = {}): WSState {
  return {
    files: [],
    recLive: null,
    recSave: null,
    sttStatus: {},
    openFile: null,
    ...overrides,
  } as unknown as WSState;
}

function actions(): WSActions {
  return {
    startLiveRecording: vi.fn(),
    viewFile: vi.fn(),
  } as unknown as WSActions;
}

async function render(workspace = state(), workspaceActions = actions()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const [{ createRoot }, { default: RecordingsPage }] = await Promise.all([
    import("react-dom/client"),
    import("./RecordingsPage"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(RecordingsPage, {
      s: workspace,
      a: workspaceActions,
      info: {} as RoomInfo,
    }));
    await Promise.resolve();
  });
  return { host, close: async () => act(async () => root.unmount()), workspaceActions };
}

function reactClick(element: Element) {
  const propKey = Object.keys(element).find((key) => key.startsWith("__reactProps"));
  if (!propKey) throw new Error("React props missing");
  const props = (element as unknown as Record<string, Record<string, () => void>>)[propKey];
  props.onClick();
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("RecordingsPage", () => {
  it("offers the single empty-shelf capture action", async () => {
    const workspaceActions = actions();
    const view = await render(state(), workspaceActions);
    const button = view.host.querySelector("button");
    if (!button) throw new Error("capture action missing");
    expect(button.textContent).toContain("Start a live recording");
    reactClick(button);
    expect(workspaceActions.startLiveRecording).toHaveBeenCalledOnce();
    await view.close();
  });

  it("keeps live work, transcript attention, and overflow visible without duplicating the active tape", async () => {
    const current = file("current", { createdAt: "2026-08-31T13:00:00.000Z" });
    const waiting = Array.from({ length: 6 }, (_, index) => file(`waiting-${index}`, {
      createdAt: `2026-08-${String(30 - index).padStart(2, "0")}T12:00:00.000Z`,
    }));
    const converting = file("converting", { createdAt: "2026-08-20T12:00:00.000Z" });
    const anotherConverting = file("converting-2", { createdAt: "2026-08-19T12:00:00.000Z" });
    const workspace = state({
      files: [current, ...waiting, converting, anotherConverting],
      recLive: { fileId: current.id, status: "recording" },
      sttStatus: {
        [converting.name]: "processing",
        [anotherConverting.name]: "processing",
        [waiting[0].name]: "failed: unreadable container",
      },
    });
    const workspaceActions = actions();
    const view = await render(workspace, workspaceActions);
    expect(view.host.textContent).toContain("Recording now");
    expect(view.host.textContent).toContain("Writing up");
    expect(view.host.textContent).toContain("Waiting on a transcript");
    expect(view.host.textContent).toContain("1 more are waiting too");
    expect(view.host.textContent).not.toContain("Most recent");
    const open = [...view.host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Open the recording"),
    );
    if (!open) throw new Error("live recording action missing");
    reactClick(open);
    expect(workspaceActions.viewFile).toHaveBeenCalledWith(current.id);
    const attention = [...view.host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("shown waiting-0.m4a"),
    );
    if (!attention) throw new Error("attention recording card missing");
    reactClick(attention);
    expect(workspaceActions.viewFile).toHaveBeenCalledWith(waiting[0].id);
    await view.close();
  });

  it("shows one finished newest recording and its transcribed shelf total", async () => {
    const newest = file("newest", { hasText: true, createdAt: "2026-08-31T14:00:00.000Z" });
    const older = file("older", { hasText: true, createdAt: "2026-08-30T14:00:00.000Z" });
    const workspaceActions = actions();
    const view = await render(state({ files: [older, newest] }), workspaceActions);
    expect(view.host.textContent).toContain("2");
    expect(view.host.textContent).toContain("transcribed — all of them");
    expect(view.host.textContent).toContain("Most recent");
    expect(view.host.textContent).toContain("shown newest.m4a");
    const card = [...view.host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("shown newest.m4a"),
    );
    if (!card) throw new Error("newest recording card missing");
    reactClick(card);
    expect(workspaceActions.viewFile).toHaveBeenCalledWith(newest.id);
    await view.close();
  });

  it("keeps every capture, transcript, and shelf-status decision explicit", () => {
    const sample = file("sample");
    const saving = { stage: "transcribing" as const, remaining: 2, startedAt: "now" };
    expect(captureNow(null, null)).toBeNull();
    expect(captureNow({ fileId: sample.id, status: "saving" }, null)).toMatchObject({ phase: "saving" });
    expect(captureNow({ fileId: sample.id, status: "paused" }, null)).toMatchObject({ phase: "paused" });
    expect(captureNow({ fileId: sample.id, status: "recording" }, saving)).toMatchObject({ phase: "saving" });
    expect(saveDetail({ ...saving, stage: "writing" })).toContain("writing into the room");
    expect(saveDetail(saving)).toContain("2 to go");
    expect(saveDetail({ ...saving, remaining: 0 })).toContain("finishing the transcript");
    expect(captureDetail("paused", null)).toContain("microphone is closed");
    expect(captureDetail("saving", saving)).toContain("2 to go");
    expect(shelfChip(sample, { phase: "recording", fileId: sample.id }, undefined)).toMatchObject({
      word: "Recording now",
      loud: true,
    });
    expect(shelfChip(sample, null, "processing").word).toBe("Writing up");
    expect(shelfChip({ ...sample, hasText: true }, null, undefined).word).toBe("Transcribed");
    expect(shelfChip(sample, null, undefined).word).toBe("No transcript yet");
    expect(attentionReason({ ...sample, hasText: true }, undefined, null)).toBeNull();
    expect(attentionReason(sample, "model-missing", null)).toBe("model-missing");
    expect(attentionReason(sample, "none", null)).toBe("no-speech");
    expect(transcribedPhrase({ count: 3, transcribed: 1, bytes: 30 })).toBe("transcribed of 3");
  });
});
