import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  decodeJxl: vi.fn(),
  decodeTiff: vi.fn(),
  decodeTiffImage: vi.fn(),
  getCompositeImageData: vi.fn(),
  initializeCanvas: vi.fn(),
  readPsd: vi.fn(),
  toRgba8: vi.fn(),
}));

vi.mock("ag-psd", () => ({
  getCompositeImageData: fakes.getCompositeImageData,
  initializeCanvas: fakes.initializeCanvas,
  readPsd: fakes.readPsd,
}));
vi.mock("utif", () => ({
  decode: fakes.decodeTiff,
  decodeImage: fakes.decodeTiffImage,
  toRGBA8: fakes.toRgba8,
}));
vi.mock("@jsquash/jxl/decode.js", () => ({ default: fakes.decodeJxl }));

class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number);
  constructor(width: number, height: number);
  constructor(
    dataOrWidth: Uint8ClampedArray | number,
    width: number,
    height?: number,
  ) {
    if (typeof dataOrWidth === "number") {
      this.width = dataOrWidth;
      this.height = width;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      return;
    }
    this.data = dataOrWidth;
    this.width = width;
    this.height = height!;
  }
}

interface FakeWorkerScope {
  onmessage?: (event: MessageEvent) => void;
  postMessage: ReturnType<typeof vi.fn>;
}

async function loadWorker(): Promise<FakeWorkerScope> {
  const worker: FakeWorkerScope = { postMessage: vi.fn() };
  vi.stubGlobal("self", worker);
  vi.stubGlobal("ImageData", FakeImageData);
  vi.stubGlobal("OffscreenCanvas", class {});
  await import("./rasterDecode.worker");
  return worker;
}

async function decode(
  worker: FakeWorkerScope,
  id: number,
  format: "psd" | "tiff" | "jxl",
): Promise<unknown> {
  worker.onmessage?.({
    data: { id, format, buffer: new Uint8Array([id]).buffer },
  } as MessageEvent);
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
  return worker.postMessage.mock.calls[0]![0];
}

function success(message: unknown): { id: number; ok: true; width: number; height: number; rgba: ArrayBuffer } {
  return message as { id: number; ok: true; width: number; height: number; rgba: ArrayBuffer };
}

function failure(message: unknown): { id: number; ok: false; error: string } {
  return message as { id: number; ok: false; error: string };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("raster decode worker", () => {
  it("copies and scales fabricated Uint16 PSD pixels before transfer", async () => {
    const composite = {
      data: new Uint16Array([0, 257, 65_535, 12_850]),
      width: 1,
      height: 1,
    };
    fakes.readPsd.mockReturnValue({ imageData: composite });
    const worker = await loadWorker();

    const message = success(await decode(worker, 1, "psd"));

    expect(message).toMatchObject({ id: 1, ok: true, width: 1, height: 1 });
    expect([...new Uint8ClampedArray(message.rgba)]).toEqual([0, 1, 255, 50]);
    expect(fakes.initializeCanvas).toHaveBeenCalledOnce();
    expect(worker.postMessage.mock.calls[0]![1]).toEqual([message.rgba]);
  });

  it("scales fabricated Float32 PSD pixels before transfer", async () => {
    fakes.readPsd.mockReturnValue({
      imageData: { data: new Float32Array([0, 0.5, 1, 0.25]), width: 1, height: 1 },
    });
    const worker = await loadWorker();

    const message = success(await decode(worker, 2, "psd"));

    expect(message).toMatchObject({ id: 2, ok: true, width: 1, height: 1 });
    expect([...new Uint8ClampedArray(message.rgba)]).toEqual([0, 128, 255, 64]);
  });

  it("returns fabricated RGBA8 pixels from the first TIFF page", async () => {
    const page = { width: 1, height: 1 };
    fakes.decodeTiff.mockReturnValue([page]);
    fakes.toRgba8.mockReturnValue(new Uint8Array([7, 8, 9, 10]));
    const worker = await loadWorker();

    const message = success(await decode(worker, 7, "tiff"));

    expect(message).toMatchObject({ id: 7, ok: true, width: 1, height: 1 });
    expect([...new Uint8ClampedArray(message.rgba)]).toEqual([7, 8, 9, 10]);
    expect(fakes.decodeTiffImage).toHaveBeenCalledWith(expect.any(ArrayBuffer), page);
  });

  it("copies a fabricated Uint8ClampedArray view so the transferred buffer is exact", async () => {
    const source = new Uint8ClampedArray(8);
    source.set([1, 2, 3, 4], 2);
    fakes.decodeJxl.mockResolvedValue(new FakeImageData(source.subarray(2, 6), 1, 1));
    const worker = await loadWorker();

    const message = success(await decode(worker, 3, "jxl"));

    expect(message.rgba.byteLength).toBe(4);
    expect([...new Uint8ClampedArray(message.rgba)]).toEqual([1, 2, 3, 4]);
    expect(message.rgba).not.toBe(source.buffer);
  });

  it("materializes fabricated generic channel data without changing its byte scale", async () => {
    fakes.decodeJxl.mockResolvedValue({
      data: { 0: 11, 1: 22, 2: 33, 3: 44, length: 4 },
      width: 1,
      height: 1,
    });
    const worker = await loadWorker();

    const message = success(await decode(worker, 8, "jxl"));

    expect([...new Uint8ClampedArray(message.rgba)]).toEqual([11, 22, 33, 44]);
  });

  it("reports fabricated decoder failures without transferring pixels", async () => {
    fakes.readPsd.mockReturnValue({ imageData: undefined });
    fakes.getCompositeImageData.mockReturnValue(null);
    const psdWorker = await loadWorker();
    expect(failure(await decode(psdWorker, 4, "psd"))).toEqual({
      id: 4,
      ok: false,
      error: "This PSD has no flattened composite image.",
    });
    expect(psdWorker.postMessage.mock.calls[0]).toHaveLength(1);

    vi.resetModules();
    vi.clearAllMocks();
    fakes.decodeTiff.mockReturnValue([]);
    const tiffWorker = await loadWorker();
    expect(failure(await decode(tiffWorker, 5, "tiff"))).toEqual({
      id: 5,
      ok: false,
      error: "No TIFF pages were found.",
    });

    vi.resetModules();
    vi.clearAllMocks();
    const malformedPage = { width: 1, height: 1 };
    fakes.decodeTiff.mockReturnValue([malformedPage]);
    fakes.toRgba8.mockReturnValue(new Uint8Array([1, 2, 3]));
    const malformedTiffWorker = await loadWorker();
    expect(failure(await decode(malformedTiffWorker, 7, "tiff"))).toEqual({
      id: 7,
      ok: false,
      error: "The first TIFF page could not be decoded.",
    });

    vi.resetModules();
    vi.clearAllMocks();
    fakes.decodeJxl.mockRejectedValue("fabricated JXL failure");
    const jxlWorker = await loadWorker();
    expect(failure(await decode(jxlWorker, 6, "jxl"))).toEqual({
      id: 6,
      ok: false,
      error: "fabricated JXL failure",
    });
  });
});
