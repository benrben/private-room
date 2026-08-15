import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { api } from "../api";
import { prefersReducedMotion } from "../rooms/helpers";
import { setSketchFocus } from "../workspace/sketchFocus";
import "./sketch.css";
import {
  CANVAS_H,
  CANVAS_W,
  INKS,
  type Ink,
  type Point,
  type Sketch,
  type SketchElement,
  arrowHead,
  bboxOf,
  ellipsePath,
  emptyHistory,
  hitTest,
  mergeAgentDoc,
  nextId,
  parseSketch,
  pushHistory,
  rectPath,
  redo,
  seeded,
  serializeSketch,
  strokeFromTrail,
  strokePath,
  translate,
  undo,
  HANDLES,
  type Handle,
  type Rect,
  align,
  bboxOfMany,
  canConnect,
  chipLabel,
  describeElement,
  distribute,
  duplicate,
  fitToBox,
  guidesFor,
  handleAt,
  historyHint,
  hitTestArea,
  reflow,
  reorder,
  resizedBox,
  routeBetween,
  snapTo,
  type AlignEdge,
  type Guide,
  type Ordering,
} from "./sketch/model";

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

type Tool = "select" | "pen" | "rect" | "ellipse" | "arrow" | "text" | "eraser";

const TOOLS: Array<{ key: Tool; label: string; hint: string; icon: ReactElement }> = [
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
    icon: <path d="m8.5 18.5-4-4a1.6 1.6 0 0 1 0-2.3l7.2-7.2a1.6 1.6 0 0 1 2.3 0l4.5 4.5a1.6 1.6 0 0 1 0 2.3l-6.7 6.7zM6 20h13" />,
  },
];

const KEY_TOOL: Record<string, Tool> = {
  v: "select",
  p: "pen",
  r: "rect",
  o: "ellipse",
  a: "arrow",
  t: "text",
  e: "eraser",
};

/** The dotted paper's spacing, matching `--grid-gap` on the app's own sheet. */
const GRID_GAP = 22;

/** How long the canvas has to be still before a save goes out.
 *
 * Long enough that a burst of strokes is one write, short enough that nobody
 * loses work by closing a tab. The unmount flush covers the gap. */
const SAVE_IDLE_MS = 1400;

/** How far in and out the page can be taken. Past 6x a stroke is wider than
 * the pane; below 0.3x a label is smaller than the dots behind it. */
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 6;

/** How long each agent-drawn shape waits before it appears. */
const REVEAL_STEP_MS = 260;
/** The pace target: the reveal aims to finish inside this, and does until the
 * floor below binds at ~100 elements — past that it stretches (400 shapes take
 * about 16 s, against 104 s at one full step each). */
const REVEAL_BUDGET_MS = 4000;
/** …but never so fast that the staging is indistinguishable from a single
 * repaint, which would spend the animation and buy nothing. */
const REVEAL_MIN_STEP_MS = 40;
/** How long the agent's new elements stay marked as theirs after the last one
 * lands. */
const FRESH_HOLD_MS = 1400;

interface Props {
  fileId: string;
  text: string;
}

/* No `saveEdit`. Every other viewer saves through the shell's shared handler,
 * which calls `update_file_content` — right for a document with a Save button,
 * and far too heavy for a canvas that writes several times a minute. A drawing
 * saves itself through `api.saveSketch`; see that command for what it does not
 * do on every stroke. */
export default function SketchView({ fileId, text }: Props) {
  const initial = useMemo(() => parseSketch(text), [text]);
  const [doc, setDoc] = useState<Sketch>(initial.doc);
  const [history, setHistory] = useState(emptyHistory());
  // SELECT, not Pen. Opening a document must not put the canvas in a mode
  // where the first click changes it: every sketch used to open ready to draw,
  // so panning around someone's diagram left marks on it.
  const [tool, setTool] = useState<Tool>("select");
  /** Stay in the current tool after making one thing. Off by default — a tool
   * that keeps drawing is the exception people ask for, not the resting
   * state — and double-clicking a tool button turns it on. */
  const [sticky, setSticky] = useState(false);
  const [ink, setInk] = useState<Ink>("blue");
  const [fill, setFill] = useState(false);
  /** WHAT IS SELECTED — several things, in the order they were picked.
   *
   * An array rather than a Set so the inspector can name "3 things" and the
   * arrange actions have a stable order to work in; small enough that the
   * membership tests below cost nothing. */
  const [selected, setSelected] = useState<string[]>([]);
  /** Whether dragging snaps to other shapes and to the paper's dots. */
  const [snap, setSnap] = useState(true);
  /** The alignment lines to draw right now — live, only during a drag. */
  const [guides, setGuides] = useState<Guide[]>([]);
  /** The marquee being dragged, in canvas units. */
  const [marquee, setMarquee] = useState<Rect | null>(null);
  /** Which toolbar popover is open. One at a time, like the room's toolbar. */
  const [menu, setMenu] = useState<"arrange" | "export" | "zoom" | "ink" | null>(null);
  /** Whether the object strip shows every object at once or a single row. */
  const [stripOpen, setStripOpen] = useState(false);
  /** Whether a text field on this page owns the keyboard right now. */
  const [typing, setTyping] = useState(false);
  /** The shape a connector being drawn started on, if it started on one. */
  const connectFrom = useRef<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">("saved");
  const [note, setNote] = useState<string | null>(initial.error);
  /** Ids the agent just added, revealed one at a time. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const svgRef = useRef<SVGSVGElement | null>(null);
  /** Each object's chip in the strip below, so the selected one can be brought
   * back into a row that scrolls sideways. */
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  /** The live selection, for handlers that must not re-register per change. */
  const selectedRef = useRef<string[]>([]);
  /** …and the same for the open menu and the armed tool, both read by the
   * capture-phase Escape listener below. */
  const menuRef = useRef<string | null>(null);
  const toolRef = useRef<Tool>("select");
  const docRef = useRef(doc);
  docRef.current = doc;
  selectedRef.current = selected;
  menuRef.current = menu;
  toolRef.current = tool;
  /** Advance the live document NOW, not at the next render.
   *
   * Several pointer events can arrive between two React renders, and each one
   * reads `docRef.current` to build the next document. Waiting for the render
   * means the second event of a fast swipe works from a document that still
   * contains what the first one removed — so an erased shape comes back, and a
   * drag loses the distance it already covered. */
  const advance = (next: Sketch) => {
    docRef.current = next;
    setDoc(next);
  };
  /** Set while a gesture is in flight, so an agent edit waits for pointer-up. */
  const drawingRef = useRef(false);
  const pendingAgent = useRef<{ doc: Sketch; added: string[]; removed: string[] } | null>(null);
  const saveTimer = useRef<number | null>(null);
  /** Every pending reveal timer, so a new drawing or an unmount can drop them. */
  const revealTimers = useRef<number[]>([]);
  const dirty = useRef(false);
  /** Version history is taken once per editing session, not once per stroke. */
  const snapshotted = useRef(false);

  // --- live gesture state (not React state: it changes per pointer event) ---
  const [preview, setPreview] = useState<SketchElement | null>(null);
  const trail = useRef<Point[]>([]);
  const anchor = useRef<Point | null>(null);
  const dragFrom = useRef<Point | null>(null);
  /** A resize in flight: which grip, the boxes it started from, and where the
   * pointer went down. Resizes are computed from the ORIGINAL box and the
   * TOTAL movement — see `resizedBox` for why accumulating deltas walks the
   * shape across the page. */
  const resizing = useRef<{
    handle: Handle;
    box: Rect;
    from: Point;
    els: SketchElement[];
  } | null>(null);
  /** Where a marquee started. */
  const marqueeFrom = useRef<Point | null>(null);
  const erasing = useRef(false);
  const capturedPointer = useRef<number | null>(null);
  /** Which part of the page is on screen: the top-left corner and the scale.
   *
   * Held as a viewBox rather than a CSS transform so `getScreenCTM` keeps
   * doing the coordinate maths for us — every pointer position stays correct
   * at any zoom with no conversion of our own to get wrong. */
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const panning = useRef<{ from: Point } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [textAt, setTextAt] = useState<Point | null>(null);
  const [textValue, setTextValue] = useState("");

  // ----------------------------------------------------------------- saving
  const flush = useCallback(
    async (next: Sketch) => {
      try {
        await api.saveSketch(fileId, serializeSketch(next), !snapshotted.current);
        snapshotted.current = true;
        dirty.current = false;
        setSaveState("saved");
      } catch {
        dirty.current = true;
        setSaveState("failed");
      }
    },
    [fileId],
  );

  const scheduleSave = useCallback(
    (next: Sketch) => {
      dirty.current = true;
      setSaveState("saving");
      // The note occupies the same slot as the save state, so it has to stand
      // down once the save state has something live to report.
      setNote(null);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(next), SAVE_IDLE_MS);
    },
    [flush],
  );

  /** Every change to the document goes through here: one undo entry, one save. */
  const commit = useCallback(
    (next: Sketch, opts: { undoable?: boolean } = {}) => {
      const before = docRef.current;
      if (opts.undoable !== false) setHistory((h) => pushHistory(h, before));
      setDoc(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  /** Drop every pending reveal timer AND un-hide whatever they were going to
   * reveal. Called before a new reveal starts and on unmount — up to one timer
   * per element were being created and cleared nowhere, so closing a tab
   * mid-reveal left them firing `setState` at a dead component.
   *
   * The two halves are one fact: cancelling the timers without clearing
   * `hidden` leaves elements permanently invisible, because the only thing
   * that would ever have shown them was the timer just cancelled. */
  const dropRevealTimers = useCallback(() => {
    for (const t of revealTimers.current) window.clearTimeout(t);
    revealTimers.current = [];
  }, []);
  const clearReveal = useCallback(() => {
    dropRevealTimers();
    setHidden(new Set());
  }, [dropRevealTimers]);

  // A drawing has no Save button, so an unmount mid-debounce is the one moment
  // work can be lost. Flush it.
  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      // Timers only, not `clearReveal`: there is no component left to un-hide
      // anything in.
      dropRevealTimers();
      // The one moment work can be lost: unmounting inside the idle window.
      if (dirty.current) {
        void api.saveSketch(fileId, serializeSketch(docRef.current), !snapshotted.current);
      }
    },
    [fileId, dropRevealTimers],
  );

  // ------------------------------------------------- the agent drawing here
  const applyAgent = useCallback((theirs: Sketch, added: string[], removed: string[]) => {
    const { doc: merged, unsavedKept } = mergeAgentDoc(docRef.current, theirs, removed);
    setDoc(merged);
    if (unsavedKept.length) {
      // The user's own unsaved work survived the merge, but it is NOT in the
      // file the agent wrote — so it has to be written back or the next reload
      // loses it.
      scheduleSave(merged);
    }
    if (!added.length) return;

    // A second drawing arriving mid-reveal must not leave the first one's
    // timers running: they would un-hide ids from a set that has been replaced.
    clearReveal();

    // Reduced motion means the drawing arrives WHOLE. The stylesheet can only
    // switch off the colour fade; the staging is JS, so without this a reader
    // who asked for less motion instead watched a diagram assemble itself —
    // and, for a large one, sat in front of a half-drawn picture for a minute.
    // Reduced motion must never mean reduced information. `fresh` still marks
    // what the agent added (its animation is what the CSS turns off), so the
    // attribution survives; only the staging goes.
    if (prefersReducedMotion()) {
      setFresh(new Set(added));
      revealTimers.current.push(
        window.setTimeout(() => setFresh(new Set()), FRESH_HOLD_MS),
      );
      return;
    }

    // Reveal in the order the agent drew them, inside a fixed budget: at one
    // step per element a 400-shape diagram took over a minute and a half to
    // finish appearing, with the page unusable-looking throughout. The floor
    // keeps a big drawing from flickering in as a single frame.
    const step = Math.max(
      REVEAL_MIN_STEP_MS,
      Math.min(REVEAL_STEP_MS, Math.floor(REVEAL_BUDGET_MS / added.length)),
    );
    setHidden(new Set(added));
    setFresh(new Set(added));
    added.forEach((id, i) => {
      revealTimers.current.push(
        window.setTimeout(() => {
          setHidden((h) => {
            const n = new Set(h);
            n.delete(id);
            return n;
          });
        }, i * step),
      );
    });
    revealTimers.current.push(
      window.setTimeout(() => setFresh(new Set()), added.length * step + FRESH_HOLD_MS),
    );
  }, [scheduleSave, clearReveal]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void api
      .onSketchDrawn((e) => {
        if (e.fileId !== fileId) return;
        const parsed = parseSketch(e.doc);
        if (parsed.error) {
          // The agent drew something and the document would not parse. This
          // returned in silence, so the drawing simply never appeared and the
          // room looked like it had ignored the request. `note` is this view's
          // own way of saying a document was not what it expected — the same
          // line a bad file shows on open.
          setNote(`The room drew something this page couldn't read: ${parsed.error}`);
          return;
        }
        // The note shares its slot with the save state (`{note ?? saveWord}`),
        // so a note that outlives its cause would silently mask "Saving…" and
        // "Couldn't save" from then on. A drawing that parses is the answer to
        // one that didn't.
        setNote(null);
        // Mid-stroke, the merge would fight the gesture. Hold it until the
        // pointer lifts rather than dropping either side's work.
        if (drawingRef.current) {
          pendingAgent.current = { doc: parsed.doc, added: e.added, removed: e.removed };
          return;
        }
        applyAgent(parsed.doc, e.added, e.removed);
      })
      .then((un) => {
        stop = un;
      });
    return () => stop?.();
  }, [fileId, applyAgent]);

  /** Zoom, keeping one canvas point pinned under the cursor.
   *
   * Anchoring is the whole difference between zoom that feels like a camera
   * and zoom that throws you across the page: the thing you pointed at is the
   * thing that stays still. */
  const zoomAt = useCallback((factor: number, at?: Point) => {
    setView((v) => {
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
      if (k === v.k) return v;
      const p = at ?? [v.x + docRef.current.width / v.k / 2, v.y + docRef.current.height / v.k / 2];
      // The point under the cursor must map to the same place afterwards.
      return { k, x: p[0] - (p[0] - v.x) * (v.k / k), y: p[1] - (p[1] - v.y) * (v.k / k) };
    });
  }, []);

  const fitPage = useCallback(() => setView({ x: 0, y: 0, k: 1 }), []);

  // A React onWheel handler is registered passively, so it cannot call
  // preventDefault — and without that, a pinch zooms the whole app instead of
  // the drawing. Attach it directly, non-passive.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const m = el.getScreenCTM();
      const at: Point | undefined = m
        ? (() => {
            const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
            return [p.x, p.y] as Point;
          })()
        : undefined;
      // macOS convention: a trackpad pinch arrives as a wheel event with
      // ctrlKey set, and a two-finger scroll as a plain one. Pinch zooms; the
      // scroll pans, which is what every other canvas on this machine does.
      if (ev.ctrlKey || ev.metaKey) {
        zoomAt(Math.exp(-ev.deltaY / 180), at);
      } else {
        setView((v) => ({ ...v, x: v.x + ev.deltaX / v.k, y: v.y + ev.deltaY / v.k }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Space is the hold-to-pan key everywhere else that draws; without it the
  // only way to move a zoomed page would be to scroll away from what you are
  // working on.
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping()) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    // A lost keyup (the window went away mid-hold) would leave the canvas
    // stuck in pan mode with no key to press to get out.
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ------------------------------------------------------------- pointer io
  const toCanvas = (ev: React.PointerEvent): Point => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    return [
      Math.round(Math.max(0, Math.min(CANVAS_W, p.x))),
      Math.round(Math.max(0, Math.min(CANVAS_H, p.y))),
    ];
  };

  /** Rub out whatever is under the pointer. One undo entry per swipe, not
   * one per shape — an eraser stroke is a single act to the person doing it. */
  const eraseAt = (p: Point, first: boolean) => {
    const hit = hitTest(docRef.current, p[0], p[1]);
    if (!hit) return;
    const next = {
      ...docRef.current,
      elements: docRef.current.elements.filter((e) => e.id !== hit.id),
    };
    if (first) {
      setHistory((h) => pushHistory(h, docRef.current));
    }
    advance(next);
    scheduleSave(next);
    setSelected([]);
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    // Middle button pans, so it must get past this guard.
    if (ev.button !== 0 && ev.button !== 1) return;
    commitText();
    const p = toCanvas(ev);

    // Hold space (or use the middle button) to move the page instead of
    // drawing on it.
    if (spaceHeld || ev.button === 1) {
      svgRef.current?.setPointerCapture?.(ev.pointerId);
      capturedPointer.current = ev.pointerId;
      panning.current = { from: p };
      return;
    }

    if (tool === "text") {
      setTextAt(p);
      setTextValue("");
      return;
    }
    // Capture on the SVG ROOT, never on `ev.target`.
    //
    // The target of a click on a shape is the `<path>` inside it — and the
    // eraser then deletes exactly that node. WebKit keeps the capture on the
    // removed element, and every later pointer event in the canvas is
    // delivered to something that is no longer in the document: the page looks
    // frozen, because nothing you do reaches the drawing any more (live QA
    // 2026-08-13, "when I erase it's stuck the app"). The root is never
    // removed, so capturing there cannot wedge.
    svgRef.current?.setPointerCapture?.(ev.pointerId);
    capturedPointer.current = ev.pointerId;

    if (tool === "eraser") {
      erasing.current = true;
      eraseAt(p, true);
      return;
    }
    if (tool === "select") {
      // A grip first: it sits on top of whatever it belongs to, so testing the
      // shape underneath would make the corner of a selected box un-grabbable.
      const grip = gripUnder(p);
      if (grip) {
        const els = docRef.current.elements.filter((e) => selected.includes(e.id));
        const box = bboxOfMany(els);
        if (box) {
          resizing.current = { handle: grip, box, from: p, els };
          return;
        }
      }
      const hit = hitTest(docRef.current, p[0], p[1]);
      if (hit?.locked) {
        // Locked is background. Clicking it starts a marquee over it rather
        // than selecting something the user cannot then do anything with.
        setSelected([]);
        marqueeFrom.current = p;
        return;
      }
      if (!hit) {
        if (!ev.shiftKey) setSelected([]);
        marqueeFrom.current = p;
        return;
      }
      // Shift adds and removes; a plain click on something already selected
      // keeps the whole selection, so a group can be dragged by any member.
      setSelected((cur) => {
        if (ev.shiftKey) {
          return cur.includes(hit.id) ? cur.filter((id) => id !== hit.id) : [...cur, hit.id];
        }
        return cur.includes(hit.id) ? cur : [hit.id];
      });
      dragFrom.current = p;
      return;
    }

    ev.preventDefault();
    drawingRef.current = true;
    anchor.current = p;
    if (tool === "pen") {
      trail.current = [p];
      setPreview({ id: "preview", type: "pen", points: [p, p], ink });
    } else if (tool === "arrow") {
      // An arrow that STARTS on a shape is a connector being drawn. Recording
      // it here — rather than guessing from the finished points — is what lets
      // a link survive the boxes moving later.
      const under = hitTest(docRef.current, p[0], p[1]);
      connectFrom.current = canConnect(under) ? under.id : null;
      setPreview({ id: "preview", type: "arrow", points: [p, p], ink });
    } else {
      setPreview({ id: "preview", type: tool, x: p[0], y: p[1], w: 1, h: 1, ink, fill });
    }
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    if (panning.current) {
      // Measured in CANVAS units against the pan's own start point, so the
      // page tracks the cursor exactly however far it is zoomed in.
      const p = toCanvas(ev);
      const dx = p[0] - panning.current.from[0];
      const dy = p[1] - panning.current.from[1];
      setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      return;
    }
    // Swiping the eraser over several things.
    if (erasing.current) {
      eraseAt(toCanvas(ev), false);
      return;
    }
    // Stretching the selection by one of its grips.
    if (resizing.current) {
      const { handle, box, from, els } = resizing.current;
      const p = toCanvas(ev);
      if (!drawingRef.current) {
        drawingRef.current = true;
        setHistory((h) => pushHistory(h, docRef.current));
      }
      const to = resizedBox(box, handle, p[0] - from[0], p[1] - from[1], ev.shiftKey);
      const moved = new Map(els.map((e) => [e.id, fitToBox(e, box, to)]));
      const next = reflow({
        ...docRef.current,
        elements: docRef.current.elements.map((e) => moved.get(e.id) ?? e),
      });
      advance(next);
      scheduleSave(next);
      return;
    }
    // Sweeping a marquee over the page.
    if (marqueeFrom.current) {
      const p = toCanvas(ev);
      const [ax, ay] = marqueeFrom.current;
      setMarquee({
        x: Math.min(ax, p[0]),
        y: Math.min(ay, p[1]),
        w: Math.abs(p[0] - ax),
        h: Math.abs(p[1] - ay),
      });
      return;
    }
    // Dragging the selection.
    if (dragFrom.current && selected.length) {
      const p = toCanvas(ev);
      let dx = p[0] - dragFrom.current[0];
      let dy = p[1] - dragFrom.current[1];
      if (!drawingRef.current && Math.hypot(dx, dy) < 3) return;
      if (!drawingRef.current) {
        drawingRef.current = true;
        setHistory((h) => pushHistory(h, docRef.current));
      }
      const picked = new Set(selected);
      const moving = docRef.current.elements.filter((e) => picked.has(e.id));
      // Snap the WHOLE selection by its own outer box, against everything it
      // is not — so three boxes dragged together line up as a block, and a
      // shape can never snap to itself.
      let landed: Guide[] = [];
      if (snap && !ev.altKey) {
        const box = bboxOfMany(moving);
        if (box) {
          const others = docRef.current.elements
            .filter((e) => !picked.has(e.id))
            .map((e) => bboxOf(e));
          const shifted = { ...box, x: box.x + dx, y: box.y + dy };
          const pull = guidesFor(shifted, others);
          if (pull.guides.length) {
            dx += pull.dx;
            dy += pull.dy;
            landed = pull.guides;
          } else {
            // Nothing to line up with, so fall back to the paper's own dots.
            dx = snapTo(box.x + dx) - box.x;
            dy = snapTo(box.y + dy) - box.y;
          }
        }
      }
      if (dx === 0 && dy === 0) {
        setGuides(landed);
        return;
      }
      dragFrom.current = [dragFrom.current[0] + dx, dragFrom.current[1] + dy];
      setGuides(landed);
      const next = reflow({
        ...docRef.current,
        elements: docRef.current.elements.map((e) =>
          picked.has(e.id) ? translate(e, dx, dy) : e,
        ),
      });
      advance(next);
      scheduleSave(next);
      return;
    }
    if (!drawingRef.current || !anchor.current) return;

    // A fast stroke on a high-refresh trackpad delivers several positions per
    // frame; taking only the event's own point drops most of the line.
    // `getCoalescedEvents` arrived in Safari 18.2 / macOS 15.2, so it is
    // feature-detected rather than assumed.
    const events =
      tool === "pen" && typeof ev.nativeEvent.getCoalescedEvents === "function"
        ? ev.nativeEvent.getCoalescedEvents()
        : [ev.nativeEvent];

    for (const raw of events) {
      const p = toCanvas({ clientX: raw.clientX, clientY: raw.clientY } as React.PointerEvent);
      if (tool === "pen") {
        const last = trail.current[trail.current.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 2) trail.current.push(p);
      } else if (tool === "arrow") {
        setPreview({ id: "preview", type: "arrow", points: [anchor.current, p], ink });
      } else {
        const [ax, ay] = anchor.current;
        setPreview({
          id: "preview",
          type: tool === "ellipse" ? "ellipse" : "rect",
          x: Math.min(ax, p[0]),
          y: Math.min(ay, p[1]),
          w: Math.abs(p[0] - ax),
          h: Math.abs(p[1] - ay),
          ink,
          fill,
        });
      }
    }
    if (tool === "pen") {
      setPreview({ id: "preview", type: "pen", points: [...trail.current], ink });
    }
  };

  const endGesture = (ev?: React.PointerEvent) => {
    const wasDrawing = drawingRef.current;
    drawingRef.current = false;
    dragFrom.current = null;
    erasing.current = false;
    panning.current = null;
    resizing.current = null;
    setGuides([]);

    // A marquee picks up everything it fully contains — and never anything
    // locked, because a lasso that quietly grabbed the background would then
    // move it.
    if (marqueeFrom.current) {
      marqueeFrom.current = null;
      const area = marquee;
      setMarquee(null);
      if (area && (area.w > 3 || area.h > 3)) {
        const inside = hitTestArea(docRef.current, area)
          .filter((e) => !e.locked)
          .map((e) => e.id);
        setSelected((cur) => (ev?.shiftKey ? [...new Set([...cur, ...inside])] : inside));
      }
      return;
    }
    if (capturedPointer.current !== null) {
      // `try` because releasing a pointer the element no longer holds throws,
      // and a throw here would skip everything below it — including the agent
      // edit that has been waiting for this gesture to finish.
      try {
        svgRef.current?.releasePointerCapture?.(capturedPointer.current);
      } catch {
        /* already released */
      }
      capturedPointer.current = null;
    }

    if (wasDrawing && preview && anchor.current) {
      const { id, seq } = nextId(docRef.current);
      let made: SketchElement | null = null;
      if (preview.type === "pen") {
        const points = strokeFromTrail(trail.current);
        if (points.length > 1) made = { ...preview, id, points };
      } else if (preview.type === "arrow") {
        const [a, b] = preview.points;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 8) {
          made = { ...preview, id };
          // Landing on a shape, having started on one, makes this a link
          // rather than a line that happens to sit between two boxes.
          const under = hitTest(docRef.current, b[0], b[1]);
          const from = connectFrom.current;
          if (from && canConnect(under) && under.id !== from) {
            const start = docRef.current.elements.find((e) => e.id === from);
            if (start) {
              const [p, q] = routeBetween(bboxOf(start), bboxOf(under));
              made = { ...made, from, to: under.id, points: [p, q] };
            }
          }
        }
      } else if (
        (preview.type === "rect" || preview.type === "ellipse") &&
        preview.w > 10 &&
        preview.h > 10
      ) {
        made = { ...preview, id };
      }
      if (made) {
        commit({
          ...docRef.current,
          seq,
          elements: [...docRef.current.elements, made],
        });
        setSelected([made.id]);
        // One shape, then back to Select. A tool that stays armed is how a
        // canvas collects marks nobody meant to make; double-clicking the
        // tool button is the way to ask for the other behaviour.
        if (!sticky) setTool("select");
      }
    }
    connectFrom.current = null;
    anchor.current = null;
    trail.current = [];
    setPreview(null);

    // An agent edit that arrived mid-gesture has been waiting for this.
    const held = pendingAgent.current;
    if (held) {
      pendingAgent.current = null;
      applyAgent(held.doc, held.added, held.removed);
    }
  };

  // ------------------------------------------------------------------- text
  const commitText = () => {
    if (!textAt) return;
    const words = textValue.trim();
    const at = textAt;
    setTextAt(null);
    setTextValue("");
    if (!words) return;
    const { id, seq } = nextId(docRef.current);
    commit({
      ...docRef.current,
      seq,
      elements: [
        ...docRef.current.elements,
        { id, type: "text", x: at[0], y: at[1], text: words, size: 30, ink },
      ],
    });
  };

  // --------------------------------------------------------------- commands
  const doUndo = useCallback(() => {
    const r = undo(history, docRef.current);
    if (!r) return;
    setHistory(r.history);
    setDoc(r.doc);
    scheduleSave(r.doc);
    setSelected([]);
  }, [history, scheduleSave]);

  const doRedo = useCallback(() => {
    const r = redo(history, docRef.current);
    if (!r) return;
    setHistory(r.history);
    setDoc(r.doc);
    scheduleSave(r.doc);
  }, [history, scheduleSave]);

  const deleteSelected = useCallback(() => {
    if (!selected.length) return;
    const picked = new Set(selected);
    // Reflowed, so a connector whose shape was just deleted drops its
    // attachment here rather than at the next unrelated edit.
    commit(
      reflow({
        ...docRef.current,
        elements: docRef.current.elements.filter((e) => !picked.has(e.id) || e.locked),
      }),
    );
    setSelected([]);
  }, [selected, commit]);

  /** The elements the selection names, in document order. */
  const chosenEls = useCallback(
    () => docRef.current.elements.filter((e) => selected.includes(e.id)),
    [selected],
  );

  const doAlign = useCallback(
    (edge: AlignEdge) => {
      const moved = new Map(align(chosenEls(), edge).map((e) => [e.id, e]));
      commit(
        reflow({
          ...docRef.current,
          elements: docRef.current.elements.map((e) => moved.get(e.id) ?? e),
        }),
      );
    },
    [chosenEls, commit],
  );

  const doDistribute = useCallback(
    (axis: "x" | "y") => {
      const moved = new Map(distribute(chosenEls(), axis).map((e) => [e.id, e]));
      commit(
        reflow({
          ...docRef.current,
          elements: docRef.current.elements.map((e) => moved.get(e.id) ?? e),
        }),
      );
    },
    [chosenEls, commit],
  );

  const doOrder = useCallback(
    (where: Ordering) => commit(reorder(docRef.current, selected, where)),
    [selected, commit],
  );

  const doDuplicate = useCallback(() => {
    const { doc: next, ids } = duplicate(docRef.current, selected);
    if (!ids.length) return;
    commit(next);
    setSelected(ids);
  }, [selected, commit]);

  const toggleLock = useCallback(() => {
    const picked = new Set(selected);
    if (!picked.size) return;
    // One question for the whole selection: if anything in it is loose,
    // locking is what the user means. A per-element toggle would leave a mixed
    // selection alternating on every press.
    const anyLoose = docRef.current.elements.some((e) => picked.has(e.id) && !e.locked);
    commit({
      ...docRef.current,
      elements: docRef.current.elements.map((e) =>
        picked.has(e.id) ? { ...e, locked: anyLoose || undefined } : e,
      ),
    });
    if (anyLoose) setSelected([]);
  }, [selected, commit]);

  const selectAll = useCallback(() => {
    setSelected(docRef.current.elements.filter((e) => !e.locked).map((e) => e.id));
  }, []);

  /** Move the selection by whole units, or by the grid with Shift. */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      const picked = new Set(selected);
      if (!picked.size) return;
      commit(
        reflow({
          ...docRef.current,
          elements: docRef.current.elements.map((e) =>
            picked.has(e.id) ? translate(e, dx, dy) : e,
          ),
        }),
      );
    },
    [selected, commit],
  );

  /** Zoom until the selection fills the pane, or the whole page if nothing is
   * selected. */
  const zoomToSelection = useCallback(() => {
    const box = bboxOfMany(chosenEls()) ?? {
      x: 0,
      y: 0,
      w: docRef.current.width,
      h: docRef.current.height,
    };
    if (box.w <= 0 || box.h <= 0) return;
    const pad = 60;
    const k = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        Math.min(docRef.current.width / (box.w + pad), docRef.current.height / (box.h + pad)),
      ),
    );
    setView({
      k,
      x: box.x + box.w / 2 - docRef.current.width / k / 2,
      y: box.y + box.h / 2 - docRef.current.height / k / 2,
    });
  }, [chosenEls]);

  const relabel = (id: string, label: string) => {
    commit({
      ...docRef.current,
      elements: docRef.current.elements.map((e) =>
        e.id !== id ? e : e.type === "text" ? { ...e, text: label } : { ...e, label },
      ),
    });
  };

  /** Three linked boxes: something to rename and rearrange rather than a
   * blank page. Deliberately the smallest useful thing — a template GALLERY is
   * a feature of its own, and one starter that always works beats a menu of
   * layouts that mostly do not fit. */
  const startTemplate = () => {
    let seq = docRef.current.seq;
    const id = () => `e${++seq}`;
    const a = id();
    const b = id();
    const c = id();
    const mk = (eid: string, x: number, label: string): SketchElement => ({
      id: eid,
      type: "rect",
      x,
      y: 420,
      w: 260,
      h: 140,
      ink,
      label,
    });
    const boxes = [mk(a, 180, "First"), mk(b, 660, "Then"), mk(c, 1140, "After that")];
    const link = (eid: string, from: string, to: string): SketchElement => ({
      id: eid,
      type: "arrow",
      points: [
        [0, 0],
        [0, 0],
      ],
      ink,
      from,
      to,
    });
    const next = reflow({
      ...docRef.current,
      seq: seq + 2,
      elements: [...boxes, link(id(), a, b), link(id(), b, c)],
    });
    commit(next);
    setSelected([a]);
  };

/* No export control on this toolbar.
 *
 * There was one, and the file header a few pixels above it had another with
 * the same word on it — two buttons named Export, doing different things
 * (this one wrote a flattened copy INTO the room; that one writes a copy OUT
 * of it), with nothing on either saying which. File-level acts belong to the
 * file header, so both of this one's formats moved there and the toolbar went
 * back to being about drawing. */

  /** ESCAPE, CLAIMED IN LAYERS — and claimed BEFORE the shell sees it.
   *
   * The shell closes the open file on Escape (`effects.ts`), and both handlers
   * sit on `window`. The shell's is registered when the room mounts and this
   * one when a sketch opens, so in the bubble phase the shell always ran
   * first: pressing Escape to dismiss the Arrange menu closed the drawing
   * instead. Capture runs before every bubble listener on the same target, so
   * this one gets to decide first and stops the event when it does.
   *
   * The layers are what a person expects: the topmost thing goes first.
   *
   *   1. a menu is open  → close the menu, and nothing else
   *   2. something is selected, or a tool is armed → back to a safe canvas
   *   3. neither         → fall through, and the shell closes the file
   *
   * Only the layers this component actually acts on stop the event. Falling
   * through silently is what keeps Escape-closes-the-file working everywhere
   * else in the app. */
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      // A text field owns its own Escape (cancel the edit) — and the shell
      // already declines to close a file while someone is typing.
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (menuRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        return;
      }
      if (selectedRef.current.length || toolRef.current !== "select") {
        e.preventDefault();
        e.stopPropagation();
        setSelected([]);
        setTool("select");
        setSticky(false);
      }
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, []);

  /** WHICH UNDO THE KEYBOARD IS TALKING TO.
   *
   * A note or a label is a real text field, and ⌘Z inside one is the field's
   * own undo — the drawing keeps out of it deliberately (see the shortcut
   * handler above). So typing, then pressing ⌘Z, then seeing the toolbar's
   * undo greyed out reads as a broken history when both are working: two
   * histories, one of them not the toolbar's. Knowing which has the keyboard
   * is what lets the page say so. */
  useEffect(() => {
    const isField = (n: EventTarget | null): boolean => {
      const el = n as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    };
    const arrived = (e: FocusEvent) => setTyping(isField(e.target));
    const left = () => setTyping(false);
    window.addEventListener("focusin", arrived);
    window.addEventListener("focusout", left);
    return () => {
      window.removeEventListener("focusin", arrived);
      window.removeEventListener("focusout", left);
    };
  }, []);

  /** TELL THE ASSISTANT WHAT IS SELECTED.
   *
   * The chat is a sibling pane with no way to see this canvas; without this it
   * answers "what is missing here?" from the whole room while the drawing sits
   * unread beside it. Published as the same sentences the object strip shows,
   * so the two can never describe the selection differently. */
  useEffect(() => {
    setSketchFocus({
      fileId,
      selection: doc.elements
        .filter((e) => selected.includes(e.id))
        .map(describeElement),
    });
  }, [fileId, doc.elements, selected]);
  // Separately from the value, because closing the drawing must retire it even
  // if the last render never ran: a stale focus would have the chat offering to
  // answer from a canvas that is no longer on screen.
  useEffect(() => () => setSketchFocus(null), []);

  /** BRING THE SELECTED OBJECT BACK INTO THE ROW.
   *
   * The strip is one row that scrolls sideways, so on a busy page the chip for
   * whatever was just selected — clicked on the canvas, caught by a marquee,
   * or drawn a moment ago — is usually past the right edge. A strip that does
   * not follow the selection is worse than no strip at all: it shows a row of
   * unselected chips while claiming to be the list of what is selected. */
  useEffect(() => {
    const first = selected[0];
    if (!first) return;
    chipRefs.current.get(first)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomAt(1.25);
        return;
      }
      if (meta && e.key === "-") {
        e.preventDefault();
        zoomAt(0.8);
        return;
      }
      if (meta && e.key === "0") {
        e.preventDefault();
        fitPage();
        return;
      }
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (meta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        doDuplicate();
        return;
      }
      if (meta && e.key === "]") {
        e.preventDefault();
        doOrder(e.shiftKey ? "front" : "forward");
        return;
      }
      if (meta && e.key === "[") {
        e.preventDefault();
        doOrder(e.shiftKey ? "back" : "backward");
        return;
      }
      if (meta || e.altKey) return;
      // Arrow keys move the selection: one unit for fine work, a whole grid
      // square with Shift. Without this the only way to place something
      // precisely was to drag it and hope.
      const step: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const move = step[e.key];
      if (move && selectedRef.current.length) {
        e.preventDefault();
        const by = e.shiftKey ? GRID_GAP : 1;
        nudge(move[0] * by, move[1] * by);
        return;
      }
      const t = KEY_TOOL[e.key.toLowerCase()];
      if (t) {
        setTool(t);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doUndo, doRedo, deleteSelected, zoomAt, fitPage, selectAll, doDuplicate, doOrder, nudge]);

  /** WHAT SOMEONE WHO CANNOT SEE THE CANVAS IS TOLD IT CONTAINS.
   *
   * The canvas used to reach the accessibility tree as a count of anonymous
   * images — "12 things on the page" and no way to learn what any of them
   * were, or to reach one. The count stays, because it is true and useful, but
   * it is no longer the whole story: the list below names every object and can
   * be tabbed through, and selecting a row selects the shape. */
  const picked = doc.elements.filter((e) => selected.includes(e.id));
  const chosen = picked.length === 1 ? picked[0] : null;
  const selBox = bboxOfMany(picked);
  /** Which grip, if any, is under a canvas point. Generous, because a corner
   * is a small target and missing it starts a marquee instead. */
  const gripUnder = (p: Point): Handle | null => {
    if (!selBox) return null;
    const near = 11 / view.k;
    for (const h of HANDLES) {
      const [hx, hy] = handleAt(selBox, h);
      if (Math.abs(p[0] - hx) <= near && Math.abs(p[1] - hy) <= near) return h;
    }
    return null;
  };
  const canvasSummary = doc.elements.length
    ? `Drawing canvas, ${doc.elements.length} object${doc.elements.length === 1 ? "" : "s"}${
        selected.length ? `, ${selected.length} selected` : ""
      }`
    : "Drawing canvas, empty";

  const saveWord =
    saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Not saved";

  return (
    <div className="sk-page">
      <div className="sk-tools" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map((tl) => (
          <button
            key={tl.key}
            type="button"
            className={`sk-tool${sticky && tool === tl.key ? " sk-locked-tool" : ""}`}
            title={`${tl.hint}${tl.key === tool && sticky ? " · staying on" : ""}`}
            aria-label={tl.label}
            aria-pressed={tool === tl.key}
            onClick={() => {
              setTool(tl.key);
              setSticky(false);
              setMenu(null);
            }}
            // Double-click arms a tool to STAY. One shape then back to Select
            // is the safe default; this is how to ask for the other one, and
            // the button shows which state it is in.
            onDoubleClick={() => {
              setTool(tl.key);
              setSticky(tl.key !== "select");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">{tl.icon}</svg>
          </button>
        ))}

        <span className="sk-div" />

        {/* ONE colour control, not five permanent swatches. The palette is a
            press away, and the button shows what is currently loaded — which
            is the fact the five dots were spending the whole width to say. */}
        <div className="sk-pop-wrap">
          <button
            type="button"
            className={`sk-tool sk-current-ink sk-ink-${ink}`}
            aria-haspopup="menu"
            aria-expanded={menu === "ink"}
            aria-label={`Colour: ${ink}`}
            title={`Colour: ${ink}`}
            onClick={() => setMenu((m) => (m === "ink" ? null : "ink"))}
          >
            <i />
          </button>
          {menu === "ink" ? (
            <div className="sk-pop" role="menu" aria-label="Colour">
              <div className="sk-pop-row">
                {INKS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="menuitemradio"
                    aria-checked={ink === k}
                    className={`sk-swatch sk-ink-${k}`}
                    aria-label={`${k} ink`}
                    title={k}
                    onClick={() => {
                      setInk(k);
                      // A colour chosen with something selected recolours it —
                      // otherwise the control only ever affects the NEXT shape,
                      // which is not what picking a colour looks like it does.
                      if (selected.length) {
                        const on = new Set(selected);
                        commit({
                          ...docRef.current,
                          elements: docRef.current.elements.map((e) =>
                            on.has(e.id) ? { ...e, ink: k } : e,
                          ),
                        });
                      }
                      setMenu(null);
                    }}
                  >
                    <i />
                  </button>
                ))}
              </div>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={fill}
                className="sk-pop-item"
                onClick={() => setFill((f) => !f)}
              >
                Fill shapes with a wash
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={snap}
                className="sk-pop-item"
                onClick={() => setSnap((s) => !s)}
              >
                Snap to shapes and the grid
              </button>
            </div>
          ) : null}
        </div>

        {/* ARRANGE — everything that acts on a selection, in one place rather
            than as eight more permanent buttons. Disabled, not hidden, so the
            actions are discoverable before anything is selected. */}
        <div className="sk-pop-wrap">
          <button
            type="button"
            className="sk-tool sk-wide"
            aria-haspopup="menu"
            aria-expanded={menu === "arrange"}
            disabled={!selected.length}
            title={selected.length ? "Arrange the selection" : "Select something first"}
            onClick={() => setMenu((m) => (m === "arrange" ? null : "arrange"))}
          >
            Arrange
          </button>
          {menu === "arrange" ? (
            <div className="sk-pop" role="menu" aria-label="Arrange">
              <div className="sk-pop-label">Align</div>
              <div className="sk-pop-row">
                {(
                  [
                    ["left", "Left"],
                    ["hcenter", "Centre"],
                    ["right", "Right"],
                    ["top", "Top"],
                    ["vcenter", "Middle"],
                    ["bottom", "Bottom"],
                  ] as Array<[AlignEdge, string]>
                ).map(([edge, word]) => (
                  <button
                    key={edge}
                    type="button"
                    role="menuitem"
                    className="sk-pop-chip"
                    disabled={selected.length < 2}
                    onClick={() => {
                      doAlign(edge);
                      setMenu(null);
                    }}
                  >
                    {word}
                  </button>
                ))}
              </div>
              <div className="sk-pop-label">Distribute</div>
              <div className="sk-pop-row">
                <button
                  type="button"
                  role="menuitem"
                  className="sk-pop-chip"
                  disabled={selected.length < 3}
                  onClick={() => {
                    doDistribute("x");
                    setMenu(null);
                  }}
                >
                  Across
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sk-pop-chip"
                  disabled={selected.length < 3}
                  onClick={() => {
                    doDistribute("y");
                    setMenu(null);
                  }}
                >
                  Down
                </button>
              </div>
              <div className="sk-pop-sep" role="separator" />
              {(
                [
                  ["front", "Bring to front", "⇧⌘]"],
                  ["forward", "Bring forward", "⌘]"],
                  ["backward", "Send backward", "⌘["],
                  ["back", "Send to back", "⇧⌘["],
                ] as Array<[Ordering, string, string]>
              ).map(([where, word, key]) => (
                <button
                  key={where}
                  type="button"
                  role="menuitem"
                  className="sk-pop-item"
                  onClick={() => {
                    doOrder(where);
                    setMenu(null);
                  }}
                >
                  {word}
                  <span className="sk-pop-key">{key}</span>
                </button>
              ))}
              <div className="sk-pop-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  doDuplicate();
                  setMenu(null);
                }}
              >
                Duplicate
                <span className="sk-pop-key">⌘D</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  toggleLock();
                  setMenu(null);
                }}
              >
                {picked.some((e) => !e.locked) ? "Lock in place" : "Unlock"}
              </button>
            </div>
          ) : null}
        </div>

        <span className="sk-div" />
        <button
          type="button"
          className="sk-tool"
          onClick={doUndo}
          disabled={!history.past.length}
          title={historyHint({
            verb: "Undo",
            shortcut: "⌘Z",
            depth: history.past.length,
            typing,
          })}
          aria-label="Undo drawing change"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8.5 6 4.5 10l4 4M4.5 10h9a5.5 5.5 0 1 1 0 11H9" />
          </svg>
        </button>
        <button
          type="button"
          className="sk-tool"
          onClick={doRedo}
          disabled={!history.future.length}
          title={historyHint({
            verb: "Redo",
            shortcut: "⇧⌘Z",
            depth: history.future.length,
            typing,
          })}
          aria-label="Redo drawing change"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15.5 6l4 4-4 4M19.5 10h-9a5.5 5.5 0 1 0 0 11H15" />
          </svg>
        </button>

        {/* Zoom collapses into ONE control. Three buttons plus a percentage
            were what pushed this toolbar onto a second row with the assistant
            open — and a second row of a spatial palette is worse than a menu. */}
        <div className="sk-pop-wrap sk-shrink">
          <button
            type="button"
            className="sk-tool sk-zoom"
            aria-haspopup="menu"
            aria-expanded={menu === "zoom"}
            title="Zoom"
            onClick={() => setMenu((m) => (m === "zoom" ? null : "zoom"))}
          >
            {Math.round(view.k * 100)}%
          </button>
          {menu === "zoom" ? (
            <div className="sk-pop" role="menu" aria-label="Zoom">
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  zoomAt(1.25);
                  setMenu(null);
                }}
              >
                Zoom in<span className="sk-pop-key">⌘+</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  zoomAt(0.8);
                  setMenu(null);
                }}
              >
                Zoom out<span className="sk-pop-key">⌘−</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                disabled={!selected.length}
                onClick={() => {
                  zoomToSelection();
                  setMenu(null);
                }}
              >
                Zoom to selection
              </button>
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  fitPage();
                  setMenu(null);
                }}
              >
                Fit the page<span className="sk-pop-key">⌘0</span>
              </button>
            </div>
          ) : null}
        </div>

      </div>

      <div className="sk-stage">
        <svg
          ref={svgRef}
          className={`sk-canvas${spaceHeld || panning.current ? " sk-panning" : ""}`}
          viewBox={`${view.x} ${view.y} ${doc.width / view.k} ${doc.height / view.k}`}
          preserveAspectRatio="xMidYMid meet"
          role="application"
          aria-label={canvasSummary}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
          <title>{canvasSummary}</title>
          <defs>
            <pattern
              id="sk-dots"
              width={GRID_GAP}
              height={GRID_GAP}
              patternUnits="userSpaceOnUse"
            >
              <circle className="sk-dot" cx={1.1} cy={1.1} r={1.1} />
            </pattern>
          </defs>
          {/* The sheet is drawn well past the page so panning never exposes a
              hard edge of nothing; the page itself is outlined below. */}
          <rect
            className="sk-paper"
            x={-doc.width}
            y={-doc.height}
            width={doc.width * 3}
            height={doc.height * 3}
          />
          <rect
            x={-doc.width}
            y={-doc.height}
            width={doc.width * 3}
            height={doc.height * 3}
            fill="url(#sk-dots)"
          />
          <rect className="sk-edge" width={doc.width} height={doc.height} />
          {doc.elements.map((e) =>
            hidden.has(e.id) ? null : (
              <Drawn
                key={e.id}
                el={e}
                selected={selected.includes(e.id)}
                fresh={fresh.has(e.id)}
              />
            ),
          )}
          {preview ? <Drawn el={preview} selected={false} fresh={false} /> : null}

          {/* The alignment lines, only while something is being dragged onto
              them. Drawn across the whole sheet, because a guide that stops at
              the two shapes it relates is hard to read as a line at all. */}
          {guides.map((g) => (
            <line
              key={`${g.axis}${g.at}`}
              className="sk-guide"
              x1={g.axis === "x" ? g.at : -doc.width}
              y1={g.axis === "x" ? -doc.height : g.at}
              x2={g.axis === "x" ? g.at : doc.width * 2}
              y2={g.axis === "x" ? doc.height * 2 : g.at}
            />
          ))}

          {marquee ? (
            <rect
              className="sk-marquee"
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
            />
          ) : null}

          {/* THE SELECTION AND ITS GRIPS.
              Drawn once around the whole selection rather than per element, so
              three shapes resize as one block — and so the grips are where a
              person expects them, on the outside of everything selected. */}
          {selBox && tool === "select" ? (
            <g className="sk-sel" aria-hidden="true">
              <rect
                className="sk-sel-box"
                x={selBox.x - 6}
                y={selBox.y - 6}
                width={selBox.w + 12}
                height={selBox.h + 12}
              />
              {picked.some((e) => e.locked) ? null : (
                HANDLES.map((h) => {
                  const [hx, hy] = handleAt(
                    { x: selBox.x - 6, y: selBox.y - 6, w: selBox.w + 12, h: selBox.h + 12 },
                    h,
                  );
                  // Sized against the zoom so a grip is the same physical
                  // target however far the page is scaled.
                  const r = 5 / view.k;
                  return (
                    <rect
                      key={h}
                      className={`sk-grip sk-grip-${h}`}
                      x={hx - r}
                      y={hy - r}
                      width={r * 2}
                      height={r * 2}
                    />
                  );
                })
              )}
            </g>
          ) : null}
        </svg>

        {/* THREE WAYS IN, instead of one passive sentence.
            `pointer-events: none` on the layer with the buttons opted back in,
            so an empty canvas can still be drawn on THROUGH the offer — a hint
            that swallows the first click is worse than no hint. */}
        {doc.elements.length === 0 && !preview ? (
          <div className="sk-empty" aria-hidden={false}>
            <div className="sk-empty-cards">
              <button
                type="button"
                className="sk-empty-card"
                onClick={() => {
                  setTool("pen");
                  setSticky(true);
                }}
              >
                <span className="sk-empty-title">Draw freely</span>
                <span className="sk-empty-copy">Use the pen and shapes to sketch ideas.</span>
              </button>
              <button
                type="button"
                className="sk-empty-card"
                onClick={() => startTemplate()}
              >
                <span className="sk-empty-title">Start from a shape</span>
                <span className="sk-empty-copy">
                  Three linked boxes to rename and rearrange.
                </span>
              </button>
              <button
                type="button"
                className="sk-empty-card"
                onClick={() => setNote("Ask the assistant to draw from your room's files.")}
              >
                <span className="sk-empty-title">Turn room files into a diagram</span>
                <span className="sk-empty-copy">
                  Ask the assistant, with this sketch open.
                </span>
              </button>
            </div>
          </div>
        ) : null}

        {textAt ? (
          <input
            className="sk-text-input"
            style={{
              left: `${(textAt[0] / doc.width) * 100}%`,
              top: `${(textAt[1] / doc.height) * 100}%`,
            }}
            value={textValue}
            autoFocus
            aria-label="Note text"
            placeholder="note…"
            onChange={(e) => setTextValue(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") {
                setTextAt(null);
                setTextValue("");
              }
            }}
          />
        ) : null}
      </div>

      {/* EVERY OBJECT, REACHABLE WITHOUT A POINTER.
          Visually a thin strip that only appears when the canvas has content;
          for a screen reader it is the canvas's table of contents, and the one
          way to select a shape without being able to see where it is.

          One row by default, because it sits under the canvas and taking three
          rows from the drawing to list the drawing is a bad trade. The count on
          the left says how much is off the end and opens the whole set. */}
      {doc.elements.length > 0 ? (
        <div className={`sk-objects${stripOpen ? " sk-objects-open" : ""}`}>
          <button
            type="button"
            className="sk-objects-toggle"
            aria-expanded={stripOpen}
            title={stripOpen ? "Back to a single row" : "Show every object at once"}
            onClick={() => setStripOpen((v) => !v)}
          >
            {doc.elements.length} object{doc.elements.length === 1 ? "" : "s"}
          </button>
          <div
            className="sk-objects-row"
            role="listbox"
            aria-label="Objects on this page"
            aria-multiselectable="true"
          >
            {doc.elements.map((e, i) => (
              <button
                key={e.id}
                ref={(node) => {
                  if (node) chipRefs.current.set(e.id, node);
                  else chipRefs.current.delete(e.id);
                }}
                type="button"
                role="option"
                aria-selected={selected.includes(e.id)}
                // The chip shows a short name; the full sentence — including
                // where the object sits — is the accessible name, where it
                // costs no width.
                aria-label={describeElement(e)}
                aria-posinset={i + 1}
                aria-setsize={doc.elements.length}
                className={`sk-object${selected.includes(e.id) ? " on" : ""}${
                  e.locked ? " sk-object-locked" : ""
                }`}
                title={describeElement(e)}
                onClick={(ev) =>
                  setSelected((cur) =>
                    ev.shiftKey
                      ? cur.includes(e.id)
                        ? cur.filter((id) => id !== e.id)
                        : [...cur, e.id]
                      : [e.id],
                  )
                }
              >
                {e.locked ? (
                  <svg className="sk-object-lock" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                  </svg>
                ) : null}
                {chipLabel(e)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="sk-foot">
        {chosen ? (
          <label className="sk-label-edit">
            <span>Label</span>
            <input
              value={chosen.type === "text" ? chosen.text : (chosen.label ?? "")}
              placeholder="give this a name"
              onChange={(e) => relabel(chosen.id, e.target.value)}
            />
          </label>
        ) : picked.length > 1 ? (
          <span className="sk-hint">
            {picked.length} selected · Arrange to align them · ⌘D to duplicate
          </span>
        ) : (
          <span className="sk-hint">
            {doc.elements.length === 0
              ? "Pick a tool and draw — or ask the room's AI to draw it for you."
              : "Click to select · drag a box around several · ⌘Z to undo"}
          </span>
        )}
        {/* Said here because a disabled button cannot say it: while a field
            has the keyboard, ⌘Z is the field's and the toolbar's undo is the
            drawing's. Both work; they are simply not the same history. */}
        {typing ? (
          <span className="sk-hint sk-hint-typing">
            ⌘Z undoes your typing here — the toolbar’s undo covers the drawing
          </span>
        ) : null}
        <span className={`sk-save sk-save-${saveState}`} role="status">
          {note ?? saveWord}
        </span>
      </div>
    </div>
  );
}

/** One element, drawn. Pure — every path is a function of the element alone. */
function Drawn({
  el,
  selected,
  fresh,
}: {
  el: SketchElement;
  selected: boolean;
  fresh: boolean;
}) {
  const rand = seeded(el.id);
  const cls = `sk-el sk-ink-${el.ink}${fresh ? " sk-fresh" : ""}`;
  const label =
    el.type !== "text" && el.label ? (
      <text className="sk-shape-label" x={0} y={0}>
        {el.label}
      </text>
    ) : null;

  let body: ReactElement;
  switch (el.type) {
    case "rect": {
      body = (
        <>
          {el.fill ? (
            <rect className="sk-fill" x={el.x} y={el.y} width={el.w} height={el.h} rx={8} />
          ) : null}
          <path className="sk-line" d={rectPath(rand, el.x, el.y, el.w, el.h)} />
          {el.label ? (
            <text className="sk-shape-label" x={el.x + el.w / 2} y={el.y + el.h / 2 + 9}>
              {el.label}
            </text>
          ) : null}
        </>
      );
      break;
    }
    case "ellipse": {
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      body = (
        <>
          {el.fill ? (
            <ellipse className="sk-fill" cx={cx} cy={cy} rx={el.w / 2} ry={el.h / 2} />
          ) : null}
          <path className="sk-line" d={ellipsePath(rand, cx, cy, el.w / 2, el.h / 2)} />
          {el.label ? (
            <text className="sk-shape-label" x={cx} y={cy + 9}>
              {el.label}
            </text>
          ) : null}
        </>
      );
      break;
    }
    case "text":
      body = (
        <text className="sk-note" x={el.x} y={el.y} fontSize={el.size}>
          {el.text}
        </text>
      );
      break;
    case "arrow": {
      const [h1, h2] = arrowHead(el.points);
      const tip = el.points[el.points.length - 1];
      const mid: Point = [
        (el.points[0][0] + tip[0]) / 2,
        (el.points[0][1] + tip[1]) / 2 - 12,
      ];
      body = (
        <>
          <path className="sk-line" d={strokePath(el.points)} />
          <path className="sk-line" d={`M${tip[0]} ${tip[1]}L${h1[0]} ${h1[1]}`} />
          <path className="sk-line" d={`M${tip[0]} ${tip[1]}L${h2[0]} ${h2[1]}`} />
          {el.label ? (
            <text className="sk-shape-label" x={mid[0]} y={mid[1]}>
              {el.label}
            </text>
          ) : null}
        </>
      );
      break;
    }
    default:
      body = <path className="sk-line sk-stroke" d={strokePath(el.points)} />;
  }

  const box = bboxOf(el);
  return (
    <g className={cls} data-id={el.id}>
      {body}
      {el.type === "line" ? label : null}
      {selected ? (
        <rect
          className="sk-selection"
          x={box.x - 7}
          y={box.y - 7}
          width={box.w + 14}
          height={box.h + 14}
        />
      ) : null}
    </g>
  );
}
