/// <reference types="vite/client" />

declare module "foliate-js/mobi.js" {
  export class MOBI {
    constructor(options: { unzlib(data: ArrayBuffer): Promise<Uint8Array> });
    open(file: File): Promise<unknown>;
  }
}

declare module "foliate-js/fb2.js" {
  export function makeFB2(file: Blob): Promise<unknown>;
}

declare module "foliate-js/comic-book.js" {
  export function makeComicBook(
    source: {
      entries: Array<{ filename: string }>;
      loadBlob(name: string): Promise<Blob>;
      getSize(name: string): number;
      getComment(): Promise<string | null>;
    },
    file: File,
  ): Promise<unknown>;
}

declare module "utif" {
  export interface Ifd {
    width?: number;
    height?: number;
    [key: string]: unknown;
  }
  export function decode(buffer: ArrayBuffer): Ifd[];
  export function decodeImage(buffer: ArrayBuffer, ifd: Ifd): void;
  export function toRGBA8(ifd: Ifd): Uint8Array;
}
