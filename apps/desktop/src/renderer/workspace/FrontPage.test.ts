import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontPage as FrontPageData, RoomInfo } from "../api";
import type { LayoutApi } from "../shell/useLayout";
import type { WSActions } from "./actions";
import type { WSState } from "./state";

const mocks = vi.hoisted(() => ({
  fileKindLabel: vi.fn(() => "document"),
  startPrivacyScan: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, startPrivacyScan: mocks.startPrivacyScan },
    fileKindLabel: mocks.fileKindLabel,
  };
});
vi.mock("../icons", () => ({
  ChatBubbleIcon: () => null,
  ClockIcon: () => null,
  FileTypeIcon: () => null,
}));
vi.mock("./composer", () => ({
  displayName: (name: string) => `shown ${name}`,
  formatWhen: (when: string) => `when ${when}`,
}));
vi.mock("../shell/navPrefs", () => ({
  NAV_AREAS: [
    "home", "files", "recordings", "browser", "sketch", "create", "map", "workflows", "scripts", "skills", "connectors", "memory",
  ].map((key) => ({
    key,
    label: key === "map" ? "Room Map" : `${key[0].toUpperCase()}${key.slice(1)}`,
    blurb: `Open ${key}`,
    icon: () => null,
  })),
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

type View = Awaited<ReturnType<typeof renderFrontPage>>;

function page(overrides: Partial<FrontPageData> = {}): FrontPageData {
  return {
    recentFiles: [],
    recentChats: [],
    memories: [],
    suggestions: [],
    fileCount: 1,
    chatCount: 2,
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}): WSState {
  return {
    ai: null,
    files: [],
    fpSuggestions: [],
    harnessRuns: {},
    jobProgress: {},
    jobs: [],
    model: "",
    privacyOn: true,
    privacyPending: 0,
    privacyScanning: false,
    recLive: null,
    recSave: null,
    scripts: [],
    summaryStarting: false,
    workflows: [],
    pushToast: vi.fn(),
    setActiveChatId: vi.fn(),
    setAiTab: vi.fn(),
    setArea: vi.fn(),
    setOpenFile: vi.fn(),
    setQuestion: vi.fn(),
    setSettingsSection: vi.fn(),
    setShowMap: vi.fn(),
    setShowScripts: vi.fn(),
    setShowSettings: vi.fn(),
    setShowWorkflows: vi.fn(),
    ...overrides,
  } as unknown as WSState;
}

function actions(): WSActions {
  return {
    focusComposer: vi.fn(),
    openScripts: vi.fn(),
    openWorkflows: vi.fn(),
    revealBrowser: vi.fn(),
    viewFile: vi.fn(),
  } as unknown as WSActions;
}

async function renderFrontPage({
  pageData = page(),
  workspace = state(),
  workspaceActions = actions(),
}: {
  pageData?: FrontPageData;
  workspace?: WSState;
  workspaceActions?: WSActions;
} = {}) {
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
  const [{ createRoot }, { default: FrontPage }] = await Promise.all([
    import("react-dom/client"),
    import("./FrontPage"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const layout = { showPane: vi.fn() } as unknown as LayoutApi;
  await act(async () => {
    root.render(createElement(FrontPage, {
      page: pageData,
      s: workspace,
      a: workspaceActions,
      layout,
      info: {} as RoomInfo,
    }));
    await Promise.resolve();
  });
  return { close: async () => act(async () => root.unmount()), host, layout, workspace, workspaceActions };
}

function reactProp(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (
    element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>
  )[key][name];
}

async function click(element: Element) {
  await act(async () => {
    reactProp(element, "onClick")({ currentTarget: element, preventDefault: vi.fn(), target: element });
    await Promise.resolve();
  });
}

function button(view: View, text: string) {
  const element = [...view.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === text,
  );
  if (!element) throw new Error(`button not found: ${text}`);
  return element;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.fileKindLabel.mockClear();
  mocks.startPrivacyScan.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("FrontPage", () => {
  it("keeps an empty room calm while explaining an unavailable room map", async () => {
    const view = await renderFrontPage();
    expect(view.host.textContent).not.toContain("Needs your attention");
    expect(view.host.querySelector(".rh-stamp-state")?.textContent).toBe("All quiet");
    expect(view.host.querySelector(".rh-stamp-counts")?.textContent).toContain("1 room file · 2 chats");
    expect(view.host.textContent).toContain("Nothing here yet");
    const map = button(view, "Room Map");
    expect(map.getAttribute("aria-disabled")).toBe("true");
    expect(view.host.textContent).toContain("Add a file first");
    await view.close();
  });

  it("orders all attention categories and preserves CTA routing and scan errors", async () => {
    mocks.startPrivacyScan.mockRejectedValueOnce(new Error("scan unavailable"));
    const workspace = state({
      model: "openrouter::gpt",
      privacyOn: false,
      privacyPending: 2,
      scripts: [
        { approved: false, changedSinceApproval: false },
        { approved: true, changedSinceApproval: false, lastRun: { status: "failed" } },
      ],
      workflows: [{ createdBy: "user", status: "draft" }],
    });
    const workspaceActions = actions();
    const view = await renderFrontPage({ workspace, workspaceActions });
    const entries = [...view.host.querySelectorAll(".rh-attn-list li")].map((entry) => entry.textContent);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toContain("raw cloud model");
    expect(entries[1]).toContain("haven't been scanned");
    expect(entries[2]).toContain("need review");
    expect(entries[3]).toContain("failed on");
    expect(entries[4]).toContain("workflow is a draft");
    await click(button(view, "Review privacy"));
    await click(button(view, "Scan now"));
    await flush();
    expect(mocks.startPrivacyScan).toHaveBeenCalledOnce();
    expect(workspace.pushToast).toHaveBeenCalledWith("error", "Error: scan unavailable");
    expect(workspace.setSettingsSection).toHaveBeenCalledWith("set-cloud-privacy");
    expect(workspace.setShowSettings).toHaveBeenCalledWith(true);
    await click(button(view, "Review scripts"));
    await click(button(view, "Open scripts"));
    await click(button(view, "Review workflows"));
    expect(workspaceActions.openScripts).toHaveBeenCalledTimes(2);
    expect(workspaceActions.openWorkflows).toHaveBeenCalledOnce();
    await view.close();
  });

  it("uses the scan wording and room stamp priority for scanning, recording, paused, and busy work", async () => {
    const scanning = await renderFrontPage({ workspace: state({ privacyPending: 1, privacyScanning: true }) });
    expect(scanning.host.textContent).toContain("Scanning 1 file");
    await click(button(scanning, "Watch progress"));
    expect(mocks.startPrivacyScan).not.toHaveBeenCalled();
    expect(scanning.host.querySelector(".rh-stamp-state")?.textContent).toBe("Scanning files");
    await scanning.close();

    const recording = await renderFrontPage({ workspace: state({ recLive: { status: "recording" } }) });
    expect(recording.host.querySelector(".rh-stamp-state")?.textContent).toBe("Recording now");
    await recording.close();

    const paused = await renderFrontPage({ workspace: state({ recLive: { status: "paused" } }) });
    expect(paused.host.querySelector(".rh-stamp-state")?.textContent).toBe("Recording paused");
    await paused.close();

    const busy = await renderFrontPage({ workspace: state({ jobs: [{ status: "queued", id: "job", title: "Index", cursor: 0, total: 0, updatedAt: "2026-09-01" }] }) });
    expect(busy.host.querySelector(".rh-stamp-state")?.textContent).toBe("1 running or waiting");
    await busy.close();
  });

  it("keeps timeline, navigation chips, and suggestions wired to their destinations", async () => {
    const file = { id: "file-1", name: "report.pdf", createdAt: "2026-09-01T09:00:00.000Z" };
    const chat = { id: "chat-1", title: "Discuss report", lastAt: "2026-09-01T10:00:00.000Z" };
    const workspace = state({
      files: [file],
      fpSuggestions: ["Explain report"],
      jobProgress: { job: { done: 1, total: 3 } },
      jobs: [{ status: "running", id: "job", title: "Index report", cursor: 0, total: 0, updatedAt: "2026-09-01T11:00:00.000Z" }],
    });
    const workspaceActions = actions();
    const view = await renderFrontPage({
      pageData: page({ recentFiles: [file] as never, recentChats: [chat] as never, memories: [{}] as never }),
      workspace,
      workspaceActions,
    });
    expect(view.host.textContent).toContain("1 of 3");
    expect(view.host.textContent).toContain("shown report.pdf");
    expect(view.host.textContent).toContain("Chat");
    expect(view.host.textContent).toContain("1");
    await click(view.host.querySelector('button[title="Index report"]')!);
    await click(view.host.querySelector('button[title="report.pdf"]')!);
    await click(view.host.querySelector('button[title="Discuss report"]')!);
    expect(view.layout.showPane).toHaveBeenCalledWith("ai");
    expect(workspaceActions.viewFile).toHaveBeenCalledWith("file-1");
    expect(workspace.setActiveChatId).toHaveBeenCalledWith("chat-1");

    for (const label of ["Files", "Recordings", "Browser", "Sketch", "Create", "Room Map", "Workflows", "Scripts", "Skills", "Connectors", "Memory"]) {
      await click(button(view, label === "Memory" ? "Memory1" : label));
    }
    expect(workspaceActions.revealBrowser).toHaveBeenCalledOnce();
    expect(workspaceActions.openWorkflows).toHaveBeenCalledOnce();
    expect(workspaceActions.openScripts).toHaveBeenCalledOnce();
    expect(workspace.setShowMap).toHaveBeenCalledWith(true);

    await click(button(view, "Suggestions 1"));
    await click(button(view, "Explain report"));
    expect(workspace.setQuestion).toHaveBeenCalledWith("Explain report");
    expect(workspaceActions.focusComposer).toHaveBeenCalledWith(view.layout);
    await view.close();
  });
});
