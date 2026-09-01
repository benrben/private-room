/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { applyScript } from "./sketchDocApply.js";
import { CANVAS_H, CANVAS_W, INK_DEFAULT, Ink, MAX_POINTS, Point, Shape, asI32, clamp } from "./sketchDocModel.js";
import { quote } from "./sketchDocRouting.js";
import { QUOTE_SENTINEL, Tokens, canonVerb, sortTokens, tokenHasFlag, tokenInk, tokenLabel, tokenNum, tokenStrays, tokenize } from "./sketchDocTokens.js";
export type Ref = { kind: "id"; id: string } | { kind: "back"; index: number };

export function refEquals(a: Ref, b: Ref): boolean {
  if (a.kind === "id" && b.kind === "id") {
    return a.id === b.id;
  }
  if (a.kind === "back" && b.kind === "back") {
    return a.index === b.index;
  }
  return false;
}

export type Stmt =
  | { kind: "add"; shape: Shape; ink: Ink; fill: boolean; label: string | null }
  | { kind: "link"; from: Ref; to: Ref; ink: Ink; label: string | null }
  | { kind: "move"; target: string; dx: number; dy: number }
  | { kind: "label"; target: string; label: string }
  | { kind: "ink"; target: string; ink: Ink }
  | { kind: "delete"; target: string }
  | { kind: "clear" }
  | { kind: "canvas"; w: number; h: number };

export function stmtCreates(s: Stmt): boolean {
  return s.kind === "add" || s.kind === "link";
}

export const EXAMPLE_SCRIPT =
  'rect 250 400 320 130 blue "Login form"\n' +
  'rect 930 400 330 130 green "Auth service"\n' +
  'link #1 #2 blue "credentials"';

export const SCRIPT_HELP =
  "Commands (one per line, whole numbers, colours are pink/yellow/green/blue/red):\n" +
  'rect X Y W H [colour] [fill] "label"\n' +
  'ellipse X Y W H [colour] [fill] "label"\n' +
  'text X Y [colour] [size] "words"\n' +
  'arrow X1 Y1 X2 Y2 [colour] "label"\n' +
  "line X1 Y1 X2 Y2 [colour]\n" +
  "pen [colour] X1 Y1 X2 Y2 …\n" +
  'link FROM TO [colour] "label"   — routes an arrow between two shapes\n' +
  'move ID DX DY · label ID "new" · ink ID colour · delete ID · clear\n' +
  "FROM/TO/ID is an existing id like e7, or #1 for the first shape THIS script creates.";

/** `n` is a `bigint` because Rust parses `#n` as a `usize`, which reaches
 * 2^64 - 1 — past what a `number` can spell exactly. */
export function ordinal(n: bigint): string {
  if (n === 1n) {
    return "1st";
  }
  if (n === 2n) {
    return "2nd";
  }
  if (n === 3n) {
    return "3rd";
  }
  return `${n}th`;
}

export function unknownWords(strays: readonly string[]): string {
  return (
    `did not understand ${strays.map((s) => `\`${s}\``).join(", ")} — colours are ` +
    'pink/yellow/green/blue/red, and any words to show must be in "quotes"'
  );
}

export type Fallible<T> = { ok: true; value: T } | { ok: false; error: string };

export function four(
  t: Tokens,
  keys: readonly [string, string, string, string],
  alt: readonly [string, string, string, string]
): Fallible<[number, number, number, number]> {
  const got: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const names = [keys[i] as string, alt[i] as string].filter((s) => s !== "");
    const n = tokenNum(t, names, i);
    if (n === null) {
      return { ok: false, error: `needs four numbers (${keys.join(" ")}); got ${t.nums.length}` };
    }
    // Rust's `(got[i] as i32)`: the caller's `w <= 0` test reads the CAST
    // value, so a width of 2^32 is zero and refuses the line.
    got[i] = asI32(n);
  }
  return { ok: true, value: got };
}

/**
 * Keep a shape on the page. Clamping rather than refusing: a model that put a
 * box at x=1700 meant it to be near the right edge, and moving it there is a
 * better answer than a syntax error — the layout report says what moved.
 *
 * `page` is the document's OWN size, which `canvas` may have just changed.
 */
export function clampBox(
  x: number,
  y: number,
  w: number,
  h: number,
  page: readonly [number, number]
): [number, number, number, number] {
  const [pw, ph] = page;
  const cw = clamp(w, 1, pw);
  const ch = clamp(h, 1, ph);
  return [clamp(x, 0, pw - cw), clamp(y, 0, ph - ch), cw, ch];
}

/**
 * `page` is the document's size as of THIS line — see {@link applyScript}.
 * Every coordinate below is clamped against it rather than against the
 * default canvas, so a script that widens the page can then draw in the new
 * space.
 */
export function parseStmt(
  line: string,
  live: readonly string[],
  created: readonly string[],
  page: readonly [number, number]
): Fallible<Stmt> {
  const context = statementContext(line, live, created, page);
  if (!context.ok) {
    return context;
  }
  return parseStatement(context.value);
}

export interface StmtParseContext {
  verb: string;
  tokens: Tokens;
  live: readonly string[];
  created: readonly string[];
  page: readonly [number, number];
  ink: Ink;
}

export type StmtParser = (context: StmtParseContext) => Fallible<Stmt>;

export function statementContext(
  line: string,
  live: readonly string[],
  created: readonly string[],
  page: readonly [number, number]
): Fallible<StmtParseContext> {
  const raw = tokenize(line);
  if (raw.length === 0) return { ok: false, error: "nothing on the line" };
  // The verb is the first token that is not quoted; a leading quote means the
  // model wrote a bare label with no command.
  const head = raw[0] as string;
  if (head.startsWith(QUOTE_SENTINEL)) {
    return {
      ok: false,
      error:
        'this line starts with a label but no command — put the command first, e.g. `text 200 300 "…"`',
    };
  }
  const verb = canonVerb(head);
  if (verb === "") {
    return { ok: false, error: `\`${head}\` is not a command` };
  }
  const tokens = sortTokens(raw.slice(1));
  return { ok: true, value: { verb, tokens, live, created, page, ink: tokenInk(tokens) ?? INK_DEFAULT } };
}

export function parseStatement(context: StmtParseContext): Fallible<Stmt> {
  return (STMT_PARSERS[context.verb] as StmtParser)(context);
}

export function resolveRef(reference: string, context: StmtParseContext): Fallible<Ref> {
  if (reference.startsWith("#")) {
    return resolveBackRef(reference, context.created);
  }
  if (context.live.includes(reference)) {
    return { ok: true, value: { kind: "id", id: reference } };
  }
  return { ok: false, error: `there is no \`${reference}\` on this page` };
}

export function resolveBackRef(reference: string, created: readonly string[]): Fallible<Ref> {
  const digits = reference.slice(1);
  if (!validBackRefDigits(digits)) {
    return { ok: false, error: `\`${reference}\` is not a reference` };
  }
  const ordinalNumber = BigInt(digits);
  if (ordinalNumber === 0n || ordinalNumber > BigInt(created.length)) {
    return {
      ok: false,
      error: `\`${reference}\` points at the ${ordinal(ordinalNumber)} shape this script creates, but it only creates ${created.length}`,
    };
  }
  return { ok: true, value: { kind: "back", index: Number(ordinalNumber) - 1 } };
}

export function validBackRefDigits(digits: string): boolean {
  return /^[0-9]+$/.test(digits) && BigInt(digits) <= 18446744073709551615n;
}

export function targetOf(tokens: Tokens, context: StmtParseContext): Fallible<string> {
  const reference = tokens.refs[0];
  if (reference === undefined) {
    return {
      ok: false,
      error:
        "this command needs the id of something on the page (like e3), or #1 for the first shape this script creates",
    };
  }
  const resolved = resolveRef(reference, context);
  if (!resolved.ok) {
    return resolved;
  }
  return { ok: true, value: concreteTarget(resolved.value, context.created) };
}

export function concreteTarget(reference: Ref, created: readonly string[]): string {
  return reference.kind === "id" ? reference.id : (created[reference.index] as string);
}

export function rejectStrays(tokens: Tokens, flags: readonly string[]): Fallible<null> {
  const strays = tokenStrays(tokens, flags);
  if (strays.length > 0) {
    return { ok: false, error: unknownWords(strays) };
  }
  return { ok: true, value: null };
}

export function parseBox(context: StmtParseContext): Fallible<Stmt> {
  const strays = rejectStrays(context.tokens, ["fill", "filled", "solid"]);
  if (!strays.ok) {
    return strays;
  }
  const box = positiveBox(context.tokens);
  if (!box.ok) {
    return box;
  }
  return { ok: true, value: addBox(context, box.value) };
}

export function positiveBox(tokens: Tokens): Fallible<[number, number, number, number]> {
  const nums = four(tokens, ["x", "y", "w", "h"], ["", "", "width", "height"]);
  if (!nums.ok) {
    return nums;
  }
  const [, , width, height] = nums.value;
  if (width <= 0 || height <= 0) {
    return {
      ok: false,
      error: `width and height must be positive (got ${width}×${height}); the numbers are X Y WIDTH HEIGHT, not two corners`,
    };
  }
  return nums;
}

export function addBox(context: StmtParseContext, box: readonly [number, number, number, number]): Stmt {
  const [x, y, width, height] = clampBox(box[0], box[1], box[2], box[3], context.page);
  return {
    kind: "add",
    shape: boxShape(context.verb, x, y, width, height),
    ink: context.ink,
    fill: boxIsFilled(context.tokens),
    label: tokenLabel(context.tokens),
  };
}

export function boxShape(verb: string, x: number, y: number, width: number, height: number): Shape {
  return verb === "rect" ? { type: "rect", x, y, w: width, h: height } : { type: "ellipse", x, y, w: width, h: height };
}

export function boxIsFilled(tokens: Tokens): boolean {
  return tokenHasFlag(tokens, "fill") || tokenHasFlag(tokens, "filled") || tokenHasFlag(tokens, "solid");
}

export function parseText(context: StmtParseContext): Fallible<Stmt> {
  const strays = rejectStrays(context.tokens, []);
  if (!strays.ok) {
    return strays;
  }
  const position = textPosition(context.tokens);
  if (!position.ok) {
    return position;
  }
  const label = tokenLabel(context.tokens);
  if (label === null) {
    return { ok: false, error: 'needs the words to write, in quotes — e.g. `text 200 300 "retry three times"`' };
  }
  return { ok: true, value: addText(context, position.value, label) };
}

export function textPosition(tokens: Tokens): Fallible<Point> {
  const x = tokenNum(tokens, ["x"], 0);
  if (x === null) {
    return { ok: false, error: "needs an X position" };
  }
  const y = tokenNum(tokens, ["y"], 1);
  if (y === null) {
    return { ok: false, error: "needs a Y position" };
  }
  return { ok: true, value: [x, y] };
}

export function addText(context: StmtParseContext, position: Point, text: string): Stmt {
  const size = clamp(tokenNum(context.tokens, ["size"], 2) ?? 30, 10, 160);
  return {
    kind: "add",
    shape: {
      type: "text",
      x: clamp(asI32(position[0]), 0, context.page[0]),
      y: clamp(asI32(position[1]), 0, context.page[1]),
      text,
      size,
    },
    ink: context.ink,
    fill: false,
    label: null,
  };
}

export function parseLine(context: StmtParseContext): Fallible<Stmt> {
  const strays = rejectStrays(context.tokens, []);
  if (!strays.ok) {
    return strays;
  }
  const points = linePoints(context.tokens, context.page);
  if (!points.ok) {
    return points;
  }
  if (samePoint(points.value[0], points.value[1])) {
    return { ok: false, error: "start and end are the same point" };
  }
  return { ok: true, value: addLine(context, points.value) };
}

export function linePoints(tokens: Tokens, page: readonly [number, number]): Fallible<[Point, Point]> {
  const nums = four(tokens, ["x1", "y1", "x2", "y2"], ["from_x", "from_y", "to_x", "to_y"]);
  if (!nums.ok) {
    return nums;
  }
  const [x1, y1, x2, y2] = nums.value;
  return {
    ok: true,
    value: [
      [clamp(x1, 0, page[0]), clamp(y1, 0, page[1])],
      [clamp(x2, 0, page[0]), clamp(y2, 0, page[1])],
    ],
  };
}

export function samePoint(first: Point, second: Point): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

export function addLine(context: StmtParseContext, points: [Point, Point]): Stmt {
  return {
    kind: "add",
    shape: context.verb === "arrow" ? { type: "arrow", points } : { type: "line", points },
    ink: context.ink,
    fill: false,
    label: tokenLabel(context.tokens),
  };
}

export function parsePen(context: StmtParseContext): Fallible<Stmt> {
  const strays = rejectStrays(context.tokens, []);
  if (!strays.ok) {
    return strays;
  }
  if (!validPenNumbers(context.tokens.nums)) {
    return {
      ok: false,
      error: `needs an even list of at least two X Y pairs (got ${context.tokens.nums.length} number(s))`,
    };
  }
  return { ok: true, value: addPen(context) };
}

export function validPenNumbers(numbers: readonly number[]): boolean {
  return numbers.length >= 4 && numbers.length % 2 === 0;
}

export function addPen(context: StmtParseContext): Stmt {
  return {
    kind: "add",
    shape: { type: "pen", points: penPoints(context.tokens.nums, context.page) },
    ink: context.ink,
    fill: false,
    label: tokenLabel(context.tokens),
  };
}

export function penPoints(numbers: readonly number[], page: readonly [number, number]): Point[] {
  const points: Point[] = [];
  for (let index = 0; hasNextPenPoint(numbers, points, index); index += 2) {
    points.push([
      clamp(asI32(numbers[index] as number), 0, page[0]),
      clamp(asI32(numbers[index + 1] as number), 0, page[1]),
    ]);
  }
  return points;
}

export function hasNextPenPoint(numbers: readonly number[], points: readonly Point[], index: number): boolean {
  return index + 1 < numbers.length && points.length < MAX_POINTS;
}

export function parseLink(context: StmtParseContext): Fallible<Stmt> {
  const strays = rejectStrays(context.tokens, []);
  if (!strays.ok) {
    return strays;
  }
  if (context.tokens.refs.length < 2) {
    return {
      ok: false,
      error: 'needs two things to connect — e.g. `link e3 e5 "sends token"`, or `link #1 #2` for shapes this script just drew',
    };
  }
  const from = resolveRef(context.tokens.refs[0] as string, context);
  if (!from.ok) {
    return from;
  }
  const to = resolveRef(context.tokens.refs[1] as string, context);
  if (!to.ok) {
    return to;
  }
  if (refEquals(from.value, to.value)) {
    return { ok: false, error: "cannot connect something to itself" };
  }
  return { ok: true, value: { kind: "link", from: from.value, to: to.value, ink: context.ink, label: tokenLabel(context.tokens) } };
}

export function parseMove(context: StmtParseContext): Fallible<Stmt> {
  const target = targetOf(context.tokens, context);
  if (!target.ok) {
    return target;
  }
  const dx = tokenNum(context.tokens, ["dx"], 0);
  if (dx === null) {
    return { ok: false, error: "needs how far to move across (DX)" };
  }
  const dy = tokenNum(context.tokens, ["dy"], 1);
  if (dy === null) {
    return { ok: false, error: "needs how far to move down (DY)" };
  }
  return { ok: true, value: { kind: "move", target: target.value, dx: asI32(dx), dy: asI32(dy) } };
}

export function parseLabel(context: StmtParseContext): Fallible<Stmt> {
  const target = targetOf(context.tokens, context);
  if (!target.ok) {
    return target;
  }
  const label = tokenLabel(context.tokens);
  if (label === null) {
    return { ok: false, error: "needs the new label in quotes" };
  }
  return { ok: true, value: { kind: "label", target: target.value, label } };
}

export function parseInk(context: StmtParseContext): Fallible<Stmt> {
  const target = targetOf(context.tokens, context);
  if (!target.ok) {
    return target;
  }
  const ink = tokenInk(context.tokens);
  if (ink === null) {
    return { ok: false, error: "needs a colour: pink, yellow, green, blue or red" };
  }
  return { ok: true, value: { kind: "ink", target: target.value, ink } };
}

export function parseDelete(context: StmtParseContext): Fallible<Stmt> {
  const target = targetOf(context.tokens, context);
  if (!target.ok) {
    return target;
  }
  return { ok: true, value: { kind: "delete", target: target.value } };
}

export function parseClear(): Fallible<Stmt> {
  return { ok: true, value: { kind: "clear" } };
}

export function parseCanvas(context: StmtParseContext): Fallible<Stmt> {
  const width = tokenNum(context.tokens, ["w", "width"], 0) ?? CANVAS_W;
  const height = tokenNum(context.tokens, ["h", "height"], 1) ?? CANVAS_H;
  return { ok: true, value: { kind: "canvas", w: clamp(asI32(width), 200, 8000), h: clamp(asI32(height), 200, 8000) } };
}

export const STMT_PARSERS: Readonly<Record<string, StmtParser>> = {
  rect: parseBox,
  ellipse: parseBox,
  text: parseText,
  arrow: parseLine,
  line: parseLine,
  pen: parsePen,
  link: parseLink,
  move: parseMove,
  label: parseLabel,
  ink: parseInk,
  delete: parseDelete,
  clear: parseClear,
  canvas: parseCanvas,
};
