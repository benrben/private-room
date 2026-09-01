import { NeuralVoiceInfo } from "../api";
import { PlayIcon, StopIcon, CircleCheckIcon } from "../icons";
import { VoiceArchetype, VoiceParams } from "../workspace/voice";
import {
  groupVoices,
  languageLabel,
  optionLabel,
  voiceName,
} from "./voiceCatalog";

interface Props {
  neuralVoiceId: string;
  setNeuralVoiceId: (id: string) => void;
  archetype: VoiceArchetype;
  pickArchetype: (a: VoiceArchetype) => void;
  params: VoiceParams;
  setParam: (k: keyof VoiceParams, v: number) => void;
  voices: NeuralVoiceInfo[];
  voicesError: boolean;
  save: () => void;
  saved: boolean;
  saveError: string;
  preview: () => void;
  previewing: boolean;
}

interface VoiceSliderProps {
  label: string;
  setting: keyof VoiceParams;
  min: number;
  max: number;
  step: number;
  params: VoiceParams;
  setParam: Props["setParam"];
}

interface VoicePickerProps {
  neuralVoiceId: string;
  setNeuralVoiceId: Props["setNeuralVoiceId"];
  voices: NeuralVoiceInfo[];
  voicesError: boolean;
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

function VoiceSlider({
  label,
  setting,
  min,
  max,
  step,
  params,
  setParam,
}: VoiceSliderProps) {
  return (
    <div className="temp-row">
      <span className="settings-hint" style={{ minWidth: 72 }}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={params[setting]}
        onChange={(e) => setParam(setting, parseFloat(e.target.value))}
      />
      <span className="settings-hint set-figure">
        {params[setting].toFixed(2)}
      </span>
    </div>
  );
}

function SavedVoiceOption({ known, voiceId }: { known: boolean; voiceId: string }) {
  if (known) return null;
  return <option value={voiceId}>{voiceName(voiceId)} — saved voice</option>;
}

function MultilingualVoiceOptions({ voices }: { voices: NeuralVoiceInfo[] }) {
  if (voices.length === 0) return null;
  return (
    <optgroup label="Multilingual — reads any language">
      {voices.map((voice) => (
        <option key={voice.id} value={voice.id}>
          {optionLabel(voice)} · {languageLabel(voice.locale)}
        </option>
      ))}
    </optgroup>
  );
}

function LanguageVoiceOptions({ groups }: { groups: ReturnType<typeof groupVoices>["byLanguage"] }) {
  return groups.map(([language, voices]) => (
    <optgroup key={language} label={language}>
      {voices.map((voice) => (
        <option key={voice.id} value={voice.id}>
          {optionLabel(voice)}
        </option>
      ))}
    </optgroup>
  ));
}

function VoiceCatalogError({ failed, voices }: { failed: boolean; voices: NeuralVoiceInfo[] }) {
  if (!failed || voices.length > 0) return null;
  return (
    <p className="settings-hint">
      Couldn't load the voice catalog — check your connection. Your saved voice still works.
    </p>
  );
}

function VoicePicker({ neuralVoiceId, setNeuralVoiceId, voices, voicesError }: VoicePickerProps) {
  const { multilingual, byLanguage } = groupVoices(voices);
  const knownSaved = !neuralVoiceId || voices.some((voice) => voice.id === neuralVoiceId);
  return (
    <>
      <label className="settings-label">
        Voice{voices.length > 0 ? ` (${voices.length} available)` : ""}
      </label>
      <select
        className="chat-select"
        value={neuralVoiceId}
        onChange={(event) => setNeuralVoiceId(event.target.value)}
      >
        <option value="">Default — Andrew · multilingual</option>
        <SavedVoiceOption known={knownSaved} voiceId={neuralVoiceId} />
        <MultilingualVoiceOptions voices={multilingual} />
        <LanguageVoiceOptions groups={byLanguage} />
      </select>
      <VoiceCatalogError failed={voicesError} voices={voices} />
    </>
  );
}

function VoiceArchetypePicker({ archetype, pickArchetype }: Pick<Props, "archetype" | "pickArchetype">) {
  return (
    <div className="style-seg" role="radiogroup" aria-label="Voice archetype">
      {ARCHETYPES.map(([id, label]) => (
        <button
          key={id}
          role="radio"
          aria-checked={archetype === id}
          className={`style-seg-opt${archetype === id ? " active" : ""}`}
          onClick={() => pickArchetype(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function VoiceActions({ preview, previewing, save, saved }: Pick<Props, "preview" | "previewing" | "save" | "saved">) {
  return (
    <div className="settings-actions">
      <button className="subtle btn-ic" onClick={preview}>
        {previewing ? (
          <><StopIcon size={12} /> Stop preview</>
        ) : (
          <><PlayIcon size={12} /> Preview</>
        )}
      </button>
      <button className="primary btn-ic" onClick={save}>
        {saved ? (<><CircleCheckIcon size={14} /> Saved</>) : "Save"}
      </button>
    </div>
  );
}

// Naming and grouping live in `voiceCatalog` — shared with the podcast's
// per-host picker, so the two cannot describe the same voice differently.

/** Idea 3: "Spoken voice" — labeled to avoid colliding with the writing-style
 * "voice" presets in Behavior. The voice list is the service's LIVE catalog
 * (grouped: multilingual first, then per language) — nothing is bundled, and
 * a voice is vetted by listening (▶ Preview), not pre-tested. */
export default function VoiceSection({
  neuralVoiceId,
  setNeuralVoiceId,
  archetype,
  pickArchetype,
  params,
  setParam,
  voices,
  voicesError,
  save,
  saved,
  saveError,
  preview,
  previewing,
}: Props) {
  return (
    <section id="set-voice">
      <h3>Spoken voice</h3>
      <p className="settings-hint">
        Give answers a voice. Turn it on per answer with ▶ Play, or for every
        answer with the speaker toggle above the chat.
      </p>
      {/* The data boundary, stated plainly and first — speaking always uses
          the cloud voice, so a naïve user must not have to infer that. The
          tape carries the clause that was already bold in the copy; not one
          word changed, the emphasis is simply drawn instead of bolded. */}
      <div className="voice-boundary set-note set-note--flag set-note--lead nb-sem-urgent">
        <span className="nb-tape set-note-tag">
          Spoken answers use a cloud voice
        </span>{" "}
        — the text of each spoken sentence leaves this Mac, sent to Microsoft's
        Edge TTS service. Only the sentence being spoken is sent, and only
        while speaking is on. So it needs the room's internet switch on
        (Settings → Online features): with that off, answers stay silent —
        including ▶ Preview — and no sentence is sent.
      </div>
      {/* A saved voice the catalog no longer lists (or a failed load) still
          needs an option, or the select would silently jump to Default. */}
      <VoicePicker
        neuralVoiceId={neuralVoiceId}
        setNeuralVoiceId={setNeuralVoiceId}
        voices={voices}
        voicesError={voicesError}
      />
      {/* Rates, pitch offsets and LUFS targets are the densest technical run
          in Settings and they sit under a dropdown almost nobody reads twice.
          Folded behind a disclosure — every word still in the DOM, still in
          the accessibility tree, still reachable by find-in-page. The data
          boundary above it stays open, because that one is a promise. */}
      <details className="set-more">
        <summary>About these voices</summary>
        <p className="settings-hint">
          These are <b>neural synthetic voices, not human recordings</b> —
          synthesized by Microsoft's Edge TTS service at +22% rate, −2 Hz
          pitch, loudness normalized to about −16 LUFS. The list is fetched
          live from the service's catalog, so new voices appear on their own.
          <b> Multilingual</b> voices read whatever language your answer is in
          — Hebrew included. A voice listed under a language heading only
          sounds right in that language. Offline, answers stay silent until
          the connection returns. Use ▶ Preview to hear the one you picked
          before saving.
        </p>
      </details>
      <label className="settings-label">Archetype</label>
      {/* Same segmented control as Behavior's response style and Appearance's
          theme — one exclusive choice, one idiom. The chosen option used to be
          marked by TEXT COLOUR alone, which is the one thing status is never
          allowed to be; it now carries the ring, the wash and a heavier
          weight as well, and the role/aria-checked pair is untouched. */}
      <VoiceArchetypePicker archetype={archetype} pickArchetype={pickArchetype} />
      <VoiceSlider label="Reverb" setting="reverb" min={0} max={1} step={0.05} params={params} setParam={setParam} />
      <VoiceSlider label="Distortion" setting="distortion" min={0} max={1} step={0.05} params={params} setParam={setParam} />
      <VoiceActions preview={preview} previewing={previewing} save={save} saved={saved} />
      {/* A save that fails used to look exactly like a click that did nothing. */}
      {saveError && (
        <p className="set-note set-note--flag nb-sem-urgent" role="alert">
          {saveError}
        </p>
      )}
    </section>
  );
}
