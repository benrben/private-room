import { useEffect, useState } from "react";

export type RasterFormat = "psd" | "tiff" | "jxl";

interface DecodeReply {
  id: number;
  ok: boolean;
  width?: number;
  height?: number;
  rgba?: ArrayBuffer;
  error?: string;
}

export interface DecodedRaster {
  url: string | null;
  loading: boolean;
  error: string;
}

let requestId = 0;

type CompleteDecodeReply = DecodeReply & Required<Pick<DecodeReply, "width" | "height" | "rgba">>;
type RasterStateSetter = (state: DecodedRaster) => void;

function decoderFailure(error: string): DecodedRaster {
  return { url: null, loading: false, error };
}

function isCompleteDecode(reply: DecodeReply): reply is CompleteDecodeReply {
  return reply.ok
    && reply.rgba !== undefined
    && reply.width !== undefined
    && reply.height !== undefined
    && Boolean(reply.width)
    && Boolean(reply.height);
}

function failedDecodeMessage(reply: DecodeReply): string {
  return reply.error || "This picture could not be decoded.";
}

function drawDecodedRaster(
  reply: CompleteDecodeReply,
  setState: RasterStateSetter,
  setLiveUrl: (url: string) => void,
) {
  const canvas = document.createElement("canvas");
  canvas.width = reply.width;
  canvas.height = reply.height;
  const context = canvas.getContext("2d");
  if (!context) {
    setState(decoderFailure("This Mac could not create an image canvas."));
    return;
  }
  context.putImageData(new ImageData(new Uint8ClampedArray(reply.rgba), reply.width, reply.height), 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) {
      setState(decoderFailure("The decoded picture could not be drawn."));
      return;
    }
    const url = URL.createObjectURL(blob);
    setLiveUrl(url);
    setState({ url, loading: false, error: "" });
  }, "image/png");
}

function handleDecodeReply(
  reply: DecodeReply,
  expectedId: number,
  setState: RasterStateSetter,
  setLiveUrl: (url: string) => void,
) {
  if (reply.id !== expectedId) return;
  if (!isCompleteDecode(reply)) {
    setState(decoderFailure(failedDecodeMessage(reply)));
    return;
  }
  drawDecodedRaster(reply, setState, setLiveUrl);
}

function handleDecoderError(event: ErrorEvent, setState: RasterStateSetter) {
  setState(decoderFailure(event.message || "The picture decoder stopped unexpectedly."));
}

/** Decode heavyweight design/image containers away from React's main thread. */
export function useDecodedRaster(format: RasterFormat | null, bytes: Uint8Array | null): DecodedRaster {
  const [state, setState] = useState<DecodedRaster>({ url: null, loading: format !== null, error: "" });

  useEffect(() => {
    if (format === null) {
      setState({ url: null, loading: false, error: "" });
      return;
    }
    if (bytes === null) {
      setState({ url: null, loading: true, error: "" });
      return;
    }
    const worker = new Worker(new URL("./rasterDecode.worker.ts", import.meta.url), { type: "module" });
    const id = ++requestId;
    let liveUrl: string | null = null;
    setState({ url: null, loading: true, error: "" });
    worker.onmessage = (event: MessageEvent<DecodeReply>) => {
      handleDecodeReply(event.data, id, setState, (url) => { liveUrl = url; });
    };
    worker.onerror = (event) => handleDecoderError(event, setState);
    const transfer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    worker.postMessage({ id, format, buffer: transfer }, [transfer]);
    return () => {
      worker.terminate();
      if (liveUrl) URL.revokeObjectURL(liveUrl);
    };
  }, [format, bytes]);

  return state;
}
