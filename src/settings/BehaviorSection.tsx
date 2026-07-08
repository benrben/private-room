interface Props {
  temperature: number;
  setTemperature: (v: number) => void;
  instructions: string;
  setInstructions: (v: string) => void;
  saveTuning: () => void;
  saved: boolean;
}

export default function BehaviorSection({
  temperature,
  setTemperature,
  instructions,
  setInstructions,
  saveTuning,
  saved,
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
    </section>
  );
}
