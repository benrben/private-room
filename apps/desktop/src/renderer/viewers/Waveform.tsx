import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import HoverPlugin from "wavesurfer.js/dist/plugins/hover.esm.js";
import { api } from "../api";
import { readSignal, trackNote } from "./waveformSignal";
import { axisTicks, fmtStamp, type Tick } from "./waveformAxis";
import type {
  ChapterRule,
  DrawWaveformOptions,
  HolderRef,
  LoadedWaveform,
  PositionedBand,
  Ribbon,
  SavedBand,
  WaveformLoad,
  WaveformProps,
} from "./waveformTypes";
import "./waveform.css";

export type { SpeakerRegion } from "./waveformTypes";

/** Drawn height, in CSS px, for the compact lane an imported audio/video file
 * gets under its player. Also the container's hard height, so the component can
 * never take more room than it was budgeted. */
export const WAVE_HEIGHT = 52;

/** The recording detail page draws the SAME envelope as the page's primary
 * visual element rather than as a strip above the transcript, so it asks for a
 * taller box. Nothing about the data changes — only how many pixels one
 * amplitude bucket is allowed to occupy. */
export const WAVE_HEIGHT_LARGE = 120;

/** How many speakers a lane view stays readable at. Past this the lanes are
 * thinner than the gaps between them and the single ribbon (plus its named
 * legend) says the same thing in less space. */
const MAX_LANES = 6;

/** How many distinct textures the spans can wear, counting "plain" as one.
 * With four hues that separates 16 voices by colour-and-texture together. */
const TONE_BANDS = 4;

/** The texture class for a voice's palette lap. Band 0 is plain paper. */
function toneBand(band: number | undefined): string {
  return band ? ` is-tex-${Math.min(band, TONE_BANDS - 1)}` : "";
}

/**
 * The identity palette for voices.
 *
 * FOUR marker hues, not five: red is reserved product-wide for recording and
 * urgent states, and "who was talking" is identity, not status — a speaker
 * drawn in red would read as an error on their own sentence.
 *
 * Colour repeats past the fourth voice, which is why it is never the only
 * carrier: every lane is labelled with the speaker's name, the ribbon has its
 * legend, and each time the palette wraps the spans take the next TEXTURE (see
 * `toneBand`), so two speakers sharing a hue are still told apart with colour
 * ignored entirely.
 *
 * Exported because the recording viewer keys the same classes off the machine
 * speaker LABEL, so a voice's chip in the transcript and its lane under the
 * wave are guaranteed to be the same colour.
 */
export const SPEAKER_TONES = [
  "nb-mark-blue",
  "nb-mark-green",
  "nb-mark-yellow",
  "nb-mark-pink",
];

/** Read the host-produced envelope and distinguish an empty track from a
 * valid-but-flat one. Keeping this outside the component makes every response
 * settle into a small, explicit UI result before a DOM node is touched. */
async function loadWaveform(fileId: string): Promise<WaveformLoad> {
  try {
    const data = await api.audioPeaks(fileId);
    const signal = readSignal(data);
    if (signal.state === "empty") return { kind: "failed", message: signal.note };
    return {
      kind: "ready",
      waveform: {
        peaks: data.peaks,
        duration: data.duration,
        note: signal.state === "silent" ? signal.note : "",
      },
    };
  } catch (error) {
    return { kind: "failed", message: String(error) };
  }
}

function reportFailure(
  alive: () => boolean,
  setFailed: (value: boolean) => void,
  setStatus: (value: string) => void,
  message: string,
) {
  if (!alive()) return;
  setFailed(true);
  setStatus(message);
}

function reportReady(
  alive: () => boolean,
  setDuration: (value: number) => void,
  setStatus: (value: string) => void,
  setNote: (value: string) => void,
  waveform: LoadedWaveform,
) {
  if (!alive()) return;
  setDuration(waveform.duration);
  setStatus("");
  setNote(waveform.note);
}

/** Build the view only after an envelope is known to be usable. The host owns
 * decoding; this layer only draws its precomputed result. */
async function drawWaveform(options: DrawWaveformOptions) {
  const result = await loadWaveform(options.fileId);
  if (result.kind === "failed") {
    reportFailure(options.alive, options.setFailed, options.setStatus, result.message);
    return;
  }
  const holder = options.holderRef.current;
  if (!options.alive() || !holder) return;
  holder.replaceChildren();
  const wave = createWaveSurfer(holder, options.media, options.height, result.waveform, options.onSeek, () => {
    reportFailure(options.alive, options.setFailed, options.setStatus, "The waveform could not be drawn.");
  });
  options.setWaveSurfer(wave);
  reportReady(options.alive, options.setDuration, options.setStatus, options.setNote, result.waveform);
}

function createWaveSurfer(
  holder: HTMLDivElement,
  media: HTMLMediaElement,
  height: number,
  waveform: LoadedWaveform,
  onSeek: (seconds: number) => void,
  onError: () => void,
) {
  const wave = WaveSurfer.create({
    container: holder,
    // The wave is meaningful non-text and owes 3:1 (WCAG 1.4.11). --rule
    // is the PENCIL weight (2.55:1 in dark) and was under that floor, so
    // the shape of the audio was the one thing on the page a low-contrast
    // reader could not make out. --rule-strong is the control-edge stroke.
    waveColor: cssVar("--rule-strong", "#787e77"),
    progressColor: cssVar("--accent", "#c87b91"),
    cursorColor: cssVar("--text", "#f0eee5"),
    cursorWidth: 1,
    height,
    // `splitChannels` is left unset (it is a per-channel OPTIONS ARRAY in
    // v7, not a flag). `audio_peaks` decodes to mono, so a meeting recording
    // can never show two stacked source channels here.
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    // The host deliberately leaves near-silent samples below its noise floor;
    // a second normalization here would turn them back into a full waveform.
    normalize: false,
    media,
    peaks: [waveform.peaks],
    duration: waveform.duration,
    plugins: [
      HoverPlugin.create({
        lineColor: cssVar("--accent", "#c87b91"),
        lineWidth: 1,
        labelBackground: cssVar("--panel", "#222"),
        labelColor: cssVar("--text", "#fff"),
        formatTimeCallback: fmtStamp,
      }),
    ],
  });
  wave.on("interaction", () => onSeek(wave.getCurrentTime()));
  wave.on("error", onError);
  return wave;
}

function destroyWaveSurfer(wave: WaveSurfer | null) {
  try {
    wave?.unAll();
    // `destroy()` on a wavesurfer bound to a shared media element must not
    // take the element with it: the transcript and native controls still use it.
    wave?.destroy();
  } catch {
    /* already torn down */
  }
}

function WaveformPlot({
  holderRef,
  height,
  savedBands,
  chapterRules,
  band,
}: {
  holderRef: HolderRef;
  height: number;
  savedBands: SavedBand[];
  chapterRules: ChapterRule[];
  band: PositionedBand | null;
}) {
  return (
    <div className="waveform-stage">
      <div className="waveform-plot">
        <div ref={holderRef} className="waveform-canvas" style={{ height }} />
        {/* Saved marks sit under the live selection: the selection is what
            you are about to act on, and it must never be hidden by them. */}
        {savedBands.map((saved) => (
          <span
            key={`mk-${saved.key}`}
            className="waveform-saved-mark"
            aria-hidden="true"
            style={{ left: `${saved.left}%`, width: `${saved.width}%` }}
          />
        ))}
        {chapterRules.map((chapter) => (
          <span
            key={`ch-${chapter.key}`}
            className="waveform-chapter"
            style={{ left: `${chapter.left}%` }}
            title={chapter.title}
          >
            <span className="waveform-chapter-label">{chapter.title}</span>
          </span>
        ))}
        {band ? (
          <span
            className="waveform-band nb-sem-pending"
            aria-hidden="true"
            style={{ left: `${band.left}%`, width: `${band.width}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

function WaveformAxis({ ticks }: { ticks: Tick[] }) {
  if (ticks.length === 0) return null;
  return (
    <div className="waveform-axis" aria-hidden="true">
      <div className="waveform-axis-track">
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className={`waveform-tick${tick.major ? " is-major" : ""}`}
            style={{ left: `${tick.pct}%` }}
          >
            {tick.label ? <i className="waveform-tick-label">{tick.label}</i> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function SpeakerLanes({ ribbon }: { ribbon: Ribbon }) {
  return (
    <div className="waveform-lanes">
      {ribbon.order.map((speaker) => {
        const tone = ribbon.tone.get(speaker);
        return (
          <div key={speaker} className={`waveform-lane ${tone?.cls ?? ""}`}>
            {/* dir="auto" lets a name in any script truncate from its proper end. */}
            <span className="waveform-lane-name" dir="auto" title={speaker}>
              {speaker}
            </span>
            <span className="waveform-lane-track" aria-hidden="true">
              {ribbon.spans
                .filter((span) => span.speaker === speaker)
                .map((span, index) => (
                  <span
                    key={index}
                    className={`waveform-turn${toneBand(tone?.band)}`}
                    style={{ left: `${span.left}%`, width: `${span.width}%` }}
                  />
                ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SpeakerRibbon({ ribbon }: { ribbon: Ribbon }) {
  if (ribbon.spans.length === 0) return null;
  return (
    <div className="waveform-ribbon" aria-hidden>
      {ribbon.spans.map((span, index) => {
        const tone = ribbon.tone.get(span.speaker);
        return (
          <span
            key={index}
            className={`waveform-turn ${tone?.cls ?? ""}${toneBand(tone?.band)}`}
            style={{ left: `${span.left}%`, width: `${span.width}%` }}
            title={span.speaker}
          />
        );
      })}
    </div>
  );
}

function SpeakerPresentation({ asLanes, ribbon }: { asLanes: boolean; ribbon: Ribbon }) {
  return asLanes ? <SpeakerLanes ribbon={ribbon} /> : <SpeakerRibbon ribbon={ribbon} />;
}

function WaveformMessages({ status, failed, note }: { status: string; failed: boolean; note: string }) {
  if (status) {
    return <div className={`viewer-status${failed ? " waveform-failed" : ""}`} role="status">{status}</div>;
  }
  if (note) return <div className="viewer-status waveform-note" role="status">{note}</div>;
  return null;
}

function WaveformLegend({ status, asLanes, ribbon }: { status: string; asLanes: boolean; ribbon: Ribbon }) {
  if (status || asLanes || ribbon.order.length < 2) return null;
  return (
    <ul className="waveform-legend">
      {ribbon.order.map((speaker) => (
        <li key={speaker} className={ribbon.tone.get(speaker)?.cls ?? ""}>
          <span className="waveform-swatch" aria-hidden />
          {speaker}
        </li>
      ))}
    </ul>
  );
}

/**
 * The recording's waveform, with its speakers drawn under it.
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
 *
 * Everything this component draws ON TOP of the envelope — ticks, lanes, the
 * selection band — is positioned as a percentage of the same duration
 * wavesurfer was handed, so the decoration can never disagree with the data.
 * The amplitudes themselves are drawn exactly as the host computed them.
 */
export default function Waveform({
  fileId,
  media,
  regions,
  hasAudioTrack,
  height = WAVE_HEIGHT,
  lanes = false,
  mark,
  marks,
  chapters,
  onSeek,
}: WaveformProps) {
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

    void drawWaveform({
      fileId,
      media,
      height,
      holderRef,
      alive: () => alive,
      onSeek: (seconds) => onSeekRef.current?.(seconds),
      setWaveSurfer: (wave) => { wsRef.current = wave; },
      setFailed,
      setStatus,
      setDuration,
      setNote,
    });

    return () => {
      alive = false;
      const ws = wsRef.current;
      wsRef.current = null;
      destroyWaveSurfer(ws);
      holder.replaceChildren();
    };
    // `onSeek` is deliberately absent: it is read through a ref, so a caller
    // that passes a fresh closure each render can't tear the waveform down and
    // rebuild it on every keystroke.
  }, [fileId, media, hasAudioTrack, height]);

  /**
   * Repaint the wave when the theme flips.
   *
   * wavesurfer takes its colours as resolved VALUES at create time, not as
   * `var(--accent)` the engine can re-evaluate — so switching to light mode
   * left the one drawing on the page still painted in the dark palette until
   * the file was reopened. The theme is an attribute on <html> (see theme.ts),
   * so one observer is enough; nothing else in this component re-renders.
   */
  useEffect(() => {
    const repaint = () => {
      const ws = wsRef.current;
      if (!ws) return;
      try {
        ws.setOptions({
          waveColor: cssVar("--rule-strong", "#787e77"),
          progressColor: cssVar("--accent", "#c87b91"),
          cursorColor: cssVar("--text", "#f0eee5"),
        });
      } catch {
        /* a wave torn down between the mutation and this call */
      }
    };
    const mo = new MutationObserver(repaint);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => mo.disconnect();
  }, []);

  /** Speaker turns as percentage spans, in first-heard order. */
  const ribbon = useMemo(() => {
    const empty = {
      order: [] as string[],
      spans: [] as { left: number; width: number; speaker: string }[],
      tone: new Map<string, { cls: string; band: number }>(),
    };
    if (!duration || !regions?.length) return empty;
    const order = Array.from(new Set(regions.map((r) => r.speaker)));
    const tone = new Map<string, { cls: string; band: number }>();
    // How many voices already wear each hue. The band has to be counted off
    // the HUE THAT WAS ACTUALLY CHOSEN, not off the voice's position: a caller
    // supplying `tone` (the recording viewer keys it off the machine label)
    // can hand two voices the same class at any two indices — Speaker 1 and
    // Speaker 5 both land on nb-mark-blue — and deriving the band from `i`
    // then gave them the same texture too, so their turns on the shared ribbon
    // were drawn identically. The Nth voice wearing a hue gets band N.
    //
    // A ladder, not a boolean. It used to be `% 2 === 1`, which made speakers
    // 8-11 plain again and therefore identical to speakers 0-3 — in the exact
    // view a nine-speaker meeting gets, since lanes cap at MAX_LANES and fall
    // back to the single ribbon. The diarizer really does produce those (see
    // the AMI testbed).
    const worn = new Map<string, number>();
    order.forEach((sp, i) => {
      const cls =
        regions.find((r) => r.speaker === sp)?.tone
        || SPEAKER_TONES[i % SPEAKER_TONES.length];
      const lap = worn.get(cls) ?? 0;
      worn.set(cls, lap + 1);
      // Texture only appears where a hue has actually had to repeat, so a
      // meeting whose voices all differ is drawn in clean strokes.
      tone.set(sp, { cls, band: Math.min(lap, TONE_BANDS - 1) });
    });
    const spans = regions
      .filter((r) => r.end > r.start)
      .map((r) => ({
        left: Math.max(0, Math.min(100, (r.start / duration) * 100)),
        width: Math.max(0.3, Math.min(100, ((r.end - r.start) / duration) * 100)),
        speaker: r.speaker,
      }));
    return { order, spans, tone };
  }, [regions, duration]);

  const ticks = useMemo(() => (failed ? [] : axisTicks(duration)), [duration, failed]);

  /** The selected span, clamped to the file. Never widened to a minimum: a
   * band drawn wider than the words it stands for would be a small lie about
   * what pressing Delete is going to remove. */
  const band = useMemo(() => {
    if (!mark || !duration || !(mark.end > mark.start)) return null;
    const left = Math.max(0, Math.min(100, (mark.start / duration) * 100));
    const right = Math.max(0, Math.min(100, (mark.end / duration) * 100));
    return { left, width: Math.max(0, right - left) };
  }, [mark, duration]);

  /** Saved marks and section starts, as percentages of the file. Computed the
   * same way as `band`, and clamped the same way: a band wider than the audio
   * it stands for would misrepresent where the moment is. */
  const savedBands = useMemo(() => {
    if (!duration) return [];
    return (marks ?? []).map((m, i) => {
      const left = Math.max(0, Math.min(100, (m.start / duration) * 100));
      const right = Math.max(0, Math.min(100, (m.end / duration) * 100));
      // A point mark still has to be visible, so it gets a hairline rather
      // than a zero-width band nobody can see or click.
      return { key: i, left, width: Math.max(0.4, right - left) };
    });
  }, [marks, duration]);

  const chapterRules = useMemo(() => {
    if (!duration) return [];
    return (chapters ?? [])
      .filter((c) => c.at >= 0 && c.at <= duration)
      .map((c, i) => ({ key: i, left: (c.at / duration) * 100, title: c.title }));
  }, [chapters, duration]);

  const asLanes = lanes && ribbon.order.length > 0 && ribbon.order.length <= MAX_LANES;

  // `has-lanes` opens the label gutter (see waveform.css). It is a class
  // rather than a `:has()` selector because the app ships on host WebKit.
  return (
    <div className={`waveform${asLanes ? " has-lanes" : ""}`}>
      <WaveformPlot
        holderRef={holderRef}
        height={height}
        savedBands={savedBands}
        chapterRules={chapterRules}
        band={band}
      />
      <WaveformAxis ticks={ticks} />
      <SpeakerPresentation asLanes={asLanes} ribbon={ribbon} />
      <WaveformMessages status={status} failed={failed} note={note} />
      <WaveformLegend status={status} asLanes={asLanes} ribbon={ribbon} />
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
