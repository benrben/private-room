/** A saved message, reduced to what a reader needs.
 *
 * The mirror of `extraction/data.rs`'s `extract_eml` on the Rust side: that one
 * derives the text search and the model read, this one drives the screen. They
 * make the same decisions (prefer `text/plain`, decode quoted-printable and
 * base64, decode RFC-2047 encoded words) so what you see and what the AI was
 * given can't disagree. Kept dependency-free and DOM-free so it is unit-tested
 * directly under `npm run test:page`.
 */
export interface ParsedEmail {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  body: string;
  attachments: { name: string; sizeHint: string }[];
}

/** Split at the first blank line. A message with no body is still valid. */
function splitHeaders(raw: string): [string, string] {
  const text = raw.replace(/^﻿/, "");
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  let at = -1;
  let skip = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    at = crlf;
    skip = 4;
  } else if (lf >= 0) {
    at = lf;
    skip = 2;
  }
  if (at < 0) return [unfold(text), ""];
  return [unfold(text.slice(0, at)), text.slice(at + skip)];
}

/** RFC 5322 folding: a header continued on the next line by leading
 * whitespace. Unfolded first so a wrapped Subject reads as one value. */
function unfold(headers: string): string {
  const out: string[] = [];
  for (const line of headers.split("\n")) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += " " + line.trim();
    else out.push(line.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

function header(headers: string, name: string): string {
  const want = name.toLowerCase() + ":";
  for (const line of headers.split("\n")) {
    if (line.toLowerCase().startsWith(want)) {
      return decodeMimeWords(line.slice(want.length).trim());
    }
  }
  return "";
}

function boundaryOf(contentType: string): string | null {
  if (!contentType.toLowerCase().startsWith("multipart/")) return null;
  const m = /boundary=("([^"]*)"|[^;\s]+)/i.exec(contentType);
  const value = m ? (m[2] ?? m[1]) : "";
  return value || null;
}

/** `=XX` hex escapes and `=` soft line breaks. Bytes are collected first and
 * decoded as UTF-8 at the end, so a multi-byte character split across two
 * escapes survives — the bug that turned "siège" into "si ge". */
function quotedPrintableLine(line: string) {
  const withoutCarriageReturn = line.replace(/\r$/, "");
  const soft = withoutCarriageReturn.endsWith("=");
  return { content: soft ? withoutCarriageReturn.slice(0, -1) : withoutCarriageReturn, soft };
}

function hexEscapeAt(text: string, index: number): string | null {
  if (text[index] !== "=" || index + 2 >= text.length) return null;
  const hex = text.slice(index + 1, index + 3);
  return /^[0-9a-fA-F]{2}$/.test(hex) ? hex : null;
}

function appendUtf8Bytes(bytes: number[], character: string) {
  for (const byte of new TextEncoder().encode(character)) bytes.push(byte);
}

function appendQuotedPrintableContent(bytes: number[], content: string) {
  for (let index = 0; index < content.length; index++) {
    const hex = hexEscapeAt(content, index);
    if (hex) {
      bytes.push(parseInt(hex, 16));
      index += 2;
      continue;
    }
    appendUtf8Bytes(bytes, content[index]);
  }
}

function needsLineBreak(soft: boolean, lineIndex: number, lineCount: number) {
  return !soft && lineIndex < lineCount - 1;
}

export function decodeQuotedPrintable(source: string): string {
  const bytes: number[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = quotedPrintableLine(lines[index]);
    appendQuotedPrintableContent(bytes, line.content);
    if (needsLineBreak(line.soft, index, lines.length)) bytes.push(10);
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

export function decodeBase64Text(s: string): string {
  try {
    const packed = s.replace(/\s+/g, "");
    if (!packed) return "";
    const binary = atob(packed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return s;
  }
}

/** RFC 2047 `=?utf-8?B?…?=` encoded words — how a non-ASCII Subject or display
 * name reaches the file. */
export function decodeMimeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_all, _charset: string, enc: string, body: string) =>
      enc.toUpperCase() === "B"
        ? decodeBase64Text(body)
        : // In an encoded word, `_` means space.
          decodeQuotedPrintable(body.replace(/_/g, " ")),
  );
}

function decodeTransfer(headers: string, body: string): string {
  switch (header(headers, "Content-Transfer-Encoding").trim().toLowerCase()) {
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    case "base64":
      return decodeBase64Text(body);
    default:
      return body;
  }
}

/** Tags out, entities decoded — for the HTML-only messages that have no plain
 * alternative. Deliberately minimal: the result is shown as TEXT, never
 * injected as markup, so nothing here has to be a sanitizer. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function filenameOf(headers: string): string {
  const disp = header(headers, "Content-Disposition");
  const type = header(headers, "Content-Type");
  const m = /(?:file)?name=("([^"]*)"|[^;\s]+)/i.exec(disp) ?? /name=("([^"]*)"|[^;\s]+)/i.exec(type);
  return m ? decodeMimeWords(m[2] ?? m[1]) : "";
}

type BodyCandidates = {
  plain: string;
  htmlFallback: string;
  nested: string;
};

function decodeLeaf(headers: string, body: string, contentType: string): string {
  const decoded = decodeTransfer(headers, body);
  return contentType.toLowerCase().startsWith("text/html") ? stripHtml(decoded) : decoded;
}

function bodyCandidates(): BodyCandidates {
  return { plain: "", htmlFallback: "", nested: "" };
}

function attachPart(headers: string, body: string, out: ParsedEmail) {
  const name = filenameOf(headers);
  const rawLength = body.replace(/\s+/g, "").length;
  out.attachments.push({
    name: name || "(unnamed attachment)",
    sizeHint: rawLength ? `${Math.round((rawLength * 3) / 4 / 1024).toLocaleString()} KB` : "",
  });
}

function isAttachment(headers: string, contentType: string): boolean {
  const disposition = header(headers, "Content-Disposition").toLowerCase();
  const name = filenameOf(headers);
  return disposition.startsWith("attachment") || (name !== "" && !contentType.startsWith("text/"));
}

function recordTextBody(
  headers: string,
  body: string,
  contentType: string,
  candidates: BodyCandidates,
) {
  const decoded = decodeTransfer(headers, body);
  if (contentType.startsWith("text/plain") && !candidates.plain) {
    candidates.plain = decoded;
    return;
  }
  if (contentType.startsWith("text/html") && !candidates.htmlFallback) {
    candidates.htmlFallback = stripHtml(decoded);
  }
}

function recordNestedBody(headers: string, body: string, out: ParsedEmail, candidates: BodyCandidates) {
  const nested = walk(headers, body, out);
  if (nested.trim() && !candidates.nested) candidates.nested = nested;
}

function visitMultipartPart(chunk: string, out: ParsedEmail, candidates: BodyCandidates) {
  const part = chunk.replace(/^--/, "");
  if (!part.trim()) return;
  const [headers, body] = splitHeaders(part);
  const contentType = header(headers, "Content-Type").toLowerCase();
  if (contentType.startsWith("multipart/")) {
    recordNestedBody(headers, body, out, candidates);
    return;
  }
  if (isAttachment(headers, contentType)) {
    attachPart(headers, body, out);
    return;
  }
  recordTextBody(headers, body, contentType, candidates);
}

function preferredBody(candidates: BodyCandidates): string {
  return candidates.plain || candidates.nested || candidates.htmlFallback;
}

function walkMultipart(boundary: string, body: string, out: ParsedEmail): string {
  const candidates = bodyCandidates();
  for (const chunk of body.split("--" + boundary).slice(1)) {
    visitMultipartPart(chunk, out, candidates);
  }
  return preferredBody(candidates);
}

function walk(headers: string, body: string, out: ParsedEmail): string {
  const contentType = header(headers, "Content-Type");
  const boundary = boundaryOf(contentType);
  return boundary ? walkMultipart(boundary, body, out) : decodeLeaf(headers, body, contentType);
}

export function parseEml(raw: string): ParsedEmail {
  const [headers, body] = splitHeaders(raw);
  const out: ParsedEmail = {
    subject: header(headers, "Subject"),
    from: header(headers, "From"),
    to: header(headers, "To"),
    cc: header(headers, "Cc"),
    date: header(headers, "Date"),
    body: "",
    attachments: [],
  };
  out.body = walk(headers, body, out);
  return out;
}
