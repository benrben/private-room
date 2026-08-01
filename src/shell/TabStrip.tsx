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
