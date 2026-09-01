import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptApproveRequest } from "../api";
import type { WSState } from "./state";

const transport = vi.hoisted(() => ({
  listScripts: vi.fn(),
  resolveScriptRun: vi.fn(),
  runScript: vi.fn(),
  setScriptSchedule: vi.fn(),
}));

vi.mock("../api", () => ({ api: transport }));

import { makeScriptActions } from "./scriptActions";

function state(scripts: Array<{ fileId: string; name: string }> = []): WSState {
  return {
    scripts,
    setScripts: vi.fn(),
    setShowMap: vi.fn(),
    setShowWorkflows: vi.fn(),
    setOpenFile: vi.fn(),
    setShowScripts: vi.fn(),
    setScriptApprovals: vi.fn(),
    pushToast: vi.fn(),
  } as unknown as WSState;
}

describe("script actions with a fake API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.listScripts.mockResolvedValue([]);
    transport.resolveScriptRun.mockResolvedValue(undefined);
    transport.setScriptSchedule.mockResolvedValue(undefined);
  });

  it("runs a named script, reports its start, and refreshes the fake list", async () => {
    const s = state([{ fileId: "script-1", name: "daily report" }]);
    transport.runScript.mockResolvedValue(undefined);
    transport.listScripts.mockResolvedValue([{ fileId: "script-1", name: "daily report" }]);

    await makeScriptActions(s).runScript("script-1");

    expect(transport.runScript).toHaveBeenCalledWith("script-1");
    expect(s.pushToast).toHaveBeenCalledWith("info", "daily report started", {
      label: "Scripts",
      run: expect.any(Function),
    });
    expect(transport.listScripts).toHaveBeenCalledOnce();
    expect(s.setScripts).toHaveBeenCalledWith([{ fileId: "script-1", name: "daily report" }]);
  });

  it("keeps declined consent informational and surfaces other fake API errors", async () => {
    const s = state([{ fileId: "script-1", name: "daily report" }]);
    transport.runScript.mockRejectedValueOnce(new Error("not approved by the user"));

    await makeScriptActions(s).runScript("script-1");
    expect(s.pushToast).toHaveBeenCalledWith("info", "daily report was not run.");

    transport.runScript.mockRejectedValueOnce(new Error("fake runtime failure"));
    await makeScriptActions(s).runScript("unknown-script");
    expect(s.pushToast).toHaveBeenLastCalledWith("error", "Error: fake runtime failure");
    expect(transport.listScripts).toHaveBeenCalledTimes(0);
  });

  it("sets and clears schedules through the fabricated API before refreshing scripts", async () => {
    const s = state([{ fileId: "script-1", name: "daily report" }]);
    transport.listScripts.mockResolvedValue([{ fileId: "script-1", name: "daily report" }]);
    const actions = makeScriptActions(s);

    await actions.scheduleScript("script-1", { kind: "daily", param: "09:00", enabled: false });
    await actions.scheduleScript("script-1", { kind: "" });

    expect(transport.setScriptSchedule).toHaveBeenNthCalledWith(1, "script-1", "daily", "09:00", false);
    expect(transport.setScriptSchedule).toHaveBeenNthCalledWith(2, "script-1", "", "", true);
    expect(transport.listScripts).toHaveBeenCalledTimes(2);
    expect(s.setScripts).toHaveBeenLastCalledWith([{ fileId: "script-1", name: "daily report" }]);
  });

  it("reports a fabricated schedule failure without claiming the scripts refreshed", async () => {
    const s = state();
    transport.setScriptSchedule.mockRejectedValueOnce(new Error("schedule rejected"));

    await makeScriptActions(s).scheduleScript("script-1", { kind: "weekly", param: "Mon 09:00" });

    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: schedule rejected");
    expect(transport.listScripts).not.toHaveBeenCalled();
    expect(s.setScripts).not.toHaveBeenCalled();
  });

  it("removes a resolved approval even when its fabricated acknowledgement fails", async () => {
    const s = state();
    const request: ScriptApproveRequest = {
      id: "approval-1",
      name: "daily report",
      interpreterLine: "uv run report.py",
      deps: [],
      inputs: [],
      outputs: [],
      timeout: 30,
    };
    const other: ScriptApproveRequest = { ...request, id: "approval-2" };
    let pending = [request, other];
    (s.setScriptApprovals as ReturnType<typeof vi.fn>).mockImplementation((update) => {
      pending = update(pending);
    });
    transport.resolveScriptRun.mockRejectedValueOnce(new Error("response channel closed"));

    makeScriptActions(s).resolveScriptApproval(request, "always");
    await Promise.resolve();

    expect(transport.resolveScriptRun).toHaveBeenCalledWith("approval-1", "always");
    expect(pending).toEqual([other]);
  });

  it("opens and closes the Scripts surface and refreshes its fake rows", async () => {
    const s = state();
    transport.listScripts.mockResolvedValue([{ fileId: "script-2", name: "weekly review" }]);
    const actions = makeScriptActions(s);

    actions.openScripts();
    await Promise.resolve();

    expect(s.setShowMap).toHaveBeenCalledWith(false);
    expect(s.setShowWorkflows).toHaveBeenCalledWith(false);
    expect(s.setOpenFile).toHaveBeenCalledWith(null);
    expect(s.setShowScripts).toHaveBeenCalledWith(true);
    expect(s.setScripts).toHaveBeenCalledWith([{ fileId: "script-2", name: "weekly review" }]);

    actions.closeScripts();
    expect(s.setShowScripts).toHaveBeenLastCalledWith(false);
  });

  it("keeps the current Scripts rows when their refresh fails", async () => {
    const s = state([{ fileId: "existing", name: "existing script" }]);
    transport.listScripts.mockRejectedValueOnce(new Error("room unavailable"));

    await makeScriptActions(s).refreshScripts();

    expect(s.setScripts).not.toHaveBeenCalled();
    expect(s.scripts).toEqual([{ fileId: "existing", name: "existing script" }]);
  });
});
