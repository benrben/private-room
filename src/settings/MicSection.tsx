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
 * speakers, which is why it defaults on — but it also takes the device into
 * macOS's voice-processing mode, so anyone on headphones can hand it back. */
export default function MicSection() {
  const [on, setOn] = useState(micVoiceProcessing());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api
      .getSetting("mic_voice_processing")
      .then((v) => {
        const next = v !== "0";
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
        them.
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

      <p className="settings-hint">
        {on ? (
          <>
            <b>On</b> — meeting audio coming out of your speakers is kept out of
            your own voice track, so speakers are told apart correctly. macOS
            puts the microphone into voice-processing mode for this. If you wear
            headphones, or another app sounds quieter while Arcelle records,
            turn this off.
          </>
        ) : (
          <>
            <b>Off</b> — the microphone is passed through untouched. Best with
            headphones. On speakers, the other people in the call may be picked
            up by your own microphone as well and land in your voice track.
          </>
        )}
      </p>
      <p className="settings-hint">
        Takes effect on the next recording or dictation you start.
      </p>

      <div className="settings-actions">
        {saved && (
          <span className="settings-hint">
            <CircleCheckIcon size={13} /> Saved
          </span>
        )}
      </div>
    </section>
  );
}
