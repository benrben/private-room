import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { api } from "../api";
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
  const [tool, setTool] = useState<Tool>("pen");
  const [ink, setInk] = useState<Ink>("blue");
  const [fill, setFill] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">("saved");
  const [note, setNote] = useState<string | null>(initial.error);
  /** Ids the agent just added, revealed one at a time. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const svgRef = useRef<SVGSVGElement | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
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
  const dirty = useRef(false);
  /** Version history is taken once per editing session, not once per stroke. */
  const snapshotted = useRef(false);

  // --- live gesture state (not React state: it changes per pointer event) ---
  const [preview, setPreview] = useState<SketchElement | null>(null);
  const trail = useRef<Point[]>([]);
  const anchor = useRef<Point | null>(null);
  const dragFrom = useRef<Point | null>(null);
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

  // A drawing has no Save button, so an unmount mid-debounce is the one moment
  // work can be lost. Flush it.
  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      // The one moment work can be lost: unmounting inside the idle window.
      if (dirty.current) {
        void api.saveSketch(fileId, serializeSketch(docRef.current), !snapshotted.current);
      }
    },
    [fileId],
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
    // Reveal in the order the agent drew them.
    setHidden(new Set(added));
    setFresh(new Set(added));
    added.forEach((id, i) => {
      window.setTimeout(() => {
        setHidden((h) => {
          const n = new Set(h);
          n.delete(id);
          return n;
        });
      }, i * REVEAL_STEP_MS);
    });
    window.setTimeout(
      () => setFresh(new Set()),
      added.length * REVEAL_STEP_MS + 1400,
    );
  }, [scheduleSave]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void api
      .onSketchDrawn((e) => {
        if (e.fileId !== fileId) return;
        const parsed = parseSketch(e.doc);
        if (parsed.error) return;
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
    setSelected(null);
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
      const hit = hitTest(doc, p[0], p[1]);
      setSelected(hit ? hit.id : null);
      dragFrom.current = hit ? p : null;
      return;
    }

    ev.preventDefault();
    drawingRef.current = true;
    anchor.current = p;
    if (tool === "pen") {
      trail.current = [p];
      setPreview({ id: "preview", type: "pen", points: [p, p], ink });
    } else if (tool === "arrow") {
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
    // Dragging a selected element.
    if (dragFrom.current && selected) {
      const p = toCanvas(ev);
      const dx = p[0] - dragFrom.current[0];
      const dy = p[1] - dragFrom.current[1];
      if (!drawingRef.current && Math.hypot(dx, dy) < 3) return;
      if (!drawingRef.current) {
        drawingRef.current = true;
        setHistory((h) => pushHistory(h, docRef.current));
      }
      dragFrom.current = p;
      const next = {
        ...docRef.current,
        elements: docRef.current.elements.map((e) =>
          e.id === selected ? translate(e, dx, dy) : e,
        ),
      };
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

  const endGesture = () => {
    const wasDrawing = drawingRef.current;
    drawingRef.current = false;
    dragFrom.current = null;
    erasing.current = false;
    panning.current = null;
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
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 8) made = { ...preview, id };
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
        setSelected(made.id);
      }
    }
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
    setSelected(null);
  }, [history, scheduleSave]);

  const doRedo = useCallback(() => {
    const r = redo(history, docRef.current);
    if (!r) return;
    setHistory(r.history);
    setDoc(r.doc);
    scheduleSave(r.doc);
  }, [history, scheduleSave]);

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    commit({
      ...docRef.current,
      elements: docRef.current.elements.filter((e) => e.id !== selected),
    });
    setSelected(null);
  }, [selected, commit]);

  const relabel = (id: string, label: string) => {
    commit({
      ...docRef.current,
      elements: docRef.current.elements.map((e) =>
        e.id !== id ? e : e.type === "text" ? { ...e, text: label } : { ...e, label },
      ),
    });
  };

  const exportSvg = async () => {
    try {
      const meta = await api.exportSketchSvg(fileId);
      setNote(`Exported "${meta.name}" into the Library.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

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
      if (meta || e.altKey) return;
      const t = KEY_TOOL[e.key.toLowerCase()];
      if (t) {
        setTool(t);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doUndo, doRedo, deleteSelected, zoomAt, fitPage]);

  const chosen = doc.elements.find((e) => e.id === selected) ?? null;
  const saveWord =
    saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Not saved";

  return (
    <div className="sk-page">
      <div className="sk-tools" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="sk-tool"
            title={t.hint}
            aria-label={t.label}
            aria-pressed={tool === t.key}
            onClick={() => setTool(t.key)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {t.icon}
            </svg>
          </button>
        ))}
        <span className="sk-div" />
        {INKS.map((k) => (
          <button
            key={k}
            type="button"
            className={`sk-swatch sk-ink-${k}`}
            title={k}
            aria-label={`${k} pen`}
            aria-pressed={ink === k}
            onClick={() => setInk(k)}
          >
            <i />
          </button>
        ))}
        <button
          type="button"
          className="sk-tool sk-wide"
          aria-pressed={fill}
          onClick={() => setFill((f) => !f)}
          title="Fill new shapes with a translucent wash"
        >
          Fill
        </button>
        <span className="sk-div" />
        <button
          type="button"
          className="sk-tool"
          onClick={doUndo}
          disabled={!history.past.length}
          title="Undo · ⌘Z"
          aria-label="Undo"
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
          title="Redo · ⇧⌘Z"
          aria-label="Redo"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15.5 6l4 4-4 4M19.5 10h-9a5.5 5.5 0 1 0 0 11H15" />
          </svg>
        </button>
        <span className="sk-div" />
        <button
          type="button"
          className="sk-tool"
          onClick={() => zoomAt(0.8)}
          title="Zoom out · ⌘−"
          aria-label="Zoom out"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M8 11h6M20 20l-4.4-4.4" />
          </svg>
        </button>
        <button
          type="button"
          className="sk-tool sk-zoom"
          onClick={fitPage}
          title="Fit the page · ⌘0"
        >
          {Math.round(view.k * 100)}%
        </button>
        <button
          type="button"
          className="sk-tool"
          onClick={() => zoomAt(1.25)}
          title="Zoom in · ⌘+"
          aria-label="Zoom in"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M8 11h6M11 8v6M20 20l-4.4-4.4" />
          </svg>
        </button>
        <button type="button" className="sk-tool sk-wide" onClick={exportSvg}>
          Export SVG
        </button>
      </div>

      <div className="sk-stage">
        <svg
          ref={svgRef}
          className={`sk-canvas${spaceHeld || panning.current ? " sk-panning" : ""}`}
          viewBox={`${view.x} ${view.y} ${doc.width / view.k} ${doc.height / view.k}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label={`Drawing canvas, ${doc.elements.length} things on the page`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
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
              <Drawn key={e.id} el={e} selected={e.id === selected} fresh={fresh.has(e.id)} />
            ),
          )}
          {preview ? <Drawn el={preview} selected={false} fresh={false} /> : null}
        </svg>

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
        ) : (
          <span className="sk-hint">
            {doc.elements.length === 0
              ? "Pick a pen and draw — or ask the room's AI to draw it for you."
              : "Drag to draw · V to select · ⌘Z to undo"}
          </span>
        )}
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
