import { useRef, type RefObject } from "react";
import { type ImageBox, type DerivedPreviewStatus } from "../api";
import { BOX_COLORS } from "./util";
import { useFileBytes } from "./useFileBytes";
import { useDecodedRaster } from "./useDecodedRaster";
import { derivedPreviewCaption } from "./derivedPreviewStatus";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  accessibleImageName,
  imageExtension,
  imageFailureReason,
  imageOcrText,
  imageSource,
  loadingCaption,
  rasterFormatFor,
  rasterIsLoading,
  useImageFailure,
  useImageLocator,
  useImagePan,
  useImageZoom,
  useVisionHelper,
  type BytesState,
  type DecodeState,
  type VisionHelper,
  type Zoom,
} from "./imageViewState";

interface Props {
  fileId: string;
  name: string;
  mime: string;
  mediaToken?: string | null;
  dataB64?: string | null;
  text?: string | null;
  derivedPreview?: DerivedPreviewStatus;
}

function LoadingPreview({ extension }: { extension: string }) {
  return <div className="empty-hint">{loadingCaption(extension)}</div>;
}

function ImageUnavailable({
  bytes,
  decoded,
}: {
  bytes: BytesState;
  decoded: DecodeState;
}) {
  return (
    <div className="empty-hint">
      This picture couldn’t be shown{imageFailureReason(bytes, decoded)}. The
      original is still stored in the room: export it from the toolbar above to
      inspect it, or import the picture again to replace it.
    </div>
  );
}

function DerivedPreviewCaption({
  derivedPreview,
}: {
  derivedPreview?: DerivedPreviewStatus;
}) {
  if (!derivedPreview) return null;
  return (
    <div className="viewer-status derived-preview-caption">
      {derivedPreviewCaption(derivedPreview)}
    </div>
  );
}

function MarkButton({ busy, disabled }: { busy: boolean; disabled: boolean }) {
  if (busy)
    return (
      <button className="primary" disabled>
        …
      </button>
    );
  return (
    <button className="primary" disabled={disabled}>
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
      Mark
    </button>
  );
}

function ClearBoxes({
  boxes,
  onClear,
}: {
  boxes: ImageBox[];
  onClear: () => void;
}) {
  if (boxes.length === 0) return null;
  return (
    <button type="button" className="subtle" onClick={onClear}>
      Clear
    </button>
  );
}

function LocateBar({
  locator,
}: {
  locator: ReturnType<typeof useImageLocator>;
}) {
  return (
    <form className="locate-bar" onSubmit={locator.locate}>
      <input
        placeholder='Ask AI to mark something… e.g. "the red button", "faces", "the total price"'
        value={locator.query}
        onChange={(event) => locator.setQuery(event.target.value)}
      />
      <MarkButton busy={locator.busy} disabled={!locator.query.trim()} />
      <ClearBoxes boxes={locator.boxes} onClear={() => locator.setBoxes([])} />
    </form>
  );
}

function DownloadVisionButton({ helper }: { helper: VisionHelper }) {
  if (helper.pulling)
    return (
      <button className="primary" onClick={helper.getVisionHelper} disabled>
        Downloading…
      </button>
    );
  return (
    <button className="primary" onClick={helper.getVisionHelper}>
      Download
    </button>
  );
}

function StopVisionButton({ helper }: { helper: VisionHelper }) {
  if (!helper.pulling) return null;
  return (
    <button
      className="subtle"
      onClick={helper.stopVisionHelper}
      title="Abandon this download — nothing is installed and no partial file is kept"
    >
      Stop
    </button>
  );
}

function PullBar({ percent }: { percent: number | null }) {
  if (percent == null) return null;
  return (
    <div className="pull-bar">
      <div className="pull-bar-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

function PullCaption({
  percent,
  status,
}: {
  percent: number | null;
  status: string;
}) {
  if (percent == null) return <span>{status}</span>;
  return (
    <span>
      {status} — {percent.toFixed(0)}%
    </span>
  );
}

function PullProgress({ helper }: { helper: VisionHelper }) {
  if (!helper.pullStatus && helper.pullPercent == null) return null;
  return (
    <div className="pull-progress" style={{ flexBasis: "100%" }}>
      <PullBar percent={helper.pullPercent} />
      <PullCaption percent={helper.pullPercent} status={helper.pullStatus} />
    </div>
  );
}

function PullError({ error }: { error: string }) {
  if (!error) return null;
  return <span style={{ color: "var(--danger)" }}>{error}</span>;
}

function VisionOffer({ helper }: { helper: VisionHelper }) {
  if (!helper.visionModel) return null;
  if (helper.pullDone) return null;
  return (
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
        Nothing here can mark images yet. Either pick a model with the “vision”
        badge in Settings → Model, or download a local helper (
        <code>{helper.visionModel}</code>) — a large one-time download. It keeps
        running if you leave this picture; use Stop to abandon it.
      </span>
      <DownloadVisionButton helper={helper} />
      <StopVisionButton helper={helper} />
      <PullProgress helper={helper} />
      <PullError error={helper.pullErr} />
    </div>
  );
}

function VisionReady({ ready }: { ready: boolean }) {
  if (!ready) return null;
  return (
    <div className="viewer-status">Vision helper ready — try marking now.</div>
  );
}

function StatusLine({ status }: { status: string }) {
  if (!status) return null;
  return (
    <div className="viewer-status" role="status">
      {status}
    </div>
  );
}

function ZoomControls({
  zoom,
  setZoom,
  zoomBy,
}: Pick<ReturnType<typeof useImageZoom>, "zoom" | "setZoom" | "zoomBy">) {
  return (
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
  );
}

function imageWrapStyle(zoom: Zoom, naturalWidth: number) {
  if (zoom === "fit") return undefined;
  if (!naturalWidth) return undefined;
  return { width: naturalWidth * zoom, maxWidth: "none" };
}

function imageCursor(zoom: Zoom, panning: boolean) {
  if (zoom === "fit") return undefined;
  return panning ? "grabbing" : "grab";
}

function boxStyle(box: ImageBox, index: number) {
  const color = BOX_COLORS[index % BOX_COLORS.length];
  return {
    color,
    style: {
      left: `${box.x1 * 100}%`,
      top: `${box.y1 * 100}%`,
      width: `${(box.x2 - box.x1) * 100}%`,
      height: `${(box.y2 - box.y1) * 100}%`,
      borderColor: color,
    },
  };
}

function ImageBoxes({ boxes }: { boxes: ImageBox[] }) {
  return (
    <>
      {boxes.map((box, index) => {
        const appearance = boxStyle(box, index);
        return (
          <div key={index} className="img-box" style={appearance.style}>
            <span
              className="img-box-label"
              style={{ background: appearance.color }}
            >
              {box.label}
            </span>
          </div>
        );
      })}
    </>
  );
}

function ImageSurface({
  accessibleName,
  locator,
  src,
  failure,
  zoomState,
  imageRef,
}: {
  accessibleName: string;
  locator: ReturnType<typeof useImageLocator>;
  src: string | null;
  failure: ReturnType<typeof useImageFailure>;
  zoomState: ReturnType<typeof useImageZoom>;
  imageRef: RefObject<HTMLImageElement | null>;
}) {
  const pan = useImagePan(zoomState.zoom);
  return (
    <div
      className="img-scroll"
      ref={pan.scrollRef}
      onPointerDown={pan.onPanStart}
      onPointerMove={pan.onPanMove}
      onPointerUp={pan.onPanEnd}
      onPointerCancel={pan.onPanEnd}
      style={{ cursor: imageCursor(zoomState.zoom, pan.panning.current) }}
    >
      <div
        className="img-wrap"
        style={imageWrapStyle(zoomState.zoom, zoomState.natW)}
      >
        <img
          ref={imageRef}
          src={src ?? ""}
          alt={accessibleName}
          aria-label={accessibleName}
          onLoad={(event) =>
            zoomState.setNatW(event.currentTarget.naturalWidth)
          }
          onError={() => failure.setImgDead(true)}
        />
        <ImageBoxes boxes={locator.boxes} />
      </div>
    </div>
  );
}

function OcrPanel({ text }: { text: string }) {
  if (!text) return null;
  return (
    <details className="img-ocr" open={false}>
      <summary>
        Text read from this picture
        <span className="img-ocr-count">
          {" "}
          · {text.length.toLocaleString()} characters
        </span>
      </summary>
      <p className="img-ocr-note">
        Recognised on this Mac. Machine reading is not perfect — check it
        against the picture before relying on it.
      </p>
      <pre className="img-ocr-text" dir="auto">
        {text}
      </pre>
    </details>
  );
}

function ImageViewerContent({
  accessibleName,
  derivedPreview,
  failure,
  helper,
  imageRef,
  locator,
  ocrText,
  src,
  zoomState,
}: {
  accessibleName: string;
  derivedPreview?: DerivedPreviewStatus;
  failure: ReturnType<typeof useImageFailure>;
  helper: VisionHelper;
  imageRef: RefObject<HTMLImageElement | null>;
  locator: ReturnType<typeof useImageLocator>;
  ocrText: string;
  src: string | null;
  zoomState: ReturnType<typeof useImageZoom>;
}) {
  return (
    <div className="image-view">
      <DerivedPreviewCaption derivedPreview={derivedPreview} />
      <LocateBar locator={locator} />
      <VisionOffer helper={helper} />
      <VisionReady ready={helper.pullDone} />
      <StatusLine status={locator.status} />
      <ZoomControls
        zoom={zoomState.zoom}
        setZoom={zoomState.setZoom}
        zoomBy={zoomState.zoomBy}
      />
      <ImageSurface
        accessibleName={accessibleName}
        locator={locator}
        src={src}
        failure={failure}
        zoomState={zoomState}
        imageRef={imageRef}
      />
      <OcrPanel text={ocrText} />
    </div>
  );
}

export default function ImageView({
  fileId,
  name,
  mime,
  mediaToken,
  dataB64,
  text,
  derivedPreview,
}: Props) {
  const extension = imageExtension(name);
  const rasterFormat = rasterFormatFor(extension);
  const specialBytes = useFileBytes(
    rasterFormat ? mediaToken : null,
    rasterFormat ? dataB64 : null,
  );
  const decoded = useDecodedRaster(rasterFormat, specialBytes.bytes);
  const src = imageSource(rasterFormat, decoded.url, mime, dataB64, mediaToken);
  const imageRef = useRef<HTMLImageElement>(null);
  const helper = useVisionHelper();
  const failure = useImageFailure(
    rasterFormat,
    specialBytes,
    decoded,
    src,
    dataB64,
    mediaToken,
  );
  const locator = useImageLocator(fileId, imageRef, helper.setVisionModel);
  const zoomState = useImageZoom(imageRef);
  if (rasterIsLoading(rasterFormat, specialBytes, decoded))
    return <LoadingPreview extension={extension} />;
  if (failure.imgDead)
    return <ImageUnavailable bytes={specialBytes} decoded={decoded} />;
  return (
    <ImageViewerContent
      accessibleName={accessibleImageName(name)}
      derivedPreview={derivedPreview}
      failure={failure}
      helper={helper}
      imageRef={imageRef}
      locator={locator}
      ocrText={imageOcrText(text)}
      src={src}
      zoomState={zoomState}
    />
  );
}
