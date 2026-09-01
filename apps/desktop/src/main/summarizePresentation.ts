import { htmlEscape } from "./docsHtml.js";

const DEFAULT_FILE_GLYPH = "\u{1F4C4}"; // 📄

/** Data table equivalent to Rust's extension switch. */
const FILE_GLYPHS: ReadonlyMap<string, string> = new Map([
  ["pdf", "\u{1F4D5}"], // 📕
  ["csv", "\u{1F4CA}"], // 📊
  ["tsv", "\u{1F4CA}"],
  ["xls", "\u{1F4CA}"],
  ["xlsx", "\u{1F4CA}"],
  ["numbers", "\u{1F4CA}"],
  ["png", "\u{1F5BC}\u{FE0F}"], // 🖼️
  ["jpg", "\u{1F5BC}\u{FE0F}"],
  ["jpeg", "\u{1F5BC}\u{FE0F}"],
  ["gif", "\u{1F5BC}\u{FE0F}"],
  ["webp", "\u{1F5BC}\u{FE0F}"],
  ["svg", "\u{1F5BC}\u{FE0F}"],
  ["heic", "\u{1F5BC}\u{FE0F}"],
  ["tiff", "\u{1F5BC}\u{FE0F}"],
  ["mp3", "\u{1F3A7}"], // 🎧
  ["m4a", "\u{1F3A7}"],
  ["wav", "\u{1F3A7}"],
  ["aac", "\u{1F3A7}"],
  ["flac", "\u{1F3A7}"],
  ["ogg", "\u{1F3A7}"],
  ["aiff", "\u{1F3A7}"],
  ["mp4", "\u{1F3AC}"], // 🎬
  ["mov", "\u{1F3AC}"],
  ["mkv", "\u{1F3AC}"],
  ["webm", "\u{1F3AC}"],
  ["avi", "\u{1F3AC}"],
  ["html", "\u{1F310}"], // 🌐
  ["htm", "\u{1F310}"],
  ["md", "\u{1F4DD}"], // 📝
  ["markdown", "\u{1F4DD}"],
  ["txt", "\u{1F4DD}"],
  ["rtf", "\u{1F4DD}"],
  ["json", "\u{1F5C2}\u{FE0F}"], // 🗂️
  ["yaml", "\u{1F5C2}\u{FE0F}"],
  ["yml", "\u{1F5C2}\u{FE0F}"],
  ["toml", "\u{1F5C2}\u{FE0F}"],
  ["xml", "\u{1F5C2}\u{FE0F}"],
  ["zip", "\u{1F5DC}\u{FE0F}"], // 🗜️
  ["tar", "\u{1F5DC}\u{FE0F}"],
  ["gz", "\u{1F5DC}\u{FE0F}"],
  ["7z", "\u{1F5DC}\u{FE0F}"],
  ["doc", "\u{1F4D8}"], // 📘
  ["docx", "\u{1F4D8}"],
  ["pages", "\u{1F4D8}"],
  ["ppt", "\u{1F4FD}\u{FE0F}"], // 📽️
  ["pptx", "\u{1F4FD}\u{FE0F}"],
  ["key", "\u{1F4FD}\u{FE0F}"],
]);

/** Return the summary-list glyph associated with a file extension. */
export function fileGlyph(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return FILE_GLYPHS.get(ext) ?? DEFAULT_FILE_GLYPH;
}

/** Build the shared visual header for a generated room summary. */
export function docHero(eyebrow: string, title: string, subHtml: string): string {
  let html = '<header class="hero">\n';
  if (eyebrow !== "") html += `<div class="eyebrow">${htmlEscape(eyebrow)}</div>\n`;
  html += `<h1>${htmlEscape(title)}</h1>\n`;
  if (subHtml.trim() !== "") html += `<p class="sub">${subHtml}</p>\n`;
  html += '<div class="rule"></div>\n</header>\n';
  return html;
}
