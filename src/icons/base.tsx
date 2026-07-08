import { ReactNode } from "react";
import { IconProps } from "./types";

/*
 * Brand icon set. One visual system: 24px grid, 1.6px rounded strokes,
 * currentColor so icons inherit text color (slate by default, violet on
 * hover/active via CSS). The violet accent is reserved for the logomark,
 * the AI spark and focal glows.
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
