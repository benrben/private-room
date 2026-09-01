/**
 * Port of `src-tauri/src/textutil.rs` (296 lines, read in full) — the bridge
 * to macOS's own Word/RTF importer at the fixed path `/usr/bin/textutil` (the
 * one behind TextEdit and Quick Look), plus the Word FIELD CODE resolver that
 * turns a `HYPERLINK "url"displayed text` instruction that survived the
 * import into either a real `<a href>` or its plain-text target.
 *
 * WHY THIS EXISTS AS A SHARED MODULE (verbatim from the Rust source's own
 * header): the legacy `.doc` path needs the same converter twice, for two
 * different outputs. The PREVIEW wants HTML (fonts, weights, colours,
 * lists); the EXTRACTED TEXT — what search, RAG and the editor all read —
 * wants plain text. Those used to come from two unrelated places, and only
 * the preview was any good: the text came from a `strings(1)`-style sweep of
 * the OLE compound file that returned the font table and binary noise. One
 * document, two answers that disagreed. `textutil` ships with every Mac at a
 * fixed path, works offline, and is nothing to bundle, sign or notarize.
 *
 * ============================================================================
 * NOT A DUPLICATE OF `textClamp.ts` — checked before writing a line here.
 * ============================================================================
 * `textClamp.ts` ports a completely different Rust source
 * (`src-tauri/src/commands/agent.rs`'s `normalize_for_match`/`clamp_*`/
 * `excerpt` family): byte- and char-safe truncation of text a MODEL already
 * has in hand, for quote-matching and inventory descriptions. This file
 * ports `src-tauri/src/textutil.rs`: a macOS system-binary bridge (spawns a
 * real subprocess against a decrypted temp copy) plus a narrow HTML
 * field-code fixer. Neither the inputs, the outputs, nor a single function
 * name overlap between the two Rust files or these two ports — read both
 * files in full and confirmed there is no shared logic to fold together.
 *
 * ============================================================================
 * NOT A MODEL TOOL
 * ============================================================================
 * Grepped `toolSpecs.ts`/`toolSchema.ts`/`execTool.ts`: nothing there
 * references `textutil`, `office_html`, or `legacy` — this Rust module has no
 * `exec_tool` arm in `agent.rs` either (grepped the Rust tree the same way).
 * It is consumed internally by two Rust callers, `commands::office_html`
 * (`src-tauri/src/commands/office.rs`) and `extraction::legacy`
 * (`src-tauri/src/extraction/legacy.rs`) — a UI preview command and an
 * extraction-pipeline fallback, neither of which has an Electron port yet in
 * this tree (no `office.ts`/`legacy.ts` exists here). So this batch adds
 * nothing to `execTool.ts`, per this migration's rule 5 — there is no arm to
 * add additively because no arm calls this module yet.
 *
 * ============================================================================
 * A NOTE ON WHERE THIS CODE LIVES
 * ============================================================================
 * The migration design routes `textutil.rs` to the PYTHON SIDECAR under its
 * "document parsing goes to Python" split rule. That split does not
 * (yet) exist as running code anywhere in this tree — there is no Python
 * sidecar directory under `electron-migration/` at all, and several of its
 * own "sidecar" candidates (`editMatchDocx.ts`, `editMatchHtml.ts`,
 * `extractionWindow.ts`, `docsHtml.ts`, `previewTools.ts`'s non-PyObjC half)
 * already live in `src/main/*.ts` today. This port follows that same,
 * already-established precedent and lands in Electron main per this task's
 * explicit instruction. Unlike `quicklook.rs` (genuine PyObjC/Vision
 * dependency, stubbed NOT_IMPLEMENTED in `previewTools.ts`), `/usr/bin/
 * textutil` is an ordinary fixed-path CLI with no native-framework
 * dependency Node cannot reach directly — so this is a REAL, WORKING port,
 * not a stub. Flagging the plan/actual divergence for the owner rather than
 * silently resolving it either way.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ------------------------------------------------------------------ formats

/**
 * The formats `textutil` can import. `.docx` is deliberately absent from the
 * PREVIEW path (docx-preview renders more) but it can still be converted, so
 * this list is about what the importer understands, not about who uses it.
 * Ported verbatim from `textutil.rs`'s `can_read`.
 */
export function canRead(ext: string): boolean {
  return (
    ext === "doc" ||
    ext === "rtf" ||
    ext === "rtfd" ||
    ext === "odt" ||
    ext === "wordml" ||
    ext === "webarchive"
  );
}

/**
 * `extraction::extension_of` (`Path::new(name).extension()`, lower-cased),
 * including its own quirk: no dot, or a leading dot with no other dot (a
 * dotfile), both read as no extension at all. ANOTHER local copy — same as
 * `docsHtml.ts`'s and `organize.ts`'s own, for the same reason: this rewrite
 * has no shared `extraction.ts` yet for any of them to import instead.
 */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

// -------------------------------------------------------------- temp hygiene

/**
 * `write_private`, ported verbatim: create `filePath` EXCLUSIVELY (fails if
 * it already exists — Rust's `create_new(true)`) and owner-only (`0o600`,
 * Rust's `.mode(0o600)`; both are still subject to the process umask on
 * either side, so both end up with the same effective bits), then write
 * `bytes`. Returns `false` on any failure rather than throwing, mirroring
 * `io::Result<()>` collapsed by the caller's `.ok()?`.
 *
 * Exported only so the delete-on-every-exit-path and owner-only-permission
 * guarantees can be tested directly against the mechanism, exactly as the
 * Rust source's own `#[cfg(test)] mod tests` reaches `write_private`/
 * `TempPath` in the same module rather than inferring the guarantee
 * indirectly through `convert()` — the Rust test's own comment explains why:
 * the shared temp dir is used by tests running in parallel, so counting
 * files there proves nothing about any one of them.
 */
export function writePrivate(filePath: string, bytes: Buffer): boolean {
  try {
    fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete `filePath`, discarding any error — Rust's `let _ =
 * std::fs::remove_file(&self.0)` inside `TempPath`'s `Drop`. A path that was
 * never created (e.g. because `writePrivate` failed before ever reaching the
 * OS write) is not an error here, matching `remove_file` on a missing file
 * being silently swallowed by the Rust guard. Exported for the same testing
 * reason as {@link writePrivate}.
 */
export function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort by design — see doc comment.
  }
}

/**
 * `std::fs::read_to_string`, which is NOT what `readFile(path, "utf8")` does.
 * Rust REFUSES a file that is not valid UTF-8 (`io::ErrorKind::InvalidData`),
 * which the caller's `.ok()?` turns into "no text from this converter" and
 * the extraction pipeline treats as a reason to fall back. Node instead
 * substitutes U+FFFD for every bad byte and hands back a long, non-empty,
 * entirely meaningless string — which `convert`'s "not blank" filter passes
 * straight through to search, RAG and the editor as if it were the
 * document's prose. The second existing port of this same Rust source,
 * `services/agent-sidecar/src/arcelle_sidecar/docs/textutil.py`, is explicit about it too
 * (`except (OSError, UnicodeDecodeError): return None`).
 *
 * `ignoreBOM: true` means "do not strip a leading U+FEFF" — Rust keeps it as
 * a character, so this keeps it too.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Run `/usr/bin/textutil` with `args`, resolving `true` only on a clean
 * exit — a spawn failure, a non-zero exit, or a killing signal all resolve
 * `false`, mirroring the Rust source's `match run { Ok(o) if
 * o.status.success() => …, _ => None }`. */
function runTextutil(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/textutil", args, (error) => {
      resolve(error === null);
    });
  });
}

/**
 * Convert `bytes` (`name`'s decrypted content) to `to` (`"txt"` or `"html"`).
 * `null` when the format isn't importable, the converter fails, or the
 * result is empty after trimming — ported verbatim from `textutil.rs`'s
 * `convert`.
 *
 * Same bargain as the Quick Look bridge and the audio decoder (per the Rust
 * doc comment): a system converter takes a path, so the decrypted bytes
 * touch the disk for the moment it runs — owner-only, created exclusively —
 * and are removed straight after, on EVERY exit path (success, a failed
 * write, a failed convert, an empty result, or a thrown error), via the
 * `finally` below standing in for the Rust guard's `Drop`.
 */
export async function convert(name: string, bytes: Buffer, to: string): Promise<string | null> {
  const ext = extensionOf(name);
  if (!canRead(ext)) {
    return null;
  }
  const stem = randomUUID();
  const dir = os.tmpdir();
  const srcPath = path.join(dir, `arcelle-tu-${stem}.${ext}`);
  const dstPath = path.join(dir, `arcelle-tu-${stem}.${to}`);
  try {
    if (!writePrivate(srcPath, bytes)) {
      return null;
    }
    const ok = await runTextutil(["-convert", to, "-output", dstPath, srcPath]);
    if (!ok) {
      return null;
    }
    let out: string;
    try {
      // Read BYTES and decode strictly — see {@link STRICT_UTF8}. A decode
      // failure lands in the same `catch` as a missing/unreadable file, which
      // is exactly where Rust's `read_to_string(...).ok()` puts both.
      out = STRICT_UTF8.decode(await fsp.readFile(dstPath));
    } catch {
      return null;
    }
    return out.trim().length === 0 ? null : out;
  } finally {
    removeQuietly(srcPath);
    removeQuietly(dstPath);
  }
}

// --------------------------------------------------------- Word field codes

/** How much may sit between the `HYPERLINK` keyword and its target — room
 * for a space and a switch, and nothing like a clause of prose. Measured in
 * UTF-8 BYTES via `Buffer.byteLength`, matching the Rust source's
 * byte-counted `gap.len()` exactly (this is a length comparison, not a
 * content slice, so — unlike the ASCII-delimited slices around it — a
 * non-ASCII gap really could disagree between a byte count and a UTF-16
 * count). */
const MAX_FIELD_GAP = 8;

const HYPERLINK = "HYPERLINK";

/**
 * Rust's `str::split_whitespace` splits on `char::is_whitespace`, i.e. the
 * Unicode White_Space property — which is NOT the same set as JavaScript's
 * `\s`, and both differences flip this function's answer:
 *
 * - `\s` matches U+FEFF, which has NO White_Space property. Splitting on
 *   `/\s+/` made a stray BOM in the gap vanish, leaving zero tokens, so the
 *   vacuous `.every()` passed and `HYPERLINK﻿"great" and the rest.`
 *   came back as `great and the rest.` — the keyword and the quoted phrase
 *   deleted from the prose. That is precisely the failure the gap check
 *   exists to prevent, and a stray BOM is ordinary debris in text that has
 *   been through a legacy converter.
 * - `\s` does NOT match U+0085 (NEL), which DOES have the property. Rust
 *   sees no tokens and resolves the field; `/\s+/` saw a token that does not
 *   start with a backslash and left a genuine hyperlink unresolved.
 *
 * So the class is spelled out to be exactly Unicode White_Space.
 */
const RUST_WHITESPACE =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/**
 * Turn Word FIELD CODES that survived the import into what they mean.
 * Ported verbatim from `textutil.rs`'s `resolve_field_codes`, including its
 * exact bail conditions.
 *
 * A `.doc` stores a hyperlink as a field: the instruction `HYPERLINK "url"`
 * followed by the display text, with no separator between the closing quote
 * and that text. textutil imports the instruction as literal characters, so
 * the reader saw `HYPERLINK "https://products.office.com/en-us/word"Mauris
 * id ex erat.` — the machinery of the document leaking into its prose, and
 * the actual link not a link at all.
 *
 * Only the codes that carry user-visible meaning are handled — the gap
 * between the keyword and the quote must look like the rest of a field
 * instruction (short, and every whitespace-separated token in it a `\switch`
 * like `\l`/`\o`) or the word "HYPERLINK" is left exactly as it came, because
 * guessing at an unknown field is how a converter starts eating real text.
 *
 * BYTE-VS-CHAR NOTE: every slice point here (`"HYPERLINK"`, `"`) is an ASCII
 * delimiter, so slicing a JS string by UTF-16 index at that point yields the
 * identical Unicode content Rust's byte-index slicing would — the two only
 * disagree on how a LENGTH is counted, which is why {@link MAX_FIELD_GAP}'s
 * comparison alone uses `Buffer.byteLength`.
 */
export function resolveFieldCodes(text: string, asHtml: boolean): string {
  let out = "";
  let rest = text;
  for (;;) {
    const field = nextHyperlinkField(rest);
    if (field === null) break;
    out += field.before;
    if (field.target !== null) out += renderedFieldTarget(field.target, asHtml);
    rest = field.rest;
  }
  out += rest;
  return out;
}

interface HyperlinkField {
  readonly before: string;
  readonly target: string | null;
  readonly rest: string;
}

function nextHyperlinkField(text: string): HyperlinkField | null {
  const at = text.indexOf(HYPERLINK);
  if (at === -1) return null;
  const before = text.slice(0, at);
  const after = text.slice(at + HYPERLINK.length);
  const quotes = fieldQuotePositions(after);
  if (quotes === null || !isHyperlinkFieldGap(after.slice(0, quotes.first))) {
    return { before: before + HYPERLINK, target: null, rest: after };
  }
  const target = after.slice(quotes.first + 1, quotes.first + 1 + quotes.secondRelative);
  return { before, target, rest: after.slice(quotes.first + quotes.secondRelative + 2) };
}

interface FieldQuotePositions {
  readonly first: number;
  readonly secondRelative: number;
}

function fieldQuotePositions(text: string): FieldQuotePositions | null {
  const first = text.indexOf('"');
  if (first === -1) return null;
  const secondRelative = text.slice(first + 1).indexOf('"');
  return secondRelative === -1 ? null : { first, secondRelative };
}

function isHyperlinkFieldGap(gap: string): boolean {
  // Only treat it as a field if what sits between the keyword and the quote
  // looks like the rest of a field instruction — otherwise the word
  // "HYPERLINK" is just a word someone wrote. Everything Word puts there
  // before the target is a SWITCH, and every switch starts with a backslash.
  const tokens = gap.split(RUST_WHITESPACE).filter((token) => token.length > 0);
  return Buffer.byteLength(gap, "utf8") <= MAX_FIELD_GAP && tokens.every((token) => token.startsWith("\\"));
}

function renderedFieldTarget(target: string, asHtml: boolean): string {
  if (asHtml && looksLikeUrl(target)) return `<a href="${escapeAttr(target)}">${escapeText(target)}</a>`;
  return asHtml ? escapeText(target) : target;
}

/** Conservative: only schemes a document viewer should ever make clickable.
 * `javascript:` and friends must never become an `href`. Ported verbatim
 * from `looks_like_url`. Rust's `to_ascii_lowercase` lowercases ASCII bytes
 * only; JS's `toLowerCase()` also folds non-ASCII casing, but every prefix
 * checked below is pure ASCII, so the two never disagree on the boolean this
 * returns. */
function looksLikeUrl(s: string): boolean {
  const lower = s.trim().toLowerCase();
  return lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:");
}

/** Ported verbatim from `escape_attr`. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Ported verbatim from `escape_text`. */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
