import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterHtml, hrefToPath, opfPath, parseEpub } from "./epub";

const encoder = new TextEncoder();
const originalDomParser = globalThis.DOMParser;

function text(value: string) {
  return encoder.encode(value);
}

function xml(value: string) {
  return value.replace(/>\s+</g, "><").trim();
}

function browserDocument(source: string): Document {
  const parsed = parseHTML(source);
  const document = parsed.document as unknown as Document;
  const elements = [document.documentElement, ...document.querySelectorAll("*")].filter(Boolean);
  for (const element of elements) {
    const localName = element.localName.includes(":")
      ? element.localName.split(":").at(-1)
      : element.localName === "navpoint"
        ? "navPoint"
        : element.localName;
    Object.defineProperty(element, "localName", {
      configurable: true,
      value: localName,
    });
    Object.defineProperty(element, "getElementsByTagName", {
      configurable: true,
      value: (name: string) => (name === "*" ? element.querySelectorAll("*") : []),
    });
    for (const attribute of Array.from(element.attributes)) {
      Object.defineProperty(attribute, "localName", {
        configurable: true,
        value: attribute.name.split(":").at(-1),
      });
    }
  }
  Object.defineProperty(document, "getElementsByTagName", {
    configurable: true,
    value: (name: string) => (name === "*" ? document.querySelectorAll("*") : []),
  });
  return document;
}

class TestDomParser {
  parseFromString(source: string): Document {
    return browserDocument(source.includes("INVALID_XML") ? "<parsererror />" : source);
  }
}

beforeEach(() => {
  Reflect.set(globalThis, "DOMParser", TestDomParser);
});

afterEach(() => {
  Reflect.set(globalThis, "DOMParser", originalDomParser);
});

describe("EPUB parsing", () => {
  it("falls back to an OPF entry when the browser XML parser throws", () => {
    class ThrowingDomParser {
      parseFromString(): Document {
        throw new Error("fabricated parser failure");
      }
    }
    Reflect.set(globalThis, "DOMParser", ThrowingDomParser);

    expect(opfPath({
      "META-INF/container.xml": text("<container />"),
      "Fallback.OPF": text("<package />"),
    })).toBe("Fallback.OPF");
  });

  it("resolves encoded EPUB references and preserves malformed escapes", () => {
    expect(hrefToPath("OPS/book.opf", "Text/Chapter%201.xhtml#start")).toBe("OPS/Text/Chapter 1.xhtml");
    expect(hrefToPath("OPS/book.opf", "Text/Notes%3A%20one.xhtml")).toBe("OPS/Text/Notes: one.xhtml");
    expect(hrefToPath("OPS/book.opf", "Text/%ZZ.xhtml")).toBe("OPS/Text/%ZZ.xhtml");
  });

  it("uses the declared OPF when available and finds a fallback in a malformed container", () => {
    const declared = {
      "META-INF/container.xml": text(xml(`<container><rootfiles><rootfile full-path="OPS/book.opf" /></rootfiles></container>`)),
      "OPS/book.opf": text("<package />"),
      "other.opf": text("<package />"),
    };
    const fallback = {
      "META-INF/container.xml": text("<container><rootfile full-path='missing.opf'></container>"),
      "Book.OPF": text("<package />"),
    };
    expect(opfPath(declared)).toBe("OPS/book.opf");
    expect(opfPath(fallback)).toBe("Book.OPF");
    expect(opfPath({ "META-INF/container.xml": text("<container />") })).toBeNull();
  });

  it("keeps OPF spine order, EPUB 3 navigation titles, NCX fallbacks, and its cover", () => {
    const files = {
      "META-INF/container.xml": text(xml(`<container><rootfiles><rootfile full-path="OPS/book.opf" /></rootfiles></container>`)),
      "OPS/book.opf": text(xml(`
        <package xmlns:dc="http://purl.org/dc/elements/1.1/">
          <metadata><dc:title>Ordered book</dc:title><dc:creator>Author</dc:creator></metadata>
          <manifest>
            <item id="two" href="Text/Chapter%202.xhtml" media-type="application/xhtml+xml" />
            <item id="one" href="Text/Chapter%201.xhtml" media-type="application/xhtml+xml" />
            <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml" />
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
            <item id="cover" href="Images/cover.png" properties="cover-image" media-type="image/png" />
          </manifest>
          <spine><itemref idref="two" /><itemref idref="nav" /><itemref idref="one" /></spine>
        </package>
      `)),
      "OPS/Text/Chapter 1.xhtml": text("<html><body>one</body></html>"),
      "OPS/Text/Chapter 2.xhtml": text("<html><body>two</body></html>"),
      "OPS/nav.xhtml": text(xml(`
        <html xmlns:epub="http://www.idpf.org/2007/ops"><body>
          <nav epub:type="toc"><a href="Text/Chapter%202.xhtml">Second title</a></nav>
          <nav><a href="Text/Chapter%201.xhtml">First title</a></nav>
        </body></html>
      `)),
      "OPS/toc.ncx": text(xml(`
        <ncx><navMap>
          <navPoint><navLabel><text>NCX first</text></navLabel><content src="Text/Chapter%201.xhtml" /></navPoint>
          <navPoint><navLabel><text>NCX second</text></navLabel><content src="Text/Chapter%202.xhtml" /></navPoint>
        </navMap></ncx>
      `)),
      "OPS/Images/cover.png": new Uint8Array([137, 80, 78, 71]),
    };

    expect(parseEpub(files)).toEqual({
      title: "Ordered book",
      author: "Author",
      chapters: [
        { path: "OPS/Text/Chapter 2.xhtml", title: "Second title" },
        { path: "OPS/Text/Chapter 1.xhtml", title: "NCX first" },
      ],
      cover: "data:image/png;base64,iVBORw==",
    });
  });

  it("opens books with no usable spine and chooses a cover image by name", () => {
    const files = {
      "book.opf": text(xml(`
        <package><metadata><title>Fallback</title></metadata><manifest>
          <item id="cover" href="cover.jpg" media-type="image/jpeg" />
        </manifest><spine><itemref idref="gone" /></spine></package>
      `)),
      "z.xhtml": text("<html />"),
      "a.html": text("<html />"),
      "META-INF/ignored.xhtml": text("<html />"),
      "cover.jpg": new Uint8Array([255, 216, 255]),
    };

    expect(parseEpub(files)).toEqual({
      title: "Fallback",
      author: "",
      chapters: [
        { path: "a.html", title: "Section 1" },
        { path: "z.xhtml", title: "Section 2" },
      ],
      cover: "data:image/jpeg;base64,/9j/",
    });
    expect(parseEpub({ "book.opf": text("INVALID_XML") })).toBeNull();
  });

  it("inlines chapter images, stylesheet assets, inline styles, and removes scripts", () => {
    const files = {
      "OPS/Text/chapter.xhtml": text(xml(`
        <html><head>
          <link rel="stylesheet alternate" href="../styles/book.css" />
          <link rel="icon" href="icon.ico" />
          <style>.inline { color: red; }</style>
          <script>window.bad = true;</script>
        </head><body><img src="../images/pic.png" /><image href="missing.svg" /><img src="data:image/png;base64,kept" /><p>Words</p></body></html>
      `)),
      "OPS/styles/book.css": text("@font-face{src:url('../fonts/book.woff2')} .image{background:url('../images/pic.png')} .missing{background:url(missing.png)} .remote{src:url(https://example.test/font)}"),
      "OPS/images/pic.png": new Uint8Array([1, 2, 3]),
      "OPS/fonts/book.woff2": new Uint8Array([4, 5, 6]),
    };
    const html = chapterHtml(files, "OPS/Text/chapter.xhtml", 1.2, true);

    expect(html).toContain("data:image/png;base64,AQID");
    expect(html).toContain("data:font/woff2;base64,BAUG");
    expect(html).toContain("url()");
    expect(html).toContain("url(https://example.test/font)");
    expect(html).toContain(".inline { color: red; }");
    expect(html).toContain("data:image/png;base64,kept");
    expect(html).not.toContain("missing.svg");
    expect(html).not.toContain("window.bad");
    expect(html).toContain("color-scheme: dark");
    expect(html).toContain("font-size: 1.26rem");
  });

  it("escapes an unparseable chapter and applies the requested light reader chrome", () => {
    const html = chapterHtml(
      { "broken.xhtml": text("INVALID_XML words <tag & more") },
      "broken.xhtml",
      0.8,
      false,
    );
    expect(html).toContain("<pre>INVALID_XML words &lt;tag &amp; more</pre>");
    expect(html).toContain("color-scheme: light");
    expect(html).toContain("font-size: 0.84rem");
  });
});
