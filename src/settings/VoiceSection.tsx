import { VoiceInfo } from "../api";
import { VoiceArchetype, VoiceEngine, VoiceParams } from "../workspace/voice";

interface Props {
  engine: VoiceEngine;
  setEngine: (e: VoiceEngine) => void;
  archetype: VoiceArchetype;
  pickArchetype: (a: VoiceArchetype) => void;
  params: VoiceParams;
  setParam: (k: keyof VoiceParams, v: number) => void;
  voiceId: string;
  setVoiceId: (id: string) => void;
  voices: VoiceInfo[];
  save: () => void;
  saved: boolean;
  preview: () => void;
  previewing: boolean;
}

// "off" is the id of the clean, unshaped voice (it never disables speaking —
// the chat toggles decide that), so it reads "Plain" here.
const ARCHETYPES: [VoiceArchetype, string][] = [
  ["off", "Plain"],
  ["demon", "Demon"],
  ["ghost", "Ghost"],
  ["wraith", "Wraith"],
  ["ancient", "Ancient"],
  ["custom", "Custom"],
];

const ENGINES: [VoiceEngine, string][] = [
  ["neural", "Neural (default)"],
  ["device", "On-device"],
];

/** Idea 3: "Spoken voice" — labeled to avoid colliding with the writing-style
 * "voice" presets in Behavior. */
export default function VoiceSection({
  engine,
  setEngine,
  archetype,
  pickArchetype,
  params,
  setParam,
  voiceId,
  setVoiceId,
  voices,
  save,
  saved,
  preview,
  previewing,
}: Props) {
  const slider = (
    label: string,
    k: keyof VoiceParams,
    min: number,
    max: number,
    step: number,
  ) => (
    <div className="temp-row">
      <span className="settings-hint" style={{ minWidth: 72 }}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={params[k]}
        onChange={(e) => setParam(k, parseFloat(e.target.value))}
      />
      <span className="settings-hint">{params[k].toFixed(2)}</span>
    </div>
  );
  return (
    <section id="set-voice">
      <h3>Spoken voice</h3>
      <p className="settings-hint">
        Give answers a voice. Turn it on per answer with ▶ Play, or for every
        answer with the speaker toggle above the chat.
      </p>
      <label className="settings-label">Voice engine</label>
      <div className="temp-row" role="radiogroup" aria-label="Voice engine">
        {ENGINES.map(([id, label]) => (
          <button
            key={id}
            role="radio"
            aria-checked={engine === id}
            className={`subtle${engine === id ? " accent" : ""}`}
            onClick={() => setEngine(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="settings-hint">
        {engine === "neural" ? (
          <>
            <b>Neural</b> speaks with Andrew (en-US, multilingual) — a{" "}
            <b>neural synthetic voice, not a human recording</b> — via
            Microsoft's Edge TTS service at +22% rate, −2 Hz pitch, loudness
            normalized to about −16 LUFS. Only the sentence being spoken
            leaves this Mac, and only while speaking is on. Offline, answers
            fall back to the on-device voice.
          </>
        ) : (
          <>
            <b>On-device</b> synthesizes with macOS's own voices — nothing
            about your answers leaves this Mac.
          </>
        )}
      </p>
      <label className="settings-label">Archetype</label>
      <div className="temp-row" role="radiogroup" aria-label="Voice archetype">
        {ARCHETYPES.map(([id, label]) => (
          <button
            key={id}
            role="radio"
            aria-checked={archetype === id}
            className={`subtle${archetype === id ? " accent" : ""}`}
            onClick={() => pickArchetype(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {engine === "device" && (
        <>
          <label className="settings-label">System voice</label>
          <select
            className="chat-select"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
          >
            <option value="">System default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
          {slider("Pitch", "pitch", 0.5, 2.0, 0.05)}
          {slider("Rate", "rate", 0.1, 0.7, 0.02)}
        </>
      )}
      {slider("Reverb", "reverb", 0, 1, 0.05)}
      {slider("Distortion", "distortion", 0, 1, 0.05)}
      <div className="settings-actions">
        <button className="subtle" onClick={preview}>
          {previewing ? "◼ Stop preview" : "▶ Preview"}
        </button>
        <button className="primary" onClick={save}>
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>
    </section>
  );
}
