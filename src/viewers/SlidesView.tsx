import { useEffect, useMemo, useRef, useState } from "react";
import { unzip } from "fflate";
import { api } from "../api";
import { Deck, parsePptx } from "./pptx";
import { useFileBytes } from "./useFileBytes";
import "./slides.css";

/**
 * A PowerPoint deck, drawn by macOS.
 *
 * THE FIRST ATTEMPT AT THIS rendered the OOXML by hand — text runs and pictures
 * positioned from their EMU coordinates. It was not close. A deck's design is
 * its slide background, its master's placeholder type scale, its theme colours
 * and its shape fills, and none of that is in the parts a text-and-pictures
 * renderer reads: a title slide whose real look is 130pt serif over a
 * mint-green band came out as two lines of 18px text on white.
 *
 * So the picture comes from Quick Look, the same renderer Finder uses, at full
 * fidelity. Quick Look draws page ONE of a document and offers no way to ask
 * for another — so for slide N the backend hands it a copy of the deck whose
 * `<p:sldIdLst>` puts slide N first. Everything else in the file is untouched,
 * so every layout, master, theme and image is exactly where it was.
 *
 * The OOXML parse stays, doing what it is actually good at: slide titles for
 * the rail, speaker notes, and the text that lets an AI citation land on the
 * right slide. Pictures for the eye, text for the machine.
 */
export default function SlidesView({
  fileId,
  mediaToken,
  dataB64,
  target,
}: {
  fileId: string;
  mediaToken?: string | null;
  dataB64?: string | null;
  target?: { quote?: string };
}) {
  const { bytes, error: readError, loading } = useFileBytes(mediaToken, dataB64);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [parseError, setParseError] = useState("");
  const [at, setAt] = useState(0);
  const [showNotes, setShowNotes] = useState(false);

  // Rendered slides, kept per index so paging back is instant. The backend
  // caches too; this avoids even the IPC round trip.
  const [images, setImages] = useState<Record<number, string>>({});
  const [slideCount, setSlideCount] = useState(0);
  const [renderError, setRenderError] = useState("");
  const [rendering, setRendering] = useState(false);
  const wanted = useRef(0);

  // ---- text side: outline, notes, and citation targeting -----------------
  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    setParseError("");
    unzip(bytes, (err, files) => {
      if (!alive) return;
      if (err) {
        // A zip-parse failure is a verdict on the OUTLINE, not on the deck: a
        // legacy .ppt is not a zip at all, and macOS draws it perfectly well.
        // Announcing it as unreadable said so for the whole render, and for
        // ever on a Mac where the render fails — hiding the accurate message
        // written for exactly that case.
        setParseError(err.message);
        return;
      }
      try {
        const parsed = parsePptx(files);
        setDeck(parsed);
        if (parsed.slides.length) setSlideCount((n) => n || parsed.slides.length);
      } catch {
        // A parse failure costs the outline and the notes, not the deck: the
        // pictures come from macOS and do not depend on this at all.
        setParseError("");
      }
    });
    return () => {
      alive = false;
    };
  }, [bytes]);

  // ---- picture side: ask macOS for the current slide ---------------------
  useEffect(() => {
    let alive = true;
    wanted.current = at;
    if (images[at]) return;
    setRendering(true);
    setRenderError("");
    api
      .slidePreview(fileId, at)
      .then((img) => {
        if (!alive) return;
        setRendering(false);
        if (!img) {
          setRenderError("This Mac could not draw this slide.");
          return;
        }
        setSlideCount(img.slides);
        setImages((prev) => ({ ...prev, [at]: img.pngB64 }));
      })
      .catch((e) => {
        if (!alive) return;
        setRendering(false);
        setRenderError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [fileId, at, images]);

  // Quietly fetch the next slide so Next is instant.
  useEffect(() => {
    const next = at + 1;
    if (next >= slideCount || images[next]) return;
    const t = window.setTimeout(() => {
      void api
        .slidePreview(fileId, next)
        .then((img) => {
          if (img) setImages((prev) => ({ ...prev, [next]: img.pngB64 }));
        })
        .catch(() => {});
    }, 350);
    return () => window.clearTimeout(t);
  }, [fileId, at, slideCount, images]);

  // An AI quote lands on the slide that contains it, rather than on slide 1.
  const quote = target?.quote;
  useEffect(() => {
    if (!deck || !quote) return;
    const needle = quote.toLowerCase().replace(/\s+/g, " ").trim();
    if (!needle) return;
    const hit = deck.slides.find((s) =>
      s.text.toLowerCase().replace(/\s+/g, " ").includes(needle),
    );
    // Its own number, not where it sits in the array — a dropped slide part
    // ahead of it would land the citation one slide short.
    if (hit) setAt(Math.max(0, hit.number - 1));
  }, [deck, quote]);

  // Keyed by the slide's OWN number, never by its position in the array. A
  // slide part that fails to parse is dropped, and reading the rest by index
  // then showed slide 8's title and speaker notes beside the picture of slide
  // 7, all the way to the end of the deck. A gap now stays a gap.
  const byNumber = useMemo(
    () => new Map((deck?.slides ?? []).map((s) => [s.number, s])),
    [deck],
  );
  const outline = useMemo(
    () =>
      Array.from({ length: slideCount }, (_, i) => ({
        number: i + 1,
        title:
          byNumber.get(i + 1)?.text.split("\n").find((l) => l.trim()) ??
          `Slide ${i + 1}`,
      })),
    [byNumber, slideCount],
  );
  const notes = byNumber.get(at + 1)?.notes ?? "";

  if (loading) return <div className="empty-hint">Opening presentation…</div>;
  if (readError) return <div className="empty-hint">{readError}</div>;
  if (!slideCount && renderError) {
    return (
      <div className="empty-hint">
        This presentation could not be drawn ({renderError}). Its text is still
        stored and searchable, and <strong>Export</strong> saves the original out
        unchanged.
      </div>
    );
  }
  // The terminal branch: the read, the parse and the render have all been
  // ruled out and there is still no slide. It used to say "Reading slides…"
  // whether or not anything was running, so a deck that resolves to zero
  // slides looked permanently busy instead of permanently unreadable —
  // and the reader waited rather than reaching for Export.
  if (!slideCount)
    return rendering ? (
      <div className="empty-hint">Opening presentation…</div>
    ) : (
      <div className="empty-hint">
        No slides were found in this presentation. Its text is still stored and
        searchable, and <strong>Export</strong> saves the original out
        unchanged.
      </div>
    );

  const last = slideCount - 1;
  const current = images[at];

  return (
    <div className="sl-view">
      <div className="sl-bar">
        <button className="nb-btn" disabled={at <= 0} onClick={() => setAt((n) => Math.max(0, n - 1))}>
          ‹ Previous
        </button>
        {/* "Slide 3 of 12" is a count pencilled beside the deck — see
            `.sl-where`. The class is additive, so the status keeps whatever
            `.viewer-status` gives it. */}
        <span className="viewer-status sl-where">
          Slide {at + 1} of {slideCount}
        </span>
        <button
          className="nb-btn"
          disabled={at >= last}
          onClick={() => setAt((n) => Math.min(last, n + 1))}
        >
          Next ›
        </button>
        {notes && (
          <button
            className="nb-btn"
            aria-pressed={showNotes}
            onClick={() => setShowNotes((s) => !s)}
          >
            {showNotes ? "Hide notes" : "Speaker notes"}
          </button>
        )}
        {/* Said where the missing thing is missing from, not over the deck:
            the slides are drawn either way, but their titles and notes are not
            available to read. */}
        {parseError && (
          <span className="viewer-status">
            No slide titles or notes ({parseError})
          </span>
        )}
      </div>
      <div className="sl-stage">
        {current ? (
          <img
            className="sl-image"
            src={`data:image/png;base64,${current}`}
            alt={outline[at]?.title ?? `Slide ${at + 1}`}
          />
        ) : (
          /* This had a ternary with the same string in both branches, so it
             looked like it told two states apart and did not. There is only
             one to tell: a slide with no picture and no error always has a
             render in flight, or one the effect issues in this same tick —
             every other outcome sets `renderError`. */
          <div className="empty-hint">{renderError || "Drawing slide…"}</div>
        )}
      </div>
      {showNotes && notes && (
        <div className="sl-notes" dir="auto">
          {notes}
        </div>
      )}
      {/* A plain nav with aria-current, not a tablist: a tablist promises
          arrow-key roving and a tabpanel, and this rail has neither. Same
          choice, for the same reason, as the sheet tabs in SheetView. */}
      <nav className="sl-rail" aria-label="Slides">
        {outline.map((o, i) => (
          <button
            key={o.number}
            aria-current={i === at ? "true" : undefined}
            className={`sl-thumb${i === at ? " active" : ""}`}
            onClick={() => setAt(i)}
            title={o.title}
          >
            <span className="sl-thumb-n">{o.number}</span>
            <span className="sl-thumb-t">{o.title}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
