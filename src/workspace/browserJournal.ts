import type { BrowseJournalRow } from "../apiTypes";

/* THE JOURNAL, READ AS A RECORD RATHER THAN A LOG.
 *
 * The panel used to fetch the newest 300 rows and print every one of them in a
 * flat list — hundreds of events from many days and unrelated sittings, the
 * same blocker failure repeated dozens of times, long URLs, no boundary
 * anywhere. That is auditable and unusable, which for an audit trail is the
 * same as unauditable: nobody reads it, so nothing in it is ever noticed.
 *
 * Three transformations, in order, all pure so they can be pinned without a
 * browser:
 *
 *   1. SESSION — rows carry the browsing sitting they belong to. "What just
 *      happened" is the default view; everything older is behind a deliberate
 *      click. The boundary is Rust's, not a guess from timestamp gaps: a gap is
 *      indistinguishable from a slow reader.
 *   2. FACET — six filters over twelve free-form kinds. The kinds are written
 *      as string literals at each call site in Rust, so this map is the ONE
 *      place that knows the vocabulary, and an unknown kind is shown rather
 *      than hidden. Filtering that silently drops what it does not recognise is
 *      how an audit trail loses the row that mattered.
 *   3. RUN — consecutive identical rows collapse to one line with a count. The
 *      content blocker journals per page created, so a failing blocker writes
 *      the same sentence once per page and buries the rest of the sitting.
 *
 * The summary is deliberately counted from the FULL session, not from the
 * filtered view: a headline that changes when you tick a filter is describing
 * the filter rather than the sitting.
 */

/** The filters the panel offers. `all` is not a facet — it is the absence of
 *  one, which is why it is not in this table. */
export type JournalFacet =
  | "agent"
  | "user"
  | "saved"
  | "consent"
  | "errors"
  | "protection";

/** Which facet each Rust `kind` belongs to.
 *
 * Kinds are free-form `&str` literals in Rust with no enum behind them, so this
 * is a map rather than an exhaustive switch, and `facetOf` answers `null` for
 * anything not listed. An unlisted kind is a new one somebody added — it must
 * survive filtering, not vanish from the record. */
const FACET_OF: Readonly<Record<string, JournalFacet>> = {
  open: "agent",
  search: "agent",
  read: "agent",
  act: "agent",
  look: "agent",
  takeover: "user",
  save: "saved",
  download: "saved",
  consent: "consent",
  error: "errors",
  blocked: "errors",
  blocker: "protection",
};

export const FACETS: readonly { id: JournalFacet; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "user", label: "User" },
  { id: "saved", label: "Saved" },
  { id: "consent", label: "Consent" },
  { id: "errors", label: "Errors" },
  { id: "protection", label: "Protection" },
];

export function facetOf(kind: string): JournalFacet | null {
  return FACET_OF[kind] ?? null;
}

/** One line of the rendered record: a row, plus how many identical rows it
 *  stands for. `runs === 1` is the ordinary case. */
export interface JournalLine {
  row: BrowseJournalRow;
  runs: number;
}

/** Rows of one browsing sitting, newest first, as the panel draws them. */
export interface JournalSession {
  /** Rust's session id. `""` is the pre-migration bucket: rows written before
   *  sittings were recorded, which are honestly undatable to a sitting and are
   *  never presented as the current one. */
  id: string;
  current: boolean;
  lines: JournalLine[];
  /** Counted over the whole sitting, before any filter. */
  summary: string;
  /** When the sitting started, for its heading. */
  from: string;
}

/** Collapse consecutive identical rows.
 *
 * IDENTICAL means same kind, same detail and same address — not merely the same
 * kind. Two different pages that both failed to block are two facts; the same
 * page failing to block fifty times is one fact with a count, and printing it
 * fifty times is how the other forty-nine rows in a sitting got pushed off the
 * panel. Order is preserved and never re-sorted: the record's whole value is
 * that it is in the order things happened. */
export function coalesce(rows: readonly BrowseJournalRow[]): JournalLine[] {
  const lines: JournalLine[] = [];
  for (const row of rows) {
    const last = lines[lines.length - 1];
    const same =
      last &&
      last.row.kind === row.kind &&
      last.row.detail === row.detail &&
      last.row.url === row.url;
    if (same) {
      last.runs += 1;
      continue;
    }
    lines.push({ row, runs: 1 });
  }
  return lines;
}

/** What a sitting amounted to, in the words the user would use.
 *
 * Only the counts that are non-zero are named, so a sitting where nothing was
 * saved does not claim "0 saved" — a zero in a summary reads as a fact that was
 * checked, and these are simply absent. */
export function summarise(rows: readonly BrowseJournalRow[]): string {
  const n = (kind: string) => rows.filter((r) => r.kind === kind).length;
  const parts: string[] = [];
  const say = (count: number, one: string, many: string) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
  };
  say(n("search"), "search", "searches");
  say(n("open"), "page opened", "pages opened");
  say(n("read"), "page read", "pages read");
  say(n("act") + n("look"), "action", "actions");
  say(n("save") + n("download"), "item saved", "items saved");
  say(n("consent"), "consent asked", "consents asked");
  say(n("error") + n("blocked"), "refusal", "refusals");
  const blocker = rows.filter(
    (r) => r.kind === "blocker" && !r.detail.startsWith("Content blocking active"),
  ).length;
  say(blocker, "protection warning", "protection warnings");
  return parts.length === 0 ? "Nothing recorded." : parts.join(" · ");
}

/** What a Clear is about to destroy, said out loud.
 *
 * The button's own words were "Erase this record?", and the command behind it
 * empties the room's whole web cache as well — the cached search terms, page
 * text and preview images. A confirmation that understates its deletion is not
 * a confirmation. `null` is a scope the backend would not report: say the
 * larger thing is included rather than guess at a number. */
export function clearWarning(
  scope: { journal: number; searches: number; pages: number; images: number } | null,
): string {
  if (!scope) {
    return "Erase this record and the room's cached pages, searches and previews?";
  }
  const cached = scope.searches + scope.pages + scope.images;
  const entries = `${scope.journal} ${scope.journal === 1 ? "entry" : "entries"}`;
  if (cached === 0) return `Erase ${entries}?`;
  return `Erase ${entries} and ${cached} cached ${cached === 1 ? "item" : "items"} (searches, page text and previews)?`;
}

/** Split the newest-first rows into sittings, apply the chosen facets, and
 *  collapse runs.
 *
 * `chosen` empty means no filter at all rather than nothing at all: an empty
 * filter set is what "show me everything" looks like when the control is a row
 * of toggles, and reading it as "match none" would hand the user a blank panel
 * for the state they reach by turning every filter off. */
export function groupSessions(
  rows: readonly BrowseJournalRow[],
  currentSession: string,
  chosen: readonly JournalFacet[],
): JournalSession[] {
  const order: string[] = [];
  const bySession = new Map<string, BrowseJournalRow[]>();
  for (const row of rows) {
    const id = row.session ?? "";
    let bucket = bySession.get(id);
    if (!bucket) {
      bucket = [];
      bySession.set(id, bucket);
      order.push(id);
    }
    bucket.push(row);
  }

  const wanted = new Set(chosen);
  const keep = (row: BrowseJournalRow) => {
    if (wanted.size === 0) return true;
    const facet = facetOf(row.kind);
    // An unrecognised kind is never filtered out — see FACET_OF.
    return facet === null || wanted.has(facet);
  };

  return order.map((id) => {
    const all = bySession.get(id)!;
    return {
      id,
      // A sitting with no id cannot be the live one even when none is live:
      // it predates sittings being recorded at all.
      current: id !== "" && id === currentSession,
      // COALESCE FIRST, THEN FILTER. The other order collapses two identical
      // rows that a filtered-out row sat between, and prints "×2" for an
      // adjacency the record does not have — a small fabrication in the one
      // artefact whose whole value is being exactly what happened.
      lines: coalesce(all).filter((line) => keep(line.row)),
      summary: summarise(all),
      from: all[all.length - 1]?.at ?? "",
    };
  });
}
