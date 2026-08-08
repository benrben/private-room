import { ReactNode } from "react";
import { IconProps } from "./types";

/*
 * Brand icon set. One visual system: 24px grid, 1.6px rounded strokes,
 * currentColor so icons inherit text colour and an icon can never disagree
 * with the label beside it.
 *
 * There is no violet in this interface. The old brand violet was removed
 * everywhere; the accent is now the PINK PEN, and it means selection and
 * active state — nothing else reaches for it. The logomark is a theme-ink
 * fill with the fold's underside in the yellow highlighter tokens (see
 * ./icons/nav.tsx); the brand plum and gold live only in src-tauri/icons
 * and public/logo.svg.
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
