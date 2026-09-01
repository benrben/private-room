import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CastMember,
  CreateModel,
  StoryBoard,
  StoryList,
  StoryShot,
} from "../../api";

const mocks = vi.hoisted(() => ({
  review: { send: null as null | (() => void) },
  api: {
    startShotListJob: vi.fn(),
    storyAddCast: vi.fn(),
    storyAddCastMany: vi.fn(),
    storyAddShot: vi.fn(),
    storyApplySplit: vi.fn(),
    storyBoard: vi.fn(),
    storyCreateList: vi.fn(),
    storyPictures: vi.fn(),
    storyPlanSplit: vi.fn(),
    storyReadCastFile: vi.fn(),
    storyRemoveCast: vi.fn(),
    storyRemoveShot: vi.fn(),
    storySetFace: vi.fn(),
    storySetShape: vi.fn(),
    storyTextFromFile: vi.fn(),
    storyUpdateCast: vi.fn(),
    storyUpdateList: vi.fn(),
    storyUpdateShot: vi.fn(),
  },
}));

vi.mock("../../api", () => ({ api: mocks.api }));
vi.mock("../../icons", () => ({
  CheckIcon: () => null,
  CreateIcon: () => null,
}));
vi.mock("./DocumentPicker", () => ({
  DocumentPicker: ({
    open,
    title,
    onClose,
    onPick,
  }: {
    open: boolean;
    title: string;
    onClose: () => void;
    onPick: (document: { fileId: string; name: string }) => void;
  }) =>
    open
      ? createElement(
          "div",
          null,
          createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                onPick({ fileId: "doc-1", name: `${title} file` });
                onClose();
              },
            },
            `Pick ${title}`,
          ),
          createElement(
            "button",
            { type: "button", onClick: onClose },
            `Close ${title}`,
          ),
        )
      : null,
}));
vi.mock("./PicturePicker", () => ({
  PicturePicker: ({
    open,
    onClose,
    onPick,
  }: {
    open: boolean;
    onClose: () => void;
    onPick: (picture: {
      fileId: string;
      name: string;
      thumbB64: string;
    }) => void;
  }) =>
    open
      ? createElement(
          "div",
          null,
          createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                onPick({
                  fileId: "picture-2",
                  name: "Mira",
                  thumbB64: "thumb",
                });
                onClose();
              },
            },
            "Pick a picture",
          ),
          createElement(
            "button",
            { type: "button", onClick: onClose },
            "Close picture",
          ),
        )
      : null,
}));
vi.mock("./FilmReview", () => ({
  FilmReview: ({
    kind,
    onClose,
    onSend,
  }: {
    kind: string;
    onClose: () => void;
    onSend: () => void;
  }) => {
    mocks.review.send = onSend;
    return createElement(
      "div",
      { "data-review": kind },
      createElement(
        "button",
        { type: "button", onClick: onSend },
        "Send review",
      ),
      createElement(
        "button",
        { type: "button", onClick: onClose },
        "Close review",
      ),
    );
  },
}));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function model(overrides: Partial<CreateModel> = {}): CreateModel {
  return {
    model: "model",
    slug: "Model",
    label: "Model",
    engine: "local",
    engineLabel: "Local",
    local: true,
    description: null,
    image: false,
    video: false,
    outputPrice: null,
    limits: null,
    ...overrides,
  };
}

function list(overrides: Partial<StoryList> = {}): StoryList {
  return {
    id: "list-1",
    title: "Episode one",
    logline: "A return to the harbour",
    aspectRatio: "",
    stillResolution: "",
    clipResolution: "",
    shotCount: 2,
    updatedAt: "now",
    ...overrides,
  };
}

function cast(overrides: Partial<CastMember> = {}): CastMember {
  return {
    id: "cast-1",
    name: "Mira",
    description: "grey coat",
    story: "lost ship",
    faceFileId: "picture-1",
    ord: 0,
    ...overrides,
  };
}

function shot(overrides: Partial<StoryShot> = {}): StoryShot {
  return {
    id: "shot-1",
    listId: "list-1",
    ord: 0,
    action: "Mira walks home",
    castIds: ["cast-1"],
    seconds: 8,
    imageModel: "image-1",
    videoModel: "video-1",
    stillFileId: "still-1",
    clipFileId: "clip-1",
    ...overrides,
  };
}

function board(overrides: Partial<StoryBoard> = {}): StoryBoard {
  return {
    cast: [
      cast(),
      cast({ id: "cast-2", name: "Jon", faceFileId: null, ord: 1 }),
    ],
    lists: [list()],
    shots: [
      shot(),
      shot({
        id: "shot-2",
        ord: 1,
        action: "Jon waits",
        videoModel: "video-2",
        seconds: null,
      }),
    ],
    selected: "list-1",
    ...overrides,
  };
}

const models = [
  model({
    model: "image-1",
    slug: "Painter",
    image: true,
    limits: {
      durations: [],
      resolutions: ["1K", "2K"],
      aspectRatios: ["16:9", "1:1"],
      frameImages: [],
      maxReferences: 2,
      generateAudio: false,
    },
  }),
  model({
    model: "video-1",
    slug: "Camera",
    video: true,
    limits: {
      durations: [4, 8],
      resolutions: ["720p", "1080p"],
      aspectRatios: ["16:9"],
      frameImages: ["first_frame", "last_frame"],
      maxReferences: 1,
      generateAudio: false,
    },
  }),
  model({
    model: "video-2",
    slug: "No frame camera",
    video: true,
    limits: {
      durations: [6],
      resolutions: ["720p"],
      aspectRatios: ["9:16"],
      frameImages: [],
      maxReferences: null,
      generateAudio: false,
    },
  }),
  model({
    model: "video-3",
    slug: "Another no frame camera",
    video: true,
    limits: {
      durations: [10],
      resolutions: ["480p"],
      aspectRatios: ["4:3"],
      frameImages: [],
      maxReferences: null,
      generateAudio: false,
    },
  }),
];

let currentBoard = board();

beforeEach(() => {
  currentBoard = board();
  mocks.review.send = null;
  for (const value of Object.values(mocks.api)) value.mockReset();
  mocks.api.startShotListJob.mockResolvedValue({
    jobIds: ["job-1", "job-2"],
    asked: 2,
    shortfall: null,
  });
  mocks.api.storyAddCast.mockResolvedValue(cast());
  mocks.api.storyAddCastMany.mockResolvedValue(1);
  mocks.api.storyAddShot.mockResolvedValue(shot());
  mocks.api.storyApplySplit.mockResolvedValue(2);
  mocks.api.storyBoard.mockImplementation(async () => currentBoard);
  mocks.api.storyCreateList.mockResolvedValue("list-2");
  mocks.api.storyPictures.mockResolvedValue([
    { fileId: "picture-1", name: "Mira", thumbB64: "thumb" },
  ]);
  mocks.api.storyPlanSplit.mockResolvedValue({
    parts: 2,
    totalSeconds: 16,
    shots: [
      { action: "Mira enters", seconds: 8 },
      { action: "Jon looks up", seconds: 8 },
    ],
    fromScript: false,
  });
  mocks.api.storyReadCastFile.mockResolvedValue({
    name: "cast sheet",
    found: [{ name: "Lena", description: "red scarf", story: "returns" }],
    readBy: "local reader",
    fellBack: null,
  });
  mocks.api.storyRemoveCast.mockResolvedValue(undefined);
  mocks.api.storyRemoveShot.mockResolvedValue(undefined);
  mocks.api.storySetFace.mockResolvedValue(undefined);
  mocks.api.storySetShape.mockResolvedValue(undefined);
  mocks.api.storyTextFromFile.mockResolvedValue("A script from the room.");
  mocks.api.storyUpdateCast.mockResolvedValue(undefined);
  mocks.api.storyUpdateList.mockResolvedValue(undefined);
  mocks.api.storyUpdateShot.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

type StoryProps = { handoff?: string | null };
type View = Awaited<ReturnType<typeof renderStory>>;

async function renderStory(initial: StoryProps = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLSelectElement", window.HTMLSelectElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const [{ createRoot }, { StoryTab }] = await Promise.all([
    import("react-dom/client"),
    import("./StoryTab"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const pushToast = vi.fn();
  const refreshJobs = vi.fn().mockResolvedValue(undefined);
  const viewFile = vi.fn();
  const onHandoffUsed = vi.fn();
  const draw = async (next: StoryProps = initial) => {
    await act(async () => {
      root.render(
        createElement(StoryTab, {
          s: { pushToast } as never,
          a: { refreshJobs, viewFile } as never,
          models,
          onHandoffUsed,
          ...next,
        }),
      );
      await Promise.resolve();
    });
  };
  await draw();
  await flush();
  return {
    close: async () => act(async () => root.unmount()),
    document,
    draw,
    host,
    onHandoffUsed,
    pushToast,
    refreshJobs,
    viewFile,
    window,
  };
}

function reactProp(
  element: Element,
  name: string,
): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps"),
  );
  if (!key) throw new Error(`React prop ${name} missing`);
  return (
    element as unknown as Record<
      string,
      Record<string, (event: Record<string, unknown>) => void>
    >
  )[key][name];
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () => {
    reactProp(
      element,
      name,
    )({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    });
    await Promise.resolve();
  });
  await flush();
}

function button(view: View, text: string): HTMLButtonElement {
  const found = [...view.host.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === text ||
      candidate.textContent?.trim().startsWith(text) ||
      candidate.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
  if (!found)
    throw new Error(`button ${text} missing: ${view.host.textContent}`);
  return found;
}

async function click(view: View, text: string) {
  const found = button(view, text);
  await invoke(found);
  return found;
}

function field(
  view: View,
  label: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const found =
    view.host.querySelector(`[aria-label="${label}"]`) ??
    view.host.querySelector(`#${label}`);
  if (!found) throw new Error(`field ${label} missing`);
  return found as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

async function change(element: Element, value: string) {
  await invoke(element, "onChange", { target: { value } });
}

describe("StoryTab", () => {
  it("reports board failures and creates a first list without losing a handed-off script", async () => {
    mocks.api.storyBoard.mockRejectedValueOnce(new Error("offline"));
    const failed = await renderStory();
    expect(failed.host.textContent).toContain(
      "Could not read this room’s story",
    );
    expect(failed.host.textContent).toContain("offline");
    await failed.close();

    currentBoard = board({ lists: [], shots: [], selected: null });
    const plain = await renderStory();
    expect(plain.host.textContent).toContain("Each line becomes a picture");
    expect(button(plain, "Start one")).toBeTruthy();
    await plain.close();

    const view = await renderStory({ handoff: "A long scene" });
    expect(view.host.textContent).toContain("Your script is waiting");
    await click(view, "Start a list from your script");
    expect(mocks.api.storyCreateList).toHaveBeenCalledWith("Untitled", "");
    expect(mocks.api.storyBoard).toHaveBeenCalledWith("list-2");
    await view.close();
  });

  it("edits cast members, reads a sheet for review, and keeps picked faces", async () => {
    const view = await renderStory();
    expect(view.host.textContent).toContain("2 people");
    await click(view, "Read them from a file in this room");
    await click(view, "Pick Which file describes them?");
    expect(mocks.api.storyReadCastFile).toHaveBeenCalledWith("doc-1");
    await change(field(view, "Name of person 1"), "Lena revised");
    await change(field(view, "What person 1 looks like"), "green scarf");
    await change(field(view, "Story of person 1"), "waits");
    await click(view, "Not a person");
    await click(view, "Keep them");
    await click(view, "Add 1 person");
    expect(mocks.api.storyAddCastMany).toHaveBeenCalledWith([
      { name: "Lena revised", description: "green scarf", story: "waits" },
    ]);

    await click(view, "Add someone");
    await click(view, "Cancel");
    await click(view, "Add someone");
    await change(field(view, "hero-name"), "Nia");
    await change(field(view, "hero-desc"), "blue coat");
    await change(field(view, "hero-story"), "found a map");
    await click(view, "Add them");
    expect(mocks.api.storyAddCast).toHaveBeenCalledWith(
      "Nia",
      "blue coat",
      "found a map",
    );

    const firstHero = view.host.querySelector(".cr-hero");
    if (!firstHero) throw new Error("hero missing");
    const face = firstHero.querySelector(".cr-hero-face");
    if (!face) throw new Error("face button missing");
    await invoke(face);
    await click(view, "Close picture");
    await invoke(face);
    await click(view, "Pick a picture");
    expect(mocks.api.storySetFace).toHaveBeenCalledWith("cast-1", "picture-2");

    await click(view, "Edit");
    await click(view, "Cancel");
    await click(view, "Edit");
    await change(field(view, "hero-name"), "Mira changed");
    await click(view, "Save");
    expect(mocks.api.storyUpdateCast).toHaveBeenCalledWith(
      "cast-1",
      "Mira changed",
      "grey coat",
      "lost ship",
    );
    await click(view, "Clear face");
    expect(mocks.api.storySetFace).toHaveBeenCalledWith("cast-1", null);
    await click(view, "Remove");
    expect(mocks.api.storyRemoveCast).toHaveBeenCalledWith("cast-1");
    await view.close();
  });

  it("edits lists and shots, uses model limits, opens generated files, and starts reviewed runs", async () => {
    const view = await renderStory();
    await change(field(view, "Shot list title"), "New episode");
    await invoke(field(view, "Shot list title"), "onBlur");
    expect(mocks.api.storyUpdateList).toHaveBeenCalledWith(
      "list-1",
      "New episode",
      "A return to the harbour",
    );
    await change(field(view, "Logline"), "A storm returns");
    await invoke(field(view, "Logline"), "onBlur");
    expect(mocks.api.storyUpdateList).toHaveBeenLastCalledWith(
      "list-1",
      "New episode",
      "A storm returns",
    );

    const shapeFields = view.host.querySelectorAll(".cr-shape select");
    await change(shapeFields[0], "2K");
    await change(shapeFields[1], "720p");
    expect(mocks.api.storySetShape).toHaveBeenNthCalledWith(1, {
      id: "list-1",
      aspectRatio: "",
      stillResolution: "2K",
      clipResolution: "",
    });
    expect(mocks.api.storySetShape).toHaveBeenNthCalledWith(2, {
      id: "list-1",
      aspectRatio: "",
      stillResolution: "",
      clipResolution: "720p",
    });

    await change(field(view, "Shot 1"), "Mira runs");
    await invoke(field(view, "Shot 1"), "onBlur");
    expect(mocks.api.storyUpdateShot).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "shot-1", action: "Mira runs" }),
    );
    await click(view, "Mira");
    await change(view.host.querySelectorAll(".cr-shot-knobs select")[0], "");
    await change(
      view.host.querySelectorAll(".cr-shot-knobs select")[1],
      "video-1",
    );
    await change(
      view.host.querySelectorAll(".cr-shot-knobs select")[1],
      "video-2",
    );
    await change(view.host.querySelectorAll(".cr-shot-knobs select")[2], "6");
    await change(view.host.querySelectorAll(".cr-shot-knobs select")[1], "");
    await change(view.host.querySelectorAll(".cr-shot-knobs select")[2], "");
    expect(mocks.api.storyUpdateShot).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "shot-1",
        videoModel: "video-2",
        seconds: null,
      }),
    );
    await click(view, "Open the picture");
    await click(view, "Open the clip");
    expect(view.viewFile).toHaveBeenNthCalledWith(1, "still-1");
    expect(view.viewFile).toHaveBeenNthCalledWith(2, "clip-1");
    const removeShot = view.host.querySelector('[aria-label="Remove shot 1"]');
    if (!removeShot) throw new Error("remove shot button missing");
    await invoke(removeShot);
    expect(mocks.api.storyRemoveShot).toHaveBeenCalledWith("shot-1");

    await change(field(view, "A new shot"), "A boat appears");
    await click(view, "Add shot");
    expect(mocks.api.storyAddShot).toHaveBeenCalledWith(
      "list-1",
      "A boat appears",
    );
    await click(view, "Draw them");
    await click(view, "Send review");
    expect(mocks.api.startShotListJob).toHaveBeenCalledWith(
      "list-1",
      "image",
      true,
    );
    expect(view.refreshJobs).toHaveBeenCalledOnce();
    expect(view.pushToast).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("Drawing 2 shots"),
    );

    mocks.api.startShotListJob.mockResolvedValueOnce({
      jobIds: ["job-3"],
      asked: 2,
      shortfall: "one job could not start",
    });
    await click(view, "Film them");
    await click(view, "Send review");
    expect(view.pushToast).toHaveBeenCalledWith(
      "error",
      "one job could not start",
    );
    mocks.api.startShotListJob.mockResolvedValueOnce({
      jobIds: ["job-4"],
      asked: 1,
      shortfall: null,
    });
    await click(view, "Film them");
    await click(view, "Send review");
    expect(view.pushToast).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("Filming 1 clip"),
    );
    await view.close();
  });

  it("splits handed-off and file scripts, explains model choices, and applies the preview", async () => {
    const view = await renderStory({
      handoff: "A scene arrives from the bench.",
    });
    expect(view.onHandoffUsed).toHaveBeenCalledOnce();
    expect(mocks.api.storyPlanSplit).toHaveBeenCalledWith(
      "A scene arrives from the bench.",
      5,
      15,
    );
    expect(view.host.textContent).toContain("picture model and a clip model");
    await click(view, "Use a file from this room");
    await click(view, "Pick Which file is the script?");
    expect(mocks.api.storyTextFromFile).toHaveBeenCalledWith("doc-1");
    await change(field(view, "The script"), "Changed by hand");
    await change(
      view.host.querySelectorAll(".cr-split-knobs select")[0],
      "video-1",
    );
    await change(
      view.host.querySelectorAll(".cr-split-knobs select")[2],
      "image-1",
    );
    await click(view, "Add 2 shots");
    expect(mocks.api.storyApplySplit).toHaveBeenCalledWith({
      listId: "list-1",
      shots: [
        { action: "Mira enters", seconds: 8 },
        { action: "Jon looks up", seconds: 8 },
      ],
      imageModel: "image-1",
      videoModel: "video-1",
    });
    expect(view.pushToast).toHaveBeenCalledWith(
      "info",
      "2 shots added — 0:16 in all.",
    );
    await view.close();
  });

  it("keeps cast-file failures and empty sheets visible without adding anyone", async () => {
    currentBoard = board({ cast: [], shots: [] });
    mocks.api.storyReadCastFile.mockResolvedValueOnce({
      name: "empty sheet",
      found: [],
      readBy: "pattern reader",
      fellBack: null,
    });
    const view = await renderStory();
    expect(view.host.textContent).toContain("nobody yet");
    await click(view, "Read them from a file in this room");
    await click(view, "Pick Which file describes them?");
    expect(view.host.textContent).toContain("found nobody");
    expect(view.host.textContent).toContain("reports no characters");
    await click(view, "Close");

    mocks.api.storyReadCastFile.mockResolvedValueOnce({
      name: "fallback sheet",
      found: [],
      readBy: "pattern reader",
      fellBack: "model unavailable; used headings",
    });
    await click(view, "Read them from a file in this room");
    await click(view, "Pick Which file describes them?");
    expect(view.host.textContent).toContain("model unavailable; used headings");
    await click(view, "Close");

    mocks.api.storyReadCastFile.mockRejectedValueOnce(
      new Error("cannot read cast"),
    );
    await click(view, "Read them from a file in this room");
    await click(view, "Pick Which file describes them?");
    expect(view.host.textContent).toContain("cannot read cast");
    await view.close();

    currentBoard = board({ shots: [] });
    mocks.api.storyReadCastFile.mockResolvedValueOnce({
      name: "two people",
      found: [
        { name: "Lena", description: "red scarf", story: "returns" },
        { name: "Tari", description: "black coat", story: "waits" },
      ],
      readBy: "pattern reader",
      fellBack: "model unavailable; reviewed by headings",
    });
    const reviewed = await renderStory();
    await click(reviewed, "Read them from a file in this room");
    await click(reviewed, "Pick Which file describes them?");
    expect(reviewed.host.textContent).toContain("reviewed by headings");
    await change(field(reviewed, "Name of person 1"), "Lena edited");
    const closeReview = reviewed.host.querySelector(
      '.cr-sheet [aria-label="Close"]',
    );
    if (!closeReview) throw new Error("cast review close missing");
    await invoke(closeReview);
    await reviewed.close();
  });

  it("renders missing portraits and alternate list, shape, runtime, and file states", async () => {
    currentBoard = board({
      cast: [cast({ description: "", story: "", faceFileId: "old-picture" })],
      lists: [
        list(),
        list({ id: "list-2", title: "Second list", shotCount: 1 }),
      ],
      shots: [
        shot({ stillFileId: "still-1", clipFileId: null }),
        shot({
          id: "shot-2",
          ord: 1,
          stillFileId: null,
          clipFileId: "clip-2",
          videoModel: "",
          seconds: null,
        }),
      ],
    });
    mocks.api.storyPictures.mockResolvedValue([]);
    const view = await renderStory();
    expect(view.host.textContent).toContain("picture not shown");
    expect(view.host.textContent).toContain("some shots have no clip model");
    await change(field(view, "Which shot list"), "list-2");
    expect(mocks.api.storyBoard).toHaveBeenCalledWith("list-2");
    await click(view, "Open the picture");
    await click(view, "Open the clip");
    expect(view.viewFile).toHaveBeenNthCalledWith(1, "still-1");
    expect(view.viewFile).toHaveBeenNthCalledWith(2, "clip-2");
    await view.close();

    currentBoard = board({
      cast: [],
      shots: [shot({ videoModel: "video-2", imageModel: "image-1" })],
    });
    const disagree = await renderStory();
    expect(disagree.host.textContent).toContain("share no frame shape");
    expect(disagree.host.textContent).toContain("Add someone to the cast");
    await disagree.close();

    currentBoard = board({ cast: [], shots: [] });
    const noShape = await renderStory();
    expect(noShape.host.querySelector(".cr-shape")).toBeNull();
    await noShape.close();
  });

  it("handles keyboard additions and mutation and batch failures visibly", async () => {
    const view = await renderStory();
    mocks.api.storyAddShot.mockRejectedValueOnce(new Error("cannot add shot"));
    await change(field(view, "A new shot"), "Key press shot");
    await invoke(field(view, "A new shot"), "onKeyDown", { key: "Enter" });
    expect(view.pushToast).toHaveBeenCalledWith(
      "error",
      "Error: cannot add shot",
    );
    await click(view, "Jon");
    expect(mocks.api.storyUpdateShot).toHaveBeenCalledWith(
      expect.objectContaining({ id: "shot-1", castIds: ["cast-1", "cast-2"] }),
    );

    mocks.api.startShotListJob.mockRejectedValueOnce(
      new Error("cannot start run"),
    );
    await click(view, "Draw them");
    await click(view, "Send review");
    expect(view.pushToast).toHaveBeenCalledWith(
      "error",
      "Error: cannot start run",
    );

    await click(view, "Film them");
    await click(view, "Send review");
    expect(view.pushToast).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("Filming 2 clips"),
    );
    await view.close();
  });

  it("shows invalid split inputs, script-defined plans, and planning errors", async () => {
    mocks.api.storyPlanSplit.mockResolvedValueOnce({
      parts: 1,
      totalSeconds: 12,
      shots: [{ action: "", seconds: 12 }],
      fromScript: true,
    });
    const defined = await renderStory({ handoff: "**00:00–00:12**" });
    expect(defined.host.textContent).toContain(
      "Using your script’s own chunks",
    );
    expect(defined.host.textContent).toContain("nothing here");
    await defined.close();

    const view = await renderStory({ handoff: "Plain script" });
    const minutes = view.host.querySelector(
      '.cr-split-knobs input[type="number"]',
    );
    if (!minutes) throw new Error("minutes field missing");
    await change(minutes, "2");
    await change(minutes, "");
    expect(view.host.textContent).toContain("Say how long it should run");
    await change(
      view.host.querySelectorAll(".cr-split-knobs select")[0],
      "video-2",
    );
    expect(view.host.textContent).toContain("cannot take an ending picture");
    await view.close();

    mocks.api.storyPlanSplit.mockRejectedValueOnce(
      new Error("cannot split script"),
    );
    const failed = await renderStory({ handoff: "Bad script" });
    expect(failed.host.textContent).toContain("cannot split script");
    await failed.close();

    const halfChosen = await renderStory({ handoff: "Choose only one model" });
    await change(
      halfChosen.host.querySelectorAll(".cr-split-knobs select")[2],
      "image-1",
    );
    expect(halfChosen.host.textContent).toContain("skipped by “Film them”");
    await change(
      halfChosen.host.querySelectorAll(".cr-split-knobs select")[2],
      "",
    );
    await change(
      halfChosen.host.querySelectorAll(".cr-split-knobs select")[0],
      "video-1",
    );
    expect(halfChosen.host.textContent).toContain(
      "skipped by “Draw the frames”",
    );
    await halfChosen.close();
  });

  it("covers controls whose choices have no persisted default and keeps cleanup harmless", async () => {
    currentBoard = board({
      lists: [list(), list({ id: "list-2", title: "Other" })],
      shots: [shot({ videoModel: "video-1" })],
    });
    const view = await renderStory();
    await click(view, "New list");
    expect(mocks.api.storyCreateList).toHaveBeenCalledWith("Untitled", "");

    await click(view, "Break a script into shots");
    const splitClose = view.host.querySelector(".cr-split .cr-pick-x");
    if (!splitClose) throw new Error("split close missing");
    await invoke(splitClose);
    await click(view, "Break a script into shots");
    await change(field(view, "The script"), "A scene to split");
    const splitSelects = view.host.querySelectorAll(".cr-split-knobs select");
    await change(splitSelects[0], "video-1");
    await change(splitSelects[1], "4");
    await change(splitSelects[2], "image-1");
    const splitCancel = view.host.querySelector(
      ".cr-split .cr-form-acts button",
    );
    if (!splitCancel) throw new Error("split cancel missing");
    await invoke(splitCancel);

    const frameShape = view.host.querySelector(".cr-shape select");
    if (!frameShape) throw new Error("frame shape missing");
    await change(frameShape, "16:9");
    const continuous = view.host.querySelector(".cr-chain input");
    if (!continuous) throw new Error("continuous choice missing");
    await invoke(continuous, "onChange", { target: { checked: false } });
    await click(view, "Draw them");
    await click(view, "Close review");
    await click(view, "Draw them");
    currentBoard.selected = null;
    const skippedSend = mocks.review.send;
    if (!skippedSend) throw new Error("review send missing");
    await act(async () => skippedSend());
    expect(mocks.api.startShotListJob).not.toHaveBeenCalled();
    await view.close();

    currentBoard = board({
      lists: [list(), list({ id: "list-2", title: "Unselected list" })],
      shots: [],
      selected: null,
    });
    const noSelection = await renderStory();
    expect(field(noSelection, "Which shot list")).toBeTruthy();
    await change(field(noSelection, "A new shot"), "No selected destination");
    await click(noSelection, "Add shot");
    expect(mocks.api.storyAddShot).not.toHaveBeenCalled();
    await noSelection.close();

    currentBoard = board({
      cast: [],
      shots: [
        shot({ id: "first", videoModel: "video-1" }),
        shot({ id: "second", ord: 1, videoModel: "video-2" }),
        shot({ id: "third", ord: 2, videoModel: "video-3" }),
      ],
    });
    const pluralWarning = await renderStory();
    expect(pluralWarning.host.textContent).toContain(
      "take no starting picture",
    );
    await pluralWarning.close();

    currentBoard = board({
      cast: [],
      shots: [
        shot({
          imageModel: "unlisted-image",
          videoModel: "unlisted-video",
          stillFileId: null,
          clipFileId: null,
        }),
      ],
    });
    const missingFiles = await renderStory();
    expect(missingFiles.host.textContent).not.toContain("Open the picture");
    expect(missingFiles.host.textContent).not.toContain("Open the clip");
    await missingFiles.close();

    const picturePromise: {
      settle:
        | ((
            pictures: { fileId: string; name: string; thumbB64: string }[],
          ) => void)
        | null;
    } = { settle: null };
    currentBoard = board({ shots: [] });
    mocks.api.storyPictures.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          picturePromise.settle = resolve;
        }),
    );
    const unmounted = await renderStory();
    await unmounted.close();
    if (!picturePromise.settle)
      throw new Error("picture request never started");
    picturePromise.settle([]);
    await flush();
  });
});
