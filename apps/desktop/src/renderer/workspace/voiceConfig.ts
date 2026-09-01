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

export interface VoiceConfig {
  archetype: VoiceArchetype;
  params: VoiceParams;
  autoSpeak: boolean;
  /** Curated neural voice id; null/"" = the product default (Andrew). */
  neuralVoiceId: string | null;
}
