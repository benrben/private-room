import { useCallback, useEffect, useState } from "react";
import { api, type DecodedFileText, type FileContent, type ViewerKind } from "../api";
import "./encoding.css";

/**
 * THE ENCODING STRIP — which charset a plain-text file is being read as, and a
 * way for a human to say otherwise.
 *
 * Import now detects the encoding (`extraction::decode_text_bytes`) instead of
 * destroying legacy bytes with `from_utf8_lossy`, but detection is a GUESS and
 * single-byte encodings are genuinely ambiguous: the same bytes really are
 * Turkish and really are Cyrillic, and no detector can be right every time. So
 * the reading is stated out loud — fact ("this file's BOM says…"), guess
 * ("read as … — a guess") or the user's own pick — and the guess can be
 * overruled from here.
 *
 * The override re-reads the file's ORIGINAL BYTES in Rust. Re-decoding the
 * string we already have could only ever launder one wrong reading into
 * another, because the wrong reading has already thrown the bytes away.
 */

/** Kinds whose text IS the file's bytes, and which therefore have an encoding
 * to argue about at all. Mirrors the `text: Raw` rows of `formats.rs` (a PDF's
 * or a Word file's words are read out of a container, so there is no charset
 * the user could usefully change); `encoding.test.mjs` fails when the two
 * lists drift apart. */
export const RE_DECODABLE_KINDS: ReadonlySet<string> = new Set<ViewerKind>([
  "csv",
  "markdown",
  "html",
  "svg",
  "notebook",
  "json",
  "subtitle",
  "email",
  "prose",
  "log",
  "code",
]);

export interface EncodingState {
  /** The text to show, once a re-read has landed. Null = use what
   * `get_file_content` already handed over (the same automatic reading). */
  text: string | null;
  /** Part of the editor's remount key: Monaco takes its value at mount, so a
   * re-decode has to remount it or the buffer would keep the old reading. */
  key: string;
  /** The banner sentence for the editor, when saving would convert the file. */
  decoded: DecodedFileText | null;
  /** An inline card for the document column — but only the two readings
   * worth interrupting the page for: the re-read failing outright, or
   * landing on replacement characters. Null the rest of the time, INCLUDING
   * the routine case ("Read as UTF-8.") that used to sit here as a strip over
   * every plain-text file whether or not it had anything to say. P1-4 moved
   * that routine sentence into `picker`, in the toolbar's overflow menu. */
  alert: React.ReactNode;
  /** The overflow-menu row: which encoding this file is being read as, and
   * the control to pick a different one. Null for a kind with no encoding to
   * argue about, or before the first read has landed — deliberately silent
   * rather than a placeholder guess that might turn out wrong. */
  picker: React.ReactNode;
}

const IDLE: EncodingState = {
  text: null,
  key: "auto",
  decoded: null,
  alert: null,
  picker: null,
};

function isReDecodable(content: FileContent): boolean {
  if (!RE_DECODABLE_KINDS.has(content.kind)) return false;
  return content.kind !== "email" || !content.name.toLocaleLowerCase().endsWith(".msg");
}

function payloadChanged(pinned: { id: string; payload: string }, fileId: string, payload: string): boolean {
  return pinned.id !== fileId || pinned.payload !== payload;
}

function encodingState(
  decoded: DecodedFileText | null,
  chosen: string | null,
  error: string,
  pick: (name: string) => void,
): EncodingState {
  return {
    // Only substitute text once a re-read has actually landed; before that the
    // viewer shows what `get_file_content` decoded, which is the same reading.
    text: decoded ? decoded.text : null,
    key: chosen ?? "auto",
    decoded,
    alert: <EncodingAlert decoded={decoded} error={error} />,
    picker: <EncodingPicker decoded={decoded} chosen={chosen} onPick={pick} />,
  };
}

/**
 * Track (and let the user change) how the open file's bytes are being decoded.
 *
 * Always called — hooks can't be conditional — but it only asks the backend
 * anything for the kinds whose text comes from their own bytes.
 */
export function useTextEncoding(fileId: string, content: FileContent): EncodingState {
  // `.eml` is a byte-oriented MIME message and can legitimately need a
  // charset override. `.msg` is a structured OLE container: EmailView parses
  // its MAPI strings from the original bytes with msgreader. Asking the raw
  // text decoder to inspect that binary container produces a UTF-8 byte
  // warning even while the selected MSG parser has rendered the body cleanly.
  const applies = isReDecodable(content);
  const [chosen, setChosen] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<DecodedFileText | null>(null);
  const [error, setError] = useState("");

  // Both the pick and the cached re-read belong to the BYTES they were made
  // against. A save (which rewrites the file as UTF-8), a version restore, an
  // undo or an agent edit all replace the payload under this component without
  // unmounting it — and a stale re-read would then be drawn OVER the new text,
  // handing the pre-save version straight back to the next Edit, while a stale
  // legacy pick would re-decode bytes that are now UTF-8 into mojibake. So the
  // file's identity here is (id, payload), and either changing starts over.
  //
  // Adjusted during render rather than in an effect on purpose: React re-runs
  // this render before committing, so the fetch below only ever fires once,
  // with the reset values — an effect would fire a doomed request first.
  const payload = content.text ?? "";
  const [pinned, setPinned] = useState({ id: fileId, payload });
  if (payloadChanged(pinned, fileId, payload)) {
    setPinned({ id: fileId, payload });
    setChosen(null);
    setDecoded(null);
    setError("");
  }

  useEffect(() => {
    if (!applies) return;
    let alive = true;
    (async () => {
      try {
        const d = await api.decodeFileText(fileId, chosen);
        if (alive) {
          setDecoded(d);
          setError("");
        }
      } catch (e) {
        // Never fall back to "it's UTF-8" — that is the lie this whole feature
        // exists to stop. The strip says the re-read failed and keeps showing
        // whatever the viewer already had.
        if (alive) {
          setDecoded(null);
          setError(String(e));
        }
      }
    })();
    return () => {
      alive = false;
    };
    // `payload` is in here so a file whose bytes were replaced is re-read
    // rather than kept at whatever the last decode said.
  }, [applies, fileId, chosen, payload]);

  const pick = useCallback((name: string) => {
    setChosen(name === AUTO ? null : name);
  }, []);

  if (!applies) return IDLE;
  return encodingState(decoded, chosen, error, pick);
}

/** The value of the picker's first row — "let the app decide", which is not an
 * encoding name and so can never collide with one. */
const AUTO = "";

/** The inline card over the document — reserved for the two readings that are
 * actually a problem: the re-read failing outright, or landing on replacement
 * characters. The routine case ("Read as UTF-8.") has nothing to say here
 * and says nothing; see `EncodingPicker` for where changing it lives now. */
function EncodingAlert({
  decoded,
  error,
}: {
  decoded: DecodedFileText | null;
  error: string;
}) {
  if (error) {
    // Its own class, not the lossy-reading one: "we could not check" is a
    // failure (red across this product) and "we read it and got replacement
    // characters" is something to review (yellow). They used to share a
    // stylesheet rule and so said the same thing in the same colour.
    return (
      <div className="encoding-strip encoding-error" role="status">
        This file's text encoding couldn't be checked ({error})
      </div>
    );
  }
  // Nothing to say yet (the first read is in flight), or nothing wrong with
  // the reading — either way, deliberately silent rather than showing a
  // placeholder or repeating the routine "Read as UTF-8." that used to sit
  // here unconditionally.
  if (!decoded?.lossy) return null;

  return (
    <div className="encoding-strip" role="status">
      <span className="encoding-lede">{ledeFor(decoded)}</span>
      <span className="encoding-warn">
        Some bytes have no meaning in {decoded.encoding}, so they show as “�”.
        This isn't the file's text — open the ⋯ menu above the document and
        pick the encoding it was actually written in. Editing stays off until
        the text reads correctly.
      </span>
    </div>
  );
}

/** The overflow-menu row: the lede sentence plus the picker itself. Null
 * while the first read is still in flight, or once it has failed outright
 * (the `EncodingAlert` card is the whole story then — offering a picker next
 * to "couldn't be checked" invites picking against bytes it never read). */
function EncodingPicker({
  decoded,
  chosen,
  onPick,
}: {
  decoded: DecodedFileText | null;
  chosen: string | null;
  onPick: (name: string) => void;
}) {
  if (!decoded) return null;
  return (
    <label className="encoding-label">
      <span className="encoding-lede">{ledeFor(decoded)}</span>
      <select
        className="encoding-select"
        aria-label="Read this file's text as a different encoding"
        value={chosen ?? AUTO}
        onChange={(e) => onPick(e.target.value)}
      >
        <option value={AUTO}>
          {decoded.source === "chosen"
            ? "Let Arcelle decide"
            : `Read automatically (${decoded.encoding})`}
        </option>
        {decoded.options.map((o) => (
          <option key={o.name} value={o.name}>
            {o.title}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The sentence in front of the picker. The four cases are NOT equally
 * trustworthy, and a strip that always said "windows-1254" would present a
 * guess as a fact. */
function ledeFor(d: DecodedFileText): string {
  if (d.source === "chosen") return `Read as ${d.encoding} — your choice.`;
  if (d.source === "bom") return `Read as ${d.encoding}, which this file states.`;
  if (d.source === "utf8") return "Read as UTF-8.";
  return `Read as ${d.encoding} — a guess, because this file doesn't say.`;
}

/** What the editor says above the buffer before you save one of these.
 *
 * Saving writes UTF-8 (that is the only thing the writer does), so a legacy
 * file is CONVERTED by being saved. Doing that silently would rewrite the whole
 * file behind the user's back on the strength of a guess, so it is said in
 * advance, with the guess named and the way back pointed at. Null when saving
 * changes nothing about the encoding.
 */
export function encodingSaveNote(d: DecodedFileText | null): string | null {
  if (!d || d.encoding === "UTF-8") return null;
  const how =
    d.source === "chosen"
      ? "as you chose"
      : d.source === "bom"
        ? "as its byte-order mark states"
        : "which Arcelle guessed";
  return (
    `This file is stored as ${d.encoding} (${how}), and saving rewrites the whole file ` +
    `as UTF-8. Check the text above reads correctly first — if it doesn't, close the ` +
    `editor and pick a different encoding. The version before your save is kept in ` +
    `this file's history either way.`
  );
}
