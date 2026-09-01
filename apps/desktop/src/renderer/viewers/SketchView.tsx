import type { ReactElement } from "react";
import {
  type Ink,
  type Point,
  type SketchElement,
  HANDLES,
  type Rect,
  handleAt,
  type Ordering,
} from "./sketch/model";
import { Drawn } from "./SketchElements";
import "./sketch.css";

/**
 * The drawing page.
 *
 * A `.sketch` file is a document both a person and the room's drawing agent
 * write to, so this editor has two jobs the app's other viewers do not: it
 * saves continuously (there is no Save button on a drawing), and it accepts
 * edits arriving from outside while the user is mid-stroke.
 *
 * Everything is SVG. There is no `<canvas>` anywhere in this app and adding
 * one here would mean a second rendering path for the same document — the
 * exported file and the picture the agent looks at are drawn by Rust from the
 * same geometry this component draws, and keeping both in SVG is what lets
 * them agree.
 */

export type Tool = "select" | "pen" | "rect" | "ellipse" | "arrow" | "text" | "eraser";
export type CanvasTool = "pen" | "rect" | "ellipse" | "arrow";
export type PointerDownMode = "ignore" | "pan" | "text" | "erase" | "select" | "draw";
export type PointerMoveMode =
  | "pan"
  | "erase"
  | "resize"
  | "marquee"
  | "drag"
  | "draw"
  | "idle";
export type KeyAction =
  | {
      kind:
        | "zoom-in"
        | "zoom-out"
        | "fit"
        | "undo"
        | "redo"
        | "select-all"
        | "duplicate";
    }
  | { kind: "order"; where: Ordering }
  | { kind: "nudge"; dx: number; dy: number }
  | { kind: "tool"; tool: Tool }
  | { kind: "delete" };

export const TOOLS: Array<{
  key: Tool;
  label: string;
  hint: string;
  icon: ReactElement;
}> = [
  {
    key: "select",
    label: "Select",
    hint: "Select · V",
    icon: <path d="M6.5 4.5 18 12l-5 1.2L10.5 18z" />,
  },
  {
    key: "pen",
    label: "Pen",
    hint: "Pen · P",
    icon: <path d="M14.8 4.9l4.3 4.3L9.6 18.7l-5 .7.7-5z" />,
  },
  {
    key: "rect",
    label: "Box",
    hint: "Box · R",
    icon: <rect x="4.5" y="6" width="15" height="12" rx="1.5" />,
  },
  {
    key: "ellipse",
    label: "Ellipse",
    hint: "Ellipse · O",
    icon: <ellipse cx="12" cy="12" rx="7.5" ry="6" />,
  },
  {
    key: "arrow",
    label: "Arrow",
    hint: "Arrow · A",
    icon: <path d="M5 18.5 18.5 5.5M18.5 12V5.5H12" />,
  },
  {
    key: "text",
    label: "Note",
    hint: "Note · T",
    icon: <path d="M5.5 7V5h13v2M12 5v14M9.5 19h5" />,
  },
  {
    key: "eraser",
    label: "Eraser",
    hint: "Eraser · E",
    icon: (
      <path d="m8.5 18.5-4-4a1.6 1.6 0 0 1 0-2.3l7.2-7.2a1.6 1.6 0 0 1 2.3 0l4.5 4.5a1.6 1.6 0 0 1 0 2.3l-6.7 6.7zM6 20h13" />
    ),
  },
];

export const KEY_TOOL: Record<string, Tool> = {
  v: "select",
  p: "pen",
  r: "rect",
  o: "ellipse",
  a: "arrow",
  t: "text",
  e: "eraser",
};

export const META_SHORTCUTS: Record<string, KeyAction> = {
  "=": { kind: "zoom-in" },
  "+": { kind: "zoom-in" },
  "-": { kind: "zoom-out" },
  "0": { kind: "fit" },
  z: { kind: "undo" },
  "shift:z": { kind: "redo" },
  a: { kind: "select-all" },
  d: { kind: "duplicate" },
  "]": { kind: "order", where: "forward" },
  "shift:]": { kind: "order", where: "front" },
  "[": { kind: "order", where: "backward" },
  "shift:[": { kind: "order", where: "back" },
};

export const NUDGE_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export const CHIP_STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

export function pointerDownMode(
  button: number,
  spaceHeld: boolean,
  tool: Tool,
): PointerDownMode {
  if (button !== 0 && button !== 1) return "ignore";
  if (spaceHeld || button === 1) return "pan";
  return pointerToolMode(tool);
}

export function pointerToolMode(tool: Tool): PointerDownMode {
  if (tool === "text") return "text";
  if (tool === "eraser") return "erase";
  if (tool === "select") return "select";
  return "draw";
}

export function activePointerMoveMode(
  panning: boolean,
  erasing: boolean,
  resizing: boolean,
  marqueeing: boolean,
): PointerMoveMode | null {
  if (panning) return "pan";
  if (erasing) return "erase";
  if (resizing) return "resize";
  if (marqueeing) return "marquee";
  return null;
}

export function drawingPointerMoveMode(
  dragging: boolean,
  selected: boolean,
  drawing: boolean,
  anchored: boolean,
): PointerMoveMode {
  if (dragging && selected) return "drag";
  if (drawing && anchored) return "draw";
  return "idle";
}

export function previewFor(
  tool: CanvasTool,
  at: Point,
  ink: Ink,
  fill: boolean,
): SketchElement {
  const base = { id: "preview", ink };
  if (tool === "pen") return { ...base, type: "pen", points: [at, at] };
  if (tool === "arrow") return { ...base, type: "arrow", points: [at, at] };
  return { ...base, type: tool, x: at[0], y: at[1], w: 1, h: 1, fill };
}

export function pointerPreviewEvents(
  ev: React.PointerEvent,
  tool: Tool,
): PointerEvent[] {
  if (tool !== "pen") return [ev.nativeEvent];
  if (typeof ev.nativeEvent.getCoalescedEvents !== "function")
    return [ev.nativeEvent];
  return ev.nativeEvent.getCoalescedEvents();
}

export function metaShortcut(event: KeyboardEvent): KeyAction | null {
  const prefix = event.shiftKey ? "shift:" : "";
  return META_SHORTCUTS[`${prefix}${event.key.toLowerCase()}`] ?? null;
}

export function plainShortcut(event: KeyboardEvent): KeyAction | null {
  const move = NUDGE_KEYS[event.key];
  if (move) return { kind: "nudge", dx: move[0], dy: move[1] };
  const tool = KEY_TOOL[event.key.toLowerCase()];
  if (tool) return { kind: "tool", tool };
  if (event.key === "Backspace" || event.key === "Delete")
    return { kind: "delete" };
  return null;
}

export function shortcutFor(event: KeyboardEvent): KeyAction | null {
  if (event.metaKey || event.ctrlKey) return metaShortcut(event);
  if (event.altKey) return null;
  return plainShortcut(event);
}

export function nextChipIndex(key: string, at: number, count: number): number {
  const step = CHIP_STEPS[key];
  if (step) return Math.min(count - 1, Math.max(0, at + step));
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return -1;
}

export function activeElementIsTextField(): boolean {
  const element = document.activeElement;
  if (!element) return false;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}

export function keyboardLeavesPageAlone(page: HTMLElement | null): boolean {
  if (activeElementIsTextField()) return true;
  return !keysAreForThePage(page);
}

/** The dotted paper's spacing, matching `--grid-gap` on the app's own sheet. */
export const GRID_GAP = 22;

/** How long the canvas has to be still before a save goes out.
 *
 * Long enough that a burst of strokes is one write, short enough that nobody
 * loses work by closing a tab. The unmount flush covers the gap. */
export const SAVE_IDLE_MS = 1400;

/** How long after a write that FAILED the drawing tries again, and the ceiling
 * the backoff stops doubling at.
 *
 * A canvas has no Save button, so a failed save has no way back to disk unless
 * it asks for itself: before this the footer said "Couldn't save" and nothing
 * whatsoever happened afterwards. */
export const SAVE_RETRY_MS = 2000;
export const SAVE_RETRY_MAX_MS = 30000;

/** How far in and out the page can be taken. Past 6x a stroke is wider than
 * the pane; below 0.3x a label is smaller than the dots behind it. */
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 6;

/** How long each agent-drawn shape waits before it appears. */
export const REVEAL_STEP_MS = 260;
/** The pace target: the reveal aims to finish inside this, and does until the
 * floor below binds at ~100 elements — past that it stretches (400 shapes take
 * about 16 s, against 104 s at one full step each). */
export const REVEAL_BUDGET_MS = 4000;
/** …but never so fast that the staging is indistinguishable from a single
 * repaint, which would spend the animation and buy nothing. */
export const REVEAL_MIN_STEP_MS = 40;
/** How long the agent's new elements stay marked as theirs after the last one
 * lands. */
export const FRESH_HOLD_MS = 1400;

export interface Props {
  fileId: string;
  text: string;
}

export type SaveState = "saved" | "saving" | "failed";
export type View = { x: number; y: number; k: number };

export function When({ show, children }: { show: boolean; children: ReactElement }) {
  return show ? children : null;
}

export function chosenElement(elements: SketchElement[]): SketchElement | null {
  return elements.length === 1 ? elements[0] : null;
}

export function canvasDescription(
  elements: SketchElement[],
  selected: string[],
): string {
  if (!elements.length) return "Drawing canvas, empty";
  const plural = elements.length === 1 ? "" : "s";
  const selection = selected.length ? `, ${selected.length} selected` : "";
  return `Drawing canvas, ${elements.length} object${plural}${selection}`;
}

export function saveLabel(state: SaveState): string {
  if (state === "saved") return "Saved";
  return state === "saving" ? "Saving…" : "Not saved";
}

export function arrangeTitle(count: number): string {
  return count ? "Arrange the selection" : "Select something first";
}

export function toolClass(sticky: boolean, selected: boolean): string {
  return `sk-tool${sticky && selected ? " sk-locked-tool" : ""}`;
}

export function toolTitle(active: boolean, sticky: boolean, hint: string): string {
  if (active && sticky)
    return `${hint} · staying on — click any tool or press Escape to stop`;
  return `${hint} · double-click to keep it on`;
}

export function lockActionName(elements: SketchElement[]): string {
  return elements.some((element) => !element.locked)
    ? "Lock in place"
    : "Unlock";
}

export function canvasClass(spaceHeld: boolean, panning: boolean): string {
  return `sk-canvas${spaceHeld || panning ? " sk-panning" : ""}`;
}

export function objectStripClass(open: boolean): string {
  return `sk-objects${open ? " sk-objects-open" : ""}`;
}

export function objectStripTitle(open: boolean): string {
  return open ? "Back to a single row" : "Show every object at once";
}

export function pluralSuffix(count: number): string {
  return count === 1 ? "" : "s";
}

export function labelValue(element: SketchElement | null): string {
  if (!element) return "";
  if (element.type === "text") return element.text;
  return element.label || "";
}

export function footerHint(sticky: boolean, tool: Tool, empty: boolean): string {
  if (sticky)
    return `${TOOLS.find((item) => item.key === tool)?.label || "This tool"} stays on — Escape or another tool to stop`;
  return empty
    ? "Pick a tool and draw — or ask the room's AI to draw it for you."
    : "Click to select · drag a box around several · ⌘Z to undo";
}

export function saveMessage(note: string | null, word: string): string {
  return note || word;
}

export function PreviewElement({ preview }: { preview: SketchElement | null }) {
  if (!preview) return null;
  return <Drawn el={preview} selected={false} fresh={false} />;
}

export function MarqueeOverlay({ marquee }: { marquee: Rect | null }) {
  if (!marquee) return null;
  return (
    <rect
      className="sk-marquee"
      x={marquee.x}
      y={marquee.y}
      width={marquee.w}
      height={marquee.h}
    />
  );
}

export function SelectionOverlay({
  box,
  tool,
  picked,
  view,
}: {
  box: Rect | null;
  tool: Tool;
  picked: SketchElement[];
  view: View;
}) {
  if (!box || tool !== "select") return null;
  if (picked.some((element) => element.locked))
    return <SelectionBox box={box} />;
  return <SelectionBox box={box} handles view={view} />;
}

export function SelectionBox({
  box,
  handles = false,
  view = { x: 0, y: 0, k: 1 },
}: {
  box: Rect;
  handles?: boolean;
  view?: View;
}) {
  const outer = { x: box.x - 6, y: box.y - 6, w: box.w + 12, h: box.h + 12 };
  return (
    <g className="sk-sel" aria-hidden="true">
      <rect
        className="sk-sel-box"
        x={outer.x}
        y={outer.y}
        width={outer.w}
        height={outer.h}
      />
      <When show={handles}>
        <SelectionHandles box={outer} scale={view.k} />
      </When>
    </g>
  );
}

export function SelectionHandles({ box, scale }: { box: Rect; scale: number }) {
  const radius = 5 / scale;
  return (
    <>
      {HANDLES.map((handle) => {
        const [x, y] = handleAt(box, handle);
        return (
          <rect
            key={handle}
            className={`sk-grip sk-grip-${handle}`}
            x={x - radius}
            y={y - radius}
            width={radius * 2}
            height={radius * 2}
          />
        );
      })}
    </>
  );
}

/** Is a key pressed on `window` meant for the drawing?
 *
 * Three of this page's handlers listen on `window`, because the canvas is an
 * SVG and cannot hold focus — and the sketch is the CENTRE pane, with the
 * sidebar and the assistant beside it and focusable buttons in both. `body`
 * (or nothing) counts as the drawing: clicking the canvas focuses no element
 * at all, which is the ordinary way to be drawing. */
export function keysAreForThePage(page: HTMLElement | null): boolean {
  const el = document.activeElement;
  const focused = el && el !== document.body ? el : null;
  return !focused || !!page?.contains(focused);
}

/* No `saveEdit`. Every other viewer saves through the shell's shared handler,
 * which calls `update_file_content` — right for a document with a Save button,
 * and far too heavy for a canvas that writes several times a minute. A drawing
 * saves itself through `api.saveSketch`; see that command for what it does not
 * do on every stroke. */

import { useSketchBase } from "./sketchControllerBase";
import { useSketchGestures } from "./sketchGestures";
import { useSketchActions } from "./sketchActions";
import { SketchSurface } from "./SketchSurface";

export default function SketchView(props: Props) {
  const base = useSketchBase(props);
  const gestures = useSketchGestures(base);
  const actions = useSketchActions(gestures);
  return <SketchSurface actions={actions} />;
}
