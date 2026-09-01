import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatePage } from "./CreatePage";

const { act, createElement } = React;
type TestPicture = { fileId: string; name: string; thumbB64: string };
const picture: TestPicture = { fileId: "picture-1", name: "Harbor", thumbB64: "thumb" };

const mocks = vi.hoisted(() => ({
  api: {
    listCreateModels: vi.fn(),
    startCreateJob: vi.fn(),
    storyPictures: vi.fn(),
    storyPlanSplit: vi.fn(),
  },
  picker: null as null | { onPick: (picture: TestPicture) => void; onClose: () => void },
  story: null as null | { onHandoffUsed: () => void; handoff: string | null },
  attachments: [] as Array<{ onClear: () => void; role: string }>,
}));

vi.mock("../../api", () => ({
  api: mocks.api,
  formatSize: (bytes: number) => `${bytes} B`,
}));
vi.mock("../../icons", () => ({
  CheckIcon: () => null,
  CreateIcon: () => null,
  LockIcon: () => null,
}));
vi.mock("./StoryTab", () => ({
  StoryTab: (props: { handoff: string | null; onHandoffUsed: () => void }) => {
    mocks.story = props;
    return null;
  },
}));
vi.mock("./PicturePicker", () => ({
  PicturePicker: (props: { onPick: (picture: TestPicture) => void; onClose: () => void }) => {
    mocks.picker = props;
    return null;
  },
  Attached: (props: { onClear: () => void; role: string }) => {
    mocks.attachments.push(props);
    return null;
  },
}));

const globalKeys = [
  "document", "window", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement",
  "Event", "React", "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount: () => void }> = [];

function model(overrides: Record<string, unknown> = {}) {
  return {
    model: "remote-image",
    slug: "remote-image",
    label: "Remote Image",
    engine: "cloud",
    engineLabel: "Cloud",
    local: false,
    description: "A capable model",
    image: true,
    video: false,
    outputPrice: null,
    limits: {
      durations: [],
      resolutions: ["1K"],
      aspectRatios: ["1:1"],
      frameImages: [],
      maxReferences: 1,
      generateAudio: false,
    },
    ...overrides,
  };
}

function catalog(models = [model(), model({
  model: "remote-video",
  slug: "remote-video",
  label: "Remote Video",
  image: false,
  video: true,
  limits: {
    durations: [4, 8],
    resolutions: ["720p"],
    aspectRatios: ["16:9"],
    frameImages: ["first_frame"],
    maxReferences: 1,
    generateAudio: true,
  },
}), model({
  model: "words-video",
  slug: "words-video",
  label: "Words Video",
  image: false,
  video: true,
  limits: {
    durations: [],
    resolutions: [],
    aspectRatios: [],
    frameImages: [],
    maxReferences: null,
    generateAudio: false,
  },
})]) {
  return {
    models,
    scanned: models.length + 1,
    excluded: [{ engineLabel: "Text", reason: "text only", count: 1, examples: ["Writer"] }],
    anyProvider: true,
    error: null,
  };
}

function workspace() {
  return {
    jobs: [
      { id: "run", kind: "create", title: "Working picture", status: "running", error: null },
      { id: "queue", kind: "create", title: "Queued picture", status: "queued", error: null },
      { id: "bad", kind: "create", title: "Broken picture", status: "error", error: "provider refused" },
    ],
    jobProgress: { run: { label: "Drawing", done: 0, total: 1 } },
    files: [{
      id: "picture-1", name: "made.png", mimeType: "image/png", sizeBytes: 22, originDestination: "create",
    }],
    newCreationSeq: 0,
    pushToast: vi.fn(),
  } as unknown as Parameters<typeof CreatePage>[0]["s"];
}

function actions() {
  return {
    refreshJobs: vi.fn(async () => {}),
    dismissJob: vi.fn(async () => {}),
    viewFile: vi.fn(async () => {}),
  } as unknown as Parameters<typeof CreatePage>[0]["a"];
}

function resetMocks() {
  Object.values(mocks.api).forEach((fn) => fn.mockReset());
  mocks.picker = null;
  mocks.story = null;
  mocks.attachments = [];
  mocks.api.listCreateModels.mockResolvedValue(catalog());
  mocks.api.startCreateJob.mockResolvedValue(undefined);
  mocks.api.storyPictures.mockResolvedValue([picture]);
  mocks.api.storyPlanSplit.mockResolvedValue({ parts: 2, totalSeconds: 10, shots: [], fromScript: true });
}

beforeEach(() => {
  resetMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
    await Promise.resolve();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function renderCreate(s = workspace(), a = actions()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Vitest" } });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(CreatePage, { s, a }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  roots.push(root);
  return { host, root, s, a };
}

function reactProps<T>(element: Element): T {
  const keys = Object.getOwnPropertyNames(element).filter((name) => name.startsWith("__reactProps"));
  const key = keys[keys.length - 1];
  if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, unknown>)[key] as T;
}

async function call<T>(element: Element, name: string, event?: T) {
  await act(async () => {
    const props = reactProps<Record<string, (event: T) => void>>(element);
    props[name]?.(event as T);
    await Promise.resolve();
  });
}

function button(host: Element, text: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`missing button ${text}`);
  return found;
}

async function click(host: Element, text: string) {
  await call(button(host, text), "onClick");
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CreatePage", () => {
  it("loads the bench, manages creation controls, attachments, and generation", async () => {
    const s = workspace();
    const a = actions();
    const view = await renderCreate(s, a);
    await settle();
    expect(view.host.textContent).toContain("Remote Image");
    expect(view.host.textContent).toContain("Broken picture");
    await click(view.host, "Why the other");
    expect(view.host.textContent).toContain("text only");
    const dismiss = view.host.querySelector('[aria-label="Dismiss this failure"]');
    if (!dismiss) throw new Error("dismiss missing");
    await call(dismiss, "onClick");
    await click(view.host, "made.png");
    const prompt = view.host.querySelector("textarea");
    if (!prompt) throw new Error("prompt missing");
    await call(prompt, "onChange", { target: { value: "a lighthouse" } });
    await click(view.host, "Make it");
    await settle();
    await click(view.host, "4");
    const selects = view.host.querySelectorAll("select");
    await call(selects[1], "onChange", { target: { value: "1:1" } });
    await call(selects[2], "onChange", { target: { value: "1K" } });
    mocks.api.startCreateJob.mockRejectedValueOnce(new Error("payment declined"));
    await click(view.host, "Make 4");
    await settle();
    expect(mocks.api.startCreateJob).toHaveBeenCalledWith(expect.objectContaining({ variations: 4, kind: "image" }));
    expect(a.refreshJobs).toHaveBeenCalled();
    expect(s.pushToast).toHaveBeenCalledWith("error", expect.stringContaining("payment declined"));

    await click(view.host, "Video");
    expect(view.host.textContent).toContain("How long");
    await click(view.host, "4s");
    await click(view.host, "Use a picture");
    mocks.picker?.onPick(picture);
    await settle();
    await click(view.host, "Attach a picture");
    mocks.picker?.onPick(picture);
    await settle();
    expect(view.host.textContent).toContain("Send and make 4");
    mocks.attachments.forEach((attachment) => attachment.onClear());
    await settle();
    await click(view.host, "1");
    const modelSelect = view.host.querySelector(".cr-model-select");
    if (!modelSelect) throw new Error("model selector missing");
    await call(modelSelect, "onChange", { target: { value: "words-video" } });
    expect(view.host.textContent).toContain("takes no starting picture");

    vi.useFakeTimers();
    await call(prompt, "onChange", { target: { value: "x".repeat(400) } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await settle();
    expect(view.host.textContent).toContain("Take it to Story");
    await click(view.host, "Take it to Story");
    await click(view.host, "Story");
    expect(mocks.story).not.toBeNull();
    mocks.story?.onHandoffUsed();
    await act(async () => {
      view.root.render(createElement(CreatePage, { s: { ...s, newCreationSeq: 1 }, a }));
      await Promise.resolve();
    });
  });

  it("uses correct loading, catalogue failure, and empty shelf recovery messages", async () => {
    let resolveCatalog!: (value: ReturnType<typeof catalog>) => void;
    mocks.api.listCreateModels.mockReturnValue(new Promise((resolve) => { resolveCatalog = resolve; }));
    const loading = await renderCreate();
    expect(loading.host.textContent).toContain("Reading what this room");
    await act(async () => resolveCatalog(catalog()));

    mocks.api.listCreateModels.mockRejectedValue(new Error("offline"));
    const unavailable = await renderCreate();
    await settle();
    expect(unavailable.host.textContent).toContain("Could not read the model list");

    mocks.api.listCreateModels.mockResolvedValue({ ...catalog([]), error: "catalogue down" });
    const failed = await renderCreate();
    expect(failed.host.textContent).toContain("Connected, but the catalogue would not load");

    mocks.api.listCreateModels.mockResolvedValue({ ...catalog([]), anyProvider: false });
    const none = await renderCreate();
    expect(none.host.textContent).toContain("No provider is connected");

    mocks.api.listCreateModels.mockResolvedValue(catalog([]));
    const unsupported = await renderCreate();
    expect(unsupported.host.textContent).toContain("Nothing here can draw");
  });

  it("filters a large model shelf and shows an empty video canvas", async () => {
    const many = Array.from({ length: 9 }, (_, index) => model({
      model: `model-${index}`,
      slug: `model-${index}`,
      label: `Model ${index}`,
    }));
    mocks.api.listCreateModels.mockResolvedValue(catalog(many));
    const emptyState = workspace() as unknown as { files: unknown[] };
    emptyState.files = [];
    const view = await renderCreate(emptyState as Parameters<typeof CreatePage>[0]["s"]);
    const filter = view.host.querySelector('[aria-label="Filter models by name"]');
    if (!filter) throw new Error("model filter missing");
    await call(filter, "onChange", { target: { value: "Model 8" } });
    expect(view.host.textContent).toContain("Model 8");
    await click(view.host, "Video");
    expect(view.host.textContent).toContain("Describe a clip on the right");
  });
});
