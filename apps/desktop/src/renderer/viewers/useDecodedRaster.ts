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
      const reply = event.data;
      if (reply.id !== id) return;
      if (!reply.ok || !reply.rgba || !reply.width || !reply.height) {
        setState({ url: null, loading: false, error: reply.error || "This picture could not be decoded." });
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = reply.width;
      canvas.height = reply.height;
      const context = canvas.getContext("2d");
      if (!context) {
        setState({ url: null, loading: false, error: "This Mac could not create an image canvas." });
        return;
      }
      context.putImageData(new ImageData(new Uint8ClampedArray(reply.rgba), reply.width, reply.height), 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          setState({ url: null, loading: false, error: "The decoded picture could not be drawn." });
          return;
        }
        liveUrl = URL.createObjectURL(blob);
        setState({ url: liveUrl, loading: false, error: "" });
      }, "image/png");
    };
    worker.onerror = (event) => setState({
      url: null,
      loading: false,
      error: event.message || "The picture decoder stopped unexpectedly.",
    });
    const transfer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    worker.postMessage({ id, format, buffer: transfer }, [transfer]);
    return () => {
      worker.terminate();
      if (liveUrl) URL.revokeObjectURL(liveUrl);
    };
  }, [format, bytes]);

  return state;
}
