import { useEffect, useState } from "react";
import { api } from "../api";
import type { SavedVoice } from "../api";
import { formatWhen } from "../workspace/composer";

/** Naming a speaker in a recording teaches this room that voice, so the next
 * recording puts their name back automatically. This is where that shows.
 *
 * It exists because the feature is otherwise invisible: the room quietly
 * accumulates biometric data about the user's colleagues as a side effect of
 * renaming chips, and a store nobody can see is a store nobody can correct or
 * delete. Everything the room has learned is listed, with the evidence behind
 * each name, and every row can be forgotten. */
export default function SavedVoicesSection() {
  const [voices, setVoices] = useState<SavedVoice[]>([]);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api
      .voicesList()
      .then(setVoices)
      .catch((e) => setError(String(e)))
      .finally(() => setLoaded(true));
  }, []);

  async function forget(name: string) {
    setConfirm(null);
    try {
      setVoices(await api.voiceForget(name));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section id="set-voice-ids">
      <h3>Saved voices</h3>
      <p className="settings-hint">
        When you name a speaker in a recording, this room remembers their voice
        so later recordings can name them for you. A voice it isn't sure about
        stays “Speaker&nbsp;2” — and a name it guessed is marked with a “?” in
        the transcript until you confirm it by typing one.
      </p>
      <p className="settings-hint">
        These stay inside this room, encrypted with it, on this Mac. They are
        never sent to any model, local or cloud, and deleting the room deletes
        them. Other rooms don't share them — the same person is named once per
        room.
      </p>

      {error && <div className="gate-error">{error}</div>}

      {loaded && voices.length === 0 && !error && (
        <p className="set-note">
          Nobody yet. Name a speaker in a recording and they'll appear here.
        </p>
      )}

      {voices.length > 0 && (
        <div className="ckpt-list" data-testid="saved-voices">
          {voices.map((v) =>
            confirm === v.name ? (
              <div key={v.name} className="ckpt-confirm" data-agent-blocked>
                <span className="ckpt-confirm-q">
                  Forget {v.name}'s voice? Recordings that already name them keep
                  their names — new ones will call them “Speaker&nbsp;N” until
                  you name them again.
                </span>
                <div className="ckpt-confirm-actions">
                  <button className="primary" onClick={() => void forget(v.name)}>
                    Forget
                  </button>
                  <button className="subtle" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div key={v.name} className="ckpt-row" data-voice={v.name}>
                <span className="ckpt-meta">
                  <span className="ckpt-name" dir="auto">
                    {v.name}
                  </span>
                  {/* The evidence, plainly: how much of them the room has
                      heard is the whole basis for it recognising them, and
                      "0.8 seconds from one recording" should look as thin as
                      it is. */}
                  <span className="ckpt-sub">
                    {Math.round(v.seconds)}s of speech from {v.takes} recording
                    {v.takes === 1 ? "" : "s"} · learned{" "}
                    {formatWhen(v.updatedAt)}
                    {v.corrections > 0 &&
                      ` · ${v.corrections} correction${v.corrections === 1 ? "" : "s"}`}
                  </span>
                </span>
                <span className="ckpt-actions">
                  <button
                    className="subtle ckpt-action"
                    title={`Stop recognising ${v.name}'s voice`}
                    onClick={() => setConfirm(v.name)}
                  >
                    Forget
                  </button>
                </span>
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}
