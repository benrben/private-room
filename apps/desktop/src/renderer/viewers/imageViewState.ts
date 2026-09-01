import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { listen } from "../platform";
import { api, recommendedModels, type ImageBox } from "../api";
import { ocrBody } from "./util";
import { fileUrl, useFileBytes } from "./useFileBytes";
import { useDecodedRaster, type RasterFormat } from "./useDecodedRaster";

export type Zoom = number | "fit";
export type BytesState = ReturnType<typeof useFileBytes>;
export type DecodeState = ReturnType<typeof useDecodedRaster>;
export type VisionHelper = ReturnType<typeof useVisionHelper>;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.25;

export function imageExtension(name: string): string {
  return name.split(".").pop()?.toLocaleLowerCase() ?? "";
}

export function rasterFormatFor(extension: string): RasterFormat | null {
  if (extension === "psd") return "psd";
  if (extension === "tif" || extension === "tiff") return "tiff";
  if (extension === "jxl") return "jxl";
  return null;
}

export function imageSource(
  rasterFormat: RasterFormat | null,
  decodedUrl: string | null,
  mime: string,
  dataB64: string | null | undefined,
  mediaToken: string | null | undefined,
): string | null {
  if (rasterFormat) return decodedUrl;
  if (dataB64) return `data:${mime};base64,${dataB64}`;
  return fileUrl(mediaToken);
}

function startsWithoutImage(
  dataB64: string | null | undefined,
  mediaToken: string | null | undefined,
) {
  return !dataB64 && !mediaToken;
}

function hasSpecialDecodeFailure(bytes: BytesState, decoded: DecodeState): boolean {
  return Boolean(bytes.error || decoded.error);
}

function imageIsDead(
  rasterFormat: RasterFormat | null,
  bytes: BytesState,
  decoded: DecodeState,
  src: string | null,
) {
  if (rasterFormat) return hasSpecialDecodeFailure(bytes, decoded);
  return !src;
}

export function imageFailureReason(bytes: BytesState, decoded: DecodeState): string {
  const error = bytes.error || decoded.error;
  if (error) return ` — ${error}`;
  return " — the file appears to be empty, damaged, or in a format this Mac can’t decode";
}

export function loadingCaption(extension: string): string {
  return `Drawing ${extension.toUpperCase()} preview…`;
}

export function rasterIsLoading(
  rasterFormat: RasterFormat | null,
  bytes: BytesState,
  decoded: DecodeState,
): boolean {
  if (!rasterFormat) return false;
  return bytes.loading || decoded.loading;
}

export function accessibleImageName(name: string): string {
  const trimmed = name.trim();
  if (trimmed) return trimmed;
  return "Image preview";
}

export function imageOcrText(text: string | null | undefined): string {
  return ocrBody(text) ?? "";
}

function locationStatus(found: ImageBox[]): string {
  if (found.length === 0) return "The AI could not locate that in this image.";
  if (found.length === 1) return "Found 1 match.";
  return `Found ${found.length} matches.`;
}

function needsVisionModel(error: unknown): boolean {
  return String(error).includes("NO_VISION_MODEL");
}

function markingModelMessage(): string {
  return (
    "Marking needs a model that can see images. This room's model can't, " +
    "and nothing on this Mac can either — pick a model with the “vision” " +
    "badge in Settings → Model, or download a local helper below."
  );
}

async function recommendedVisionModel(): Promise<string | null> {
  const status = await api.aiStatus().catch(() => null);
  if (!status?.running) return null;
  const models = await recommendedModels().catch(() => null);
  return models?.vision?.trim() || null;
}

async function offeredVisionModel(): Promise<string | null> {
  try {
    const picked = await api.groundingModelForRoom();
    if (picked) return null;
    return await recommendedVisionModel();
  } catch {
    return null;
  }
}

export function useImageFailure(
  rasterFormat: RasterFormat | null,
  bytes: BytesState,
  decoded: DecodeState,
  src: string | null,
  dataB64: string | null | undefined,
  mediaToken: string | null | undefined,
) {
  const [imgDead, setImgDead] = useState(() =>
    startsWithoutImage(dataB64, mediaToken),
  );
  useEffect(() => {
    setImgDead(imageIsDead(rasterFormat, bytes, decoded, src));
  }, [bytes, decoded, rasterFormat, src]);
  return { imgDead, setImgDead };
}

function canLocate(
  query: string,
  busy: boolean,
  image: HTMLImageElement | null,
): boolean {
  if (!query) return false;
  if (busy) return false;
  return Boolean(image);
}

async function reportLocateError(
  error: unknown,
  setStatus: (status: string) => void,
  setVisionModel: (model: string) => void,
) {
  if (!needsVisionModel(error)) {
    setStatus(String(error));
    return;
  }
  setStatus(markingModelMessage());
  const model = await recommendedModels().catch(() => null);
  const vision = model?.vision?.trim();
  if (vision) setVisionModel(vision);
}

export function useImageLocator(
  fileId: string,
  imageRef: RefObject<HTMLImageElement | null>,
  setVisionModel: (model: string) => void,
) {
  const [query, setQuery] = useState("");
  const [boxes, setBoxes] = useState<ImageBox[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const locate = async (event: FormEvent) => {
    event.preventDefault();
    const term = query.trim();
    if (!canLocate(term, busy, imageRef.current)) return;
    setBusy(true);
    setStatus("Looking…");
    setBoxes([]);
    try {
      const found = await api.locateInImage(fileId, term);
      setBoxes(found);
      setStatus(locationStatus(found));
    } catch (error) {
      await reportLocateError(error, setStatus, setVisionModel);
    } finally {
      setBusy(false);
    }
  };
  return { boxes, busy, locate, query, setBoxes, setQuery, status };
}

function measuredZoom(image: HTMLImageElement | null): number {
  return image?.naturalWidth ? image.clientWidth / image.naturalWidth : 1;
}

function zoomBase(zoom: Zoom, image: HTMLImageElement | null): number {
  if (zoom === "fit") return measuredZoom(image);
  return zoom;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 20) / 20));
}

export function useImageZoom(imageRef: RefObject<HTMLImageElement | null>) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [natW, setNatW] = useState(0);
  const zoomBy = (delta: number) =>
    setZoom(clampZoom(zoomBase(zoom, imageRef.current) + delta));
  return { natW, setNatW, setZoom, zoom, zoomBy };
}

function canStartPan(zoom: Zoom, target: EventTarget | null): boolean {
  if (zoom === "fit") return false;
  return !(target as HTMLElement).closest(".img-box");
}

export function useImagePan(zoom: Zoom) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const panning = useRef(false);
  const panFrom = useRef({ x: 0, y: 0, left: 0, top: 0 });
  const onPanStart = (event: PointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (!element) return;
    if (!canStartPan(zoom, event.target)) return;
    panning.current = true;
    panFrom.current = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    element.setPointerCapture(event.pointerId);
  };
  const onPanMove = (event: PointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (!panning.current) return;
    if (!element) return;
    element.scrollLeft = panFrom.current.left - (event.clientX - panFrom.current.x);
    element.scrollTop = panFrom.current.top - (event.clientY - panFrom.current.y);
  };
  const onPanEnd = (event: PointerEvent<HTMLDivElement>) => {
    panning.current = false;
    scrollRef.current?.releasePointerCapture?.(event.pointerId);
  };
  return { onPanEnd, onPanMove, onPanStart, panning, scrollRef };
}

function pullWasCancelled(message: string): boolean {
  return message.includes("The download was cancelled");
}

function setPullFailure(
  message: string,
  setPullErr: (error: string) => void,
  setPullStatus: (status: string) => void,
) {
  if (pullWasCancelled(message)) {
    setPullStatus("Download stopped. Nothing was installed.");
    return;
  }
  setPullErr(message);
  setPullStatus("");
}

export function useVisionHelper() {
  const [visionModel, setVisionModel] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullStatus, setPullStatus] = useState("");
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullErr, setPullErr] = useState("");
  const [pullDone, setPullDone] = useState(false);
  const unlistenPullRef = useRef<(() => void) | null>(null);
  const pullingNameRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void offeredVisionModel().then((model) => {
      if (alive && model) setVisionModel(model);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      unlistenPullRef.current?.();
      unlistenPullRef.current = null;
    },
    [],
  );

  const stopVisionHelper = () => {
    const name = pullingNameRef.current;
    if (!name) return;
    setPullStatus("stopping…");
    api.cancelAsk(`pull:${name}`).catch(() => undefined);
  };

  const getVisionHelper = async () => {
    if (!visionModel) return;
    if (pulling) return;
    const name = visionModel;
    pullingNameRef.current = name;
    setPulling(true);
    setPullErr("");
    setPullStatus("starting…");
    setPullPercent(null);
    const unlisten = await listen<{ status: string; percent: number | null }>(
      "pull-progress",
      (event) => {
        setPullStatus(event.payload.status);
        setPullPercent(event.payload.percent);
      },
    );
    unlistenPullRef.current = unlisten;
    try {
      await api.pullModel(name);
      setPullDone(true);
      setVisionModel(null);
    } catch (error) {
      setPullFailure(String(error), setPullErr, setPullStatus);
    } finally {
      unlisten();
      unlistenPullRef.current = null;
      pullingNameRef.current = null;
      setPulling(false);
      setPullPercent(null);
    }
  };

  return {
    getVisionHelper,
    pullDone,
    pullErr,
    pulling,
    pullPercent,
    pullStatus,
    setVisionModel,
    stopVisionHelper,
    visionModel,
  };
}
