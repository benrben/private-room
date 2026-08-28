import { CircleCheckIcon } from "../icons";

interface Props {
  temperature: number;
  setTemperature: (v: number) => void;
  instructions: string;
  setInstructions: (v: string) => void;
  saveTuning: () => void;
  saved: boolean;
  /** Wave 1b (idea 12): response-style preset — persists immediately. */
  responseStyle: string;
  changeResponseStyle: (v: string) => void;
  /** Wave 1b (idea 8): auto-describe new files — persists immediately. */
  autoIndex: boolean;
  changeAutoIndex: (on: boolean) => void;
  /** Wave 1b (idea 5): auto-save suggested memories — persists immediately. */
  memoryAutoSave: boolean;
  changeMemoryAutoSave: (on: boolean) => void;
  /** Wave 2 (idea 6): ask-before-edit cadence — persists immediately. */
  editApproval: string;
  changeEditApproval: (v: string) => void;
  /** Master switch for adaptive UI text (area subtitles, tab titles, activity
   * summaries) — persists immediately. */
  adaptiveTextEnabled: boolean;
  changeAdaptiveTextEnabled: (on: boolean) => void;
}

const EDIT_APPROVAL_OPTIONS: { value: string; label: string }[] = [
  { value: "off", label: "Off — undo covers mistakes" },
  { value: "turn", label: "Once per answer" },
  { value: "edit", label: "Every edit" },
];

const STYLE_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "terse", label: "Terse" },
  { value: "friendly", label: "Friendly" },
  { value: "formal", label: "Formal" },
];

export default function BehaviorSection({
  temperature,
  setTemperature,
  instructions,
  setInstructions,
  saveTuning,
  saved,
  responseStyle,
  changeResponseStyle,
  autoIndex,
  changeAutoIndex,
  memoryAutoSave,
  changeMemoryAutoSave,
  editApproval,
  changeEditApproval,
  adaptiveTextEnabled,
  changeAdaptiveTextEnabled,
}: Props) {
  return (
    <section id="set-behavior">
      <h3>Behavior</h3>
            {/* Every control here is written with api.setSetting, i.e. into
                this room's encrypted DB — unlike Appearance and Interface,
                which are this Mac's. The reader has no other way to tell. */}
            <p className="settings-hint">
              These belong to this room. Another room keeps its own.
            </p>
            <label className="settings-label">
              Creativity (temperature):{" "}
              <strong className="set-figure">{temperature.toFixed(2)}</strong>
            </label>
            <div className="temp-row">
              <span className="settings-hint">focused</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
              />
              <span className="settings-hint">imaginative</span>
            </div>
            <label className="settings-label">Custom instructions</label>
            <textarea
              rows={4}
              dir="auto"
              placeholder='Shape the AI&apos;s tone, e.g. "Answer briefly and formally, in Hebrew when I write Hebrew."'
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={(e) => {
                // Don't let Escape bubble to the modal close and discard edits.
                if (e.key === "Escape") e.stopPropagation();
              }}
            />
            {/* The button saves the slider and the textarea and nothing else
                (saveTuning). Everything that persists on change now sits
                BELOW it, so the grouping and the save model agree — and the
                sentence says so, because a Save button is read as governing
                whatever it is drawn near. */}
            <div className="settings-actions">
              <button className="primary btn-ic" onClick={saveTuning}>
                {saved ? (<><CircleCheckIcon size={14} /> Saved</>) : "Save"}
              </button>
            </div>
            <p className="settings-hint">
              Saves the creativity slider and the custom instructions.
              Everything below applies the moment you change it.
            </p>
            <label className="settings-label">Response style</label>
            <div className="style-seg" role="radiogroup" aria-label="Response style">
              {STYLE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={responseStyle === o.value}
                  className={`style-seg-opt${responseStyle === o.value ? " active" : ""}`}
                  onClick={() => changeResponseStyle(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="settings-hint">
              Applies to chat answers. Custom instructions above always win over
              the preset.
            </p>
            <label className="settings-label">
              <input
                type="checkbox"
                checked={autoIndex}
                onChange={(e) => changeAutoIndex(e.target.checked)}
              />{" "}
              Describe new files automatically with the local AI
            </label>
            {/* The numbers are auto_index.rs's: AUTO_INDEX_DEBOUNCE_SECS = 30,
                QUIET_FILLER_MAX = 5. */}
            <p className="settings-hint">
              About half a minute after files land, the local model writes a
              short description of each. Up to five at a time happen quietly;
              a bigger batch becomes an “Indexing new files” job you can stop.
              Off, files are imported undescribed and nothing runs.
            </p>
            <label className="settings-label">
              <input
                type="checkbox"
                checked={memoryAutoSave}
                onChange={(e) => changeMemoryAutoSave(e.target.checked)}
              />{" "}
              Save suggested memories automatically
            </label>
            <p className="settings-hint">
              When an answer ends with something worth keeping, it is written
              straight to this room's Memory, with a Forget button on the
              toast. Off, it is offered as a card in that conversation instead.
            </p>
            <label className="settings-label">
              <input
                type="checkbox"
                checked={adaptiveTextEnabled}
                onChange={(e) => changeAdaptiveTextEnabled(e.target.checked)}
              />{" "}
              Let the local AI write small pieces of the interface (area
              summaries, tab titles, activity summaries)
            </label>
            <p className="settings-hint">
              Generated locally from what's already in the room. Off falls
              back to the plain static labels everywhere.
            </p>
            <label className="settings-label" htmlFor="edit-approval-select">
              Ask before the AI edits files
            </label>
            <select
              id="edit-approval-select"
              value={editApproval}
              onChange={(e) => changeEditApproval(e.target.value)}
            >
              {EDIT_APPROVAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="settings-hint">
              When on, the AI shows a before/after diff and waits for your approval
              before changing any file. Off by default — every edit is auto-saved
              to History and one-click undoable.
            </p>
    </section>
  );
}
