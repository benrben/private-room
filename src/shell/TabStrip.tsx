import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CloseIcon, GlobeIcon, PlusIcon } from "../icons";
import type { Tab, TabsApi } from "../workspace/tabs";

/** The workspace's open DOCUMENTS.
 *
 * Not its navigation: places live in the activity rail, which is always
 * visible and can name them in full (see shell/ActivityRail.tsx). What is left
 * here is the short, honest list of things you have actually opened — files
 * and private-browser pages — so a tab can be a readable title rather than one
 * of two glyphs repeated eight times.
 *
 * Lives ABOVE the pane's measured rect on purpose: the private browser is a
 * native child webview positioned from that rect, and nothing can be drawn
 * over a native webview — so a strip that overlapped it would simply vanish
 * behind the page. Same reason the address bar sits where it does. */
/** How many trailing characters a tab holds on to when it has to truncate.
 *
 * Enough for a short extension plus a few characters of the distinguishing
 * part (`…-script.js`, `…-14.32.m4a`), and not so many that the head — where
 * the human-chosen words usually are — loses its share of a narrow tab. */
const TAIL = 9;

const headOf = (title: string): string =>
  title.length > TAIL ? title.slice(0, title.length - TAIL) : title;
const tailOf = (title: string): string =>
  title.length > TAIL ? title.slice(title.length - TAIL) : "";

export default function TabStrip({
  tabs,
  icons,
  onNewPage,
}: {
  tabs: TabsApi;
  /** Per-tab glyph, supplied by the shell — the strip owns no file-type or
   * area knowledge of its own. Returning null (the shell does, for files) is
   * how a tab says "my title is the whole story"; no empty slot is drawn. */
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

  /** Which ends of the strip have more tabs beyond them.
   *
   * The strip has always scrolled horizontally, but with the scrollbar hidden
   * there was nothing on screen that said so — tabs simply stopped, and the
   * ones past the edge may as well not have existed. These two flags drive the
   * pinned arrows below, so overflow reads as "the page continues" rather than
   * as "that is all of them". Recomputed on scroll, on resize and whenever the
   * list changes, because all three can change the answer. */
  const [ends, setEnds] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // A pixel of slack: sub-pixel layout leaves scrollLeft a hair short of max
    // at the true end, which would leave the "more this way" fade up forever.
    setEnds((prev) => {
      const next = { start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 };
      return prev.start === next.start && prev.end === next.end ? prev : next;
    });
  }, []);

  useLayoutEffect(measure, [measure, tabs.tabs]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  /** Keep the current tab reachable. Activating a tab from ⌥⌘7, ⇧⌘], a
   * citation or the library can select one that is scrolled out of sight;
   * without this the strip would show a selection the user cannot see. Jumps
   * rather than animates — this is a correction, not a transition, and it must
   * behave identically under prefers-reduced-motion. */
  useEffect(() => {
    const el = stripRef.current;
    if (!el || !tabs.activeId) return;
    const current = el.querySelector<HTMLElement>('[aria-selected="true"]');
    current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    measure();
  }, [tabs.activeId, measure]);

  if (!tabs.tabs.length) return null;

  return (
    <div
      className="tab-strip"
      role="tablist"
      aria-label="Open tabs"
      ref={stripRef}
      onScroll={measure}
      data-more-start={ends.start ? "" : undefined}
      data-more-end={ends.end ? "" : undefined}
    >
      {/* "The page continues" — a hand arrow pinned to whichever end still has
          tabs beyond it. Always rendered and hidden with `visibility`, never
          conditionally mounted: appearing and disappearing would change the
          strip's own scrollWidth, which is the number that decides whether it
          should be there. Inert decoration — aria-hidden, pointer-events none
          (paper.css .nb-ico), and every tab it points at is still reachable
          from Left/Right, ⌥⌘1–9 and the library. */}
      <span className="tab-edge tab-edge-start nb-ico nb-ico-arrow" aria-hidden />
      {tabs.tabs.map((tab, index) => {
        const current = tab.id === tabs.activeId;
        const glyph = icons(tab);
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
            {glyph && (
              <span className="tab-icon" aria-hidden>
                {glyph}
              </span>
            )}
            {/* Truncate from the MIDDLE, not the end. Room files routinely
                share a long prefix — a set of `arcelle-qa-…` fixtures, a run
                of `2026-08-…` recordings, a folder of `meeting-notes-…` — and
                an end ellipsis cuts off the one part that tells them apart, so
                a strip of eight tabs read as eight copies of the same title.
                The head shrinks and the tail is held; when the tab is wide
                enough for the whole name the tail is empty and this is an
                ordinary label. */}
            <span className="tab-title" aria-hidden>
              <span className="tab-title-head">{headOf(tab.title)}</span>
              <span className="tab-title-tail">{tailOf(tab.title)}</span>
            </span>
            {/* The name, once, for anything reading rather than looking. Split
                across two elements it would be announced with a seam in it. */}
            <span className="sr-only">{tab.title}</span>
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
      {/* Last, so "scrolled to the end" is the state where it is gone and the
          ＋ button is the thing at the edge. */}
      <span className="tab-edge tab-edge-end nb-ico nb-ico-arrow" aria-hidden />
    </div>
  );
}
