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
}

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
}: Props) {
  return (
    <section id="set-behavior">
      <h3>Behavior</h3>
            <label className="settings-label">
              Creativity (temperature): <strong>{temperature.toFixed(2)}</strong>
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
              Applies to chat answers. Custom instructions below always win over
              the preset.
            </p>
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
            <div className="settings-actions">
              <button className="primary" onClick={saveTuning}>
                {saved ? "Saved ✓" : "Save"}
              </button>
            </div>
            <label className="settings-label">
              <input
                type="checkbox"
                checked={autoIndex}
                onChange={(e) => changeAutoIndex(e.target.checked)}
              />{" "}
              Describe new files automatically with the local AI
            </label>
            <label className="settings-label">
              <input
                type="checkbox"
                checked={memoryAutoSave}
                onChange={(e) => changeMemoryAutoSave(e.target.checked)}
              />{" "}
              Save suggested memories automatically
            </label>
    </section>
  );
}
