import { ReactNode } from "react";
import { IconProps } from "./types";

/*
 * Brand icon set. One visual system: 24px grid, 1.6px rounded strokes,
 * currentColor so icons inherit text colour and an icon can never disagree
 * with the label beside it.
 *
 * ----- THE SIZE SCALE: 12 / 14 / 16, and nothing between -----
 *
 *   12  dense metadata rows — beside --fs-micro and --fs-meta text
 *   14  the default — buttons, chips, menu rows, inline with body copy
 *   16  chrome — the activity rail, the top bar, anything a pointer aims at
 *
 * Sizes at or above 20 are ART, not chrome: the logomark and the empty-state
 * drawings, each drawn for the size it is passed. They are outside the scale
 * on purpose.
 *
 * The app used to pass SIXTEEN distinct sizes, 10 through 64, none of them
 * chosen against the others — 99 icons at 13px and 53 at 14px, differing by a
 * pixel nobody could see but enough to stop any two rows sharing a rhythm.
 * `visualRegister.test.mjs` holds the scale.
 *
 * There is no violet in this interface. The old brand violet was removed
 * everywhere; the accent is the BERRY PEN, and it means selection and active
 * state — nothing else reaches for it. The logomark is a theme-ink fill with
 * the fold's underside in the yellow highlighter tokens (see ./icons/nav.tsx);
 * the brand plum and gold live only in src-tauri/icons and public/logo.svg.
 */

export function Stroke({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}
