import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    throw new Error("fabricated synchronous spawn refusal");
  }),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocked.spawn,
}));

import { CancelFlag } from "./cancel.js";
import { executeScriptInWorkspace } from "./scriptRun.js";

describe("synchronous process spawn failures", () => {
  it("adds the script-run context and preserves the native error message", async () => {
    await expect(
      executeScriptInWorkspace(
        "/fabricated-workspace",
        { program: "/fabricated/runtime", argvPrefix: [] },
        "script.js",
        30,
        new CancelFlag(),
      ),
    ).rejects.toThrow("Could not start the script: fabricated synchronous spawn refusal");
    expect(mocked.spawn).toHaveBeenCalledOnce();
  });
});
