import type { WorkArea } from "./types";

/** THE CONTEXTUAL SIDEBAR CONTRACT.
 *
 * Two levels of navigation, and each answers exactly one question:
 *
 *   • the rail (shell/ActivityRail.tsx) — "which part of Arcelle am I in?"
 *   • the second column — "what can I open or manage in here?"
 *
 * The second column used to be called Library everywhere and be the Library
 * nearly everywhere, which made it answer the first question again in two of
 * the destinations and answer nothing at all in three others (Sketch and
 * Create rendered an empty column titled Library; the browser rendered a
 * paragraph explaining that its pages were somewhere else). This module is
 * the one place that says what the column IS per destination, so a new
 * destination cannot quietly inherit Home's.
 *
 * Everything here is pure and total over `WorkArea` — `Record<WorkArea, …>`
 * means a destination added to the union fails to compile until it has
 * declared what its second column shows. That is the whole point: falling
 * back to Home's Library is exactly the bug this replaces. */

/** What the second column is called in each destination, or `null` for the
 * destinations that deliberately have none and give their width to the
 * workspace instead.
 *
 * "Library" appears twice and only twice — `files` and `home` ARE Home. */
export const SIDEBAR_TITLES: Record<WorkArea, string | null> = {
  files: "Library",
  home: "Library",
  // The map's own scope and filters, not the room's file list. The map draws
  // room content; that does not make the Library its navigator.
  map: "Map",
  recordings: "Recordings",
  workflows: "Workflows",
  scripts: "Scripts",
  skills: "Skills",
  memory: "Memory",
  connectors: "Connectors",
  skin: "Skin Studio",
  create: "Creations",
  sketch: "Sketches",
  browser: "Private pages",
};

/** The accessible name of the second column's region.
 *
 * Home's column really is the library AND the AI evidence set, so it keeps the
 * name it has always had. Everywhere else the region is named after what is in
 * it — announcing "Library and sources" over a list of private browser pages
 * was a false statement made to exactly the users who cannot check it. */
export function sidebarRegionLabel(area: WorkArea): string {
  const title = SIDEBAR_TITLES[area];
  if (title === null) return "Contextual sidebar";
  if (area === "files" || area === "home") return "Library and sources";
  return title;
}

/** What the ⌘1 row is called in the Layout menus, native and in-app.
 *
 * Both menus said "Library ⌘1" in every destination, so the one control that
 * shows and hides the second column named it after Home's contents while
 * standing over Memory's. The row toggles whatever column is actually there,
 * and now says so. `null` — a destination with no second column — falls back to
 * the generic word rather than to Home's: the row still toggles the pane, there
 * is simply nothing destination-specific to call it. */
export function sidebarMenuLabel(area: WorkArea): string {
  return SIDEBAR_TITLES[area] ?? "Sidebar";
}

/** What ⌘T makes here, or `null` where the destination has no new-item verb.
 *
 * ⌘T used to mean "new private browser page" everywhere in the app, including
 * in destinations that have no browser on screen — so the shortcut navigated
 * you out of what you were doing. It is the destination's key now, and a
 * destination with nothing to make simply does not claim it (the press falls
 * through untouched rather than being swallowed). */
export type NewItemKind = "page" | "sketch" | "creation" | "note";

export function newItemOf(area: WorkArea): NewItemKind | null {
  switch (area) {
    case "browser":
      return "page";
    case "sketch":
      return "sketch";
    case "create":
      return "creation";
    case "files":
    case "home":
      return "note";
    default:
      return null;
  }
}

/** Whether this destination draws the horizontal document strip above the
 * workspace.
 *
 * ONLY Home. The strip's contents are room documents, which is a Home concept;
 * a strip of room files above the Skills editor, the sketch canvas or a
 * private page was navigation belonging to somewhere else, taking height from
 * the surface the reader had actually chosen. Every other destination switches
 * through its own contextual sidebar, which is both closer to the content and
 * always visible. */
export function showsDocumentTabs(area: WorkArea): boolean {
  return area === "files" || area === "home";
}

/** The one-line label for ⌘T in this destination, for the shortcuts sheet and
 * the sidebar header's tooltip. Null where ⌘T does nothing.
 *
 * Home's is "New note", not "New page": ⌘T there makes a blank Markdown note in
 * the library, while ⌘T in the browser opens a web page. Both were called "New
 * page", so the shortcut sheet promised the same object in two destinations and
 * delivered two different ones. */
export function newItemLabel(area: WorkArea): string | null {
  switch (newItemOf(area)) {
    case "page":
      return "New page";
    case "sketch":
      return "New sketch";
    case "creation":
      return "New creation";
    case "note":
      return "New note";
    default:
      return null;
  }
}
