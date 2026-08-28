/**
 * Make generated book markup agree with the bytes that carry it.
 *
 * foliate-js decodes a MOBI using the charset declared in its MOBI header,
 * serialises the parsed DOM into a JavaScript string, then puts that string in
 * a Blob. Blob string parts are UTF-8. Some books retain their original
 * windows-1252 declaration in the serialised markup, however, so Chromium
 * decodes those new UTF-8 bytes as windows-1252 on the next page and renders
 * punctuation such as `’` as `â€™`.
 *
 * This does not guess at the book's original encoding: foliate has already
 * decoded it. It only labels the newly generated UTF-8 document truthfully.
 */
export function declareGeneratedMarkupUtf8(markup: string): string {
  return markup
    .replace(/(<\?xml\b[^>]*\bencoding\s*=\s*["'])[^"']*(["'][^>]*\?>)/gi, "$1utf-8$2")
    .replace(/(<meta\b[^>]*\bcharset\s*=\s*["']?)[^\s"'/>]+/gi, "$1utf-8")
    .replace(
      /(<meta\b[^>]*\bcontent\s*=\s*["'][^"']*?\bcharset\s*=\s*)[^\s;"']+/gi,
      "$1utf-8",
    );
}
