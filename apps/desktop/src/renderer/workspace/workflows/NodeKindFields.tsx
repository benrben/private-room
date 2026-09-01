import type { ComponentType } from "react";
import { CONDITION_OPS, CsvField, FILE_SELECTORS, type FormProps, NumberField, PromptField, Segmented, TRANSFORM_OPS } from "./NodeParamControls";

export const MODEL_KINDS = new Set([
  "generate",
  "for_each_file",
  "extract",
  "route",
  "vote",
  "refine",
  "plan_and_map",
]);

function FileSelectionFields({ node, set }: FormProps) {
  const selection =
    (node.select as { type?: string; pattern?: string } | undefined) ?? {};
  const patch = (next: Record<string, unknown>) =>
    set("select", {
      type: selection.type ?? "newest",
      pattern: selection.pattern,
      ...next,
    });
  return (
    <>
      <label>
        Which file(s)
        <select
          value={selection.type ?? "newest"}
          onChange={(event) => patch({ type: event.target.value })}
        >
          {FILE_SELECTORS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {selection.type === "name_like" && (
        <label>
          Name pattern
          <input
            type="text"
            value={String(selection.pattern ?? "")}
            onChange={(event) => patch({ pattern: event.target.value })}
          />
        </label>
      )}
    </>
  );
}

function GenerateFields(props: FormProps) {
  return <PromptField {...props} />;
}
function SummarizeFields(props: FormProps) {
  return <FileSelectionFields {...props} />;
}
function ForEachFields(props: FormProps) {
  return (
    <>
      <FileSelectionFields {...props} />
      <label>
        Instruction <span className="wf-field-hint">(run on EACH file)</span>
        <textarea
          value={String(props.node.instruction ?? "")}
          onChange={(event) => props.set("instruction", event.target.value)}
        />
      </label>
    </>
  );
}
function AgentFields({ node, set }: FormProps) {
  return (
    <label>
      Question for the agent
      <textarea
        value={String(node.question ?? "")}
        onChange={(event) => set("question", event.target.value)}
      />
    </label>
  );
}

function FilePassFields({ node, set }: FormProps) {
  return (
    <>
      <FileSelectionFields node={node} set={set} />
      <label>
        Instruction
        <textarea
          value={String(node.instruction ?? "")}
          onChange={(event) => set("instruction", event.target.value)}
        />
      </label>
      <label>
        Mode
        <Segmented
          value={String(node.mode ?? "merge")}
          options={[
            ["merge", "merge"],
            ["stitch", "stitch"],
          ]}
          onChange={(value) => set("mode", value)}
        />
      </label>
    </>
  );
}
function ExtractFields({ node, set }: FormProps) {
  return (
    <label>
      Fields to pull out{" "}
      <span className="wf-field-hint">(comma-separated)</span>
      <CsvField
        key={`${node.id}:fields`}
        value={node.fields}
        placeholder="title, author, date"
        onChange={(value) => set("fields", value)}
      />
    </label>
  );
}
function RouteFields({ node, set }: FormProps) {
  return (
    <>
      <PromptField
        node={node}
        set={set}
        label="Question"
        hint="how to classify {{input}}"
      />
      <label>
        Labels{" "}
        <span className="wf-field-hint">
          (comma-separated — each becomes a branch)
        </span>
        <CsvField
          key={`${node.id}:labels`}
          value={node.labels}
          placeholder="urgent, normal, ignore"
          onChange={(value) => set("labels", value)}
        />
      </label>
    </>
  );
}
function VoteFields({ node, set }: FormProps) {
  return (
    <>
      <PromptField node={node} set={set} hint="{{input}}" />
      <NumberField
        label="Samples"
        value={Number(node.samples ?? 3)}
        min={1}
        max={7}
        onChange={(value) => set("samples", value)}
      />
      <label>
        Combine
        <Segmented
          value={String(node.mode ?? "concat")}
          options={[
            ["concat", "All samples"],
            ["majority", "Majority"],
          ]}
          onChange={(value) => set("mode", value)}
        />
      </label>
    </>
  );
}
function RefineFields({ node, set }: FormProps) {
  return (
    <>
      <PromptField node={node} set={set} hint="{{input}} {{files}}" />
      <label>
        Quality bar{" "}
        <span className="wf-field-hint">(what a good result must be)</span>
        <textarea
          value={String(node.rubric ?? "")}
          onChange={(event) => set("rubric", event.target.value)}
        />
      </label>
      <NumberField
        label="Max rounds"
        value={Number(node.max_rounds ?? 2)}
        min={1}
        max={4}
        onChange={(value) => set("max_rounds", value)}
      />
    </>
  );
}
function PlanFields({ node, set }: FormProps) {
  return (
    <>
      <label>
        Objective{" "}
        <span className="wf-field-hint">({"{{input}} {{files}}"})</span>
        <textarea
          value={String(node.objective ?? "")}
          onChange={(event) => set("objective", event.target.value)}
        />
      </label>
      <NumberField
        label="Max subtasks"
        value={Number(node.max_workers ?? 4)}
        min={1}
        max={8}
        onChange={(value) => set("max_workers", value)}
      />
    </>
  );
}

function transformNeedsValue(operation: string): boolean {
  return ["replace", "append", "prepend", "truncate"].includes(operation);
}
function transformValueLabel(operation: string): string {
  if (operation === "truncate") return "Character count";
  return operation === "replace" ? "Replace with" : "Text";
}
function TransformFind({
  node,
  set,
  operation,
}: FormProps & { operation: string }) {
  if (operation !== "replace") return null;
  return (
    <label>
      Find
      <input
        type="text"
        value={String(node.find ?? "")}
        onChange={(event) => set("find", event.target.value)}
      />
    </label>
  );
}
function TransformValue({
  node,
  set,
  operation,
}: FormProps & { operation: string }) {
  if (!transformNeedsValue(operation)) return null;
  return (
    <label>
      {transformValueLabel(operation)}
      <input
        type="text"
        value={String(node.value ?? "")}
        onChange={(event) => set("value", event.target.value)}
      />
    </label>
  );
}
function TransformFields({ node, set }: FormProps) {
  const operation = String(node.op ?? "trim");
  return (
    <>
      <label>
        Operation
        <select
          value={operation}
          onChange={(event) => set("op", event.target.value)}
        >
          {TRANSFORM_OPS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <TransformFind node={node} set={set} operation={operation} />
      <TransformValue node={node} set={set} operation={operation} />
    </>
  );
}
function MergeFields({ node, set }: FormProps) {
  return (
    <label>
      How to combine branches
      <select
        value={String(node.mode ?? "concat")}
        onChange={(event) => set("mode", event.target.value)}
      >
        <option value="concat">Concatenate</option>
        <option value="numbered">Numbered list</option>
        <option value="dedupe_lines">Dedupe lines</option>
      </select>
    </label>
  );
}
function FetchFields({ node, set }: FormProps) {
  return (
    <label>
      URL <span className="wf-field-hint">({"{{input}} {{date}}"})</span>
      <input
        type="text"
        placeholder="https://…"
        value={String(node.url ?? "")}
        onChange={(event) => set("url", event.target.value)}
      />
    </label>
  );
}

function scriptFiles(files: { id: string; name: string }[] | undefined) {
  return (files ?? []).filter((file) => /\.(py|js)$/i.test(file.name));
}
function missingScript(
  current: string,
  scripts: { id: string; name: string }[],
) {
  if (!current) return false;
  return !scripts.some((file) => file.id === current || file.name === current);
}
function MissingScriptOption({
  current,
  scripts,
}: {
  current: string;
  scripts: { id: string; name: string }[];
}) {
  if (!missingScript(current, scripts)) return null;
  return <option value={current}>{current} (not in this room)</option>;
}
function ScriptFileField({
  node,
  set,
  files,
}: FormProps & { files?: { id: string; name: string }[] }) {
  const scripts = scriptFiles(files);
  const current = String(node.file ?? "");
  if (scripts.length === 0)
    return (
      <input
        type="text"
        placeholder="script.py"
        value={current}
        onChange={(event) => set("file", event.target.value)}
      />
    );
  return (
    <select
      value={current}
      onChange={(event) => set("file", event.target.value)}
    >
      <option value="">Choose a .py / .js file…</option>
      <MissingScriptOption current={current} scripts={scripts} />
      {scripts.map((file) => (
        <option key={file.id} value={file.name}>
          {file.name}
        </option>
      ))}
    </select>
  );
}
function ScriptFields({
  node,
  set,
  files,
}: FormProps & { files?: { id: string; name: string }[] }) {
  const mode = String(node.mode ?? "import");
  return (
    <>
      <label>
        Script
        <ScriptFileField node={node} set={set} files={files} />
      </label>
      <div className="field" role="radiogroup" aria-label="Script mode">
        <span className="field-head">Mode</span>
        <Segmented
          value={mode}
          role="radio"
          options={[
            ["import", "Import files"],
            ["transform", "Pipe (in→out)"],
          ]}
          onChange={(value) => set("mode", value)}
        />
      </div>
      <div className="caption">
        {mode === "transform"
          ? "Pipe mode: the upstream {{input}} is sent to the script's stdin, and its stdout becomes this step's output. Any files the script writes are still imported into the room."
          : "Import mode: the script runs and its output files are imported back into the room; this step's result is the run report (exit code, stdout/stderr)."}
      </div>
    </>
  );
}
function SaveFields({ node, set }: FormProps) {
  return (
    <>
      <label>
        File name <span className="wf-field-hint">({"{{date}}"})</span>
        <input
          type="text"
          value={String(node.name_template ?? "")}
          onChange={(event) => set("name_template", event.target.value)}
        />
      </label>
      <label>
        Format
        <Segmented
          value={String(node.format ?? "html")}
          options={[
            ["html", "html"],
            ["md", "md"],
          ]}
          onChange={(value) => set("format", value)}
        />
      </label>
      <label>
        When it exists
        <select
          value={String(node.mode ?? "create")}
          onChange={(event) => set("mode", event.target.value)}
        >
          <option value="create">Create a new file</option>
          <option value="overwrite">Overwrite</option>
          <option value="append">Append</option>
        </select>
      </label>
    </>
  );
}
function ConditionFields({ node, set }: FormProps) {
  const operation = String(node.op ?? "not_empty");
  const needsText = operation === "contains" || operation === "not_contains";
  return (
    <>
      <label>
        Condition
        <select
          value={operation}
          onChange={(event) => set("op", event.target.value)}
        >
          {CONDITION_OPS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {needsText && (
        <label>
          Text
          <input
            type="text"
            value={String(node.value ?? "")}
            onChange={(event) => set("value", event.target.value)}
          />
        </label>
      )}
    </>
  );
}

const KIND_FORMS: Record<string, ComponentType<FormProps>> = {
  generate: GenerateFields,
  summarize_file: SummarizeFields,
  file_pass: FilePassFields,
  for_each_file: ForEachFields,
  agent_run: AgentFields,
  extract: ExtractFields,
  route: RouteFields,
  vote: VoteFields,
  refine: RefineFields,
  plan_and_map: PlanFields,
  transform: TransformFields,
  merge: MergeFields,
  http_fetch: FetchFields,
  save_file: SaveFields,
  condition: ConditionFields,
};
export function NodeKindFields({
  node,
  set,
  files,
}: FormProps & { files?: { id: string; name: string }[] }) {
  if (node.kind === "script_run")
    return <ScriptFields node={node} set={set} files={files} />;
  const Form = KIND_FORMS[node.kind];
  return Form ? <Form node={node} set={set} /> : null;
}
export function ModelPicker({ node, set }: FormProps) {
  return (
    <label>
      Model
      <Segmented
        value={String(node.model ?? "auto")}
        options={[
          ["auto", "Auto"],
          ["local", "Local"],
          ["cloud", "Cloud"],
        ]}
        onChange={(value) => set("model", value)}
      />
    </label>
  );
}
