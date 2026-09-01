import type { VoiceArchetype, VoiceParams } from "./voiceConfig";

const irCache = new Map<string, AudioBuffer>();

export function clearVoiceDspCache(): void {
  irCache.clear();
}

export function scheduleDspChunk(
  c: AudioContext,
  buf: AudioBuffer,
  arch: VoiceArchetype,
  params: VoiceParams,
  when: number,
): { sources: AudioBufferSourceNode[]; duration: number } {
  const duration = effectiveDuration(arch, buf);
  const until = when + duration + 6;
  const graph = chunkGraph(c, buf);
  const tail = archetypeTail(c, graph, arch, params, when, until);
  tail.connect(graph.master);
  startUnscheduledSources(graph.sources, arch, when);
  return { sources: graph.sources, duration };
}

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

type ChunkGraph = {
  master: GainNode;
  head: GainNode;
  sources: AudioBufferSourceNode[];
  source: (rate: number, gain: number) => AudioBufferSourceNode;
};

function chunkGraph(c: AudioContext, buf: AudioBuffer): ChunkGraph {
  const master = c.createGain();
  master.connect(c.destination);
  const head = c.createGain();
  const sources: AudioBufferSourceNode[] = [];
  const source = (rate: number, gain: number): AudioBufferSourceNode => {
    const node = c.createBufferSource();
    node.buffer = buf;
    node.playbackRate.value = rate;
    const gainNode = c.createGain();
    gainNode.gain.value = gain;
    node.connect(gainNode);
    gainNode.connect(head);
    sources.push(node);
    return node;
  };
  return { master, head, sources, source };
}

function archetypeTail(
  c: AudioContext,
  graph: ChunkGraph,
  arch: VoiceArchetype,
  params: VoiceParams,
  when: number,
  until: number,
): AudioNode {
  switch (arch) {
    case "demon": return demonTail(c, graph, params);
    case "ghost": return ghostTail(c, graph, params, when, until);
    case "wraith": return wraithTail(c, graph, params, when, until);
    case "ancient": return ancientTail(c, graph, params, when);
    default: return cleanTail(c, graph, arch, params);
  }
}

function demonTail(c: AudioContext, graph: ChunkGraph, params: VoiceParams): AudioNode {
  graph.master.gain.value = 0.9;
  graph.source(0.88, 1.0);
  graph.source(0.983, 0.5); // the "legion" double
  const shelf = c.createBiquadFilter();
  shelf.type = "lowshelf";
  shelf.frequency.value = 200;
  shelf.gain.value = 6;
  const filtered = graph.head.connect(shelf);
  return reverbMix(c, shaper(c, filtered, Math.max(4, 8 * params.distortion)), 2.5, 3, params.reverb);
}

function ghostTail(
  c: AudioContext,
  graph: ChunkGraph,
  params: VoiceParams,
  when: number,
  until: number,
): AudioNode {
  graph.master.gain.value = 0.8;
  graph.source(1.0, 1.0);
  const filter = highPass(c, graph.head, 300);
  const doubled = chorus(c, filter, 0.018, 0.3, 0.004, when, until);
  return reverbMix(c, tremolo(c, doubled, 2.2, 0.12, when, until), 4, 2, params.reverb);
}

function wraithTail(
  c: AudioContext,
  graph: ChunkGraph,
  params: VoiceParams,
  when: number,
  until: number,
): AudioNode {
  graph.master.gain.value = 0.8;
  graph.source(1.0, 1.0);
  const filter = highPass(c, graph.head, 500);
  const doubled = chorus(c, filter, 0.014, 0.5, 0.005, when, until);
  return reverbMix(c, tremolo(c, doubled, 4, 0.2, when, until), 6, 2, params.reverb);
}

function ancientTail(
  c: AudioContext,
  graph: ChunkGraph,
  params: VoiceParams,
  when: number,
): AudioNode {
  graph.master.gain.value = 0.9;
  const offsets = [0, 0.02, 0.035];
  const rates = [1.0, 0.94, 1.06];
  const gains = [1, 0.45, 0.35];
  for (let index = 0; index < 3; index += 1) {
    graph.source(rates[index], gains[index]).start(when + offsets[index]);
  }
  return reverbMix(c, shaper(c, graph.head, Math.max(1.5, 8 * params.distortion)), 1.8, 2.5, params.reverb);
}

function cleanTail(
  c: AudioContext,
  graph: ChunkGraph,
  arch: VoiceArchetype,
  params: VoiceParams,
): AudioNode {
  // off (manual play) / custom: clean chain, sliders decide everything.
  graph.master.gain.value = 0.9;
  graph.source(1.0, 1.0);
  if (arch !== "custom") return graph.head;
  const shaped = shaper(c, graph.head, 8 * params.distortion);
  return reverbMix(c, shaped, 1 + 3 * params.reverb, 2, params.reverb);
}

function highPass(c: AudioContext, input: AudioNode, frequency: number): AudioNode {
  const filter = c.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = frequency;
  return input.connect(filter);
}

function startUnscheduledSources(
  sources: AudioBufferSourceNode[],
  arch: VoiceArchetype,
  when: number,
): void {
  if (arch === "ancient") return;
  for (const source of sources) source.start(when);
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
