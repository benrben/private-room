import type React from "react";
import type { ResultPreview, WebHit } from "../apiTypes";
import { CheckIcon, EyeIcon, LinkIcon, PlusIcon } from "../icons";
import { hostOf } from "./browserAnnounce";
import { ENGINE_SLOTS, PREVIEW_COUNT, type AddState } from "./BrowserSearch";

export type CardDisplay = {
  blurb: string | null;
  host: string;
  waiting: boolean;
};

export function cardDisplay(
  hit: WebHit,
  idx: number,
  preview: ResultPreview | undefined,
  previewsPending: boolean,
): CardDisplay {
  return {
    host: hostOf(hit.url) ?? hit.url,
    blurb: preview?.description || hit.snippet || null,
    waiting: previewsPending && !preview && idx < PREVIEW_COUNT,
  };
}

export function searchCardClassName(
  tier: "feature" | "duo" | "row",
  selected: boolean,
  peek: string | null | undefined,
): string {
  return `bsearch-card ${tier}${selected ? " sel" : ""}${peek !== undefined ? " peeked" : ""}`;
}

export function shouldOpenSearchCard(event: React.MouseEvent<HTMLElement>): boolean {
  if (isCardControl(event.target)) return false;
  return !hasCardTextSelection(event.currentTarget);
}

export function isCardControl(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("button, .bsearch-peek") !== null
  );
}

export function hasCardTextSelection(card: HTMLElement): boolean {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed) return false;
  if (!selection.toString().trim()) return false;
  return card.contains(selection.anchorNode);
}

export function SearchCardImage({
  display,
  preview,
}: {
  display: CardDisplay;
  preview: ResultPreview | undefined;
}) {
  const image = preview?.image;
  if (image) return <CardImage image={image} waiting={display.waiting} />;
  if (display.waiting) return <CardImage waiting />;
  return <CardMonogram host={display.host} />;
}

export function CardImage({
  image,
  waiting,
}: {
  image?: string | null;
  waiting?: boolean;
}) {
  return (
    <div
      className={`bsearch-img${waiting ? " waiting" : ""}${image ? " has" : ""}`}
      aria-hidden
    >
      {image && <img src={image} alt="" loading="lazy" />}
    </div>
  );
}

export function CardMonogram({ host }: { host: string }) {
  return (
    <div className="bsearch-img" aria-hidden>
      <span className="bsearch-mono" style={monoStyle(host)}>
        {monogramLetter(host)}
      </span>
    </div>
  );
}

export function monogramLetter(host: string): string {
  return host
    .replace(/^(www|en|blog|news|groups)\./, "")
    .charAt(0)
    .toUpperCase();
}

export function FeatureEyebrow({
  engines,
  tier,
}: {
  engines: string[];
  tier: "feature" | "duo" | "row";
}) {
  if (tier !== "feature") return null;
  return (
    <div className="bsearch-eyebrow">
      Top result · {engines.length} of {ENGINE_SLOTS.length} engines agree
    </div>
  );
}

export function SearchCardCrumb({
  host,
  preview,
  url,
}: {
  host: string;
  preview: ResultPreview | undefined;
  url: string;
}) {
  return (
    <div className="bsearch-crumb">
      <CardFavicon icon={preview?.icon} />
      <b>{host}</b>
      {pathBits(url).map((part, index) => (
        <span key={index}>
          <i>›</i>
          {part}
        </span>
      ))}
    </div>
  );
}

export function CardFavicon({ icon }: { icon: string | null | undefined }) {
  if (!icon) return null;
  return <img className="bsearch-favicon" src={icon} alt="" />;
}

export function CardBlurb({ blurb }: { blurb: string | null }) {
  if (!blurb) return null;
  return (
    <p className="bsearch-snippet" dir="auto">
      {blurb}
    </p>
  );
}

export function SearchCardMeta({
  addState,
  hit,
  onAdd,
  onOpenNewTab,
  onPeek,
  peek,
  relative,
}: {
  addState: AddState;
  hit: WebHit;
  onAdd: () => void;
  onOpenNewTab: () => void;
  onPeek: () => void;
  peek: string | null | undefined;
  relative: number;
}) {
  return (
    <div className="bsearch-metarow">
      <SearchCardDial engines={hit.engines} />
      <span className="bsearch-engn">
        {hit.engines.length} of {ENGINE_SLOTS.length} engines
      </span>
      <CardDate date={hit.date} />
      <CardRelevance relative={relative} score={hit.score} />
      <AttachmentStatus addState={addState} />
      <SearchCardActions
        addState={addState}
        onAdd={onAdd}
        onOpenNewTab={onOpenNewTab}
        onPeek={onPeek}
        peek={peek}
      />
    </div>
  );
}

export function SearchCardDial({ engines }: { engines: string[] }) {
  return (
    <span
      className="bsearch-dial"
      style={{ background: dialGradient(engines) }}
      title={`Found by ${engines.join(" · ")} — each engine keeps the same slot on every card`}
    />
  );
}

export function CardDate({ date }: { date: string | null | undefined }) {
  if (!date) return null;
  return <span className="bsearch-date">{date}</span>;
}

export function CardRelevance({
  relative,
  score,
}: {
  relative: number;
  score: number;
}) {
  return (
    <span className="bsearch-rel" title={`Relevance ${score.toFixed(2)}`}>
      <i style={{ width: `${Math.round(relative * 100)}%` }} />
    </span>
  );
}

export function AttachmentStatus({ addState }: { addState: AddState }) {
  if (addState !== "added") return null;
  return (
    <span className="bsearch-inroom">
      <CheckIcon size={12} /> In room · attached
    </span>
  );
}

export function SearchCardActions({
  addState,
  onAdd,
  onOpenNewTab,
  onPeek,
  peek,
}: {
  addState: AddState;
  onAdd: () => void;
  onOpenNewTab: () => void;
  onPeek: () => void;
  peek: string | null | undefined;
}) {
  return (
    <span className="bsearch-acts">
      <button
        className="browser-btn"
        type="button"
        aria-label="Open in a new tab"
        title="Open in a new tab"
        onClick={onOpenNewTab}
      >
        <LinkIcon size={14} />
      </button>
      <button
        className="browser-btn"
        type="button"
        aria-label="Peek — read a preview without opening"
        title="Peek — read a preview without opening"
        aria-pressed={peek !== undefined}
        onClick={onPeek}
      >
        <EyeIcon size={14} />
      </button>
      <AddSearchResultButton addState={addState} onAdd={onAdd} />
    </span>
  );
}

export function AddSearchResultButton({
  addState,
  onAdd,
}: {
  addState: AddState;
  onAdd: () => void;
}) {
  return (
    <button
      className={addButtonClassName(addState)}
      type="button"
      disabled={addState === "adding"}
      aria-label="Add to the chat as a source"
      title="Add to the chat as a source"
      onClick={onAdd}
    >
      <AddButtonIcon addState={addState} />
    </button>
  );
}

export function addButtonClassName(addState: AddState): string {
  return `browser-btn bsearch-add${addState === "added" ? " done" : ""}`;
}

export function AddButtonIcon({ addState }: { addState: AddState }) {
  if (addState === "added") return <CheckIcon size={14} />;
  if (addState === "adding") return <span className="bsearch-spin" />;
  return <PlusIcon size={14} />;
}

export function ReaderPeek({ peek }: { peek: string | null | undefined }) {
  if (peek === undefined) return null;
  return (
    <div className="bsearch-peek">
      <div className="bsearch-peek-head">
        Reader preview{peek === null ? " — reading…" : ""}
      </div>
      {peek && <p dir="auto">{peek}</p>}
    </div>
  );
}

/* ----------------------------------------------------------------- bits --- */

/** The dial: every engine owns a fixed wedge, lit when it returned this URL.
 *  Same engine, same angle, every card — so agreement is readable by shape. */
export function dialGradient(engines: string[]): string {
  const slot = 360 / ENGINE_SLOTS.length;
  const gap = 5;
  const stops = ENGINE_SLOTS.map((engine, i) => {
    const lit = engines.includes(engine);
    const color = lit
      ? `var(--eng-${engine.replace("-", "")})`
      : "color-mix(in srgb, var(--line) 60%, transparent)";
    const a = (i * slot + gap / 2).toFixed(1);
    const b = ((i + 1) * slot - gap / 2).toFixed(1);
    return `transparent ${a}deg, ${color} ${a}deg ${b}deg, transparent ${b}deg`;
  });
  return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

/** A stable hue per host, so the same site keeps the same tile between
 *  searches. No favicon is fetched for this — that would contact the origin.
 *
 *  Only the HUE is decided here. The lightness is the stylesheet's job
 *  (browser.css .bsearch-mono), because one lightness cannot clear contrast
 *  on both papers: the previous version wrote a finished `hsl(h 55% 68%)`
 *  into the style attribute and that letter sat at roughly 2:1 on the ivory
 *  theme's near-white tile. A component has no business picking a colour this
 *  app has two themes for. */
export function monoStyle(host: string): React.CSSProperties {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) % 360;
  return { "--mono-h": String(h) } as React.CSSProperties;
}

export function pathBits(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}
