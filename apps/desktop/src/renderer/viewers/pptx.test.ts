import { DOMParser } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePptx, slideOrder } from "./pptx";

const originalDomParser = globalThis.DOMParser;
const encode = (value: string) => new TextEncoder().encode(value);

function makeDescendantLookup(document: Document): void {
  for (const node of [
    document,
    ...Array.from(document.querySelectorAll("*")),
  ]) {
    Object.defineProperty(node, "getElementsByTagName", {
      configurable: true,
      value: (name: string) => node.querySelectorAll(name),
    });
  }
}

class TestDomParser {
  parseFromString(value: string, _mime: DOMParserSupportedType): Document {
    if (value === "__parser_throws__") throw new Error("invalid XML");
    const source = value || "<root><parsererror/></root>";
    const document = new DOMParser().parseFromString(
      source,
      "text/xml",
    ) as unknown as Document;
    makeDescendantLookup(document);
    return document;
  }
}

beforeEach(() => {
  Reflect.set(globalThis, "DOMParser", TestDomParser);
});

afterEach(() => {
  if (originalDomParser === undefined)
    Reflect.deleteProperty(globalThis, "DOMParser");
  else Reflect.set(globalThis, "DOMParser", originalDomParser);
});

function parts(
  values: Record<string, string | Uint8Array>,
): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(values).map(([path, value]) => [
      path,
      typeof value === "string" ? encode(value) : value,
    ]),
  );
}

function mainDeckParts(): Record<string, Uint8Array> {
  return parts({
    "ppt/presentation.xml": `
      <presentation><sldSz cx="1000" cy="500"/><sldIdLst>
        <sldId id2="second"/><sldId id="first"/><sldId id2="absent"/><sldId/>
      </sldIdLst></presentation>`,
    "ppt/_rels/presentation.xml.rels": `
      <Relationships>
        <Relationship Id="first" Target="slides/slide1.xml"/>
        <Relationship Id="second" Target="slides/slide2.xml"/>
        <Relationship Id="absent" Target="slides/slide3.xml"/>
        <Relationship Target="slides/ignored.xml"/>
        <Relationship Id="ignored"/>
      </Relationships>`,
    "ppt/slides/slide1.xml": `
      <sld>
        <sp><spPr><xfrm><off x="100" y="50"/><ext cx="500" cy="100"/></xfrm></spPr><txBody>
          <p><pPr lvl="2" algn="ctr"><buChar/></pPr><r><rPr b="1" i="1" u="sng" sz="2400"><solidFill><srgbClr val="FF0000"/></solidFill></rPr><t>Rich</t></r><br/><fld><t> field</t></fld><endParaRPr/></p>
          <p><pPr algn="r"><buNone/></pPr><r><rPr u="none" sz="bad"><solidFill><srgbClr val="bad"/></solidFill></rPr><t>Right</t></r></p>
          <p><pPr algn="just"/><r><t>Justified</t></r></p>
          <p><pPr algn="l"><buChar/></pPr><r><rPr><solidFill/></rPr><t>Left</t></r></p>
          <p><pPr algn="distributed"/><r><rPr u=""/><t>Unknown</t></r></p>
          <p><r><t>Inherited</t></r></p>
          <p><pPr/><r><t>Plain</t></r></p>
          <p><pPr/><r><t/></r></p>
          <p><pPr/><endParaRPr/></p>
        </txBody></sp>
        <sp><spPr><xfrm><off x="100"/><ext cx="300" cy="100"/></xfrm></spPr><txBody><p><r><t>Fallback</t></r></p></txBody></sp>
        <sp><spPr/><txBody><p><r><t>Stacked</t></r></p></txBody></sp>
        <sp><spPr/><txBody><p><r/></p></txBody></sp>
        <sp><spPr/></sp>
        <pic><spPr><xfrm><off x="300" y="100"/><ext cx="200" cy="200"/></xfrm></spPr><blipFill><blip embed="png"/></blipFill></pic>
        <pic><blipFill><blip embed="emf"/></blipFill></pic>
        <pic><blipFill><blip embed="missing"/></blipFill></pic>
        <pic><blipFill/></pic>
        <graphicFrame><xfrm><off x="0" y="300"/><ext cx="100" cy="100"/></xfrm><graphic><graphicData uri="http://schemas/chart"/></graphic></graphicFrame>
        <graphicFrame><graphic><graphicData uri="http://schemas/table"/></graphic></graphicFrame>
        <graphicFrame><graphic><graphicData uri="http://schemas/table"/></graphic><txBody><p><r><t>Cell text</t></r></p></txBody></graphicFrame>
        <graphicFrame><graphic><graphicData uri="http://schemas/diagram"/></graphic></graphicFrame>
        <graphicFrame><graphic/></graphicFrame>
      </sld>`,
    "ppt/slides/_rels/slide1.xml.rels": `
      <Relationships>
        <Relationship Id="png" Target="../media/photo.png"/>
        <Relationship Id="emf" Target="../media/vector.emf"/>
        <Relationship Id="missing" Target="../media/missing.jpg"/>
        <Relationship Id="notes" Target="../notesSlides/notesSlide1.xml"/>
      </Relationships>`,
    "ppt/notesSlides/notesSlide1.xml":
      "<notes><t>First note</t><t>second note</t></notes>",
    "PPT/MEDIA/PHOTO.PNG": Uint8Array.of(1, 2, 3),
    "ppt/slides/slide2.xml": "<sld><sp><spPr/></sp></sld>",
    "ppt/slides/_rels/slide2.xml.rels":
      '<Relationships><Relationship Id="notes" Target="../notesSlides/missing.xml"/></Relationships>',
    "ppt/slides/slide3.xml": "<root><parsererror/></root>",
  });
}

describe("slideOrder", () => {
  it("uses presentation relationships in spine order and falls back to numbered parts", () => {
    const deck = mainDeckParts();
    expect(slideOrder(deck)).toEqual([
      "ppt/slides/slide2.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/slide3.xml",
    ]);

    expect(
      slideOrder(
        parts({
          "ppt/slides/slide10.xml": "<sld/>",
          "ppt/slides/slide2.xml": "<sld/>",
          "ppt/slides/slide1.xml": "<sld/>",
          "ppt/slides/not-a-slide.xml": "<sld/>",
        }),
      ),
    ).toEqual([
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      "ppt/slides/slide10.xml",
    ]);
  });
});

describe("parsePptx", () => {
  it("keeps slide order while parsing text, media, object placeholders, notes, and geometry fallbacks", () => {
    const deck = parsePptx(mainDeckParts());

    expect(deck.aspect).toBe(2);
    expect(deck.slides.map((slide) => slide.number)).toEqual([1, 2]);
    const [emptySlide, richSlide] = deck.slides;
    expect(emptySlide).toMatchObject({ shapes: [], notes: "", text: "" });
    expect(richSlide.notes).toBe("First note second note");
    expect(richSlide.text).toContain("Rich\n field");
    expect(richSlide.text).toContain("Cell text");

    const textShapes = richSlide.shapes.filter(
      (shape) => shape.kind === "text",
    );
    expect(textShapes[0]).toMatchObject({ x: 0.1, y: 0.1, w: 0.5, h: 0.2 });
    expect(textShapes[1]).toMatchObject({ x: 0.08, y: 0.22, w: 0.84, h: 0.1 });
    expect(textShapes[2]).toMatchObject({ x: 0.08, w: 0.84, h: 0.1 });
    expect(textShapes[2].y).toBeCloseTo(0.34);

    const paragraphs = textShapes[0].paragraphs;
    expect(paragraphs).toHaveLength(7);
    expect(paragraphs?.map((paragraph) => paragraph.align)).toEqual([
      "center",
      "right",
      "justify",
      "left",
      null,
      null,
      null,
    ]);
    expect(paragraphs?.map((paragraph) => paragraph.bullet)).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(paragraphs?.[0].runs).toEqual([
      {
        text: "Rich",
        bold: true,
        italic: true,
        underline: true,
        sizePt: 24,
        color: "#FF0000",
      },
      {
        text: "\n",
        bold: false,
        italic: false,
        underline: false,
        sizePt: null,
        color: null,
      },
      {
        text: " field",
        bold: false,
        italic: false,
        underline: false,
        sizePt: null,
        color: null,
      },
    ]);
    expect(paragraphs?.[1].runs[0]).toMatchObject({
      underline: false,
      sizePt: null,
      color: null,
    });
    expect(paragraphs?.[4].runs[0].underline).toBe(false);

    expect(richSlide.shapes.filter((shape) => shape.kind === "image")).toEqual([
      expect.objectContaining({
        x: 0.3,
        y: 0.2,
        w: 0.2,
        h: 0.4,
        src: "data:image/png;base64,AQID",
      }),
    ]);
    expect(
      richSlide.shapes.filter((shape) => shape.kind === "placeholder"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ note: "EMF image", x: 0.1, y: 0.1 }),
        expect.objectContaining({ note: "missing picture" }),
        expect.objectContaining({ note: "picture" }),
        expect.objectContaining({
          note: "chart",
          x: 0,
          y: 0.6,
          w: 0.1,
          h: 0.2,
        }),
        expect.objectContaining({ note: "table" }),
        expect.objectContaining({ note: "diagram" }),
        expect.objectContaining({ note: "object" }),
      ]),
    );
  });

  it("returns a usable empty deck for malformed or incomplete presentation parts", () => {
    expect(
      parsePptx(
        parts({
          "ppt/presentation.xml":
            '<presentation><sldSz cx="100" cy="0"/></presentation>',
        }),
      ),
    ).toEqual({ aspect: 12_192_000 / 6_858_000, slides: [] });
    expect(
      parsePptx(parts({ "ppt/presentation.xml": "__parser_throws__" })),
    ).toEqual({
      aspect: 12_192_000 / 6_858_000,
      slides: [],
    });
    expect(
      parsePptx(
        parts({
          "ppt/presentation.xml":
            '<presentation><sldId id2="slide"/></presentation>',
          "ppt/_rels/presentation.xml.rels":
            '<Relationships><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
          "ppt/slides/slide1.xml": "<sld/>",
        }),
      ).slides[0],
    ).toMatchObject({ number: 1, notes: "", shapes: [], text: "" });
  });
});
