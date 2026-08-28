import type { ViewerKind } from "../apiTypes";
import { READER_KINDS } from "./ReaderShell";

/**
 * "Quote this in chat" — turning the most natural pointing gesture a person
 * has (selecting text) into something the room can act on.
 *
 * The decision of WHETHER a selection may be quoted is pure and lives here, so
 * it can be argued with in a test rather than discovered by clicking through
 * thirty viewer kinds. The rendering half is in ViewerPane.
 */

/** Selections shorter than this are a click that slipped, not a gesture. */
const MIN_QUOTE_CHARS = 2;

/** Long enough to carry a paragraph, short enough that the composer still
 * shows the user's own words. A longer passage is cut with an ellipsis rather
 * than refused: the model gets the beginning, which is what "look at this bit"
 * usually means. */
export const MAX_QUOTE_CHARS = 1200;

/**
 * Surfaces where a selection is NOT an invitation to quote.
 *
 * Editors own their selection (it is what typing acts on), and RecordingView
 * owns its own with a documented freeze rule — a second reader of the same
 * selection would fight both. Anything inside a consent surface is off-limits
 * for the same reason the agent cannot see it.
 *
 * The last two are a reader's OWN chrome. `.viewer-body` is the containment
 * anchor because it is the scroll region, and the page, book and legacy-Word
 * readers draw their toolbar inside it — the book its contents list too. So
 * containment alone would read a chapter title in the table of contents, or
 * the word "Page" on a mode button, as a passage of the document and offer to
 * quote it under the document's name. Navigation is not prose.
 */
export const EXCLUDED_SELECTOR = [
  "[contenteditable]:not([contenteditable='false'])",
  ".monaco-editor",
  "input",
  "textarea",
  ".rec-transcript",
  "[data-agent-blocked]",
  ".rdr-bar",
  ".book-toc",
].join(", ");

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

/** Is this element inside something that owns its own selection? */
export function inExcludedSurface(node: Node | null): boolean {
  const el = elementOf(node);
  return el != null && el.closest(EXCLUDED_SELECTOR) != null;
}

/**
 * Is this node inside the document the quote would be ATTRIBUTED to?
 *
 * The other half of the rule, and the important half. Excluding editors is not
 * enough: `selectionchange` is a document-wide event, so without a positive
 * containment test a sentence highlighted in the assistant's own answer — or in
 * the Library, or on Home — was offered as a quote and stamped "— lease.pdf".
 * That is a fabricated citation, in an app whose annotation path goes to some
 * length to mark a quote it could not verify.
 *
 * `.viewer-body` is the right anchor rather than the whole viewer section: it
 * wraps exactly the rendered document, so the breadcrumb and the header
 * controls are outside it too.
 */
export function inQuotableDocument(node: Node | null): boolean {
  return elementOf(node)?.closest(".viewer-body") != null;
}

/**
 * Formats whose words may be quoted.
 *
 * Deliberately NOT `READER_KINDS`, which this rule used to borrow. That set
 * answers a different question — which viewers scroll `.viewer-body` itself,
 * so the reading-progress stroke has something to measure — and the three
 * formats it leaves out are left out for that reason alone: each draws its
 * prose inside its own frame. Borrowing it withheld the quote button from a
 * saved web page, an e-book and a legacy Word document, which are not marginal
 * formats but three of the things people most want to quote.
 *
 * Everything absent from here is absent on its own merits: a drawing, a
 * spreadsheet, a video and a live recording have selections that mean
 * something else, and a quote button over them would fight affordances those
 * surfaces already have.
 */
const QUOTABLE_KINDS: ReadonlySet<ViewerKind> = new Set<ViewerKind>([
  ...READER_KINDS,
  "html",
  "book",
  "worddoc",
]);

/** Whitespace is layout, not content: a passage selected across a line break
 * and the same passage in the file differ only by it. */
function flatten(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The text this selection would contribute, or null when it is not a quote.
 */
export function quotableText(
  raw: string,
  kind: ViewerKind | null,
  editing: boolean,
): string | null {
  if (editing || kind == null || !QUOTABLE_KINDS.has(kind)) return null;
  const text = flatten(raw);
  if (text.length < MIN_QUOTE_CHARS) return null;
  return text.length > MAX_QUOTE_CHARS
    ? `${text.slice(0, MAX_QUOTE_CHARS - 1)}…`
    : text;
}

/**
 * The selection a sandboxed frame REPORTED, once the app has checked the claim.
 *
 * The Page tab runs the document's own script, so a selection arriving from it
 * is a claim rather than an observation: nothing stops a hostile page from
 * announcing a sentence it does not contain and having the room quote that
 * sentence under the page's own name. That is precisely the fabricated
 * citation this path exists to prevent, so the claim is checked against the
 * copy of the document the app already holds before it is ever offered.
 *
 * The check is containment, not equality — the frame reports the user's
 * selection, which is a fragment of the document, and whitespace differs
 * between a rendered page and its extracted text.
 */
export function verifiedFrameQuote(
  reported: string,
  doc: SearchableDocument,
  kind: ViewerKind | null,
  editing: boolean,
): string | null {
  const quote = quotableText(reported, kind, editing);
  if (!quote) return null;
  // An over-long selection was cut with an ellipsis that is ours, not the
  // document's, and would never be found in it.
  const needle = flatten(quote.replace(/…$/, "")).toLowerCase();
  if (!needle) return null;
  return doc.flattened.includes(needle) ? quote : null;
}

/**
 * A document prepared once for repeated containment checks.
 *
 * A nominal type rather than a bare string, because the difference matters and
 * is invisible: `selectionchange` fires continuously while a drag is in
 * progress, so flattening and lower-casing the whole document per event copies
 * it twice per frame. Passing the raw text would still compile and still
 * mostly work — it would just be slow, and quietly wrong on any document whose
 * case or spacing differs from the selection. The type makes that unsayable.
 */
export interface SearchableDocument {
  readonly flattened: string;
}

export function searchableDocument(documentText: string): SearchableDocument {
  return { flattened: flatten(documentText).toLowerCase() };
}

/**
 * The composer's next value once this quote is added.
 *
 * APPENDS. Replacing would silently destroy a draft the user is part-way
 * through — and the whole point of the gesture is to add what they are
 * pointing at to what they were already saying.
 */
export function withQuote(draft: string, quote: string, fileName: string): string {
  const block = `> ${quote}\n— ${fileName}\n\n`;
  const base = draft.trimEnd();
  return base ? `${base}\n\n${block}` : block;
}
