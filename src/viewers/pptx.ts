import {
  bytesToText,
  findEntry,
  isRenderableImage,
  mimeForPath,
  resolvePath,
  toDataUrl,
} from "./zipdoc";

/** One run of text inside a paragraph, with the formatting that changes how it
 * reads (a slide title vs. a footnote). */
export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Point size, or null to inherit the shape's default. */
  sizePt: number | null;
  color: string | null;
}

export interface Paragraph {
  runs: Run[];
  /** Outline depth — bullets are indented by it. */
  level: number;
  align: "left" | "center" | "right" | "justify" | null;
  bullet: boolean;
}

/** A positioned box on a slide. Coordinates are FRACTIONS of the slide, so the
 * renderer scales to whatever width the pane happens to be. */
export interface Shape {
  kind: "text" | "image" | "placeholder";
  x: number;
  y: number;
  w: number;
  h: number;
  paragraphs?: Paragraph[];
  src?: string;
  /** Why an image isn't shown (EMF/WMF, or a missing part). */
  note?: string;
}

export interface Slide {
  number: number;
  shapes: Shape[];
  /** The speaker notes, as plain text. */
  notes: string;
  /** Every word on the slide — for the deck's own find, and for the outline. */
  text: string;
}

export interface Deck {
  /** Slide aspect ratio, width / height. */
  aspect: number;
  slides: Slide[];
}

/** Default 16:9 at 12,192,000 × 6,858,000 EMU, which is what PowerPoint writes
 * when a deck doesn't say otherwise. */
const DEFAULT_ASPECT = 12_192_000 / 6_858_000;

function parseXml(text: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    return doc.querySelector("parsererror") ? null : doc;
  } catch {
    return null;
  }
}

/** Local-name lookup. OOXML is namespaced (`a:`, `p:`, `r:`) and
 * `getElementsByTagName` with a prefix is unreliable across parsers, so every
 * lookup here goes by local name. */
function kids(el: Element, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local);
}
function descendants(root: Element | Document, local: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((e) => e.localName === local);
}
function firstKid(el: Element, local: string): Element | null {
  return kids(el, local)[0] ?? null;
}
/** An attribute by local name, whatever prefix it carries (`r:embed`). */
function attr(el: Element, local: string): string | null {
  for (const a of Array.from(el.attributes)) {
    if (a.localName === local) return a.value;
  }
  return null;
}
function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** `<a:srgbClr val="FF0000"/>` anywhere under this element. */
function colorUnder(el: Element | null): string | null {
  if (!el) return null;
  const c = descendants(el, "srgbClr")[0];
  const val = c ? attr(c, "val") : null;
  return val && /^[0-9a-fA-F]{6}$/.test(val) ? `#${val}` : null;
}

function readParagraphs(txBody: Element): Paragraph[] {
  const out: Paragraph[] = [];
  for (const p of kids(txBody, "p")) {
    const pPr = firstKid(p, "pPr");
    const level = num(pPr ? attr(pPr, "lvl") : null) ?? 0;
    const rawAlign = pPr ? attr(pPr, "algn") : null;
    const align =
      rawAlign === "ctr"
        ? "center"
        : rawAlign === "r"
          ? "right"
          : rawAlign === "just"
            ? "justify"
            : rawAlign === "l"
              ? "left"
              : null;
    // `<a:buNone/>` is how a paragraph opts OUT; anything else at level 0+
    // inside a body placeholder is bulleted by the layout.
    const bullet = !!pPr && !firstKid(pPr, "buNone") && (level > 0 || !!firstKid(pPr, "buChar"));
    const runs: Run[] = [];
    for (const child of Array.from(p.children)) {
      if (child.localName === "br") {
        runs.push({
          text: "\n",
          bold: false,
          italic: false,
          underline: false,
          sizePt: null,
          color: null,
        });
        continue;
      }
      // `<a:fld>` is a field (slide number, date) and carries text like a run.
      if (child.localName !== "r" && child.localName !== "fld") continue;
      const t = firstKid(child, "t");
      const text = t?.textContent ?? "";
      if (!text) continue;
      const rPr = firstKid(child, "rPr");
      const sz = num(rPr ? attr(rPr, "sz") : null);
      runs.push({
        text,
        bold: (rPr && attr(rPr, "b")) === "1",
        italic: (rPr && attr(rPr, "i")) === "1",
        underline: !!rPr && !!attr(rPr, "u") && attr(rPr, "u") !== "none",
        // OOXML stores size in hundredths of a point.
        sizePt: sz != null ? sz / 100 : null,
        color: colorUnder(rPr),
      });
    }
    if (runs.length) out.push({ runs, level, align, bullet });
  }
  return out;
}

/** Position + size, as fractions of the slide. Returns null for a shape with
 * no explicit geometry (it inherits from the layout, which this renderer
 * deliberately does not resolve — see the note in `parsePptx`). */
function readFrame(
  sp: Element,
  slideW: number,
  slideH: number,
): { x: number; y: number; w: number; h: number } | null {
  const xfrm = descendants(sp, "xfrm")[0];
  if (!xfrm) return null;
  const off = firstKid(xfrm, "off");
  const ext = firstKid(xfrm, "ext");
  const x = num(off ? attr(off, "x") : null);
  const y = num(off ? attr(off, "y") : null);
  const cx = num(ext ? attr(ext, "cx") : null);
  const cy = num(ext ? attr(ext, "cy") : null);
  if (x == null || y == null || cx == null || cy == null) return null;
  return { x: x / slideW, y: y / slideH, w: cx / slideW, h: cy / slideH };
}

/** relationship id → target path, resolved against the slide part. */
function readRels(files: Record<string, Uint8Array>, partPath: string): Map<string, string> {
  const dir = partPath.slice(0, partPath.lastIndexOf("/"));
  const file = partPath.slice(partPath.lastIndexOf("/") + 1);
  const relsPath = `${dir}/_rels/${file}.rels`;
  const doc = parseXml(bytesToText(findEntry(files, relsPath)));
  const out = new Map<string, string>();
  if (!doc) return out;
  for (const rel of descendants(doc, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    // Resolved against the PART, not against the `_rels` folder the mapping
    // happens to live in. `../media/image1.png` in
    // `ppt/slides/_rels/slide1.xml.rels` means `ppt/media/image1.png`;
    // resolving it against the rels folder yields `ppt/slides/media/…`, which
    // exists in no deck — every picture would silently go missing.
    if (id && target) out.set(id, resolvePath(partPath, target));
  }
  return out;
}

/** Slide parts, in presentation order.
 *
 * Sorting by the number in the filename is right for every deck PowerPoint
 * writes; a deck whose slides were reordered still names them slide1..slideN
 * in spine order inside presentation.xml, which is read first when available.
 */
export function slideOrder(files: Record<string, Uint8Array>): string[] {
  const byRel = (() => {
    const rels = readRels(files, "ppt/presentation.xml");
    const doc = parseXml(bytesToText(findEntry(files, "ppt/presentation.xml")));
    if (!doc) return [];
    return descendants(doc, "sldId")
      .map((s) => attr(s, "id2") ?? attr(s, "id"))
      .map((id) => (id ? rels.get(id) : undefined))
      .filter((p): p is string => !!p && !!findEntry(files, p));
  })();
  if (byRel.length) return byRel;
  return Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const n = (s: string) => Number(/slide(\d+)\.xml$/.exec(s)?.[1] ?? 0);
      return n(a) - n(b);
    });
}

/**
 * Read a deck into positioned slides.
 *
 * Scope, stated plainly: this renders TEXT and PICTURES at their real
 * positions, which is what a deck is read for. It does not resolve slide
 * layouts and masters, so a background graphic or a theme's placeholder
 * styling won't appear, and it does not draw charts, SmartArt or autoshape
 * geometry — those become labelled placeholders rather than silent gaps. That
 * is a large step up from where this format was, which was no viewer at all:
 * a `.pptx` opened as a wall of undifferentiated slide text.
 */
export function parsePptx(files: Record<string, Uint8Array>): Deck {
  const presentation = parseXml(bytesToText(findEntry(files, "ppt/presentation.xml")));
  const sldSz = presentation ? descendants(presentation, "sldSz")[0] : null;
  const slideW = num(sldSz ? attr(sldSz, "cx") : null) ?? 12_192_000;
  const slideH = num(sldSz ? attr(sldSz, "cy") : null) ?? 6_858_000;
  const aspect = slideH > 0 ? slideW / slideH : DEFAULT_ASPECT;

  const slides: Slide[] = [];
  for (const [i, path] of slideOrder(files).entries()) {
    const doc = parseXml(bytesToText(findEntry(files, path)));
    if (!doc) continue;
    const rels = readRels(files, path);
    const shapes: Shape[] = [];

    // Text boxes and placeholders.
    for (const sp of descendants(doc, "sp")) {
      const txBody = descendants(sp, "txBody")[0];
      if (!txBody) continue;
      const paragraphs = readParagraphs(txBody);
      if (!paragraphs.length) continue;
      const frame = readFrame(sp, slideW, slideH);
      shapes.push({
        kind: "text",
        // A shape with no geometry of its own inherits it from the layout.
        // Rather than drop it, stack it down the middle where it is at least
        // readable and obviously part of the slide.
        x: frame?.x ?? 0.08,
        y: frame?.y ?? 0.1 + shapes.length * 0.12,
        w: frame?.w ?? 0.84,
        h: frame?.h ?? 0.1,
        paragraphs,
      });
    }

    // Pictures.
    for (const pic of descendants(doc, "pic")) {
      const blip = descendants(pic, "blip")[0];
      const id = blip ? attr(blip, "embed") : null;
      const target = id ? rels.get(id) : undefined;
      const frame = readFrame(pic, slideW, slideH) ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      if (!target) {
        shapes.push({ kind: "placeholder", ...frame, note: "picture" });
        continue;
      }
      if (!isRenderableImage(target)) {
        // EMF/WMF are common in decks and no browser draws them. Saying so
        // beats a broken-image glyph.
        shapes.push({
          kind: "placeholder",
          ...frame,
          note: `${target.slice(target.lastIndexOf(".") + 1).toUpperCase()} image`,
        });
        continue;
      }
      const bytes = findEntry(files, target);
      if (!bytes) {
        shapes.push({ kind: "placeholder", ...frame, note: "missing picture" });
        continue;
      }
      shapes.push({ kind: "image", ...frame, src: toDataUrl(bytes, mimeForPath(target)) });
    }

    // Charts, tables and SmartArt: named, not silently dropped.
    for (const frameEl of descendants(doc, "graphicFrame")) {
      const uri = descendants(frameEl, "graphicData")[0];
      const kindUri = uri ? attr(uri, "uri") ?? "" : "";
      const label = kindUri.includes("chart")
        ? "chart"
        : kindUri.includes("table")
          ? "table"
          : kindUri.includes("diagram")
            ? "diagram"
            : "object";
      // A table's cells DO carry readable text — pull it in rather than
      // reducing a whole comparison table to the word "table".
      const cells = descendants(frameEl, "txBody").flatMap(readParagraphs);
      const frame = readFrame(frameEl, slideW, slideH) ?? { x: 0.1, y: 0.5, w: 0.8, h: 0.35 };
      if (cells.length) shapes.push({ kind: "text", ...frame, paragraphs: cells });
      else shapes.push({ kind: "placeholder", ...frame, note: label });
    }

    // Speaker notes live in their own part, linked from the slide's rels.
    const notesPath = Array.from(rels.values()).find((p) => p.includes("notesSlide"));
    const notesDoc = notesPath ? parseXml(bytesToText(findEntry(files, notesPath))) : null;
    const notes = notesDoc
      ? descendants(notesDoc, "t")
          .map((t) => t.textContent ?? "")
          .join(" ")
          .trim()
      : "";

    const text = shapes
      .flatMap((s) => s.paragraphs ?? [])
      .map((p) => p.runs.map((r) => r.text).join(""))
      .join("\n");

    slides.push({ number: i + 1, shapes, notes, text });
  }
  return { aspect, slides };
}
