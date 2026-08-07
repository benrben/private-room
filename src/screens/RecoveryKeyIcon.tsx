import { Stroke } from "../icons/base";
import { IconProps } from "../icons/types";

// The room's recovery-key glyph, for the "Forgot password?" affordance and
// the one-time code sheet.
//
// It draws through the shared `Stroke` base rather than hand-rolling its own
// <svg>, so it is provably the same mark-making as every other icon in the
// app — one 24px grid, one 1.6px stroke, currentColor, aria-hidden — instead
// of a near-copy that drifts the next time the icon set is retuned. Same
// paths, same 16px default, and it now accepts `className` like its siblings.
export function RecoveryKeyIcon(p: IconProps) {
  return (
    <Stroke {...p}>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2 20 3" />
      <path d="M16.5 6.5 19 9" />
      <path d="M14 9l2 2" />
    </Stroke>
  );
}
