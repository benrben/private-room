import { useEffect, useRef, useState } from "react";
import { api, NeuralVoiceInfo, Podcast, PodcastHost } from "../api";
import { PlayIcon, StopIcon, MicIcon, CircleCheckIcon } from "../icons";
import {
  castNeedsVoices,
  groupVoices,
  languageLabel,
  loadVoiceCatalog,
  optionLabel,
  suggestDistinctVoices,
  voiceName,
} from "../settings/voiceCatalog";
import { base64ToBytes } from "../viewers/util";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** Cast the hosts of a podcast script and record it as audio.
 *
 * Opens beside a generated podcast script. Everything here is about ONE
 * question — what should this sound like — so the panel is the cast list, a
 * voice per host, and one button that records.
 *
 * TWO THINGS IT STATES BEFORE THE BUTTON, deliberately and in that order:
 *
 *   1. Recording sends every line to a cloud voice service. The user is about
 *      to hand a script written FROM their own documents to Microsoft, and a
 *      panel that mentioned that afterwards would be telling them too late.
 *   2. With the privacy door on, names are SPOKEN as their placeholders. This
 *      is the trap worth the most words: the door silently substitutes, the
 *      audio sounds finished, and ten minutes of "Person A said" is discovered
 *      on playback. Saying it up front is the difference between a setting and
 *      a surprise.
 */
export default function PodcastPanel({
  fileId,
  s,
  a,
}: {
  fileId: string;
  s: WSState;
  a: WSActions;
}) {
  const [script, setScript] = useState<Podcast | null>(null);
  const [loading, setLoading] = useState(true);
  const [voices, setVoices] = useState<NeuralVoiceInfo[]>([]);
  const [voicesError, setVoicesError] = useState(false);
  const [cast, setCast] = useState<PodcastHost[]>([]);
  const [autoCastDone, setAutoCastDone] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // The script and the catalog are independent: a room that is offline still
  // shows the cast and the lines, just without a list of voices to change them
  // to. Failing the whole panel on a catalog fetch would hide the script too.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const p = await api.getPodcast(fileId);
        if (!alive) return;
        setScript(p);
        setCast(p?.cast ?? []);
      } catch {
        if (alive) setScript(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    // The SHARED catalog promise, not a fetch of our own: this panel mounts and
    // unmounts as the Studio tab swaps, and a per-mount fetch was being
    // cancelled before it landed — leaving the picker empty and "Suggest
    // voices" disabled in a room whose internet was on. A failure is now
    // SHOWN; swallowing it is what made this look like a dead button.
    setVoicesError(false);
    setAutoCastDone(false);
    void loadVoiceCatalog()
      .then((v) => alive && setVoices(v))
      .catch(() => alive && setVoicesError(true));
    return () => {
      alive = false;
      stopPreview();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // A cast seeded without a catalog has every host on "" — the product default
  // — so a two-host script comes out in ONE voice. As soon as real voices are
  // known, fill in distinct ones and leave it UNSAVED: the user confirms it
  // with Save, rather than discovering the collision on playback. Runs once per
  // script (`autoCast`), so it never fights a deliberate choice to reuse a
  // voice — that choice is saved, and a saved cast is never touched again.
  useEffect(() => {
    if (autoCastDone || !voices.length || cast.length < 2) return;
    if (!castNeedsVoices(cast)) return;
    setAutoCastDone(true);
    const ids = suggestDistinctVoices(voices, cast.length, cast[0]?.voice || undefined);
    setCast((cur) => cur.map((h, i) => ({ ...h, voice: ids[i] || h.voice })));
    setSaved(false);
  }, [voices, cast, autoCastDone]);

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewing(null);
  }

  function editHost(i: number, patch: Partial<PodcastHost>) {
    setCast((cur) => cur.map((h, n) => (n === i ? { ...h, ...patch } : h)));
    setSaved(false);
  }

  async function saveCast() {
    try {
      const next = await api.setPodcastCast(fileId, cast);
      setScript(next);
      setCast(next.cast);
      setSaved(true);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Speak one of this host's ACTUAL lines, not a generic sample. Hearing the
   * words the episode will contain is what tells you whether the voice suits
   * the script; "The quick brown fox" tells you nothing about either. */
  async function preview(host: PodcastHost) {
    if (previewing === host.name) {
      stopPreview();
      return;
    }
    stopPreview();
    const line =
      script?.turns.find(
        (t) => t.speaker.toLowerCase() === host.name.trim().toLowerCase(),
      )?.line ?? `Hello, I'm ${host.name}.`;
    setPreviewing(host.name);
    try {
      const b64 = await api.previewPodcastVoice(
        line.slice(0, 300),
        host.voice,
        host.rate,
        host.pitch,
      );
      const blob = new Blob([base64ToBytes(b64)], { type: "audio/wav" });
      const el = new Audio(URL.createObjectURL(blob));
      audioRef.current = el;
      el.onended = () => setPreviewing(null);
      await el.play();
    } catch (e) {
      setPreviewing(null);
      // A failed preview must not look like a voice that sounds like nothing.
      s.pushToast("error", `Could not play that voice: ${String(e)}`);
    }
  }

  async function record() {
    try {
      await api.startPodcastAudioJob(fileId);
      await a.refreshJobs();
      s.pushToast(
        "info",
        "Recording in the background — the episode opens itself when it's ready.",
      );
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  function autoCast() {
    const ids = suggestDistinctVoices(voices, cast.length);
    setCast((cur) => cur.map((h, i) => ({ ...h, voice: ids[i] ?? h.voice })));
    setSaved(false);
  }

  if (loading) return <div className="pod-panel">Loading the script…</div>;

  // A podcast PAGE with no row: generated before scripts were stored as data.
  // Say exactly that, and say the way forward, rather than showing a Record
  // button that would fail on a script with no readable turns.
  if (!script) {
    return (
      <div className="pod-panel">
        <p className="settings-hint">
          This page has no script attached, so it can't be cast or recorded.
          Podcast scripts made before voices existed are pages only — generate
          the podcast again from the Studio shelf and the new one will have
          voices.
        </p>
      </div>
    );
  }

  const { multilingual, byLanguage } = groupVoices(voices);
  const recorded = script.audioFileId;
  const dirty = JSON.stringify(cast) !== JSON.stringify(script.cast);

  return (
    <div className="pod-panel">
      <div className="pod-head">
        <h3>{script.title}</h3>
        <span className="settings-hint">
          {script.turns.length} turns · {cast.length} host
          {cast.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* The data boundary, first and unfoldable — same doctrine as Settings →
          Spoken voice, which states it before the picker rather than under a
          disclosure. */}
      <div className="voice-boundary set-note set-note--flag set-note--lead nb-sem-urgent">
        <span className="nb-tape set-note-tag">Recording uses a cloud voice</span>{" "}
        — every line of this script is sent to Microsoft's Edge TTS service to
        be spoken. Nothing else goes with it, and nothing is sent until you
        press Record.
      </div>

      {/* THE TRAP, named before the button and not after it. */}
      {s.privacyOn && (
        <p className="set-note set-note--flag nb-sem-pending" role="note">
          This room's privacy door is on, so names in the script are replaced
          before they are spoken — the recording will say “Person A” where the
          script says a real name. Turn the door off in Settings → Cloud
          privacy first if you want the real names read aloud.
        </p>
      )}
      {!s.webOn && (
        <p className="set-note set-note--flag nb-sem-urgent" role="alert">
          This room is offline, so it can't be recorded — speaking sends each
          line to an online voice service. Turn on Settings → Online features
          to record. You can still cast the hosts now.
        </p>
      )}

      <div className="pod-cast">
        {cast.map((host, i) => (
          <div className="pod-host" key={i}>
            <div className="pod-host-row">
              <input
                className="pod-host-name"
                value={host.name}
                dir="auto"
                aria-label={`Host ${i + 1} name`}
                onChange={(e) => editHost(i, { name: e.target.value })}
              />
              <button
                className="chip-btn"
                title={`Hear ${host.name || "this host"} read one of their lines`}
                aria-label={`Preview ${host.name}`}
                onClick={() => void preview(host)}
              >
                {previewing === host.name ? (
                  <StopIcon size={12} />
                ) : (
                  <PlayIcon size={12} />
                )}
              </button>
            </div>
            <select
              className="chat-select"
              aria-label={`Voice for ${host.name}`}
              value={host.voice}
              onChange={(e) => editHost(i, { voice: e.target.value })}
            >
              <option value="">Default — Andrew · multilingual</option>
              {/* A saved voice the catalog no longer lists still needs an
                  option, or the select silently jumps to Default and the user
                  saves a change they never made. */}
              {host.voice && !voices.some((v) => v.id === host.voice) && (
                <option value={host.voice}>
                  {voiceName(host.voice)} — saved voice
                </option>
              )}
              {multilingual.length > 0 && (
                <optgroup label="Multilingual — reads any language">
                  {multilingual.map((v) => (
                    <option key={v.id} value={v.id}>
                      {optionLabel(v)} · {languageLabel(v.locale)}
                    </option>
                  ))}
                </optgroup>
              )}
              {byLanguage.map(([lang, group]) => (
                <optgroup key={lang} label={lang}>
                  {group.map((v) => (
                    <option key={v.id} value={v.id}>
                      {optionLabel(v)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="pod-host-prosody">
              <label>
                <span className="settings-hint">Speed</span>
                <select
                  aria-label={`Speaking speed for ${host.name}`}
                  value={host.rate}
                  onChange={(e) => editHost(i, { rate: e.target.value })}
                >
                  <option value="">Normal</option>
                  <option value="-10%">Slower</option>
                  <option value="+15%">Faster</option>
                  <option value="+25%">Fastest</option>
                </select>
              </label>
              <label>
                <span className="settings-hint">Pitch</span>
                <select
                  aria-label={`Pitch for ${host.name}`}
                  value={host.pitch}
                  onChange={(e) => editHost(i, { pitch: e.target.value })}
                >
                  <option value="">Normal</option>
                  <option value="-6Hz">Lower</option>
                  <option value="+6Hz">Higher</option>
                </select>
              </label>
            </div>
          </div>
        ))}
      </div>

      {/* A disabled button must say why it is disabled. Without this the
          catalog failing to load looked identical to the feature being broken:
          the picker was empty, Suggest was greyed, and nothing on screen
          mentioned a failed request. */}
      {voicesError && voices.length === 0 && (
        <p className="set-note set-note--flag nb-sem-urgent" role="alert">
          The voice list couldn't be loaded, so each host is reading in the
          default voice. Check your connection and reopen this panel to try
          again — the script and its lines are unaffected.
        </p>
      )}

      <div className="pod-actions">
        <button
          className="subtle"
          onClick={autoCast}
          disabled={voices.length === 0}
          title={
            voices.length === 0
              ? "The voice catalog hasn't loaded — check your connection"
              : "Give each host a different voice automatically"
          }
        >
          Suggest voices
        </button>
        <button className="primary btn-ic" onClick={() => void saveCast()} disabled={!dirty}>
          {saved && !dirty ? (
            <>
              <CircleCheckIcon size={14} /> Saved
            </>
          ) : (
            "Save cast"
          )}
        </button>
      </div>

      <div className="pod-record">
        <button
          className="primary btn-ic"
          disabled={!s.webOn || dirty}
          title={
            !s.webOn
              ? "This room is offline — recording sends each line to an online voice service"
              : dirty
                ? "Save the cast first, so the recording uses the voices you picked"
                : "Record every line in its host's voice"
          }
          onClick={() => void record()}
        >
          <MicIcon size={14} /> {recorded ? "Record again" : "Record the episode"}
        </button>
        {recorded && (
          <button className="subtle" onClick={() => void a.viewFile(recorded)}>
            Open the recording
          </button>
        )}
      </div>
      <p className="settings-hint">
        Recording takes a few minutes — each line is spoken separately. It runs
        in the background, and the finished episode lands in this room as an
        audio file with a clickable transcript.
      </p>
    </div>
  );
}
