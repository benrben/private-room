import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentSketchFocus,
  setSketchFocus,
  subscribeSketchFocus,
} from "./sketchFocus";

afterEach(() => setSketchFocus(null));

describe("sketch focus store", () => {
  it("notifies only when the published drawing focus changes by value", () => {
    const notify = vi.fn();
    const unsubscribe = subscribeSketchFocus(notify);

    expect(currentSketchFocus()).toBeNull();
    setSketchFocus(null);
    setSketchFocus({ fileId: "drawing-a", selection: [] });
    setSketchFocus({ fileId: "drawing-a", selection: [] });
    setSketchFocus({ fileId: "drawing-b", selection: [] });
    setSketchFocus({ fileId: "drawing-b", selection: ["Circle"] });
    setSketchFocus({ fileId: "drawing-b", selection: ["Arrow"] });
    setSketchFocus({ fileId: "drawing-b", selection: ["Arrow"] });

    expect(notify).toHaveBeenCalledTimes(4);
    expect(currentSketchFocus()).toEqual({ fileId: "drawing-b", selection: ["Arrow"] });

    unsubscribe();
    setSketchFocus(null);
    expect(notify).toHaveBeenCalledTimes(4);
  });
});
