import { useState } from "react";
import type { Schedule, ScheduleArg } from "../../api";

type Props = {
  schedule: Schedule | null;
  /** True for a file-scoped (run_input) workflow — scheduling is refused. */
  disabled: boolean;
  onSave: (s: ScheduleArg) => void;
  onClose: () => void;
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function SchedulePopover({ schedule, disabled, onSave, onClose }: Props) {
  const [kind, setKind] = useState<string>(schedule?.kind ?? "");
  const [interval, setIntervalMin] = useState(
    schedule?.kind === "interval" ? schedule.param : "30",
  );
  const [daily, setDaily] = useState(schedule?.kind === "daily" ? schedule.param : "08:00");
  const initWeekly = schedule?.kind === "weekly" ? schedule.param.split(/\s+/) : ["5", "16:00"];
  const [weekDay, setWeekDay] = useState(initWeekly[0] ?? "5");
  const [weekTime, setWeekTime] = useState(initWeekly[1] ?? "16:00");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [catchUp, setCatchUp] = useState(schedule?.catchUp ?? true);

  if (disabled) {
    return (
      <div className="wf-popover">
        <div className="caption">
          This workflow runs on a chosen file, so it can't be scheduled — run it from a file's
          Actions menu instead.
        </div>
        <button className="subtle" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  function save() {
    if (!kind) {
      onSave({ kind: "" });
      onClose();
      return;
    }
    const param =
      kind === "interval" ? interval : kind === "daily" ? daily : `${weekDay} ${weekTime}`;
    onSave({ kind, param, enabled, catchUp });
    onClose();
  }

  return (
    <div className="wf-popover">
      <label>
        Schedule
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Off</option>
          <option value="interval">Every N minutes</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      {kind === "interval" && (
        <label>
          Minutes
          <input
            type="text"
            value={interval}
            onChange={(e) => setIntervalMin(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </label>
      )}
      {kind === "daily" && (
        <label>
          Time (HH:MM)
          <input type="text" value={daily} onChange={(e) => setDaily(e.target.value)} />
        </label>
      )}
      {kind === "weekly" && (
        <>
          <label>
            Day
            <select value={weekDay} onChange={(e) => setWeekDay(e.target.value)}>
              {DOW.map((d, i) => (
                <option key={i} value={String(i)}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Time (HH:MM)
            <input type="text" value={weekTime} onChange={(e) => setWeekTime(e.target.value)} />
          </label>
        </>
      )}
      {kind && (
        <>
          <label className="wf-toggle-row">
            <span>Enabled</span>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </label>
          <label className="wf-toggle-row">
            <span>Catch up at unlock</span>
            <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} />
          </label>
          <div className="caption">
            Runs while this room is open and unlocked; missed runs catch up at unlock.
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
        <button className="subtle" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
