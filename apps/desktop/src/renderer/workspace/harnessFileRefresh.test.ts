import { describe, expect, it, vi } from "vitest";
import { refreshSharedFilesForHarnessEvent } from "./harnessFileRefresh";

describe("refreshSharedFilesForHarnessEvent", () => {
  it("ignores a fabricated non-file harness event without reading the file list", async () => {
    const listFiles = vi.fn<() => Promise<string[]>>();
    const setFiles = vi.fn();

    await expect(refreshSharedFilesForHarnessEvent({ type: "run_finished" }, listFiles, setFiles)).resolves.toBe(false);
    expect(listFiles).not.toHaveBeenCalled();
    expect(setFiles).not.toHaveBeenCalled();
  });

  it("replaces the shared list with fabricated files after a file-change event", async () => {
    const files = [{ id: "fake-file", name: "report.md" }];
    const listFiles = vi.fn<() => Promise<typeof files>>().mockResolvedValue(files);
    const setFiles = vi.fn();

    await expect(refreshSharedFilesForHarnessEvent({ type: "file_changed" }, listFiles, setFiles)).resolves.toBe(true);
    expect(listFiles).toHaveBeenCalledOnce();
    expect(setFiles).toHaveBeenCalledWith(files);
  });

  it("propagates a fabricated list failure and does not replace the current files", async () => {
    const listFiles = vi.fn<() => Promise<string[]>>().mockRejectedValue(new Error("fabricated list failure"));
    const setFiles = vi.fn();

    await expect(refreshSharedFilesForHarnessEvent({ type: "file_changed" }, listFiles, setFiles))
      .rejects.toThrow("fabricated list failure");
    expect(setFiles).not.toHaveBeenCalled();
  });
});
