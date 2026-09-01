import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRun } from "../../api";

const mocks = vi.hoisted(() => ({
  getJobStepArtifact: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../api", () => ({
  api: { getJobStepArtifact: mocks.getJobStepArtifact },
}));
vi.mock("../../icons", () => ({ CircleCheckIcon: () => null }));

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
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function run(id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflowId: "workflow",
    jobId: `job-${id}`,
    trigger: "manual",
    status: "done",
    error: null,
    inputFileId: null,
    startedAt: "2026-08-31T12:00:00.000Z",
    finishedAt: "2026-08-31T12:01:00.000Z",
    ...overrides,
  };
}

async function render(runs: WorkflowRun[]) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const timers: Array<() => void> = [];
  Reflect.set(window, "setTimeout", (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  });
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest", clipboard: { writeText: mocks.writeText } },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const [{ createRoot }, { RunHistory }] = await Promise.all([
    import("react-dom/client"),
    import("./RunHistory"),
  ]);
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(RunHistory, { runs, nodeCount: 1 }));
    await Promise.resolve();
  });
  return {
    host,
    close: async () => act(async () => root.unmount()),
    runTimers: async () => act(async () => timers.splice(0).forEach((callback) => callback())),
  };
}

async function reactClick(element: Element) {
  const propKey = Object.keys(element).find((key) => key.startsWith("__reactProps"));
  if (!propKey) throw new Error("React props missing");
  const props = (element as unknown as Record<string, Record<string, () => void>>)[propKey];
  await act(async () => {
    props.onClick();
    await Promise.resolve();
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.getJobStepArtifact.mockReset();
  mocks.writeText.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (key === "navigator") {
      Reflect.deleteProperty(globalThis, key);
      if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor);
      continue;
    }
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("RunHistory", () => {
  it("states when no workflows have run", async () => {
    const view = await render([]);
    expect(view.host.textContent).toContain("No runs yet.");
    await view.close();
  });

  it("collapses identical leading errors and loads stored script artifacts", async () => {
    const report = JSON.stringify({
      result: JSON.stringify({
        exitCode: 0,
        stdoutTail: "created export",
        stderrTail: "",
        imported: [{ name: "notes.md" }],
      }),
      node_label: "Export notes",
      node_kind: "save_file",
      branch: "then",
    });
    mocks.getJobStepArtifact.mockImplementation((_jobId: string, index: number) =>
      Promise.resolve(index === 0 ? report : null),
    );
    const view = await render([
      run("error-1", { status: "error", error: "disk full" }),
      run("error-2", { status: "error", error: "disk full" }),
      run("done"),
    ]);
    expect(view.host.textContent).toContain("1 earlier run failed the same way");
    expect([...view.host.querySelectorAll(".run-row")]).toHaveLength(2);
    const done = [...view.host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("done"),
    );
    if (!done) throw new Error("done row missing");
    await reactClick(done);
    await flush();
    expect(mocks.getJobStepArtifact).toHaveBeenCalledWith("job-done", 0);
    expect(view.host.textContent).toContain("Export notes");
    expect(view.host.textContent).toContain("created export");
    expect(view.host.textContent).toContain("Imported 1 file(s): notes.md");
    await view.close();
  });

  it("settles a run with no job as an explicit empty artifact list", async () => {
    const view = await render([run("local", { jobId: null })]);
    const row = view.host.querySelector("button");
    if (!row) throw new Error("run row missing");
    await reactClick(row);
    await flush();
    expect(mocks.getJobStepArtifact).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain("No step artifacts recorded.");
    await reactClick(row);
    await flush();
    expect(view.host.textContent).not.toContain("No step artifacts recorded.");
    await view.close();
  });

  it("renders an explicitly skipped empty step without treating it as missing", async () => {
    mocks.getJobStepArtifact.mockImplementation((_jobId: string, index: number) =>
      Promise.resolve(index === 0 ? JSON.stringify({ result: "", skipped: true }) : null),
    );
    const view = await render([run("skipped")]);
    const row = view.host.querySelector("button");
    if (!row) throw new Error("run row missing");
    await reactClick(row);
    await flush();
    expect(view.host.textContent).toContain("Step skipped (an upstream branch was not taken).");
    await view.close();
  });

  it("copies a script report's fabricated stdout and stderr, then clears the copied state", async () => {
    const report = JSON.stringify({
      result: JSON.stringify({ exitCode: 1, stdoutTail: "created draft", stderrTail: "lint failed" }),
      node_label: "Write draft",
    });
    mocks.getJobStepArtifact.mockImplementation((_jobId: string, index: number) =>
      Promise.resolve(index === 0 ? report : null),
    );
    const view = await render([run("copy-script")]);
    const row = view.host.querySelector(".run-row-head");
    if (!row) throw new Error("run row missing");
    await reactClick(row);
    await flush();
    const copy = view.host.querySelector(".run-step-copy");
    if (!copy) throw new Error("copy action missing");
    await reactClick(copy);
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith("created draft\nlint failed");
    expect(copy.textContent).toContain("Copied");
    await view.runTimers();
    expect(view.host.querySelector(".run-step-copy")?.textContent).toBe("Copy");
    await view.close();
  });

  it("copies the raw fabricated script report when it has no output streams", async () => {
    const scriptReport = JSON.stringify({
      exitCode: 0,
      stdoutTail: "",
      stderrTail: "",
      imported: [{ name: "notes.md" }],
    });
    mocks.getJobStepArtifact.mockImplementation((_jobId: string, index: number) =>
      Promise.resolve(index === 0 ? JSON.stringify({ result: scriptReport }) : null),
    );
    const view = await render([run("copy-empty-report")]);
    const row = view.host.querySelector(".run-row-head");
    if (!row) throw new Error("run row missing");
    await reactClick(row);
    await flush();
    const copy = view.host.querySelector(".run-step-copy");
    if (!copy) throw new Error("copy action missing");
    await reactClick(copy);
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith(scriptReport);
    await view.runTimers();
    await view.close();
  });

  it("copies a fabricated JSON result that is not a script report as-is", async () => {
    const normalJson = JSON.stringify({ message: "plain structured output" });
    mocks.getJobStepArtifact.mockImplementation((_jobId: string, index: number) =>
      Promise.resolve(index === 0 ? JSON.stringify({ result: normalJson }) : null),
    );
    const view = await render([run("copy-json")]);
    const row = view.host.querySelector(".run-row-head");
    if (!row) throw new Error("run row missing");
    await reactClick(row);
    await flush();
    const copy = view.host.querySelector(".run-step-copy");
    if (!copy) throw new Error("copy action missing");
    await reactClick(copy);
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith(normalJson);
    await view.runTimers();
    await view.close();
  });

  it("leaves normal output visibly copyable when a fabricated clipboard write fails", async () => {
    mocks.getJobStepArtifact.mockImplementation((_jobId: string, index: number) =>
      Promise.resolve(index === 0 ? "plain step output" : null),
    );
    mocks.writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    const view = await render([run("copy-plain")]);
    const row = view.host.querySelector(".run-row-head");
    if (!row) throw new Error("run row missing");
    await reactClick(row);
    await flush();
    const copy = view.host.querySelector(".run-step-copy");
    if (!copy) throw new Error("copy action missing");
    await reactClick(copy);
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith("plain step output");
    expect(copy.textContent).toBe("Copy");
    await view.close();
  });
});
