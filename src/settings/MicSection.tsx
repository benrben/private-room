import { useEffect, useState } from "react";
import { api } from "../api";
import { CircleCheckIcon } from "../icons";
import { configureMic, micVoiceProcessing } from "../workspace/liveRec";

/** GH #4 — microphone clean-up, and the one thing about it a user can decide.
 *
 * Automatic gain control is NOT offered here: it is always off, because on
 * macOS it moves the shared input device's real gain and other apps on the same
 * microphone hear that as their own volume dropping. The remaining voice
 * processing (echo cancellation + noise suppression) earns its keep on
 * speakers, but it also takes the device into macOS's voice-processing mode.
 * It therefore defaults off so Teams, Slack, Zoom and Meet retain the shared
 * input unchanged; users recording through speakers can opt in. */
export default function MicSection() {
  const [on, setOn] = useState(micVoiceProcessing());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api
      .getSetting("mic_voice_processing")
      .then((v) => {
        const next = v === "1";
        setOn(next);
        configureMic(next);
      })
      .catch(() => {});
  }, []);

  async function save(next: boolean) {
    setOn(next);
    configureMic(next); // takes effect on the NEXT mic acquisition
    try {
      await api.setSetting("mic_voice_processing", next ? "1" : "0");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch {
      /* a failed save just means it won't survive a restart */
    }
  }

  return (
    <section id="set-mic">
      <h3>Microphone</h3>
      <p className="settings-hint">
        Applies to recordings and dictation. Arcelle never changes your
        microphone's input level — your other apps keep the volume you set for
        them. Cleanup starts off so Teams, Slack, Zoom, and Meet can continue
        using the microphone normally while Arcelle records.
      </p>

      <label className="rec-opt">
        <input
          type="checkbox"
          data-testid="mic-voice-processing"
          checked={on}
          onChange={(e) => void save(e.target.checked)}
        />
        Clean up microphone audio (echo cancellation and noise suppression)
      </label>

      {/* What is in force, attached to the switch that decides it. The bold
          "On"/"Off" the copy already carried becomes the tape label — the same
          words, with the emphasis drawn instead of bolded — and the hue says
          which of the two states you are in without the word having to change.
          Neither state is a risk, so both are quiet notes rather than flagged
          ones; the marker only distinguishes them. */}
      <p className={`set-note set-note--flag ${on ? "nb-sem-done" : "nb-sem-pending"}`}>
        {on ? (
          <>
            <span className="nb-tape set-note-tag">On</span> — meeting audio coming out of your speakers is kept out of
            your own voice track, so speakers are told apart correctly. macOS
            puts the microphone into voice-processing mode for this. If you wear
            headphones, or another app sounds quieter while Arcelle records,
            turn this off.
          </>
        ) : (
          <>
            <span className="nb-tape set-note-tag">Off</span> — the microphone is passed through untouched. Best with
            headphones. On speakers, the other people in the call may be picked
            up by your own microphone as well and land in your voice track.
          </>
        )}
      </p>
      <p className="settings-hint">
        Takes effect on the next recording or dictation you start.
      </p>

      {/* This setting applies immediately, so there is no Save button and no
          unsaved state to show — only the confirmation that it stuck, in the
          same green every other "Saved" on this surface uses. */}
      <div className="settings-actions">
        {saved && (
          <span className="settings-confirm btn-ic" role="status">
            <CircleCheckIcon size={14} /> Saved
          </span>
        )}
      </div>
    </section>
  );
}
