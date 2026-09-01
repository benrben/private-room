/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { has } from "./sketchDocJson.js";
import { Element, OFF_PAGE_SLACK, Point, Rect, Sketch, asciiLower, compareUtf8, elementBbox, elementIsSolid, elementWords, grow, rectBottom, rectContains, rectOverlap, rectRight, rustTrim } from "./sketchDocModel.js";
// ---------------------------------------------------------------------------
// The layout checker
// ---------------------------------------------------------------------------

/**
 * Problems a drawing can have that are visible at a glance but invisible in
 * text.
 *
 * This is the other half of "let the agent see its work". A rendered picture
 * only helps a model that can read pictures well, and the small local models
 * this app is built around cannot. Every check here is geometric, exact, and
 * phrased as an instruction the model can act on directly.
 */
export function layoutReport(doc: Sketch): string[] {
  const solids = doc.elements.filter(elementIsSolid);
  const notes = [
    ...overlapNotes(solids),
    ...offPageNotes(doc.elements, doc.width, doc.height),
    ...unlabelledNotes(doc.elements),
    ...nearMissNotes(doc.elements, solids),
    ...textOverlapNotes(doc.elements, solids),
    ...duplicateLabelNotes(doc.elements),
  ];
  return uniqueSortedNotes(notes);
}

/** Overlapping shapes are the most common unreadable generated diagram. */
export function overlapNotes(solids: readonly Element[]): string[] {
  const notes: string[] = [];
  for (let first = 0; first < solids.length; first += 1) {
    for (let second = first + 1; second < solids.length; second += 1) {
      const left = solids[first] as Element;
      const right = solids[second] as Element;
      const overlap = rectOverlap(elementBbox(left), elementBbox(right));
      if (overlap !== null) {
        notes.push(`${left.id} and ${right.id} overlap by ${overlap[0]}×${overlap[1]} — move one of them apart.`);
      }
    }
  }
  return notes;
}

export function offPageNotes(elements: readonly Element[], width: number, height: number): string[] {
  const notes: string[] = [];
  for (const element of elements) {
    const bounds = elementBbox(element);
    if (!isOffPage(bounds, width, height)) {
      continue;
    }
    notes.push(
      `${element.id} sits outside the ${width}×${height} page (at ${bounds.x} ${bounds.y}, ${bounds.w}×${bounds.h}) — move it back on.`
    );
  }
  return notes;
}

export function isOffPage(bounds: Rect, width: number, height: number): boolean {
  return outsideHorizontally(bounds, width) || outsideVertically(bounds, height);
}

export function outsideHorizontally(bounds: Rect, width: number): boolean {
  return bounds.x < -OFF_PAGE_SLACK || rectRight(bounds) > width + OFF_PAGE_SLACK;
}

export function outsideVertically(bounds: Rect, height: number): boolean {
  return bounds.y < -OFF_PAGE_SLACK || rectBottom(bounds) > height + OFF_PAGE_SLACK;
}

/** A box without a word is invisible to text-only readers of the drawing. */
export function unlabelledNotes(elements: readonly Element[]): string[] {
  const notes: string[] = [];
  for (const element of elements) {
    if (!isUnlabelledSolid(element)) {
      continue;
    }
    notes.push(`${element.id} has no label — give it one so it can be read.`);
  }
  return notes;
}

export function isUnlabelledSolid(element: Element): boolean {
  return elementIsSolid(element) && rustTrim(element.label ?? "") === "";
}

/** A free arrow is legitimate; an endpoint that nearly reaches a box is not. */
export function nearMissNotes(elements: readonly Element[], solids: readonly Element[]): string[] {
  const notes: string[] = [];
  for (const element of elements) {
    if (element.shape.type !== "arrow" || !arrowNearlyMissesSolid(element, solids)) {
      continue;
    }
    notes.push(
      `${element.id} nearly touches a shape but stops short — use \`link\` to connect two shapes instead of placing arrow ends by hand.`
    );
  }
  return notes;
}

export function arrowNearlyMissesSolid(arrow: Element, solids: readonly Element[]): boolean {
  const [start, end] = arrow.shape.type === "arrow" ? arrow.shape.points : [];
  if (start === undefined || end === undefined) {
    return false;
  }
  return endpointNearlyMissesSolid(start, solids) || endpointNearlyMissesSolid(end, solids);
}

export function endpointNearlyMissesSolid(point: Point, solids: readonly Element[]): boolean {
  return !pointTouchesSolid(point, solids) && pointIsNearSolid(point, solids);
}

export function pointTouchesSolid(point: Point, solids: readonly Element[]): boolean {
  return solids.some((solid) => rectContains(grow(elementBbox(solid), 14), point[0], point[1]));
}

export function pointIsNearSolid(point: Point, solids: readonly Element[]): boolean {
  return solids.some((solid) => rectContains(grow(elementBbox(solid), 90), point[0], point[1]));
}

/** Text over a shape reads as its caption, even when it was meant as a note. */
export function textOverlapNotes(elements: readonly Element[], solids: readonly Element[]): string[] {
  const notes: string[] = [];
  for (const element of elements) {
    if (element.shape.type === "text") {
      notes.push(...textNotesOverSolids(element, solids));
    }
  }
  return notes;
}

export function textNotesOverSolids(note: Element, solids: readonly Element[]): string[] {
  const notes: string[] = [];
  for (const solid of solids) {
    if (textOverlapsSolid(note, solid)) {
      notes.push(`the note ${note.id} lies on top of ${solid.id} — move it clear, or make it ${solid.id}'s label.`);
    }
  }
  return notes;
}

export function textOverlapsSolid(note: Element, solid: Element): boolean {
  const overlap = rectOverlap(elementBbox(note), elementBbox(solid));
  return overlap !== null && overlap[0] > 8 && overlap[1] > 8;
}

/** Boxes and notes may have duplicate text; arrows deliberately may not. */
export function duplicateLabelNotes(elements: readonly Element[]): string[] {
  const seen = new Map<string, string>();
  const notes: string[] = [];
  for (const e of elements) {
    const words = duplicateLabelWords(e);
    if (words === null) {
      continue;
    }
    const key = asciiLower(words);
    const prev = seen.get(key);
    seen.set(key, e.id);
    if (prev !== undefined) {
      notes.push(`${prev} and ${e.id} both say "${words}" — delete one if it is a duplicate.`);
    }
  }
  return notes;
}

export function duplicateLabelWords(element: Element): string | null {
  if (!elementIsSolid(element) && element.shape.type !== "text") {
    return null;
  }
  const words = elementWords(element);
  if (words === null) {
    return null;
  }
  const trimmed = rustTrim(words);
  return trimmed === "" ? null : trimmed;
}

/** Rust's `sort` then `dedup`, including its UTF-8 byte ordering. */
export function uniqueSortedNotes(notes: string[]): string[] {
  notes.sort(compareUtf8);
  return notes.filter(isFirstUniqueNote);
}

export function isFirstUniqueNote(note: string, index: number, notes: readonly string[]): boolean {
  return index === 0 || note !== notes[index - 1];
}
