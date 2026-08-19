import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import HoverPlugin from "wavesurfer.js/dist/plugins/hover.esm.js";
import { api } from "../api";
import { readSignal, trackNote } from "./waveformSignal";
import "./waveform.css";

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

/** One speaker's turn, in seconds. */
export interface SpeakerRegion {
  start: number;
  end: number;
  speaker: string;
  /**
   * Optional class that sets `--mk` / `--mk-ink` for this voice — any of the
   * `nb-mark-*` / `nb-sem-*` setters from paper.css, or a caller-owned class
   * that sets the same two properties. Supplied by a caller that already knows
   * a speaker's stable identity (the recording viewer keys it off the engine's
   * label, so renaming a voice cannot change its colour); omitted by a caller
   * that only has names, in which case first-heard order decides.
   */
  tone?: string;
}

interface Props {
  /** The room file id — the envelope is computed on-device from its audio. */
  fileId: string;
  /** The media element the waveform drives. Sharing the element (rather than
   * letting wavesurfer create its own) keeps ONE playhead: the native controls,
   * the transcript rows and the waveform can't disagree about the position. */
  media: HTMLMediaElement | null;
  /** Speaker turns, drawn as a ribbon beneath the wave — or, with `lanes`, as
   * one named row per voice. */
  regions?: SpeakerRegion[];
  /** What the container's own track list says (`MediaMeta.hasAudio`). `false`
   * is a FINDING — there is no audio track — and the lane says so immediately
   * instead of spending seconds in `avconvert` only to render its failure in
   * red. Undefined/null means never probed, and changes nothing. */
  hasAudioTrack?: boolean | null;
  /** Drawn height of the wave itself. */
  height?: number;
  /** One labelled row per speaker instead of the single mixed ribbon. */
  lanes?: boolean;
  /** A span the rest of the page has selected (seconds), drawn over the wave so
   * a transcript selection and the audio it refers to are visibly one thing. */
  mark?: { start: number; end: number } | null;
  /** Saved marks (seconds) — the moments worth coming back to, drawn as
   * standing bands so they are findable at a glance on a long recording. */
  marks?: { start: number; end: number }[];
  /** Section starts (seconds), drawn as labelled rules. Gives a two-hour
   * recording a shape you can read without scrubbing it. */
  chapters?: { at: number; title: string }[];
  /** Called when the user clicks or drags on the waveform. */
  onSeek?: (seconds: number) => void;
}

/** The ladder of tick spacings, in seconds. Deliberately a fixed ladder rather
 * than duration/8 rounded: an axis whose gridlines land on 0:37 and 1:14 is a
 * drawing of a number, not a scale you can read a time off. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** The coarsest step that still fits `target` labels across the whole file. */
function tickStep(duration: number, target = 8): number {
  for (const s of TICK_STEPS) if (duration / s <= target) return s;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

interface Tick {
  at: number;
  pct: number;
  major: boolean;
  label: string;
}

/** The pencil ticks under the wave. Pure and index-driven (never `t += step`
 * in a float loop), so a two-hour meeting's last tick lands exactly where the
 * arithmetic says it does. */
function axisTicks(duration: number): Tick[] {
  if (!(duration > 0)) return [];
  const step = tickStep(duration);
  const out: Tick[] = [];
  // Half-steps carry no label: they are there to make the major ticks readable
  // as a scale rather than as a row of marks.
  const half = step / 2;
  for (let i = 0; i * half <= duration; i++) {
    const at = i * half;
    const major = i % 2 === 0;
    const pct = (at / duration) * 100;
    out.push({
      at,
      pct,
      major,
      // A label centred past ~96% would hang off the right edge of the box,
      // and the wave's own end already says where the file stops.
      label: major && pct <= 96 ? fmtStamp(at) : "",
    });
  }
  return out;
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
}: Props) {
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
            lineColor: cssVar("--accent", "#c87b91"),
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

  return (
    // `has-lanes` opens the label gutter (see waveform.css). It is a class
    // rather than a `:has()` selector on purpose: the app ships on whatever
    // WebKit the host Mac has, and this component already carries prefixed
    // fallbacks for the same reason.
    <div className={`waveform${asLanes ? " has-lanes" : ""}`}>
      <div className="waveform-stage">
        <div className="waveform-plot">
          <div ref={holderRef} className="waveform-canvas" style={{ height }} />
          {/* Saved marks sit UNDER the live selection: the selection is what
              you are about to act on, and it must never be hidden by them. */}
          {savedBands.map((b) => (
            <span
              key={`mk-${b.key}`}
              className="waveform-saved-mark"
              aria-hidden="true"
              style={{ left: `${b.left}%`, width: `${b.width}%` }}
            />
          ))}
          {chapterRules.map((c) => (
            <span
              key={`ch-${c.key}`}
              className="waveform-chapter"
              style={{ left: `${c.left}%` }}
              title={c.title}
            >
              <span className="waveform-chapter-label">{c.title}</span>
            </span>
          ))}
          {band && (
            <span
              className="waveform-band nb-sem-pending"
              aria-hidden="true"
              style={{ left: `${band.left}%`, width: `${band.width}%` }}
            />
          )}
        </div>
      </div>

      {/* The pencil scale. Inert decoration over real geometry: every tick is
          positioned as a percentage of the duration wavesurfer drew, so the
          axis and the wave cannot drift apart. */}
      {ticks.length > 0 && (
        <div className="waveform-axis" aria-hidden="true">
          <div className="waveform-axis-track">
            {ticks.map((t) => (
              <span
                key={t.at}
                className={`waveform-tick${t.major ? " is-major" : ""}`}
                style={{ left: `${t.pct}%` }}
              >
                {t.label && <i className="waveform-tick-label">{t.label}</i>}
              </span>
            ))}
          </div>
        </div>
      )}

      {asLanes ? (
        // One row per voice. The name is real text, not a title attribute:
        // this IS the legend, so it has to reach a screen reader.
        <div className="waveform-lanes">
          {ribbon.order.map((sp) => {
            const t = ribbon.tone.get(sp);
            return (
              <div key={sp} className={`waveform-lane ${t?.cls ?? ""}`}>
                {/* dir="auto" because a speaker can be named in any script,
                    and the gutter truncates — a Hebrew name has to ellipse
                    from the correct end. */}
                <span className="waveform-lane-name" dir="auto" title={sp}>
                  {sp}
                </span>
                <span className="waveform-lane-track" aria-hidden="true">
                  {ribbon.spans
                    .filter((s) => s.speaker === sp)
                    .map((s, i) => (
                      <span
                        key={i}
                        className={`waveform-turn${toneBand(t?.band)}`}
                        style={{ left: `${s.left}%`, width: `${s.width}%` }}
                      />
                    ))}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        ribbon.spans.length > 0 && (
          <div className="waveform-ribbon" aria-hidden>
            {ribbon.spans.map((s, i) => {
              const t = ribbon.tone.get(s.speaker);
              return (
                <span
                  key={i}
                  className={`waveform-turn ${t?.cls ?? ""}${toneBand(t?.band)}`}
                  style={{ left: `${s.left}%`, width: `${s.width}%` }}
                  title={s.speaker}
                />
              );
            })}
          </div>
        )
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
      {/* The ribbon's legend. Lanes name themselves, so it would be a second
          copy of the same list there. */}
      {!status && !asLanes && ribbon.order.length > 1 && (
        <ul className="waveform-legend">
          {ribbon.order.map((s) => (
            <li key={s} className={ribbon.tone.get(s)?.cls ?? ""}>
              <span className="waveform-swatch" aria-hidden />
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
