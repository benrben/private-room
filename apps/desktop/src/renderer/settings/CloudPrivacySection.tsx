import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { CircleCheckIcon } from "../icons";
import type {
  PrivacyEntity,
  PrivacyScanProgress,
  PrivacyStatus,
} from "../apiTypes";
import {
  privacyConceptLines,
  scanIsRunning,
  stopEscape,
  type PrivacyActions,
  type PrivacyPanelState,
} from "./cloudPrivacyState";

function WorkspaceRoomNotice({ workspaceRoom }: { workspaceRoom: boolean }) {
  if (!workspaceRoom) return null;
  return (
    <p className="set-note set-note--flag nb-sem-pending">
      The room password encrypts Arcelle's private state: chats, memory,
      search, agent history, and recovery versions. Current files in the
      workspace folder are normal files and remain readable in Finder,
      including while the room is locked.
    </p>
  );
}

function PrivacyDoor({
  effectiveOn,
  onToggle,
}: {
  effectiveOn: boolean;
  onToggle: () => void;
}) {
  const description = effectiveOn
    ? "On for this room — protected details never reach a cloud model."
    : "OFF — cloud models can see everything in this room.";
  return (
    <div className="settings-toggle-row set-consequence" data-agent-blocked="true">
      <label className="switch">
        <input type="checkbox" checked={effectiveOn} onChange={onToggle} />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
      </label>
      <span>{description}</span>
    </div>
  );
}

function RoomOverrideNotice({
  roomSetting,
  globalDefaultOn,
  onFollowDefault,
}: {
  roomSetting: string | null;
  globalDefaultOn: boolean;
  onFollowDefault: () => void;
}) {
  if (!roomSetting) return null;
  const defaultState = globalDefaultOn ? " (currently on)." : " (currently off).";
  return (
    <p className="settings-hint cpv-inline-hint">
      This room has its own choice.{" "}
      <button type="button" className="linkish" onClick={onFollowDefault}>
        Follow the app default instead
      </button>
      {defaultState}
    </p>
  );
}

function PrivacyDoorWarning({ effectiveOn }: { effectiveOn: boolean }) {
  if (effectiveOn) return null;
  return (
    <p className="cpv-off-warning set-note set-note--flag set-note--lead nb-sem-urgent">
      <span className="nb-tape set-note-tag">The door is open</span>:
      questions, documents and tool results go to cloud models with real
      names and details. Your stored blackouts are kept and enforcement
      resumes the moment you switch back on.
    </p>
  );
}

function MaskedConnectorNotice({
  effectiveOn,
  connectorArgsMasked,
}: {
  effectiveOn: boolean;
  connectorArgsMasked: boolean;
}) {
  if (effectiveOn || !connectorArgsMasked) return null;
  return (
    <p className="cpv-seam-note set-note set-note--flag nb-sem-pending">
      One exception, and this switch does not control it: a <b>remote connector</b>{" "}
      is still sent placeholders instead of the items below, even with the
      door open. If a connector lookup comes back empty or off-target, check
      that first — it is Connectors → “Send remote connectors real values”
      that decides it.
    </p>
  );
}

function UnmaskedConnectorNotice({
  effectiveOn,
  connectorArgsMasked,
  entityCount,
}: {
  effectiveOn: boolean;
  connectorArgsMasked: boolean;
  entityCount: number;
}) {
  if (connectorArgsMasked || entityCount === 0) return null;
  const prefix = effectiveOn ? "Even with the door shut, one" : "One";
  return (
    <p className="cpv-seam-note set-note set-note--flag nb-sem-pending">
      {prefix} seam sends real values: a <b>remote connector</b> receives the
      items below as themselves, because Connectors → “Send remote connectors
      real values” is on. The switch above does not govern that seam either
      way.
    </p>
  );
}

function ConnectorNotices({
  status,
  effectiveOn,
}: {
  status: PrivacyStatus | null;
  effectiveOn: boolean;
}) {
  if (!status) return null;
  return (
    <>
      <MaskedConnectorNotice
        effectiveOn={effectiveOn}
        connectorArgsMasked={status.connectorArgsMasked}
      />
      <UnmaskedConnectorNotice
        effectiveOn={effectiveOn}
        connectorArgsMasked={status.connectorArgsMasked}
        entityCount={status.entities.length}
      />
    </>
  );
}

function GlobalDefaultToggle({
  status,
  onToggle,
}: {
  status: PrivacyStatus | null;
  onToggle: () => void;
}) {
  const globalDefaultOn = status?.globalDefaultOn ?? true;
  const roomDescription = status?.roomSetting
    ? " (this room has its own choice above)"
    : " (this room follows it)";
  return (
    <div className="settings-toggle-row" data-agent-blocked="true">
      <label className="switch">
        <input type="checkbox" checked={globalDefaultOn} onChange={onToggle} />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
      </label>
      <span className="settings-hint cpv-inline-hint">
        Default for rooms without their own choice{roomDescription}
      </span>
    </div>
  );
}

function PrivacyPolicyControls({
  status,
  effectiveOn,
  actions,
}: {
  status: PrivacyStatus | null;
  effectiveOn: boolean;
  actions: Pick<PrivacyActions, "toggleRoom" | "followDefault" | "toggleGlobal">;
}) {
  return (
    <>
      <label className="settings-label">Hide private details from cloud AI</label>
      <PrivacyDoor effectiveOn={effectiveOn} onToggle={actions.toggleRoom} />
      <RoomOverrideNotice
        roomSetting={status?.roomSetting ?? null}
        globalDefaultOn={status?.globalDefaultOn ?? true}
        onFollowDefault={actions.followDefault}
      />
      <PrivacyDoorWarning effectiveOn={effectiveOn} />
      <ConnectorNotices status={status} effectiveOn={effectiveOn} />
      <GlobalDefaultToggle status={status} onToggle={actions.toggleGlobal} />
    </>
  );
}

function PrivacyEntityList({
  entities,
  onRemove,
}: {
  entities: PrivacyEntity[];
  onRemove: (id: string) => void;
}) {
  if (entities.length === 0) return null;
  return (
    <ul className="cpv-list">
      {entities.map((entity) => {
        const sourceClass = entity.source === "user" ? "user" : "scan";
        const sourceText = entity.source === "user" ? "guaranteed" : "found by scan";
        const title = entity.source === "user"
          ? "Remove from the block list"
          : "Not private — stop hiding this";
        return (
          <li key={entity.id} className="cpv-item">
            <span className="cpv-real">{entity.realText}</span>
            <span className="cpv-arrow" aria-hidden="true">→</span>
            <span className="cpv-placeholder">{entity.placeholder}</span>
            <span className={`cpv-source ${sourceClass}`}>{sourceText}</span>
            <button
              type="button"
              className="cpv-remove"
              title={title}
              data-agent-blocked="true"
              onClick={() => onRemove(entity.id)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function BlockListControls({
  entities,
  newItem,
  newCat,
  actions,
}: {
  entities: PrivacyEntity[];
  newItem: string;
  newCat: string;
  actions: Pick<
    PrivacyActions,
    "addItem" | "removeItem" | "updateNewItem" | "updateCategory"
  >;
}) {
  const addOnEnter = (key: string) => {
    if (key === "Enter") actions.addItem();
  };
  return (
    <>
      <label className="settings-label">Never share these</label>
      <p className="settings-hint">
        Exact words you add here are blocked mechanically on every request —
        guaranteed, no AI judgment involved.
      </p>
      <div className="cpv-add-row">
        <input
          placeholder="e.g. a name, address, phone number…"
          value={newItem}
          onChange={(event) => actions.updateNewItem(event.target.value)}
          onKeyDown={(event) => addOnEnter(event.key)}
        />
        <select
          className="cpv-cat"
          value={newCat}
          onChange={(event) => actions.updateCategory(event.target.value)}
        >
          <option value="person">Person</option>
          <option value="address">Address</option>
          <option value="phone">Phone</option>
          <option value="email">Email</option>
          <option value="id">ID number</option>
          <option value="org">Organization</option>
          <option value="concept">Other</option>
        </select>
        <button type="button" className="primary" onClick={actions.addItem}>
          Add
        </button>
      </div>
      <PrivacyEntityList entities={entities} onRemove={actions.removeItem} />
    </>
  );
}

function PrivateTopicsControls({
  conceptDraft,
  conceptsErr,
  conceptsSaved,
  actions,
}: {
  conceptDraft: string;
  conceptsErr: string | null;
  conceptsSaved: boolean;
  actions: Pick<PrivacyActions, "updateConceptDraft" | "saveConcepts">;
}) {
  return (
    <>
      <label className="settings-label">Private topics</label>
      <p className="settings-hint">
        One per line, in your own words (“my health”, “my kids”). A local model
        looks for these while scanning — best effort, not a guarantee. Exact
        items above are the stronger protection.
      </p>
      <textarea
        className="cpv-concepts"
        rows={3}
        value={conceptDraft}
        onChange={(event) => actions.updateConceptDraft(event.target.value)}
        onKeyDown={stopEscape}
        onBlur={actions.saveConcepts}
        placeholder={"my health\nmy family"}
      />
      {conceptsErr && (
        <div className="gate-error" role="alert">
          These topics were not saved: {conceptsErr}
        </div>
      )}
      {conceptsSaved && (
        <div className="settings-actions">
          <span className="settings-confirm btn-ic" role="status">
            <CircleCheckIcon size={14} /> Saved
          </span>
        </div>
      )}
    </>
  );
}

function ActiveScanProgress({ scan }: { scan: PrivacyScanProgress }) {
  const progress = scan.total > 0
    ? `Scanning ${Math.min(scan.done + 1, scan.total)} of ${scan.total}`
    : "Starting the scan";
  const label = scan.label ? ` — ${scan.label}` : "";
  return <span className="settings-hint">{progress}{label}…</span>;
}

function PendingScanProgress({ pendingFiles }: { pendingFiles: number }) {
  const plural = pendingFiles === 1 ? "" : "s";
  return (
    <span className="settings-hint">
      {pendingFiles} file{plural} awaiting scan.
    </span>
  );
}

function ScanProgress({
  scan,
  status,
}: {
  scan: PrivacyScanProgress | null;
  status: PrivacyStatus | null;
}) {
  if (scan?.running === true) return <ActiveScanProgress scan={scan} />;
  if (status?.pendingFiles && status.pendingFiles > 0) {
    return <PendingScanProgress pendingFiles={status.pendingFiles} />;
  }
  return <span className="settings-hint">All files scanned.</span>;
}

function ScanError({ scan }: { scan: PrivacyScanProgress | null }) {
  if (!scan?.error) return null;
  return <div className="gate-error">{scan.error}</div>;
}

function DocumentScanControls({
  scan,
  status,
  onStart,
}: {
  scan: PrivacyScanProgress | null;
  status: PrivacyStatus | null;
  onStart: () => void;
}) {
  return (
    <>
      <label className="settings-label">Document scan</label>
      <p className="settings-hint">
        A local model reads each imported file once and marks private details.
        Open any file’s “Cloud view” to see exactly what a cloud model would
        receive.
      </p>
      <div className="cpv-scan-row">
        <ScanProgress scan={scan} status={status} />
        <button
          type="button"
          className="subtle"
          disabled={scanIsRunning(scan, status)}
          onClick={onStart}
        >
          Scan now
        </button>
      </div>
      <ScanError scan={scan} />
    </>
  );
}

function useCloudPrivacyPanel(): [PrivacyPanelState, PrivacyActions] {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [scan, setScan] = useState<PrivacyScanProgress | null>(null);
  const [newItem, setNewItem] = useState("");
  const [newCat, setNewCat] = useState("person");
  const [conceptDraft, setConceptDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [conceptsSaved, setConceptsSaved] = useState(false);
  const [conceptsErr, setConceptsErr] = useState<string | null>(null);
  const [workspaceRoom, setWorkspaceRoom] = useState(false);
  const conceptsDirty = useRef(false);
  const conceptEdits = useRef(0);

  const reload = useCallback(() => {
    api
      .privacyStatus()
      .then((nextStatus) => {
        setStatus(nextStatus);
        if (!conceptsDirty.current) setConceptDraft(nextStatus.concepts.join("\n"));
      })
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    api.roomStorageUsage().then((usage) => setWorkspaceRoom(usage.kind === "workspace")).catch(() => {});
    reload();
    let unlisten: (() => void) | undefined;
    api.onPrivacyScan((progress) => {
      setScan(progress);
      if (!progress.running) reload();
    }).then((unsubscribe) => (unlisten = unsubscribe));
    return () => unlisten?.();
  }, [reload]);

  const toggleRoom = async () => {
    if (!status) return;
    try {
      await api.setPrivacyRoom(status.effectiveOn ? "off" : "on");
      setErr(null);
      reload();
    } catch (error) {
      setErr(String(error));
    }
  };

  const followDefault = async () => {
    if (!status) return;
    try {
      await api.setPrivacyRoom("default");
      setErr(null);
      reload();
    } catch (error) {
      setErr(String(error));
    }
  };

  const toggleGlobal = async () => {
    if (!status) return;
    try {
      await api.setPrivacyGlobal(!status.globalDefaultOn);
      setErr(null);
      reload();
    } catch (error) {
      setErr(String(error));
    }
  };

  const addItem = async () => {
    const text = newItem.trim();
    if (!text) return;
    try {
      await api.addPrivacyBlock(text, newCat);
      setNewItem("");
      setErr(null);
      reload();
    } catch (error) {
      setErr(String(error));
    }
  };

  const removeItem = async (id: string) => {
    try {
      await api.removePrivacyEntity(id);
      reload();
    } catch (error) {
      setErr(String(error));
    }
  };

  const updateConceptDraft = (value: string) => {
    conceptsDirty.current = true;
    conceptEdits.current += 1;
    setConceptDraft(value);
  };

  const saveConcepts = async () => {
    const concepts = privacyConceptLines(conceptDraft);
    const editsAtSave = conceptEdits.current;
    const wasEdited = conceptsDirty.current;
    try {
      await api.setPrivacyConcepts(concepts);
      const stillCurrent = conceptEdits.current === editsAtSave;
      if (stillCurrent) conceptsDirty.current = false;
      setErr(null);
      setConceptsErr(null);
      if (wasEdited && stillCurrent) {
        setConceptsSaved(true);
        window.setTimeout(() => setConceptsSaved(false), 1600);
      }
      reload();
    } catch (error) {
      setConceptsErr(String(error));
    }
  };

  const startScan = () => {
    setScan({ running: true, done: 0, total: 0 });
    api.startPrivacyScan().catch((error) => {
      setScan(null);
      setErr(String(error));
    });
  };

  return [
    {
      status,
      scan,
      newItem,
      newCat,
      conceptDraft,
      err,
      conceptsSaved,
      conceptsErr,
      workspaceRoom,
      effectiveOn: status?.effectiveOn ?? true,
    },
    {
      toggleRoom,
      followDefault,
      toggleGlobal,
      addItem,
      removeItem,
      updateNewItem: setNewItem,
      updateCategory: setNewCat,
      updateConceptDraft,
      saveConcepts,
      startScan,
    },
  ];
}

/** PRIV-1 — the cloud-privacy gatekeeper's controls. */
export default function CloudPrivacySection() {
  const [state, actions] = useCloudPrivacyPanel();
  return (
    <section id="set-cloud-privacy">
      <h3>Cloud privacy</h3>
      <p className="settings-hint">
        When a question goes to a cloud model, private details are replaced
        with neutral tags like “[Person A]” before anything leaves this Mac —
        and put back in the answer you read. Local models never need this.
      </p>
      <WorkspaceRoomNotice workspaceRoom={state.workspaceRoom} />
      <PrivacyPolicyControls
        status={state.status}
        effectiveOn={state.effectiveOn}
        actions={actions}
      />
      <BlockListControls
        entities={state.status?.entities ?? []}
        newItem={state.newItem}
        newCat={state.newCat}
        actions={actions}
      />
      <PrivateTopicsControls
        conceptDraft={state.conceptDraft}
        conceptsErr={state.conceptsErr}
        conceptsSaved={state.conceptsSaved}
        actions={actions}
      />
      <DocumentScanControls
        scan={state.scan}
        status={state.status}
        onStart={actions.startScan}
      />
      <p className="cpv-honesty set-note">
        Honest limits: hiding names can’t stop every inference from remaining
        context, and anything already sent to a cloud can’t be recalled.
        Images never go to cloud models while the door is on.
      </p>
      {state.err && <div className="gate-error">{state.err}</div>}
    </section>
  );
}
