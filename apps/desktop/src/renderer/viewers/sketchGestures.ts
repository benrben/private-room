import type React from "react";
import { CANVAS_H, CANVAS_W, type Point, type SketchElement, bboxOf, hitTest, nextId, pushHistory, strokeFromTrail, translate, bboxOfMany, canConnect, fitToBox, guidesFor, hitTestArea, reflow, resizedBox, routeBetween, snapTo, HANDLES, handleAt, type Guide, type Handle } from "./sketch/model";
import { CanvasTool, PointerDownMode, PointerMoveMode, pointerDownMode, activePointerMoveMode, drawingPointerMoveMode, previewFor, pointerPreviewEvents } from "./SketchView";
import type { SketchBase } from "./sketchControllerBase";

export function useSketchGestures(base: SketchBase) {
  const { doc, setHistory, tool, setTool, sticky, ink, fill, selected, setSelected, snap, setGuides, marquee, setMarquee, connectFrom, svgRef, stageRef, docRef, advance, drawingRef, pendingAgent, preview, setPreview, trail, anchor, dragFrom, resizing, marqueeFrom, erasing, capturedPointer, view, setView, panning, spaceHeld, textAt, setTextAt, textValue, setTextValue, scheduleSave, commit, applyAgent } = base;

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

  const gripUnder = (point: Point): Handle | null => {
    const picked = doc.elements.filter((element) => selected.includes(element.id));
    const box = bboxOfMany(picked);
    if (!box) return null;
    const near = 11 / view.k;
    for (const handle of HANDLES) {
      const [x, y] = handleAt(box, handle);
      if (Math.abs(point[0] - x) <= near && Math.abs(point[1] - y) <= near)
        return handle;
    }
    return null;
  };


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

  /** Where a canvas point lands inside the stage, in pixels — the inverse of
   * `toCanvas`, for the one thing on this page drawn in HTML rather than SVG.
   *
   * The note field used to be placed at a percentage of the DOCUMENT, which is
   * only ever right at 100% with the page exactly filling its box: zoom, pan
   * and the letterboxing of `preserveAspectRatio` all sit between the two.
   * `getScreenCTM` is the one mapping that already accounts for all three.
   * Falls back to the old percentage if the layout cannot be measured, so the
   * field still appears. */
  const stagePosition = (p: Point): { left: string; top: string } => {
    const m = svgRef.current?.getScreenCTM();
    const box = stageRef.current?.getBoundingClientRect();
    if (!m || !box) {
      return {
        left: `${(p[0] / doc.width) * 100}%`,
        top: `${(p[1] / doc.height) * 100}%`,
      };
    }
    const at = new DOMPoint(p[0], p[1]).matrixTransform(m);
    return { left: `${at.x - box.left}px`, top: `${at.y - box.top}px` };
  };

  /** Rub out whatever is under the pointer. One undo entry per swipe, not
   * one per shape — an eraser stroke is a single act to the person doing it. */
  const eraseAt = (p: Point, first: boolean) => {
    // Locked is background: the click path passes over it and the delete key
    // refuses it, so the eraser has to as well — one swipe used to take out a
    // locked backdrop the user had pinned down precisely so it could not be.
    // Tested against the loose elements only, so the eraser still reaches what
    // is UNDER a locked shape.
    const hit = hitTest(
      {
        ...docRef.current,
        elements: docRef.current.elements.filter((e) => !e.locked),
      },
      p[0],
      p[1],
    );
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

  const capturePointer = (ev: React.PointerEvent) => {
    svgRef.current?.setPointerCapture?.(ev.pointerId);
    capturedPointer.current = ev.pointerId;
  };

  const startPan = (ev: React.PointerEvent, p: Point) => {
    capturePointer(ev);
    panning.current = { from: p };
  };

  const startText = (p: Point) => {
    setTextAt(p);
    setTextValue("");
  };

  const startErasing = (p: Point) => {
    erasing.current = true;
    eraseAt(p, true);
  };

  const selectHit = (hit: SketchElement, shiftKey: boolean) => {
    setSelected((cur) => {
      if (!shiftKey) return cur.includes(hit.id) ? cur : [hit.id];
      return cur.includes(hit.id)
        ? cur.filter((id) => id !== hit.id)
        : [...cur, hit.id];
    });
  };

  const startResize = (p: Point): boolean => {
    const grip = gripUnder(p);
    if (!grip) return false;
    const els = docRef.current.elements.filter(
      (e) => selected.includes(e.id) && !e.locked,
    );
    const box = bboxOfMany(els);
    if (!box) return false;
    resizing.current = { handle: grip, box, from: p, els };
    return true;
  };

  const startMarquee = (
    hit: SketchElement | null,
    shiftKey: boolean,
    p: Point,
  ) => {
    if (hit?.locked) setSelected([]);
    if (!hit && !shiftKey) setSelected([]);
    marqueeFrom.current = p;
  };

  const startSelection = (ev: React.PointerEvent, p: Point) => {
    if (startResize(p)) return;
    const hit = hitTest(docRef.current, p[0], p[1]);
    if (!hit) return startMarquee(null, ev.shiftKey, p);
    if (hit.locked) return startMarquee(hit, ev.shiftKey, p);
    selectHit(hit, ev.shiftKey);
    dragFrom.current = p;
  };

  const startDrawing = (ev: React.PointerEvent, p: Point) => {
    ev.preventDefault();
    drawingRef.current = true;
    anchor.current = p;
    const drawingTool = tool as CanvasTool;
    if (drawingTool === "pen") trail.current = [p];
    if (drawingTool === "arrow") {
      const under = hitTest(docRef.current, p[0], p[1]);
      connectFrom.current = canConnect(under) ? under.id : null;
    }
    setPreview(previewFor(drawingTool, p, ink, fill));
  };

  const pointerDownHandlers: Record<
    Exclude<PointerDownMode, "ignore">,
    (ev: React.PointerEvent, p: Point) => void
  > = {
    pan: startPan,
    text: (_, p) => startText(p),
    erase: (_, p) => startErasing(p),
    select: startSelection,
    draw: startDrawing,
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    const mode = pointerDownMode(ev.button, spaceHeld, tool);
    if (mode === "ignore") return;
    commitText();
    pointerDownHandlers[mode](ev, toCanvas(ev));
  };

  const movePan = (ev: React.PointerEvent) => {
    const p = toCanvas(ev);
    const from = panning.current?.from;
    if (!from) return;
    setView((v) => ({
      ...v,
      x: v.x - (p[0] - from[0]),
      y: v.y - (p[1] - from[1]),
    }));
  };

  const moveResize = (ev: React.PointerEvent) => {
    const resize = resizing.current;
    if (!resize) return;
    if (!drawingRef.current) {
      drawingRef.current = true;
      setHistory((h) => pushHistory(h, docRef.current));
    }
    const p = toCanvas(ev);
    const to = resizedBox(
      resize.box,
      resize.handle,
      p[0] - resize.from[0],
      p[1] - resize.from[1],
      ev.shiftKey,
    );
    const moved = new Map(
      resize.els.map((e) => [e.id, fitToBox(e, resize.box, to)]),
    );
    const next = reflow({
      ...docRef.current,
      elements: docRef.current.elements.map((e) => moved.get(e.id) ?? e),
    });
    advance(next);
    scheduleSave(next);
  };

  const moveMarquee = (ev: React.PointerEvent) => {
    const from = marqueeFrom.current;
    if (!from) return;
    const p = toCanvas(ev);
    setMarquee({
      x: Math.min(from[0], p[0]),
      y: Math.min(from[1], p[1]),
      w: Math.abs(p[0] - from[0]),
      h: Math.abs(p[1] - from[1]),
    });
  };

  const beginDrag = (dx: number, dy: number): boolean => {
    if (drawingRef.current) return true;
    if (Math.hypot(dx, dy) < 3) return false;
    drawingRef.current = true;
    setHistory((h) => pushHistory(h, docRef.current));
    return true;
  };

  const snappedDrag = (
    picked: Set<string>,
    dx: number,
    dy: number,
    altKey: boolean,
  ) => {
    if (!snap || altKey) return { dx, dy, guides: [] as Guide[] };
    const moving = docRef.current.elements.filter((e) => picked.has(e.id));
    const box = bboxOfMany(moving);
    if (!box) return { dx, dy, guides: [] as Guide[] };
    const others = docRef.current.elements
      .filter((e) => !picked.has(e.id))
      .map(bboxOf);
    const pull = guidesFor({ ...box, x: box.x + dx, y: box.y + dy }, others);
    if (pull.guides.length)
      return { dx: dx + pull.dx, dy: dy + pull.dy, guides: pull.guides };
    return {
      dx: snapTo(box.x + dx) - box.x,
      dy: snapTo(box.y + dy) - box.y,
      guides: [] as Guide[],
    };
  };

  const moveDrag = (ev: React.PointerEvent) => {
    const from = dragFrom.current;
    if (!from) return;
    const p = toCanvas(ev);
    const initialDx = p[0] - from[0];
    const initialDy = p[1] - from[1];
    if (!beginDrag(initialDx, initialDy)) return;
    const picked = new Set(selected);
    const landed = snappedDrag(picked, initialDx, initialDy, ev.altKey);
    if (landed.dx === 0 && landed.dy === 0) {
      setGuides(landed.guides);
      return;
    }
    dragFrom.current = [from[0] + landed.dx, from[1] + landed.dy];
    setGuides(landed.guides);
    const next = reflow({
      ...docRef.current,
      elements: docRef.current.elements.map((e) =>
        picked.has(e.id) ? translate(e, landed.dx, landed.dy) : e,
      ),
    });
    advance(next);
    scheduleSave(next);
  };

  const updatePen = (p: Point) => {
    const last = trail.current[trail.current.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 2)
      trail.current.push(p);
  };

  const updateArrow = (p: Point) => {
    if (!anchor.current) return;
    setPreview({
      id: "preview",
      type: "arrow",
      points: [anchor.current, p],
      ink,
    });
  };

  const updateShape = (p: Point) => {
    const at = anchor.current;
    if (!at) return;
    setPreview({
      id: "preview",
      type: tool === "ellipse" ? "ellipse" : "rect",
      x: Math.min(at[0], p[0]),
      y: Math.min(at[1], p[1]),
      w: Math.abs(p[0] - at[0]),
      h: Math.abs(p[1] - at[1]),
      ink,
      fill,
    });
  };

  const moveDrawingPoint = (p: Point) => {
    if (tool === "pen") return updatePen(p);
    if (tool === "arrow") return updateArrow(p);
    updateShape(p);
  };

  const moveDrawing = (ev: React.PointerEvent) => {
    for (const raw of pointerPreviewEvents(ev, tool)) {
      moveDrawingPoint(
        toCanvas({
          clientX: raw.clientX,
          clientY: raw.clientY,
        } as React.PointerEvent),
      );
    }
    if (tool === "pen")
      setPreview({
        id: "preview",
        type: "pen",
        points: [...trail.current],
        ink,
      });
  };

  const moveHandlers: Record<
    Exclude<PointerMoveMode, "idle">,
    (ev: React.PointerEvent) => void
  > = {
    pan: movePan,
    erase: (ev) => eraseAt(toCanvas(ev), false),
    resize: moveResize,
    marquee: moveMarquee,
    drag: moveDrag,
    draw: moveDrawing,
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const active = activePointerMoveMode(
      !!panning.current,
      erasing.current,
      !!resizing.current,
      !!marqueeFrom.current,
    );
    const mode =
      active ??
      drawingPointerMoveMode(
        !!dragFrom.current,
        selected.length > 0,
        drawingRef.current,
        !!anchor.current,
      );
    if (mode === "idle") return;
    moveHandlers[mode](ev);
  };

  const resetGesture = () => {
    const wasDrawing = drawingRef.current;
    drawingRef.current = false;
    dragFrom.current = null;
    erasing.current = false;
    panning.current = null;
    resizing.current = null;
    setGuides([]);
    return wasDrawing;
  };

  const finishMarquee = (ev?: React.PointerEvent): boolean => {
    if (!marqueeFrom.current) return false;
    marqueeFrom.current = null;
    const area = marquee;
    setMarquee(null);
    if (!area || (area.w <= 3 && area.h <= 3)) return true;
    const inside = hitTestArea(docRef.current, area)
      .filter((e) => !e.locked)
      .map((e) => e.id);
    setSelected((cur) =>
      ev?.shiftKey ? [...new Set([...cur, ...inside])] : inside,
    );
    return true;
  };

  const releaseCapturedPointer = () => {
    const pointer = capturedPointer.current;
    if (pointer === null) return;
    try {
      svgRef.current?.releasePointerCapture?.(pointer);
    } catch {
      capturedPointer.current = null;
      return;
    }
    capturedPointer.current = null;
  };

  const finishPen = (
    preview: SketchElement,
    id: string,
  ): SketchElement | null => {
    const points = strokeFromTrail(trail.current);
    return points.length > 1
      ? { ...(preview as Extract<SketchElement, { type: "pen" }>), id, points }
      : null;
  };

  const linkedArrow = (arrow: Extract<SketchElement, { type: "arrow" }>) => {
    const tip = arrow.points[arrow.points.length - 1];
    const from = connectFrom.current;
    const under = hitTest(docRef.current, tip[0], tip[1]);
    if (!from || !canConnect(under) || under.id === from) return arrow;
    const start = docRef.current.elements.find((e) => e.id === from);
    if (!start) return arrow;
    const [p, q] = routeBetween(bboxOf(start), bboxOf(under));
    return { ...arrow, from, to: under.id, points: [p, q] };
  };

  const finishArrow = (
    preview: SketchElement,
    id: string,
  ): SketchElement | null => {
    const arrow = preview as Extract<SketchElement, { type: "arrow" }>;
    const [a, b] = arrow.points;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= 8) return null;
    return linkedArrow({ ...arrow, id });
  };

  const finishShape = (
    preview: SketchElement,
    id: string,
  ): SketchElement | null => {
    const shape = preview as Extract<
      SketchElement,
      { type: "rect" | "ellipse" }
    >;
    if (shape.w <= 10 || shape.h <= 10) return null;
    return { ...shape, id };
  };

  const finishers: Partial<
    Record<
      SketchElement["type"],
      (preview: SketchElement, id: string) => SketchElement | null
    >
  > = {
    pen: finishPen,
    arrow: finishArrow,
    rect: finishShape,
    ellipse: finishShape,
  };

  const canFinishDrawing = (wasDrawing: boolean): boolean => {
    if (!wasDrawing) return false;
    if (!preview) return false;
    return !!anchor.current;
  };

  const commitFinishedDrawing = (made: SketchElement, seq: number) => {
    commit({
      ...docRef.current,
      seq,
      elements: [...docRef.current.elements, made],
    });
    setSelected([made.id]);
    if (!sticky) setTool("select");
  };

  const finishDrawing = (wasDrawing: boolean) => {
    if (!canFinishDrawing(wasDrawing) || !preview) return;
    const { id, seq } = nextId(docRef.current);
    const made = finishers[preview.type]?.(preview, id);
    if (!made) return;
    commitFinishedDrawing(made, seq);
  };

  const clearGesturePreview = () => {
    connectFrom.current = null;
    anchor.current = null;
    trail.current = [];
    setPreview(null);
  };

  const applyHeldAgent = () => {
    const held = pendingAgent.current;
    if (!held) return;
    pendingAgent.current = null;
    applyAgent(held.doc, held.added, held.removed);
  };

  const endGesture = (ev?: React.PointerEvent) => {
    const wasDrawing = resetGesture();
    if (finishMarquee(ev)) return;
    releaseCapturedPointer();
    finishDrawing(wasDrawing);
    clearGesturePreview();
    applyHeldAgent();
  };
  return { ...base,
    toCanvas,
    stagePosition,
    eraseAt,
    capturePointer,
    startPan,
    startText,
    startErasing,
    selectHit,
    startResize,
    startMarquee,
    startSelection,
    startDrawing,
    pointerDownHandlers,
    onPointerDown,
    movePan,
    moveResize,
    moveMarquee,
    beginDrag,
    snappedDrag,
    moveDrag,
    updatePen,
    updateArrow,
    updateShape,
    moveDrawingPoint,
    moveDrawing,
    moveHandlers,
    onPointerMove,
    resetGesture,
    finishMarquee,
    releaseCapturedPointer,
    finishPen,
    linkedArrow,
    finishArrow,
    finishShape,
    finishers,
    canFinishDrawing,
    commitFinishedDrawing,
    finishDrawing,
    clearGesturePreview,
    applyHeldAgent,
    endGesture,
    commitText,
    gripUnder
  };
}
export type SketchGestures = ReturnType<typeof useSketchGestures>;
