export function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/* Annotation boxes drawn over a user's image. These are the notebook's five
   markers in their fixed order, so a box on a photo belongs to the same colour
   language as a highlight in a document. Read from the theme rather than fixed
   hex: the old set was tuned for a dark UI and washed out on light paper. */
export const BOX_COLORS = [
  "var(--mk-berry-ink)",
  "var(--mk-green-ink)",
  "var(--mk-yellow-ink)",
  "var(--mk-blue-ink)",
  "var(--mk-red-ink)",
];

/** The prefix `run_ocr_job` stamps on recognised text so the model can flag
 * that the words are a machine reading rather than the file's own. See
 * `commands/files.rs` — the two strings have to stay identical. */
export const OCR_PREFIX = "(text recognized from scan)";

/** The recognised words a picture carries, ready to show — or `null` when there
 * are none.
 *
 * A picture's stored text is either OCR output (prefixed) or nothing. The
 * prefix is an instruction to the model, not something to put on screen under
 * someone's photograph, so it is stripped here; the viewer says "recognised on
 * this Mac" in its own words instead. Empty and whitespace-only both mean "no
 * text was read", never "read, and it was blank".
 */
export function ocrBody(text: string | null | undefined): string | null {
  if (!text) return null;
  const body = (text.startsWith(OCR_PREFIX) ? text.slice(OCR_PREFIX.length) : text).trim();
  return body === "" ? null : body;
}

/** The prefix `run_stt_job` puts on the `stt-progress` stage when a recording
 * could not be DECODED or transcribed, as opposed to being silent. See
 * `commands/stt_cmds.rs` — the two strings have to stay identical. */
export const STT_FAILED_PREFIX = "failed: ";

/** Why the transcriber gave up on this file, or `null` when it didn't.
 *
 * The backend distinguishes "this container can't be opened" from "the model
 * heard nothing", and the distinction is the whole point: one is fixed by
 * converting the file, the other is not. `sttStatus` kept the reason and every
 * reader only ever compared the stage to "processing", so a file the Mac
 * cannot decode fell through to the same "No transcript yet — a silent or
 * speechless recording stays empty" as a genuinely silent one. Empty stays
 * empty: an absent stage, or any other stage, is `null`, never a guess.
 */
export function sttFailure(stage: string | null | undefined): string | null {
  if (!stage || !stage.startsWith(STT_FAILED_PREFIX)) return null;
  const why = stage.slice(STT_FAILED_PREFIX.length).trim();
  return why === "" ? null : why;
}
