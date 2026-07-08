/*
 * Brand icon set. One visual system: 24px grid, 1.6px rounded strokes,
 * currentColor so icons inherit text color (slate by default, violet on
 * hover/active via CSS). The violet accent is reserved for the logomark,
 * the AI spark and focal glows.
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
