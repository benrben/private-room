import { AiStatus, AnnotationPayload, FileTarget, splitExternalModel } from "../api";
import { isRelayedModel } from "./localModel";

/** External cloud engines/providers. Recognizes both a bare engine id and a
 * composite "engine::submodel" selection from the Cloud picker. */
export function isExternalEngine(model: string): boolean {
  const [engine] = splitExternalModel(model);
  return engine === "claude-cli" || engine === "codex-cli" || engine === "antigravity-cli" || engine === "openrouter";
}

/** An Ollama relayed model: listed alongside local models and driven through
 * the same tool loop (ADD-29 parity), but it RUNS REMOTELY — prompts and file
 * context leave this Mac. Must never be labeled "Local".
 *
 * The rule itself lives in `localModel.isRelayedModel`, which mirrors the
 * host's declared capability record. It used to be an exact `endsWith(":cloud")`
 * here, which misses Ollama's `<size>-cloud` spelling (`gpt-oss:120b-cloud`) —
 * so `trustState` called such a room "Local only — nothing leaves the device"
 * while every prompt was going to ollama.com. */
export function isRemoteModel(model: string): boolean {
  return isRelayedModel(model);
}

/** Anything that sends room content off this Mac (SEC-6): drives the privacy
 * strip and the Cloud tier label. */
export function isCloudEngine(model: string): boolean {
  return isExternalEngine(model) || isRemoteModel(model);
}

/** Does this room's content leave this Mac — engine OR transport?
 *
 * `isCloudEngine` reads the model NAME, and a name cannot know that Settings →
 * the Closet has pointed Ollama at another computer. With that set, the very
 * same `qwen3.5:4b` runs on a LAN box: prompts, documents and transcripts go
 * there. The host reports it as `AiStatus.remoteRelay` (its own locality rule
 * is `capabilities::ollama_runs_here`), and every trust surface ORs it in — so
 * the chip can never say "Local only" about a relayed room. */
export function isCloudRoute(model: string, ai: { remoteRelay?: boolean } | null): boolean {
  return isCloudEngine(model) || ai?.remoteRelay === true;
}

export type TrustTone = "good" | "warn" | "danger";
export interface TrustState {
  tone: TrustTone;
  label: string;
  title: string;
}

/** The room's ONE trust state, derived from the engine (local vs cloud) and the
 * privacy door (protected vs raw). Every surface that tells the user whether
 * their content leaves this Mac — the status-bar chip, the top-bar engine
 * badge — reads from this single function, so they can never say different
 * things about the same room at the same time.
 *   • Local only      — the model runs on this Mac; nothing leaves.       (good)
 *   • Protected cloud — a cloud model, but private details are redacted. (warn)
 *   • Raw cloud       — a cloud model with the door OPEN; real content leaves. (danger) */
export function trustState(cloud: boolean, protectedOn: boolean | null): TrustState {
  if (!cloud) {
    return {
      tone: "good",
      label: "Local only",
      title: "The AI runs on this Mac — nothing leaves the device.",
    };
  }
  if (protectedOn === false) {
    return {
      tone: "danger",
      label: "Raw cloud",
      title:
        "Cloud model with privacy OFF — questions, documents and tool results leave this Mac with real names and details.",
    };
  }
  return {
    tone: "warn",
    label: "Protected cloud",
    title:
      "Cloud model with the privacy door on — private details are replaced with neutral tags before anything leaves this Mac.",
  };
}

/** Is the room's selected model usable right now (so no "download a model"
 * card is warranted)? A local/`:cloud` model must be present in Ollama's live
 * list (matched loosely on the `:tag` boundary). A cloud CLI is ready as soon
 * as its engine is detected — but the picker hands us a composite
 * "engine::model::effort" selection, so we split down to the bare engine id
 * before checking `ai.external` (which only ever holds bare engine ids). */
export function isModelReady(ai: AiStatus | null | undefined, model: string): boolean {
  if (!ai) return false;
  const [engine] = splitExternalModel(model);
  if (ai.external.includes(engine)) return true;
  // Both directions match only across a `:` TAG BOUNDARY. A bare prefix test
  // would call "qwen3.5:4b" installed because an unrelated "qwen3" is — the
  // download card then never appears and the turn fails with MODEL_MISSING.
  return (
    ai.running &&
    (ai.models.includes(model) ||
      ai.models.some(
        (m) => m.startsWith(model + ":") || model.startsWith(m + ":"),
      ))
  );
}

export interface BoxesPayload {
  fileId: string;
  name?: string;
  boxes: { label: string; x1: number; y1: number; x2: number; y2: number }[];
}

/** Split assistant content into visible text and optional viewer-markup payloads. */
export function splitMarkupBlocks(content: string): {
  text: string;
  boxes?: BoxesPayload;
  annotation?: AnnotationPayload;
} {
  let text = content;
  let boxes: BoxesPayload | undefined;
  let annotation: AnnotationPayload | undefined;
  const boxMatch = text.match(/```boxes\n([\s\S]*?)\n?```/);
  if (boxMatch) {
    try {
      boxes = JSON.parse(boxMatch[1]) as BoxesPayload;
    } catch {
      /* malformed payload — show the text alone */
    }
    text = text.replace(boxMatch[0], "").trim();
  }
  const annotMatch = text.match(/```annotation\n([\s\S]*?)\n?```/);
  if (annotMatch) {
    try {
      annotation = JSON.parse(annotMatch[1]) as AnnotationPayload;
    } catch {
      /* malformed payload — show the text alone */
    }
    text = text.replace(annotMatch[0], "").trim();
  }
  return { text, boxes, annotation };
}

/** Viewer navigation for an annotation: quote or cell range. */
export function annotationTarget(a: AnnotationPayload): FileTarget {
  return {
    quote: a.quote,
    find: a.quote,
    page: a.page,
    sheet: a.sheet,
    range: a.range,
  };
}

/** What the app itself wrote into the transcript when a turn produced no
 * answer, and what the user may safely do about it.
 *  • "clean"      — no answer, nothing written, nothing running: re-ask freely.
 *  • "after-write"— a file change already landed; re-asking would repeat it.
 *  • "with-job"   — background work is still running; re-asking may start it twice.
 * `null` for every real answer, including one that merely talks about a
 * failure. The strings are Arcelle's own constants (`agent.rs`
 * LOST_REPLY_*), pinned from the Rust side by
 * `the_notices_keep_the_fragments_the_chat_ui_matches_on`. */
export type LostReplyKind = "clean" | "after-write" | "with-job";

export function lostReplyNotice(content: string): LostReplyKind | null {
  const t = content.trimStart();
  if (!t.startsWith("*(The agent ")) return null;
  if (!t.includes("the reply was lost before it reached the app")) return null;
  if (t.includes("A change was already applied")) return "after-write";
  if (t.includes("Background work in this room is still running")) return "with-job";
  return "clean";
}

/** The one line the recovery strip shows above Try again. Says what is true of
 * THIS turn — never "nothing happened" when a write landed or a job is live. */
export function lostReplyAdvice(kind: LostReplyKind): string {
  if (kind === "after-write") {
    return "A change was already applied before the reply was lost — check the file first; asking again may repeat it.";
  }
  if (kind === "with-job") {
    return "Background work in this room is still running — check the Jobs list first; asking again may start it twice.";
  }
  return "Nothing was written, so asking again is safe.";
}

/** CHG-6: an in-progress stream may hold a half-open ``` fence — balance it
 * (display only) so MarkdownView never renders a broken code block. */
export function patchStreamFences(s: string): string {
  const fences = (s.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${s}\n\`\`\`` : s;
}

/* ==========================================================================
   THE CHAT'S TWO VOICES
   The AI pane is a shared notebook rather than a chat panel, so a message can
   be set in the hand (Kalam) or in the interface sans — and WHICH one is a
   fact about the MESSAGE, not about who wrote it:

     short and conversational  → the hand, either speaker
     long, or technical        → the sans, either speaker

   That is the whole rule, and it is deliberately not "user messages are
   handwritten". A three-word answer from the model is a note; a 900-word
   answer from the user pasted out of a brief is a document, and setting a
   document in a handwriting face makes it harder to read for nothing. The
   design system says the same thing from the other side: the hand is for
   annotations, dates, counts and short asides, never for code, tables, URLs,
   paths, long answers or instructions.
   ========================================================================== */

/** The longest message still set in the hand.
 *
 * Calibrated against what this app actually receives rather than a round
 * number: the 29 live-QA prompts in qa/AGENT-PROMPTS.md — one real prompt per
 * agent, from "how is it going?" to "create a new skill that teaches you how I
 * format meeting notes" — run 16 to 62 characters, and the four starter
 * prompts in the empty chat run 24 to 39. 220 is about three lines of Kalam at
 * the conversation's 720px measure: comfortably past every real question, and
 * short of the pasted paragraph where the hand stops being charming. */
export const HAND_MAX_CHARS = 220;

/** …and a note is a few lines, whatever its character count says. */
export const HAND_MAX_LINES = 4;

/** Anything outside the two Kalam subsets this app bundles (latin +
 * latin-ext), plus the general punctuation and currency blocks that any script
 * borrows. Shared by `isHandwritten` and `isLatinScript` so there is one answer
 * to "can the hand actually draw this?". */
const NON_LATIN = /[^\u0000-\u024F\u2000-\u206F\u20A0-\u20BF]/;

/** Structure that means "this is a document, not a note". Any one of these
 * sends the whole message to the sans — the clean-font fallback is not
 * optional, because these are exactly the things a handwriting face renders
 * badly and that a reader may need to copy character for character. */
const HAND_STOPPERS: RegExp[] = [
  /```|~~~/, // a fenced code block
  /`[^`\n]+`/, // inline code
  /^[ \t]*\|.*\|/m, // a table row
  /^[ \t]*#{1,6}[ \t]/m, // a heading (a "#command" has no space after it)
  /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/m, // a list ("*agent" has no space either)
  /^[ \t]*>[ \t]*\S/m, // a block quotation
  /\bhttps?:\/\/\S|\bwww\.\S/i, // a full URL
  // A filesystem path: "~/…", or two slash-separated segments ("/Users/ben",
  // "./src/main.rs"). Deliberately NOT any slash — "/skill" is the composer's
  // own token and "and/or" is a word, and neither is a path.
  /(?:^|\s)(?:~\/|\.{0,2}\/[\w.-]+\/)/,
  // A filename: the extension is exactly the part a reader may need to copy.
  /\.(?:ts|tsx|js|jsx|json|md|py|rs|css|html?|pdf|docx?|xlsx?|pptx?|csv|txt|toml|ya?ml|png|jpe?g|gif|svg|mp[34]|wav|zip)\b/i,
  /\$\$|\\\(|\\\[/, // display or inline maths
  /\n[ \t]*\n/, // more than one paragraph — that is a document, not a note
  // ANYTHING OUTSIDE LATIN + LATIN-EXT. This is the most important stopper in
  // the list and the least obvious. Only those two Kalam subsets are bundled
  // (see fonts.css), so a Hebrew, Arabic or CJK message set in the hand gets
  // its Latin punctuation and digits from Kalam and every other glyph from
  // whatever the system offers — two faces inside one sentence, at metrics
  // tuned for the face that is not rendering. Sending those to the sans keeps
  // them in ONE face that actually has the glyphs, which is the honest version
  // of the same intent. Hebrew is this app's second language.
  NON_LATIN,
];

/* `isLatinScript` used to live here, and it answered one question for one
 * caller: a LONG answer went to the sans but kept handwritten HEADINGS, and a
 * Hebrew or CJK heading would then have been drawn in a face with none of its
 * glyphs. Model-written headings are set in the sans now (chat.css §7), so
 * there is no face left to keep them out of and nothing to gate. NON_LATIN
 * stays — `isHandwritten` below still needs it, for the same reason. */

/** Should this message be set in the hand? Length first, then kind. */
export function isHandwritten(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > HAND_MAX_CHARS) return false;
  if (t.split("\n").length > HAND_MAX_LINES) return false;
  return !HAND_STOPPERS.some((re) => re.test(t));
}

/** Who a transcript row is from.
 *
 * One definition, read by the on-screen speaker label AND by the copied
 * transcript, so the two can never drift apart — they were separate string
 * literals in two files before, which is how a rename on screen becomes
 * something else in the clipboard.
 *
 * "Assistant", because that is what the control the reader pressed to get here
 * says: the top-bar pill, its ⌘2 shortcut and the layout presets all call this
 * actor the assistant. The label used to read "Room AI", a name carried on no
 * control anywhere in the app. */
export function speakerName(role: string): string {
  return role === "assistant" ? "Assistant" : "You";
}

/** One run of a handwritten message. `mono` runs are PRINTED. */
export interface HandToken {
  text: string;
  mono: boolean;
}

/** A token that stays printed inside a handwritten note. Both patterns are
 * tested against the chunk with its surrounding punctuation stripped. */
const MONO_CHUNK: RegExp[] = [
  // The composer's own vocabulary: @file, @folder/, #command, /skill, *agent.
  /^[@#/*][A-Za-z0-9_][\w./-]*$/,
  // A filename or a bare host — "notes.pdf", "lecture.mp4", "en.wikipedia.org".
  // The last segment must START with a letter, so "12.50" and "3.5" stay words
  // and "e.g." (one-letter tail) is not mistaken for a file.
  /^[\w-]+(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{1,11}$/,
];

/** Split a handwritten message into hand runs and printed runs.
 *
 * A person writing a note by hand still PRINTS the things that have to be read
 * exactly — a filename, a domain, an @mention — and that is the whole idea
 * here: "browse to google.com" reads as handwriting with `google.com` set in
 * the mono face. It is the reason a bare host or a filename does not send the
 * entire message to the sans the way a URL or a path does.
 *
 * The chunks concatenate back to the input exactly (the split keeps its
 * separators), so the rendered note is character-for-character what was sent —
 * nothing is dropped, reordered, or re-spaced. */
export function handTokens(text: string): HandToken[] {
  const out: HandToken[] = [];
  const push = (t: string, mono: boolean) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.mono === mono) prev.text += t;
    else out.push({ text: t, mono });
  };
  for (const chunk of text.split(/(\s+)/)) {
    if (!chunk || /^\s+$/.test(chunk)) {
      push(chunk, false);
      continue;
    }
    const lead = /^[([{"'«]*/.exec(chunk)![0];
    const rest = chunk.slice(lead.length);
    const tail = /[)\]}"'».,;:!?…]*$/.exec(rest)![0];
    const core = rest.slice(0, rest.length - tail.length);
    if (core && MONO_CHUNK.some((re) => re.test(core))) {
      push(lead, false);
      push(core, true);
      push(tail, false);
    } else {
      push(chunk, false);
    }
  }
  return out;
}

/** The clock time in a message's margin, or "" when there is none to show (an
 * optimistic row that has not been stored yet carries an empty `createdAt`).
 *
 * A time, not a relative age: this is the log line of a notebook page, and
 * "14:32" stays true where "2 minutes ago" silently goes stale on screen. The
 * stored value is ISO-8601 UTC (`strftime('%Y-%m-%dT%H:%M:%SZ')`), so the
 * conversion to the reader's own clock is the browser's.
 *
 * THE DAY COMES WITH IT once the message is not from today. Chats persist and
 * "Show earlier messages" pages back through months, so a transcript routinely
 * spans weeks — and a bare "09:14" on every row of it suggests a recency it
 * cannot support. Same convention as AiPane's `dayLabelOf`: the year is added
 * only when it is not this one. */
export function messageClock(createdAt: string): string {
  if (!createdAt) return "";
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}
