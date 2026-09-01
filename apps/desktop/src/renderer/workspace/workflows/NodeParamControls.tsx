import { useState } from "react";
import type { WorkflowNode } from "../../api";

export type SetNode = (key: string, value: unknown) => void;
export type FormProps = { node: WorkflowNode; set: SetNode };

export const FILE_SELECTORS = [
  ["newest", "Newest file"],
  ["all", "All files"],
  ["name_like", "Name contains…"],
  ["missing_summary", "Files missing a summary"],
  ["since_last_run", "Added since last run"],
  ["run_input", "The file this runs on"],
];
export const CONDITION_OPS = [
  ["not_empty", "Input is not empty"],
  ["is_empty", "Input is empty"],
  ["contains", "Input contains…"],
  ["not_contains", "Input does not contain…"],
  ["new_files_since_last_run", "New files since last run"],
];
export const TRANSFORM_OPS = [
  ["trim", "Trim whitespace"],
  ["upper", "UPPERCASE"],
  ["lower", "lowercase"],
  ["append", "Append text…"],
  ["prepend", "Prepend text…"],
  ["replace", "Find & replace…"],
  ["truncate", "Truncate to N chars…"],
  ["strip_html", "Strip HTML tags"],
];
function csv(value: unknown): string {
  return Array.isArray(value) ? (value as string[]).join(", ") : "";
}
function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function CsvField({
  value,
  placeholder,
  onChange,
}: {
  value: unknown;
  placeholder: string;
  onChange: (parts: string[]) => void;
}) {
  const [raw, setRaw] = useState(() => csv(value));
  const change = (next: string) => {
    setRaw(next);
    onChange(parseCsv(next));
  };
  return (
    <input
      type="text"
      placeholder={placeholder}
      value={raw}
      onChange={(event) => change(event.target.value)}
    />
  );
}

export function PromptField({
  node,
  set,
  label = "Prompt",
  hint = "{{input}} {{files}} {{date}}",
}: FormProps & { label?: string; hint?: string }) {
  return (
    <label>
      {label} <span className="wf-field-hint">({hint})</span>
      <textarea
        value={String(node.prompt ?? "")}
        onChange={(event) => set("prompt", event.target.value)}
      />
    </label>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const clamp = (raw: string) =>
    Math.max(min, Math.min(max, Number(raw) || min));
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(clamp(event.target.value))}
      />
    </label>
  );
}

export function Segmented({
  value,
  options,
  onChange,
  role,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
  role?: "radio";
}) {
  return (
    <div className="wf-seg">
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          role={role}
          aria-pressed={role ? undefined : value === option}
          aria-checked={role ? value === option : undefined}
          className={value === option ? "active" : ""}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
