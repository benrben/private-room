import { useState } from "react";
import type { Schedule, ScheduleArg } from "../../api";
import { CadenceNote, DOW, cadenceOf } from "./cadence";

type Props = {
  schedule: Schedule | null;
  /** True for a file-scoped (run_input) workflow — scheduling is refused. */
  disabled: boolean;
  onSave: (s: ScheduleArg) => void;
  onClose: () => void;
};

/** What the backend will accept, checked here so Save can't close on something
 * the backend is about to reject.
 *
 * Mirrors `next_run_after` in `jobs/scheduler.rs`: minutes must be a whole
 * number above zero, and a time must be a real 24-hour HH:MM. Nothing used to
 * be checked while the popover was open — pressing Save closed it, threw away
 * what had been typed, and only THEN showed "That schedule is invalid", so the
 * one thing needed to fix it was already gone. Returns null when it is fine. */
export function scheduleProblem(
  kind: string,
  interval: string,
  daily: string,
  weekTime: string,
): string | null {
  const badTime = (t: string) => {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(t);
    if (!m) return true;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h > 23 || min > 59;
  };
  if (kind === "interval") {
    const n = Number(interval.trim());
    if (!interval.trim() || !Number.isInteger(n) || n <= 0) {
      return "Minutes must be a whole number above zero.";
    }
    return null;
  }
  if (kind === "daily" && badTime(daily)) {
    return "Time must be HH:MM on a 24-hour clock — e.g. 08:00 or 17:30.";
  }
  if (kind === "weekly" && badTime(weekTime)) {
    return "Time must be HH:MM on a 24-hour clock — e.g. 08:00 or 17:30.";
  }
  return null;
}

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

  const problem = scheduleProblem(kind, interval, daily, weekTime);

  // The exact `param` string the backend stores for this kind, built ONCE: the
  // calendar note below and what Save actually writes read the same value, so
  // the preview cannot describe a schedule other than the one being saved.
  const param =
    kind === "interval" ? interval : kind === "daily" ? daily : `${weekDay} ${weekTime}`;

  function save() {
    if (!kind) {
      onSave({ kind: "" });
      onClose();
      return;
    }
    // Stay open on a bad value: closing is what destroyed the input the user
    // needed in order to correct it.
    if (problem) return;
    onSave({ kind, param, enabled, catchUp });
    onClose();
  }

  // The schedule read back in the same words the library card will show it in,
  // so what you are about to save is legible before you save it. Only drawn
  // once the values parse — echoing an invalid time as a calendar note would
  // claim a run that is never going to happen.
  const preview = kind && !problem ? cadenceOf({ kind, param, enabled }) : null;

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
      {preview && (
        <div className="wf-sched-note">
          <CadenceNote cadence={preview} />
        </div>
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
      {problem && (
        <div className="caption wf-schedule-problem" role="alert">
          {problem}
        </div>
      )}
      <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
        <button className="subtle" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" onClick={save} disabled={!!problem}>
          Save
        </button>
      </div>
    </div>
  );
}
