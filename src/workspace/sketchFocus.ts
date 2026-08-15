/**
 * WHAT THE OPEN DRAWING HAS SELECTED, for the one pane that cannot see it.
 *
 * The assistant sits beside the canvas and knew nothing about it. Asked "what
 * is missing here?" while a diagram filled the window, it answered from the
 * whole room — searching two hundred files for something that was on screen,
 * and never mentioning the drawing.
 *
 * A store rather than a prop because the two are three levels apart and neither
 * owns the other: the canvas is a lazily-loaded viewer inside the workspace
 * pane, the chat is a sibling of that pane, and threading a selection up
 * through the shell would put drawing state in every component between them.
 *
 * Only the SELECTION lives here. Which file is open is already the shell's
 * knowledge, and a second copy of it here would be a second thing to keep true.
 */

export interface SketchFocus {
  readonly fileId: string;
  /** One line per selected object, in the words the object strip shows —
   * `describeElement`, so the chat and the strip cannot disagree about what is
   * selected. Empty when nothing is. */
  readonly selection: readonly string[];
}

let focus: SketchFocus | null = null;
const watchers = new Set<() => void>();

/** Same focus, told apart by value — `useSyncExternalStore` re-renders on
 * identity, and a canvas that republishes on every pointer move would
 * otherwise re-render the entire chat several times a second. */
function same(a: SketchFocus | null, b: SketchFocus | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.fileId === b.fileId &&
    a.selection.length === b.selection.length &&
    a.selection.every((line, i) => line === b.selection[i])
  );
}

/** The open drawing publishes here; `null` when there is no drawing open. */
export function setSketchFocus(next: SketchFocus | null): void {
  if (same(focus, next)) return;
  focus = next;
  for (const notify of watchers) notify();
}

export function currentSketchFocus(): SketchFocus | null {
  return focus;
}

export function subscribeSketchFocus(notify: () => void): () => void {
  watchers.add(notify);
  return () => {
    watchers.delete(notify);
  };
}
