import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GeometryStore,
  geometryIsUsable,
  parseGeometry,
  saveGeometryPath,
  type Geometry,
  type Screen,
} from "./windowGeometry.js";

const LAPTOP: Screen = [0, 0, 1728, 1117];
const EXTERNAL: Screen = [1728, -400, 2560, 1440];

describe("geometryIsUsable", () => {
  it("a window remembered on an unplugged monitor is not restored", () => {
    // THE failure this guard exists for: restore the rectangle from a
    // docked session onto an undocked laptop and the window opens where it
    // cannot be seen, dragged or closed — and the app reads as broken.
    const docked: Geometry = { x: 2000, y: -200, width: 1400, height: 900 };
    expect(geometryIsUsable(docked, [LAPTOP, EXTERNAL])).toBe(true);
    // the external monitor is gone — opening there is unrecoverable
    expect(geometryIsUsable(docked, [LAPTOP])).toBe(false);
  });

  it("only a grabbable window is restored", () => {
    // Mostly off the right edge, but the title bar is still catchable.
    const edge: Geometry = { x: 1600, y: 40, width: 1000, height: 700 };
    expect(geometryIsUsable(edge, [LAPTOP])).toBe(true);
    // Past it: nothing left to grab.
    const gone: Geometry = { x: 1700, y: 40, width: 1000, height: 700 };
    expect(geometryIsUsable(gone, [LAPTOP])).toBe(false);
    // Title bar above every screen — the classic "dragged under the menu
    // bar and saved" rectangle.
    const above: Geometry = { x: 100, y: -500, width: 1000, height: 700 };
    expect(geometryIsUsable(above, [LAPTOP])).toBe(false);
  });

  it("a size below the window's own minimum is refused", () => {
    // The window config declares minWidth 900 / minHeight 600. A smaller
    // saved size is a corrupt file, and restoring it would produce a window
    // the layout was never built for.
    const tiny: Geometry = { x: 10, y: 10, width: 200, height: 150 };
    expect(geometryIsUsable(tiny, [LAPTOP])).toBe(false);
    const ok: Geometry = { x: 10, y: 10, width: 900, height: 600 };
    expect(geometryIsUsable(ok, [LAPTOP])).toBe(true);
    // No screens at all (a headless or mid-wake state) can never be usable.
    expect(geometryIsUsable(ok, [])).toBe(false);
  });
});

describe("parseGeometry", () => {
  it("round-trips a well-formed, current-schema file", () => {
    const raw = JSON.stringify({ v: 1, x: 10, y: 20, width: 900, height: 600 });
    expect(parseGeometry(raw)).toEqual({ x: 10, y: 20, width: 900, height: 600 });
  });

  it("rejects malformed JSON rather than throwing", () => {
    expect(parseGeometry("{not json")).toBeNull();
    expect(parseGeometry("")).toBeNull();
    expect(parseGeometry("null")).toBeNull();
    expect(parseGeometry("[1,2,3]")).toBeNull();
  });

  it("rejects a file missing a field", () => {
    expect(parseGeometry(JSON.stringify({ v: 1, x: 10, y: 20, width: 900 }))).toBeNull();
  });

  it("rejects fractional or out-of-i32/u32-range fields, same as serde's typed deserialize", () => {
    // Rust's `x`/`y` are `i32`, `width`/`height` are `u32` — a JSON number
    // that doesn't fit, or isn't a whole number, fails to deserialize at all
    // and the caller falls back to "nothing saved". A finite JS double can
    // represent all of these without wrapping, so this must be checked
    // explicitly rather than relying on the arithmetic to fail loudly.
    expect(parseGeometry(JSON.stringify({ v: 1, x: 10.5, y: 20, width: 900, height: 600 }))).toBeNull();
    expect(parseGeometry(JSON.stringify({ v: 1, x: 10, y: 20, width: -900, height: 600 }))).toBeNull();
    expect(
      parseGeometry(JSON.stringify({ v: 1, x: 10, y: 20, width: 5_000_000_000, height: 600 })),
    ).toBeNull();
    expect(
      parseGeometry(JSON.stringify({ v: 1, x: 2_200_000_000, y: 20, width: 900, height: 600 })),
    ).toBeNull();
  });

  it("rejects a pre-migration Tauri window.json (physical px, no schema version)", () => {
    // The exact file this guard exists for: the old Rust app's `window.json`
    // has no `v` field at all, and its numbers are physical pixels, not the
    // DIP `screen.getAllDisplays()` now reports. Reading it as-is would
    // restore the wrong rectangle on any Retina display.
    const oldTauriFile = JSON.stringify({ x: 10, y: 20, width: 1800, height: 1200 });
    expect(parseGeometry(oldTauriFile)).toBeNull();
    // A future/foreign schema version is equally untrusted.
    expect(
      parseGeometry(JSON.stringify({ v: 2, x: 10, y: 20, width: 900, height: 600 })),
    ).toBeNull();
  });
});

describe("saveGeometryPath", () => {
  it("places window.json inside the given per-machine data directory", () => {
    expect(saveGeometryPath("/Users/x/Library/Application Support/Arcelle")).toBe(
      path.join("/Users/x/Library/Application Support/Arcelle", "window.json"),
    );
  });
});

describe("GeometryStore", () => {
  const LAPTOP: Screen = [0, 0, 1728, 1117];
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "window-geometry-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("note() ignores a fullscreen report, keeping the last normal-state rectangle", () => {
    const store = new GeometryStore(dir);
    store.note(false, { x: 10, y: 10 }, { width: 900, height: 600 });
    // Entering fullscreen reports the whole display — must not overwrite
    // the rectangle the user actually arranged.
    store.note(true, { x: 0, y: 0 }, { width: 1728, height: 1117 });
    store.save();
    const written = JSON.parse(fs.readFileSync(path.join(dir, "window.json"), "utf8"));
    expect(written).toEqual({ v: 1, x: 10, y: 10, width: 900, height: 600 });
  });

  it("note() ignores an unreadable position or size", () => {
    const store = new GeometryStore(dir);
    store.note(false, { x: 10, y: 10 }, { width: 900, height: 600 });
    store.note(false, null, { width: 1000, height: 700 });
    store.note(false, { x: 20, y: 20 }, null);
    store.save();
    const written = JSON.parse(fs.readFileSync(path.join(dir, "window.json"), "utf8"));
    expect(written).toEqual({ v: 1, x: 10, y: 10, width: 900, height: 600 });
  });

  it("save() is a no-op when nothing has been noted yet", () => {
    const store = new GeometryStore(dir);
    store.save();
    expect(fs.existsSync(path.join(dir, "window.json"))).toBe(false);
  });

  it("save() never throws even when the directory cannot be created", () => {
    // A file sitting where the directory needs to go makes mkdir fail —
    // this must stay best-effort, exactly like the Rust `let _ = ...write`.
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const store = new GeometryStore(blocked);
    store.note(false, { x: 10, y: 10 }, { width: 900, height: 600 });
    expect(() => store.save()).not.toThrow();
  });

  it("restores a saved rectangle that is still usable on the attached screens", () => {
    const writer = new GeometryStore(dir);
    writer.note(false, { x: 10, y: 10 }, { width: 900, height: 600 });
    writer.save();

    const reader = new GeometryStore(dir);
    expect(reader.restore([LAPTOP])).toEqual({ x: 10, y: 10, width: 900, height: 600 });
  });

  it("refuses to restore onto a screen set where the rectangle is unusable", () => {
    const writer = new GeometryStore(dir);
    // Recorded on an external monitor that is no longer attached.
    writer.note(false, { x: 2000, y: -200 }, { width: 1400, height: 900 });
    writer.save();

    const reader = new GeometryStore(dir);
    expect(reader.restore([LAPTOP])).toBeNull();
  });

  it("restore() is silent on a missing file", () => {
    const store = new GeometryStore(dir);
    expect(store.restore([LAPTOP])).toBeNull();
  });

  it("restore() is silent on a malformed file", () => {
    fs.writeFileSync(path.join(dir, "window.json"), "{not json");
    const store = new GeometryStore(dir);
    expect(store.restore([LAPTOP])).toBeNull();
  });

  it("restore() refuses a pre-migration Tauri window.json instead of misreading physical px as DIP", () => {
    fs.writeFileSync(
      path.join(dir, "window.json"),
      JSON.stringify({ x: 10, y: 10, width: 900, height: 600 }),
    );
    const store = new GeometryStore(dir);
    expect(store.restore([LAPTOP])).toBeNull();
  });

  it("seeds the cache on a successful restore, so a quit with no move/resize still saves it", () => {
    const writer = new GeometryStore(dir);
    writer.note(false, { x: 10, y: 10 }, { width: 900, height: 600 });
    writer.save();

    const reader = new GeometryStore(dir);
    reader.restore([LAPTOP]);
    // Nothing was ever noted on `reader` directly — if restore() hadn't
    // seeded the cache, this save() would be a no-op and the file would be
    // left untouched (it already holds the same value here, so re-write it
    // with a screen change to prove the cache, not the old file, was used).
    fs.rmSync(path.join(dir, "window.json"));
    reader.save();
    const written = JSON.parse(fs.readFileSync(path.join(dir, "window.json"), "utf8"));
    expect(written).toEqual({ v: 1, x: 10, y: 10, width: 900, height: 600 });
  });
});
