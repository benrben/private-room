import { api } from "../api";
import { base64ToBytes } from "../viewers/util";
import { ARCHETYPE_DEFAULTS, type VoiceArchetype, type VoiceConfig, type VoiceParams } from "./voiceConfig";
import { clearVoiceDspCache, scheduleDspChunk } from "./voiceDsp";
import { breakPoint, emitCompleteSentences, flushLongRemainder, FORCE_FLUSH_CHARS, splitOpenFence, stripForSpeech } from "./voiceText";

export { ARCHETYPE_DEFAULTS };
export type { VoiceArchetype, VoiceParams };

/** Singleton streaming voice pipeline. Epoch tokens make every asynchronous
 * stage no-op after a newer turn, Stop, or lock takes ownership. */

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

const MIN_CHUNK_CHARS = 60;
/** The FIRST chunk of a turn may be shorter.
 * Later chunks stay longer so their intonation sounds like prose. */
const MIN_FIRST_CHUNK_CHARS = 25;
/** Has this turn already sent a chunk to synthesis? Only the first one gets
 * the lower floor above. */
let firstChunkSent = false;

// ---- context / gesture unlock --------------------------------------------

/** Create and resume the context synchronously inside a real user gesture. */
export function ensureUnlocked(): void {
  if (!ctx) {
    ctx = new AudioContext();
    clearVoiceDspCache();
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

/** A streamed ask is open and still owes hands-free its re-arm. This remains
 * independent of manual playback temporarily taking the audio pipeline. */
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
    finishStreamedTurn(finalText);
  } else if (!turnOpen) {
    // The turn is dead (cancelAll: Stop, lock) or there was never one.
    return;
  }
  closeTurn();
}

function finishStreamedTurn(finalText: string | undefined): void {
  turnEnded = true;
  if (!autoSpeakOn()) return;
  if (!deltasFed && finalText) pending = finalText;
  extractSentences(true);
}

function closeTurn(): void {
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
  preserveAskThroughManualTakeover();
  epoch += 1;
  turnEpoch = epoch;
  streamedTurn = false;
  problemReported = false;
  overrides = manualOverrides(opts);
  onManualState = opts?.onState ?? null;
  onManualState?.(true);
  pending = text;
  extractSentences(true);
  turnEnded = true;
  maybeFireTurnDone();
}

function preserveAskThroughManualTakeover(): void {
  const askOpen = turnOpen;
  const askOwedDone = turnDonePending;
  cancelAll();
  turnOpen = askOpen;
  turnDonePending = askOwedDone;
}

function manualOverrides(
  opts: Parameters<typeof speakText>[1],
): VoiceOverrides | null {
  if (!hasManualOverrides(opts)) return null;
  return {
    archetype: opts?.archetype ?? cfg.archetype,
    params: opts?.params ?? cfg.params,
    neuralVoiceId:
      opts?.neuralVoiceId === undefined ? cfg.neuralVoiceId : opts.neuralVoiceId,
  };
}

function hasManualOverrides(opts: Parameters<typeof speakText>[1]): boolean {
  return (
    opts?.archetype !== undefined ||
    Boolean(opts?.params) ||
    opts?.neuralVoiceId !== undefined
  );
}

/** Active per-call overrides (manual speakText only). */
type VoiceOverrides = {
  archetype: VoiceArchetype;
  params: VoiceParams;
  neuralVoiceId: string | null;
};

let overrides: VoiceOverrides | null = null;

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
/** Cut complete sentences out of `pending` into the synthesis queue.
 * Fence-stateful (review amendment): text from an unmatched ``` onward is
 * held un-spoken until the closing fence arrives (streamed viewer-markup
 * JSON must never be read aloud); `force` (endOfTurn) DROPS a still-open
 * fence rather than flushing it. */
function extractSentences(force: boolean): void {
  // Complete fences drop wholesale (annotation/boxes payloads, code blocks).
  pending = pending.replace(/```[a-zA-Z0-9_-]*\n?[\s\S]*?```/g, " ");
  const { work, held } = splitOpenFence(pending);

  // Sentence enders, Western AND CJK: 。！？ are the full stop / bang / query
  // of Chinese and Japanese, and their closing quotes and brackets are the
  // trailing punctuation that belongs to the sentence just cut. Without them
  // those scripts never split at all and the whole answer arrives as one
  // over-long chunk the synthesizer refuses (see emit).
  let rest = emitCompleteSentences(work, emit);

  // Force-flush a runaway sentence at ~300 chars, cutting on the nearest
  // mid-sentence break — and on the character count when there is none, which
  // is the normal case in CJK (no spaces, and a clause can run without any
  // punctuation). Bailing out there used to leave the chunk to grow past the
  // synthesizer's limit, where it was dropped without a sound.
  rest = flushLongRemainder(rest, carry.length, emit);

  if (force) {
    // End of turn: speak the tail, drop (never speak) an open fence.
    emit(rest);
    flushCarry();
    pending = "";
  } else {
    pending = rest + held;
  }
}

/** Keep decimals, filenames, and host names intact until a true sentence end. */
/** Mid-sentence break characters. `、，；：` are the ideographic and fullwidth
 * forms: Chinese and Japanese write no spaces, so without them a long clause
 * offers nowhere to cut. */
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
      if (!(await scheduleSentence(text, myEpoch))) return;
    }
  } finally {
    pumping = false;
    maybeFireTurnDone();
  }
}

/** Resolve, decode, and schedule one sentence. False means a newer turn took
 * ownership while an async stage was outstanding, so the pump must stop. */
async function scheduleSentence(text: string, myEpoch: number): Promise<boolean> {
  const synthesized = await synthesizeForEpoch(text, myEpoch);
  if (synthesized === undefined) return false;
  if (synthesized === null) return true;
  const context = runningAudioContext();
  if (!context) return true;
  const buffer = await decodeSpeech(context, synthesized);
  if (!buffer) return true;
  if (epoch !== myEpoch) return false;
  scheduleChunk(context, buffer, myEpoch);
  return true;
}

/** `undefined` is stale; `null` is one reported sentence failure to skip. */
async function synthesizeForEpoch(
  text: string,
  myEpoch: number,
): Promise<string | null | undefined> {
  try {
    // Edge neural (+22%, -2 Hz, ~-16 LUFS) via the sidecar, with the room's
    // chosen roster voice (null = Andrew). Volume shaping happens in the DSP graph.
    const audio = await api.speakTextNeural(text, activeNeuralVoiceId());
    if (epoch !== myEpoch) return undefined;
    return audio;
  } catch (error) {
    if (epoch !== myEpoch) return undefined;
    reportVoiceProblem(synthesisProblem(String(error)));
    return null;
  }
}

function runningAudioContext(): AudioContext | null {
  const context = ctx;
  if (context && context.state === "running") return context;
  reportVoiceProblem(AUDIO_LOCKED_MESSAGE);
  return null;
}

async function decodeSpeech(
  context: AudioContext,
  encodedAudio: string,
): Promise<AudioBuffer | null> {
  try {
    const bytes = base64ToBytes(encodedAudio);
    return await context.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
  } catch {
    reportVoiceProblem(AUDIO_UNREADABLE_MESSAGE);
    return null;
  }
}

// ---- DSP graphs -------------------------------------------------------------

/** Build the archetype graph for one decoded chunk and schedule it gaplessly
 * after whatever is already queued. */
function scheduleChunk(c: AudioContext, buf: AudioBuffer, myEpoch: number): void {
  const arch = activeArchetype();
  const when = Math.max(c.currentTime + 0.02, lastChunkEnd);
  const scheduled = scheduleDspChunk(c, buf, arch, activeParams(), when);
  trackScheduledChunk(scheduled.sources, when, scheduled.duration, myEpoch);
}

function trackScheduledChunk(
  sources: AudioBufferSourceNode[],
  when: number,
  duration: number,
  myEpoch: number,
): void {
  liveSources.push(...sources);
  liveGroups += 1;
  lastChunkEnd = when + duration;
  slowestSource(sources).onended = () => finishScheduledChunk(sources, myEpoch);
}

function slowestSource(sources: AudioBufferSourceNode[]): AudioBufferSourceNode {
  let longest = sources[0]!;
  for (const source of sources) {
    if (source.playbackRate.value < longest.playbackRate.value) longest = source;
  }
  return longest;
}

function finishScheduledChunk(sources: AudioBufferSourceNode[], myEpoch: number): void {
  liveSources = liveSources.filter((source) => !sources.includes(source));
  liveGroups = Math.max(0, liveGroups - 1);
  if (epoch !== myEpoch) return;
  maybeFireTurnDone();
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
  if (!voicePipelineIdle()) return;
  clearManualPlaybackState();
  firePendingTurnDone();
}

function voicePipelineIdle(): boolean {
  return turnEnded && !pumping && sentenceQueue.length === 0 && liveGroups === 0;
}

function clearManualPlaybackState(): void {
  if (onManualState) {
    onManualState(false);
    onManualState = null;
  }
}

function firePendingTurnDone(): void {
  if (turnDonePending) {
    turnDonePending = false;
    streamedTurn = false;
    onTurnAudioDone?.();
  }
}
