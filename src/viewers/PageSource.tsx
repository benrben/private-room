import type { PageMeta } from "../apiTypes";
import "./pagesource.css";

/**
 * The provenance strip above a saved web page: where it came from, who the page
 * said wrote it, and when it was published and saved.
 *
 * The whole point is that it shows ONLY what the page declared. There is no
 * "Author: unknown" row and no "Published: —": a page that named nobody simply
 * has no author line, because a row that says "unknown" reads as "we looked it
 * up and the answer is unknown", which is a different (and unearned) claim. If
 * the page declared nothing at all and the room has no source URL either, the
 * strip does not render.
 *
 * Nothing here is fetched. The fields come from `files.web_meta`, written once
 * at save time from the page's own `<meta>`/JSON-LD.
 */

/** One row of the strip: a label and the page's own words. */
export interface SourceFact {
  label: string;
  value: string;
  /** A link target when the value is an address. */
  href?: string;
}

/** The facts a saved page actually declared, in reading order. Pure, so the
 * "absent means absent" rule is testable without a DOM. */
export function sourceFacts(meta: PageMeta | null): SourceFact[] {
  if (!meta) return [];
  const out: SourceFact[] = [];
  const push = (label: string, value: string | undefined, href?: string) => {
    const v = value?.trim();
    if (v) out.push(href ? { label, value: v, href } : { label, value: v });
  };
  push("Site", meta.siteName);
  push("Author", meta.byline);
  push("Published", formatDate(meta.published));
  push("Updated", formatDate(meta.modified));
  push("Source", meta.sourceUrl, meta.sourceUrl);
  push("Saved", formatDate(meta.capturedAt));
  return out;
}

/**
 * An ISO timestamp as a plain date — but ONLY when it really parses as one.
 * Pages declare all sorts of things in `article:published_time`, and a string
 * this can't read is shown exactly as the page wrote it rather than turned into
 * "Invalid Date" or silently dropped.
 */
function formatDate(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function PageSource({ meta }: { meta: PageMeta | null }) {
  const facts = sourceFacts(meta);
  if (facts.length === 0) return null;
  return (
    <div className="page-source" role="note" aria-label="Where this page came from">
      {facts.map((f) => (
        <span className="page-source-fact" key={f.label}>
          <span className="page-source-label">{f.label}</span>
          {f.href ? (
            // Not a live link: the viewer has no network and this is a record
            // of an address, not a way to go there. Selectable so it can be
            // copied.
            <span className="page-source-url" title={f.href}>
              {f.value}
            </span>
          ) : (
            <span>{f.value}</span>
          )}
        </span>
      ))}
    </div>
  );
}
