/**
 * Where the window was, and how big — remembered between launches.
 *
 * Every launch reopened at the configured 1180×780 in the default position, no
 * matter how the user had it arranged. For a workspace app people keep open
 * all day on a large display that is a chore repeated every single time.
 *
 * Kept per-Mac, beside the connector preference files and outside every room:
 * a window rectangle is a fact about this machine's screens, not about the
 * room, and nothing about it may travel inside a `.roomai`.
 *
 * WHY NOT an off-the-shelf window-state restorer: it would be a new
 * dependency for ~60 lines of arithmetic, and it restores state the app has
 * no way to sanity-check. The one thing that MUST be checked is the case that
 * makes this feature worse than not having it: a window remembered on a
 * monitor that is no longer attached opens off-screen, where it cannot be
 * moved, resized or closed.
 *
 * Boundary (same one `quitDoor.ts` draws around `app.on(...)`): this file
 * owns every bit of logic and disk I/O that the Rust module owned itself —
 * `geometryIsUsable`, the note/save/restore decisions, reading and writing
 * `window.json` — using only Node built-ins, no `electron` import. Actually
 * calling `BrowserWindow#on("move"|"resize", ...)`, `app.on("will-quit", ...)`,
 * and applying the restored rectangle to a real `BrowserWindow` is main-process
 * wiring for the not-yet-built `index.ts`, exactly as `note_geometry`/
 * `save_geometry`/`restore_geometry` are themselves just functions that
 * `lib.rs` — not `window_geometry.rs` — calls from real window/app events.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * The remembered rectangle. Tauri's `window.json` held physical pixels (what
 * tao reported); this one deliberately holds DIP, which is what
 * `screen.getAllDisplays()` reports — see `GEOMETRY_SCHEMA_VERSION`.
 */
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A monitor's own rectangle, in the same coordinate space: [x, y, width, height]. */
export type Screen = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
];

/** The minimums from the window config (`minWidth`/`minHeight`). A remembered
 * size below them is a corrupt or hand-edited file, not a user preference. */
export const MIN_W = 900;
export const MIN_H = 600;

/** How much of the title bar has to land on a real screen for the window to be
 * reachable. Enough to grab and drag, not so much that a deliberately
 * half-off-screen window is refused. */
export const GRABBABLE = 80;

/** The largest value that fits in Rust's `i32`, which is what `x`/`y` values
 * (and `width`/`height` once converted) are reasoned about as on the Rust
 * side. A saved or reported dimension beyond this cannot be reasoned about
 * safely (it would wrap in the original arithmetic), so it is treated as
 * unusable rather than reasoned about anyway. */
const I32_MAX = 2147483647;
const I32_MIN = -2147483648;
/** The largest value that fits in Rust's `u32`, which is what `width`/`height`
 * are typed as on the Rust side before ever reaching this arithmetic. */
const U32_MAX = 4294967295;

function isValidI32(n: number): boolean {
  return Number.isInteger(n) && n >= I32_MIN && n <= I32_MAX;
}

function isValidU32(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= U32_MAX;
}

/**
 * Can this remembered rectangle actually be USED on the screens attached now?
 *
 * This is the whole reason for hand-rolling the feature. Restoring a window
 * onto a monitor that has since been unplugged — or onto a docked display the
 * laptop is no longer docked to — puts it somewhere the user cannot see, drag
 * or close, and the app looks like it failed to launch. Refusing to restore
 * is always recoverable; restoring off-screen is not.
 */
export function geometryIsUsable(
  g: Geometry,
  screens: readonly Screen[],
): boolean {
  if (g.width < MIN_W || g.height < MIN_H) {
    return false;
  }
  // A degenerate saved width would wrap when added; treat any rectangle we
  // cannot reason about as unusable rather than reasoning about it anyway.
  if (g.width > I32_MAX) {
    return false;
  }
  const w = g.width;
  // Only the TITLE BAR matters. A window can hang off the bottom or the right
  // of a screen and still be perfectly usable; what makes it unrecoverable is
  // having nothing left to grab.
  return screens.some(([sx, sy, sw, sh]) => {
    if (sw > I32_MAX || sh > I32_MAX) {
      return false;
    }
    const overlapX = Math.min(g.x + w, sx + sw) - Math.max(g.x, sx);
    return g.y >= sy - 1 && g.y < sy + sh && overlapX >= GRABBABLE;
  });
}

/**
 * Where the remembered geometry is kept on disk, beside the app's other
 * per-machine preference files (Rust's `geometry_file`, minus the
 * `create_dir_all` side effect — callers that write go through
 * `GeometryStore`, which creates the directory itself).
 */
export function saveGeometryPath(userDataDir: string): string {
  return path.join(userDataDir, "window.json");
}

/**
 * The on-disk schema version. `screen.getAllDisplays()` reports `bounds` in
 * DIP, not the physical pixels tao/tauri reported and `window.json` used to
 * hold — a deliberate unit change, not a compatible one. A file with no `v`
 * field (or the wrong one) is, most likely, the old Tauri app's physical-pixel
 * `window.json` left behind by the migration; reading its numbers as DIP
 * would restore the wrong rectangle, especially on a Retina display where the
 * two units differ by 2x. Bumping this discards it cleanly instead.
 */
const GEOMETRY_SCHEMA_VERSION = 1;

/**
 * Parse geometry read back from `window.json`. Mirrors what
 * `serde_json::from_str::<Geometry>` gets Rust for free: `x`/`y` must fit an
 * `i32` and `width`/`height` an unsigned `u32`, and all four must be whole
 * numbers — a fractional or out-of-range field is exactly as much a "corrupt
 * file" as a missing one — plus the schema-version check above, which Rust
 * never needed because it only ever had one file format. Any failure returns
 * `null`, never throws: a bad file must read as "nothing saved", not crash
 * the caller.
 */
function parseJsonRecord(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : null;
}

function geometryNumbers(value: Record<string, unknown>): Geometry | null {
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  return { x, y, width, height };
}

function validGeometryRange(geometry: Geometry): boolean {
  return (
    isValidI32(geometry.x) &&
    isValidI32(geometry.y) &&
    isValidU32(geometry.width) &&
    isValidU32(geometry.height)
  );
}

function geometryFromRecord(value: Record<string, unknown>): Geometry | null {
  if (value.v !== GEOMETRY_SCHEMA_VERSION) return null;
  const geometry = geometryNumbers(value);
  return geometry !== null && validGeometryRange(geometry) ? geometry : null;
}

export function parseGeometry(raw: string): Geometry | null {
  const value = parseJsonRecord(raw);
  return value === null ? null : geometryFromRecord(value);
}

/**
 * The last geometry seen from a window event, and the `window.json` file
 * beside it. Rust kept the cache as a process-global
 * `OnceLock<Mutex<Option<Geometry>>>` (`last_seen()`, window_geometry.rs:32-35)
 * because tao's event loop and the command handlers are different threads;
 * Node's main process is single-threaded, so a plain instance field does the
 * same job without the lock.
 */
export class GeometryStore {
  private lastSeen: Geometry | null = null;

  constructor(private readonly userDataDir: string) {}

  private filePath(): string {
    return saveGeometryPath(this.userDataDir);
  }

  /**
   * Remember the rectangle a window event just reported. Cheap by design:
   * this runs on every move and resize (window_geometry.rs:84-105).
   *
   * `fullscreen` follows Rust's `is_fullscreen().unwrap_or(false)` — a
   * caller unable to tell should pass `false`, the same "assume not
   * fullscreen" default. `position`/`size` are `null` when the caller
   * couldn't read them (Rust's `outer_position()`/`inner_size()` both
   * returning `Err`); either being `null` skips the note entirely, leaving
   * the last known-good rectangle as the one that gets written on the way
   * out.
   *
   * Full screen is NOT a rectangle worth remembering: entering it reports
   * the whole display, and quitting from there would relaunch the app as a
   * display-sized window parked in the corner, with the arrangement the
   * user actually chose overwritten and gone.
   */
  note(
    fullscreen: boolean,
    position: { x: number; y: number } | null,
    size: { width: number; height: number } | null,
  ): void {
    if (fullscreen) {
      return;
    }
    if (position === null || size === null) {
      return;
    }
    this.lastSeen = {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    };
  }

  /**
   * Write what was last seen. Best-effort: failing to remember a window
   * position must never be able to fail a quit (window_geometry.rs:107-117).
   * No-op if nothing has been noted yet, same as Rust's `let Some(g) = ...
   * else { return; }`.
   */
  save(): void {
    if (this.lastSeen === null) {
      return;
    }
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      const onDisk = { v: GEOMETRY_SCHEMA_VERSION, ...this.lastSeen };
      fs.writeFileSync(this.filePath(), JSON.stringify(onDisk));
    } catch {
      // Best-effort, same as the Rust `let _ = std::fs::write(...)`.
    }
  }

  /**
   * Put the window back where it was, if that is still somewhere it can be
   * used. Silent on every failure — a missing, unreadable, malformed or
   * unusable file means "open at the configured default", which is exactly
   * the old behaviour (window_geometry.rs:119-151).
   *
   * `screens` are the attached monitors' rectangles, caller-supplied (same
   * boundary `geometryIsUsable` already draws) — in Electron these come from
   * `screen.getAllDisplays()`, whose `bounds` are DIP, not physical pixels
   * like tao reported; that unit change is deliberate and is why a
   * `window.json` written by the old Tauri app must not be read here as-is.
   *
   * Returns the geometry to apply, or `null` to leave the configured
   * default alone. Actually calling `BrowserWindow#setBounds` is main-process
   * wiring left to the caller. On success, seeds the cache so quitting
   * without ever moving the window still rewrites the same rectangle rather
   * than dropping it.
   */
  restore(screens: readonly Screen[]): Geometry | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath(), "utf8");
    } catch {
      return null;
    }
    const g = parseGeometry(raw);
    if (g === null || !geometryIsUsable(g, screens)) {
      return null;
    }
    this.lastSeen = g;
    return g;
  }
}
