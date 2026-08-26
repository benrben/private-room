import { useEffect, useRef, useState } from "react";
import { listen } from "../platform";
import { api, ImageBox, recommendedModels } from "../api";
import { BOX_COLORS, ocrBody } from "./util";
import { fileUrl } from "./useFileBytes";

interface Props {
  fileId: string;
  name: string;
  mime: string;
  /** Streaming token for the picture's bytes (roommedia://). */
  mediaToken?: string | null;
  /** Legacy base64 payload — honoured if byte delivery is ever switched back. */
  dataB64?: string | null;
  /** Whatever OCR read off this picture, as stored on the file. */
  text?: string | null;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export default function ImageView({ fileId, name, mime, mediaToken, dataB64, text }: Props) {
  const ocrText = ocrBody(text);
  // Streamed over the room's own URI scheme rather than inlined as base64.
  // The old data URL was 4/3 the size of the picture and had to cross IPC as
  // one string, which is why anything over 50 MB lost the image viewer
  // entirely and opened as its OCR text. A 60 MB TIFF scan is just a picture.
  const src = dataB64 ? `data:${mime};base64,${dataB64}` : fileUrl(mediaToken);
  const imgRef = useRef<HTMLImageElement>(null);
  const [query, setQuery] = useState("");
  const [boxes, setBoxes] = useState<ImageBox[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // An image the engine can't decode (empty, truncated, wrong extension) used
  // to show only a broken-image glyph, with the zoom buttons and the "mark
  // something" bar still live over nothing at all.
  const [imgDead, setImgDead] = useState(!dataB64 && !mediaToken);

  // Zoom: "fit" scales to the pane (the default); a number is a fraction of
  // the image's natural size. The AI boxes are %-positioned, so they ride
  // along with any zoom for free.
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [natW, setNatW] = useState(0);
  const effectiveZoom = () => {
    if (zoom !== "fit") return zoom;
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return 1;
    return img.clientWidth / img.naturalWidth;
  };
  const clampZoom = (z: number) =>
    Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 20) / 20));
  const zoomBy = (d: number) => setZoom(clampZoom(effectiveZoom() + d));

  // Drag to pan. Zooming in was possible before this; MOVING around the
  // zoomed picture was not, short of hunting for the scrollbars — which on a
  // trackpad Mac are hidden until you are already scrolling.
  const scrollRef = useRef<HTMLDivElement>(null);
  const panning = useRef(false);
  const panFrom = useRef({ x: 0, y: 0, left: 0, top: 0 });
  function onPanStart(e: React.PointerEvent<HTMLDivElement>) {
    const el = scrollRef.current;
    // Only drag the picture itself — not the marker labels drawn over it.
    if (!el || zoom === "fit" || (e.target as HTMLElement).closest(".img-box")) return;
    panning.current = true;
    panFrom.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  }
  function onPanMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = scrollRef.current;
    if (!panning.current || !el) return;
    el.scrollLeft = panFrom.current.left - (e.clientX - panFrom.current.x);
    el.scrollTop = panFrom.current.top - (e.clientY - panFrom.current.y);
  }
  function onPanEnd(e: React.PointerEvent<HTMLDivElement>) {
    panning.current = false;
    scrollRef.current?.releasePointerCapture?.(e.pointerId);
  }

  // The recommended vision model, set only when it's worth offering to
  // download it (Ollama is up but nothing installed can mark images).
  const [visionModel, setVisionModel] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullStatus, setPullStatus] = useState("");
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullErr, setPullErr] = useState("");
  const [pullDone, setPullDone] = useState(false);

  useEffect(() => {
    setImgDead(!src);
  }, [src]);

  // ---- decide whether to offer the vision helper (doesn't block the bar) ----
  // ASK THE BACKEND, don't re-derive. This used to scan the local Ollama list
  // for a name match against the recommended helper — so a room already running
  // a vision-capable cloud model (or a local one with an unfamiliar name) was
  // shown a Download button for a model it had no use for, permanently, under
  // every picture. `groundingModelForRoom` is the same pick the marking call
  // makes, so the offer appears only when marking genuinely cannot happen.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const picked = await api.groundingModelForRoom();
        if (!alive || picked) return;
        // Nothing can see. Pulling a helper needs Ollama running; without it
        // the only honest advice is the model picker, which the status line
        // below gives.
        const st = await api.aiStatus().catch(() => null);
        if (!alive || !st?.running) return;
        const rec = await recommendedModels().catch(() => null);
        const vision = rec?.vision?.trim();
        if (alive && vision) setVisionModel(vision);
      } catch {
        // offline or older backend — just don't offer anything
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function locate(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    // Still gated on the image being on screen — the boxes are drawn over it —
    // but its SIZE is no longer measured or sent: the command dropped
    // imgWidth/imgHeight and the boxes come back in 0-1000 coordinates.
    if (!q || busy || !imgRef.current) return;
    setBusy(true);
    setStatus("Looking…");
    setBoxes([]);
    try {
      const found = await api.locateInImage(fileId, q);
      setBoxes(found);
      setStatus(
        found.length === 0
          ? "The AI could not locate that in this image."
          : `Found ${found.length} match${found.length === 1 ? "" : "es"}.`,
      );
    } catch (err) {
      // NO_VISION_MODEL is not a failure to find anything — it means nothing
      // installed can aim at all. Saying "could not locate that" here would be
      // a claim about the user's picture; this is a claim about their setup,
      // and it comes with the one-click fix already wired below.
      const msg = String(err);
      if (msg.includes("NO_VISION_MODEL")) {
        // Name the two real fixes. The old text said only "download one below",
        // which is the wrong advice for anyone whose engine can already see —
        // switching to a model carrying the `vision` badge in Settings → Model
        // costs nothing and is usually the better one.
        setStatus(
          "Marking needs a model that can see images. This room's model can't, " +
            "and nothing on this Mac can either — pick a model with the “vision” " +
            "badge in Settings → Model, or download a local helper below.",
        );
        const rec = await recommendedModels().catch(() => null);
        if (rec?.vision?.trim()) setVisionModel(rec.vision.trim());
      } else {
        setStatus(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  // Reuse the existing pull_model flow + its pull-progress events.
  const unlistenPullRef = useRef<(() => void) | null>(null);
  /** The model name a running download was started with — what Stop needs.
   * Kept in a ref because `visionModel` is cleared the moment the pull
   * succeeds, and Stop must never reach for a name that has already moved. */
  const pullingNameRef = useRef<string | null>(null);
  // Leaving the picture mid-download drops the event listener; the pull itself
  // keeps running in the backend, which is deliberate (it is a large download
  // and the room is not the only place it is useful) and is what the offer's
  // wording says. Stop is the way out — it is not the same thing as leaving.
  useEffect(
    () => () => {
      unlistenPullRef.current?.();
      unlistenPullRef.current = null;
    },
    [],
  );

  /** Abandon a running download. `pull_model` registers its cancel flag under
   * `pull:<model name>` in the SAME registry chat's Stop uses, so this is the
   * whole wiring — the Rust half has been cancellable (and tested) all along
   * with no surface calling it, which is why a started download could not be
   * stopped, paused, or escaped by leaving the picture. */
  function stopVisionHelper() {
    const name = pullingNameRef.current;
    if (!name) return;
    setPullStatus("stopping…");
    api.cancelAsk(`pull:${name}`).catch(() => {
      // Nothing to stop (it just finished, or the flag is already gone). The
      // pull's own result is the honest answer either way — say nothing here.
    });
  }

  async function getVisionHelper() {
    if (!visionModel || pulling) return;
    const name = visionModel;
    pullingNameRef.current = name;
    setPulling(true);
    setPullErr("");
    setPullStatus("starting…");
    setPullPercent(null);
    const unlisten = await listen<{ status: string; percent: number | null }>(
      "pull-progress",
      (e) => {
        setPullStatus(e.payload.status);
        setPullPercent(e.payload.percent);
      },
    );
    unlistenPullRef.current = unlisten;
    try {
      await api.pullModel(name);
      setPullDone(true);
      setVisionModel(null);
    } catch (e) {
      // A download YOU stopped is not a failure, and must not be reported in
      // red as one. Anything else is.
      const msg = String(e);
      if (msg.includes("The download was cancelled")) {
        setPullStatus("Download stopped. Nothing was installed.");
      } else {
        setPullErr(msg);
        setPullStatus("");
      }
    } finally {
      unlisten();
      unlistenPullRef.current = null;
      pullingNameRef.current = null;
      setPulling(false);
      setPullPercent(null);
    }
  }

  if (imgDead) {
    // Every other viewer names a decode failure plainly; this one used to leave
    // a broken-image icon and a working "ask AI to mark it" bar over nothing.
    return (
      <div className="empty-hint">
        This picture couldn’t be shown — the file appears to be empty, damaged,
        or in a format this Mac can’t decode. The original is still stored in
        the room: export it from the toolbar above to inspect it, or import the
        picture again to replace it.
      </div>
    );
  }

  return (
    <div className="image-view">
      <form className="locate-bar" onSubmit={locate}>
        <input
          placeholder='Ask AI to mark something… e.g. "the red button", "faces", "the total price"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="primary" disabled={busy || !query.trim()}>
          {busy ? (
            "…"
          ) : (
            <>
              {/* Monochrome crosshair (currentColor => white on the violet
                  primary button), replacing the warm 🎯 emoji so the mark
                  action stays on the single violet accent. */}
              <svg
                width={13}
                height={13}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ verticalAlign: "-2px", marginRight: 5 }}
                aria-hidden
              >
                <circle cx="12" cy="12" r="7.5" />
                <path d="M12 2.5v3.5M12 18v3.5M2.5 12h3.5M18 12h3.5" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
              </svg>
              {/* "Mark", not "Find". PdfView's toolbar has a Find that searches
                  the document's own text; this asks a model to draw boxes on a
                  picture. Two different acts under one word, in one family of
                  viewers — and "mark" is the verb the rest of this component
                  already uses (the placeholder, the status line, the offer). */}
              Mark
            </>
          )}
        </button>
        {boxes.length > 0 && (
          <button type="button" className="subtle" onClick={() => setBoxes([])}>
            Clear
          </button>
        )}
      </form>

      {/* Offer the vision helper when nothing installed can mark images.
          Kept separate from the mark bar above so marking still works.

          `.rdr-note` is the viewer chrome's technical notice, so this card is
          drawn from the same tokens as every other one. Its own dress is cut
          for a one-line caption in the margin — 46ch of micro type — and this
          note is an INSTRUCTION with two buttons and a download bar in it, so
          it takes the width and the reading size back. */}
      {visionModel && !pullDone && (
        <div
          className="rdr-note"
          style={{
            flexWrap: "wrap",
            alignItems: "center",
            maxWidth: "none",
            fontSize: "var(--fs-body)",
          }}
        >
          <span>
            {/* Offered only when the backend says nothing can mark — and framed
                as one way out, not the way. Switching this room to any model
                that carries the "vision" badge works just as well and downloads
                nothing. No invented size figure: the build Ollama actually
                fetches isn't known here (the old "~3 GB" was neither checked nor
                right), and the progress bar below reports the real download. */}
            Nothing here can mark images yet. Either pick a model with the
            “vision” badge in Settings → Model, or download a local helper
            (<code>{visionModel}</code>) — a large one-time download. It keeps
            running if you leave this picture; use Stop to abandon it.
          </span>
          <button className="primary" onClick={getVisionHelper} disabled={pulling}>
            {pulling ? "Downloading…" : "Download"}
          </button>
          {pulling && (
            <button
              className="subtle"
              onClick={stopVisionHelper}
              title="Abandon this download — nothing is installed and no partial file is kept"
            >
              Stop
            </button>
          )}
          {(pullStatus || pullPercent != null) && (
            <div className="pull-progress" style={{ flexBasis: "100%" }}>
              {pullPercent != null && (
                <div className="pull-bar">
                  <div className="pull-bar-fill" style={{ width: `${pullPercent}%` }} />
                </div>
              )}
              <span>
                {pullStatus}
                {pullPercent != null && ` — ${pullPercent.toFixed(0)}%`}
              </span>
            </div>
          )}
          {pullErr && <span style={{ color: "var(--danger)" }}>{pullErr}</span>}
        </div>
      )}
      {pullDone && (
        <div className="viewer-status">Vision helper ready — try marking now.</div>
      )}

      {/* A live region, because this string is REPLACED as work finishes:
          "Looking…" becomes the count of matches, or the reason nothing could
          be marked. `.viewer-status` also dresses static captions elsewhere
          (a figcaption, a cue count, "Slide 3 of 12") — those are not announced
          and should not be. The rule is the readout changing, not the class. */}
      {status && (
        <div className="viewer-status" role="status">
          {status}
        </div>
      )}
      <div className="pdf-zoombar img-zoombar">
        <button
          type="button"
          className="pdf-zoom-btn"
          onClick={() => zoomBy(-ZOOM_STEP)}
          disabled={zoom !== "fit" && zoom <= MIN_ZOOM + 1e-9}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="pdf-zoom-pct">
          {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
        </span>
        <button
          type="button"
          className="pdf-zoom-btn"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={zoom !== "fit" && zoom >= MAX_ZOOM - 1e-9}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="pdf-zoom-fit"
          onClick={() => setZoom(1)}
          title="Actual size"
        >
          100%
        </button>
        <button
          type="button"
          className="pdf-zoom-fit"
          onClick={() => setZoom("fit")}
          title="Fit to the pane"
        >
          Fit
        </button>
      </div>
      <div
        className="img-scroll"
        ref={scrollRef}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
        style={{ cursor: zoom !== "fit" ? (panning.current ? "grabbing" : "grab") : undefined }}
      >
      <div
        className="img-wrap"
        style={
          zoom !== "fit" && natW
            ? { width: natW * zoom, maxWidth: "none" }
            : undefined
        }
      >
        <img
          ref={imgRef}
          src={src ?? ""}
          alt={name}
          onLoad={(e) => setNatW(e.currentTarget.naturalWidth)}
          onError={() => setImgDead(true)}
        />
        {boxes.map((b, i) => {
          const color = BOX_COLORS[i % BOX_COLORS.length];
          return (
            <div
              key={i}
              className="img-box"
              style={{
                left: `${b.x1 * 100}%`,
                top: `${b.y1 * 100}%`,
                width: `${(b.x2 - b.x1) * 100}%`,
                height: `${(b.y2 - b.y1) * 100}%`,
                borderColor: color,
              }}
            >
              <span className="img-box-label" style={{ background: color }}>
                {b.label}
              </span>
            </div>
          );
        })}
      </div>
      </div>
      {/* The words OCR read off this picture. They were computed, stored and
          indexed — searchable, and fed to the model — but the viewer was never
          handed them, so the one person who could tell they were WRONG was the
          only one who could not see them. Collapsed by default: a picture is
          still a picture. */}
      {ocrText && (
        <details className="img-ocr" open={false}>
          <summary>
            Text read from this picture
            <span className="img-ocr-count">
              {" "}
              · {ocrText.length.toLocaleString()} characters
            </span>
          </summary>
          <p className="img-ocr-note">
            Recognised on this Mac. Machine reading is not perfect — check it
            against the picture before relying on it.
          </p>
          <pre className="img-ocr-text" dir="auto">
            {ocrText}
          </pre>
        </details>
      )}
    </div>
  );
}
