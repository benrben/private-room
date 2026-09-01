import { bboxOf, bboxOfMany, routeBetween, translate, type Point, type Rect, type Sketch, type SketchElement } from "./model";

export function reflow(doc: Sketch): Sketch {
  const boxes = new Map<string, Rect>();
  for (const e of doc.elements) boxes.set(e.id, bboxOf(e));
  const updates = doc.elements.map((element) => reflowElement(element, boxes));
  if (!updates.some((update) => update.changed)) return doc;
  return { ...doc, elements: updates.map((update) => update.element) };
}

type ReflowUpdate = { element: SketchElement; changed: boolean };

function reflowElement(element: SketchElement, boxes: Map<string, Rect>): ReflowUpdate {
  if (!isAttachedConnector(element)) return unchangedElement(element);
  return reflowAttachedConnector(element, boxes);
}

function isAttachedConnector(element: SketchElement): element is Extract<SketchElement, { points: Point[] }> {
  const canAttach = element.type === "arrow" || element.type === "line";
  return canAttach && Boolean(element.from || element.to);
}

function unchangedElement(element: SketchElement): ReflowUpdate {
  return { element, changed: false };
}

function reflowAttachedConnector(
  element: Extract<SketchElement, { points: Point[] }>,
  boxes: Map<string, Rect>,
): ReflowUpdate {
  const endpoints = attachedBoxes(element, boxes);
  if (endpoints) return reroutedConnector(element, endpoints);
  if (hasMissingAttachment(element, boxes)) return detachedConnector(element);
  return unchangedElement(element);
}

function attachedBoxes(
  element: SketchElement,
  boxes: Map<string, Rect>,
): [Rect, Rect] | null {
  const from = element.from ? boxes.get(element.from) : undefined;
  const to = element.to ? boxes.get(element.to) : undefined;
  return from && to ? [from, to] : null;
}

function hasMissingAttachment(element: SketchElement, boxes: Map<string, Rect>): boolean {
  return Boolean(element.from && !boxes.get(element.from)) || Boolean(element.to && !boxes.get(element.to));
}

function detachedConnector(
  element: Extract<SketchElement, { points: Point[] }>,
): ReflowUpdate {
  // One end is gone. Forget the attachment rather than leaving a connector
  // that claims to join something the page no longer has.
  const { from: _from, to: _to, ...unattached } = element;
  return { element: unattached as SketchElement, changed: true };
}

function reroutedConnector(
  element: Extract<SketchElement, { points: Point[] }>,
  [from, to]: [Rect, Rect],
): ReflowUpdate {
  const [start, end] = routeBetween(from, to);
  const first = element.points[0];
  const last = element.points[element.points.length - 1];
  if (samePoint(first, start) && samePoint(last, end)) return unchangedElement(element);
  return { element: { ...element, points: [start, end] as Point[] }, changed: true };
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** What a connector may attach to. A connector cannot hang off another
 * connector — that is a chain with no shape at the end of it — and a shape
 * cannot join itself. */
export function canConnect(e: SketchElement | null): e is SketchElement {
  return !!e && (e.type === "rect" || e.type === "ellipse" || e.type === "text");
}

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Line a selection up against its own bounding box.
 *
 * Nothing moves along the other axis, and one element is a no-op — aligning a
 * single shape to "left" against itself would be a change with no meaning and
 * an undo entry to match.
 */
export function align(els: SketchElement[], edge: AlignEdge): SketchElement[] {
  const box = bboxOfMany(els);
  if (!box || els.length < 2) return els;
  return els.map((e) => {
    const b = bboxOf(e);
    switch (edge) {
      case "left":
        return translate(e, box.x - b.x, 0);
      case "right":
        return translate(e, box.x + box.w - (b.x + b.w), 0);
      case "hcenter":
        return translate(e, box.x + box.w / 2 - (b.x + b.w / 2), 0);
      case "top":
        return translate(e, 0, box.y - b.y);
      case "bottom":
        return translate(e, 0, box.y + box.h - (b.y + b.h));
      default:
        return translate(e, 0, box.y + box.h / 2 - (b.y + b.h / 2));
    }
  });
}

/**
 * Equal gaps between three or more elements, along one axis.
 *
 * The two outermost stay put — they define the span the rest are spread
 * inside — and the gap is the leftover space divided evenly, so shapes of
 * different sizes end up evenly SPACED rather than evenly numbered.
 */
export function distribute(els: SketchElement[], axis: "x" | "y"): SketchElement[] {
  if (els.length < 3) return els;
  const order = orderedOnAxis(els, axis);
  const span = bboxOfMany(order);
  if (!span) return els;
  const moved = distributedOnAxis(order, span, axis);
  // Returned in the caller's order, not the sorted one: the document's element
  // order is its z-order, and quietly restacking a drawing because someone
  // tidied it is a change nobody asked for.
  return els.map((e) => moved.get(e.id) ?? e);
}

export type Axis = "x" | "y";

function orderedOnAxis(elements: SketchElement[], axis: Axis): SketchElement[] {
  return [...elements].sort((first, second) => axisOrigin(bboxOf(first), axis) - axisOrigin(bboxOf(second), axis));
}

function distributedOnAxis(
  elements: SketchElement[],
  span: Rect,
  axis: Axis,
): Map<string, SketchElement> {
  const gap = (axisSize(span, axis) - totalAxisSize(elements, axis)) / (elements.length - 1);
  const moved = new Map<string, SketchElement>();
  let cursor = axisOrigin(span, axis);
  for (const element of elements) {
    const bounds = bboxOf(element);
    moved.set(element.id, moveToAxisOrigin(element, cursor, axis));
    cursor += axisSize(bounds, axis) + gap;
  }
  return moved;
}

function totalAxisSize(elements: SketchElement[], axis: Axis): number {
  return elements.reduce((total, element) => total + axisSize(bboxOf(element), axis), 0);
}

export function axisOrigin(rect: Rect, axis: Axis): number {
  return axis === "x" ? rect.x : rect.y;
}

export function axisSize(rect: Rect, axis: Axis): number {
  return axis === "x" ? rect.w : rect.h;
}

function moveToAxisOrigin(element: SketchElement, origin: number, axis: Axis): SketchElement {
  const delta = origin - axisOrigin(bboxOf(element), axis);
  return axis === "x" ? translate(element, delta, 0) : translate(element, 0, delta);
}

export type Ordering = "front" | "forward" | "backward" | "back";

/**
 * Move elements through the z-order, which IS the document's element order.
 *
 * The moved set keeps its own relative order in every direction, so sending
 * three overlapping shapes to the back does not shuffle them against each
 * other on the way.
 */
export function reorder(doc: Sketch, ids: string[], where: Ordering): Sketch {
  const picked = new Set(ids);
  if (!picked.size) return doc;
  const { moving, rest } = separatedElements(doc.elements, picked);
  if (!moving.length) return doc;
  const boundaryOrder = reorderedAtBoundary(moving, rest, where);
  if (boundaryOrder) return { ...doc, elements: boundaryOrder };
  // One step. Walk in the direction of travel so a run of selected elements
  // moves as a block instead of piling onto the first free slot.
  return { ...doc, elements: reorderedOneStep(doc.elements, picked, where) };
}

function separatedElements(elements: SketchElement[], picked: Set<string>): {
  moving: SketchElement[];
  rest: SketchElement[];
} {
  return {
    moving: elements.filter((element) => picked.has(element.id)),
    rest: elements.filter((element) => !picked.has(element.id)),
  };
}

function reorderedAtBoundary(
  moving: SketchElement[],
  rest: SketchElement[],
  where: Ordering,
): SketchElement[] | null {
  if (where === "front") return [...rest, ...moving];
  if (where === "back") return [...moving, ...rest];
  return null;
}

function reorderedOneStep(
  elements: SketchElement[],
  picked: Set<string>,
  where: Ordering,
): SketchElement[] {
  const next = [...elements];
  const step = where === "forward" ? 1 : -1;
  const order = indexesInTravelOrder(next.length, step);
  for (const i of order) {
    swapSelectedElement(next, picked, i, step);
  }
  return next;
}

function swapSelectedElement(
  elements: SketchElement[],
  picked: Set<string>,
  index: number,
  step: number,
): void {
  const adjacent = index + step;
  if (!isElementIndex(elements, adjacent)) return;
  if (!movesPastUnselectedElement(elements, picked, index, adjacent)) return;
  [elements[index], elements[adjacent]] = [elements[adjacent], elements[index]];
}

function isElementIndex(elements: SketchElement[], index: number): boolean {
  return index >= 0 && index < elements.length;
}

function movesPastUnselectedElement(
  elements: SketchElement[],
  picked: Set<string>,
  index: number,
  adjacent: number,
): boolean {
  return picked.has(elements[index].id) && !picked.has(elements[adjacent].id);
}

function indexesInTravelOrder(length: number, step: number): number[] {
  const indexes = Array.from({ length }, (_, index) => index);
  return step === 1 ? indexes.reverse() : indexes;
}

/** How far a copy lands from its original, so it is visibly a second thing. */
