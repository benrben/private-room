import { useRef, useState } from "react";
import { CloseIcon, GlobeIcon, PlusIcon } from "../icons";
import type { Tab, TabsApi } from "../workspace/tabs";

/** The workspace's open tabs.
 *
 * Lives ABOVE the pane's measured rect on purpose: the private browser is a
 * native child webview positioned from that rect, and nothing can be drawn
 * over a native webview — so a strip that overlapped it would simply vanish
 * behind the page. Same reason the address bar sits where it does. */
export default function TabStrip({
  tabs,
  icons,
  onNewPage,
}: {
  tabs: TabsApi;
  /** Per-tab glyph, supplied by the shell — the strip owns no file-type or
   * area knowledge of its own. */
  icons: (tab: Tab) => React.ReactNode;
  /** Opens another private-browser page. Absent when the browser is off. */
  onNewPage: (() => void) | null;
}) {
  const [dragging, setDragging] = useState<string>("");
  const stripRef = useRef<HTMLDivElement>(null);

  /** Roving focus: a `role="tablist"` owes Left/Right (and Home/End) — without
   * them the strip claims to be a tab strip that keyboard users can't move
   * through. Focus moves first, then the shell decides whether the switch is
   * allowed (it can refuse on unsaved edits). */
  const focusTab = (index: number) => {
    const nodes =
      stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    nodes?.[index]?.focus();
  };

  const arrowTo = (from: number, delta: number) => {
    const count = tabs.tabs.length;
    if (count < 2) return;
    const to = (from + delta + count) % count;
    focusTab(to);
    tabs.activate(tabs.tabs[to].id);
  };

  if (!tabs.tabs.length) return null;

  return (
    <div className="tab-strip" role="tablist" aria-label="Open tabs" ref={stripRef}>
      {tabs.tabs.map((tab, index) => {
        const current = tab.id === tabs.activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={current}
            tabIndex={current ? 0 : -1}
            title={tab.title}
            className={`tab${current ? " is-current" : ""}${
              dragging === tab.id ? " is-dragging" : ""
            }`}
            draggable
            onDragStart={() => setDragging(tab.id)}
            onDragEnd={() => setDragging("")}
            onDragOver={(e) => {
              e.preventDefault();
              const from = tabs.tabs.findIndex((t) => t.id === dragging);
              if (from >= 0 && from !== index) tabs.move(from, index);
            }}
            onClick={() => tabs.activate(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                tabs.activate(tab.id);
                return;
              }
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                arrowTo(index, e.key === "ArrowRight" ? 1 : -1);
                return;
              }
              if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                const to = e.key === "Home" ? 0 : tabs.tabs.length - 1;
                focusTab(to);
                tabs.activate(tabs.tabs[to].id);
              }
            }}
            onAuxClick={(e) => {
              // Middle-click closes, as everywhere else with tabs.
              if (e.button === 1) {
                e.preventDefault();
                tabs.close(tab.id);
              }
            }}
          >
            <span className="tab-icon" aria-hidden>
              {icons(tab)}
            </span>
            <span className="tab-title">{tab.title}</span>
            <button
              className="tab-close"
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                tabs.close(tab.id);
              }}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        );
      })}
      {onNewPage && (
        <button
          className="tab-new"
          aria-label="New browser page"
          title="New browser page (⌘T)"
          onClick={onNewPage}
        >
          <PlusIcon size={12} />
          <GlobeIcon size={11} />
        </button>
      )}
    </div>
  );
}
