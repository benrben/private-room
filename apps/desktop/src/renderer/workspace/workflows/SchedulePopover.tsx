import { type Dispatch, type SetStateAction, useState } from "react";
import type { Schedule, ScheduleArg } from "../../api";
import { CadenceNote, DOW, cadenceOf } from "./cadence";

type Props = {
  schedule: Schedule | null;
  /** True for a file-scoped (run_input) workflow — scheduling is refused. */
  disabled: boolean;
  onSave: (s: ScheduleArg) => void;
  onClose: () => void;
};

type ScheduleForm = {
  kind: string;
  interval: string;
  daily: string;
  weekDay: string;
  weekTime: string;
  enabled: boolean;
  catchUp: boolean;
};

const DEFAULT_FORM: ScheduleForm = {
  kind: "",
  interval: "30",
  daily: "08:00",
  weekDay: "5",
  weekTime: "16:00",
  enabled: true,
  catchUp: true,
};

function weeklyValues(param: string): Pick<ScheduleForm, "weekDay" | "weekTime"> {
  const parts = param.split(/\s+/);
  return { weekDay: parts[0] ?? "5", weekTime: parts[1] ?? "16:00" };
}

function formFor(schedule: Schedule | null): ScheduleForm {
  if (!schedule) return { ...DEFAULT_FORM };
  const initial = { ...DEFAULT_FORM, kind: schedule.kind, enabled: schedule.enabled, catchUp: schedule.catchUp };
  switch (schedule.kind) {
    case "interval":
      return { ...initial, interval: schedule.param };
    case "daily":
      return { ...initial, daily: schedule.param };
    case "weekly":
      return { ...initial, ...weeklyValues(schedule.param) };
    default:
      return initial;
  }
}

function useScheduleForm(schedule: Schedule | null) {
  return useState<ScheduleForm>(() => formFor(schedule));
}

function timeProblem(time: string): string | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(time);
  if (!match) return "Time must be HH:MM on a 24-hour clock — e.g. 08:00 or 17:30.";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour > 23 || minute > 59
    ? "Time must be HH:MM on a 24-hour clock — e.g. 08:00 or 17:30."
    : null;
}

function intervalProblem(interval: string): string | null {
  const minutes = Number(interval.trim());
  if (!interval.trim() || !Number.isInteger(minutes) || minutes <= 0) {
    return "Minutes must be a whole number above zero.";
  }
  return null;
}

/** What the backend will accept, checked here so Save cannot close on something
 * the backend is about to reject. */
export function scheduleProblem(
  kind: string,
  interval: string,
  daily: string,
  weekTime: string,
): string | null {
  if (kind === "interval") return intervalProblem(interval);
  if (kind === "daily") return timeProblem(daily);
  if (kind === "weekly") return timeProblem(weekTime);
  return null;
}

function scheduleParam(form: ScheduleForm): string {
  switch (form.kind) {
    case "interval":
      return form.interval;
    case "daily":
      return form.daily;
    default:
      return `${form.weekDay} ${form.weekTime}`;
  }
}

function updateForm(
  setForm: Dispatch<SetStateAction<ScheduleForm>>,
  change: Partial<ScheduleForm>,
) {
  setForm((current) => ({ ...current, ...change }));
}

function saveSchedule(
  form: ScheduleForm,
  problem: string | null,
  param: string,
  onSave: (schedule: ScheduleArg) => void,
  onClose: () => void,
) {
  if (!form.kind) {
    onSave({ kind: "" });
    onClose();
    return;
  }
  if (problem) return;
  onSave({ kind: form.kind, param, enabled: form.enabled, catchUp: form.catchUp });
  onClose();
}

function DisabledSchedule({ onClose }: Pick<Props, "onClose">) {
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

type FormProps = {
  form: ScheduleForm;
  setForm: Dispatch<SetStateAction<ScheduleForm>>;
};

function ScheduleKind({ form, setForm }: FormProps) {
  return (
    <label>
      Schedule
      <select value={form.kind} onChange={(event) => updateForm(setForm, { kind: event.target.value })}>
        <option value="">Off</option>
        <option value="interval">Every N minutes</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
      </select>
    </label>
  );
}

function ScheduleFields({ form, setForm }: FormProps) {
  if (form.kind === "interval") {
    return (
      <label>
        Minutes
        <input
          type="text"
          value={form.interval}
          onChange={(event) => updateForm(setForm, { interval: event.target.value.replace(/[^0-9]/g, "") })}
        />
      </label>
    );
  }
  if (form.kind === "daily") {
    return (
      <label>
        Time (HH:MM)
        <input type="text" value={form.daily} onChange={(event) => updateForm(setForm, { daily: event.target.value })} />
      </label>
    );
  }
  if (form.kind !== "weekly") return null;
  return (
    <>
      <label>
        Day
        <select value={form.weekDay} onChange={(event) => updateForm(setForm, { weekDay: event.target.value })}>
          {DOW.map((day, index) => (
            <option key={index} value={String(index)}>
              {day}
            </option>
          ))}
        </select>
      </label>
      <label>
        Time (HH:MM)
        <input type="text" value={form.weekTime} onChange={(event) => updateForm(setForm, { weekTime: event.target.value })} />
      </label>
    </>
  );
}

function SchedulePreview({ form, problem, param }: { form: ScheduleForm; problem: string | null; param: string }) {
  if (!form.kind || problem) return null;
  const cadence = cadenceOf({ kind: form.kind, param, enabled: form.enabled });
  return (
    <div className="wf-sched-note">
      <CadenceNote cadence={cadence} />
    </div>
  );
}

function ScheduleToggles({ form, setForm }: FormProps) {
  if (!form.kind) return null;
  return (
    <>
      <label className="wf-toggle-row">
        <span>Enabled</span>
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => updateForm(setForm, { enabled: event.target.checked })}
        />
      </label>
      <label className="wf-toggle-row">
        <span>Catch up at unlock</span>
        <input
          type="checkbox"
          checked={form.catchUp}
          onChange={(event) => updateForm(setForm, { catchUp: event.target.checked })}
        />
      </label>
      <div className="caption">
        Runs while this room is open and unlocked; missed runs catch up at unlock.
      </div>
    </>
  );
}

function ScheduleError({ problem }: { problem: string | null }) {
  if (!problem) return null;
  return (
    <div className="caption wf-schedule-problem" role="alert">
      {problem}
    </div>
  );
}

function ScheduleActions({ problem, onClose, onSave }: { problem: string | null; onClose: () => void; onSave: () => void }) {
  return (
    <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
      <button className="subtle" onClick={onClose}>
        Cancel
      </button>
      <button className="primary" onClick={onSave} disabled={!!problem}>
        Save
      </button>
    </div>
  );
}

function ScheduleEditor({ form, setForm, onSave, onClose }: FormProps & Pick<Props, "onSave" | "onClose">) {
  const problem = scheduleProblem(form.kind, form.interval, form.daily, form.weekTime);
  const param = scheduleParam(form);
  const save = () => saveSchedule(form, problem, param, onSave, onClose);
  return (
    <div className="wf-popover">
      <ScheduleKind form={form} setForm={setForm} />
      <ScheduleFields form={form} setForm={setForm} />
      <SchedulePreview form={form} problem={problem} param={param} />
      <ScheduleToggles form={form} setForm={setForm} />
      <ScheduleError problem={problem} />
      <ScheduleActions problem={problem} onClose={onClose} onSave={save} />
    </div>
  );
}

export function SchedulePopover({ schedule, disabled, onSave, onClose }: Props) {
  const [form, setForm] = useScheduleForm(schedule);
  if (disabled) return <DisabledSchedule onClose={onClose} />;
  return <ScheduleEditor form={form} setForm={setForm} onSave={onSave} onClose={onClose} />;
}
