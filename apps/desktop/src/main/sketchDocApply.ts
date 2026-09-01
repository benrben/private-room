/** Cohesive extraction from sketchDoc.ts; its public API remains on that module. */
import { has } from "./sketchDocJson.js";
import { Element, MAX_ELEMENTS, MAX_REPORTED_ERRORS, MAX_SCRIPT_LINES, Point, Shape, Sketch, clamp, elementBbox, plainElement, rustTrim, sketchIndexOf, sketchNextId } from "./sketchDocModel.js";
import { reflow, route } from "./sketchDocRouting.js";
import { EXAMPLE_SCRIPT, Fallible, Ref, SCRIPT_HELP, Stmt, parseStmt, stmtCreates } from "./sketchDocStatements.js";
import { ScriptOutcome, newScriptOutcome } from "./sketchDocTokens.js";
export function resolveBack(r: Ref, back: readonly string[]): string {
  return r.kind === "id" ? r.id : back[r.index] ?? "";
}

/**
 * The two shapes a connector is attached to, when both are still on the page.
 *
 * Both, deliberately: {@link reflow} re-routes only a connector whose ends it
 * can BOTH find, and drops the attachment otherwise — so an arrow with one
 * end missing is an ordinary arrow again and moves like one.
 */
export function attachedEnds(doc: Sketch, index: number): [string, string] | null {
  const e = doc.elements[index] as Element;
  if (!isAttachedConnector(e) || e.from === null || e.to === null) return null;
  return liveAttachmentEnds(doc, e.from, e.to);
}

export function isAttachedConnector(element: Element): boolean {
  const shape = element.shape;
  return (shape.type === "arrow" || shape.type === "line") && element.from !== null && element.to !== null;
}

export function liveAttachmentEnds(doc: Sketch, from: string, to: string): [string, string] | null {
  return sketchIndexOf(doc, from) === -1 || sketchIndexOf(doc, to) === -1 ? null : [from, to];
}

export function noteChanged(out: ScriptOutcome, id: string): void {
  if (!out.changed.includes(id)) {
    out.changed.push(id);
  }
}

export function translate(shape: Shape, dx: number, dy: number, page: readonly [number, number]): Shape {
  const [pw, ph] = page;
  if (shape.type === "rect" || shape.type === "ellipse") return translateBox(shape, dx, dy, pw, ph);
  if (shape.type === "text") return translateText(shape, dx, dy, pw, ph);
  return translatePoints(shape, dx, dy, pw, ph);
}

export function translateBox(
  shape: Extract<Shape, { type: "rect" | "ellipse" }>,
  dx: number,
  dy: number,
  pageWidth: number,
  pageHeight: number
): Shape {
  return {
    ...shape,
    x: clamp(shape.x + dx, 0, Math.max(pageWidth - shape.w, 0)),
    y: clamp(shape.y + dy, 0, Math.max(pageHeight - shape.h, 0)),
  };
}

export function translateText(
  shape: Extract<Shape, { type: "text" }>,
  dx: number,
  dy: number,
  pageWidth: number,
  pageHeight: number
): Shape {
  return { ...shape, x: clamp(shape.x + dx, 0, pageWidth), y: clamp(shape.y + dy, 0, pageHeight) };
}

export function translatePoints(
  shape: Extract<Shape, { type: "arrow" | "line" | "pen" }>,
  dx: number,
  dy: number,
  pageWidth: number,
  pageHeight: number
): Shape {
  return {
    ...shape,
    points: shape.points.map(([x, y]): Point => [
      clamp(x + dx, 0, pageWidth),
      clamp(y + dy, 0, pageHeight),
    ]),
  };
}

export interface MutationContext {
  doc: Sketch;
  back: string[];
  out: ScriptOutcome;
}

export type StmtOf<Kind extends Stmt["kind"]> = Extract<Stmt, { kind: Kind }>;

export function applyStmt(doc: Sketch, stmt: Stmt, back: string[], out: ScriptOutcome): void {
  STMT_APPLIERS[stmt.kind](
    { doc, back, out },
    stmt as never
  );
}

export function applyAdd(context: MutationContext, stmt: StmtOf<"add">): void {
  const id = sketchNextId(context.doc);
  context.doc.elements.push({
    ...plainElement(),
    id,
    shape: stmt.shape,
    ink: stmt.ink,
    fill: stmt.fill,
    label: stmt.label,
  });
  recordAdded(context, id, addStep(stmt, id));
}

export function addStep(stmt: StmtOf<"add">, id: string): string {
  const what = stmt.label ?? (stmt.shape.type === "text" ? stmt.shape.text : "");
  return what === "" ? `drew ${stmt.shape.type} ${id}` : `drew ${stmt.shape.type} ${id} "${what}"`;
}

export function recordAdded(context: MutationContext, id: string, step: string): void {
  context.back.push(id);
  context.out.steps.push(step);
  context.out.added.push(id);
}

export function applyLink(context: MutationContext, stmt: StmtOf<"link">): void {
  const ends = linkEnds(context.doc, stmt, context.back);
  if (ends === null) {
    // Both ends were checked in pass 1; this branch is only reachable if a
    // mutable document loses an end between validation and application.
    context.out.steps.push("skipped a link whose ends went away");
    return;
  }
  const id = sketchNextId(context.doc);
  context.doc.elements.push({
    ...plainElement(),
    id,
    shape: { type: "arrow", points: route(elementBbox(ends.from), elementBbox(ends.to)) },
    ink: stmt.ink,
    label: stmt.label,
    from: ends.fromId,
    to: ends.toId,
  });
  recordAdded(context, id, linkStep(ends, stmt, id));
}

export interface LinkEnds {
  fromId: string;
  toId: string;
  from: Element;
  to: Element;
}

export function linkEnds(doc: Sketch, stmt: StmtOf<"link">, back: readonly string[]): LinkEnds | null {
  const fromId = resolveBack(stmt.from, back);
  const toId = resolveBack(stmt.to, back);
  const from = elementById(doc, fromId);
  const to = elementById(doc, toId);
  return from === null || to === null ? null : { fromId, toId, from, to };
}

export function linkStep(ends: LinkEnds, stmt: StmtOf<"link">, id: string): string {
  return stmt.label !== null
    ? `linked ${ends.fromId} → ${ends.toId} as ${id} "${stmt.label}"`
    : `linked ${ends.fromId} → ${ends.toId} as ${id}`;
}

export function applyMove(context: MutationContext, stmt: StmtOf<"move">): void {
  const target = indexedElement(context.doc, stmt.target);
  if (target === null) {
    return;
  }
  const attached = attachedEnds(context.doc, target.index);
  if (attached !== null) {
    recordRefusedConnectorMove(context.out, stmt.target, attached);
    return;
  }
  target.element.shape = translate(target.element.shape, stmt.dx, stmt.dy, [context.doc.width, context.doc.height]);
  context.out.steps.push(`moved ${stmt.target} by ${stmt.dx},${stmt.dy}`);
  noteChanged(context.out, stmt.target);
}

export function recordRefusedConnectorMove(out: ScriptOutcome, target: string, attached: [string, string]): void {
  const [from, to] = attached;
  const why = `left ${target} where it is (a connector between ${from} and ${to} — move ${from} or ${to} instead)`;
  out.steps.push(why);
  out.refused.push(why);
}

export function applyLabel(context: MutationContext, stmt: StmtOf<"label">): void {
  const element = elementById(context.doc, stmt.target);
  if (element === null) {
    return;
  }
  if (element.shape.type === "text") {
    element.shape = { ...element.shape, text: stmt.label };
  } else {
    element.label = stmt.label;
  }
  context.out.steps.push(`relabelled ${stmt.target} to "${stmt.label}"`);
  noteChanged(context.out, stmt.target);
}

export function applyInk(context: MutationContext, stmt: StmtOf<"ink">): void {
  const element = elementById(context.doc, stmt.target);
  if (element === null) {
    return;
  }
  element.ink = stmt.ink;
  context.out.steps.push(`recoloured ${stmt.target} ${stmt.ink}`);
  noteChanged(context.out, stmt.target);
}

export function applyDelete(context: MutationContext, stmt: StmtOf<"delete">): void {
  const index = sketchIndexOf(context.doc, stmt.target);
  if (index === -1) {
    return;
  }
  context.doc.elements.splice(index, 1);
  context.out.steps.push(`deleted ${stmt.target}`);
  context.out.removed.push(stmt.target);
}

export function applyClear(context: MutationContext): void {
  const count = context.doc.elements.length;
  context.doc.elements.length = 0;
  context.back.length = 0;
  context.out.cleared = true;
  context.out.steps.push(`cleared the page (${count} removed)`);
}

export function applyCanvas(context: MutationContext, stmt: StmtOf<"canvas">): void {
  if (context.doc.width !== stmt.w || context.doc.height !== stmt.h) {
    context.out.resized = [stmt.w, stmt.h];
  }
  context.doc.width = stmt.w;
  context.doc.height = stmt.h;
  context.out.steps.push(`set the page to ${stmt.w}×${stmt.h}`);
}

export interface IndexedElement {
  index: number;
  element: Element;
}

export function indexedElement(doc: Sketch, id: string): IndexedElement | null {
  const index = sketchIndexOf(doc, id);
  return index === -1 ? null : { index, element: doc.elements[index] as Element };
}

export function elementById(doc: Sketch, id: string): Element | null {
  return indexedElement(doc, id)?.element ?? null;
}

export const STMT_APPLIERS: { [Kind in Stmt["kind"]]: (context: MutationContext, stmt: StmtOf<Kind>) => void } = {
  add: applyAdd,
  link: applyLink,
  move: applyMove,
  label: applyLabel,
  ink: applyInk,
  delete: applyDelete,
  clear: applyClear,
  canvas: applyCanvas,
};

/**
 * Apply a script to a drawing.
 *
 * Two-pass by design: every statement is parsed and checked BEFORE any of
 * them is applied. A half-applied script leaves the model reasoning about a
 * drawing that does not exist — it believes 9 of its 10 boxes landed and has
 * no way to tell which — so a script with any bad line changes nothing and
 * reports every problem it found.
 */
export function applyScript(doc: Sketch, script: string): Fallible<ScriptOutcome> {
  const lines = scriptCommandLines(script);
  const inputError = scriptLineLimitError(lines);
  if (inputError !== null) return { ok: false, error: inputError };
  const projection = validateScript(doc, lines);
  if (projection.errors.length > 0) return validationFailure(projection.errors, lines.length);
  const capacityError = projectedCapacityError(projection.live.length);
  if (capacityError !== null) return { ok: false, error: capacityError };
  return applyValidatedScript(doc, projection.statements);
}

export type ScriptLine = readonly [number, string];

export interface ScriptProjection {
  statements: Stmt[];
  errors: string[];
  created: string[];
  live: string[];
  projectedSeq: number;
  page: [number, number];
}

export function scriptCommandLines(script: string): ScriptLine[] {
  const lines: ScriptLine[] = [];
  const rawLines = script.split("\n");
  for (let index = 0; index < rawLines.length; index++) {
    const line = rustTrim(rawLines[index] as string);
    if (isScriptCommandLine(line)) lines.push([index + 1, line]);
  }
  return lines;
}

export function isScriptCommandLine(line: string): boolean {
  return line !== "" && !line.startsWith("#") && !line.startsWith("//");
}

export function scriptLineLimitError(lines: readonly ScriptLine[]): string | null {
  if (lines.length === 0) {
    return `That script had no drawing commands in it. One command per line, for example:\n${EXAMPLE_SCRIPT}`;
  }
  if (lines.length > MAX_SCRIPT_LINES) {
    return `That script has ${lines.length} lines; ${MAX_SCRIPT_LINES} is the most a single call may carry. Split it across calls.`;
  }
  return null;
}

export function validateScript(doc: Sketch, lines: readonly ScriptLine[]): ScriptProjection {
  const projection = newScriptProjection(doc);
  for (const [lineNumber, line] of lines) validateScriptLine(projection, lineNumber, line);
  return projection;
}

export function newScriptProjection(doc: Sketch): ScriptProjection {
  return {
    statements: [],
    errors: [],
    created: [],
    live: doc.elements.map((element) => element.id),
    projectedSeq: doc.seq,
    page: [doc.width, doc.height],
  };
}

export function validateScriptLine(projection: ScriptProjection, lineNumber: number, line: string): void {
  const parsed = parseStmt(line, projection.live, projection.created, projection.page);
  if (!parsed.ok) {
    recordValidationError(projection.errors, lineNumber, line, parsed.error);
    return;
  }
  projectStatement(projection, parsed.value);
  projection.statements.push(parsed.value);
}

export function recordValidationError(errors: string[], lineNumber: number, line: string, error: string): void {
  if (errors.length < MAX_REPORTED_ERRORS) errors.push(`line ${lineNumber} (\`${line}\`): ${error}`);
}

export function projectStatement(projection: ScriptProjection, statement: Stmt): void {
  if (statement.kind === "canvas") projection.page = [statement.w, statement.h];
  if (stmtCreates(statement)) projectCreatedId(projection);
  if (statement.kind === "delete") removeProjectedId(projection.live, statement.target);
  if (statement.kind === "clear") clearProjectedState(projection);
}

export function projectCreatedId(projection: ScriptProjection): void {
  projection.projectedSeq += 1;
  const id = `e${projection.projectedSeq}`;
  projection.created.push(id);
  projection.live.push(id);
}

export function removeProjectedId(live: string[], target: string): void {
  for (let index = live.length - 1; index >= 0; index--) {
    if (live[index] === target) live.splice(index, 1);
  }
}

export function clearProjectedState(projection: ScriptProjection): void {
  projection.live.length = 0;
  projection.created.length = 0;
}

export function validationFailure(errors: readonly string[], lineCount: number): Fallible<ScriptOutcome> {
  return {
    ok: false,
    error:
      `Nothing was drawn — ${errors.length} line(s) could not be read, so the whole script was refused:\n` +
      `${errors.join("\n")}${validationErrorTail(errors, lineCount)}\n\n${SCRIPT_HELP}`,
  };
}

export function validationErrorTail(errors: readonly string[], lineCount: number): string {
  const more = Math.max(lineCount - MAX_REPORTED_ERRORS, 0);
  return errors.length >= MAX_REPORTED_ERRORS && more > 0
    ? "\n(more lines may also be wrong — these are the first few.)"
    : "";
}

export function projectedCapacityError(projected: number): string | null {
  return projected > MAX_ELEMENTS
    ? `That would put ${projected} things on the page; ${MAX_ELEMENTS} is the limit. Draw fewer, or start a new sketch.`
    : null;
}

export function applyValidatedScript(doc: Sketch, statements: readonly Stmt[]): Fallible<ScriptOutcome> {
  const out = newScriptOutcome();
  const back: string[] = [];
  for (const statement of statements) applyStmt(doc, statement, back, out);
  reflow(doc);
  return { ok: true, value: out };
}
