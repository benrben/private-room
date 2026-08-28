/*
 * Brand icon set. One visual system: 24px grid, 1.6px rounded strokes,
 * currentColor so icons inherit text colour and an icon can never disagree
 * with the label beside it.
 *
 * There is no violet in this interface. The old brand violet was removed
 * everywhere; the accent is now the PINK PEN, and it means selection and
 * active state — nothing else reaches for it. The logomark is a theme-ink
 * fill with the fold's underside in the yellow highlighter tokens (see
 * ./icons/nav.tsx); the brand plum and gold live only in the master artwork
 * under assets/brand/, the packaged macOS icons, and public/logo.svg.
 *
 * This module is a barrel: the icons are grouped by theme into sibling
 * files under ./icons/ and re-exported here so every `import { XIcon }
 * from "./icons"` keeps resolving unchanged.
 */

export * from "./icons/actions";
export * from "./icons/nav";
export * from "./icons/status";
export * from "./icons/files";
export * from "./icons/features";
export * from "./icons/empty";
export * from "./icons/shell";
