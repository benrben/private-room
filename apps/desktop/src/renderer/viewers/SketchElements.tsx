import { type ReactElement } from "react";
import { type SketchElement, arrowHead, bboxOf, ellipsePath, rectPath, seeded, strokePath } from "./sketch/model";

export type RectElement = Extract<SketchElement, { type: "rect" }>;
export type EllipseElement = Extract<SketchElement, { type: "ellipse" }>;
export type ArrowElement = Extract<SketchElement, { type: "arrow" }>;
export type LineElement = Extract<SketchElement, { type: "line" }>;
export type PenElement = Extract<SketchElement, { type: "pen" }>;
export type TextElement = Extract<SketchElement, { type: "text" }>;

export function ShapeLabel({ label, x, y }: { label?: string; x: number; y: number }) {
  if (!label) return null;
  return (
    <text className="sk-shape-label" x={x} y={y}>
      {label}
    </text>
  );
}

export function RectBody({ el }: { el: RectElement }) {
  return (
    <>
      {el.fill ? (
        <rect
          className="sk-fill"
          x={el.x}
          y={el.y}
          width={el.w}
          height={el.h}
          rx={8}
        />
      ) : null}
      <path
        className="sk-line"
        d={rectPath(seeded(el.id), el.x, el.y, el.w, el.h)}
      />
      <ShapeLabel
        label={el.label}
        x={el.x + el.w / 2}
        y={el.y + el.h / 2 + 9}
      />
    </>
  );
}

export function EllipseBody({ el }: { el: EllipseElement }) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  return (
    <>
      {el.fill ? (
        <ellipse
          className="sk-fill"
          cx={cx}
          cy={cy}
          rx={el.w / 2}
          ry={el.h / 2}
        />
      ) : null}
      <path
        className="sk-line"
        d={ellipsePath(seeded(el.id), cx, cy, el.w / 2, el.h / 2)}
      />
      <ShapeLabel label={el.label} x={cx} y={cy + 9} />
    </>
  );
}

export function TextBody({ el }: { el: TextElement }) {
  return (
    <text className="sk-note" x={el.x} y={el.y} fontSize={el.size}>
      {el.text}
    </text>
  );
}

export function ArrowBody({ el }: { el: ArrowElement }) {
  const [h1, h2] = arrowHead(el.points);
  const tip = el.points[el.points.length - 1];
  const start = el.points[0];
  return (
    <>
      <path className="sk-line" d={strokePath(el.points)} />
      <path className="sk-line" d={`M${tip[0]} ${tip[1]}L${h1[0]} ${h1[1]}`} />
      <path className="sk-line" d={`M${tip[0]} ${tip[1]}L${h2[0]} ${h2[1]}`} />
      <ShapeLabel
        label={el.label}
        x={(start[0] + tip[0]) / 2}
        y={(start[1] + tip[1]) / 2 - 12}
      />
    </>
  );
}

export function LineBody({ el }: { el: LineElement }) {
  const start = el.points[0];
  const end = el.points[el.points.length - 1];
  return (
    <>
      <path className="sk-line sk-stroke" d={strokePath(el.points)} />
      <ShapeLabel
        label={el.label}
        x={(start[0] + end[0]) / 2}
        y={(start[1] + end[1]) / 2 - 12}
      />
    </>
  );
}

export function PenBody({ el }: { el: PenElement }) {
  const box = bboxOf(el);
  return (
    <>
      <path className="sk-line sk-stroke" d={strokePath(el.points)} />
      <ShapeLabel
        label={el.label}
        x={box.x + box.w / 2}
        y={box.y + box.h / 2 + 9}
      />
    </>
  );
}

export const DRAWN_BODIES: Record<
  SketchElement["type"],
  (el: SketchElement) => ReactElement
> = {
  rect: (el) => <RectBody el={el as RectElement} />,
  ellipse: (el) => <EllipseBody el={el as EllipseElement} />,
  text: (el) => <TextBody el={el as TextElement} />,
  arrow: (el) => <ArrowBody el={el as ArrowElement} />,
  line: (el) => <LineBody el={el as LineElement} />,
  pen: (el) => <PenBody el={el as PenElement} />,
};

export function SelectionOutline({ el }: { el: SketchElement }) {
  const box = bboxOf(el);
  return (
    <rect
      className="sk-selection"
      x={box.x - 7}
      y={box.y - 7}
      width={box.w + 14}
      height={box.h + 14}
    />
  );
}

/** One element, drawn. Pure — every path is a function of the element alone. */
export function Drawn({
  el,
  selected,
  fresh,
}: {
  el: SketchElement;
  selected: boolean;
  fresh: boolean;
}) {
  return (
    <g
      className={`sk-el sk-ink-${el.ink}${fresh ? " sk-fresh" : ""}`}
      data-id={el.id}
    >
      {DRAWN_BODIES[el.type](el)}
      {selected ? <SelectionOutline el={el} /> : null}
    </g>
  );
}
