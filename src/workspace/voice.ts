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
 * (turn dead: a later endOfTurn is a no-op, and a late-resolving speak_text
 * can never schedule audio after Stop or lock). */

export type VoiceArchetype = "off" | "demon" | "ghost" | "wraith" | "ancient" | "custom";

/** Which synthesizer voices the room:
 *  - "neural" (default): Edge neural TTS via the sidecar — Andrew
 *    multilingual at +22% rate / -2 Hz pitch, normalized to ~-16 LUFS. A
 *    neural synthetic voice, not a human recording; the sentence text goes
 *    to Microsoft's service (Settings discloses this).
 *  - "device": the original on-device AVSpeech path — nothing leaves the Mac.
 *  Neural failures (offline, sidecar down) fall back to "device" per
 *  sentence, so speech degrades instead of going silent. */
export type VoiceEngine = "neural" | "device";

/** The curated neural-voice roster (Edge TTS short names, all verified
 * against the live catalog). "Multilingual" voices speak dozens of languages
 * — including Hebrew — with one natural timbre; Avri/Hila are Hebrew-native.
 * The sidecar accepts any of these ids in TtsRequest.voice; an empty id
 * means the product default (Andrew). */
export interface NeuralVoice {
  id: string;
  label: string;
  hint: string;
}

export const NEURAL_VOICES: NeuralVoice[] = [
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew", hint: "warm male · multilingual · default" },
  { id: "en-US-BrianMultilingualNeural", label: "Brian", hint: "calm male · multilingual" },
  { id: "en-US-AvaMultilingualNeural", label: "Ava", hint: "bright female · multilingual" },
  { id: "en-US-EmmaMultilingualNeural", label: "Emma", hint: "friendly female · multilingual" },
  { id: "fr-FR-RemyMultilingualNeural", label: "Rémy", hint: "French male · multilingual" },
  { id: "fr-FR-VivienneMultilingualNeural", label: "Vivienne", hint: "French female · multilingual" },
  { id: "de-DE-SeraphinaMultilingualNeural", label: "Seraphina", hint: "German female · multilingual" },
  { id: "he-IL-AvriNeural", label: "Avri", hint: "Hebrew male" },
  { id: "he-IL-HilaNeural", label: "Hila", hint: "Hebrew female" },
];

export interface VoiceParams {
  /** AVSpeech pitchMultiplier, 0.5–2.0. */
  pitch: number;
  /** AVSpeech rate, 0.1–0.7. */
  rate: number;
  /** Convolver wet mix 0–1 (custom archetype also derives IR length from it). */
  reverb: number;
  /** WaveShaper drive 0–1 (k = 8·d; 0 bypasses the shaper). */
  distortion: number;
}

export const ARCHETYPE_DEFAULTS: Record<Exclude<VoiceArchetype, "custom">, VoiceParams> = {
  off: { pitch: 1.0, rate: 0.5, reverb: 0, distortion: 0 },
  demon: { pitch: 0.5, rate: 0.45, reverb: 0.4, distortion: 0.5 },
  ghost: { pitch: 1.15, rate: 0.4, reverb: 0.6, distortion: 0 },
  // Wraith is deliberately its own preset (the user's list names all four):
  // higher/faster-shimmer than ghost, longer tail.
  wraith: { pitch: 1.3, rate: 0.38, reverb: 0.7, distortion: 0 },
  ancient: { pitch: 0.8, rate: 0.42, reverb: 0.3, distortion: 0.19 },
};

/** Synthesis-side volume per archetype (whispery presets speak softer). */
const ARCHETYPE_VOLUME: Record<string, number> = { ghost: 0.85, wraith: 0.8 };

interface VoiceConfig {
  archetype: VoiceArchetype;
  params: VoiceParams;
  voiceId: string | null;
  autoSpeak: boolean;
  engine: VoiceEngine;
  /** Curated neural voice id; null/"" = the product default (Andrew). */
  neuralVoiceId: string | null;
}

// ---- module state ---------------------------------------------------------

let ctx: AudioContext | null = null;
let cfg: VoiceConfig = {
  archetype: "off",
  params: { ...ARCHETYPE_DEFAULTS.off },
  voiceId: null,
  autoSpeak: false,
  engine: "neural",
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

/** Cached procedurally-generated impulse responses, keyed `${secs}:${decay}`.
 * Tied to the AudioContext (buffers belong to it). */
const irCache = new Map<string, AudioBuffer>();

const MIN_CHUNK_CHARS = 60;
const FORCE_FLUSH_CHARS = 300;

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

/** A new ask begins: silence the old answer, invalidate every in-flight
 * continuation, and open a fresh turn. */
export function beginTurn(): void {
  stopAudio();
  epoch += 1;
  turnEpoch = epoch;
  pending = "";
  carry = "";
  sentenceQueue = [];
  deltasFed = false;
  turnEnded = false;
  streamedTurn = true;
  overrides = null;
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
}

/** Feed one ask-delta. No-ops when auto-speak is off or the turn is dead.
 * NOTE (cross-wave): this rides the globally-emitted ask-delta stream; if a
 * future headless/agent path ever emits ask-* events, its fix must suppress
 * them at the source or gate the effects.ts listener — otherwise background
 * runs would speak aloud. */
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
  if (!streamedTurn || turnEpoch !== epoch || turnEnded) return;
  turnEnded = true;
  if (autoSpeakOn()) {
    if (!deltasFed && finalText) pending = finalText;
    extractSentences(true);
  }
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
  turnEnded = false;
  streamedTurn = false;
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
    voiceId?: string | null;
    engine?: VoiceEngine;
    neuralVoiceId?: string | null;
    onState?: (playing: boolean) => void;
  },
): void {
  cancelAll();
  epoch += 1;
  turnEpoch = epoch;
  streamedTurn = false;
  if (
    opts?.archetype !== undefined ||
    opts?.params ||
    opts?.voiceId !== undefined ||
    opts?.engine !== undefined ||
    opts?.neuralVoiceId !== undefined
  ) {
    overrides = {
      archetype: opts?.archetype ?? cfg.archetype,
      params: opts?.params ?? cfg.params,
      voiceId: opts?.voiceId === undefined ? cfg.voiceId : opts.voiceId,
      engine: opts?.engine ?? cfg.engine,
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
  voiceId: string | null;
  engine: VoiceEngine;
  neuralVoiceId: string | null;
} | null = null;

export function setTurnAudioDoneListener(cb: (() => void) | null): void {
  onTurnAudioDone = cb;
}

function activeArchetype(): VoiceArchetype {
  return overrides?.archetype ?? cfg.archetype;
}

function activeParams(): VoiceParams {
  return overrides?.params ?? cfg.params;
}

function activeVoiceId(): string | null {
  return overrides?.voiceId ?? cfg.voiceId;
}

function activeEngine(): VoiceEngine {
  return overrides?.engine ?? cfg.engine;
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

  const re = /[.!?…]+[\s"')\]]*/g;
  let cut = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(work))) {
    const end = m.index + m[0].length;
    // Don't cut decimal points ("3.5b"): a bare "." between digits.
    const before = work[m.index - 1] ?? "";
    const after = work[end] ?? "";
    if (m[0].trimEnd() === "." && /\d/.test(before) && /\d/.test(after)) continue;
    emit(work.slice(cut, end));
    cut = end;
  }
  let rest = work.slice(cut);

  // Force-flush a runaway sentence at ~300 chars, cutting on a comma or space.
  while (rest.length + carry.length > FORCE_FLUSH_CHARS) {
    const window = rest.slice(0, FORCE_FLUSH_CHARS);
    const at = Math.max(window.lastIndexOf(","), window.lastIndexOf(" "));
    if (at <= 0) break;
    emit(rest.slice(0, at + 1));
    rest = rest.slice(at + 1);
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

/** Queue one cut chunk, merging short ones forward until ~60 chars. */
function emit(raw: string): void {
  const s = stripForSpeech(raw);
  if (!s) return;
  carry = carry ? `${carry} ${s}` : s;
  if (carry.length >= MIN_CHUNK_CHARS) flushCarry();
}

function flushCarry(): void {
  if (!carry) return;
  sentenceQueue.push(carry);
  carry = "";
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
      const p = activeParams();
      const volume = ARCHETYPE_VOLUME[activeArchetype()] ?? 1.0;
      let b64: string;
      try {
        if (activeEngine() === "neural") {
          try {
            // Edge neural (+22%, -2 Hz, ~-16 LUFS) via the sidecar, with the
            // room's chosen roster voice (null = Andrew). Volume shaping for
            // whispery archetypes still applies in the DSP graph via
            // `master.gain`, not synthesis-side.
            b64 = await api.speakTextNeural(text, activeNeuralVoiceId());
          } catch {
            // Offline / sidecar down: this sentence falls back to the
            // on-device voice rather than going silent.
            b64 = await api.speakText(text, activeVoiceId(), p.rate, p.pitch, volume);
          }
        } else {
          b64 = await api.speakText(text, activeVoiceId(), p.rate, p.pitch, volume);
        }
      } catch {
        continue; // one failed sentence must not kill the rest
      }
      if (epoch !== myEpoch) return;
      const c = ctx;
      if (!c || c.state !== "running") continue; // no gesture unlock — drop silently
      let buf: AudioBuffer;
      try {
        const bytes = base64ToBytes(b64);
        buf = await c.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      } catch {
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
  if (streamedTurn && turnEpoch === epoch) {
    streamedTurn = false;
    onTurnAudioDone?.();
  }
}
