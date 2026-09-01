import type { RefObject } from "react";
import type { Workflow, WorkflowBinding, WorkflowDef, WorkflowEdge, WorkflowNode, WorkflowNodeEvent, WorkflowRun } from "../../api";
import type { WSState } from "../state";
import { PipelineCanvas } from "./PipelineCanvas";
import { NodeParamSheet } from "./NodeParamSheet";
import { RunHistory } from "./RunHistory";
import { nodeTitle } from "./kinds";
import { KIND_UNION } from "./workflowDetailModel";
import { WorkflowDraftBadge, WorkflowValidationErrors } from "./WorkflowDetailActions";

type CanvasProps = {
  def: WorkflowDef;
  liveStatus: Record<string, WorkflowNodeEvent> | undefined;
  selected: string | null;
  selectedNode: WorkflowNode | null;
  stepHeadRef: RefObject<HTMLHeadingElement | null>;
  files: WSState["files"];
  onAddBranch: (afterId: string) => void;
  onAddNode: (afterId: string | null) => void;
  onEdgesChange: (edges: WorkflowEdge[]) => void;
  onNodeChange: (node: WorkflowNode) => void;
  onNodeDelete: (nodeId: string) => void;
  onSelect: (nodeId: string | null) => void;
};

function SelectedNodeEditor({
  files,
  node,
  def,
  onEdgesChange,
  onNodeChange,
  onNodeDelete,
  stepHeadRef,
}: Pick<
  CanvasProps,
  | "files"
  | "def"
  | "onEdgesChange"
  | "onNodeChange"
  | "onNodeDelete"
  | "stepHeadRef"
> & { node: WorkflowNode | null }) {
  if (node === null) return null;
  return (
    <>
      <h3 className="wf-sec-head" ref={stepHeadRef}>
        Step: {nodeTitle(node)}
      </h3>
      <NodeParamSheet
        node={node}
        onChange={onNodeChange}
        onDelete={() => onNodeDelete(node.id)}
        edges={def.edges}
        allNodes={def.nodes}
        onEdgesChange={onEdgesChange}
        files={files}
      />
    </>
  );
}

function WorkflowCanvasEditor({
  def,
  liveStatus,
  selected,
  selectedNode,
  files,
  onAddBranch,
  onAddNode,
  onEdgesChange,
  onNodeChange,
  onNodeDelete,
  onSelect,
  stepHeadRef,
}: CanvasProps) {
  return (
    <>
      <PipelineCanvas
        def={def}
        status={liveStatus}
        selectedId={selected}
        onSelect={onSelect}
        onAddAfter={onAddNode}
        onAddBranch={onAddBranch}
        editable
      />
      <SelectedNodeEditor
        def={def}
        files={files}
        node={selectedNode}
        onEdgesChange={onEdgesChange}
        onNodeChange={onNodeChange}
        onNodeDelete={onNodeDelete}
        stepHeadRef={stepHeadRef}
      />
    </>
  );
}

function selectedClass(selected: boolean): string {
  return selected ? "active" : "";
}

function BindingScopeChooser({
  binding,
  onGeneral,
  onFile,
}: {
  binding: WorkflowBinding;
  onGeneral: () => void;
  onFile: () => void;
}) {
  return (
    <label>
      Where it appears
      <div className="wf-seg" role="radiogroup" aria-label="Where it appears">
        <button
          type="button"
          role="radio"
          aria-checked={binding.scope === "general"}
          className={selectedClass(binding.scope === "general")}
          onClick={onGeneral}
        >
          General
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={binding.scope === "file"}
          className={selectedClass(binding.scope === "file")}
          onClick={onFile}
        >
          Specific files
        </button>
      </div>
    </label>
  );
}

function FileKindChips({
  binding,
  onToggle,
}: {
  binding: Extract<WorkflowBinding, { scope: "file" }>;
  onToggle: (kind: string) => void;
}) {
  const kinds = binding.kinds ?? [];
  return (
    <div className="field" role="group" aria-label="File kinds it runs on">
      <span className="field-head">File kinds it runs on</span>
      <div className="wf-chips">
        {KIND_UNION.map((kind) => {
          const selected = kinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={selected}
              className={`nb-chip nb-chip-btn${selected ? " is-on" : ""}`}
              onClick={() => onToggle(kind)}
            >
              {kind}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileBindingExtensions({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      File extensions{" "}
      <span className="wf-field-hint">(comma-separated, e.g. pdf, docx)</span>
      <input
        type="text"
        value={value}
        placeholder="pdf, docx, md"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function FileBindingFileSelect({
  binding,
  files,
  onChange,
}: {
  binding: Extract<WorkflowBinding, { scope: "file" }>;
  files: WSState["files"];
  onChange: (id: string | null) => void;
}) {
  const fileId = binding.file_id;
  const missingFileId =
    fileId && !files.some((file) => file.id === fileId) ? fileId : null;
  return (
    <label>
      Only this specific file{" "}
      <span className="wf-field-hint">(optional — overrides kinds/exts)</span>
      <select
        value={binding.file_id ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Any matching file</option>
        {missingFileId !== null && (
          <option value={missingFileId}>(bound file — not in this room)</option>
        )}
        {files.map((file) => (
          <option key={file.id} value={file.id}>
            {file.name}
          </option>
        ))}
      </select>
    </label>
  );
}

type FileBindingFieldsProps = {
  binding: WorkflowBinding;
  extsText: string;
  files: WSState["files"];
  onExtsChange: (value: string) => void;
  onFileChange: (id: string | null) => void;
  onKindToggle: (kind: string) => void;
};

function FileBindingFields({
  binding,
  extsText,
  files,
  onExtsChange,
  onFileChange,
  onKindToggle,
}: FileBindingFieldsProps) {
  if (binding.scope !== "file") return null;
  return (
    <>
      <FileKindChips binding={binding} onToggle={onKindToggle} />
      <FileBindingExtensions value={extsText} onChange={onExtsChange} />
      <FileBindingFileSelect
        binding={binding}
        files={files}
        onChange={onFileChange}
      />
    </>
  );
}

type BindingEditorProps = FileBindingFieldsProps & {
  onGeneral: () => void;
  onSpecificFiles: () => void;
};

function WorkflowBindingEditor({
  binding,
  onGeneral,
  onSpecificFiles,
  ...fileFields
}: BindingEditorProps) {
  return (
    <>
      <h3 className="wf-sec-head">Where this workflow appears</h3>
      <div className="node-param-sheet">
        <BindingScopeChooser
          binding={binding}
          onGeneral={onGeneral}
          onFile={onSpecificFiles}
        />
        <FileBindingFields binding={binding} {...fileFields} />
      </div>
    </>
  );
}

type DetailBodyProps = CanvasProps &
  FileBindingFieldsProps & {
    errors: string[];
    fileScoped: boolean;
    onGeneral: () => void;
    onSpecificFiles: () => void;
    runs: WorkflowRun[];
    workflow: Workflow;
  };

export function WorkflowDetailBody({
  binding,
  errors,
  fileScoped,
  onGeneral,
  onSelect,
  onSpecificFiles,
  workflow,
  ...props
}: DetailBodyProps) {
  return (
    <div className="wf-body">
      <WorkflowDraftBadge workflow={workflow} fileScoped={fileScoped} />
      <WorkflowValidationErrors
        errors={errors}
        nodes={props.def.nodes}
        onSelect={(nodeId) => onSelect(nodeId)}
      />
      <WorkflowCanvasEditor {...props} onSelect={onSelect} />
      <WorkflowBindingEditor
        binding={binding}
        onGeneral={onGeneral}
        onSpecificFiles={onSpecificFiles}
        {...props}
      />
      <h3 className="wf-sec-head">Run history</h3>
      <RunHistory
        runs={props.runs}
        nodeCount={props.def.nodes.length}
        nodes={props.def.nodes}
      />
    </div>
  );
}
