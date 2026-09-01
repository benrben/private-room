import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "../api";
import type { ViewerContext } from "./registry";

const mocks = vi.hoisted(() => ({
  sheetProps: null as null | Record<string, unknown>,
  audioProps: null as null | Record<string, unknown>,
  subtitleProps: null as null | Record<string, unknown>,
}));

vi.mock("./EmailView", () => ({ default: () => null }));
vi.mock("./AudioView", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.audioProps = props;
    return null;
  },
}));
vi.mock("./HtmlView", () => ({ default: () => null }));
vi.mock("./ImageView", () => ({ default: () => null }));
vi.mock("./JsonView", () => ({ default: () => null }));
vi.mock("./LogView", () => ({ default: () => null }));
vi.mock("./MarkdownView", () => ({ default: () => null }));
vi.mock("./OfficeDocView", () => ({ default: () => null }));
vi.mock("./ProseView", () => ({ default: () => null }));
vi.mock("./QuickLookView", () => ({ default: () => null }));
vi.mock("./SubtitleView", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.subtitleProps = props;
    return null;
  },
}));
vi.mock("./SvgView", () => ({ default: () => null }));
vi.mock("../workspace/TextView", () => ({ default: () => null }));
vi.mock("./SheetView", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.sheetProps = props;
    return null;
  },
}));
vi.mock("./languages", () => ({ languageForFile: () => "plaintext" }));

import { coveredKinds, FORMATS, editModeOf, makeLazyViewers } from "./registry";

const { act, createElement, Suspense } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function content(name: string): FileContent {
  return {
    kind: "sheet",
    name,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    editable: false,
    text: null,
    dataB64: "fabricated-bytes",
    mediaToken: "fabricated-media-token",
    mediaMeta: null,
    webMeta: null,
  };
}

function context(sheet: FileContent, target: ViewerContext["target"] = {}): ViewerContext {
  return {
    fileId: "sheet-file",
    content: sheet,
    target,
    viewerRev: 1,
    lazy: makeLazyViewers(),
    editCell: vi.fn(async () => {}),
    saveEdit: vi.fn(async () => true),
    recording: {
      live: null,
      saveProgress: null,
      pushToast: vi.fn(),
      onStart: vi.fn(async () => {}),
      onPause: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
      onStop: vi.fn(async () => {}),
    },
  };
}

async function renderSheet(viewerContext: ViewerContext) {
  return renderFormat("sheet", viewerContext);
}

async function renderFormat(kind: "sheet" | "audio" | "video" | "subtitle", viewerContext: ViewerContext) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const render = async (next: ViewerContext) => {
    mocks.sheetProps = null;
    mocks.audioProps = null;
    mocks.subtitleProps = null;
    await act(async () => root.render(createElement(Suspense, { fallback: createElement("span", null, "Loading viewer") }, FORMATS[kind].render(next))));
    await vi.dynamicImportSettled();
  };
  await render(viewerContext);
  return { root, render };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("sheet viewer registry", () => {
  it("offers grid editing only for workbook formats the cell writer can preserve", () => {
    expect(editModeOf(content("Budget.XLSX"))).toBe("grid");
    expect(editModeOf(content("Archive.XLS"))).toBeNull();
    expect(editModeOf(content("Exchange.ods"))).toBeNull();
  });

  it("routes sheet content and targets to a mocked lazy grid with the exact read-only policy", async () => {
    const view = await renderSheet(context(content("Budget.xlsx"), { sheet: "Forecast", cell: "C7" }));
    expect(mocks.sheetProps).toMatchObject({
      mediaToken: "fabricated-media-token",
      dataB64: "fabricated-bytes",
      target: { sheet: "Forecast", range: "C7" },
      readOnlyReason: undefined,
    });

    await view.render(context(content("Archive.xls"), { sheet: "Sheet1", range: "A1:B2", cell: "D4" }));
    expect(mocks.sheetProps?.target).toEqual({ sheet: "Sheet1", range: "A1:B2" });
    expect(mocks.sheetProps?.readOnlyReason).toContain("legacy Excel 97–2003");
    expect(mocks.sheetProps?.readOnlyReason).toContain("save it as .xlsx");

    await view.render(context(content("Exchange.ODS")));
    expect(mocks.sheetProps?.readOnlyReason).toContain("OpenDocument spreadsheet");
    expect(mocks.sheetProps?.readOnlyReason).toContain("Save it as .xlsx");
    await act(async () => view.root.unmount());
  });
});

describe("media viewer registry", () => {
  it("passes audio and video content through the mocked lazy view with the correct status policy", async () => {
    const audio = {
      ...content("meeting.m4a"),
      kind: "audio" as const,
      mime: "audio/mp4",
      dataB64: null,
      text: "[00:01] Fabricated transcript",
    };
    const audioView = await renderFormat("audio", context(audio, { quote: "Fabricated" }));
    expect(mocks.audioProps).toMatchObject({
      kind: "audio",
      fileId: "sheet-file",
      mime: "audio/mp4",
      dataB64: "",
      mediaToken: "fabricated-media-token",
      text: "[00:01] Fabricated transcript",
      target: { quote: "Fabricated" },
      transcribing: false,
      sttStage: undefined,
    });

    const queuedAudio = context({ ...audio, dataB64: "fabricated-audio" }, { find: "fallback" });
    queuedAudio.sttStatus = { "meeting.m4a": "queued" };
    await audioView.render(queuedAudio);
    expect(mocks.audioProps).toMatchObject({
      dataB64: "fabricated-audio",
      target: { quote: "fallback" },
      transcribing: false,
      sttStage: "queued",
    });

    const video = {
      ...content("clip.mp4"),
      kind: "video" as const,
      mime: "video/mp4",
      mediaMeta: {
        durationSecs: 12,
        width: 1280,
        height: 720,
        videoCodec: "h264",
        frameRate: 30,
        bitrateKbps: 1200,
        hasAudio: true,
        audioCodec: "aac",
      },
    };
    const videoContext = context(video, { find: "scene" });
    videoContext.sttStatus = { "clip.mp4": "processing" };
    const videoView = await renderFormat("video", videoContext);
    expect(mocks.audioProps).toMatchObject({
      kind: "video",
      fileId: "sheet-file",
      mime: "video/mp4",
      mediaToken: "fabricated-media-token",
      mediaMeta: { durationSecs: 12, width: 1280, height: 720 },
      text: null,
      target: { quote: "scene" },
      transcribing: true,
      sttStage: "processing",
    });

    const unavailableVideo = context({ ...video, dataB64: null });
    unavailableVideo.target = undefined;
    await videoView.render(unavailableVideo);
    expect(mocks.audioProps).toMatchObject({
      dataB64: "",
      target: { quote: undefined },
      transcribing: false,
      sttStage: undefined,
    });

    await act(async () => audioView.root.unmount());
    await act(async () => videoView.root.unmount());
  });
});

describe("subtitle viewer registry", () => {
  it("passes editable subtitle text, name, and save callback to the subtitle viewer", async () => {
    const saveEdit = vi.fn(async (text: string) => text === "00:00:02.000 --> 00:00:04.000");
    const subtitle = {
      ...content("captions.vtt"),
      kind: "subtitle" as const,
      mime: "text/vtt",
      editable: true,
      text: "00:00:00.000 --> 00:00:02.000\nFabricated caption",
    };
    const viewerContext = context(subtitle);
    viewerContext.saveEdit = saveEdit;
    const view = await renderFormat("subtitle", viewerContext);

    expect(mocks.subtitleProps).toMatchObject({
      name: "captions.vtt",
      text: "00:00:00.000 --> 00:00:02.000\nFabricated caption",
      onSave: saveEdit,
    });
    const onSave = mocks.subtitleProps?.onSave;
    if (typeof onSave !== "function") throw new Error("editable subtitle save callback missing");
    await expect(onSave("00:00:02.000 --> 00:00:04.000")).resolves.toBe(true);
    expect(saveEdit).toHaveBeenCalledWith("00:00:02.000 --> 00:00:04.000");
    await act(async () => view.root.unmount());
  });

  it("keeps a read-only subtitle viewer from receiving a save callback", async () => {
    const subtitle = {
      ...content("locked.srt"),
      kind: "subtitle" as const,
      mime: "application/x-subrip",
      editable: false,
      text: null,
    };
    const viewerContext = context(subtitle);
    const view = await renderFormat("subtitle", viewerContext);

    expect(mocks.subtitleProps).toEqual({ name: "locked.srt", text: "", onSave: undefined });
    expect(viewerContext.saveEdit).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });
});

describe("remaining viewer registry routes", () => {
  it("constructs every specialized viewer with the file and navigation context it owns", () => {
    Reflect.set(globalThis, "React", React);
    const base = content("report.md");
    const viewerContext = context(
      { ...base, text: "Visible text", editable: true, derivedPreview: { status: "ready" } as never },
      { page: 3, quote: "quoted", find: "fallback", sheet: "Plan", cell: "B4" },
    );

    const kinds = [
      "image",
      "pdf",
      "docx",
      "worddoc",
      "csv",
      "slides",
      "book",
      "archive",
      "markdown",
      "sketch",
      "email",
      "prose",
      "code",
      "recording",
    ] as const;
    const rendered = kinds.map((kind) => FORMATS[kind].render(viewerContext));

    expect(rendered.every(React.isValidElement)).toBe(true);
    const elements = rendered.map((node) => {
      if (!React.isValidElement<Record<string, unknown>>(node)) {
        throw new Error("format renderer did not return a React element");
      }
      return node;
    });
    expect(elements[0]?.props).toMatchObject({
      fileId: "sheet-file",
      name: "report.md",
      text: "Visible text",
    });
    expect(elements[1]?.props.target).toEqual({ page: 3, quote: "quoted" });
    expect(elements[2]?.props.target).toEqual({ quote: "quoted" });
    expect(elements[4]?.props.target).toEqual({ sheet: "Plan", range: "B4" });
    expect(elements[12]?.props).toMatchObject({ value: "Visible text", language: "plaintext", readOnly: true });
    expect(elements[13]?.props).toMatchObject({
      fileId: "sheet-file",
      pushToast: viewerContext.recording.pushToast,
      onStop: viewerContext.recording.onStop,
    });
  });

  it("selects text or Quick Look for the catch-all route and reports the complete registry", () => {
    Reflect.set(globalThis, "React", React);
    const textContext = context({ ...content("notes.rtf"), kind: "text", text: "Readable copy" });
    const text = FORMATS.text.render(textContext);
    const quickLook = FORMATS.text.render({
      ...textContext,
      content: { ...textContext.content, text: null },
    });

    expect(text).toMatchObject({ props: { text: "Readable copy" } });
    expect(quickLook).toMatchObject({ props: { fileId: "sheet-file" } });
    expect(coveredKinds()).toEqual(Object.keys(FORMATS).sort());
  });
});
