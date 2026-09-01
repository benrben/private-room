import { describe, expect, it } from "vitest";
import {
  CANVAS_H,
  CANVAS_W,
  distribute,
  emptySketch,
  fitToBox,
  guidesFor,
  hitTest,
  kindOf,
  parseSketch,
  reorder,
  resizedBox,
  reflow,
  routeBetween,
  simplify,
  type SketchElement,
} from "./model";

type BoxElement = Extract<SketchElement, { type: "rect" }>;

const box = (id: string, x: number, y: number, w: number, h: number): BoxElement => ({
  id,
  type: "rect",
  x,
  y,
  w,
  h,
  ink: "blue",
});

const documentOf = (...elements: SketchElement[]) => ({
  ...emptySketch(),
  seq: elements.length,
  elements,
});

describe("sketch model geometry", () => {
  it("keeps each persisted element kind while rejecting malformed shapes", () => {
    const { doc, error } = parseSketch(
      JSON.stringify({
        version: 2,
        width: 0,
        height: -1,
        seq: -4,
        elements: [
          box("e2", 0, 0, 10, 10),
          { id: "e3", type: "ellipse", x: 0, y: 0, w: 10, h: 10, ink: "blue" },
          { id: "e4", type: "text", x: 0, y: 0, text: "note", size: 12, ink: "blue" },
          { id: "e5", type: "arrow", points: [[0, 0], [1, 1]], ink: "blue" },
          { id: "e6", type: "line", points: [[0, 0], [1, 1]], ink: "blue" },
          { id: "e7", type: "pen", points: [[0, 0], [1, 1]], ink: "blue" },
          { id: "bad-points", type: "pen", points: [[0, 0]], ink: "blue" },
          { id: "bad-type", type: "unicorn", x: 0, y: 0 },
          { id: "non-string-type", type: 3, x: 0, y: 0 },
        ],
      }),
    );

    expect(error).toBeNull();
    expect(doc.width).toBe(CANVAS_W);
    expect(doc.height).toBe(CANVAS_H);
    expect(doc.seq).toBe(7);
    expect(doc.elements.map((element) => element.id)).toEqual([
      "e2",
      "e3",
      "e4",
      "e5",
      "e6",
      "e7",
    ]);
  });

  it("keeps the resize and hit-test boundaries for sides, empty dimensions, and polylines", () => {
    expect(resizedBox({ x: 10, y: 20, w: 40, h: 30 }, "s", 99, 15)).toEqual({
      x: 10,
      y: 20,
      w: 40,
      h: 45,
    });
    expect(resizedBox({ x: 10, y: 20, w: 0, h: 30 }, "se", 15, 10, true)).toEqual({
      x: 10,
      y: 20,
      w: 15,
      h: 40,
    });

    const line: SketchElement = {
      id: "line",
      type: "line",
      points: [[0, 0], [100, 0]],
      ink: "blue",
    };
    expect(hitTest(documentOf(line), 50, 5)).toBe(line);
    expect(hitTest(documentOf(line), 50, 50)).toBeNull();
  });

  it("keeps labels and arrangement order for every element kind and both axes", () => {
    expect(kindOf({ id: "oval", type: "ellipse", x: 0, y: 0, w: 1, h: 1, ink: "blue" })).toBe(
      "Ellipse",
    );
    expect(kindOf({ id: "note", type: "text", x: 0, y: 0, text: "", size: 12, ink: "blue" })).toBe(
      "Note",
    );
    expect(kindOf({ id: "line", type: "line", points: [[0, 0], [1, 1]], ink: "blue" })).toBe("Line");
    expect(kindOf({ id: "pen", type: "pen", points: [[0, 0], [1, 1]], ink: "blue" })).toBe("Stroke");

    const verticallySpaced = distribute(
      [box("first", 0, 0, 20, 20), box("middle", 0, 150, 20, 40), box("last", 0, 400, 20, 20)],
      "y",
    );
    expect(verticallySpaced.map((element) => element.id)).toEqual(["first", "middle", "last"]);
    expect(verticallySpaced[1]).toMatchObject({ y: 190 });

    const original = documentOf(box("a", 0, 0, 1, 1), box("b", 0, 0, 1, 1), box("c", 0, 0, 1, 1));
    expect(reorder(original, ["b", "c"], "backward").elements.map((element) => element.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(reorder(original, [], "front")).toBe(original);
  });

  it("retains connected geometry unless an attachment is missing", () => {
    const source = box("source", 0, 0, 100, 100);
    const target = box("target", 300, 0, 100, 100);
    const points = routeBetween(
      { x: source.x, y: source.y, w: source.w, h: source.h },
      { x: target.x, y: target.y, w: target.w, h: target.h },
    );
    const connected: SketchElement = {
      id: "connector",
      type: "arrow",
      points,
      ink: "blue",
      from: source.id,
      to: target.id,
    };
    const stable = documentOf(source, target, connected);
    expect(reflow(stable)).toBe(stable);

    const halfAttached: SketchElement = {
      ...connected,
      id: "half-attached",
      to: undefined,
    };
    const halfDocument = documentOf(source, halfAttached);
    expect(reflow(halfDocument)).toBe(halfDocument);

    const missing: SketchElement = { ...connected, id: "missing", to: "gone" };
    const detached = reflow(documentOf(source, missing)).elements[1];
    expect(detached).not.toHaveProperty("from");
    expect(detached).not.toHaveProperty("to");
  });

  it("finds vertical guides and preserves the simplifier's endpoint rules", () => {
    const snap = guidesFor(
      { x: 300, y: 103, w: 50, h: 50 },
      [{ x: 0, y: 100, w: 50, h: 50 }],
    );
    expect(snap.dy).toBe(-3);
    expect(snap.guides).toContainEqual({ axis: "y", at: 100 });

    expect(simplify([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
    expect(simplify([[0, 0], [1, 0], [2, 0]])).toEqual([[0, 0], [2, 0]]);
  });

  it("maps a rectangle proportionally between ordinary boxes", () => {
    const element: SketchElement = {
      id: "rect",
      type: "rect",
      x: 35,
      y: 30,
      w: 20,
      h: 10,
      ink: "blue",
      fill: true,
      label: "Fabricated box",
    };

    expect(fitToBox(element, { x: 10, y: 20, w: 100, h: 50 }, { x: 200, y: 100, w: 300, h: 100 }))
      .toEqual({ ...element, x: 275, y: 120, w: 60, h: 20 });
  });

  it("keeps an ellipse at the canvas edge with the minimum persisted size", () => {
    const element: SketchElement = {
      id: "edge-ellipse",
      type: "ellipse",
      x: 9,
      y: 9,
      w: 5,
      h: 5,
      ink: "green",
    };

    expect(fitToBox(element, { x: 0, y: 0, w: 10, h: 10 }, { x: 1590, y: 995, w: 10, h: 10 }))
      .toEqual({ ...element, x: 1599, y: 1000, w: 12, h: 12 });
  });

  it("scales text by the smaller aspect factor instead of stretching its glyphs", () => {
    const element: SketchElement = {
      id: "note",
      type: "text",
      x: 40,
      y: 25,
      text: "Fabricated note",
      size: 20,
      ink: "red",
    };

    expect(fitToBox(element, { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 50, h: 200 }))
      .toEqual({ ...element, x: 20, y: 50, size: 10 });
  });

  it("maps a fabricated stroke from a degenerate source box without dividing by zero", () => {
    const element: SketchElement = {
      id: "stroke",
      type: "pen",
      points: [[10, 20], [30, 45]],
      ink: "pink",
    };

    expect(fitToBox(element, { x: 10, y: 20, w: 0, h: 0 }, { x: 100, y: 200, w: 800, h: 600 }))
      .toEqual({ ...element, points: [[100, 200], [120, 225]] });
  });
});
