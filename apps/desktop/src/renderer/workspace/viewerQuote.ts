import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { FileContent, ViewerKind } from "../api";
import { frameSelectionOf } from "../viewers/frameSelection";
import { textOf } from "../viewers/htmlText";
import { inExcludedSurface, inQuotableDocument, quotableText, searchableDocument, verifiedFrameQuote, type SearchableDocument } from "./quoteSelection";
import type { WSState } from "./state";

export function useDismissOnEscape(
  open: boolean,
  close: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);
}

/** True when a file name is a runnable script (.py/.js). */
export function isScriptName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".py") || lower.endsWith(".js");
}

/** True when a media transcript carries real speech — at least one timestamped
 * "[m:ss] …" row with words. The "(transcribed from recording)" provenance line
 * and a lone silence "." don't count, so downstream actions (Minutes) don't
 * offer to summarize a recording that has nothing to summarize. */
export function transcriptHasSpeech(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.split("\n").some((line) => {
    const m = line.match(/^\[(?:\d+:)?\d{1,2}:\d{2}\]\s*(.*)$/);
    return m ? /[\p{L}\p{N}]/u.test(m[1]) : false;
  });
}

/** A file's-worth of nothing, so `useTextEncoding` below — a hook, which has
 * to run on every render whether or not a file is open — always has a real
 * `FileContent` to ask rather than needing a nullable signature of its own.
 * `kind: "binary"` is never in `RE_DECODABLE_KINDS`, so with no file open
 * this resolves straight to the hook's idle state. */
export const NO_FILE: FileContent = {
  kind: "binary",
  name: "",
  mime: "",
  editable: false,
  text: null,
  dataB64: null,
  mediaToken: null,
  mediaMeta: null,
  webMeta: null,
};

export type ViewerQuote = { text: string; top: number; left: number };

function selectionCanBeQuoted(selection: Selection): boolean {
  return inQuotableDocument(selection.anchorNode)
    && inQuotableDocument(selection.focusNode)
    && !inExcludedSurface(selection.anchorNode)
    && !inExcludedSurface(selection.focusNode);
}

function quoteSelectionText(selection: Selection, kind: ViewerKind | null, editMode: boolean): string | null {
  return quotableText(selection.toString(), kind, editMode);
}

function quoteSelectionPosition(selection: Selection): { top: number; left: number } | null {
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { top: rect.top, left: rect.left + rect.width / 2 };
}

function activeDocumentSelection(): Selection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  return selection;
}

function readDocumentQuote(kind: ViewerKind | null, editMode: boolean): ViewerQuote | null {
  const selection = activeDocumentSelection();
  if (selection === null) return null;
  if (!selectionCanBeQuoted(selection)) return null;
  const text = quoteSelectionText(selection, kind, editMode);
  if (!text) return null;
  const position = quoteSelectionPosition(selection);
  return position === null ? null : { text, ...position };
}

export function useDocumentQuote(fileId: string | undefined, kind: ViewerKind | null, editMode: boolean) {
  const [quote, setQuote] = useState<ViewerQuote | null>(null);
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      setQuote(readDocumentQuote(kind, editMode));
    };
    const onSelectionChange = () => {
      if (raf) return;
      raf = requestAnimationFrame(read);
    };
    const clear = () => setQuote(null);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [kind, editMode]);
  useEffect(() => setQuote(null), [fileId]);
  return [quote, setQuote] as const;
}

type SearchableCache = { id: string; text: string; doc: SearchableDocument };

function visibleQuoteFrame(source: MessageEventSource | null): HTMLIFrameElement | null {
  const frame = Array.from(document.querySelectorAll("iframe")).find(
    (candidate) => candidate.contentWindow === source,
  );
  if (!frame || frame.hidden || !inQuotableDocument(frame)) return null;
  return frame;
}

function frameSourceText(file: NonNullable<WSState["openFile"]>, shownFor: string | null, shownText: string | null): string {
  return (shownFor === file.id ? shownText : null) ?? file.content.text ?? "";
}

function searchableFrameDocument(cache: MutableRefObject<SearchableCache | null>, fileId: string, source: string): SearchableDocument {
  if (cache.current?.id !== fileId || cache.current.text !== source) {
    cache.current = { id: fileId, text: source, doc: searchableDocument(textOf(source)) };
  }
  return cache.current.doc;
}

function reportedQuoteFrame(event: MessageEvent): { report: NonNullable<ReturnType<typeof frameSelectionOf>>; frame: HTMLIFrameElement } | null {
  const report = frameSelectionOf(event.data);
  if (!report) return null;
  const frame = visibleQuoteFrame(event.source);
  return frame === null ? null : { report, frame };
}

function frameQuoteFromMessage(
  event: MessageEvent,
  file: WSState["openFile"],
  cache: MutableRefObject<SearchableCache | null>,
  shownFor: string | null,
  shownText: string | null,
  editMode: boolean,
): ViewerQuote | null {
  if (!file || file.content.kind !== "html") return null;
  const reported = reportedQuoteFrame(event);
  if (reported === null) return null;
  const text = verifiedFrameQuote(
    reported.report.text,
    searchableFrameDocument(cache, file.id, frameSourceText(file, shownFor, shownText)),
    file.content.kind,
    editMode,
  );
  if (!text || !reported.report.rect) return null;
  const box = reported.frame.getBoundingClientRect();
  return { text, top: box.top + reported.report.rect.top, left: box.left + reported.report.rect.left + reported.report.rect.width / 2 };
}

export function useFrameQuote(
  s: WSState,
  shownFor: string | null,
  shownText: string | null,
  setQuote: Dispatch<SetStateAction<ViewerQuote | null>>,
): void {
  const searchable = useRef<SearchableCache | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      setQuote(frameQuoteFromMessage(event, s.openFileRef.current, searchable, shownFor, shownText, s.editMode));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [s.editMode, shownText, shownFor]);
}

/** WHERE THIS OBJECT SHOWS UP, and the one control that changes it.
 *
 * Drawn only for objects that HAVE a placement to talk about — things made
 * inside a destination. An ordinary Library file returns `null` from
 * `libraryStatus` and gets no chip at all, because "In Library" stamped on
 * every document in the room is noise that makes the real signal invisible.
 *
 * Two states, two different jobs:
 *
 *   • section-only → a button. "Add to Library" is the whole affordance, and
 *     the confirmation says what will happen before it happens, because the
 *     word "Add" invites the reading "make a copy" and this makes none.
 *   • linked → a quiet status with a menu behind it. "View in Library" and
 *     "Remove from Library", where Remove is careful to say that it removes
 *     the Home reference and not the object — deleting is a different verb,
 *     with the trash behind it, and the two must never read as neighbours.
 */
