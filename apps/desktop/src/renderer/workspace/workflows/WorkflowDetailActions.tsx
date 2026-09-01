import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { confirm } from "../../platform";
import type { Schedule, ScheduleArg, Workflow, WorkflowNode } from "../../api";
import { SchedulePopover } from "./SchedulePopover";
import { WorkflowGlyph, WORKFLOW_ICON_CHOICES } from "./workflowGlyph";
import { PlayIcon, PinIcon, CalendarClockIcon } from "../../icons";
import { activeButtonTitle, humanizeError, pinButtonLabel, pinButtonTitle, runButtonLabel, runButtonTitle } from "./workflowDetailModel";

type IconPickerProps = {
  emoji: string;
  onChange: (emoji: string) => void;
};

function WorkflowIconPicker({ emoji, onChange }: IconPickerProps) {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <div className="wf-icon-pick">
      <button
        type="button"
        className="wf-icon-btn"
        aria-haspopup="menu"
        aria-expanded={showPicker}
        title="Choose an icon"
        aria-label="Choose an icon for this workflow"
        onClick={() => setShowPicker((visible) => !visible)}
      >
        <WorkflowGlyph emoji={emoji} size={16} />
      </button>
      {showPicker && (
        <>
          <div
            className="menu-backdrop"
            onMouseDown={() => setShowPicker(false)}
          />
          <div className="wf-icon-grid" role="menu" aria-label="Workflow icon">
            {WORKFLOW_ICON_CHOICES.map((choice) => (
              <button
                key={choice.key}
                type="button"
                role="menuitemradio"
                aria-checked={emoji === choice.key}
                className={`wf-icon-choice${emoji === choice.key ? " active" : ""}`}
                title={choice.label}
                aria-label={choice.label}
                onClick={() => {
                  onChange(choice.key);
                  setShowPicker(false);
                }}
              >
                <WorkflowGlyph emoji={choice.key} size={16} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type RunButtonProps = {
  isDraft: boolean;
  runBlocked: string | null;
  onRun: () => void;
};

function WorkflowRunButton({ isDraft, runBlocked, onRun }: RunButtonProps) {
  const disabled = runBlocked !== null;
  return (
    <button
      className="subtle btn-ic"
      disabled={disabled}
      aria-disabled={disabled}
      title={runButtonTitle(runBlocked, isDraft)}
      onClick={() => void onRun()}
    >
      <PlayIcon size={12} /> {runButtonLabel(isDraft)}
    </button>
  );
}

type StatusButtonsProps = {
  checking: boolean;
  errors: string[];
  isActive: boolean;
  valid: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
};

function WorkflowStatusButtons({
  checking,
  errors,
  isActive,
  valid,
  onActivate,
  onDeactivate,
}: StatusButtonsProps) {
  if (isActive) {
    return (
      <button className="subtle" onClick={() => void onDeactivate()}>
        Deactivate
      </button>
    );
  }
  return (
    <button
      className="primary"
      disabled={!valid}
      aria-disabled={!valid}
      title={activeButtonTitle(checking, errors)}
      onClick={() => void onActivate()}
    >
      Activate
    </button>
  );
}

function WorkflowSaveButton({
  dirty,
  valid,
  onSave,
}: {
  dirty: boolean;
  valid: boolean;
  onSave: () => void;
}) {
  return (
    <button
      className="subtle"
      disabled={!dirty || !valid}
      onClick={() => void onSave()}
    >
      Save
    </button>
  );
}

function WorkflowPinButton({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`subtle btn-ic${pinned ? " active" : ""}`}
      title={pinButtonTitle(pinned)}
      onClick={() => void onToggle()}
    >
      <PinIcon size={12} /> {pinButtonLabel(pinned)}
    </button>
  );
}

type ScheduleControlProps = {
  disabled: boolean;
  onSave: (schedule: ScheduleArg) => void;
  schedule: Schedule | null;
};

function scheduleAnchorOf(
  button: HTMLButtonElement | null,
): { top: number; right: number } | null {
  const rect = button?.getBoundingClientRect();
  return rect
    ? { top: rect.bottom + 6, right: window.innerWidth - rect.right }
    : null;
}

function SchedulePortal({
  anchor,
  disabled,
  onClose,
  onSave,
  schedule,
  show,
}: ScheduleControlProps & {
  anchor: { top: number; right: number } | null;
  onClose: () => void;
  show: boolean;
}) {
  if (!show) return null;
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: anchor?.top ?? 90,
        right: Math.max(anchor?.right ?? 16, 8),
        zIndex: 1000,
      }}
    >
      <SchedulePopover
        schedule={schedule}
        disabled={disabled}
        onClose={onClose}
        onSave={onSave}
      />
    </div>,
    document.body,
  );
}

function WorkflowScheduleControl({
  disabled,
  onSave,
  schedule,
}: ScheduleControlProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );
  const [show, setShow] = useState(false);
  return (
    <>
      <button
        ref={buttonRef}
        className="subtle btn-ic"
        onClick={() => {
          setAnchor(scheduleAnchorOf(buttonRef.current));
          setShow((visible) => !visible);
        }}
      >
        <CalendarClockIcon size={12} /> Schedule
      </button>
      <SchedulePortal
        anchor={anchor}
        disabled={disabled}
        onClose={() => setShow(false)}
        onSave={onSave}
        schedule={schedule}
        show={show}
      />
    </>
  );
}

function WorkflowDeleteButton({
  name,
  onDelete,
}: {
  name: string;
  onDelete: () => Promise<void>;
}) {
  async function confirmDelete() {
    const ok = await confirm(
      `Delete the workflow “${name}”? This can't be undone.`,
      {
        title: "Delete workflow",
        kind: "warning",
      },
    );
    if (ok) await onDelete();
  }
  return (
    <button
      className="subtle danger"
      data-agent-blocked
      onClick={() => void confirmDelete()}
    >
      Delete
    </button>
  );
}

type WorkflowActionBarProps = {
  checking: boolean;
  dirty: boolean;
  errors: string[];
  fileScoped: boolean;
  isDraft: boolean;
  pinned: boolean;
  runBlocked: string | null;
  schedule: Schedule | null;
  valid: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onDelete: () => Promise<void>;
  onPinToggle: () => void;
  onRun: () => void;
  onSave: () => void;
  onScheduleSave: (schedule: ScheduleArg) => void;
  workflowName: string;
};

function WorkflowActionBar(props: WorkflowActionBarProps) {
  return (
    <span className="viewer-actions wf-detail-actions">
      <WorkflowRunButton
        isDraft={props.isDraft}
        runBlocked={props.runBlocked}
        onRun={props.onRun}
      />
      <WorkflowStatusButtons
        checking={props.checking}
        errors={props.errors}
        isActive={!props.isDraft}
        valid={props.valid}
        onActivate={props.onActivate}
        onDeactivate={props.onDeactivate}
      />
      <WorkflowSaveButton
        dirty={props.dirty}
        valid={props.valid}
        onSave={props.onSave}
      />
      {!props.fileScoped && (
        <WorkflowPinButton pinned={props.pinned} onToggle={props.onPinToggle} />
      )}
      <WorkflowScheduleControl
        disabled={props.fileScoped}
        onSave={props.onScheduleSave}
        schedule={props.schedule}
      />
      <WorkflowDeleteButton
        name={props.workflowName}
        onDelete={props.onDelete}
      />
    </span>
  );
}

type HeaderProps = {
  actions: WorkflowActionBarProps;
  emoji: string;
  name: string;
  onBack: () => void;
  onEmojiChange: (emoji: string) => void;
  onNameChange: (name: string) => void;
};

export function WorkflowHeader({
  actions,
  emoji,
  name,
  onBack,
  onEmojiChange,
  onNameChange,
}: HeaderProps) {
  return (
    <div className="viewer-head">
      <button className="subtle btn-ic" onClick={() => void onBack()}>
        ← Library
      </button>
      <WorkflowIconPicker emoji={emoji} onChange={onEmojiChange} />
      <input
        className="viewer-title wf-title-input"
        aria-label="Workflow name"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
      />
      <WorkflowActionBar {...actions} />
    </div>
  );
}

export function WorkflowDraftBadge({
  workflow,
  fileScoped,
}: {
  workflow: Workflow;
  fileScoped: boolean;
}) {
  if (workflow.status !== "draft") return null;
  return (
    <div className="wf-badges wf-detail-badges">
      <span className="wf-badge draft">
        {fileScoped
          ? "Draft — activate it to appear in a file's Actions menu"
          : "Draft — you can test-run it now; activate it to run on a schedule"}
      </span>
      {workflow.createdBy === "agent" && (
        <span className="wf-badge agent">Drafted by the agent</span>
      )}
    </div>
  );
}

function WorkflowValidationError({
  error,
  nodes,
  onSelect,
}: {
  error: string;
  nodes: WorkflowNode[];
  onSelect: (nodeId: string) => void;
}) {
  const { text, nodeId } = humanizeError(error, nodes);
  if (nodeId === null) return <>{text}</>;
  return (
    <button
      type="button"
      className="wf-error-link"
      onClick={() => onSelect(nodeId)}
      title="Select this step"
    >
      {text}
    </button>
  );
}

export function WorkflowValidationErrors({
  errors,
  nodes,
  onSelect,
}: {
  errors: string[];
  nodes: WorkflowNode[];
  onSelect: (nodeId: string) => void;
}) {
  if (errors.length === 0) return null;
  return (
    <div className="wf-errors">
      Fix these before activating:
      <ul>
        {errors.map((error, index) => (
          <li key={index}>
            <WorkflowValidationError
              error={error}
              nodes={nodes}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
