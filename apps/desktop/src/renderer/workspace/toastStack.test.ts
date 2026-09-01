import { describe, expect, it, vi } from "vitest";

import type { Toast } from "./types";
import { clearToastsAbout, MAX_TOASTS, stackToast, toastLifeMs } from "./toastStack";

function toast(overrides: Partial<Toast> = {}): Toast {
  return { id: 1, kind: "success", text: "Saved", ...overrides };
}

describe("toast stack policy", () => {
  it("keeps only the newest message about an object and protects errors at the cap", () => {
    const replaced = stackToast(
      [toast({ id: 1, about: "file-1" }), toast({ id: 2, about: "file-2" })],
      toast({ id: 3, about: "file-1", text: "Removed" }),
    );
    expect(replaced.map((item) => item.id)).toEqual([2, 3]);

    const full = Array.from({ length: MAX_TOASTS }, (_unused, index) =>
      toast({ id: index, kind: index === 1 ? "error" : "success" }),
    );
    const capped = stackToast(full, toast({ id: 9, kind: "success" }));
    expect(capped.map((item) => item.id)).toEqual([1, 2, 3, 4, 9]);
    expect(clearToastsAbout(replaced, "file-1").map((item) => item.id)).toEqual([2]);
  });

  it("times only notices and object actions, never errors or standalone offers", () => {
    const undo = { label: "Undo", run: vi.fn() };
    expect(toastLifeMs(toast({ kind: "error" }))).toBeNull();
    expect(toastLifeMs(toast({ about: "file-1" }))).toBe(5_000);
    expect(toastLifeMs(toast({ about: "file-1", action: undo }))).toBe(12_000);
    expect(toastLifeMs(toast({ action: undo }))).toBeNull();
    expect(toastLifeMs(toast())).toBe(5_000);
  });
});
