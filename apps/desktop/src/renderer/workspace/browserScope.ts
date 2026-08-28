import type { BrowserPageSignal } from "./browserSignal";
import type { WorkArea } from "./types";

/**
 * WHAT A CHAT TURN IS ANSWERED FROM, decided from plain data.
 *
 * The strip above the chat knew exactly one thing — how many files were on the
 * paperclip — and said "the whole room" for everything else. In the private
 * browser that sentence was false in both directions at once: the room had
 * never read the page on screen, and the page contributed nothing to the turn,
 * so "the whole room" described neither what was searched nor what the reader
 * was looking at.
 *
 * The rule lives here, pure and away from React, because three surfaces have to
 * agree about it and they are three levels apart: the strip that STATES the
 * scope, the composer placeholder that echoes it, and the send that has to make
 * it true. One of them drifting is not a rendering bug — it is the app claiming
 * to have read something it did not.
 */

/** What a turn can be answered from. `room` is the behaviour that predates
 * this module and stays exactly as it was; `page`/`selection` belong to the
 * private browser, `sketch`/`objects` to the open drawing. */
export type BrowserScope = "page" | "selection" | "sketch" | "objects" | "room";

/** A page worth offering as a scope: one whose text a turn could actually be
 * given. */
export interface OpenPage {
  readonly url: string;
  readonly title: string;
  /** A passage is highlighted on it right now, so a "selected passage" scope
   *  has something to read. Reported by the chrome's own poll — never guessed
   *  here, for the same reason `readable` is not. */
  readonly hasSelection: boolean;
}

/**
 * The page a scope may be offered for, or null when there is nothing a question
 * could be answered from.
 *
 * WHETHER IT CAN BE READ IS THE PUBLISHER'S ANSWER, never reconstructed here.
 * `BrowserView` parks the native view at 1×1 behind the results list, the start
 * screen and the reading view, and Rust refuses to extract text from a parked
 * page — but which of those is up lives in that component's React state, so at
 * this distance an unreadable page is indistinguishable from a readable one.
 * Guessing cost the user a question: press "Read as text", ask about what is on
 * the screen, and the strip promised the page while the send stalled in the
 * settle loop and came back "close whatever is covering the browser".
 *
 * Unreadable is therefore the same answer as absent — the room scope, stated as
 * the room scope, rather than a page nothing can deliver.
 */
export function readablePage(signal: BrowserPageSignal | null): OpenPage | null {
  if (!signal || !signal.readable) return null;
  return {
    url: signal.url,
    title: signal.title,
    hasSelection: signal.hasSelection,
  };
}

/** A drawing worth offering as a scope: the room file it is, and what it has
 * selected right now. */
export interface OpenSketch {
  readonly fileId: string;
  /** The drawing's name as the room shows it, for the control's own words. */
  readonly name: string;
  /** One line per selected object — see workspace/sketchFocus. */
  readonly selection: readonly string[];
}

/** Everything the rule reads. Plain values, so the whole decision is arguable
 * in a test rather than only reachable by clicking. */
export interface ScopeSubject {
  readonly area: WorkArea;
  readonly page: OpenPage | null;
  /** Whether a passage of the page is selected. Always false today — see
   * PAGE_TEXT_MODE in chatActions for the missing half. */
  readonly hasSelection: boolean;
  /** The drawing on screen, or null when there is none. */
  readonly sketch: OpenSketch | null;
  readonly attachments: number;
}

export interface ChatScope {
  /** What the control offers, in the order it lists them. The first is the
   * default, so ordering is the rule rather than a second constant. */
  readonly available: readonly BrowserScope[];
  /** The one in force: the user's pick while it is still offered, else the
   * default. */
  readonly scope: BrowserScope;
  /** The control's own words — "Answering from " + this. */
  readonly label: string;
  readonly placeholder: string;
  /** Does this scope put the page's text into the turn? */
  readonly sendsPageText: boolean;
  /** Room files this scope answers from, on top of whatever is attached.
   * Empty for every scope that carries its evidence as text instead. */
  readonly fileIds: readonly string[];
  /** Text the scope itself puts in front of the question, or "". Unlike the
   * page, a drawing's selection is already known here — there is nothing to go
   * and fetch — so it is built now rather than at send. */
  readonly preamble: string;
}

/** Unchanged from before this module existed, and it has to stay that way:
 * everywhere outside the browser the composer must say what it always said. */
const ROOM_PLACEHOLDER = "Ask anything about this room…";

/**
 * Which scopes this moment offers.
 *
 * A selection ADDS a third option, second in the list — it never takes the
 * default, because selecting a sentence to check one detail is not a statement
 * that the rest of the page has stopped mattering.
 */
export function offeredScopes(subject: ScopeSubject): BrowserScope[] {
  if (subject.area === "browser") {
    if (subject.page === null) return ["room"];
    return subject.hasSelection ? ["page", "selection", "room"] : ["page", "room"];
  }
  // A drawing follows the same shape for the same reason: the whole thing is
  // the default, and selecting part of it offers a narrower scope without
  // taking the default away.
  if (subject.sketch) {
    return subject.sketch.selection.length
      ? ["sketch", "objects", "room"]
      : ["sketch", "room"];
  }
  return ["room"];
}

/** The control's words for one scope. Attached files still beat the room, and
 * are still counted the way they always were. */
export function scopeLabel(scope: BrowserScope, subject: ScopeSubject): string {
  if (scope === "page") return "this page";
  if (scope === "selection") return "the selected passage";
  if (scope === "sketch") {
    // Named, because "this drawing" beside a Sketches list of nine is not an
    // answer to which one. Attachments are not dropped by picking a drawing,
    // so they are not hidden either.
    const named = subject.sketch ? `“${subject.sketch.name}”` : "this drawing";
    return subject.attachments === 0
      ? named
      : `${named} + ${subject.attachments} attached`;
  }
  if (scope === "objects") {
    const n = subject.sketch?.selection.length ?? 0;
    return n === 1 ? "the selected object" : `the ${n} selected objects`;
  }
  if (subject.attachments === 0) return "the whole room";
  return `${subject.attachments} attached source${subject.attachments === 1 ? "" : "s"}`;
}

function placeholderOf(scope: BrowserScope, subject: ScopeSubject): string {
  if (scope === "page") return "Ask about this page…";
  if (scope === "selection") return "Ask about the selected passage…";
  if (scope === "sketch") {
    return subject.sketch
      ? `Ask about “${subject.sketch.name}”…`
      : "Ask about this drawing…";
  }
  if (scope === "objects") return "Ask about what you have selected…";
  return ROOM_PLACEHOLDER;
}

/**
 * The selected objects, written out for the turn.
 *
 * The room's index holds a drawing's words, not which of them are selected —
 * so unlike the whole drawing, this cannot be carried by attaching the file.
 * It is the SAME sentences the object strip shows, and it is the same string
 * the transcript stores: the room keeps what was sent, so a turn that sent
 * more than it displayed would rewrite the user's own message on reload.
 */
export function selectedObjectsBlock(sketch: OpenSketch): string {
  const list = sketch.selection.map((line) => `- ${line}`).join("\n");
  return `Selected on the drawing “${sketch.name}”:\n${list}`;
}

/** The question with a scope's own block in front of it. Same shape as
 * `withPageContext`, and the same rule: what is sent is what is shown. */
export function withPreamble(question: string, preamble: string): string {
  return preamble ? `${preamble}\n\n${question}` : question;
}

/**
 * The whole state of the strip, for a moment and a pick.
 *
 * `chosen` is DROPPED rather than carried when the moment stops offering it:
 * walking out of the browser with "this page" selected must leave the strip
 * saying precisely what it said before, and a scope kept alive past the page it
 * named would send the turn looking for text that is no longer on screen.
 */
export function chatScope(
  subject: ScopeSubject,
  chosen: BrowserScope | null,
): ChatScope {
  const available = offeredScopes(subject);
  const scope = chosen && available.includes(chosen) ? chosen : available[0];
  return {
    available,
    scope,
    label: scopeLabel(scope, subject),
    placeholder: placeholderOf(scope, subject),
    sendsPageText: scope === "page" || scope === "selection",
    fileIds: scope === "sketch" && subject.sketch ? [subject.sketch.fileId] : [],
    preamble:
      scope === "objects" && subject.sketch ? selectedObjectsBlock(subject.sketch) : "",
  };
}

/** What the strip and the composer say when there is no browser and no drawing
 * in the picture — the value the store rests at while nothing states a scope. */
export const ROOM_ONLY: ChatScope = chatScope(
  { area: "home", page: null, hasSelection: false, sketch: null, attachments: 0 },
  null,
);

/**
 * How much of a page one turn may carry.
 *
 * Larger than a quote (quoteSelection's 1200 is a paragraph someone pointed at)
 * and far smaller than a page: the room's own engine is a 4B model whose
 * context is fitted to the payload, and an article dropped whole into it pushes
 * the conversation out the other end. What does not fit is SAID, never dropped
 * quietly — see `withPageContext`.
 */
export const MAX_PAGE_CHARS = 8000;

/** A page prepared for one turn: the text exactly as it will be sent, and how
 * much of the page that text is not. */
export interface PageContext {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  /** Characters the page has that this block does not carry. 0 when whole. */
  readonly omitted: number;
}

/**
 * The extractor's answer, cut to what a turn may carry — or null when there was
 * nothing to carry.
 *
 * Null is the honest answer for a page that returned no words (a PDF, a canvas,
 * a video). The caller reports it; it must never become a whole-room answer,
 * which is the one outcome the user would have no way to notice.
 */
export function pageContext(got: {
  title?: string;
  url?: string;
  text?: string;
  total?: number;
}): PageContext | null {
  const text = (got.text ?? "").trim();
  if (!text) return null;
  const kept = text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
  // The page script cuts long documents too, and reports the whole document's
  // length in `total`. Its shortfall and ours are the same thing to a reader —
  // page they were told about and did not get — so they are counted together
  // rather than reported as two separate cuts.
  const whole = Math.max(got.total ?? 0, text.length);
  return {
    title: (got.title ?? "").trim(),
    url: (got.url ?? "").trim(),
    text: kept,
    omitted: Math.max(0, whole - kept.length),
  };
}

/**
 * The question with the page in front of it.
 *
 * Same idea as `withQuote`, automated: the passage is marked off, attributed to
 * the page it came from, and it is the SAME string the transcript shows — the
 * room stores what is sent, so a turn that sent more than it displayed would
 * rewrite the user's own message the moment the chat reloaded.
 */
/** The same block, for a passage a PERSON highlighted rather than the page.
 *
 * Its own preamble, not a parameter on the one below: "the page open in the
 * private browser, as text" describes something the user did not ask about, and
 * a model reading it would answer about the article when the question was about
 * the sentence. */
export function withSelectionContext(
  question: string,
  passage: PageContext,
): string {
  const where = [passage.title, passage.url].filter((s) => s !== "").join(" \u2014 ");
  const cut =
    passage.omitted > 0
      ? `\nOnly the first ${passage.text.length.toLocaleString()} characters of the selection are below; ` +
        `${passage.omitted.toLocaleString()} more are not.`
      : "";
  return `The passage selected in the private browser:\n${where}${cut}\n\n"""\n${passage.text}\n"""\n\n${question}`;
}

export function withPageContext(question: string, page: PageContext): string {
  const where = [page.title, page.url].filter((s) => s !== "").join(" — ");
  const cut =
    page.omitted > 0
      ? `\nOnly the first ${page.text.length.toLocaleString()} characters are below; ` +
        `${page.omitted.toLocaleString()} more of the page are not.`
      : "";
  return `The page open in the private browser, as text:\n${where}${cut}\n\n"""\n${page.text}\n"""\n\n${question}`;
}
