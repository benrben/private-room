import { api } from "../api";
import { base64ToBytes } from "../viewers/util";

/** Idea 3 (Wave 4b): the room's spoken voice — sentence-chunked synthesis fed
 * from the ask-delta stream, played through a Web Audio "supernatural
 * archetype" DSP chain. Module-level singleton on purpose (same doctrine as
 * liveRec.ts): speech must survive view changes, so its lifetime can't belong
 * to any component — which is exactly why every lock path must call
 * cancelAll() explicitly.
 *
 * Epoch tokens (second-pass addendum): every async stage — chunker feed, the
 * synthesis pump, decode, scheduling callbacks — captures `epoch` and no-ops
 * when it went stale. beginTurn()/roundBoundary() advance BOTH epoch and
 * turnEpoch (audio killed, turn alive); cancelAll() advances only epoch
 * (turn dead: a later endOfTurn is a no-op, and a late-resolving synthesis
 * call can never schedule audio after Stop or lock). */

export type VoiceArchetype = "off" | "demon" | "ghost" | "wraith" | "ancient" | "custom";

/** The room speaks with ONE engine: Edge neural TTS via the sidecar —
 * multilingual voices at +22% rate / -2 Hz pitch, normalized to ~-16 LUFS.
 * Neural synthetic voices, not human recordings; the sentence text goes to
 * Microsoft's service (Settings discloses this). A failed sentence (offline,
 * sidecar down) is skipped — there is no on-device fallback voice. */

/** There is NO bundled voice roster: the Settings picker is fed from the
 * service's live catalog (api.listNeuralVoices) and the sidecar accepts any
 * catalog id in TtsRequest.voice. An empty/null id means the sidecar's
 * product default (Andrew, multilingual). */

export interface VoiceParams {
  /** Convolver wet mix 0–1 (custom archetype also derives IR length from it). */
  reverb: number;
  /** WaveShaper drive 0–1 (k = 8·d; 0 bypasses the shaper). */
  distortion: number;
}

export const ARCHETYPE_DEFAULTS: Record<Exclude<VoiceArchetype, "custom">, VoiceParams> = {
  off: { reverb: 0, distortion: 0 },
  demon: { reverb: 0.4, distortion: 0.5 },
  ghost: { reverb: 0.6, distortion: 0 },
  // Wraith is deliberately its own preset (the user's list names all four):
  // more shimmer than ghost, longer tail.
  wraith: { reverb: 0.7, distortion: 0 },
  ancient: { reverb: 0.3, distortion: 0.19 },
};

interface VoiceConfig {
  archetype: VoiceArchetype;
  params: VoiceParams;
  autoSpeak: boolean;
  /** Curated neural voice id; null/"" = the product default (Andrew). */
  neuralVoiceId: string | null;
}

// ---- module state ---------------------------------------------------------

let ctx: AudioContext | null = null;
let cfg: VoiceConfig = {
  archetype: "off",
  params: { ...ARCHETYPE_DEFAULTS.off },
  autoSpeak: false,
  neuralVoiceId: null,
};

/** Generation token: any async continuation captured under an older value is
 * stale and must do nothing. */
let epoch = 0;
/** The epoch of the currently-alive turn; endOfTurn/feed no-op when it
 * doesn't match `epoch` (i.e. after cancelAll). */
let turnEpoch = -1;

/** Sentence chunker state. `pending` holds raw not-yet-cut text (an open
 * ``` fence and everything after it stays held here until it closes). */
let pending = "";
/** Short sentences merge forward until they reach a speakable size. */
let carry = "";
/** Sentences awaiting synthesis. */
let sentenceQueue: string[] = [];
let pumping = false;
/** Did this turn's stream feed any deltas? (External CLI engines emit none —
 * endOfTurn then speaks the persisted answer instead.) */
let deltasFed = false;
/** endOfTurn ran for the current turn (playback-done may fire). */
let turnEnded = false;
/** Was the current speech started by the streaming turn path (vs manual
 * play/preview)? Hands-free only re-arms after a real turn. */
let streamedTurn = false;

/** Sources currently scheduled/playing, so cancel can silence instantly. */
let liveSources: AudioBufferSourceNode[] = [];
/** Scheduled-but-not-finished chunk groups (for isSpeaking + done detection). */
let liveGroups = 0;
/** Gapless sequencing cursor (see scheduleChunk). */
let lastChunkEnd = 0;

/** Fires when a streamed turn's audio has fully finished playing (hands-free
 * re-arms the mic here — never earlier, so the mic can't capture the speaker). */
let onTurnAudioDone: (() => void) | null = null;
/** Per-message play state callback (Play/Stop button label). */
let onManualState: ((playing: boolean) => void) | null = null;
/** Where a sentence that could not be synthesized is reported (a toast). */
let onVoiceProblem: ((message: string) => void) | null = null;
/** One report per turn, not one per dropped sentence. */
let problemReported = false;

/** Cached procedurally-generated impulse responses, keyed `${secs}:${decay}`.
 * Tied to the AudioContext (buffers belong to it). */
const irCache = new Map<string, AudioBuffer>();

const MIN_CHUNK_CHARS = 60;
/** The FIRST chunk of a turn may be shorter.
 *
 * Sixty characters is what makes the voice sound like prose rather than a list
 * of fragments, and it stays the rule for everything after the opening. But it
 * also holds a short opener — "Sure, let me check that." — silent until a
 * second sentence arrives to pad it, which spends the one moment the wait is
 * most felt. Trading intonation on the opening line for a faster first word is
 * the right way round; trading it on every line is not. */
const MIN_FIRST_CHUNK_CHARS = 25;
const FORCE_FLUSH_CHARS = 300;
/** Has this turn already sent a chunk to synthesis? Only the first one gets
 * the lower floor above. */
let firstChunkSent = false;

// ---- context / gesture unlock --------------------------------------------

/** Create + resume the shared AudioContext. MUST be called synchronously
 * inside a real user gesture (send click/Enter, Play, the auto-speak toggle,
 * Settings Preview) — WKWebView keeps a context created outside a gesture
 * suspended, and resume() only succeeds while the gesture's activation is
 * alive (same doctrine as acquireMic in liveRec.ts). */
export function ensureUnlocked(): void {
  if (!ctx) {
    ctx = new AudioContext();
    irCache.clear();
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
}

// ---- configuration --------------------------------------------------------

export function configure(next: Partial<VoiceConfig>): void {
  cfg = { ...cfg, ...next };
}

export function autoSpeakOn(): boolean {
  // The chat toggle alone decides — the archetype only picks the sound
  // ("off" = the plain system voice, same clean chain per-message Play uses).
  // Gating on archetype here made the toggle a silent no-op until the user
  // discovered Settings → Spoken voice.
  return cfg.autoSpeak;
}

/** Audio is scheduled or audibly playing. The autolock tick treats this as
 * activity (like a live recording): listening IS using the room. */
export function isSpeaking(): boolean {
  return liveGroups > 0;
}

// ---- turn lifecycle --------------------------------------------------------

/** The conversation that owns the voice pipeline right now, or null when the
 * turn was opened without one (nothing to distinguish, so everything passes). */
let turnChat: string | null = null;

/** A streamed ask is open and still owes hands-free its re-arm.
 *
 * Deliberately NOT `streamedTurn`, which says who owns the audio pipeline: a
 * per-message Play or a Settings Preview takes the pipeline mid-answer without
 * ending the ask behind it. Reading the re-arm off ownership meant that ask's
 * `endOfTurn` no-opped, the mic was never re-armed, and hands-free died with
 * nothing on screen saying why. Only beginTurn opens this; only cancelAll (Stop,
 * lock — the turn is dead) and the fired signal close it. */
let turnOpen = false;
/** That ask has closed and the signal is owed as soon as the pipeline is quiet
 * — never while audio is still playing, or the mic would hear the speaker. */
let turnDonePending = false;

/** A new ask begins: silence the old answer, invalidate every in-flight
 * continuation, and open a fresh turn. `chatId` is the conversation whose turn
 * this is (owner replacement #4) — there is one voice pipeline, so it belongs
 * to whichever turn most recently claimed it, and only that turn's deltas may
 * be spoken. */
export function beginTurn(chatId: string | null = null): void {
  stopAudio();
  epoch += 1;
  turnEpoch = epoch;
  turnChat = chatId;
  pending = "";
  carry = "";
  sentenceQueue = [];
  firstChunkSent = false;
  deltasFed = false;
  turnEnded = false;
  streamedTurn = true;
  turnOpen = true;
  turnDonePending = false;
  problemReported = false;
  overrides = null;
}

/** May this chat's stream events drive the voice?
 *
 * The pipeline follows the TURN, not the screen. Gating on "is this the chat on
 * screen" instead would drop the deltas that arrive while the user is looking
 * elsewhere — and since `feedStreamDelta` accumulates a sentence buffer, the
 * hole is invisible: the answer would be READ ALOUD with words missing that are
 * plainly there on the page. */
export function turnBelongsTo(chatId: string | null): boolean {
  return turnChat === null || turnChat === chatId;
}

/** ask-round: the sidecar streams deltas in EVERY round and the round event
 * discards the previous round's text — so queued-but-unplayed chunks and
 * in-flight synthesis for the old round are dropped here. Already-audible
 * speech is stopped too (it was deliberation text, not the answer). We speak
 * optimistically ("thinking aloud") because `final` is never re-emitted by
 * the bridge and the last round is only knowable at stream end — buffering
 * per round would delay ALL speech to end-of-turn (second-pass addendum). */
export function roundBoundary(): void {
  // Guarded on streamedTurn too: a per-message Play pressed mid-ask owns the
  // current epoch — round events from the still-running ask must not kill it.
  if (!streamedTurn || turnEpoch !== epoch) return;
  stopAudio();
  epoch += 1;
  turnEpoch = epoch;
  pending = "";
  carry = "";
  sentenceQueue = [];
  // A new round replaces the text, so its opening line is a first word again.
  firstChunkSent = false;
}

/** Feed one ask-delta. No-ops when auto-speak is off or the turn is dead.
 * Owner replacement #4: ask-* events name their chat now, and effects.ts only
 * calls this for the conversation that owns the pipeline (`turnBelongsTo`), so
 * a headless or background run can no longer speak over the answer the user is
 * actually listening to. */
export function feedStreamDelta(delta: string): void {
  if (!autoSpeakOn() || !streamedTurn || turnEpoch !== epoch) return;
  deltasFed = true;
  pending += delta;
  extractSentences(false);
}

/** The turn's stream finished. Flush the remainder (dropping any still-open
 * fence) — or, when no deltas ever arrived (external CLI engines return the
 * answer whole, no ask-delta), speak the persisted answer instead. Dead
 * turns (cancelAll ran: user Stop, lock) no-op — runGuarded's `finally`
 * reaches here even on a cancelled ask. */
export function endOfTurn(finalText?: string): void {
  if (streamedTurn && turnEpoch === epoch) {
    if (turnEnded) return;
    turnEnded = true;
    if (autoSpeakOn()) {
      if (!deltasFed && finalText) pending = finalText;
      extractSentences(true);
    }
  } else if (!turnOpen) {
    // The turn is dead (cancelAll: Stop, lock) or there was never one.
    return;
  }
  // Otherwise the ask closed while a manual Play or Preview owned the pipeline:
  // none of this answer will be spoken, but the ask still ENDED, and hands-free
  // is owed its re-arm as soon as whatever is playing has played out.
  turnOpen = false;
  turnDonePending = true;
  // Always close the turn: with auto-speak off nothing was scheduled, and
  // hands-free still needs the done signal to re-arm the mic (silent mode —
  // the user reads the answer instead of hearing it).
  maybeFireTurnDone();
}

/** Stop everything, now: sources, queue, chunker, in-flight synthesis (its
 * continuations go stale). The turn is dead — a later endOfTurn no-ops. */
export function cancelAll(): void {
  epoch += 1;
  stopAudio();
  pending = "";
  carry = "";
  sentenceQueue = [];
  firstChunkSent = false;
  turnEnded = false;
  streamedTurn = false;
  turnOpen = false;
  turnDonePending = false;
  overrides = null;
  if (onManualState) {
    onManualState(false);
    onManualState = null;
  }
}

/** Speak arbitrary text (per-message Play, Settings Preview). Routes through
 * the same sentence chunker + pipeline as streaming, so >1,000-char messages
 * split instead of erroring. Overrides let Preview speak the live slider
 * values before they're saved. */
export function speakText(
  text: string,
  opts?: {
    archetype?: VoiceArchetype;
    params?: VoiceParams;
    neuralVoiceId?: string | null;
    onState?: (playing: boolean) => void;
  },
): void {
  // A manual play TAKES the pipeline; it does not end the ask that may still be
  // streaming behind it. `cancelAll` closes a turn for good (Stop, lock), so the
  // ask's outstanding re-arm is carried across it rather than lost — see
  // `turnOpen`.
  const askOpen = turnOpen;
  const askOwedDone = turnDonePending;
  cancelAll();
  turnOpen = askOpen;
  turnDonePending = askOwedDone;
  epoch += 1;
  turnEpoch = epoch;
  streamedTurn = false;
  problemReported = false;
  if (
    opts?.archetype !== undefined ||
    opts?.params ||
    opts?.neuralVoiceId !== undefined
  ) {
    overrides = {
      archetype: opts?.archetype ?? cfg.archetype,
      params: opts?.params ?? cfg.params,
      neuralVoiceId:
        opts?.neuralVoiceId === undefined ? cfg.neuralVoiceId : opts.neuralVoiceId,
    };
  } else {
    overrides = null;
  }
  onManualState = opts?.onState ?? null;
  onManualState?.(true);
  pending = text;
  extractSentences(true);
  turnEnded = true;
  maybeFireTurnDone();
}

/** Active per-call overrides (manual speakText only). */
let overrides: {
  archetype: VoiceArchetype;
  params: VoiceParams;
  neuralVoiceId: string | null;
} | null = null;

export function setTurnAudioDoneListener(cb: (() => void) | null): void {
  onTurnAudioDone = cb;
}

/** Where a synthesis failure is reported (effects.ts turns it into a toast).
 * There is NO on-device fallback voice: a sentence that cannot be synthesized
 * is dropped, and without this the app simply went quiet and looked mute. */
export function setVoiceProblemListener(
  cb: ((message: string) => void) | null,
): void {
  onVoiceProblem = cb;
}

/** At most once per turn — one answer that cannot be spoken is ONE problem,
 * not one per sentence. */
function reportVoiceProblem(message: string): void {
  if (problemReported) return;
  problemReported = true;
  onVoiceProblem?.(message);
}

/** Why the synthesis call itself failed, in the words that fit what happened.
 *
 * The room's internet switch is its OWN answer, not a service failure: the host
 * refuses before anything leaves (speech_cmds::SPEECH_OFFLINE_MESSAGE), and
 * "the voice service didn't answer" would blame the wrong thing and hide the
 * one-click fix. Matched on the settings path the host names. */
function synthesisProblem(reason: string): string {
  if (reason.includes("Online features")) {
    return "Couldn't read that aloud — spoken answers use an online voice service, and this room's internet switch is off (Settings → Online features). The answer is still on screen.";
  }
  return navigator.onLine
    ? "Couldn't read that aloud — the voice service didn't answer. The answer is still on screen."
    : "Couldn't read that aloud — reading answers aloud needs an internet connection. The answer is still on screen.";
}

/** WKWebView keeps an AudioContext created or resumed outside a user gesture
 * suspended (see ensureUnlocked). Hands-free is where this actually bites: from
 * the second turn on, `send()` is called from a dictation callback rather than
 * a click, so a context that never got its gesture can never resume — and this
 * used to `continue` without a word, in the one mode built for a user who is
 * not watching the screen. Play is a real gesture and unlocks it. */
const AUDIO_LOCKED_MESSAGE =
  "Couldn't read that aloud — this Mac only starts audio from a click. Press Play on the answer to switch the voice back on. The answer is still on screen.";

/** The service answered and the bytes would not decode. Rare, and nothing the
 * user can act on — but silence here is indistinguishable from a mute app. */
const AUDIO_UNREADABLE_MESSAGE =
  "Couldn't read that aloud — the audio came back unreadable. The answer is still on screen.";

function activeArchetype(): VoiceArchetype {
  return overrides?.archetype ?? cfg.archetype;
}

function activeParams(): VoiceParams {
  return overrides?.params ?? cfg.params;
}

function activeNeuralVoiceId(): string | null {
  return overrides?.neuralVoiceId ?? cfg.neuralVoiceId;
}

// ---- sentence chunker ------------------------------------------------------

/** Markdown → speakable prose. Complete fenced blocks are gone before this
 * runs (extractSentences holds open fences), so this only strips inline
 * markers: links keep their label, emphasis/heading/table syntax drops. */
function stripForSpeech(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n?[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/[*_~|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut complete sentences out of `pending` into the synthesis queue.
 * Fence-stateful (review amendment): text from an unmatched ``` onward is
 * held un-spoken until the closing fence arrives (streamed viewer-markup
 * JSON must never be read aloud); `force` (endOfTurn) DROPS a still-open
 * fence rather than flushing it. */
function extractSentences(force: boolean): void {
  // Complete fences drop wholesale (annotation/boxes payloads, code blocks).
  pending = pending.replace(/```[a-zA-Z0-9_-]*\n?[\s\S]*?```/g, " ");
  let work = pending;
  let held = "";
  const fenceIdx = work.indexOf("```");
  if (fenceIdx >= 0) {
    held = work.slice(fenceIdx);
    work = work.slice(0, fenceIdx);
  }

  // Sentence enders, Western AND CJK: 。！？ are the full stop / bang / query
  // of Chinese and Japanese, and their closing quotes and brackets are the
  // trailing punctuation that belongs to the sentence just cut. Without them
  // those scripts never split at all and the whole answer arrives as one
  // over-long chunk the synthesizer refuses (see emit).
  const re = /[.!?…。！？]+[\s"')\]」』）】》〉”’]*/g;
  let cut = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(work))) {
    const end = m.index + m[0].length;
    // Don't cut INSIDE a token: a decimal ("3.5b"), a filename, a host and path
    // ("example.com/setup.html"). Cutting there also splits a markdown link
    // across two chunks, where `stripForSpeech` can no longer match it and the
    // raw URL is read out, brackets and all.
    //
    // The match ITSELF is what separates the two: the trailing class above has
    // already eaten any space, so `m[0] === "."` exactly means nothing at all
    // stands between this dot and the next character. A capital still ends the
    // sentence, for the missing-space case ("…done.Next…"). Testing the
    // FOLLOWING character instead would have kept every script without capitals
    // — Hebrew and Arabic, both first-class here — in one unbroken chunk until
    // the force-flush size, cut mid-clause.
    const after = work[end] ?? "";
    if (m[0] === "." && after !== "" && !/\p{Lu}/u.test(after)) continue;
    emit(work.slice(cut, end));
    cut = end;
  }
  let rest = work.slice(cut);

  // Force-flush a runaway sentence at ~300 chars, cutting on the nearest
  // mid-sentence break — and on the character count when there is none, which
  // is the normal case in CJK (no spaces, and a clause can run without any
  // punctuation). Bailing out there used to leave the chunk to grow past the
  // synthesizer's limit, where it was dropped without a sound.
  while (rest.length + carry.length > FORCE_FLUSH_CHARS) {
    const cutAt = breakPoint(rest.slice(0, FORCE_FLUSH_CHARS));
    if (cutAt <= 0) break;
    emit(rest.slice(0, cutAt));
    rest = rest.slice(cutAt);
  }

  if (force) {
    // End of turn: speak the tail, drop (never speak) an open fence.
    emit(rest);
    flushCarry();
    pending = "";
  } else {
    pending = rest + held;
  }
}

/** Mid-sentence break characters. `、，；：` are the ideographic and fullwidth
 * forms: Chinese and Japanese write no spaces, so without them a long clause
 * offers nowhere to cut. */
const SOFT_BREAKS = ",;: 、，；：";

/** Where to cut a chunk that has outgrown FORCE_FLUSH_CHARS: just past the
 * last break character in `window`, or the end of the window itself when it
 * holds none. Non-zero for any non-empty window, so callers can loop on it. */
function breakPoint(window: string): number {
  let at = -1;
  for (const ch of SOFT_BREAKS) at = Math.max(at, window.lastIndexOf(ch));
  return at > 0 ? at + 1 : window.length;
}

/** Queue one cut chunk, merging short ones forward until ~60 chars. One
 * sentence can still be longer than the synthesizer's per-call limit
 * (MAX_SPEAK_CHARS = 1,000 in speak_text_neural, which rejects an oversize
 * chunk — and `pump` skips a rejected chunk without a word), so anything past
 * the force-flush size is split here as well. */
function emit(raw: string): void {
  let s = stripForSpeech(raw);
  if (!s) return;
  while (s.length > FORCE_FLUSH_CHARS) {
    const cutAt = breakPoint(s.slice(0, FORCE_FLUSH_CHARS));
    if (cutAt <= 0) break;
    queueChunk(s.slice(0, cutAt));
    s = s.slice(cutAt).trimStart();
  }
  queueChunk(s);
}

/** Merge one piece into the carry, flushing once it is worth speaking. */
function queueChunk(piece: string): void {
  if (!piece) return;
  carry = carry ? `${carry} ${piece}` : piece;
  const floor = firstChunkSent ? MIN_CHUNK_CHARS : MIN_FIRST_CHUNK_CHARS;
  if (carry.length >= floor) flushCarry();
}

function flushCarry(): void {
  if (!carry) return;
  sentenceQueue.push(carry);
  carry = "";
  firstChunkSent = true;
  void pump();
}

// ---- synthesis pump --------------------------------------------------------

/** Serial synthesis: while chunk N plays (scheduling is immediate), chunk
 * N+1 is already synthesizing — the 1-deep lookahead that lets audio start
 * before the stream ends. Every await re-checks the captured epoch. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (sentenceQueue.length > 0) {
      const myEpoch = epoch;
      const text = sentenceQueue.shift()!;
      let b64: string;
      try {
        // Edge neural (+22%, -2 Hz, ~-16 LUFS) via the sidecar, with the
        // room's chosen roster voice (null = Andrew). Volume shaping for
        // whispery archetypes applies in the DSP graph via `master.gain`,
        // not synthesis-side.
        b64 = await api.speakTextNeural(text, activeNeuralVoiceId());
      } catch (e) {
        // Stopped (or the room locked) while this call was in flight: the user
        // ended this turn, so a failure that lands afterwards is not a problem
        // to report — the epoch check comes FIRST, before the toast.
        if (epoch !== myEpoch) return;
        // Offline / sidecar down / this room's internet switch off: skip this
        // sentence and try the next — but say so, once, in the words that fit
        // what actually happened. Silence is indistinguishable from a broken app.
        reportVoiceProblem(synthesisProblem(String(e)));
        continue;
      }
      if (epoch !== myEpoch) return;
      const c = ctx;
      if (!c || c.state !== "running") {
        reportVoiceProblem(AUDIO_LOCKED_MESSAGE);
        continue;
      }
      let buf: AudioBuffer;
      try {
        const bytes = base64ToBytes(b64);
        buf = await c.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      } catch {
        reportVoiceProblem(AUDIO_UNREADABLE_MESSAGE);
        continue;
      }
      if (epoch !== myEpoch) return;
      scheduleChunk(c, buf, myEpoch);
    }
  } finally {
    pumping = false;
    maybeFireTurnDone();
  }
}

// ---- DSP graphs -------------------------------------------------------------

function makeDistortionCurve(k: number): Float32Array {
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    const x = (i * 2) / 1023 - 1;
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

/** Procedurally generated impulse response: stereo noise with a (1-t)^decay
 * envelope. No bundled IR files — zero bloat, CSP-safe (connect-src allows
 * only self/ipc), and the reverb slider can re-parameterize length live. */
function makeImpulse(c: AudioContext, seconds: number, decay: number): AudioBuffer {
  const key = `${seconds}:${decay}`;
  const cached = irCache.get(key);
  if (cached) return cached;
  const len = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  irCache.set(key, buf);
  return buf;
}

/** Dry/wet convolver mixer. `wet` 0 bypasses entirely. */
function reverbMix(
  c: AudioContext,
  input: AudioNode,
  seconds: number,
  decay: number,
  wet: number,
): AudioNode {
  if (wet <= 0.001) return input;
  const out = c.createGain();
  const dry = c.createGain();
  dry.gain.value = 1 - wet * 0.5; // keep intelligibility under heavy reverb
  const conv = c.createConvolver();
  conv.buffer = makeImpulse(c, seconds, decay);
  const wetGain = c.createGain();
  wetGain.gain.value = wet;
  input.connect(dry).connect(out);
  input.connect(conv).connect(wetGain).connect(out);
  return out;
}

function shaper(c: AudioContext, input: AudioNode, k: number): AudioNode {
  if (k <= 0.01) return input;
  const ws = c.createWaveShaper();
  ws.curve = makeDistortionCurve(k);
  ws.oversample = "4x";
  return input.connect(ws);
}

/** LFO → GainNode helper for chorus/tremolo. Started/stopped with the chunk. */
function lfo(
  c: AudioContext,
  hz: number,
  depth: number,
  target: AudioParam,
  when: number,
  until: number,
): void {
  const osc = c.createOscillator();
  osc.frequency.value = hz;
  const g = c.createGain();
  g.gain.value = depth;
  osc.connect(g).connect(target);
  osc.start(when);
  osc.stop(until);
}

/** Per-archetype effective playback duration (second-pass addendum: the
 * detuned copies stretch audible time — demon's 0.88-rate double runs ~14%
 * longer than buffer.duration; naive sequencing would overlap every chunk). */
function effectiveDuration(arch: VoiceArchetype, buf: AudioBuffer): number {
  if (arch === "demon") return buf.duration / 0.88;
  if (arch === "ancient") return buf.duration / 0.94 + 0.035;
  return buf.duration;
}

/** Build the archetype graph for one decoded chunk and schedule it gaplessly
 * after whatever is already queued. */
function scheduleChunk(c: AudioContext, buf: AudioBuffer, myEpoch: number): void {
  const arch = activeArchetype();
  const p = activeParams();
  const master = c.createGain();
  master.connect(c.destination);

  const sources: AudioBufferSourceNode[] = [];
  const src = (rate: number, gain: number): AudioBufferSourceNode => {
    const s = c.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = gain;
    s.connect(g);
    g.connect(head);
    sources.push(s);
    return s;
  };

  // `head` collects the (possibly layered) sources; `tail` is the end of the
  // per-archetype chain feeding the master gain.
  const head: GainNode = c.createGain();
  let tail: AudioNode = head;
  const when = Math.max(c.currentTime + 0.02, lastChunkEnd);
  const dur = effectiveDuration(arch, buf);
  const until = when + dur + 6; // LFO life: chunk + reverb tail headroom

  switch (arch) {
    case "demon": {
      master.gain.value = 0.9;
      src(0.88, 1.0);
      src(0.983, 0.5); // the "legion" double
      const shelf = c.createBiquadFilter();
      shelf.type = "lowshelf";
      shelf.frequency.value = 200;
      shelf.gain.value = 6;
      tail = tail.connect(shelf);
      tail = shaper(c, tail, Math.max(4, 8 * p.distortion));
      tail = reverbMix(c, tail, 2.5, 3, p.reverb);
      break;
    }
    case "ghost": {
      master.gain.value = 0.8;
      src(1.0, 1.0);
      const hp = c.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 300;
      tail = tail.connect(hp);
      tail = chorus(c, tail, 0.018, 0.3, 0.004, when, until);
      tail = tremolo(c, tail, 2.2, 0.12, when, until);
      tail = reverbMix(c, tail, 4, 2, p.reverb);
      break;
    }
    case "wraith": {
      master.gain.value = 0.8;
      src(1.0, 1.0);
      const hp = c.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 500;
      tail = tail.connect(hp);
      tail = chorus(c, tail, 0.014, 0.5, 0.005, when, until);
      tail = tremolo(c, tail, 4, 0.2, when, until);
      tail = reverbMix(c, tail, 6, 2, p.reverb);
      break;
    }
    case "ancient": {
      master.gain.value = 0.9;
      const offsets = [0, 0.02, 0.035];
      const rates = [1.0, 0.94, 1.06];
      const gains = [1, 0.45, 0.35];
      for (let i = 0; i < 3; i++) {
        const s = src(rates[i], gains[i]);
        s.start(when + offsets[i]);
      }
      tail = shaper(c, tail, Math.max(1.5, 8 * p.distortion));
      tail = reverbMix(c, tail, 1.8, 2.5, p.reverb);
      break;
    }
    default: {
      // off (manual play) / custom: clean chain, sliders decide everything.
      master.gain.value = 0.9;
      src(1.0, 1.0);
      if (arch === "custom") {
        tail = shaper(c, tail, 8 * p.distortion);
        tail = reverbMix(c, tail, 1 + 3 * p.reverb, 2, p.reverb);
      }
    }
  }
  tail.connect(master);

  for (const s of sources) {
    if (arch !== "ancient") s.start(when);
    liveSources.push(s);
  }
  liveGroups += 1;
  lastChunkEnd = when + dur;

  // The longest-running source marks the chunk's end.
  let longest = sources[0];
  for (const s of sources) {
    if (s.playbackRate.value < longest.playbackRate.value) longest = s;
  }
  longest.onended = () => {
    liveSources = liveSources.filter((s) => !sources.includes(s));
    liveGroups = Math.max(0, liveGroups - 1);
    if (epoch !== myEpoch) return;
    maybeFireTurnDone();
  };
}

function chorus(
  c: AudioContext,
  input: AudioNode,
  delaySec: number,
  hz: number,
  depth: number,
  when: number,
  until: number,
): AudioNode {
  const out = c.createGain();
  const dry = c.createGain();
  dry.gain.value = 0.7;
  const delay = c.createDelay(0.1);
  delay.delayTime.value = delaySec;
  lfo(c, hz, depth, delay.delayTime, when, until);
  input.connect(dry).connect(out);
  input.connect(delay).connect(out);
  return out;
}

function tremolo(
  c: AudioContext,
  input: AudioNode,
  hz: number,
  depth: number,
  when: number,
  until: number,
): AudioNode {
  const g = c.createGain();
  g.gain.value = 1 - depth;
  lfo(c, hz, depth, g.gain, when, until);
  return input.connect(g);
}

// ---- teardown / completion ---------------------------------------------------

function stopAudio(): void {
  for (const s of liveSources) {
    try {
      s.onended = null;
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  liveSources = [];
  liveGroups = 0;
  lastChunkEnd = 0;
}

/** All audio for a finished turn has played out → notify (hands-free) and
 * clear the manual play state. */
function maybeFireTurnDone(): void {
  if (!turnEnded || pumping || sentenceQueue.length > 0 || liveGroups > 0) return;
  if (onManualState) {
    onManualState(false);
    onManualState = null;
  }
  if (turnDonePending) {
    turnDonePending = false;
    streamedTurn = false;
    onTurnAudioDone?.();
  }
}
