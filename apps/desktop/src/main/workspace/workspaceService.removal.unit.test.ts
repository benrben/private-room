import { describe, expect, it } from "vitest";

import { WorkspaceService } from "./workspaceService.js";

interface WorkspaceRemovalInternals {
  removalResult(error: unknown): boolean;
}

function removalResult(error: unknown): boolean {
  const service = Object.create(WorkspaceService.prototype) as WorkspaceRemovalInternals;
  return service.removalResult(error);
}

function filesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`fake ${code}`), { code });
}

describe("WorkspaceService directory removal error mapping", () => {
  it("treats a fabricated ENOENT as an already-absent directory", () => {
    expect(removalResult(filesystemError("ENOENT"))).toBe(false);
  });

  it("preserves the non-empty refusal for fabricated ENOTEMPTY and EEXIST races", () => {
    for (const code of ["ENOTEMPTY", "EEXIST"]) {
      expect(() => removalResult(filesystemError(code)))
        .toThrow("The folder is not empty and was not removed.");
    }
  });

  it("rethrows every other fabricated filesystem failure without changing it", () => {
    const unexpected = filesystemError("EACCES");

    try {
      removalResult(unexpected);
      throw new Error("the fake EACCES should have been rethrown");
    } catch (error) {
      expect(error).toBe(unexpected);
    }
  });
});
