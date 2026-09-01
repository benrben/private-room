/// <reference lib="webworker" />

type RasterFormat = "psd" | "tiff" | "jxl";

interface DecodeRequest {
  id: number;
  format: RasterFormat;
  buffer: ArrayBuffer;
}

interface DecodeSuccess {
  id: number;
  ok: true;
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

interface DecodeFailure {
  id: number;
  ok: false;
  error: string;
}

const scope = self as DedicatedWorkerGlobalScope;

function exactRgba(
  data: ArrayLike<number> & { buffer?: ArrayBufferLike; byteOffset?: number; byteLength?: number },
): Uint8ClampedArray<ArrayBuffer> {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    // Copy rather than slicing the source buffer: a decoder may expose a
    // SharedArrayBuffer, which cannot be transferred through postMessage.
    const copied = new Uint8ClampedArray(data.byteLength);
    copied.set(data);
    return copied;
  }
  const out = new Uint8ClampedArray(data.length);
  const scale = data instanceof Uint16Array ? 1 / 257 : data instanceof Float32Array ? 255 : 1;
  for (let i = 0; i < data.length; i++) out[i] = Number(data[i]) * scale;
  return out;
}

async function decodeRaster(format: RasterFormat, buffer: ArrayBuffer): Promise<ImageData> {
  if (format === "psd") return decodePsd(buffer);
  if (format === "tiff") return decodeTiff(buffer);
  return decodeJxl(buffer);
}

async function decodePsd(buffer: ArrayBuffer): Promise<ImageData> {
  const { readPsd, getCompositeImageData, initializeCanvas } = await import("ag-psd");
  // `ag-psd` initialises its canvas helpers automatically only when a
  // `document` exists. This decoder deliberately runs in a worker, where it
  // does not, and even `useImageData: true` still reaches `createImageData`
  // while decoding the flattened composite. Without this explicit worker
  // factory every valid PSD fails with "Canvas not initialized" before a
  // pixel can be returned to ImageView.
  //
  // OffscreenCanvas is the worker-side Canvas implementation in Chromium.
  // The library's public type predates it and names HTMLCanvasElement, but
  // the 2D surface it uses is the same one. Supplying `createImageData`
  // separately also avoids allocating the library's hidden 1x1 canvas for
  // every worker instance.
  initializeCanvas(
    (width, height) => new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
    (width, height) => new ImageData(width, height),
  );
  const psd = readPsd(buffer, {
    useImageData: true,
    skipLayerImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    totalMemoryLimit: 512 * 1024 * 1024,
  });
  const composite = psd.imageData ?? getCompositeImageData(psd);
  if (!composite) throw new Error("This PSD has no flattened composite image.");
  return new ImageData(exactRgba(composite.data), composite.width, composite.height);
}

async function decodeTiff(buffer: ArrayBuffer): Promise<ImageData> {
  const UTIF = await import("utif");
  const pages = UTIF.decode(buffer);
  if (!pages.length) throw new Error("No TIFF pages were found.");
  const page = pages[0]!;
  UTIF.decodeImage(buffer, page);
  const rgba = UTIF.toRGBA8(page);
  if (!page.width || !page.height || rgba.byteLength !== page.width * page.height * 4) {
    throw new Error("The first TIFF page could not be decoded.");
  }
  return new ImageData(exactRgba(rgba), page.width, page.height);
}

async function decodeJxl(buffer: ArrayBuffer): Promise<ImageData> {
  const { default: decode } = await import("@jsquash/jxl/decode.js");
  return decode(buffer);
}

scope.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const { id, format, buffer } = event.data;
  void decodeRaster(format, buffer).then((image) => {
    const rgba = exactRgba(image.data);
    const message: DecodeSuccess = { id, ok: true, width: image.width, height: image.height, rgba: rgba.buffer };
    scope.postMessage(message, [message.rgba]);
  }).catch((reason) => {
    const message: DecodeFailure = {
      id,
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    };
    scope.postMessage(message);
  });
};

export {};
