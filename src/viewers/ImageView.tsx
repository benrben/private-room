import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, ImageBox } from "../api";
import { BOX_COLORS } from "./util";

interface Props {
  fileId: string;
  name: string;
  mime: string;
  dataB64: string;
}

// CONTRACT-NOTE: mirrors recommended_models() (BACKEND-ACTUALS). Swap for
// api.recommendedModels() once the API agent adds the wrapper.
interface RecommendedModels {
  chat: string[];
  embed: string;
  vision: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export default function ImageView({ fileId, name, mime, dataB64 }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [query, setQuery] = useState("");
  const [boxes, setBoxes] = useState<ImageBox[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

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

  // The recommended vision model, set only when it's worth offering to
  // download it (Ollama is up but nothing installed can mark images).
  const [visionModel, setVisionModel] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullStatus, setPullStatus] = useState("");
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullErr, setPullErr] = useState("");
  const [pullDone, setPullDone] = useState(false);

  // ---- decide whether to offer the vision helper (doesn't block the bar) ----
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // CONTRACT-NOTE: recommended_models has no api.ts wrapper yet.
        const rec = await invoke<RecommendedModels>("recommended_models");
        const vision = rec.vision?.trim();
        if (!vision) return;
        const [st, caps] = await Promise.all([
          api.aiStatus().catch(() => null),
          api.modelCapabilities().catch(() => []),
        ]);
        if (!alive) return;
        // Pulling needs Ollama running; and skip if a vision-capable model is
        // already installed (either flagged by caps or matching the rec name).
        const running = st?.running ?? false;
        const installed = st?.models ?? [];
        const hasVision =
          caps.some((c) => c.vision) ||
          installed.some(
            (m) => m === vision || m.startsWith(vision) || m.replace(/:.*/, "") === vision,
          );
        if (running && !hasVision) setVisionModel(vision);
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
    const img = imgRef.current;
    if (!q || busy || !img) return;
    setBusy(true);
    setStatus("Looking…");
    setBoxes([]);
    try {
      const found = await api.locateInImage(
        fileId,
        q,
        img.naturalWidth,
        img.naturalHeight,
      );
      setBoxes(found);
      setStatus(
        found.length === 0
          ? "The AI could not locate that in this image."
          : `Found ${found.length} match${found.length === 1 ? "" : "es"}.`,
      );
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  }

  // Reuse the existing pull_model flow + its pull-progress events.
  async function getVisionHelper() {
    if (!visionModel || pulling) return;
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
    try {
      await api.pullModel(visionModel);
      setPullDone(true);
      setVisionModel(null);
    } catch (e) {
      setPullErr(String(e));
    } finally {
      unlisten();
      setPulling(false);
      setPullPercent(null);
    }
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
              Find
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
          Kept separate from the mark bar above so marking still works. */}
      {visionModel && !pullDone && (
        <div
          className="vision-offer"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            margin: "2px 0",
            borderRadius: 8,
            background: "rgba(139, 124, 246, 0.08)",
            border: "1px solid rgba(139, 124, 246, 0.16)",
          }}
        >
          <span style={{ color: "var(--text-dim)" }}>
            Download the vision helper (~3&nbsp;GB) for accurate marking
          </span>
          <button className="primary" onClick={getVisionHelper} disabled={pulling}>
            {pulling ? "Downloading…" : "Download"}
          </button>
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

      {status && <div className="viewer-status">{status}</div>}
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
      <div className="img-scroll">
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
          src={`data:${mime};base64,${dataB64}`}
          alt={name}
          onLoad={(e) => setNatW(e.currentTarget.naturalWidth)}
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
    </div>
  );
}
