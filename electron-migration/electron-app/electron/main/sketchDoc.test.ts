/**
 * Tests for `sketchDoc.ts` — the `.sketch` document format's engine, ported
 * from `src-tauri/src/commands/sketchdoc.rs`.
 *
 * THREE LAYERS, and the third is the one that makes this a fidelity suite
 * rather than a self-consistency suite:
 *
 * 1. Every one of `sketchdoc.rs`'s own `mod tests` cases, ported.
 * 2. Hand-computed geometry (the `layoutGraph` column/row arithmetic, the
 *    router's `ROUTER_FIXTURES` table) — numbers derived from the layout
 *    rules, not read back out of this implementation.
 * 3. ORACLE FIXTURES. `ORACLE_*` below are the literal bytes a compiled
 *    `rustc` build of the pure half of `sketchdoc.rs` printed for the same
 *    inputs. They pin the things a plausible-looking port silently gets
 *    wrong and no property test would notice: `{:.0}`/`{:.1}` tie-to-even
 *    float formatting, `f64::round`'s tie-away-from-zero, the six-draw order
 *    of the seeded PRNG inside `wobbly_segment`, `i32` truncating division
 *    in the pen path, and the exact `to_script` spellings.
 */

import { describe, expect, it } from "vitest";
import {
  applyScript,
  asciiLower,
  CANVAS_H,
  CANVAS_W,
  compareUtf8,
  defaultSketch,
  type Element,
  elementBbox,
  elementIsSolid,
  fixed,
  type GraphEdge,
  type GraphNode,
  type Ink,
  inkParse,
  layoutGraph,
  layoutReport,
  MAX_ELEMENTS,
  plainElement,
  type Point,
  type Rect,
  reflow,
  roundTiesAwayFromZero,
  route,
  type ScriptOutcome,
  scriptOutcomeIsEmpty,
  scriptOutcomeSummary,
  type Shape,
  type Sketch,
  sketchExtractedText,
  sketchFromJson,
  sketchToJson,
  toScript,
  toSvg,
  xmlEscape,
} from "./sketchDoc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `sketchdoc.rs`'s own test helper: apply a script that must succeed. */
function draw(script: string): Sketch {
  const doc = defaultSketch();
  const out = applyScript(doc, script);
  if (!out.ok) {
    throw new Error(`script should apply: ${out.error}`);
  }
  return doc;
}

function refuse(doc: Sketch, script: string): string {
  const out = applyScript(doc, script);
  if (out.ok) {
    throw new Error("script should have been refused");
  }
  return out.error;
}

function apply(doc: Sketch, script: string): ScriptOutcome {
  const out = applyScript(doc, script);
  if (!out.ok) {
    throw new Error(`script should apply: ${out.error}`);
  }
  return out.value;
}

function points(e: Element): Point[] {
  if (e.shape.type !== "arrow" && e.shape.type !== "line" && e.shape.type !== "pen") {
    throw new Error(`expected a point list, got ${e.shape.type}`);
  }
  return e.shape.points;
}

function node(id: string, label: string): GraphNode {
  return { id, label };
}
function edge(a: string, b: string): GraphEdge {
  return { from: a, to: b, label: "then" };
}

const solids = (doc: Sketch): Element[] => doc.elements.filter(elementIsSolid);
const arrows = (doc: Sketch): Element[] => doc.elements.filter((e) => e.shape.type === "arrow");

// ---------------------------------------------------------------------------
// Oracle fixtures — literal output of a compiled `rustc` build of the pure
// half of `sketchdoc.rs`, for the document `oracleDoc()` rebuilds below.
// ---------------------------------------------------------------------------

const ORACLE_SVG =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1600\" height=\"1000\" viewBox=\"0 0 1600 1000\"><rect width=\"1600\" height=\"1000\" fill=\"#f4f1e8\"/><rect x=\"100\" y=\"100\" width=\"301\" height=\"151\" rx=\"8\" fill=\"#d8e5f5\"/><path d=\"M98.6 102.2Q250.4 100.6 402.0 98.3M400.2 101.7Q402.1 178.2 399.8 251.9M402.1 252.8Q254.4 247.4 98.2 251.2M100.8 249.8Q97.2 172.6 99.6 99.4M99.3 101.5Q246.8 102.8 399.6 98.8M399.0 99.1Q400.9 173.2 400.0 252.6M401.5 250.2Q251.1 249.1 100.1 250.3M99.6 251.3Q103.7 177.8 98.0 101.0\" fill=\"none\" stroke=\"#2563b0\" stroke-width=\"3\" stroke-linecap=\"round\"/><text x=\"250\" y=\"184\" font-family=\"Bradley Hand, Noteworthy, Chalkboard SE, Segoe Print, Comic Sans MS, cursive, sans-serif\" font-size=\"26\" fill=\"#2563b0\" text-anchor=\"middle\">Login form</text><ellipse cx=\"800.5\" cy=\"349.5\" rx=\"100.5\" ry=\"49.5\" fill=\"#f5dcd8\"/><path d=\"M897.5 358.6Q891.5 367.7 880.4 375.0Q869.3 382.2 854.7 390.1Q840.1 398.0 820.3 398.9Q800.5 399.7 781.8 396.3Q763.0 392.8 747.3 387.6Q731.6 382.3 719.6 375.4Q707.6 368.5 703.3 359.0Q699.1 349.5 704.2 340.4Q709.4 331.3 720.0 323.4Q730.5 315.6 745.7 308.3Q760.9 301.0 780.7 298.7Q800.5 296.5 819.9 299.8Q839.2 303.1 856.1 308.1Q872.9 313.1 883.8 321.6Q894.7 330.0 899.1 339.8Q903.5 349.5 897.5 358.6ZM895.6 358.6Q891.5 367.7 882.6 377.1Q873.6 386.6 855.8 389.7Q838.0 392.9 819.3 395.1Q800.5 397.3 781.0 397.0Q761.4 396.7 746.2 389.8Q731.0 382.9 718.0 376.2Q705.0 369.5 701.3 359.5Q697.6 349.5 703.0 340.2Q708.4 330.9 717.8 321.5Q727.1 312.2 744.8 308.5Q762.5 304.9 781.5 302.1Q800.5 299.3 820.3 300.1Q840.2 300.8 854.8 308.7Q869.4 316.6 880.4 324.0Q891.3 331.4 895.6 340.4Q899.8 349.5 895.6 358.6Z\" fill=\"none\" stroke=\"#b3362b\" stroke-width=\"3\" stroke-linecap=\"round\"/><text x=\"800\" y=\"358\" font-family=\"Bradley Hand, Noteworthy, Chalkboard SE, Segoe Print, Comic Sans MS, cursive, sans-serif\" font-size=\"26\" fill=\"#b3362b\" text-anchor=\"middle\">a &lt; b &amp; &quot;c&quot;</text><text x=\"50\" y=\"900\" font-family=\"Bradley Hand, Noteworthy, Chalkboard SE, Segoe Print, Comic Sans MS, cursive, sans-serif\" font-size=\"28\" fill=\"#2e7d4f\">retry three times</text><path d=\"M401.5 176.2Q548.4 259.4 700.0 350.3\" fill=\"none\" stroke=\"#b23a78\" stroke-width=\"3\" stroke-linecap=\"round\"/><path d=\"M700.0 349.0L680.0 349.3\" stroke=\"#b23a78\" stroke-width=\"3\" fill=\"none\" stroke-linecap=\"round\"/><path d=\"M700.0 349.0L690.4 331.5\" stroke=\"#b23a78\" stroke-width=\"3\" fill=\"none\" stroke-linecap=\"round\"/><text x=\"550\" y=\"250\" font-family=\"Bradley Hand, Noteworthy, Chalkboard SE, Segoe Print, Comic Sans MS, cursive, sans-serif\" font-size=\"24\" fill=\"#b23a78\" text-anchor=\"middle\">credentials</text><path d=\"M11.5 9.9Q451.0 11.6 902.2 10.0\" fill=\"none\" stroke=\"#8a6d0b\" stroke-width=\"3\" stroke-linecap=\"round\"/><path d=\"M10 20Q10 20 12 23Q15 27 18 28Q21 30 25 35L30 41\" fill=\"none\" stroke=\"#2e7d4f\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>";

const ORACLE_SCRIPT =
  "canvas 1600 1000\ne1 rect 100 100 301 151 blue fill \"Login form\"\ne2 ellipse 700 300 201 99 red fill \"a < b & 'c'\"\ne3 text 50 900 green 28 \"retry three times\"\ne4 arrow 401 175 700 349 pink \"credentials\"\ne5 line 10 10 900 12 yellow\ne6 pen green — freehand, 4 points around 10 20 (20×21) \"squiggle\"\n";

/** The document the oracle rendered. Odd widths on purpose: a 301-wide rect
 * centres at 250.5 and a 201-wide ellipse at 800.5, which is exactly where
 * `{:.0}`'s tie-to-even rule bites. The last element is a one-point arrow —
 * built in memory, so it never passed through `sketchFromJson`'s drop — which
 * both `toSvg` and `toScript` must skip rather than index into. */
function oracleDoc(): Sketch {
  const doc = defaultSketch();
  const push = (id: string, shape: Shape, ink: Ink, fill: boolean, label: string | null): void => {
    doc.elements.push({ ...plainElement(), id, shape, ink, fill, label });
  };
  push("e1", { type: "rect", x: 100, y: 100, w: 301, h: 151 }, "blue", true, "Login form");
  push("e2", { type: "ellipse", x: 700, y: 300, w: 201, h: 99 }, "red", true, 'a < b & "c"');
  push("e3", { type: "text", x: 50, y: 900, text: "retry three times", size: 28 }, "green", false, null);
  push("e4", { type: "arrow", points: [[401, 175], [700, 349]] }, "pink", false, "credentials");
  push("e5", { type: "line", points: [[10, 10], [900, 12]] }, "yellow", false, null);
  push("e6", { type: "pen", points: [[10, 20], [15, 27], [21, 30], [30, 41]] }, "green", false, "squiggle");
  push("e7", { type: "arrow", points: [[5, 5]] }, "red", false, null);
  doc.seq = 7;
  return doc;
}

describe("fidelity against a compiled-Rust oracle", () => {
  it("renders the exact SVG bytes rustc produced for the same document", () => {
    expect(toSvg(oracleDoc())).toBe(ORACLE_SVG);
  });

  it("reads back the exact script bytes rustc produced for the same document", () => {
    expect(toScript(oracleDoc())).toBe(ORACLE_SCRIPT);
  });

  it("routes to the exact endpoints rustc produced, negative and lopsided boxes included", () => {
    // The Rust source's own ROUTER_FIXTURES (its comment: "not a
    // re-derivation of the formula — these are the numbers the TS port
    // yields"), plus four more the oracle answered, of which the negative one
    // lands on an EXACT .5 tie and so separates `f64::round` (ties away from
    // zero, -228) from `Math.round` (ties to +∞, -227).
    const cases: Array<[Rect, Rect, Point, Point]> = [
      [{ x: 100, y: 100, w: 200, h: 100 }, { x: 700, y: 100, w: 200, h: 100 }, [308, 150], [692, 150]],
      [{ x: 100, y: 100, w: 200, h: 100 }, { x: 100, y: 500, w: 200, h: 100 }, [200, 208], [200, 492]],
      [{ x: 0, y: 0, w: 200, h: 200 }, { x: 400, y: 400, w: 200, h: 200 }, [208, 208], [392, 392]],
      [{ x: 100, y: 100, w: 200, h: 100 }, { x: 150, y: 125, w: 100, h: 50 }, [200, 150], [200, 150]],
      [{ x: 0, y: 0, w: 101, h: 51 }, { x: 333, y: 777, w: 55, h: 33 }, [64, 59], [351, 769]],
      [{ x: -400, y: -300, w: 200, h: 100 }, { x: 100, y: 100, w: 200, h: 100 }, [-228, -192], [128, 92]],
      [{ x: 100, y: 200, w: 200, h: 100 }, { x: 1900, y: 200, w: 200, h: 100 }, [308, 250], [1892, 250]],
      [{ x: 7, y: 9, w: 3, h: 5 }, { x: 11, y: 9, w: 3, h: 5 }, [18, 12], [3, 12]],
    ];
    for (const [a, b, start, end] of cases) {
      expect(route(a, b), `routing ${JSON.stringify(a)} → ${JSON.stringify(b)}`).toEqual([start, end]);
    }
  });

  it("measures a text bbox exactly as rustc does, counting code points not code units", () => {
    const text = (t: string, size: number): Rect =>
      elementBbox({ ...plainElement(), id: "t", shape: { type: "text", x: 5, y: 50, text: t, size } });
    expect(text("hello", 30)).toEqual({ x: 5, y: 20, w: 78, h: 38 });
    expect(text("שלום", 22)).toEqual({ x: 5, y: 28, w: 46, h: 28 });
    expect(text("a", 10)).toEqual({ x: 5, y: 40, w: 5, h: 13 });
    // Nine code points, not the ten UTF-16 code units `.length` would report.
    expect(text("emoji 😀 x", 24)).toEqual({ x: 5, y: 26, w: 112, h: 30 });
  });

  it("formats floats with Rust's tie-to-even `{:.N}`, not toFixed's tie-away-from-zero", () => {
    expect(fixed(250.5, 0)).toBe("250");
    expect(fixed(251.5, 0)).toBe("252");
    expect(fixed(-250.5, 0)).toBe("-250");
    expect(fixed(0.5, 0)).toBe("0");
    expect(fixed(1.5, 0)).toBe("2");
    expect(fixed(0.25, 1)).toBe("0.2");
    expect(fixed(-0.25, 1)).toBe("-0.2");
    expect(fixed(0.75, 1)).toBe("0.8");
    // Not a tie: 0.35 and 2.05 are both a hair BELOW their decimal spelling.
    expect(fixed(0.35, 1)).toBe("0.3");
    expect(fixed(2.05, 1)).toBe("2.0");
    // Everything that is not an exact tie still agrees with toFixed.
    for (const v of [0, -0.4, 12.34, -98.76, 1600, 3.14159]) {
      expect(fixed(v, 1)).toBe(v.toFixed(1));
    }
  });

  it("rounds ties away from zero, as `f64::round` does", () => {
    expect(roundTiesAwayFromZero(-0.5)).toBe(-1);
    expect(roundTiesAwayFromZero(2.5)).toBe(3);
    expect(roundTiesAwayFromZero(-2.5)).toBe(-3);
    expect(roundTiesAwayFromZero(-227.5)).toBe(-228);
    expect(Math.round(-227.5)).toBe(-227); // …which is what a naive port writes.
  });

  it("lower-cases ASCII only, as `to_ascii_lowercase` does", () => {
    expect(asciiLower("CAFÉ")).toBe("cafÉ");
    expect(asciiLower("RECT")).toBe("rect");
  });

  it("orders strings by UTF-8 bytes, as Rust's `String: Ord` does", () => {
    const fullwidth = "e1 Ａ";
    const emoji = "e1 \u{1F600}";
    expect(compareUtf8(fullwidth, emoji)).toBeLessThan(0);
    // JS's own comparison disagrees above the BMP, which is the whole point.
    expect(fullwidth < emoji).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The script language
// ---------------------------------------------------------------------------

describe("inkParse", () => {
  it("accepts the five names and the near-misses a model reaches for", () => {
    expect(inkParse("pink")).toBe("pink");
    expect(inkParse(" MAGENTA ")).toBe("pink");
    expect(inkParse("orange")).toBe("yellow");
    expect(inkParse("teal")).toBe("green");
    expect(inkParse("navy")).toBe("blue");
    expect(inkParse("crimson")).toBe("red");
  });

  it("refuses an unknown colour word rather than guessing", () => {
    expect(inkParse("bleu")).toBeNull();
    expect(inkParse("#1a1a1a")).toBeNull();
    expect(inkParse("")).toBeNull();
  });
});

describe("the forgiving parser", () => {
  it("the positional and named spellings of a box mean the same thing", () => {
    const a = draw('rect 250 400 320 130 blue "Login form"');
    const b = draw('rect x=250 y=400 w=320 h=130 ink=blue "Login form"');
    expect((a.elements[0] as Element).shape).toEqual((b.elements[0] as Element).shape);
    expect((a.elements[0] as Element).ink).toBe("blue");
    expect((a.elements[0] as Element).label).toBe("Login form");
  });

  it("the label may come before or after the colour", () => {
    expect(draw('rect 10 10 100 80 green "Done"').elements[0]).toEqual(
      draw('rect 10 10 100 80 "Done" green').elements[0]
    );
  });

  it("a hash followed by a digit is a reference and anything else is a comment", () => {
    const d = draw(
      'rect 100 100 200 100 blue "A"\n' +
        'rect 600 100 200 100 blue "B"\n' +
        'link #1 #2 green "talks to"   # this trailing note is not a reference'
    );
    expect(d.elements).toHaveLength(3);
    const p = points(d.elements[2] as Element);
    // Routed edge to edge: it starts RIGHT of A and ends LEFT of B.
    expect((p[0] as Point)[0]).toBeGreaterThan(300);
    expect((p[1] as Point)[0]).toBeLessThan(600);
    expect((d.elements[2] as Element).label).toBe("talks to");
  });

  it("integers written as floats or in exponent form are accepted; hex is not", () => {
    const d = draw('rect 250.0 400.4 320 130 blue "float"');
    expect((d.elements[0] as Element).shape).toEqual({ type: "rect", x: 250, y: 400, w: 320, h: 130 });
    // `1e2` is a number to Rust's `f64::from_str`, so it is one here.
    expect((draw("rect 1e2 10 50 50 blue \"exp\"").elements[0] as Element).shape).toMatchObject({ x: 100 });
    // `0x10` is not, so it is reported as an unknown word rather than 16.
    expect(refuse(defaultSketch(), 'rect 0x10 10 50 50 blue "hex"')).toContain("0x10");
  });

  it("a quoted label may contain the quote mark that delimits it", () => {
    const d = draw('rect 10 10 200 100 blue "a < b & \\"c\\""');
    expect((d.elements[0] as Element).label).toBe('a < b & "c"');
  });

  it("a line that starts with a label says to put the command first", () => {
    expect(refuse(defaultSketch(), '"just some words"')).toContain("put the command first");
  });

  it("a script token cannot pollute Object.prototype", () => {
    // `named` is a Map: a `__proto__=…` token is an ordinary key, not a write
    // through the prototype chain. (The line still parses — the four
    // positional numbers are all there — which is exactly the case a plain
    // `{}` would have quietly written a prototype property for.)
    const d = defaultSketch();
    apply(d, 'rect __proto__=1 constructor=x 10 10 100 100 blue "Hi"');
    expect(elementBbox(d.elements[0] as Element)).toEqual({ x: 10, y: 10, w: 100, h: 100 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const doc = sketchFromJson(
      '{"version":1,"width":1600,"height":1000,"seq":1,"elements":[' +
        '{"id":"__proto__","type":"rect","x":0,"y":0,"w":10,"h":10,"ink":"blue","label":"__proto__"}]}'
    );
    layoutReport(doc);
    reflow(doc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });
});

describe("the synonyms a model reaches for unprompted", () => {
  it("accepts the alternate argument names", () => {
    expect((draw('rect x=10 y=20 width=100 height=50 blue "A"').elements[0] as Element).shape).toEqual({
      type: "rect",
      x: 10,
      y: 20,
      w: 100,
      h: 50,
    });
    expect(points(draw("arrow from_x=1 from_y=2 to_x=300 to_y=400 red").elements[0] as Element)).toEqual([
      [1, 2],
      [300, 400],
    ]);
  });

  it("accepts every verb synonym `canon_verb` lists", () => {
    const d = draw(
      'box 10 10 50 50 blue "a"\ncircle 100 10 50 50 red "b"\nnote 10 300 green 20 "c"\nstroke blue 1 1 2 2 3 3\n' +
        'connect e1 e2 green "j"\nnudge e1 0 400\nrename e1 "a2"\nrecolour e1 red\npage 1700 900'
    );
    expect(d.elements.map((e) => e.shape.type)).toEqual(["rect", "ellipse", "text", "pen", "arrow"]);
    expect((d.elements[0] as Element).label).toBe("a2");
    expect((d.elements[0] as Element).ink).toBe("red");
    expect([d.width, d.height]).toEqual([1700, 900]);
  });

  it("takes the fill flag as a bare word, a synonym, or a named value", () => {
    for (const line of ["rect 10 10 100 50 blue fill", "rect 10 10 100 50 blue SOLID", "rect 10 10 100 50 blue filled=yes"]) {
      expect((draw(line).elements[0] as Element).fill, line).toBe(true);
    }
    expect((draw("rect 10 10 100 50 blue").elements[0] as Element).fill).toBe(false);
  });

  it("separates tokens on commas as well as whitespace, and takes either quote mark", () => {
    expect((draw('rect 10,20,100,50 blue "A"').elements[0] as Element).shape).toEqual({ type: "rect", x: 10, y: 20, w: 100, h: 50 });
    expect((draw("rect 10 20 100 50 blue 'Hi there'").elements[0] as Element).label).toBe("Hi there");
    expect((draw("rect 10 20 100 50 blue label=Hi").elements[0] as Element).label).toBe("Hi");
  });

  it("caps a runaway freehand stroke at MAX_POINTS", () => {
    const nums = Array.from({ length: 5000 }, (_, i) => `${i % 1000} ${i % 500}`).join(" ");
    expect(points(draw(`pen blue ${nums}`).elements[0] as Element)).toHaveLength(2000);
  });

  it("clear resets back-references for the lines below it", () => {
    const doc = draw(
      'rect 10 10 100 50 blue "A"\nclear\nrect 20 20 100 50 red "B"\nrect 400 20 100 50 red "C"\nlink #1 #2'
    );
    expect(doc.elements.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
    expect((doc.elements[2] as Element).from).toBe("e2");
  });
});

describe("two-pass validation", () => {
  it("one bad line refuses the whole script and names every problem", () => {
    const d = defaultSketch();
    const err = refuse(
      d,
      'rect 100 100 200 100 blue "Fine"\nrect 300 300 blue "Too few numbers"\nsqaure 10 10 20 20'
    );
    expect(d.elements).toHaveLength(0);
    expect(err).toContain("line 2");
    expect(err).toContain("line 3");
    expect(err).toContain("sqaure");
  });

  it("an unknown colour word is refused rather than silently substituted", () => {
    const d = defaultSketch();
    expect(refuse(d, 'rect 10 10 100 100 bleu "Oops"')).toContain("bleu");
    expect(d.elements).toHaveLength(0);
  });

  it("a back reference past the end is refused before anything is drawn", () => {
    const d = defaultSketch();
    expect(refuse(d, 'rect 10 10 100 100 blue "A"\nlink #1 #9')).toContain("#9");
    expect(d.elements).toHaveLength(0);
  });

  it("editing a shape that is not there is refused with its id", () => {
    expect(refuse(draw('rect 10 10 100 100 blue "a"'), "move e9 10 10")).toContain("e9");
  });

  it("an empty script says what a command looks like", () => {
    expect(refuse(defaultSketch(), "   \n# just a comment\n// and another\n")).toContain("rect");
  });

  it("a runaway script is stopped before it writes a giant file", () => {
    const d = defaultSketch();
    const many = Array.from({ length: MAX_ELEMENTS + 10 }, (_, i) => `rect ${i % 1500} 10 20 20 blue "x"`).join("\n");
    expect(refuse(d, many)).toContain("limit");
    expect(d.elements).toHaveLength(0);
  });

  it("clearing the page first makes room for the redraw", () => {
    // The ceiling counted a script's additions and ignored its deletions, so
    // redrawing a busy page from scratch in one call was refused with a
    // number the script would never reach.
    const d = defaultSketch();
    for (let i = 0; i < 100; i++) {
      apply(d, `rect ${i * 5} 10 40 30 blue "b${i}"`);
    }
    const script = ["clear", ...Array.from({ length: 350 }, (_, i) => `rect ${i * 4} 10 40 30 blue "n${i}"`)].join("\n");
    const out = apply(d, script);
    expect(out.cleared).toBe(true);
    expect(d.elements).toHaveLength(350);
    // …and the ceiling still holds for a script that really would exceed it.
    const over = Array.from({ length: 60 }, (_, i) => `rect ${i * 4} 100 40 30 blue "x${i}"`).join("\n");
    expect(refuse(d, over)).toContain("410");
  });

  it("cannot connect something to itself, by id or by back-reference", () => {
    expect(refuse(draw('rect 10 10 100 100 blue "a"'), "link e1 e1")).toContain("itself");
    expect(refuse(defaultSketch(), 'rect 10 10 100 100 blue "a"\nlink #1 #1')).toContain("itself");
  });
});

describe("ids and receipts", () => {
  it("ids keep climbing after a delete so an old edit cannot hit a new shape", () => {
    const d = draw('rect 10 10 100 100 blue "A"');
    apply(d, "delete e1");
    apply(d, 'rect 10 10 100 100 blue "B"');
    expect((d.elements[0] as Element).id).toBe("e2");
  });

  it("clear then draw leaves only the new work", () => {
    const d = draw('rect 10 10 100 100 blue "old"');
    const out = apply(d, 'clear\nrect 20 20 100 100 red "new"');
    expect(d.elements).toHaveLength(1);
    expect((d.elements[0] as Element).label).toBe("new");
    expect(out.cleared).toBe(true);
    expect(out.added).toHaveLength(1);
  });

  it("the receipt names the ids that actually changed", () => {
    const d = draw('rect 10 10 100 100 blue "a"');
    const out = apply(d, 'rect 300 10 100 100 red "b"\nlabel e1 "renamed"\ndelete e1');
    expect(out.added).toEqual(["e2"]);
    expect(out.changed).toEqual(["e1"]);
    expect(out.removed).toEqual(["e1"]);
    const summary = scriptOutcomeSummary(out);
    expect(summary).toContain("e2");
    expect(summary).toContain("e1");
  });

  it("a long id list is elided the way Rust's `id_list` elides it", () => {
    const d = defaultSketch();
    const out = apply(d, Array.from({ length: 5 }, (_, i) => `rect ${i * 60} 10 40 30 blue "b${i}"`).join("\n"));
    // No Oxford comma: `format!("{}, {} and {} more", …)`.
    expect(scriptOutcomeSummary(out)).toBe("added e1, e2 and 3 more");
    const four = apply(defaultSketch(), Array.from({ length: 4 }, (_, i) => `rect ${i * 60} 10 40 30 blue "c${i}"`).join("\n"));
    expect(scriptOutcomeSummary(four)).toBe("added e1, e2, e3, e4");
  });

  it("every statement leaves a step so the page can replay them in order", () => {
    const out = apply(defaultSketch(), 'rect 100 100 200 100 blue "A"\nrect 600 100 200 100 blue "B"\nlink #1 #2 green');
    expect(out.steps).toHaveLength(3);
    expect(out.steps[0]).toContain("drew rect e1");
    expect(out.steps[2]).toContain("linked e1 → e2");
  });

  it("a script that did nothing at all says so", () => {
    expect(scriptOutcomeSummary({ added: [], changed: [], removed: [], cleared: false, resized: null, steps: [], refused: [] })).toBe(
      "nothing changed"
    );
  });
});

describe("the page", () => {
  it("a box placed off the page is pulled back on", () => {
    const b = elementBbox(draw('rect 1700 900 400 400 blue "Off"').elements[0] as Element);
    expect(b.x + b.w).toBeLessThanOrEqual(CANVAS_W);
    expect(b.y + b.h).toBeLessThanOrEqual(CANVAS_H);
  });

  it("a script that widens the page may draw in the space it just made", () => {
    const d = draw('canvas 2400 1200\nrect 1800 200 300 120 blue "Right"');
    expect([d.width, d.height]).toEqual([2400, 1200]);
    expect(elementBbox(d.elements[0] as Element)).toEqual({ x: 1800, y: 200, w: 300, h: 120 });
    // …and a `move` in the same document is bounded by the new page too.
    apply(d, "move e1 400 0");
    expect(elementBbox(d.elements[0] as Element).x).toBe(2100);
  });

  it("resizing the page is a change worth saving, and re-sending the same size is not", () => {
    const d = defaultSketch();
    const out = apply(d, "canvas 2400 1200");
    expect(scriptOutcomeIsEmpty(out)).toBe(false);
    expect(out.resized).toEqual([2400, 1200]);
    expect(scriptOutcomeSummary(out)).toContain("2400×1200");
    // Every reading of a drawing starts with its own `canvas` line, so
    // counting that as an edit would re-save the file on every round trip.
    expect(scriptOutcomeIsEmpty(apply(d, "canvas 2400 1200"))).toBe(true);
  });

  it("the page size is clamped to a sane range", () => {
    expect([draw("canvas 10 10").width, draw("canvas 10 10").height]).toEqual([200, 200]);
    expect([draw("canvas 99999 99999").width, draw("canvas 99999 99999").height]).toEqual([8000, 8000]);
  });
});

// ---------------------------------------------------------------------------
// Links, reflow, routing
// ---------------------------------------------------------------------------

describe("links and reflow", () => {
  it("a link follows the box it is attached to", () => {
    const doc = defaultSketch();
    apply(doc, 'box e1 100 100 200 100 "A"\nbox e2 700 100 200 100 "B"\nlink e1 e2');
    const before = points(doc.elements[2] as Element).map((p) => [...p]);
    apply(doc, "move e2 0 500");
    const after = points(doc.elements[2] as Element);
    expect(after).not.toEqual(before);
    expect((after[1] as Point)[1]).toBeGreaterThan((before[1] as number[])[1] as number);
  });

  it("a link whose end is deleted stays put and forgets it", () => {
    const doc = defaultSketch();
    apply(doc, "box e1 100 100 200 100\nbox e2 700 100 200 100\nlink e1 e2");
    const drawn = points(doc.elements[2] as Element).map((p) => [...p]);
    apply(doc, "delete e2");
    const arrow = doc.elements.find((e) => e.id === "e3") as Element;
    expect(arrow.from).toBeNull();
    expect(arrow.to).toBeNull();
    expect(points(arrow)).toEqual(drawn);
  });

  it("a connector between concentric shapes is not the page origin", () => {
    const doc = defaultSketch();
    apply(doc, 'rect 100 100 200 100 blue "outer"\nellipse 150 125 100 50 green "inner"\nlink e1 e2');
    expect(points(doc.elements[2] as Element)).toEqual([
      [200, 150],
      [200, 150],
    ]);
  });

  it("moving a connector says it follows its shapes instead of claiming a move", () => {
    const d = defaultSketch();
    apply(d, 'rect 100 100 200 100 blue "A"\nrect 700 100 200 100 blue "B"\nlink e1 e2');
    const before = structuredClone((d.elements[2] as Element).shape);
    const out = apply(d, "move e3 40 0");
    expect((d.elements[2] as Element).shape).toEqual(before);
    expect(scriptOutcomeIsEmpty(out)).toBe(true);
    expect(out.steps[0]).toContain("connector");
    expect(out.steps[0]).toContain("e1");
    // …and the MODEL has to hear it: `steps` rides the editor's event and
    // never reaches the tool result. A summary reading "nothing changed" is
    // what sends the same `move` again on the next turn.
    const said = scriptOutcomeSummary(out);
    expect(said).toContain("connector");
    expect(said).toContain("e1");
    expect(said).toContain("e3");
    // A loose arrow — one whose ends were never attached — still moves.
    apply(d, "arrow 100 500 300 500 red");
    expect(apply(d, "move e4 0 40").changed).toEqual(["e4"]);
  });

  it("reflow re-routes attached connectors and is a no-op for unattached ones", () => {
    const doc = defaultSketch();
    apply(doc, 'rect 100 100 200 100 blue "A"\nrect 700 100 200 100 blue "B"\nlink e1 e2\narrow 50 800 250 800 red');
    const loose = points(doc.elements[3] as Element).map((p) => [...p]);
    // Move the box behind the engine's back, the way the editor's own drag
    // does before it saves.
    (doc.elements[1] as Element).shape = { type: "rect", x: 700, y: 600, w: 200, h: 100 };
    reflow(doc);
    // The rustc oracle's answer for this exact pair, not a re-derivation:
    // the ray now leaves A diagonally, so BOTH endpoints move.
    expect(points(doc.elements[2] as Element)).toEqual([
      [270, 208],
      [730, 592],
    ]);
    expect(points(doc.elements[3] as Element)).toEqual(loose);
    // Idempotent.
    const after = structuredClone(doc.elements);
    reflow(doc);
    expect(doc.elements).toEqual(after);
  });

  it("a page narrower than the default still reaches a box placed past its edge", () => {
    // A shape CAN sit off the page — the editor may resize the page under
    // one, and a file can be written by hand — so routing must not pull a
    // connector back to the new edge and off the box it names.
    const doc = sketchFromJson(
      '{"version":1,"width":800,"height":600,"seq":2,"elements":[' +
        '{"id":"e1","type":"rect","x":100,"y":200,"w":200,"h":100,"ink":"blue","label":"Here"},' +
        '{"id":"e2","type":"rect","x":1900,"y":200,"w":200,"h":100,"ink":"green","label":"Far"}]}'
    );
    apply(doc, "link e1 e2");
    const far = elementBbox(doc.elements[1] as Element);
    const end = points(doc.elements[2] as Element)[1] as Point;
    expect(end[0]).toBeGreaterThanOrEqual(far.x - 14);
    expect(end[0]).toBeLessThanOrEqual(far.x + far.w + 14);
  });
});

// ---------------------------------------------------------------------------
// Reading back, the layout report, rendering
// ---------------------------------------------------------------------------

describe("toScript", () => {
  it("a drawing round-trips through the text form it is read back as", () => {
    const first = draw(
      'rect 100 200 300 120 blue "Login form"\n' +
        'ellipse 800 200 240 140 green fill "Auth"\n' +
        'text 200 600 red 28 "retry three times"\n' +
        'arrow 400 260 800 260 pink "credentials"'
    );
    // A model copying a shape it was just shown strips the leading id.
    const replay = toScript(first)
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("canvas"))
      .map((l) => l.split(" ").slice(1).join(" "))
      .join("\n");
    const second = draw(replay);
    expect(second.elements).toHaveLength(first.elements.length);
    for (let i = 0; i < first.elements.length; i++) {
      const a = first.elements[i] as Element;
      const b = second.elements[i] as Element;
      expect(b.shape).toEqual(a.shape);
      expect(b.ink).toBe(a.ink);
      expect(b.fill).toBe(a.fill);
      expect(b.label).toBe(a.label);
    }
  });

  it("a freehand stroke is summarised rather than dumped at the model", () => {
    const d = defaultSketch();
    const pts = Array.from({ length: 60 }, (_, i) => ` ${100 + i * 5} ${300 + (i % 7) * 3}`).join("");
    apply(d, `pen blue${pts}`);
    const script = toScript(d);
    expect(script).toContain("freehand, 60 points");
    expect(script).not.toContain("100 300 105");
  });

  it("an arrow with one point is dropped on the way in rather than being indexed into", () => {
    const d = sketchFromJson(
      '{"version":1,"width":1600,"height":1000,"seq":2,"elements":[' +
        '{"id":"e1","type":"rect","x":100,"y":100,"w":200,"h":100,"ink":"blue","label":"A"},' +
        '{"id":"e2","type":"line","points":[[10,10]],"ink":"red"}]}'
    );
    expect(d.elements).toHaveLength(1);
    expect((d.elements[0] as Element).id).toBe("e1");
    // The file's own counter survives the drop — recovery only ever raises it.
    expect(d.seq).toBe(2);

    // And the three readers survive a document built in memory anyway.
    const broken = defaultSketch();
    broken.elements.push({ ...plainElement(), id: "e9", shape: { type: "arrow", points: [[10, 10]] }, ink: "red" });
    expect(toSvg(broken)).not.toBe("");
    expect(toScript(broken)).not.toContain("arrow");
    expect(() => layoutReport(broken)).not.toThrow();
  });
});

describe("layoutReport", () => {
  it("catches the mistakes a text-only model cannot see", () => {
    const notes = layoutReport(
      draw('rect 100 100 300 200 blue "One"\nrect 200 150 300 200 green "One"\nrect 900 100 200 100 red')
    ).join("\n");
    expect(notes).toContain("overlap");
    expect(notes).toContain("no label");
    expect(notes).toContain("both say");
  });

  it("a tidy drawing has nothing to report", () => {
    expect(
      layoutReport(draw('rect 100 100 300 150 blue "One"\nrect 900 100 300 150 green "Two"\nlink e1 e2 blue "flows to"'))
    ).toEqual([]);
  });

  it("a hand-placed arrow that nearly touches is flagged; a link never is", () => {
    const byHand = draw('rect 100 100 300 150 blue "One"\nrect 900 100 300 150 green "Two"\narrow 460 175 840 175 blue');
    expect(layoutReport(byHand).some((n) => n.includes("stops short"))).toBe(true);
  });

  it("a note lying on a box is called out, and its own box's label never is", () => {
    const d = draw('rect 100 100 300 200 blue "Box"\ntext 150 220 red 30 "a stray note"');
    expect(layoutReport(d).some((n) => n.includes("lies on top of"))).toBe(true);
  });

  it("two accented labels differing only in case are NOT duplicates, as ASCII lowering says", () => {
    const d = draw('rect 100 100 300 150 blue "CAFÉ"\nrect 900 100 300 150 green "café"');
    expect(layoutReport(d).some((n) => n.includes("both say"))).toBe(false);
    // …while a pure-ASCII case difference still is.
    const ascii = draw('rect 100 100 300 150 blue "Cafe"\nrect 900 100 300 150 green "CAFE"');
    expect(ascii === undefined ? [] : layoutReport(ascii).some((n) => n.includes("both say"))).toBe(true);
  });

  it("arrows are excluded from the duplicate-label check", () => {
    // A flow chart is full of "then"; reporting those sent the agent off
    // deleting the connections that made the diagram readable.
    const d = draw(
      'rect 100 100 200 100 blue "A"\nrect 700 100 200 100 blue "B"\nrect 100 600 200 100 blue "C"\n' +
        'link e1 e2 blue "then"\nlink e1 e3 blue "then"'
    );
    expect(layoutReport(d).some((n) => n.includes("both say"))).toBe(false);
  });

  it("sorts and de-duplicates its notes", () => {
    const notes = layoutReport(draw("rect 100 100 300 200 blue\nrect 900 100 300 200 red"));
    expect(notes).toEqual(["e1 has no label — give it one so it can be read.", "e2 has no label — give it one so it can be read."]);
  });
});

describe("toSvg", () => {
  it("the same document always renders the same bytes", () => {
    const d = draw('rect 100 100 300 150 blue "Stable"\nellipse 700 300 200 200 red "Round"');
    expect(toSvg(d)).toBe(toSvg(d));
    // And a second document built from the same script renders identically,
    // because the wobble is seeded from the element id and nothing else.
    const e = draw('rect 100 100 300 150 blue "Stable"\nellipse 700 300 200 200 red "Round"');
    expect(toSvg(d)).toBe(toSvg(e));
  });

  it("escapes a label that would otherwise break the document", () => {
    const d = draw('rect 10 10 200 100 blue "a < b & \\"c\\""');
    expect((d.elements[0] as Element).label).toBe('a < b & "c"');
    const svg = toSvg(d);
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&quot;");
    expect(svg.slice(svg.indexOf("a &lt;")).startsWith("a < b")).toBe(false);
  });

  it("xmlEscape escapes the four reserved characters, ampersand first", () => {
    expect(xmlEscape('&<>"')).toBe("&amp;&lt;&gt;&quot;");
    expect(xmlEscape("&lt;")).toBe("&amp;lt;");
  });

  it("an empty drawing still renders paper", () => {
    const svg = toSvg(defaultSketch());
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain("#f4f1e8");
    expect(svg.endsWith("</svg>")).toBe(true);
  });
});

describe("sketchExtractedText", () => {
  it("gets the words and never the coordinates", () => {
    const text = sketchExtractedText(draw('rect 100 100 300 150 blue "Login form"\ntext 50 50 red 30 "a loose note"'));
    expect(text).toContain("Login form");
    expect(text).toContain("a loose note");
    expect(text).not.toContain("100");
  });
});

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

describe("sketchToJson / sketchFromJson", () => {
  it("a document survives a save and load", () => {
    const d = draw('rect 100 200 300 120 blue fill "Login form"\ntext 200 600 red 28 "note"\npen green 10 10 20 20 30 15');
    expect(sketchFromJson(sketchToJson(d))).toEqual(d);
  });

  it("the JSON shape of an element is one flat map, never a nested shape object", () => {
    const v = JSON.parse(sketchToJson(draw('rect 250 400 320 130 blue "Login form"'))) as {
      elements: Array<Record<string, unknown>>;
    };
    const e = v.elements[0] as Record<string, unknown>;
    expect(e.type).toBe("rect");
    expect(e.x).toBe(250);
    expect(e.ink).toBe("blue");
    expect(e.label).toBe("Login form");
    expect(e.shape).toBeUndefined();
    // Field ORDER matches the Rust struct, so both builds write the same file.
    expect(Object.keys(e)).toEqual(["id", "type", "x", "y", "w", "h", "ink", "label"]);
  });

  it("absent optional fields stay absent on write", () => {
    const json = sketchToJson(draw("rect 0 0 10 10 blue"));
    expect(json).not.toContain('"from"');
    expect(json).not.toContain('"to"');
    expect(json).not.toContain('"locked"');
    expect(json).not.toContain('"fill"');
    expect(json).not.toContain('"label"');
  });

  it("a sketch written before links existed still opens", () => {
    const d = sketchFromJson(
      '{"version":1,"width":1600,"height":1000,"seq":1,"elements":[{"id":"e1","type":"rect","x":0,"y":0,"w":10,"h":10,"ink":"blue"}]}'
    );
    expect((d.elements[0] as Element).from).toBeNull();
    expect((d.elements[0] as Element).locked).toBe(false);
  });

  it("a reloaded file recovers its counter from the ids it holds", () => {
    const d = sketchFromJson(
      '{"version":1,"width":1600,"height":1000,"seq":0,"elements":[{"id":"e7","type":"rect","x":0,"y":0,"w":10,"h":10,"ink":"blue"}]}'
    );
    apply(d, 'rect 20 20 50 50 blue "next"');
    expect((d.elements[1] as Element).id).toBe("e8");
  });

  it("a nonsense page size falls back to the default canvas", () => {
    const d = sketchFromJson('{"version":1,"width":0,"height":-5,"seq":0,"elements":[]}');
    expect([d.width, d.height]).toEqual([CANVAS_W, CANVAS_H]);
  });

  it("blank bytes are a fresh drawing, and malformed bytes are refused outright", () => {
    expect(sketchFromJson("")).toEqual(defaultSketch());
    expect(sketchFromJson("   \n ")).toEqual(defaultSketch());
    expect(() => sketchFromJson("{ not json")).toThrow(/could not be read/);
    // STRICT, matching serde: a truncated document, an unknown shape tag and
    // an unknown ink all fail the whole read rather than being half-adopted.
    expect(() => sketchFromJson('{"elements":[]}')).toThrow(/could not be read/);
    expect(() =>
      sketchFromJson('{"version":1,"width":1600,"height":1000,"seq":0,"elements":[{"id":"e1","type":"blob"}]}')
    ).toThrow(/blob/);
    expect(() =>
      sketchFromJson(
        '{"version":1,"width":1600,"height":1000,"seq":0,"elements":[{"id":"e1","type":"rect","x":0,"y":0,"w":1,"h":1,"ink":"magenta"}]}'
      )
    ).toThrow(/ink/);
  });
});

// ---------------------------------------------------------------------------
// layoutGraph — #sketch's node/edge → drawing engine
// ---------------------------------------------------------------------------

describe("layoutGraph", () => {
  it("a three-node chain lays out in three columns at the exact rustc positions", () => {
    const doc = layoutGraph([node("a", "Draft"), node("b", "Review"), node("c", "Published")], [edge("a", "b"), edge("b", "c")]);
    expect([doc.width, doc.height]).toEqual([1600, 1000]);
    // MARGIN 80, BOX 300×130, GAP_X 130 → x = 80, 510, 940; the single-row
    // column centres at (1000-130)/2 = 435.
    expect(solids(doc).map((e) => elementBbox(e))).toEqual([
      { x: 80, y: 435, w: 300, h: 130 },
      { x: 510, y: 435, w: 300, h: 130 },
      { x: 940, y: 435, w: 300, h: 130 },
    ]);
    expect(arrows(doc).map((e) => points(e))).toEqual([
      [
        [388, 500],
        [502, 500],
      ],
      [
        [818, 500],
        [932, 500],
      ],
    ]);
    // Ink cycles by column, and every arrow is a real link.
    expect(solids(doc).map((e) => e.ink)).toEqual(["blue", "green", "yellow"]);
    expect(arrows(doc).map((e) => [e.from, e.to])).toEqual([
      ["e1", "e2"],
      ["e2", "e3"],
    ]);
    expect(layoutReport(doc)).toEqual([]);
  });

  it("branches stack in one column at the exact rustc positions", () => {
    const doc = layoutGraph(
      [node("a", "Order"), node("b", "Pay"), node("c", "Ship"), node("d", "Email")],
      [edge("a", "b"), edge("a", "c"), edge("a", "d")]
    );
    expect(solids(doc).map((e) => elementBbox(e))).toEqual([
      { x: 80, y: 435, w: 300, h: 130 },
      { x: 510, y: 215, w: 300, h: 130 },
      { x: 510, y: 435, w: 300, h: 130 },
      { x: 510, y: 655, w: 300, h: 130 },
    ]);
    expect(arrows(doc).map((e) => points(e))).toEqual([
      [
        [373, 427],
        [517, 353],
      ],
      [
        [388, 500],
        [502, 500],
      ],
      [
        [373, 573],
        [517, 647],
      ],
    ]);
    expect(layoutReport(doc)).toEqual([]);
  });

  it("a circular process lays out instead of looping forever", () => {
    const doc = layoutGraph([node("a", "Open"), node("b", "Doing"), node("c", "Done")], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    // Every node has an incoming edge, so relaxation runs to the cap and all
    // three land in the last column — honest for a diagram with no beginning.
    expect(doc.width).toBe(1750);
    expect(solids(doc).map((e) => elementBbox(e).x)).toEqual([1370, 1370, 1370]);
    expect(solids(doc)).toHaveLength(3);
    expect(arrows(doc)).toHaveLength(3);
  });

  it("a flow deeper than the default canvas keeps its arrows on the boxes", () => {
    const names = ["a", "b", "c", "d", "e"];
    const doc = layoutGraph(
      names.map((n) => node(n, n.toUpperCase())),
      names.slice(1).map((n, i) => edge(names[i] as string, n))
    );
    expect(doc.width).toBe(2180);
    expect(doc.width).toBeGreaterThan(CANVAS_W);
    const boxes = new Map(doc.elements.map((e) => [e.id, elementBbox(e)]));
    let checked = 0;
    for (const el of arrows(doc)) {
      const a = boxes.get(el.from as string) as Rect;
      const b = boxes.get(el.to as string) as Rect;
      const [s, t] = points(el) as [Point, Point];
      expect(s[0]).toBeGreaterThanOrEqual(a.x - 14);
      expect(s[0]).toBeLessThanOrEqual(a.x + a.w + 14);
      expect(t[0]).toBeGreaterThanOrEqual(b.x - 14);
      expect(t[0]).toBeLessThanOrEqual(b.x + b.w + 14);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("a column count past the cap stops growing rather than running away", () => {
    const names = Array.from({ length: 11 }, (_, i) => `n${i}`);
    const doc = layoutGraph(
      names.map((n) => node(n, n)),
      names.slice(1).map((n, i) => edge(names[i] as string, n))
    );
    // The layer cap is `n.min(8)`, so nine columns and the last three stack.
    expect(doc.width).toBe(3900);
    expect(solids(doc).map((e) => elementBbox(e).x).slice(-3)).toEqual([3520, 3520, 3520]);
  });

  it("an edge naming a box that does not exist is dropped, not drawn", () => {
    expect(arrows(layoutGraph([node("a", "Only")], [edge("a", "ghost")]))).toHaveLength(0);
  });

  it("nothing described draws nothing rather than an empty frame", () => {
    expect(layoutGraph([], []).elements).toEqual([]);
  });

  it("a start or end node is drawn round, whatever case it was described in", () => {
    const doc = layoutGraph(
      [
        { id: "s", label: "Start", kind: "START" },
        node("m", "Work"),
      ],
      [edge("s", "m")]
    );
    expect((doc.elements[0] as Element).shape.type).toBe("ellipse");
    expect((doc.elements[0] as Element).fill).toBe(true);
    expect((doc.elements[1] as Element).shape.type).toBe("rect");
  });

  it("an explanation is drawn under its box and never swallows the page", () => {
    const doc = layoutGraph([{ id: "a", label: "Auth", note: "This step ".repeat(40) }], []);
    const note = doc.elements.find((e) => e.shape.type === "text") as Element;
    const shape = note.shape as { type: "text"; y: number; text: string };
    expect([...shape.text].length).toBeLessThanOrEqual(61);
    expect(shape.text.endsWith("…")).toBe(true);
    // 435 (top) + 130 (BOX_H) + 34.
    expect(shape.y).toBe(599);
    expect(shape.y).toBeGreaterThan(elementBbox(doc.elements[0] as Element).y);
  });

  it("a blank note or edge label is left off rather than drawn empty", () => {
    const doc = layoutGraph(
      [
        { id: "a", label: "  Auth  ", note: "   " },
        node("b", "Work"),
      ],
      [{ from: "a", to: "b", label: "   " }]
    );
    expect(doc.elements.some((e) => e.shape.type === "text")).toBe(false);
    expect((doc.elements[0] as Element).label).toBe("Auth");
    expect((arrows(doc)[0] as Element).label).toBeNull();
  });

  it("a Hebrew note keeps the head Rust's BYTE-length rule keeps", () => {
    // 25 Hebrew characters is 50 UTF-8 bytes but 25 UTF-16 units, and the
    // rule is `head.len() > max / 2` on BYTES — so this head survives where a
    // `.length` test would have dropped it and returned the raw 60-char cut.
    const note = `${"ש".repeat(25)} ${"ב".repeat(40)}`;
    const doc = layoutGraph([{ id: "a", label: "A", note }], []);
    const shape = (doc.elements.find((e) => e.shape.type === "text") as Element).shape as { text: string };
    expect(shape.text).toBe(`${"ש".repeat(25)}…`);
  });

  it("more nodes than the cap are taken from the front", () => {
    const many = Array.from({ length: 200 }, (_, i) => node(`n${i}`, `N${i}`));
    const doc = layoutGraph(many, []);
    expect(solids(doc)).toHaveLength(Math.floor(MAX_ELEMENTS / 4));
  });

  it("a model-supplied `__proto__` node id cannot pollute Object.prototype", () => {
    const doc = layoutGraph(
      [
        { id: "__proto__", label: "One" },
        { id: "constructor", label: "Two" },
      ],
      [{ from: "__proto__", to: "constructor", label: "then" }]
    );
    expect(arrows(doc)).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SECOND ORACLE WAVE. Every expectation below is the literal output of a
// compiled `rustc` build of the pure half of `sketchdoc.rs` (script parser,
// router, renderer and layout engine, serde derives stripped, `to_png`
// removed) run on the same input — not a re-derivation of the formulae, and
// not read back out of this implementation. They pin four families a
// plausible-looking port gets wrong in a way no property test notices.
// ---------------------------------------------------------------------------

describe("fidelity: Rust's whitespace, not JavaScript's", () => {
  // `str::trim` trims the Unicode White_Space property; JS's `String#trim`
  // trims a DIFFERENT set — it adds U+FEFF and omits U+0085. The tokenizer
  // already models this (`IS_WHITESPACE`); every other trim in the module has
  // to as well, or the two builds disagree about what a script says.

  it("refuses a script whose first line begins with a byte-order mark", () => {
    // rustc: line 1 (`\u{feff}rect …`): `\u{feff}rect` is not a command.
    // A BOM is exactly what a copied-out-of-a-file script carries.
    const doc = defaultSketch();
    const out = applyScript(doc, '\ufeffrect 10 10 200 100 blue "BOM"');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("is not a command");
    expect(doc.elements).toHaveLength(0);
  });

  it("keeps a U+FEFF inside a label, which Rust's trim does not touch", () => {
    const doc = defaultSketch();
    const out = applyScript(doc, 'rect 10 10 200 100 blue "pad\ufeff"');
    expect(out.ok).toBe(true);
    expect((doc.elements[0] as Element).label).toBe("pad\ufeff");
  });

  it("trims a U+0085 from a label, which Rust's trim does touch", () => {
    const doc = defaultSketch();
    const out = applyScript(doc, 'rect 10 10 200 100 blue "pad\u0085"');
    expect(out.ok).toBe(true);
    expect((doc.elements[0] as Element).label).toBe("pad");
  });

  it("treats U+0085 as whitespace and U+FEFF as ordinary text when trimming a note", () => {
    // `clampWords`/`sketchExtractedText` share the rule.
    const doc = layoutGraph([{ id: "a", label: "A", note: "\u0085note\u0085" }], []);
    const note = doc.elements.find((e) => e.shape.type === "text") as Element;
    expect((note.shape as { text: string }).text).toBe("note");
    expect(sketchExtractedText(doc)).toBe("A\nnote\n");
  });
});

describe("fidelity: Rust's truncating `as i32` on a script number", () => {
  // `parse_num` yields an `i64` and every coordinate site casts it with `as
  // i32`, which TRUNCATES to the low 32 bits rather than clamping. A model
  // that loses its place and emits a huge number therefore gets a small (and
  // often negative) coordinate, not the page edge.

  it("wraps a width of 2^32 to zero and refuses the line, as rustc does", () => {
    // rustc: width and height must be positive (got 0×100).
    const doc = defaultSketch();
    const out = applyScript(doc, 'rect 10 10 4294967296 100 blue "A"');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("got 0×100");
    expect(doc.elements).toHaveLength(0);
  });

  it("saturates past i64 and then truncates, so a 20-digit width reads as -1", () => {
    // rustc: `99999999999999999999` → f64 1e20 → `as i64` saturates to
    // i64::MAX → `as i32` truncates to -1.
    const doc = defaultSketch();
    const out = applyScript(doc, 'rect 10 10 99999999999999999999 100 blue "A"');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("got -1×100");
  });

  it("puts a 20-digit x at the LEFT edge, not the right", () => {
    // rustc: `e1 rect 0 10 200 100`. Clamping the un-cast 1e20 would give
    // x=1400, the far edge — the opposite side of the page.
    const doc = defaultSketch();
    const out = applyScript(doc, 'rect 99999999999999999999 10 200 100 blue "A"');
    expect(out.ok).toBe(true);
    expect((doc.elements[0] as Element).shape).toEqual({ type: "rect", x: 0, y: 10, w: 200, h: 100 });
  });

  it("wraps 2^31 to i32::MIN, so a huge x clamps to the left edge", () => {
    // rustc: `e1 rect 0 10 200 100`.
    const doc = defaultSketch();
    expect(applyScript(doc, 'rect 2147483648 10 200 100 blue "A"').ok).toBe(true);
    expect((doc.elements[0] as Element).shape).toMatchObject({ x: 0 });
  });

  it("shrinks a 2^32 canvas to the MINIMUM page, not the maximum", () => {
    // rustc: `200x200`. `4294967296 as i32` is 0, and 0 clamps up to 200.
    const doc = defaultSketch();
    expect(applyScript(doc, "canvas 4294967296 4294967296").ok).toBe(true);
    expect([doc.width, doc.height]).toEqual([200, 200]);
  });

  it("wraps a pen point and an arrow endpoint the same way", () => {
    // rustc: `pen [1600,10;0,20]` and `arrow [1600,10;20,20]`
    // (5000000000 as i32 = 705032704 → clamped to 1600; 4294967296 → 0).
    const pen = defaultSketch();
    expect(applyScript(pen, "pen blue 5000000000 10 4294967296 20").ok).toBe(true);
    expect((pen.elements[0] as Element).shape).toEqual({ type: "pen", points: [[1600, 10], [0, 20]] });
    const arrow = defaultSketch();
    expect(applyScript(arrow, "arrow 5000000000 10 20 20 blue").ok).toBe(true);
    expect((arrow.elements[0] as Element).shape).toEqual({ type: "arrow", points: [[1600, 10], [20, 20]] });
  });

  it("still clamps a text size BEFORE the cast, which is the other order", () => {
    // The one site where Rust clamps the i64 and casts the result, so a huge
    // size is 160 rather than a wrapped value.
    const doc = defaultSketch();
    expect(applyScript(doc, 'text 10 10 blue 99999999999999999999 "T"').ok).toBe(true);
    expect((doc.elements[0] as Element).shape).toMatchObject({ size: 160 });
  });
});

describe("fidelity: the remaining oracle disagreements", () => {
  it("keeps the sign of a negative value that formats as zero", () => {
    // rustc: `format!("{:.0}", -0.5)` is "-0". Reachable through a hand-edited
    // file: a 1-wide box at x=-1 centres its label on exactly -0.5.
    expect(fixed(-0.5, 0)).toBe("-0");
    const doc = defaultSketch();
    doc.elements.push({ ...plainElement(), id: "e1", shape: { type: "rect", x: -1, y: -1, w: 1, h: 1 }, label: "neg" });
    doc.seq = 1;
    expect(toSvg(doc)).toContain('<text x="-0" y="8"');
  });

  it("calls a back-reference past `usize` not a reference at all", () => {
    // rustc: "`#99999999999999999999` is not a reference" — `usize::from_str`
    // overflows. Reading it as a number instead reports a shape count nobody
    // wrote ("the 100000000000000000000th shape").
    const doc = defaultSketch();
    const out = applyScript(doc, 'rect 10 10 100 100 blue "A"\nlink #99999999999999999999 #1');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("`#99999999999999999999` is not a reference");
    expect(out.ok === false && out.error).not.toContain("th shape");
  });

  it("leaves the counter alone for an id number past u32", () => {
    // rustc: `e4294967296`.parse::<u32>() overflows, so `seq` stays 3 and the
    // next shape is `e4`. Reading it as a JS number mints `e4294967297`.
    const doc = sketchFromJson(
      '{"version":1,"width":1600,"height":1000,"seq":3,"elements":[{"id":"e4294967296","type":"rect","x":0,"y":0,"w":10,"h":10}]}'
    );
    expect(doc.seq).toBe(3);
    expect(applyScript(doc, 'rect 20 20 50 50 blue "next"').ok).toBe(true);
    expect((doc.elements[1] as Element).id).toBe("e4");
  });

  it("drops EVERY copy of a deleted id from the projected page", () => {
    // A hand-edited file can repeat an id. Rust's `live.retain` removes both,
    // so a later line naming it is refused; removing only the first leaves the
    // script applying against a shape Rust says is gone.
    const doc = sketchFromJson(
      '{"version":1,"width":1600,"height":1000,"seq":9,"elements":[' +
        '{"id":"e1","type":"rect","x":10,"y":10,"w":100,"h":100,"label":"A"},' +
        '{"id":"e1","type":"rect","x":300,"y":10,"w":100,"h":100,"label":"B"}]}'
    );
    const out = applyScript(doc, "delete e1\nmove e1 10 10");
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("there is no `e1` on this page");
    expect(doc.elements).toHaveLength(2);
  });
});
