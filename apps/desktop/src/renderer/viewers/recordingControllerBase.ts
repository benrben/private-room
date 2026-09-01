import { useEffect, useRef, useState } from "react";
import { type UnlistenFn } from "../platform";
import { api, type RecMeta } from "../api";
import { liveSttOn, micMuted } from "../workspace/liveRec";
import { type RecordingViewProps, TabId } from "./RecordingView";
import { sessionForFile, isLiveStatus } from "./recordingModel";

let lastVolume = 1;
let lastRate = 1;

export function useRecordingBase({
  fileId, mediaToken, live, saveProgress, pushToast, onStart, onPause, onResume, onStop,
}: RecordingViewProps) {

  const [meta, setMeta] = useState<RecMeta | null>(null);
  /** The file's own name, exactly as `rec_get` reports it beside the meta.
   * Never drawn — the viewer header already says the name — and read for one
   * decision only: which CONTAINER this file holds, which is what `capturable`
   * below turns into an answer. Null until the first `rec_get` answers, and
   * null for ever if it failed; both mean "not known", never "not a WAV". */
  const [fileName, setFileName] = useState<string | null>(null);
  const [partials, setPartials] = useState<{ mic?: string; sys?: string }>({});
  const [levels, setLevels] = useState<{ mic: number; sys: number }>({ mic: 0, sys: 0 });
  const [durationCs, setDurationCs] = useState(0);
  const [liveTranslations, setLiveTranslations] = useState<Record<string, string>>({});
  const [sysNote, setSysNote] = useState<string | null>(null);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [selection, setSelection] = useState<{ t0: number; t1: number; words: number } | null>(null);
  // The correction box, opened from the selection bar. Held apart from
  // `selection` so opening it cannot be mistaken for having typed anything.
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState("");
  /** The note box on the selection bar. */
  const [noting, setNoting] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  /** A reading pass is in flight for this recording. Set optimistically when
   * the button is pressed and cleared by `rec-read-done`, so the three tabs
   * agree with each other without polling the job list. */
  const [reading, setReading] = useState(false);
  // Read by `captureSelection`, which the `selectionchange` listener holds from
  // the first render — a state read there would be permanently `false`.
  const correctingRef = useRef(false);
  correctingRef.current = correcting;
  /** Whole-file translation. "starting" is the state between the press and the
   * engine's first progress event: how many parts there are is not known yet,
   * and seeding a denominator of 1 put a number nobody had counted on screen. */
  const [translating, setTranslating] = useState<
    { done: number; total: number } | "starting" | null
  >(null);
  const [retrans, setRetrans] = useState<{ doneCs: number; totalCs: number } | null>(null);
  const [confirmRetrans, setConfirmRetrans] = useState(false);
  const [busy, setBusy] = useState(false);
  // "Export edited copy" decodes, splices and re-encodes the whole WAV — minutes
  // on a long meeting. It no longer freezes the room (the work is off the UI
  // thread), but the button simply greyed out and said nothing, which is what
  // "the app has hung" looks like. There is no honest percentage to show —
  // nothing reports one — so the button says what it is doing and no more.
  const [exporting, setExporting] = useState(false);
  const [activeSeg, setActiveSeg] = useState<string | null>(null);
  // Pre-start choices (also editable mid-flight for live translate).
  const [withSystem, setWithSystem] = useState(true);
  const [liveLang, setLiveLang] = useState("");
  const [translateTo, setTranslateTo] = useState("");
  // Session controls whose truth lives OUTSIDE this view (liveRec module
  // state), because the view unmounts while the recording keeps running.
  const [micIsMuted, setMicIsMuted] = useState(micMuted());
  const [liveStt, setLiveStt] = useState(liveSttOn());
  // Which reading tab is showing, and the playback mirror the transport draws
  // from — the <audio> element is the truth, these follow its events.
  const [tab, setTab] = useState<TabId>("transcript");
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [playCs, setPlayCs] = useState(0);
  // Volume and speed used to belong to the native `<audio controls>`. They are
  // mirrors of the element, exactly like `playing`: the control asks the
  // element and the element's own event writes these back, so a slider can
  // never claim a level the audio is not at.
  // The session memory is written through the SAME setters, so it can only ever
  // hold a level the element reported.
  const [volume, setVolumeNow] = useState(lastVolume);
  const [rate, setRateNow] = useState(lastRate);
  const setVolume = (v: number) => {
    lastVolume = v;
    setVolumeNow(v);
  };
  const setRate = (v: number) => {
    lastRate = v;
    setRateNow(v);
  };
  /** The capture choices, while a finished recording is being CONTINUED. Off
   * until the user presses Continue, because until then they are choices about
   * a session that does not exist. */
  const [preflight, setPreflight] = useState(false);
  /** Find a phrase in the transcript. */
  const [query, setQuery] = useState("");
  /** The phrase "Show in transcript" asked for: scrolled to, and marked until
   * the next jump. Held apart from `activeSeg` because it is not the playhead
   * — the whole point of that action is to read a moment without playing it. */
  const [findSeg, setFindSeg] = useState<string | null>(null);

  // The sys-lane failure toast fires once per outage, not on every event.
  const sysToastedRef = useRef(false);

  function handleSystemSource(message: string, status: string) {
    if (status !== "error") {
      setSysNote(null);
      sysToastedRef.current = false;
      return;
    }
    setSysNote(message);
    if (sysToastedRef.current) return;
    sysToastedRef.current = true;
    pushToast("error", message);
  }

  function handleRecSource(p: Parameters<Parameters<typeof api.onRecSource>[0]>[0]) {
    if (p.fileId !== fileId) return;
    if (p.source === "sys") {
      handleSystemSource(p.message, p.status);
      return;
    }
    if (p.source === "mic") setMicNote(p.status === "error" ? p.message : null);
  }
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Does the transcript still belong to the playhead? A wheel or a drag
   * inside the panel means the reader took it over — following them back to
   * the playhead every few seconds would make the page unreadable. Seeking,
   * scrubbing or asking for a phrase hands it back. */
  const followRef = useRef(true);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { status } = sessionForFile(live, fileId);
  const isLive = isLiveStatus(status);
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
          // The other two `recGet` calls below refresh the meta of a file that
          // is already open; only this one can learn its name for the first
          // time, and a rename never changes the bytes `capturable` is about.
          setFileName(r.name);
        }
      })
      .catch((e) => pushToast("error", String(e)));
    // A read may already be under way when this view mounts — the room starts
    // one by itself on Stop and in the background sweep, and the button's
    // optimistic flag only exists in the session that pressed it. Without this
    // the tabs offer "Read this recording" for a read that is already running,
    // and pressing it is refused ("already being read").
    void api
      .listJobs()
      .then((jobs) => {
        if (dead) return;
        const mineNow = jobs.some(
          (j) =>
            j.kind === "rec_read" &&
            (j.status === "queued" || j.status === "running") &&
            (j.plan as { file_id?: string } | null)?.file_id === fileId,
        );
        if (mineNow) setReading(true);
      })
      .catch(() => {});
    // A source may have died BEFORE this view mounted; the engine keeps the
    // latest health durable exactly for this read.
    void api
      .recLiveStatus()
      .then((r) => {
        if (dead || !r || r.fileId !== fileId) return;
        setSysNote(r.sys?.[0] === "error" ? r.sys[1] : null);
        setMicNote(r.mic?.[0] === "error" ? r.mic[1] : null);
      })
      .catch(() => {});
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
      api.onRecSegmentDrop((p) => {
        if (p.fileId !== fileId) return;
        setMeta((m) => (m ? { ...m, segments: m.segments.filter((s) => s.id !== p.id) } : m));
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
                // The overlay travels with the labels: a voice the room
                // recognises mid-meeting gets its name here, and taking only
                // the labels would leave that name off screen until reload.
                speakerNames: p.speakerNames ?? m.speakerNames,
                recognized: p.recognized ?? m.recognized,
              }
            : m,
        );
      }),
      // The room stopped reading — pull the meta so the three tabs fill in
      // without the user clicking anything. This is also how a reading the
      // room started BY ITSELF (on Stop, or the background sweep) reaches a
      // recording that is already open.
      //
      // It fires on EVERY ending now, not only a successful one: a read that
      // failed or was stopped left the three tabs saying "Reading this
      // recording…" and the button disabled until the file was closed and
      // reopened. The REASON is not toasted here — the runner emits the
      // standard terminal `job-progress`, whose failure toast is the one place
      // a stopped background job explains itself, and saying it twice would be
      // worse than saying it once.
      api.onRecReadDone((p) => {
        if (p.fileId !== fileId) return;
        setReading(false);
        void api
          .recGet(fileId)
          .then((f) => setMeta(f.meta))
          .catch(() => {});
      }),
      api.onRecLevel((p) => {
        if (p.fileId !== fileId) return;
        setLevels({ mic: p.mic, sys: p.sys });
        setDurationCs(p.durationCs);
      }),
      api.onRecSource(handleRecSource),
      api.onRecLiveTranslation((p) => {
        if (p.fileId !== fileId) return;
        setLiveTranslations((t) => ({ ...t, [p.segId]: p.text }));
      }),
      api.onRecTranslateProgress((p) => {
        if (p.fileId !== fileId) return;
        setTranslating(p.done >= p.total ? null : { done: p.done, total: p.total });
      }),
      api.onRecRetranscribe((p) => {
        if (p.fileId !== fileId) return;
        setRetrans(p.doneCs >= p.totalCs ? null : { doneCs: p.doneCs, totalCs: p.totalCs });
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

  // A live transcript is a moving target, and a filter over one hides the
  // words arriving. Searching is for reading a recording back, so it stands
  // down while one is being made.
  useEffect(() => {
    if (recordingNow) setQuery("");
  }, [recordingNow]);

  // Pause/stop tears the mic tap down, which resets the mute — re-read the
  // module truth whenever the session status moves.
  useEffect(() => {
    setMicIsMuted(micMuted());
  }, [status]);

  // A dead session's sys-lane error must not greet the next one: the engine
  // emits no rec-source on stop, so the banner/toast guard reset here.
  useEffect(() => {
    if (!isLive) {
      setSysNote(null);
      setMicNote(null);
      sysToastedRef.current = false;
    }
  }, [isLive]);

  // Pause/stop rewrote the file (audio + transcript): reload the saved truth.
  useEffect(() => {
    if (status === "idle" || status === "paused") {
      void api.recGet(fileId).then((r) => setMeta(r.meta)).catch(() => {});
    }
  }, [status, fileId]);
  return {
    fileId,
    mediaToken,
    live,
    saveProgress,
    pushToast,
    onStart,
    onPause,
    onResume,
    onStop,
    meta,
    setMeta,
    fileName,
    setFileName,
    partials,
    setPartials,
    levels,
    setLevels,
    durationCs,
    setDurationCs,
    liveTranslations,
    setLiveTranslations,
    sysNote,
    setSysNote,
    micNote,
    setMicNote,
    showDeleted,
    setShowDeleted,
    selection,
    setSelection,
    correcting,
    setCorrecting,
    correction,
    setCorrection,
    noting,
    setNoting,
    noteDraft,
    setNoteDraft,
    reading,
    setReading,
    correctingRef,
    translating,
    setTranslating,
    retrans,
    setRetrans,
    confirmRetrans,
    setConfirmRetrans,
    busy,
    setBusy,
    exporting,
    setExporting,
    activeSeg,
    setActiveSeg,
    withSystem,
    setWithSystem,
    liveLang,
    setLiveLang,
    translateTo,
    setTranslateTo,
    micIsMuted,
    setMicIsMuted,
    liveStt,
    setLiveStt,
    tab,
    setTab,
    playing,
    setPlaying,
    playbackError,
    setPlaybackError,
    playCs,
    setPlayCs,
    volume,
    setVolumeNow,
    rate,
    setRateNow,
    setVolume,
    setRate,
    preflight,
    setPreflight,
    query,
    setQuery,
    findSeg,
    setFindSeg,
    sysToastedRef,
    handleSystemSource,
    handleRecSource,
    mediaRef,
    listRef,
    listEndRef,
    panelRef,
    followRef,
    tabRefs,
    status,
    isLive,
    recordingNow
  };
}
