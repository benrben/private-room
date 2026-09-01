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
  // Held apart from `script`, because a failed READ and a page that genuinely
  // carries no script both arrive as null — and the explanation below tells the
  // user to regenerate the episode, which is minutes of model time and a
  // duplicate for a script that was never lost.
  const [readError, setReadError] = useState("");
  const [voices, setVoices] = useState<NeuralVoiceInfo[]>([]);
  const [voicesError, setVoicesError] = useState(false);
  const [cast, setCast] = useState<PodcastHost[]>([]);
  const [autoCastDone, setAutoCastDone] = useState(false);
  const [saved, setSaved] = useState(false);
  // Keyed by the host's POSITION in the cast, never by its name: two hosts may
  // share a name, and the Stop button then lit on the wrong row while the
  // click handler addressed a host nobody had pressed.
  const [previewing, setPreviewing] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrl = useRef<string | null>(null);
  // Every preview takes the next number; anything that comes back holding an
  // older one has been superseded (a second Preview, Stop, or this panel
  // unmounting) and must not touch the element, the state or the speakers.
  const previewEpoch = useRef(0);

  // The script and the catalog are independent: a room that is offline still
  // shows the cast and the lines, just without a list of voices to change them
  // to. Failing the whole panel on a catalog fetch would hide the script too.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setReadError("");
    void (async () => {
      try {
        const p = await api.getPodcast(fileId);
        if (!alive) return;
        setScript(p);
        setCast(p?.cast ?? []);
      } catch (e) {
        if (!alive) return;
        setScript(null);
        setReadError(String(e));
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
    previewEpoch.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    if (previewUrl.current) {
      // A blob URL holds the whole WAV alive for as long as the document does,
      // so auditioning a dozen voices used to leave a dozen clips resident.
      URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    }
    setPreviewing(null);
  }

  function editHost(i: number, patch: Partial<PodcastHost>) {
    setCast((cur) => cur.map((h, n) => (n === i ? { ...h, ...patch } : h)));
    setSaved(false);
  }

  async function saveCast() {
    try {
      // Trimmed ON THE WAY IN. The turns are re-folded onto the trimmed
      // spelling by `set_podcast_cast`, while the cast kept whatever was typed
      // — so a host saved as "Ada " matched none of their own lines and the
      // whole episode read them in the default voice, discovered only after a
      // multi-minute cloud render. Not trimmed in `editHost`: that would eat
      // the space between "Ada" and a surname as it is typed.
      const named = cast.map((h) => ({ ...h, name: h.name.trim() }));
      const next = await api.setPodcastCast(fileId, named);
      setScript(next);
      setCast(next.cast);
      setSaved(true);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Speak one of this host's ACTUAL lines where there is one. Hearing the
   * words the episode will contain is what tells you whether the voice suits
   * the script; "The quick brown fox" tells you nothing about either. A host
   * whose name matches no speaker — freshly renamed, or cast before the script
   * was written — has no line to hear, so a greeting stands in. The button's
   * title promises only that something is sent and spoken, because that is the
   * half that is true on both branches. */
  async function preview(i: number, host: PodcastHost) {
    if (previewing === i) {
      stopPreview();
      return;
    }
    stopPreview();
    const epoch = previewEpoch.current;
    const line =
      script?.turns.find(
        (t) => t.speaker.toLowerCase() === host.name.trim().toLowerCase(),
      )?.line ?? `Hello, I'm ${host.name}.`;
    setPreviewing(i);
    try {
      const b64 = await api.previewPodcastVoice(
        line.slice(0, 300),
        host.voice,
        host.rate,
        host.pitch,
      );
      // Synthesis is a cloud round trip, so a second Preview — or leaving the
      // panel — can land first. Answering it would start a second clip over
      // the top of the first and orphan whichever element `audioRef` no longer
      // holds, leaving one voice talking with nothing that could stop it.
      if (epoch !== previewEpoch.current) return;
      const url = URL.createObjectURL(
        new Blob([base64ToBytes(b64)], { type: "audio/wav" }),
      );
      const el = new Audio(url);
      audioRef.current = el;
      previewUrl.current = url;
      el.onended = () => {
        if (epoch === previewEpoch.current) stopPreview();
      };
      await el.play();
    } catch (e) {
      if (epoch !== previewEpoch.current) return;
      stopPreview();
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

  return (
    <PodcastPanelContent
      a={a}
      autoCast={autoCast}
      cast={cast}
      editHost={editHost}
      loading={loading}
      preview={preview}
      previewing={previewing}
      readError={readError}
      record={record}
      s={s}
      saveCast={saveCast}
      saved={saved}
      script={script}
      voices={voices}
      voicesError={voicesError}
    />
  );
}

type EditHost = (index: number, patch: Partial<PodcastHost>) => void;
type PreviewHost = (index: number, host: PodcastHost) => Promise<void>;

interface PodcastPanelContentProps {
  a: WSActions;
  autoCast: () => void;
  cast: PodcastHost[];
  editHost: EditHost;
  loading: boolean;
  preview: PreviewHost;
  previewing: number | null;
  readError: string;
  record: () => Promise<void>;
  s: WSState;
  saveCast: () => Promise<void>;
  saved: boolean;
  script: Podcast | null;
  voices: NeuralVoiceInfo[];
  voicesError: boolean;
}

function PodcastPanelContent({ loading, readError, script, ...props }: PodcastPanelContentProps) {
  if (loading) return <div className="pod-panel">Loading the script…</div>;
  if (readError) return <PodcastReadError error={readError} />;
  if (!script) return <PodcastMissingScript />;
  return <PodcastScriptPanel {...props} script={script} />;
}

function PodcastReadError({ error }: { error: string }) {
  return (
    <div className="pod-panel">
      <p className="set-note set-note--flag nb-sem-urgent" role="alert">
        This script couldn't be read just now ({error}). Nothing was changed — reopen the page to try again.
      </p>
    </div>
  );
}

function PodcastMissingScript() {
  return (
    <div className="pod-panel">
      <p className="settings-hint">
        This page has no script attached, so it can't be cast or recorded. Podcast scripts made before voices
        existed are pages only — generate the podcast again from the Studio shelf and the new one will have voices.
      </p>
    </div>
  );
}

type PodcastScriptPanelProps = Omit<PodcastPanelContentProps, "loading" | "readError" | "script"> & {
  script: Podcast;
};

function PodcastScriptPanel({ a, autoCast, cast, editHost, preview, previewing, record, s, saveCast, saved, script, voices, voicesError }: PodcastScriptPanelProps) {
  const { multilingual, byLanguage } = groupVoices(voices);
  const dirty = JSON.stringify(cast) !== JSON.stringify(script.cast);
  return (
    <div className="pod-panel">
      <PodcastHeader cast={cast} script={script} />
      <PodcastCloudBoundary />
      <PodcastNotices privacyOn={s.privacyOn} webOn={s.webOn} />
      <PodcastCastEditor
        byLanguage={byLanguage}
        cast={cast}
        editHost={editHost}
        multilingual={multilingual}
        preview={preview}
        previewing={previewing}
        voices={voices}
      />
      <VoiceCatalogError failed={voicesError} voices={voices} />
      <PodcastCastActions autoCast={autoCast} dirty={dirty} onSaveCast={saveCast} saved={saved} voices={voices} />
      <PodcastRecordActions a={a} dirty={dirty} onRecord={record} recorded={script.audioFileId} webOn={s.webOn} />
      <p className="settings-hint">
        Recording takes a few minutes — each line is spoken separately. It runs in the background, and the finished
        episode lands in this room as an audio file with a clickable transcript.
      </p>
    </div>
  );
}

function PodcastHeader({ cast, script }: { cast: PodcastHost[]; script: Podcast }) {
  return (
    <div className="pod-head">
      <h3>{script.title}</h3>
      <span className="settings-hint">
        {script.turns.length} turns · {cast.length} host{cast.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function PodcastCloudBoundary() {
  return (
    <div className="voice-boundary set-note set-note--flag set-note--lead nb-sem-urgent">
      <span className="nb-tape set-note-tag">Recording uses a cloud voice</span>{" "}
      — every line of this script is sent to Microsoft's Edge TTS service to be spoken. Nothing else goes with it,
      and nothing is sent until you press Preview or Record.
    </div>
  );
}

function PodcastNotices({ privacyOn, webOn }: { privacyOn: boolean | null; webOn: boolean }) {
  return (
    <>
      {privacyOn && (
        <p className="set-note set-note--flag nb-sem-pending" role="note">
          This room's privacy door is on, so names in the script are replaced before they are spoken — a preview and
          the finished recording will both say “Person A” where the script says a real name. Turn the door off in
          Settings → Cloud privacy first if you want the real names read aloud.
        </p>
      )}
      {!webOn && (
        <p className="set-note set-note--flag nb-sem-urgent" role="alert">
          This room is offline, so it can't be recorded — speaking sends each line to an online voice service. Turn on
          Settings → Online features to record. You can still cast the hosts now.
        </p>
      )}
    </>
  );
}

function PodcastCastEditor({
  byLanguage,
  cast,
  editHost,
  multilingual,
  preview,
  previewing,
  voices,
}: {
  byLanguage: ReturnType<typeof groupVoices>["byLanguage"];
  cast: PodcastHost[];
  editHost: EditHost;
  multilingual: NeuralVoiceInfo[];
  preview: PreviewHost;
  previewing: number | null;
  voices: NeuralVoiceInfo[];
}) {
  return (
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
              title={`Send a short line to the voice service and hear it in ${host.name || "this host"}'s voice`}
              aria-label={`Preview ${host.name}`}
              onClick={() => void preview(i, host)}
            >
              {previewing === i ? <StopIcon size={12} /> : <PlayIcon size={12} />}
            </button>
          </div>
          <select
            className="chat-select"
            aria-label={`Voice for ${host.name}`}
            value={host.voice}
            onChange={(e) => editHost(i, { voice: e.target.value })}
          >
            <option value="">Default — Andrew · multilingual</option>
            {host.voice && !voices.some((v) => v.id === host.voice) && (
              <option value={host.voice}>{voiceName(host.voice)} — saved voice</option>
            )}
            {multilingual.length > 0 && (
              <optgroup label="Multilingual — reads any language">
                {multilingual.map((v) => (
                  <option key={v.id} value={v.id}>{optionLabel(v)} · {languageLabel(v.locale)}</option>
                ))}
              </optgroup>
            )}
            {byLanguage.map(([lang, group]) => (
              <optgroup key={lang} label={lang}>
                {group.map((v) => <option key={v.id} value={v.id}>{optionLabel(v)}</option>)}
              </optgroup>
            ))}
          </select>
          <PodcastProsody host={host} index={i} editHost={editHost} />
        </div>
      ))}
    </div>
  );
}

function PodcastProsody({ host, index, editHost }: { host: PodcastHost; index: number; editHost: EditHost }) {
  return (
    <div className="pod-host-prosody">
      <label>
        <span className="settings-hint">Speed</span>
        <select aria-label={`Speaking speed for ${host.name}`} value={host.rate} onChange={(e) => editHost(index, { rate: e.target.value })}>
          <option value="">Normal</option>
          <option value="-10%">Slower</option>
          <option value="+15%">Faster</option>
          <option value="+25%">Fastest</option>
        </select>
      </label>
      <label>
        <span className="settings-hint">Pitch</span>
        <select aria-label={`Pitch for ${host.name}`} value={host.pitch} onChange={(e) => editHost(index, { pitch: e.target.value })}>
          <option value="">Normal</option>
          <option value="-6Hz">Lower</option>
          <option value="+6Hz">Higher</option>
        </select>
      </label>
    </div>
  );
}

function VoiceCatalogError({ failed, voices }: { failed: boolean; voices: NeuralVoiceInfo[] }) {
  if (!failed || voices.length) return null;
  return (
    <p className="set-note set-note--flag nb-sem-urgent" role="alert">
      The voice list couldn't be loaded, so each host is reading in the default voice. Check your connection and
      reopen this panel to try again — the script and its lines are unaffected.
    </p>
  );
}

function PodcastCastActions({
  autoCast,
  dirty,
  onSaveCast,
  saved,
  voices,
}: {
  autoCast: () => void;
  dirty: boolean;
  onSaveCast: () => Promise<void>;
  saved: boolean;
  voices: NeuralVoiceInfo[];
}) {
  return (
    <div className="pod-actions">
      <button
        className="subtle"
        onClick={autoCast}
        disabled={voices.length === 0}
        title={voices.length === 0 ? "The voice catalog hasn't loaded — check your connection" : "Give each host a different voice automatically"}
      >
        Suggest voices
      </button>
      <button className="primary btn-ic" onClick={() => void onSaveCast()} disabled={!dirty}>
        {saved && !dirty ? <><CircleCheckIcon size={14} /> Saved</> : "Save cast"}
      </button>
    </div>
  );
}

function PodcastRecordActions({
  a,
  dirty,
  onRecord,
  recorded,
  webOn,
}: {
  a: WSActions;
  dirty: boolean;
  onRecord: () => Promise<void>;
  recorded: string | null;
  webOn: boolean;
}) {
  const title = !webOn
    ? "This room is offline — recording sends each line to an online voice service"
    : dirty
      ? "Save the cast first, so the recording uses the voices you picked"
      : "Record every line in its host's voice";
  return (
    <div className="pod-record">
      <button className="primary btn-ic" disabled={!webOn || dirty} title={title} onClick={() => void onRecord()}>
        <MicIcon size={14} /> {recorded ? "Record again" : "Record the episode"}
      </button>
      {recorded && <button className="subtle" onClick={() => void a.viewFile(recorded)}>Open the recording</button>}
    </div>
  );
}
