import { useEffect, useMemo, useRef, useState } from "react";
import { api, RecMeta } from "../api";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * ADD-27: the Recording file — record live (mic + the Mac's own audio, so a
 * Google Meet/Zoom/Teams call is heard), watch the transcript appear WHILE
 * people speak, with speakers told apart; then edit the recording by editing
 * its text (select words → delete: playback skips them, "Export edited copy"
 * cuts the audio for real) and translate the whole thing into any language.
 * All transcription and translation happen on this Mac.
 *
 * The capture session itself lives in the backend + a workspace-level mic
 * tap, NOT here — this view attaches to it, so navigating away never stops
 * a recording.
 */

export interface RecordingLiveState {
  fileId: string;
  status: string;
}

export interface RecordingViewProps {
  fileId: string;
  mediaToken: string | null;
  /** The workspace-wide live session (null when nothing is recording). */
  live: RecordingLiveState | null;
  pushToast: (
    kind: "info" | "success" | "error",
    text: string,
    action?: { label: string; run: () => void },
  ) => void;
  onStart: (
    fileId: string,
    opts: { systemAudio: boolean; liveTranslate: string | null },
  ) => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onStop: () => Promise<void>;
}

const LANGS = [
  "English", "עברית (Hebrew)", "Español (Spanish)", "Français (French)",
  "Deutsch (German)", "العربية (Arabic)", "Русский (Russian)", "中文 (Chinese)",
  "日本語 (Japanese)", "Português (Portuguese)", "Italiano (Italian)", "हिन्दी (Hindi)",
  "Українська (Ukrainian)", "Nederlands (Dutch)", "Polski (Polish)", "Türkçe (Turkish)",
];

/** Stable chip color per speaker: "You" gets the accent, meeting voices walk
 * a small hue palette by their number. */
function speakerHue(speaker: string): number | null {
  if (speaker === "You") return null;
  const n = parseInt(speaker.replace(/\D/g, ""), 10) || 1;
  return [155, 25, 265, 330, 95, 200][(n - 1) % 6];
}

function fmt(cs: number): string {
  const s = Math.max(0, Math.floor(cs / 100));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export default function RecordingView({
  fileId,
  mediaToken,
  live,
  pushToast,
  onStart,
  onPause,
  onResume,
  onStop,
}: RecordingViewProps) {
  const [meta, setMeta] = useState<RecMeta | null>(null);
  const [partials, setPartials] = useState<{ mic?: string; sys?: string }>({});
  const [levels, setLevels] = useState<{ mic: number; sys: number }>({ mic: 0, sys: 0 });
  const [durationCs, setDurationCs] = useState(0);
  const [liveTranslations, setLiveTranslations] = useState<Record<string, string>>({});
  const [sysNote, setSysNote] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [selection, setSelection] = useState<{ t0: number; t1: number; words: number } | null>(null);
  const [translating, setTranslating] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeSeg, setActiveSeg] = useState<string | null>(null);
  // Pre-start choices (also editable mid-flight for live translate).
  const [withSystem, setWithSystem] = useState(true);
  const [liveLang, setLiveLang] = useState("");
  const [translateTo, setTranslateTo] = useState("");

  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const mine = live?.fileId === fileId ? live : null;
  const status = mine?.status ?? "idle";
  const isLive = status === "recording" || status === "paused" || status === "saving";
  const recordingNow = status === "recording";

  // ---- load + subscribe -------------------------------------------------
  useEffect(() => {
    let dead = false;
    void api
      .recGet(fileId)
      .then((r) => {
        if (!dead) {
          setMeta(r.meta);
          setDurationCs(r.meta.durationCs);
        }
      })
      .catch((e) => pushToast("error", String(e)));
    const subs: Promise<UnlistenFn>[] = [
      api.onRecSegment((p) => {
        if (p.fileId !== fileId) return;
        setMeta((m) => {
          if (!m) return m;
          const segments = [...m.segments];
          let at = segments.length;
          while (at > 0 && segments[at - 1].t0 > p.segment.t0) at--;
          segments.splice(at, 0, p.segment);
          return { ...m, segments };
        });
        setPartials((prev) => ({ ...prev, [p.segment.source]: undefined }));
      }),
      api.onRecPartial((p) => {
        if (p.fileId !== fileId) return;
        setPartials((prev) => ({ ...prev, [p.source]: p.text || undefined }));
      }),
      // Speakers sort themselves out as the meeting goes on: the engine
      // re-clusters every few phrases and corrects the labels on screen.
      api.onRecRelabel((p) => {
        if (p.fileId !== fileId) return;
        const by = new Map(p.labels.map((l) => [l.id, l.speaker]));
        setMeta((m) =>
          m
            ? {
                ...m,
                segments: m.segments.map((s) =>
                  by.get(s.id) && by.get(s.id) !== s.speaker
                    ? { ...s, speaker: by.get(s.id)! }
                    : s,
                ),
              }
            : m,
        );
      }),
      api.onRecLevel((p) => {
        if (p.fileId !== fileId) return;
        setLevels({ mic: p.mic, sys: p.sys });
        setDurationCs(p.durationCs);
      }),
      api.onRecSource((p) => {
        if (p.fileId !== fileId || p.source !== "sys") return;
        setSysNote(p.status === "error" ? p.message : null);
        if (p.status === "error") pushToast("error", p.message);
      }),
      api.onRecLiveTranslation((p) => {
        if (p.fileId !== fileId) return;
        setLiveTranslations((t) => ({ ...t, [p.segId]: p.text }));
      }),
      api.onRecTranslateProgress((p) => {
        if (p.fileId !== fileId) return;
        setTranslating(p.done >= p.total ? null : { done: p.done, total: p.total });
      }),
    ];
    return () => {
      dead = true;
      subs.forEach((s) => void s.then((un) => un()));
    };
  }, [fileId, pushToast]);

  // Live view follows the newest words.
  useEffect(() => {
    if (recordingNow) listEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [meta?.segments.length, partials.mic, partials.sys, recordingNow]);

  // No "still speaking…" line survives a pause/stop.
  useEffect(() => {
    if (!recordingNow) setPartials({});
  }, [recordingNow]);

  // Pause/stop rewrote the file (audio + transcript): reload the saved truth.
  useEffect(() => {
    if (status === "idle" || status === "paused") {
      void api.recGet(fileId).then((r) => setMeta(r.meta)).catch(() => {});
    }
  }, [status, fileId]);

  const segments = meta?.segments ?? [];
  const cuts = useMemo(() => meta?.cuts ?? [], [meta]);

  // ---- playback (skips deleted spans) ------------------------------------
  const src = mediaToken && !isLive ? `roommedia://localhost/${mediaToken}` : null;

  function onTime() {
    const el = mediaRef.current;
    if (!el) return;
    const cs = el.currentTime * 100;
    for (const c of cuts) {
      if (cs >= c.t0 && cs < c.t1) {
        el.currentTime = c.t1 / 100 + 0.01;
        return;
      }
    }
    let current: string | null = null;
    for (const seg of segments) {
      if (seg.t0 <= cs) current = seg.id;
      else break;
    }
    if (current !== activeSeg) setActiveSeg(current);
  }

  function seek(cs: number) {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = cs / 100;
    void el.play().catch(() => {});
  }

  // ---- transcript selection → delete -------------------------------------
  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !listRef.current) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    let t0 = Infinity;
    let t1 = -Infinity;
    let words = 0;
    listRef.current.querySelectorAll<HTMLElement>("[data-t0]").forEach((sp) => {
      if (range.intersectsNode(sp)) {
        t0 = Math.min(t0, Number(sp.dataset.t0));
        t1 = Math.max(t1, Number(sp.dataset.t1));
        words++;
      }
    });
    setSelection(words > 0 ? { t0, t1, words } : null);
  }

  async function deleteSelection() {
    if (!selection) return;
    try {
      const updated = await api.recDeleteRange(fileId, selection.t0, selection.t1);
      setMeta(updated);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      pushToast(
        "success",
        `Removed ${selection.words} word${selection.words > 1 ? "s" : ""} — playback now skips it. "Export edited copy" makes it permanent.`,
      );
    } catch (e) {
      pushToast("error", String(e));
    }
  }

  // ---- toolbar actions ----------------------------------------------------
  async function runTranslate() {
    if (!translateTo.trim() || busy) return;
    setBusy(true);
    setTranslating({ done: 0, total: 1 });
    try {
      const f = await api.recTranslate(fileId, translateTo.trim());
      pushToast("success", `Translated into ${translateTo.trim()} — saved "${f.name}".`);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusy(false);
      setTranslating(null);
    }
  }

  async function exportClean() {
    if (busy) return;
    setBusy(true);
    try {
      const f = await api.recExportClean(fileId);
      pushToast("success", `Saved "${f.name}" with your edits applied to the audio.`);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLiveLang(lang: string) {
    setLiveLang(lang);
    setLiveTranslations({});
    if (isLive) {
      try {
        await api.recSetLiveTranslate(lang || null);
      } catch (e) {
        pushToast("error", String(e));
      }
    }
  }

  // ---- render -------------------------------------------------------------
  const canEdit = !isLive || status === "paused";
  const hasWords = segments.some((s) => s.words.length > 0);

  return (
    <div className="rec-view">
      {/* header: controls + meters */}
      <div className="rec-head">
        {status === "idle" && (
          <>
            <button className="primary rec-btn" onClick={() => void start()}>
              <span className="rec-dot" /> {segments.length ? "Continue recording" : "Start recording"}
            </button>
            <label className="rec-opt" title="Hear whatever the Mac plays — Google Meet, Zoom, Teams, Slack calls, videos">
              <input
                type="checkbox"
                checked={withSystem}
                onChange={(e) => setWithSystem(e.target.checked)}
              />
              Include the Mac’s audio (meetings)
            </label>
            <span
              className="rec-opt"
              title="Voices are told apart as people talk, and the labels correct themselves as the meeting goes on — nothing to set up"
            >
              Speakers detected automatically
            </span>
          </>
        )}
        {status === "recording" && (
          <>
            <button className="subtle rec-btn" onClick={() => void onPause()}>⏸ Pause</button>
            <button className="primary rec-btn" onClick={() => void onStop()}>■ Stop &amp; save</button>
            <span className="rec-live-chip">
              <span className="rec-dot pulsing" /> REC {fmt(durationCs)}
            </span>
            <span className="rec-meters" title="Microphone / Mac audio levels">
              <span className="rec-meter">
                <i>Mic</i>
                <b style={{ width: `${Math.min(100, levels.mic * 400)}%` }} />
              </span>
              <span className="rec-meter">
                <i>Mac</i>
                <b style={{ width: `${Math.min(100, levels.sys * 400)}%` }} />
              </span>
            </span>
          </>
        )}
        {status === "paused" && (
          <>
            <button className="primary rec-btn" onClick={() => void onResume()}>● Resume</button>
            <button className="subtle rec-btn" onClick={() => void onStop()}>■ Stop &amp; save</button>
            <span className="rec-live-chip paused">Paused at {fmt(durationCs)}</span>
          </>
        )}
        {status === "saving" && <span className="rec-live-chip">Finishing the last words…</span>}

        <span className="rec-head-right">
          <label className="rec-opt" title="Translate each phrase as it lands (on this Mac)">
            Live translate
            <select value={liveLang} onChange={(e) => void toggleLiveLang(e.target.value)}>
              <option value="">off</option>
              {LANGS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
        </span>
      </div>

      {sysNote && <div className="rec-note">{sysNote}</div>}

      {/* player (idle/paused, once there is audio) */}
      {src && durationCs > 0 && (
        <audio
          ref={(el) => {
            mediaRef.current = el;
          }}
          className="rec-player"
          src={src}
          controls
          onTimeUpdate={onTime}
        />
      )}

      {/* transcript */}
      <div className="rec-transcript" ref={listRef} onMouseUp={captureSelection}>
        {segments.length === 0 && !partials.mic && !partials.sys && (
          <div className="empty-hint rec-empty">
            {status === "idle" ? (
              <>
                <p><strong>This file records and understands speech — live.</strong></p>
                <p>
                  Press <em>Start recording</em>: your words (and, if you leave the checkbox on,
                  whatever the Mac plays — a Google Meet, Zoom, Teams or Slack call) appear here
                  as text while people are still speaking, with speakers told apart.
                </p>
                <p>
                  Afterwards, edit the audio by editing the text (select words → delete), run any
                  AI action on it, or translate the whole thing — everything stays on this Mac.
                </p>
              </>
            ) : (
              <p>Listening… speak, or bring the meeting on.</p>
            )}
          </div>
        )}
        {segments.map((seg) => {
          const visible = seg.words.length
            ? seg.words.filter((w) => showDeleted || !w.del)
            : null;
          if (visible && visible.length === 0 && !seg.text) return null;
          const hue = speakerHue(seg.speaker);
          const translation = liveTranslations[seg.id];
          return (
            <div key={seg.id} className={`rec-row ${activeSeg === seg.id ? "active" : ""}`}>
              <button
                className="rec-stamp"
                title="Jump to this moment"
                onClick={() => seek(seg.t0)}
              >
                {fmt(seg.t0)}
              </button>
              <span
                className="rec-speaker"
                style={hue == null ? undefined : { background: `hsl(${hue} 60% 45% / .18)`, color: `hsl(${hue} 70% 35%)` }}
              >
                {seg.speaker}
              </span>
              <span className="rec-words" dir="auto">
                {visible
                  ? visible.map((w, i) => (
                      <span
                        key={i}
                        data-t0={w.t0}
                        data-t1={w.t1}
                        className={w.del ? "rec-word deleted" : "rec-word"}
                      >
                        {w.w}{" "}
                      </span>
                    ))
                  : seg.text}
                {translation && <span className="rec-translation" dir="auto">{translation}</span>}
              </span>
            </div>
          );
        })}
        {(["mic", "sys"] as const).map((sourceKey) =>
          partials[sourceKey] ? (
            <div key={sourceKey} className="rec-row ghost">
              <span className="rec-stamp">…</span>
              <span className="rec-speaker">{sourceKey === "mic" ? "You" : "Meeting"}</span>
              <span className="rec-words" dir="auto">{partials[sourceKey]}</span>
            </div>
          ) : null,
        )}
        <div ref={listEndRef} />
      </div>

      {/* selection action bar */}
      {selection && canEdit && (
        <div className="rec-selectbar">
          <span>
            {selection.words} word{selection.words > 1 ? "s" : ""} · {fmt(selection.t0)}–{fmt(selection.t1)}
          </span>
          <button className="danger" onClick={() => void deleteSelection()}>
            Delete from recording
          </button>
          <button className="subtle" onClick={() => setSelection(null)}>Keep</button>
        </div>
      )}

      {/* footer toolbar */}
      {segments.length > 0 && (
        <div className="rec-tools">
          <span className="rec-tool">
            <input
              list="rec-langs"
              placeholder="Translate into…"
              value={translateTo}
              disabled={busy}
              onChange={(e) => setTranslateTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runTranslate();
              }}
            />
            <datalist id="rec-langs">
              {LANGS.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            <button className="subtle" disabled={busy || !translateTo.trim()} onClick={() => void runTranslate()}>
              {translating ? `Translating ${translating.done}/${translating.total}…` : "Translate"}
            </button>
          </span>
          {hasWords && (
            <>
              <button
                className="subtle"
                disabled={busy || (!cuts.length && !segments.some((s) => s.words.some((w) => w.del)))}
                title="Save a copy with the deleted words really cut out of the audio"
                onClick={() => void exportClean()}
              >
                Export edited copy
              </button>
              <label className="rec-opt">
                <input
                  type="checkbox"
                  checked={showDeleted}
                  onChange={(e) => setShowDeleted(e.target.checked)}
                />
                Show deleted
              </label>
            </>
          )}
          {!isLive && (
            <span className="rec-hint-inline">
              Select words in the transcript to delete them from the recording.
            </span>
          )}
        </div>
      )}
    </div>
  );

  async function start() {
    await onStart(fileId, { systemAudio: withSystem, liveTranslate: liveLang || null });
  }
}
