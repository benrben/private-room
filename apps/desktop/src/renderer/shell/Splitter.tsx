import { LayoutApi } from "./useLayout";

/** A draggable, keyboard-operable divider between two panes. Arrow keys resize
 * (Shift for bigger steps).
 *
 * Double-click and Enter used to call `resetLayout`, which is not this
 * divider's business: it restores BOTH pane widths, un-hides both side panes,
 * leaves focus mode, puts the rail's label preference back and re-arms the AI
 * column's step-aside. One mis-timed second click while dragging threw out
 * every layout choice in the room, with no undo, from a control 5px wide that
 * looks local. The whole-window reset stays where it is named: the toolbar's
 * Layout menu, View → Layout → Reset Layout, and ⌘K. */
export default function Splitter({
  side,
  layout,
  label,
}: {
  side: "a" | "b";
  layout: LayoutApi;
  label: string;
}) {
  const show = side === "a" ? layout.showSplitA : layout.showSplitB;
  const value =
    side === "a"
      ? Math.round(layout.ratios.library * 100)
      : Math.round((1 - layout.ratios.ai) * 100);
  return (
    // Stays a grid item even when its track is 0px (display:none would shift
    // every later pane into the wrong grid column) — visibility does the hiding.
    <div
      role="separator"
      tabIndex={show ? 0 : -1}
      aria-hidden={!show}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      title="Drag to resize, or use the arrow keys."
      className={`splitter${layout.dragging === side ? " is-dragging" : ""}${show ? "" : " is-off"}`}
      onPointerDown={(e) => layout.startDrag(side, e)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          layout.keyResize(side, dir, e.shiftKey);
        }
      }}
    />
  );
}
