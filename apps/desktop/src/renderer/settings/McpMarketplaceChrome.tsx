import * as React from "react";
import type { Dispatch, SetStateAction } from "react";
import type { CatalogEntry } from "../api";
import { initials } from "./marketplaceText";
import { MARKETPLACE_ICON as ICON } from "./marketplaceIcons";

/** The monogram tile's hue, as one of the five markers.
 *
 * This is IDENTITY, not status — the same job the token-budget categories and
 * the seven search engines do — so it comes from the palette rather than from
 * the `hsl(hash 45% 55%)` this used to generate. Two reasons the old version
 * had to go: an arbitrary hue wheel is a second colour system sitting next to
 * a five-marker one, and its white-on-mid-tone lettering measured under 4.5:1
 * for the lighter hues. The tile now draws in .nb-cat's recipe (ink on a wash
 * of the hue), which clears 10:1 in every hue and both themes.
 *
 * Still a pure function of the publisher's name, so a card's tile is identical
 * on every render. */
const MONO_MARKS = [
  "nb-mark-blue",
  "nb-mark-green",
  "nb-mark-yellow",
  "nb-mark-pink",
  "nb-mark-red",
];
const markFor = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 1024;
  return MONO_MARKS[h % MONO_MARKS.length];
};

/** The registry's real title when it has one, else the slug name. */
export const label = (e: CatalogEntry) => e.title || e.name;

/** True when an entry needs an API key/token to set up — its install spec
 * declares env vars (local) or auth headers (remote) the user must fill in.
 * Drives the "No API key" filter and the "Needs a key" badge. (OAuth-only
 * remote servers declare no header, so they read as key-free — sign-in is a
 * separate step.) */
export const needsKey = (e: CatalogEntry) =>
  (e.install.kind === "stdio" ? e.install.envKeys : e.install.headerKeys).length > 0;

/** A server's real icon (backend-inlined data URI) when present, else a
 * marker-washed monogram tile. Only ~1 in 12 registry servers ship an icon, so
 * the monogram is the common case. Decorative either way — the name it stands
 * for is written immediately beside it. */
export function Mono({ entry, lg }: { entry: CatalogEntry; lg?: boolean }) {
  const cls = `mkt-mono${lg ? " lg" : ""}`;
  if (entry.icon) return <img className={cls} src={entry.icon} alt="" />;
  return (
    <span className={`${cls} ${markFor(entry.publisher)}`} aria-hidden="true">
      {initials(label(entry))}
    </span>
  );
}

/** A filter, drawn as one of the system's circled chips.
 *
 * The control is a real `<input type="checkbox">` — it keeps its role, its
 * checked state and its keyboard handling, and the chip is only its FACE. The
 * input sits invisibly on top of the chip rather than being `display: none`,
 * which is what it used to be and which removed it from the accessibility
 * tree and from the tab order entirely.
 *
 * Selected reads as CIRCLED (.nb-chip.is-on draws a second offset ring) and
 * carries a tick — a real shape change, so the state survives greyscale. */
function FilterChip({
  on,
  onChange,
  label: text,
  hint,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="mkt-filter" title={hint}>
      <input
        type="checkbox"
        className="mkt-filter-box"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        className={`nb-chip nb-chip-btn mkt-filter-face${on ? " is-on" : ""}`}
      >
        {on && (
          <span className="nb-ico nb-ico-check mkt-filter-tick" aria-hidden="true" />
        )}
        {text}
      </span>
    </label>
  );
}

export function MarketplaceGate({ error, onTurnOn }: { error: string; onTurnOn: () => void }) {
  return (
    <div className="mkt-gate nb-card">
      <div className="mkt-gate-icon" aria-hidden>{ICON.globe}</div>
      <div className="mkt-gate-body">
        <strong className="mkt-gate-title">Browse the connector marketplace</strong>
        <p className="mkt-gate-copy">
          To list connectors, Arcelle fetches the public MCP registry over the internet — the one time it reaches out on its own. Nothing from your room is sent; only the catalog comes back. Installing still asks before anything runs, and you can turn browsing back off at any time.
        </p>
        <button className="primary" onClick={onTurnOn}>Turn on registry browsing</button>
        {error && <div className="gate-error">{error}</div>}
      </div>
    </div>
  );
}

type MarketplaceControlsProps = {
  localOnly: boolean;
  noKeyOnly: boolean;
  query: string;
  verifiedOnly: boolean;
  onLocalOnly: Dispatch<SetStateAction<boolean>>;
  onNoKeyOnly: Dispatch<SetStateAction<boolean>>;
  onQuery: Dispatch<SetStateAction<string>>;
  onTurnOff: () => void;
  onVerifiedOnly: Dispatch<SetStateAction<boolean>>;
};

export function MarketplaceControls({
  localOnly,
  noKeyOnly,
  query,
  verifiedOnly,
  onLocalOnly,
  onNoKeyOnly,
  onQuery,
  onTurnOff,
  onVerifiedOnly,
}: MarketplaceControlsProps) {
  return (
    <div className="mkt-controls">
      <div className="mkt-search nb-field">
        <span className="mkt-search-ico" aria-hidden="true">{ICON.search}</span>
        <input
          className="mkt-search-input"
          type="text"
          placeholder="Search the marketplace — “search”, “github”, “postgres”…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.stopPropagation();
          }}
        />
        {query !== "" && (
          <button type="button" className="mkt-search-clear" aria-label="Clear the search" onClick={() => onQuery("")}>
            {ICON.x}
          </button>
        )}
      </div>
      <div className="mkt-filters">
        <span className="mkt-filter-label">Show</span>
        <FilterChip on={verifiedOnly} onChange={onVerifiedOnly} label="Verified" hint="Publishers that own their namespace" />
        <FilterChip on={localOnly} onChange={onLocalOnly} label="Local only" hint="Hide connectors that reach the internet" />
        <FilterChip on={noKeyOnly} onChange={onNoKeyOnly} label="No API key" hint="Hide connectors that need an API key or token to set up" />
        <button type="button" className="subtle mkt-optout" title="Stop Arcelle fetching the public connector registry" onClick={onTurnOff}>Turn off browsing</button>
      </div>
    </div>
  );
}

type MarketplaceStatusProps = {
  entries: CatalogEntry[];
  error: string;
  hidden: number;
  loading: boolean;
  query: string;
  searched: boolean;
  shown: CatalogEntry[];
  onRetry: () => void;
};

export function MarketplaceStatus(props: MarketplaceStatusProps) {
  return (
    <React.Fragment>
      <MarketplaceError error={props.error} loading={props.loading} onRetry={props.onRetry} />
      <MarketplaceLoading error={props.error} loading={props.loading} searched={props.searched} />
      <MarketplaceEmpty entries={props.entries} error={props.error} loading={props.loading} searched={props.searched} shown={props.shown} />
      <MarketplaceCount error={props.error} hidden={props.hidden} loading={props.loading} searched={props.searched} shown={props.shown} />
    </React.Fragment>
  );
}

function MarketplaceError({ error, loading, onRetry }: { error: string; loading: boolean; onRetry: () => void }) {
  if (!error) return null;
  return <div className="gate-error mkt-error"><span>{error}</span><button className="btn-ic" onClick={onRetry} disabled={loading}>{loading ? "Retrying…" : "Retry"}</button></div>;
}

function MarketplaceLoading({ error, loading, searched }: { error: string; loading: boolean; searched: boolean }) {
  if (loading && !error) return <p className="mkt-status">Fetching the catalog…</p>;
  if (!loading && !error && !searched) return <p className="mkt-status">Fetching the catalog…</p>;
  return null;
}

function MarketplaceEmpty({ entries, error, loading, searched, shown }: Pick<MarketplaceStatusProps, "entries" | "error" | "loading" | "searched" | "shown">) {
  if (loading || error || !searched || shown.length > 0) return null;
  return <p className="mkt-status">{entries.length === 0 ? "The registry returned nothing for that search." : "No connectors match that. Try clearing a filter."}</p>;
}

function marketplaceCountIsVisible(
  error: string,
  loading: boolean,
  searched: boolean,
  shown: CatalogEntry[],
): boolean {
  return !loading && !error && searched && shown.length > 0;
}

function marketplaceCountLabel(shown: CatalogEntry[], hidden: number) {
  const suffix = hidden > 0 ? ` · ${hidden} hidden by filters` : "";
  return <>{shown.length} connector{shown.length === 1 ? "" : "s"}{suffix}</>;
}

function MarketplaceCount({ error, hidden, loading, searched, shown }: Pick<MarketplaceStatusProps, "error" | "hidden" | "loading" | "searched" | "shown">) {
  if (!marketplaceCountIsVisible(error, loading, searched, shown)) return null;
  return <p className="mkt-count">{marketplaceCountLabel(shown, hidden)}</p>;
}

export function MarketplaceGrid({
  installedNames,
  shown,
  onSelect,
}: {
  installedNames: string[];
  shown: CatalogEntry[];
  onSelect: Dispatch<SetStateAction<CatalogEntry | null>>;
}) {
  return (
    <div className="mkt-grid nb-frame-set">
      {shown.map((entry) => <MarketplaceCard key={entry.id} entry={entry} installed={installedNames.includes(entry.name)} onSelect={onSelect} />)}
    </div>
  );
}

function MarketplaceCard({ entry, installed, onSelect }: { entry: CatalogEntry; installed: boolean; onSelect: Dispatch<SetStateAction<CatalogEntry | null>> }) {
  return (
    <button className="mkt-card nb-card nb-lift" onClick={() => onSelect(entry)} aria-label={`${label(entry)} by ${entry.publisher}`}>
      <span className="mkt-card-head"><Mono entry={entry} /><span className="mkt-id"><span className="mkt-name">{label(entry)}</span><span className="mkt-pub">{entry.publisher || "community"}</span></span></span>
      <span className="mkt-desc">{entry.description}</span>
      <MarketplaceBadges entry={entry} installed={installed} />
    </button>
  );
}

function MarketplaceBadges({ entry, installed }: { entry: CatalogEntry; installed: boolean }) {
  return (
    <span className="mkt-badges">
      {entry.remote ? <span className="nb-tape mkt-badge nb-sem-pending">{ICON.cloud} Remote · reaches internet</span> : <span className="nb-tape mkt-badge nb-sem-done">{ICON.mac} Local · on your Mac</span>}
      {entry.verified && <span className="nb-tape mkt-badge nb-sem-linked" title="Verified publisher — this publisher owns the namespace in the registry">{ICON.check} Verified</span>}
      {needsKey(entry) && <span className="nb-tape mkt-badge nb-sem-saved" title="Needs an API key or token, which is stored in this room">{ICON.key} Needs a key</span>}
      <span className="mkt-badge mkt-badge-plain">{entry.transport}</span>
      {installed && <span className="nb-tape mkt-badge mkt-badge-installed">{ICON.check} Installed</span>}
    </span>
  );
}
