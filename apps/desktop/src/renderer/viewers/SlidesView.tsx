import { useEffect, useMemo, useState } from "react";
import { unzip } from "fflate";
import { api } from "../api";
import { parsePptx, type Deck } from "./pptx";
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
  const {
    bytes,
    error: readError,
    loading,
  } = useFileBytes(mediaToken, dataB64);
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
        if (parsed.slides.length)
          setSlideCount((n) => n || parsed.slides.length);
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
          byNumber
            .get(i + 1)
            ?.text.split("\n")
            .find((l) => l.trim()) ?? `Slide ${i + 1}`,
      })),
    [byNumber, slideCount],
  );
  const notes = byNumber.get(at + 1)?.notes ?? "";

  const empty = emptySlides(
    loading,
    readError,
    slideCount,
    renderError,
    rendering,
  );
  if (empty) return empty;
  return (
    <SlidesBody
      at={at}
      images={images}
      notes={notes}
      outline={outline}
      parseError={parseError}
      renderError={renderError}
      setAt={setAt}
      setShowNotes={setShowNotes}
      showNotes={showNotes}
      slideCount={slideCount}
    />
  );
}

function emptySlides(
  loading: boolean,
  readError: string,
  slideCount: number,
  renderError: string,
  rendering: boolean,
) {
  if (loading) return <div className="empty-hint">Opening presentation…</div>;
  if (readError) return <div className="empty-hint">{readError}</div>;
  if (slideCount) return null;
  if (renderError)
    return (
      <div className="empty-hint">
        This presentation could not be drawn ({renderError}). Its text is still
        stored and searchable, and <strong>Export</strong> saves the original
        out unchanged.
      </div>
    );
  if (rendering) return <div className="empty-hint">Opening presentation…</div>;
  return (
    <div className="empty-hint">
      No slides were found in this presentation. Its text is still stored and
      searchable, and <strong>Export</strong> saves the original out unchanged.
    </div>
  );
}

type Outline = { number: number; title: string };
type SlidesBodyProps = {
  at: number;
  images: Record<number, string>;
  notes: string;
  outline: Outline[];
  parseError: string;
  renderError: string;
  setAt: (value: number | ((value: number) => number)) => void;
  setShowNotes: (value: boolean | ((value: boolean) => boolean)) => void;
  showNotes: boolean;
  slideCount: number;
};

function SlidesBody({
  at,
  images,
  notes,
  outline,
  parseError,
  renderError,
  setAt,
  setShowNotes,
  showNotes,
  slideCount,
}: SlidesBodyProps) {
  const last = slideCount - 1;
  return (
    <div className="sl-view">
      <SlideToolbar
        at={at}
        last={last}
        notes={notes}
        parseError={parseError}
        setAt={setAt}
        setShowNotes={setShowNotes}
        showNotes={showNotes}
        slideCount={slideCount}
      />
      <SlideStage
        at={at}
        current={images[at]}
        outline={outline}
        renderError={renderError}
      />
      <SlideNotes notes={notes} show={showNotes} />
      <SlideRail at={at} outline={outline} setAt={setAt} />
    </div>
  );
}

function SlideToolbar({
  at,
  last,
  notes,
  parseError,
  setAt,
  setShowNotes,
  showNotes,
  slideCount,
}: Omit<SlidesBodyProps, "images" | "outline" | "renderError"> & {
  last: number;
}) {
  return (
    <div className="sl-bar">
      <button
        className="nb-btn"
        disabled={at <= 0}
        onClick={() => setAt((n) => Math.max(0, n - 1))}
      >
        ‹ Previous
      </button>
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
          onClick={() => setShowNotes((shown) => !shown)}
        >
          {showNotes ? "Hide notes" : "Speaker notes"}
        </button>
      )}
      {parseError && (
        <span className="viewer-status">
          No slide titles or notes ({parseError})
        </span>
      )}
    </div>
  );
}

function SlideStage({
  at,
  current,
  outline,
  renderError,
}: {
  at: number;
  current?: string;
  outline: Outline[];
  renderError: string;
}) {
  if (!current)
    return (
      <div className="sl-stage">
        <div className="empty-hint">{renderError || "Drawing slide…"}</div>
      </div>
    );
  return (
    <div className="sl-stage">
      <img
        className="sl-image"
        src={`data:image/png;base64,${current}`}
        alt={outline[at]?.title ?? `Slide ${at + 1}`}
      />
    </div>
  );
}

function SlideNotes({ notes, show }: { notes: string; show: boolean }) {
  if (!show || !notes) return null;
  return (
    <div className="sl-notes" dir="auto">
      {notes}
    </div>
  );
}

function SlideRail({
  at,
  outline,
  setAt,
}: {
  at: number;
  outline: Outline[];
  setAt: SlidesBodyProps["setAt"];
}) {
  return (
    <nav className="sl-rail" aria-label="Slides">
      {outline.map((slide, index) => (
        <button
          key={slide.number}
          aria-current={index === at ? "true" : undefined}
          className={`sl-thumb${index === at ? " active" : ""}`}
          onClick={() => setAt(index)}
          title={slide.title}
        >
          <span className="sl-thumb-n">{slide.number}</span>
          <span className="sl-thumb-t">{slide.title}</span>
        </button>
      ))}
    </nav>
  );
}
