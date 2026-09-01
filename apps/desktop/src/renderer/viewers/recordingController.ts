import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SpeakerRegion } from "./Waveform";
import { api } from "../api";
import { noteLiveStt, setMicMuted } from "../workspace/liveRec";
import { prefersReducedMotion } from "../rooms/helpers";
import { Quote, clampVolume, searchTranscript, segmentAt } from "./recReview";
import { LOOK_BACK_CS, TABS, TabId, speakerTone, type RecordingViewProps } from "./RecordingView";
import { Turn, ExportPhrase, keptExportPhrases, directedTurns, cutAt, nextCut, shouldPersistSpeakerName, speakerRenameMessage, exportBody, exportFileName, exportToastText, editedCopyAction, cutSkipDelayMs, segmentsOf, playbackSource } from "./recordingModel";
import { useRecordingBase } from "./recordingControllerBase";

export function useRecordingController(props: RecordingViewProps) {
  const base = useRecordingBase(props);
  const { fileId, mediaToken, pushToast, onStart, meta, setMeta, setPartials, durationCs, setDurationCs, setLiveTranslations, showDeleted, selection, setSelection, setCorrecting, correction, setCorrection, setNoting, noteDraft, setNoteDraft, reading, setReading, correctingRef, setTranslating, setRetrans, setConfirmRetrans, busy, setBusy, exporting, setExporting, activeSeg, setActiveSeg, liveLang, translateTo, micIsMuted, setMicIsMuted, setLiveStt, tab, setTab, playing, setPlaying, setPlaybackError, setPlayCs, volume, rate, setPreflight, query, setQuery, findSeg, setFindSeg, mediaRef, listRef, panelRef, followRef, tabRefs, isLive } = base;
  const segments = segmentsOf(meta);
  const cuts = useMemo(() => meta?.cuts ?? [], [meta]);
  const turns = useMemo<Turn[]>(() => directedTurns(segments, showDeleted), [segments, showDeleted]);
  const speakerRegions = useMemo<SpeakerRegion[]>(
    () =>
      turns.map((t) => {
        const last = t.segs[t.segs.length - 1].seg;
        return {
          start: t.t0 / 100,
          end: Math.max(last.t1 ?? t.t0, t.t0 + 1) / 100,
          speaker: meta?.speakerNames?.[t.speaker] || t.speaker,
          tone: speakerTone(t.speaker),
        };
      }),
    [turns, meta?.speakerNames],
  );
  const found = useMemo(() => searchTranscript(turns, query), [turns, query]);
  const quotes = useMemo<Quote[]>(
    () =>
      turns.flatMap((t) =>
        t.segs.map(({ seg, text }) => ({ t0: seg.t0, t1: Math.max(seg.t1, seg.t0), text })),
      ),
    [turns],
  );
  const src = playbackSource(mediaToken, isLive);
  const [mediaEl, setMediaEl] = useState<HTMLAudioElement | null>(null);
  const rememberMedia = useCallback((el: HTMLAudioElement | null) => {
    mediaRef.current = el;
    if (el) setMediaEl((current) => current ?? el);
  }, []);
  useEffect(() => {
    setPlaybackError("");
    setPlaying(false);
  }, [src]);
  const skipTimerRef = useRef(0);
  function armCutSkip() {
    window.clearTimeout(skipTimerRef.current);
    const el = mediaRef.current;
    if (!el || el.paused || cuts.length === 0) return;
    const cs = el.currentTime * 100;
    const inside = cutAt(cuts, cs);
    if (inside) {
      el.currentTime = inside.t1 / 100 + 0.01; // the seek re-arms us
      return;
    }
    const next = nextCut(cuts, cs);
    if (!next) return;
    const jumpTo = next.t1 / 100 + 0.01;
    const ms = cutSkipDelayMs(next, cs, el.playbackRate);
    skipTimerRef.current = window.setTimeout(
      () => {
        const e = mediaRef.current;
        if (e) e.currentTime = jumpTo;
      },
      Math.max(0, ms),
    );
  }
  useEffect(() => () => window.clearTimeout(skipTimerRef.current), []);
  useEffect(armCutSkip, [cuts]);
  useEffect(() => {
    if (!mediaEl) return;
    mediaEl.volume = volume;
    mediaEl.playbackRate = rate;
  }, [mediaEl, volume, rate]);
  useEffect(() => {
    if (!findSeg || tab !== "transcript") return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(findSeg)}"]`)
      ?.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
  }, [findSeg, tab]);
  useEffect(() => {
    if (!playing || !activeSeg || tab !== "transcript" || !followRef.current) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(activeSeg)}"]`)
      ?.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
  }, [playing, activeSeg, tab]);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const stop = () => {
      followRef.current = false;
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
    };
  }, []);
  function onTime() {
    const el = mediaRef.current;
    if (!el) return;
    const cs = el.currentTime * 100;
    setPlayCs(Math.floor(cs / 100) * 100);
    for (const c of cuts) {
      if (cs >= c.t0 && cs < c.t1) {
        el.currentTime = c.t1 / 100 + 0.01;
        return;
      }
    }
    const current = segmentAt(segments, cs);
    if (current !== activeSeg) setActiveSeg(current);
  }
  function seek(cs: number) {
    const el = mediaRef.current;
    if (!el) return;
    followRef.current = true;
    el.currentTime = cs / 100;
    void el.play().catch(() => {});
  }
  function scrubTo(cs: number) {
    const el = mediaRef.current;
    if (!el) return;
    followRef.current = true;
    el.currentTime = cs / 100;
    setPlayCs(Math.floor(cs / 100) * 100);
    setActiveSeg(segmentAt(segments, cs));
  }
  function showInTranscript(cs: number) {
    followRef.current = false;
    setQuery("");
    setTab("transcript");
    setFindSeg(segmentAt(segments, cs));
  }
  function askVolume(v: number) {
    const el = mediaRef.current;
    if (el) el.volume = clampVolume(v);
  }
  function askRate(r: number) {
    const el = mediaRef.current;
    if (el) el.playbackRate = r;
  }
  function togglePlay() {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      setPlaybackError("");
      void el.play().catch(() => {
        setPlaying(false);
        setPlaybackError("This recording could not be played. Its file is still safe.");
      });
    }
    else el.pause();
  }
  useEffect(() => {
    let raf = 0;
    const onSel = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        captureSelection();
      });
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  function captureSelection() {
    if (correctingRef.current) return;
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
  async function correctSelection() {
    if (!selection || !correction.trim()) return;
    try {
      const updated = await api.recCorrectRange(
        fileId,
        selection.t0,
        selection.t1,
        correction.trim(),
      );
      setMeta(updated);
      setSelection(null);
      setCorrection("");
      setCorrecting(false);
      window.getSelection()?.removeAllRanges();
      pushToast("success", "Transcript corrected — the audio is unchanged.");
    } catch (e) {
      pushToast("error", String(e));
    }
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
  async function markSelection() {
    if (!selection) return;
    try {
      const updated = await api.recHighlightAdd(fileId, selection.t0, selection.t1);
      setMeta((m) => (m ? { ...m, highlights: updated.highlights } : updated));
      setSelection(null);
      pushToast("success", "Marked. It's in Highlights.");
    } catch (e) {
      pushToast("error", String(e));
    }
  }
  async function saveNote() {
    const text = noteDraft.trim();
    if (!text || !selection) return;
    try {
      const updated = await api.recNoteAdd(fileId, selection.t0, "point", text);
      setMeta((m) => (m ? { ...m, notes: updated.notes } : updated));
      setNoting(false);
      setNoteDraft("");
      setSelection(null);
      pushToast("success", "Saved. It's in Notes.");
    } catch (e) {
      pushToast("error", String(e));
    }
  }
  async function markNow() {
    const at = Math.max(0, durationCs);
    try {
      const updated = await api.recHighlightAdd(fileId, Math.max(0, at - LOOK_BACK_CS), at);
      setMeta((m) => (m ? { ...m, highlights: updated.highlights } : updated));
      pushToast("success", "Marked this moment.");
    } catch (e) {
      pushToast("error", String(e));
    }
  }
  async function addChapterHere(title: string) {
    const at = Math.round((mediaRef.current?.currentTime ?? 0) * 100);
    try {
      const updated = await api.recChapterAdd(fileId, at, title);
      setMeta((m) => (m ? { ...m, chapters: updated.chapters } : updated));
      pushToast("success", `Chapter “${title}” added.`);
    } catch (e) {
      pushToast("error", String(e));
    }
  }
  async function deleteItem(kind: "note" | "chapter" | "highlight", itemId: string) {
    try {
      const updated = await api.recItemDelete(fileId, kind, itemId);
      setMeta((m) =>
        m
          ? {
              ...m,
              notes: updated.notes,
              chapters: updated.chapters,
              highlights: updated.highlights,
            }
          : updated,
      );
    } catch (e) {
      pushToast("error", String(e));
    }
  }
  function tabCount(id: TabId): number {
    return {
      transcript: turns.length,
      notes: meta?.notes?.length ?? 0,
      highlights: meta?.highlights?.length ?? 0,
      chapters: meta?.chapters?.length ?? 0,
    }[id];
  }
  async function startReading() {
    if (reading) return;
    setReading(true);
    try {
      await api.recReadStart(fileId);
      pushToast("success", "Reading this recording — the tabs will fill in.");
    } catch (e) {
      setReading(false);
      pushToast("error", String(e));
    }
  }
  function speakerName(label: string): string {
    return meta?.speakerNames?.[label] || label;
  }
  function speakerGuessed(label: string): boolean {
    const name = meta?.speakerNames?.[label];
    return !!name && !!meta?.recognized?.includes(name);
  }
  async function renameSpeaker(label: string, next: string) {
    const name = next.trim();
    const current = speakerName(label);
    const guessed = speakerGuessed(label);
    if (!shouldPersistSpeakerName(name, current, guessed, Boolean(meta?.speakerNames?.[label]))) return;
    try {
      const updated = await api.recSetSpeakerName(fileId, label, name);
      setMeta((m) =>
        m ? { ...m, speakerNames: updated.speakerNames, recognized: updated.recognized } : updated,
      );
      pushToast(
        "success",
        speakerRenameMessage(label, name, current, guessed),
      );
    } catch (e) {
      pushToast("error", String(e));
    }
  }
  async function runTranslate() {
    if (!translateTo.trim() || busy) return;
    setBusy(true);
    setTranslating("starting");
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
  function keptPhrases(shifted = false): ExportPhrase[] {
    return keptExportPhrases(segments, cuts, speakerName, shifted);
  }
  function srtStamp(cs: number): string {
    const ms = Math.max(0, Math.round(cs * 10));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
  }
  async function exportTranscript(kind: "text" | "srt") {
    if (busy) return;
    const phrases = keptPhrases(kind === "srt" && cuts.length > 0);
    if (phrases.length === 0) {
      pushToast("info", "There is nothing transcribed to export yet.");
      return;
    }
    const body = exportBody(kind, phrases, srtStamp);
    const stamp = new Date().toISOString().slice(0, 10);
    setBusy(true);
    try {
      const f = await api.saveGeneratedFile(
        exportFileName(kind, stamp),
        body,
      );
      pushToast(
        "success",
        exportToastText(kind, cuts.length > 0, f.name),
        editedCopyAction(kind, cuts.length > 0, () => void exportClean()),
      );
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }
  async function exportClean() {
    if (busy || exporting) return;
    setBusy(true);
    setExporting(true);
    pushToast("info", "Cutting the audio and saving the edited copy — this can take a while.");
    try {
      const f = await api.recExportClean(fileId);
      pushToast("success", `Saved "${f.name}" with your edits applied to the audio.`);
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setExporting(false);
      setBusy(false);
    }
  }
  function toggleMicMute() {
    const next = !micIsMuted;
    setMicMuted(next);
    setMicIsMuted(next);
  }
  async function toggleLiveStt(on: boolean) {
    setLiveStt(on);
    noteLiveStt(on);
    if (!on) setPartials({});
    try {
      await api.recSetLiveStt(on);
    } catch (e) {
      setLiveStt(!on);
      noteLiveStt(!on);
      pushToast("error", String(e));
    }
  }
  async function runRetranscribe() {
    if (busy) return;
    setConfirmRetrans(false);
    setBusy(true);
    setRetrans({ doneCs: 0, totalCs: Math.max(1, durationCs) });
    try {
      const updated = await api.recRetranscribe(fileId);
      setMeta(updated);
      setDurationCs(updated.durationCs);
      setLiveTranslations({});
      pushToast(
        "success",
        segments.length > 0
          ? "Transcript rebuilt from the audio — the old one is in this file's History."
          : "Transcript written from the audio.",
      );
    } catch (e) {
      pushToast("error", String(e));
    } finally {
      setBusy(false);
      setRetrans(null);
    }
  }
  const appliedLiveLangRef = useRef("");
  async function commitLiveLang() {
    const lang = liveLang.trim();
    if (lang === appliedLiveLangRef.current) return;
    appliedLiveLangRef.current = lang;
    setLiveTranslations({});
    if (isLive) {
      try {
        await api.recSetLiveTranslate(lang || null);
      } catch (e) {
        pushToast("error", String(e));
      }
    }
  }
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const at = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  async function start() {
    setPreflight(false);
    setLiveStt(true);
    setMicIsMuted(false);
    const lang = liveLang.trim();
    appliedLiveLangRef.current = lang;
    await onStart(fileId, {
      systemAudio: base.withSystem,
      liveTranslate: lang || null,
    });
  }

  return { ...base,
    segments,
    cuts,
    turns,
    speakerRegions,
    found,
    quotes,
    src,
    mediaEl,
    setMediaEl,
    rememberMedia,
    skipTimerRef,
    armCutSkip,
    onTime,
    seek,
    scrubTo,
    showInTranscript,
    askVolume,
    askRate,
    togglePlay,
    captureSelection,
    correctSelection,
    deleteSelection,
    markSelection,
    saveNote,
    markNow,
    addChapterHere,
    deleteItem,
    tabCount,
    startReading,
    speakerName,
    speakerGuessed,
    renameSpeaker,
    runTranslate,
    keptPhrases,
    srtStamp,
    exportTranscript,
    exportClean,
    toggleMicMute,
    toggleLiveStt,
    runRetranscribe,
    appliedLiveLangRef,
    commitLiveLang,
    onTabKey,
    start
  };
}

export type RecordingController = ReturnType<typeof useRecordingController>;
