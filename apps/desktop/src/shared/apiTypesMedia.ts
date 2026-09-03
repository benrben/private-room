import type { AskPlanStep, AskTokenUsage } from "./apiTypesCore.js";
import type { AnnotationPayload } from "./apiTypesCreative.js";

export interface StudioStep {
  step: string;
  local: boolean;
}

/** ADD-23: the `effects` column payload — what a turn's tools drew. */
export interface MessageEffects {
  boxes?: {
    fileId: string;
    name?: string;
    boxes: { label: string; x1: number; y1: number; x2: number; y2: number }[];
  };
  annotation?: AnnotationPayload;
  /** Wave 2 (Idea 4): content-free per-edit outcome records for the turn
   * (`{tool, outcome, n}`). Telemetry only — the UI renders nothing from it. */
  edits?: { tool: string; outcome: string; n?: number; files?: number }[];
  /** This turn's token-usage snapshot for the budget bar (see AskTokenUsage). */
  usage?: AskTokenUsage;
  /** Dispatch-first agent visibility: the roster of domain agents that handled
   * this turn (the sidecar's plan event body). Rendered as a compact line on
   * the finished message — the live strip only exists while streaming. */
  agents?: AskPlanStep[];
}

/** ADD-25: one backend→webview request on the agent↔UI bridge. The driver
 * answers via api.resolveAgentUi(id, payload). */
export interface AgentUiRequest {
  id: string;
  kind:
    | "ui_snapshot"
    | "ui_act"
    | "view_screenshot"
    | "media_frame"
    | "skin_read"
    | "skin_update"
    | "skin_undo"
    | "skin_validate"
    | "skin_save"
    // BROWSE-1: the OUTBOUND privacy door. Unlike the others this is not
    // performed by the DOM driver — it needs a human answer, so effects.ts
    // intercepts it and queues a consent card.
    | "browse_consent";
  args: Record<string, unknown>;
}

/** The agent is about to type ROOM content into a web page.
 *
 * Every other privacy door in the app points OUTBOUND TO A MODEL. This one
 * points outbound to the open web, where no model is involved and
 * `privacy.py` never sees it. Following the connector-argument lesson, the
 * answer is consent shown with the REAL values — masking silently would just
 * make the form submission fail in a way nobody could diagnose.
 */
export interface BrowseConsentRequest {
  id: string;
  url: string;
  field: string;
  text: string;
  entities: string[];
}

export interface Memory {
  id: string;
  content: string;
  /** Wave 1b (idea 5): preference | fact | project | instruction, or null =
   * uncategorized (every pre-category row). */
  category: string | null;
  createdAt: string;
}

/** A recording's waveform envelope: per-bucket peak amplitude (0–1), plus the
 * true duration taken from the decoded sample count — which is also how the
 * viewer learns the length of a streamed container whose own header reports
 * `Infinity` to the media element. */
export interface AudioPeaks {
  peaks: number[];
  duration: number;
  /** The envelope never rose above the host's noise floor — the file decoded
   * and has a length, but there is nothing audible in it. Decided by the host
   * (`commands::peaks::is_silent`) so the flat lane and the label under it
   * can't disagree about what silence is. */
  silent: boolean;
}

/** One slide of a deck, drawn by macOS Quick Look. */
export interface SlideImage {
  /** PNG, base64. */
  pngB64: string;
  /** How many slides the deck has — the backend counts them while rendering. */
  slides: number;
}

/** A macOS-drawn page image for a file the app can't render itself. */
export interface QuickLookPreview {
  /** PNG, base64. */
  pngB64: string;
}

/** Every viewer kind the Rust format registry (`src-tauri/src/formats.rs`) can
 * produce. `src/viewers/registry.tsx` must have an entry for each one — its
 * own test asserts that, so a kind added on the Rust side fails the UI build
 * instead of silently landing on the "no preview available" card.
 *
 * NOT to be confused with api.ts's `FileKind`, which is the Library's ICON
 * category ("web", "generated", "file") — a different question about a
 * different object (a FileMeta row, not an opened file's content). */
export type ViewerKind =
  | "image"
  | "pdf"
  | "docx"
  | "worddoc"
  | "sheet"
  | "csv"
  | "slides"
  | "book"
  | "archive"
  | "markdown"
  | "html"
  | "svg"
  | "sketch"
  | "notebook"
  | "json"
  | "subtitle"
  | "email"
  | "prose"
  | "log"
  | "code"
  | "text"
  | "audio"
  | "video"
  | "recording"
  | "binary";

/** Why the bytes in a viewer are not the original file's own bytes.
 *
 * Derived previews are hidden room files. The original remains the object the
 * Library names and Export writes, so the viewer must say when it is showing a
 * stored representation rather than silently presenting that representation
 * as the original. */
export interface DerivedPreviewStatus {
  /** A snapshot was drawn by macOS; other previews were extracted or converted. */
  kind: "stored-snapshot" | "stored-preview";
  /** The original's MIME label, retained for diagnostics and future captions. */
  originalMime: string;
}

export interface FileContent {
  kind: ViewerKind;
  name: string;
  mime: string;
  editable: boolean;
  text: string | null;
  /** Legacy base64 payload. Nothing populates this today — every viewer that
   * needs raw bytes reads them from `mediaToken` instead. Kept so byte
   * delivery can be switched back in one place if it ever has to be. */
  dataB64: string | null;
  /** Token for the roommedia:// streaming protocol (Range-capable, any size).
   * Set for EVERY file whose viewer parses the real bytes — audio and video,
   * and since the base64 payload was retired, also images, PDFs, Word files,
   * workbooks, decks, books and archives. The viewer reads
   * `roommedia://localhost/<token>` instead of receiving a data URL. */
  mediaToken: string | null;
  /** Video only: what the container itself says. `null` = never probed (the
   * viewer asks for one); every field inside is independently `null` for
   * "the file doesn't say", which the viewer must render as unknown rather
   * than as a plausible default. */
  mediaMeta: MediaMeta | null;
  /** Present only when this response serves a hidden durable preview in place
   * of the original bytes. Export still targets the original. */
  derivedPreview?: DerivedPreviewStatus;
  /** Saved web pages only: what the page declared about itself, plus where and
   * when the room saved it. `null` = this file did not come from a web page,
   * and every field inside is optional for the stronger reason — a page that
   * named no author has no author, so the strip shows none rather than
   * "unknown" (which would read as "we looked it up and it is unknown"). */
  webMeta: PageMeta | null;
}

/** What a saved page declared about itself. Mirrors `extraction::PageMeta`
 * field for field. Absent means the page never said it: nothing here is ever
 * filled in from somewhere else. */
export interface PageMeta {
  title?: string;
  byline?: string;
  siteName?: string;
  published?: string;
  modified?: string;
  excerpt?: string;
  lang?: string;
  /** The room's own facts, not the page's. */
  sourceUrl?: string;
  capturedAt?: string;
}

/** The technical facts about a video, read from its container by
 * `media_probe.rs`. Mirrors that struct field for field — and every field is
 * nullable there for the same reason it is here: a container that never stated
 * its frame rate has no frame rate to show. */
export interface MediaMeta {
  durationSecs: number | null;
  /** DISPLAY size, with the track's rotation already applied. */
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  frameRate: number | null;
  bitrateKbps: number | null;
  /** `false` is a finding ("this video is silent"), `null` is ignorance. */
  hasAudio: boolean | null;
  audioCodec: string | null;
}

/** One charset the viewer's encoding picker offers. `name` is the WHATWG name
 * the backend reports back for it, so the menu's selection and the strip's
 * "read as …" are always the same string. */
export interface EncodingChoice {
  name: string;
  title: string;
}

/** A plain-text file re-read from its ORIGINAL BYTES (`decode_file_text`).
 *
 * Detection is a guess — the same legacy bytes genuinely are Turkish AND are
 * Cyrillic — so the viewer shows which encoding is in effect and lets a human
 * overrule it. Overruling re-reads the bytes in Rust; re-interpreting the
 * already-decoded string could only launder one wrong reading into another. */
export interface DecodedFileText {
  text: string;
  /** WHATWG name of the encoding in effect (`UTF-8`, `windows-1254`, …). */
  encoding: string;
  /** How that encoding was arrived at: a fact about the bytes (`bom`, `utf8`),
   * a guess (`detected`), or the user's own pick (`chosen`). */
  source: "bom" | "utf8" | "detected" | "chosen";
  /** Bytes with no meaning in this encoding became U+FFFD — the text on screen
   * is NOT the file, so it must never be saved back over it. */
  lossy: boolean;
  /** Whether this reading may be edited in place (format allows it AND the
   * decode was clean). */
  editable: boolean;
  options: EncodingChoice[];
}

// ---- ADD-27: the live Recording file ----

/** One transcribed word on the recording's timeline (centiseconds). `del`
 * marks words removed in the transcript editor — playback skips their span. */
export interface RecWord {
  w: string;
  t0: number;
  t1: number;
  del?: boolean;
}

export interface RecSegment {
  id: string;
  /** Which capture lane heard it: your mic, or the Mac's (meeting) audio. */
  source: "mic" | "sys";
  /** "You" for the mic; "Speaker N" for clustered meeting voices. */
  speaker: string;
  t0: number;
  t1: number;
  text: string;
  words: RecWord[];
  lang?: string | null;
}

/** A span deleted from the transcript; playback skips it, export removes it. */
export interface RecCut {
  t0: number;
  t1: number;
}

export interface RecMeta {
  /* No `version`: the Rust struct dropped it (there is no version dispatch),
     and a field declared here that the backend never sends is worse than no
     field — `meta.version < 2` type-checks and is silently false at runtime.
     `recording.rs`'s round-trip test asserts the key is absent from the wire. */
  durationCs: number;
  segments: RecSegment[];
  cuts: RecCut[];
  /** 0 = speakers are discovered from their voices (always, from the UI).
   * A non-zero value pins the participant count for an older room. */
  maxSpeakers: number;
  /** GH #5: machine label → the name the user gave them ("Speaker 2" → "Dana").
   * An overlay on top of `segments`, so re-clustering and re-transcribe (which
   * both rewrite the labels) can't destroy it. Absent until someone renames. */
  speakerNames?: Record<string, string>;
  /** Which of `speakerNames` the app GUESSED, from a voice this room has been
   * told the name of before — as opposed to a name the user typed.
   *
   * NAMES, not labels: re-clustering moves labels constantly, so a guess keyed
   * to one would be about a different person by the next pass. The screen has
   * to keep the two apart — a name the app inferred and a name the user
   * asserted are not the same claim, and only the first may be withdrawn. */
  recognized?: string[];
  /** What the room found when it read this recording, plus anything you wrote
   * yourself. All three are kept in time order and anchored on the ORIGINAL
   * timeline (the same one `cuts` are stated on), so a re-transcribe — which
   * remakes every segment — leaves them exactly where they were. */
  chapters?: RecChapter[];
  highlights?: RecHighlight[];
  notes?: RecNote[];
  /** The transcript the last reading was made from. Absent = never read, which
   * is what the background sweep looks for. When it no longer matches the
   * transcript, the tabs say the reading is out of date rather than presenting
   * old findings as current. */
  readOf?: { turns: number; chars: number };
}

/** Who put an item on the recording. `room` is the reading pass; `you` is the
 * person. Editing one of the room's items makes it yours, and the room never
 * touches it again — which is also the "Read again" rule.
 *
 * The distinction is the safety property of the whole feature: the room reads
 * every recording by itself and is sometimes wrong, and a made-up action item
 * with a colleague's name on it must never look like something you wrote. */
export type By = "room" | "you";

export type NoteKind = "decision" | "action" | "question" | "point";

export interface RecChapter {
  id: string;
  t0: number;
  title: string;
  by?: By;
}

export interface RecHighlight {
  id: string;
  t0: number;
  t1: number;
  by?: By;
}

export interface RecNote {
  id: string;
  t0: number;
  kind: NoteKind;
  text: string;
  /** Who an action is on — only ever somebody who actually speaks in this
   * recording; the backend drops a name it cannot find. */
  who?: string;
  by?: By;
}

/** A voice this room can recognise: someone named in a recording, whose
 * voiceprint is saved so later recordings put their name back automatically.
 * Stored in the encrypted room, never sent anywhere; the print itself never
 * crosses this boundary. */
export interface SavedVoice {
  name: string;
  /** Seconds of speech behind the saved voice — the evidence, in a unit a
   * person can weigh. */
  seconds: number;
  /** How many separate namings have been folded into it. */
  takes: number;
  /** How many times the user has said "that isn't them". */
  corrections: number;
  updatedAt: string;
}

export interface RecStart {
  fileId: string;
  name: string;
  meta: RecMeta;
  /** Authenticated renderer-owned `WS /rec/session` URL. */
  sessionUrl: string;
}

export interface RecLive {
  fileId: string;
  status: string;
  /** Fresh authenticated URL used to reattach after a renderer reload. */
  sessionUrl?: string;
  durationCs?: number;
  /** Durable per-source health [status, message] — lets a viewer that
   *  mounted after a fast failure still show the banner. */
  mic?: [string, string];
  sys?: [string, string];
}

export interface RecFile {
  name: string;
  meta: RecMeta;
}

// ---- ADD-28: feedback → GitHub issue ----

export interface FeedbackDraft {
  title: string;
  body: string;
}

export interface AppDiag {
  version: string;
  os: string;
  arch: string;
  /** "owner/repo" the issue opens against. */
  repo: string;
}

export interface AiStatus {
  running: boolean;
  /** True when Ollama is installed on this Mac even if not currently running
   * — lets onboarding tell "not installed" from "not started" (ADD-10). */
  installed: boolean;
  models: string[];
  defaultModel: string;
  /** Cloud CLIs detected on this Mac (Claude Code, Codex, Antigravity CLI). */
  external: string[];
  /** True when this room's Ollama is ANOTHER computer (Settings → the Closet).
   * The model name cannot carry that fact, so every "does content leave this
   * Mac?" surface must OR this in — see `workspace/markup.isCloudRoute`. */
  remoteRelay: boolean;
}

export const ENGINE_LABELS: Record<string, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
  "antigravity-cli": "Antigravity CLI",
  openrouter: "OpenRouter",
};

/** A specific model offered by a cloud engine (the Cloud picker's second
 * level) — `slug` is what gets sent to the CLI via `--model`, `label` is the
 * friendly display name, `efforts` are its supported reasoning levels (empty
 * if the engine has no effort knob), `defaultEffort` the engine-reported
 * default if any. */
export interface ExternalModelInfo {
  slug: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  contextWindow: number | null;
  description: string | null;
  /** OpenRouter prices in USD per token, exactly as returned by its live API. */
  inputPrice: string | null;
  outputPrice: string | null;
  inputModalities: string[];
  /** What the model PRODUCES, from the catalog's `architecture
   * .output_modalities`. The mirror of `inputModalities`. */
  outputModalities: string[];
  tools: boolean;
  vision: boolean;
  /** Derived from `outputModalities`, never from the slug — `vision` means it
   * can READ a picture, these mean it can MAKE one, and every vision model in
   * the app is the former and none is the latter. */
  imageOutput: boolean;
  videoOutput: boolean;
  reasoning: boolean;
  structuredOutputs: boolean;
}

/** Result of validating the provider's exact model ID before selection. */
export interface ModelSelectionValidation {
  selectable: boolean;
  /** Human-readable reason when selection is blocked. */
  reason: string | null;
}

/** One model the Create page may offer, as `list_create_models` returns it. */
export interface CreateModel {
  /** The full selection string a generation is started with, engine prefix
   * included ("openrouter::vendor/slug"). */
  model: string;
  slug: string;
  label: string;
  engine: string;
  engineLabel: string;
  local: boolean;
  description: string | null;
  /** Both may be true — a model that makes stills and clips shows on both tabs. */
  image: boolean;
  video: boolean;
  /** The provider's own per-token price, verbatim. Not converted to a
   * per-picture figure, which the room would have to invent. */
  outputPrice: string | null;
  /** What this model will actually accept, read from the provider's own media
   * endpoints. Null when it published nothing. Veo takes 4/6/8 seconds and
   * nothing else; Kling takes 3–15 — so a single invented list of lengths
   * would be refused by most of the shelf. */
  limits: MediaLimits | null;
}

/** The legal shapes for one media model. An EMPTY list means the provider
 * declined to say, which is not the same as "anything goes": the caller sends
 * nothing and the model's own default stands. */
export interface MediaLimits {
  durations: number[];
  resolutions: string[];
  aspectRatios: string[];
  /** "first_frame" / "last_frame". Empty = this model animates from words
   * alone, so offering a starting picture would be offering nothing. */
  frameImages: string[];
  /** How many guiding pictures it will look at. Null = unpublished. */
  maxReferences: number | null;
  generateAudio: boolean;
}

/** Someone a story is about.
 *
 * `faceFileId` is the load-bearing field. Character consistency does not come
 * from words — "a woman with red hair" is re-imagined on every call — it comes
 * from handing the model the same picture each time. */
export interface CastMember {
  id: string;
  name: string;
  description: string;
  story: string;
  faceFileId: string | null;
  ord: number;
}

/** One shot list. Called a SHOT LIST on screen, never a "script": this app
 * already uses that word for runnable Python. */
export interface StoryList {
  id: string;
  title: string;
  logline: string;
  /** The frame shape for every shot in the list, e.g. "16:9". One value for
   * the whole thing on purpose: a shot's still becomes its clip's literal
   * first frame, so a 1:1 picture pinned to a 16:9 clip is the wrong shape.
   * Empty = let each model's own default stand. */
  aspectRatio: string;
  /** Output size, per medium — the two catalogues publish different words for
   * it ("1K"/"2K" for pictures, "720p"/"1080p"/"4K" for clips). */
  stillResolution: string;
  clipResolution: string;
  shotCount: number;
  updatedAt: string;
}

/** A room file with readable text in it — something a script or a cast can be
 * read out of, rather than typed in again. */
export interface RoomDocument {
  fileId: string;
  name: string;
  /** Roughly how long, so a note and a 40-page script are told apart before
   * either is opened. */
  words: number;
  snippet: string;
}

/** Someone found in a document, before anyone has agreed to keep them. */
export interface ParsedMember {
  name: string;
  description: string;
  story: string;
}

/** What a character sheet turned out to contain. */
export interface CastFromFile {
  name: string;
  found: ParsedMember[];
  /** WHICH reader produced these — the room's model, or the pattern reader.
   * Shown, because the two are not equally trustworthy on a messy file and
   * "why did it split this wrong" is unanswerable without it. */
  readBy: string;
  /** Set when the model was meant to read it and could not. The fallback rows
   * must never pass for the model's work. */
  fellBack: string | null;
}

/** One shot exactly as it will be sent — or why it will not be.
 *
 * Built by the same Rust that runs the job, never assembled separately: a
 * preview that drifts from what it previews is worse than none, because it
 * puts one claim on screen above a button that pays for another. */
