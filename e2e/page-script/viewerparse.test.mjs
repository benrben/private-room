/* The pure parsers behind the new viewers: saved mail, subtitles, and the
 * shared zip-container helpers used by the deck and book readers.
 *
 * These run under `npm run test:page` against the REAL TypeScript sources,
 * type-stripped in memory with the `typescript` dev dependency (the same trick
 * address.test.mjs uses). No compiled output, nothing to keep in sync.
 *
 * The email parser has a Rust twin (`extraction/data.rs::extract_eml`) that
 * feeds search and the model while this one feeds the screen. Several cases
 * below are deliberately the same cases the Rust tests assert, because the two
 * disagreeing is exactly the bug that would be invisible: the reader would
 * show a decoded body while the AI was handed base64.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

async function load(relPath) {
  const source = readFileSync(join(root, relPath), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const { parseEml, decodeQuotedPrintable, decodeMimeWords } = await load("src/viewers/eml.ts");
const { parseCues, parseStamp, formatStamp, toSrt, toVtt } = await load(
  "src/viewers/subtitles.ts",
);
const { resolvePath, withoutFragment, mimeForPath, isRenderableImage } = await load(
  "src/viewers/zipdoc.ts",
);

// ------------------------------------------------------------------- mail

test("a plain message keeps its headers and body", () => {
  const mail = parseEml("From: a@x.com\r\nTo: b@x.com\r\nSubject: Rent\r\n\r\nThe fee is 5%.\r\n");
  assert.equal(mail.subject, "Rent");
  assert.equal(mail.from, "a@x.com");
  assert.match(mail.body, /The fee is 5%\./);
});

test("a folded subject is read as one value", () => {
  // RFC 5322 folding: a continuation line begins with whitespace. Without
  // unfolding, a long subject is truncated at the wrap.
  const mail = parseEml("Subject: The quarterly\r\n  report is ready\r\nFrom: a@x.com\r\n\r\nhi\r\n");
  assert.equal(mail.subject, "The quarterly report is ready");
});

test("RFC 2047 encoded words are decoded in both spellings", () => {
  assert.equal(decodeMimeWords("=?utf-8?B?15fXqdeR15XXnw==?="), "חשבון");
  // In an encoded word `_` means space — the classic reason a decoded subject
  // comes out with underscores where the spaces should be.
  assert.equal(decodeMimeWords("=?utf-8?Q?two_words?="), "two words");
});

test("quoted-printable survives a multi-byte character split across a soft break", () => {
  // This is the bug that turned "siège" into "si ge": decoding per-line and
  // per-escape rather than collecting bytes and decoding UTF-8 at the end.
  assert.equal(decodeQuotedPrintable("Le si=C3=A8ge so=\r\ncial"), "Le siège social");
});

test("multipart prefers the plain alternative over the HTML one", () => {
  const raw =
    "Subject: Hi\r\nContent-Type: multipart/alternative; boundary=\"xyz\"\r\n\r\n" +
    "--xyz\r\nContent-Type: text/plain\r\n\r\nplain wins\r\n" +
    "--xyz\r\nContent-Type: text/html\r\n\r\n<p>html loses</p>\r\n--xyz--\r\n";
  const mail = parseEml(raw);
  assert.match(mail.body, /plain wins/);
  assert.doesNotMatch(mail.body, /html loses/);
});

test("an HTML-only message is stripped, never shown as markup", () => {
  const mail = parseEml("Subject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>\r\n");
  assert.match(mail.body, /Hello there/);
  assert.doesNotMatch(mail.body, /<b>/);
});

test("attachments are listed, not decoded into the body", () => {
  const raw =
    'Subject: Files\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n' +
    "--b\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n" +
    '--b\r\nContent-Type: application/pdf; name="lease.pdf"\r\n' +
    "Content-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
    "JVBERi0xLjQK\r\n--b--\r\n";
  const mail = parseEml(raw);
  assert.match(mail.body, /See attached\./);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].name, "lease.pdf");
  assert.doesNotMatch(mail.body, /JVBERi/, "a base64 blob leaked into the body");
});

test("a nested multipart/mixed → multipart/alternative still finds the text", () => {
  const raw =
    'Content-Type: multipart/mixed; boundary="out"\r\nSubject: N\r\n\r\n' +
    '--out\r\nContent-Type: multipart/alternative; boundary="in"\r\n\r\n' +
    "--in\r\nContent-Type: text/plain\r\n\r\ndeep text\r\n--in--\r\n--out--\r\n";
  assert.match(parseEml(raw).body, /deep text/);
});

// -------------------------------------------------------------- subtitles

test("SRT cues lose their numbering and timecodes and keep their words", () => {
  const srt =
    "1\n00:00:01,000 --> 00:00:04,000\nGood morning everyone.\n\n" +
    "2\n00:00:04,500 --> 00:00:06,000\nLet's begin.\n";
  const cues = parseCues(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "Good morning everyone.");
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[1].endMs, 6000);
});

test("WebVTT headers, notes and cue settings are handled", () => {
  const vtt = "WEBVTT\n\nNOTE recorded live\n\n00:01.000 --> 00:02.000 line:90%\nHello.\n";
  const cues = parseCues(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Hello.");
  // The trailing "line:90%" setting must not break the end stamp.
  assert.equal(cues[0].endMs, 2000);
});

test("a cue's own line breaks are kept", () => {
  const cues = parseCues("1\n00:00:01,000 --> 00:00:02,000\nline one\nline two\n");
  assert.equal(cues[0].text, "line one\nline two");
});

test("a Windows-authored file doesn't leave a carriage return on every line", () => {
  const cues = parseCues("1\r\n00:00:01,000 --> 00:00:02,000\r\nHello.\r\n");
  assert.equal(cues[0].text, "Hello.");
});

test("a malformed timestamp skips its cue rather than reading as time zero", () => {
  const cues = parseCues("1\nnot a timestamp\nHello.\n\n2\n00:00:05,000 --> 00:00:06,000\nReal.\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Real.");
});

test("stamps round-trip through parse and format", () => {
  assert.equal(parseStamp("01:02:03,450"), 3_723_450);
  assert.equal(formatStamp(3_723_450), "01:02:03,450");
  // WebVTT's short form and its dot separator.
  assert.equal(parseStamp("02:03.450"), 123_450);
});

test("editing a cue's text and re-serializing changes nothing else", () => {
  const original = "1\n00:00:01,000 --> 00:00:04,000\nOld words.\n\n2\n00:00:05,000 --> 00:00:06,000\nKeep.\n";
  const cues = parseCues(original);
  cues[0].text = "New words.";
  const out = toSrt(cues);
  const again = parseCues(out);
  assert.equal(again[0].text, "New words.");
  assert.equal(again[0].startMs, 1000, "timing drifted on a text-only edit");
  assert.equal(again[1].text, "Keep.");
  assert.equal(again[1].endMs, 6000);
});

test("a .vtt saves back as WebVTT, not as SRT", () => {
  // Silently converting the dialect would break whatever player owns the file.
  const out = toVtt(parseCues("1\n00:00:01,000 --> 00:00:02,000\nHi.\n"));
  assert.match(out, /^WEBVTT/);
  assert.match(out, /00:00:01\.000 --> 00:00:02\.000/);
});

// ------------------------------------------------------- zip-container bits

test("relationship targets resolve against the referencing part's folder", () => {
  // The classic reason a deck renders with every picture missing: an OOXML
  // rels target is relative to the PART (ppt/slides/slide1.xml), not to the
  // `_rels` folder the mapping file happens to live in.
  assert.equal(
    resolvePath("ppt/slides/slide1.xml", "../media/image1.png"),
    "ppt/media/image1.png",
  );
  assert.equal(resolvePath("OEBPS/content.opf", "text/ch1.xhtml"), "OEBPS/text/ch1.xhtml");
  assert.equal(resolvePath("OEBPS/text/ch1.xhtml", "../images/a.png"), "OEBPS/images/a.png");
  // A root-relative target and an absolute URL are both left alone.
  assert.equal(resolvePath("a/b.xml", "/ppt/media/x.png"), "ppt/media/x.png");
  assert.equal(resolvePath("a/b.xml", "https://x.com/y.png"), "https://x.com/y.png");
});

test("fragments and queries are stripped from hrefs", () => {
  assert.equal(withoutFragment("ch1.xhtml#section-2"), "ch1.xhtml");
  assert.equal(withoutFragment("ch1.xhtml"), "ch1.xhtml");
});

test("EMF and WMF are recognised as images no browser can draw", () => {
  // They are common in real decks; drawing them yields a broken-image glyph,
  // so the viewer shows a labelled placeholder instead.
  assert.equal(mimeForPath("ppt/media/image3.emf"), "image/emf");
  assert.equal(isRenderableImage("ppt/media/image3.emf"), false);
  assert.equal(isRenderableImage("ppt/media/image3.wmf"), false);
  assert.equal(isRenderableImage("ppt/media/image1.png"), true);
  assert.equal(isRenderableImage("ppt/media/image2.JPEG"), true);
  assert.equal(isRenderableImage("ppt/embeddings/sheet.xlsx"), false);
});
