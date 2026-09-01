import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./icons", () => ({
  BookOpenIcon: () => null,
  CreateIcon: () => null,
  FolderIcon: () => null,
  GlobeIcon: () => null,
  GraphIcon: () => null,
  HomeIcon: () => null,
  LinkIcon: () => null,
  MemoryIcon: () => null,
  MicIcon: () => null,
  ScriptIcon: () => null,
  SketchIcon: () => null,
  WorkflowsIcon: () => null,
}));

import { EmptyChatArt, EmptyViewerArt } from "./icons/empty";
import ToolBadgeIcon from "./settings/ToolBadgeIcon";
import { hostOf, isUsableEndpoint } from "./settings/marketplaceText";
import { groupActivity, pendingApprovalCount, runningJobCount } from "./shell/activity";
import { areaDef, areaLabel } from "./shell/navPrefs";
import {
  fakeGainNode,
  fakeNode,
  fakeScriptProcessorNode,
  fakeWorkletNode,
} from "./platform/recording/testFixtures";
import {
  emptyReason,
  emptyShelfLine,
  legalSeconds,
  selectedModel,
  sharedValues,
  takesFirstFrame,
  tallies,
  visibleModels,
} from "./workspace/create/selectors";
import {
  applyEvent,
  finishRun,
  isAsking,
  liveTurn,
  NO_LIVE_TURN,
  ownerOf,
  runIdOf,
  startRun,
  usageOf,
} from "./workspace/runIdentity";
import {
  removeWorkspaceOperation,
  updateWorkspaceOperations,
  workspaceOperationDetail,
  workspaceOperationLabel,
} from "./workspaceOperationProgress";
import { historyHint, resizedBox, simplify, strokeFromTrail } from "./viewers/sketch/model";

const originalReact = Reflect.get(globalThis, "React");

beforeAll(() => Reflect.set(globalThis, "React", React));
afterAll(() => {
  if (originalReact === undefined) Reflect.deleteProperty(globalThis, "React");
  else Reflect.set(globalThis, "React", originalReact);
});

describe("round-one renderer presentation coverage", () => {
  it("renders both decorative empty-state drawings with stable accessible semantics", () => {
    const viewer = renderToStaticMarkup(<EmptyViewerArt />);
    const chat = renderToStaticMarkup(<EmptyChatArt />);

    expect(viewer).toContain('viewBox="0 0 200 136"');
    expect(viewer).toContain("var(--mk-yellow)");
    expect(viewer).toContain('aria-hidden="true"');
    expect(chat).toContain('viewBox="0 0 156 116"');
    expect(chat).toContain("var(--mk-berry)");
    expect(chat).toContain('aria-hidden="true"');
  });

  it("renders the monochrome model-tool badge glyph", () => {
    const markup = renderToStaticMarkup(<ToolBadgeIcon />);

    expect(markup).toContain('class="model-badge-ic"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("round-one renderer pure behavior coverage", () => {
  it("counts every pending approval, including approvals nested under harness runs", () => {
    const state = {
      mcpApprovals: [{ id: "mcp" }],
      editApprovals: [{ id: "edit" }],
      scriptApprovals: [{ id: "script" }],
      browseConsents: [{ id: "browse" }],
      harnessRuns: {
        first: { approvals: [{ id: "one" }, { id: "two" }] },
        second: { approvals: [] },
      },
    } as unknown as Parameters<typeof pendingApprovalCount>[0];

    expect(pendingApprovalCount(state)).toBe(6);
    expect(pendingApprovalCount(
      { ...state, harnessRuns: undefined } as unknown as Parameters<typeof pendingApprovalCount>[0],
    )).toBe(4);
  });

  it("separates running, completed, and recoverable activity", () => {
    const queued = { id: "queued", status: "queued" };
    const running = { id: "running", status: "running" };
    const done = { id: "done", status: "done" };
    const failed = { id: "failed", status: "failed" };

    expect(groupActivity([queued, running, done, failed])).toEqual({
      active: [queued, running],
      parked: [failed],
      history: [done],
    });
    expect(runningJobCount({
      jobs: [queued],
      summaryStarting: true,
      recSave: { progress: 1 },
      recLive: null,
      harnessRuns: {
        one: { status: "starting" },
        two: { status: "done" },
      },
    } as never)).toBe(4);
  });

  it("returns catalog destinations and uses Home only for unknown labels", () => {
    expect(areaDef("files").label).toBe("Library");
    expect(() => areaDef("retired" as never)).toThrow(
      'no sidebar destination registered for "retired"',
    );
    expect(areaLabel("files")).toBe("Library");
    expect(areaLabel("retired" as never)).toBe("Home");
  });

  it("describes each empty media shelf without confusing a search miss with an empty catalog", () => {
    expect(emptyShelfLine("image", "  fox  ")).toBe("Nothing matches “fox”.");
    expect(emptyShelfLine("video", "")).toContain("No video models");
    expect(emptyShelfLine("image", "")).toContain("No image models");
  });

  it("prefers an event's chat owner and otherwise offers it to the on-screen chat", () => {
    expect(ownerOf({ chatId: "origin" } as Parameters<typeof ownerOf>[0], "visible")).toBe(
      "origin",
    );
    expect(ownerOf({ chatId: null } as Parameters<typeof ownerOf>[0], "visible")).toBe(
      "visible",
    );
    expect(ownerOf({ chatId: null } as Parameters<typeof ownerOf>[0], null)).toBeNull();
  });

  it("keeps each live run and its usage isolated by chat", () => {
    const started = startRun({}, "chat-a", "run-a");
    expect(started["chat-a"]?.runId).toBe("run-a");
    expect(liveTurn(started, "chat-a")).toBe(started["chat-a"]);
    expect(liveTurn(started, null)).toBe(NO_LIVE_TURN);
    expect(isAsking(started, "chat-a")).toBe(true);
    expect(isAsking(started, null)).toBe(false);
    expect(runIdOf(started, "chat-a")).toBe("run-a");
    expect(runIdOf(started, "missing")).toBeNull();

    const patched = applyEvent(started, "chat-a", "run-a", (turn) => ({
      ...turn,
      text: "fabricated answer",
    }));
    expect(patched["chat-a"]?.text).toBe("fabricated answer");
    expect(applyEvent(started, "missing", "run-a", (turn) => turn)).toBe(started);
    expect(applyEvent(started, "chat-a", "other-run", (turn) => turn)).toBe(started);
    expect(finishRun(started, "missing")).toBe(started);
    expect(finishRun(started, "chat-a")).toEqual({});

    const usage = {
      total_tokens: 3,
      max_context: 100,
      estimated: false,
      breakdown: {},
    } as never;
    expect(usageOf({ "chat-a": usage }, "chat-a")).toBe(usage);
    expect(usageOf({ "chat-a": usage }, null)).toBeNull();
  });

  it("treats malformed connector endpoints as unusable instead of throwing during render", () => {
    expect(hostOf("https://tools.example.test/mcp")).toBe("tools.example.test");
    expect(hostOf("not a URL")).toBe("");
    expect(isUsableEndpoint("http://localhost:9000/mcp")).toBe(true);
    expect(isUsableEndpoint("file:///tmp/socket")).toBe(false);
    expect(isUsableEndpoint("not a URL")).toBe(false);
  });

  it("replaces and removes only the matching workspace operation", () => {
    type Event = Parameters<typeof updateWorkspaceOperations>[1];
    const first = { operationId: "one", completed: 1 } as Event;
    const second = { operationId: "two", completed: 2 } as Event;
    const replacement = { operationId: "one", completed: 3 } as Event;

    expect(updateWorkspaceOperations([], first)).toEqual([first]);
    expect(updateWorkspaceOperations([first, second], replacement)).toEqual([
      replacement,
      second,
    ]);
    expect(removeWorkspaceOperation([replacement, second], "one")).toEqual([second]);
  });

  it("names workspace operations and reports bounded progress or terminal phases", () => {
    expect(workspaceOperationLabel("workspace-checkpoint")).toBe("Saving checkpoint");
    const event = {
      operationId: "one",
      operation: "workspace-checkpoint",
      phase: "copying-files",
      status: "running",
      completed: 12,
      total: 10,
      unit: "files",
    } as Parameters<typeof workspaceOperationDetail>[0];
    expect(workspaceOperationDetail(event)).toBe("Copying files — 10 of 10 files");
    expect(workspaceOperationDetail({ ...event, completed: -2 })).toBe("Copying files — 0 of 10 files");
    expect(workspaceOperationDetail({ ...event, total: null })).toBe("Copying files…");
    expect(workspaceOperationDetail({ ...event, phase: "completed", status: "completed" })).toBe("Complete");
    expect(workspaceOperationDetail({ ...event, phase: "failed", status: "failed" })).toBe("Failed");
  });

  it("derives complete create-shelf choices from fabricated provider catalogs", () => {
    const image = {
      model: "image-one",
      slug: "image-one",
      label: "Image One",
      image: true,
      video: false,
      limits: { durations: [4, 8], frameImages: ["first_frame"], aspectRatios: ["1:1", "16:9"] },
    } as never;
    const video = {
      model: "video-one",
      slug: "video-one",
      label: "Video One",
      image: false,
      video: true,
      limits: { durations: [6], frameImages: [], aspectRatios: ["16:9"] },
    } as never;
    expect(visibleModels([image, video], "image", " image ")).toEqual([image]);
    expect(selectedModel([image], "missing")).toBe(image);
    expect(selectedModel([], null)).toBeNull();
    expect(legalSeconds(image)).toEqual([4, 8]);
    expect(legalSeconds(null)).toEqual([]);
    expect(sharedValues([image, video], (limits) => limits.aspectRatios)).toEqual(["16:9"]);
    expect(sharedValues([null], (limits) => limits.aspectRatios)).toEqual([]);
    expect(takesFirstFrame(image)).toBe(true);
    expect(takesFirstFrame(video)).toBe(false);
    expect(takesFirstFrame(null)).toBe(true);
    expect(tallies(null)).toEqual({ image: 0, video: 0, cannot: 0, can: 0, scanned: 0 });
    const catalog = {
      models: [image, video],
      excluded: [{ count: 3 }],
      scanned: 5,
      anyProvider: true,
      error: null,
    };
    expect(tallies(catalog as never)).toEqual({ image: 1, video: 1, cannot: 3, can: 2, scanned: 5 });
    expect(emptyReason(null)).toBe("loading");
    expect(emptyReason({ ...catalog, error: "failed" } as never)).toBe("error");
    expect(emptyReason(catalog as never)).toBeNull();
    expect(emptyReason({ ...catalog, models: [] } as never)).toBe("none-can-draw");
    expect(emptyReason({ ...catalog, models: [], anyProvider: false } as never)).toBe("no-provider");
  });

  it("covers drawing history, south-edge resizing, simplification, and the stroke cap", () => {
    expect(historyHint({ verb: "Undo", shortcut: "⌘Z", depth: 2, typing: false })).toBe(
      "Undo · ⌘Z",
    );
    expect(historyHint({ verb: "Undo", shortcut: "⌘Z", depth: 2, typing: true })).toContain(
      "belongs to the text field",
    );
    expect(resizedBox({ x: 10, y: 20, w: 100, h: 80 }, "s", 0, 25)).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 105,
    });
    expect(resizedBox({ x: 10, y: 20, w: 100, h: 80 }, "e", 25, 40)).toEqual({
      x: 10,
      y: 20,
      w: 125,
      h: 80,
    });
    expect(simplify([[0, 0], [5, 20], [10, 0]], 1)).toEqual([
      [0, 0],
      [5, 20],
      [10, 0],
    ]);

    const longTrail = Array.from({ length: 2_100 }, (_, index) => [
      index * 0.7,
      index % 2 === 0 ? 0 : 1_000,
    ] as [number, number]);
    expect(strokeFromTrail(longTrail)).toHaveLength(2_000);
  });
});

describe("audio graph test doubles", () => {
  it("forwards live connection and disconnect state through every wrapper", () => {
    const destination = fakeNode();
    const gain = fakeGainNode();
    gain.connect(destination);
    gain.disconnect();
    expect(gain.connected).toEqual([destination]);
    expect(gain.disconnectCalls).toBe(1);

    const script = fakeScriptProcessorNode();
    const process = vi.fn();
    script.onaudioprocess = process;
    script.connect(destination);
    script.disconnect();
    expect(script.connected).toEqual([destination]);
    expect(script.disconnectCalls).toBe(1);
    expect(script.onaudioprocess).toBe(process);

    const worklet = fakeWorkletNode();
    worklet.connect(destination);
    expect(worklet.connected).toEqual([destination]);
  });
});
