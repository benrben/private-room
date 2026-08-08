import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CloseIcon, GlobeIcon, PlusIcon } from "../icons";
import type { Tab, TabsApi } from "../workspace/tabs";
import { useAdaptiveText } from "../workspace/adaptiveText";

/** What a model-written tab title (B5) is generated from: the file's saved
 * name and a short human word for its type — nothing else, and deliberately
 * not the buffer's live text, so an edit in progress never changes what's
 * fed to the generator. Supplied per tab by the shell (see `titleFacts`
 * below) because, same as `icons`, the strip itself owns no file-type
 * knowledge — only the shell knows a tab's `ref` well enough to look up its
 * `FileMeta`. */
export interface TabTitleFacts {
  name: string;
  kind: string;
}

/** One tab's on-screen label: the model-written 2-3 word title once the
 * generator has produced one for this file, else the plain filename (still
 * end-truncated by `.tab-title`'s own CSS, unchanged from before).
 *
 * A dedicated component, not inlined in the `.map()` below, because
 * `useAdaptiveText` is a hook — the strip's tab count changes over the
 * session, and a hook can only be called once per mounted component
 * instance, never once per loop iteration of a variable-length list. Each
 * `<TabTitleText>` is one such instance, keyed by its parent's `tab.id`, so
 * its hook state (and the cache it reads) lives for exactly as long as the
 * tab it labels. */
function TabTitleText({
  roomId,
  fallback,
  facts,
}: {
  roomId: string;
  /** The plain filename to show until (or unless) a generated title lands —
   * RULE 1/3: this is what paints on the very first render, always, and what
   * stays if generation is off, offline, or degraded. */
  fallback: string;
  /** `null` = too little to generate from (not a file tab, or a file with no
   * extractable text yet) — the hook is disabled and `fallback` is all that
   * ever shows. */
  facts: TabTitleFacts | null;
}) {
  // Composed fresh from `facts` every render rather than memoized: it is a
  // pure function of `facts`' content, so two renders with the same facts
  // produce byte-identical prompt text and therefore the same cache key —
  // see adaptiveText.ts's cache-key comment on why that's fine to pass as a
  // new object/string each time.
  const prompt = facts
    ? `Reader-facing tab label for this file — 2 or 3 words, never more than 4, naming what it's ABOUT rather than repeating its filename. File: "${facts.name}" (${facts.kind}). Plain words only: no punctuation, no quotes, no trailing period.`
    : "";
  const generated = useAdaptiveText({
    roomId,
    kind: "tab_title",
    prompt,
    facts,
    maxWords: 4,
    enabled: facts !== null,
  });
  // `generated` is `undefined` on a fresh miss and `null` once known-absent —
  // both nullish, both mean "show the fallback" (RULE 1/3/8).
  return <>{generated ?? fallback}</>;
}

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
export default function TabStrip({
  tabs,
  icons,
  roomId,
  titleFacts,
  onNewPage,
}: {
  tabs: TabsApi;
  /** Per-tab glyph, supplied by the shell — the strip owns no file-type or
   * area knowledge of its own. Returning null (the shell does, for files) is
   * how a tab says "my title is the whole story"; no empty slot is drawn. */
  icons: (tab: Tab) => React.ReactNode;
  /** Scopes the adaptive tab-title cache (B5) to this room, so switching
   * rooms can never paint a title generated for a different room's file of
   * the same name — see workspace/adaptiveText.ts's `roomId`. */
  roomId: string;
  /** Facts for a tab's model-written title, or `null` when there's too
   * little to generate from — see `TabTitleFacts`. */
  titleFacts: (tab: Tab) => TabTitleFacts | null;
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
      className="tab-strip-wrap"
      data-more-start={ends.start ? "" : undefined}
      data-more-end={ends.end ? "" : undefined}
    >
      {/* "The page continues" — a hand arrow pinned to whichever end still has
          tabs beyond it. Always rendered and hidden with `visibility`, never
          conditionally mounted: appearing and disappearing would change the
          strip's own scrollWidth, which is the number that decides whether it
          should be there. Inert decoration — aria-hidden, pointer-events none
          (paper.css .nb-ico), and every tab it points at is still reachable
          from Left/Right, ⌥⌘1–9 and the library.

          Lives OUTSIDE .tab-strip on purpose, in its own reserved column next
          to the scrolling box rather than layered on top of it. It used to be
          a `position: sticky` flex child inside the same scrolling row as the
          tabs: sticky keeps its box at its original, pre-scroll flow position
          for layout purposes and only repaints it pinned to the viewport edge,
          so the gutter it reserved was only ever valid at scrollLeft 0 — one
          scroll tick in, a live tab's title would slide under that repainted
          position and the arrow rendered right on top of the tab's first
          characters (confirmed by rendering both versions and sampling
          pixels: the sticky arrow measurably painted over a scrolled-in tab's
          leading text at any scroll offset beyond a few px, growing deeper
          the further you scrolled — never disappearing, never a stable
          affordance). A plain side-by-side flex column can't repeat that: the
          scrolling box's own overflow clip ends exactly where this column
          begins, so no tab pixel can ever land here, at any scroll offset. */}
      <span className="tab-edge tab-edge-start nb-ico nb-ico-arrow" aria-hidden />
      <div
        className="tab-strip"
        role="tablist"
        aria-label="Open tabs"
        ref={stripRef}
        onScroll={measure}
      >
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
              {/* Truncate from the END, not the middle. This used to hold a
                  fixed-length tail and shrink the head instead, on the theory
                  that Room files share a long prefix and an end ellipsis cuts
                  off the part that tells them apart. In practice most titles
                  are prose ("How to Value Underpriced Growth Stocks" / "How to
                  Research an Investment Analyst") whose distinguishing words
                  sit right after the shared opening, not in a fixed last few
                  characters — the old scheme cut exactly that stretch out of
                  BOTH tabs and left two near-identical fragments ("How to
                  Value Unp…th Stocks" / "How to Research…t Analyst") standing
                  in for two very different files. A plain end ellipsis keeps
                  that opening intact, which is where a narrow tab has the best
                  chance of still reading as its own title. The full name is
                  still one hover (native `title=` above) or one glance at the
                  breadcrumb away. */}
              <span className="tab-title" aria-hidden>
                <TabTitleText
                  roomId={roomId}
                  fallback={tab.title}
                  facts={titleFacts(tab)}
                />
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
      </div>
      {/* Same reserved-column fix as the start arrow, on the other end. It
          still reads as "scrolled to the end" once the ＋ button is the
          last thing in view — that's `data-more-end` going false, computed
          from the scrolling box's own scrollLeft/scrollWidth same as ever,
          just no longer the thing sharing pixels with whatever is there. */}
      <span className="tab-edge tab-edge-end nb-ico nb-ico-arrow" aria-hidden />
    </div>
  );
}
