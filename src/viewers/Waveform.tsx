import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import HoverPlugin from "wavesurfer.js/dist/plugins/hover.esm.js";
import { api } from "../api";
import { readSignal, trackNote } from "./waveformSignal";
import "./waveform.css";

/** Drawn height, in CSS px. Also the container's hard height, so the component
 * can never take more room than it was budgeted. */
const WAVE_HEIGHT = 52;

/** One speaker's turn, in seconds. */
export interface SpeakerRegion {
  start: number;
  end: number;
  speaker: string;
}

interface Props {
  /** The room file id — the envelope is computed on-device from its audio. */
  fileId: string;
  /** The media element the waveform drives. Sharing the element (rather than
   * letting wavesurfer create its own) keeps ONE playhead: the native controls,
   * the transcript rows and the waveform can't disagree about the position. */
  media: HTMLMediaElement | null;
  /** Speaker turns, drawn as a ribbon beneath the wave. */
  regions?: SpeakerRegion[];
  /** What the container's own track list says (`MediaMeta.hasAudio`). `false`
   * is a FINDING — there is no audio track — and the lane says so immediately
   * instead of spending seconds in `avconvert` only to render its failure in
   * red. Undefined/null means never probed, and changes nothing. */
  hasAudioTrack?: boolean | null;
  /** Called when the user clicks or drags on the waveform. */
  onSeek?: (seconds: number) => void;
}

/**
 * Muted speaker colours.
 *
 * FIRST ATTEMPT, and why this is different: the turns were drawn as
 * wavesurfer REGIONS — full-height translucent bands across the wave. At
 * saturated colours over a dark theme that read as neon stripes, and because a
 * region overlay is positioned against wavesurfer's own wrapper it painted
 * across the toolbar and the transcript too. Colour belongs in a thin ribbon
 * of its own, not smeared over everything.
 */
const SPEAKER_COLORS = [
  "#7c6bd6",
  "#3f9e73",
  "#c08a2e",
  "#c25b62",
  "#3f8fa8",
  "#a76aa0",
];

function colorFor(speaker: string, order: string[]): string {
  const i = Math.max(0, order.indexOf(speaker));
  return SPEAKER_COLORS[i % SPEAKER_COLORS.length];
}

/**
 * The recording's waveform, with a speaker ribbon under it.
 *
 * The app has done on-device diarization since v0.14.0 and none of it was
 * visible: the player was a bare `<audio controls>` and the only sign a meeting
 * had four people in it was the names down the transcript. Here the shape of
 * the conversation — who spoke, for how long, where the silences are — is one
 * glance.
 *
 * The envelope comes from the `audio_peaks` command rather than from decoding
 * the file in the webview: wavesurfer's default path would pull a two-hour
 * meeting through the Web Audio API as a gigabyte of Float32.
 */
export default function Waveform({ fileId, media, regions, hasAudioTrack, onSeek }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const [duration, setDuration] = useState(0);
  const [status, setStatus] = useState("Drawing waveform…");
  const [failed, setFailed] = useState(false);
  /** Said UNDER a wave that did draw — a flat lane needs an explanation, and
   * "drawing…" is not one. Separate from `status` so the ribbon and the legend
   * still show for a silent stretch of a diarized meeting. */
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    const holder = holderRef.current;
    if (!holder || !media) return;
    setFailed(false);
    setNote("");
    setStatus("Drawing waveform…");

    // The container already answered this. Decoding a video that has no audio
    // track only reaches `avconvert`'s failure some seconds later, which the
    // lane then has to show in the danger colour — for a file where nothing
    // went wrong.
    const missing = trackNote(hasAudioTrack);
    if (missing) {
      setStatus("");
      setNote(missing);
      return;
    }

    (async () => {
      let peaks: number[];
      let secs: number;
      // "" for a track with signal in it; the silence sentence otherwise.
      let flatNote = "";
      try {
        const data = await api.audioPeaks(fileId);
        const signal = readSignal(data);
        if (signal.state === "empty") {
          if (alive) {
            setFailed(true);
            setStatus(signal.note);
          }
          return;
        }
        peaks = data.peaks;
        secs = data.duration;
        flatNote = signal.state === "silent" ? signal.note : "";
      } catch (e) {
        if (alive) {
          setFailed(true);
          setStatus(String(e));
        }
        return;
      }
      if (!alive || !holderRef.current) return;

      // Belt and braces against a stacked instance. wavesurfer's own
      // `destroy()` can throw when it is bound to a media element it does not
      // own, and a swallowed throw used to leave the previous canvas in place —
      // which is exactly how two waveforms ended up drawn on top of each other.
      holderRef.current.replaceChildren();

      const ws = WaveSurfer.create({
        container: holderRef.current,
        waveColor: cssVar("--border", "#8b8b8b"),
        progressColor: cssVar("--accent", "#8b7cf6"),
        cursorColor: cssVar("--text", "#222"),
        cursorWidth: 1,
        height: WAVE_HEIGHT,
        // `splitChannels` is left unset (it is a per-channel OPTIONS ARRAY in
        // v7, not a flag). One wave is guaranteed instead by the envelope
        // itself: `audio_peaks` decodes to MONO, so there is never a second
        // channel for the renderer to stack underneath the first — which is
        // what a meeting recording (mic on one channel, the Mac's audio on the
        // other) would otherwise draw.
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        // NOT `normalize: true`. wavesurfer's normalize divides the envelope by
        // its own loudest bucket — and `audio_peaks` has ALREADY done exactly
        // that, deliberately EXCEPT below the noise floor, so that dither is
        // never amplified into a fake waveform. Letting the renderer normalize
        // a second time undoes that one exception: a near-silent track (max
        // 0.005) would be scaled by 200 and drawn as a full wave, directly
        // under the label that says it is silent. For a track WITH signal the
        // host's envelope already peaks at exactly 1.0, so this changes
        // nothing about how a normal recording looks.
        normalize: false,
        // Drive the element the rest of the viewer already owns.
        media,
        // Pre-computed envelope: nothing is decoded in the renderer.
        peaks: [peaks],
        duration: secs,
        plugins: [
          HoverPlugin.create({
            lineColor: cssVar("--accent", "#8b7cf6"),
            lineWidth: 1,
            labelBackground: cssVar("--panel", "#222"),
            labelColor: cssVar("--text", "#fff"),
            formatTimeCallback: fmtStamp,
          }),
        ],
      });
      wsRef.current = ws;
      ws.on("interaction", () => onSeekRef.current?.(ws.getCurrentTime()));
      ws.on("error", () => {
        if (alive) {
          setFailed(true);
          setStatus("The waveform could not be drawn.");
        }
      });
      if (alive) {
        setDuration(secs);
        setStatus("");
        setNote(flatNote);
      }
    })();

    return () => {
      alive = false;
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws?.unAll();
        // `destroy()` on a wavesurfer bound to a SHARED media element must not
        // take the element with it — the transcript, the cut-skipping and the
        // native controls all still use it after the waveform goes away.
        ws?.destroy();
      } catch {
        /* already torn down */
      }
      holder.replaceChildren();
    };
    // `onSeek` is deliberately absent: it is read through a ref, so a caller
    // that passes a fresh closure each render can't tear the waveform down and
    // rebuild it on every keystroke.
  }, [fileId, media, hasAudioTrack]);

  /** Speaker turns as percentage spans, in first-heard order. */
  const ribbon = useMemo(() => {
    if (!duration || !regions?.length) return { order: [] as string[], spans: [] };
    const order = Array.from(new Set(regions.map((r) => r.speaker)));
    const spans = regions
      .filter((r) => r.end > r.start)
      .map((r) => ({
        left: Math.max(0, Math.min(100, (r.start / duration) * 100)),
        width: Math.max(0.3, Math.min(100, ((r.end - r.start) / duration) * 100)),
        speaker: r.speaker,
        color: colorFor(r.speaker, order),
      }));
    return { order, spans };
  }, [regions, duration]);

  return (
    <div className="waveform">
      <div ref={holderRef} className="waveform-canvas" style={{ height: WAVE_HEIGHT }} />
      {ribbon.spans.length > 0 && (
        <div className="waveform-ribbon" aria-hidden>
          {ribbon.spans.map((s, i) => (
            <span
              key={i}
              className="waveform-turn"
              style={{ left: `${s.left}%`, width: `${s.width}%`, background: s.color }}
              title={s.speaker}
            />
          ))}
        </div>
      )}
      {status && (
        <div className={`viewer-status${failed ? " waveform-failed" : ""}`} role="status">
          {status}
        </div>
      )}
      {!status && note && (
        <div className="viewer-status waveform-note" role="status">
          {note}
        </div>
      )}
      {!status && ribbon.order.length > 1 && (
        <ul className="waveform-legend">
          {ribbon.order.map((s) => (
            <li key={s}>
              <span
                className="waveform-swatch"
                style={{ background: colorFor(s, ribbon.order) }}
                aria-hidden
              />
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Read a CSS custom property off the document, with a fallback for the case
 * where the stylesheet hasn't applied yet. */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function fmtStamp(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
