import { describe, expect, it } from "vitest";
import {
  bytesToText,
  escapeHtml,
  findEntry,
  isRenderableImage,
  mimeForPath,
  resolvePath,
  toDataUrl,
  withoutFragment,
} from "./zipdoc";

describe("escapeHtml", () => {
  it("escapes every character that can leave HTML text or an attribute", () => {
    expect(escapeHtml(`A&B <tag title="quoted">'text'</tag>`)).toBe(
      "A&amp;B &lt;tag title=&quot;quoted&quot;&gt;&#39;text&#39;&lt;/tag&gt;",
    );
  });
});

describe("zip document byte and entry helpers", () => {
  it("normalizes references, MIME types, and browser-renderable images", () => {
    expect(withoutFragment("chapter.xhtml?mode=reader#middle")).toBe("chapter.xhtml");
    expect(mimeForPath("cover.JPEG")).toBe("image/jpeg");
    expect(mimeForPath("unknown.bin")).toBe("application/octet-stream");
    expect(isRenderableImage("cover.webp")).toBe(true);
    expect(isRenderableImage("drawing.emf")).toBe(false);
    expect(isRenderableImage("notes.css")).toBe(false);
  });

  it("converts bytes without argument-limit assumptions and decodes optional text", () => {
    const bytes = new Uint8Array([65, 66, 67]);
    expect(toDataUrl(bytes, "text/plain")).toBe("data:text/plain;base64,QUJD");
    expect(bytesToText(bytes)).toBe("ABC");
    expect(bytesToText(undefined)).toBe("");
  });

  it("finds exact and normalized archive entries without guessing absent content", () => {
    const exact = new Uint8Array([1]);
    const normalized = new Uint8Array([2]);
    const files = { "exact.txt": exact, "OPS/Images/Cover.PNG": normalized };

    expect(findEntry(files, "exact.txt")).toBe(exact);
    expect(findEntry(files, "/ops/images/cover.png")).toBe(normalized);
    expect(findEntry(files, "missing.png")).toBeUndefined();
  });
});

describe("resolvePath", () => {
  it("resolves sibling and parent targets from the referencing part", () => {
    expect(resolvePath("ppt/slides/_rels/slide1.xml.rels", "../media/image1.png")).toBe("ppt/slides/media/image1.png");
    expect(resolvePath("OPS/chapters/chapter.xhtml", "../images/cover.jpg")).toBe("OPS/images/cover.jpg");
  });

  it("normalizes empty and dot segments without losing nested target parts", () => {
    expect(resolvePath("book/chapter.xhtml", "./assets//diagram.svg")).toBe("book/assets/diagram.svg");
    expect(resolvePath("chapter.xhtml", "text/page.xhtml")).toBe("text/page.xhtml");
  });

  it("keeps absolute URLs and makes rooted archive paths relative to the archive", () => {
    expect(resolvePath("ppt/slides/slide1.xml", "https://example.test/picture.png")).toBe("https://example.test/picture.png");
    expect(resolvePath("ppt/slides/slide1.xml", "/media/picture.png")).toBe("media/picture.png");
  });
});
