import type WaveSurfer from "wavesurfer.js";

export interface SpeakerRegion {
  start: number;
  end: number;
  speaker: string;
  tone?: string;
}

export interface WaveformProps {
  fileId: string;
  media: HTMLMediaElement | null;
  regions?: SpeakerRegion[];
  hasAudioTrack?: boolean | null;
  height?: number;
  lanes?: boolean;
  mark?: { start: number; end: number } | null;
  marks?: { start: number; end: number }[];
  chapters?: { at: number; title: string }[];
  onSeek?: (seconds: number) => void;
}

export interface SpeakerTone {
  cls: string;
  band: number;
}

export interface SpeakerSpan {
  left: number;
  width: number;
  speaker: string;
}

export interface Ribbon {
  order: string[];
  spans: SpeakerSpan[];
  tone: Map<string, SpeakerTone>;
}

export interface PositionedBand {
  left: number;
  width: number;
}

export interface SavedBand extends PositionedBand {
  key: number;
}

export interface ChapterRule {
  key: number;
  left: number;
  title: string;
}

export interface LoadedWaveform {
  peaks: number[];
  duration: number;
  note: string;
}

export type WaveformLoad =
  | { kind: "failed"; message: string }
  | { kind: "ready"; waveform: LoadedWaveform };

export type HolderRef = { current: HTMLDivElement | null };

export interface DrawWaveformOptions {
  fileId: string;
  media: HTMLMediaElement;
  height: number;
  holderRef: HolderRef;
  alive: () => boolean;
  onSeek: (seconds: number) => void;
  setWaveSurfer: (wave: WaveSurfer) => void;
  setFailed: (value: boolean) => void;
  setStatus: (value: string) => void;
  setDuration: (value: number) => void;
  setNote: (value: string) => void;
}
