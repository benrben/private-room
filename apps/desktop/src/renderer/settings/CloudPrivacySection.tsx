import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { CircleCheckIcon } from "../icons";
import type { PrivacyScanProgress, PrivacyStatus } from "../apiTypes";

/** PRIV-1 — the cloud-privacy gatekeeper's controls.
 *
 * The door itself is mechanical and lives in the backend; this section is the
 * user's control room: the switch (room override over a global default), the
 * personal block list (iron-clad exact items), the concept rules (best-effort,
 * interpreted by the local scanner), and the scan status. Consent-grade
 * controls (turning the door OFF, removing protections) carry
 * `data-agent-blocked` so the UI-driving agent can never operate them. */
export default function CloudPrivacySection() {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [scan, setScan] = useState<PrivacyScanProgress | null>(null);
  const [newItem, setNewItem] = useState("");
  const [newCat, setNewCat] = useState("person");
  const [conceptDraft, setConceptDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // The topics box saves on blur, with nothing to press. Both halves of that
  // write are reported where it happened rather than at the foot of the
  // section: on a privacy surface, a write you cannot see land is a question
  // about what the room is protecting, not a convenience.
  const [conceptsSaved, setConceptsSaved] = useState(false);
  const [conceptsErr, setConceptsErr] = useState<string | null>(null);
  const [workspaceRoom, setWorkspaceRoom] = useState(false);
  const conceptsDirty = useRef(false);
  // Counts keystrokes so a save that lands AFTER the user has typed again
  // knows its text is no longer what the box holds, and leaves the flag up.
  const conceptEdits = useRef(0);

  const reload = useCallback(() => {
    api
      .privacyStatus()
      .then((s) => {
        setStatus(s);
        if (!conceptsDirty.current) setConceptDraft(s.concepts.join("\n"));
      })
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    api.roomStorageUsage().then((usage) => setWorkspaceRoom(usage.kind === "workspace")).catch(() => {});
    reload();
    let un: (() => void) | undefined;
    api.onPrivacyScan((p) => {
      setScan(p);
      if (!p.running) reload();
    }).then((u) => (un = u));
    return () => un?.();
  }, [reload]);

  const effectiveOn = status?.effectiveOn ?? true;

  const toggleRoom = async () => {
    if (!status) return;
    try {
      await api.setPrivacyRoom(effectiveOn ? "off" : "on");
      setErr(null);
      reload();
    } catch (e) {
      setErr(String(e));
    }
  };

  /** Hand the room back to the app-wide default. Flipping the room switch
   * writes an explicit per-room choice, and there used to be no way to unwrite
   * it: the panel said "this room has its own choice" forever, and changing
   * the default below then did nothing here. The backend has always accepted
   * "default" (`set_privacy_room`); nothing offered it. */
  const followDefault = async () => {
    if (!status) return;
    try {
      await api.setPrivacyRoom("default");
      setErr(null);
      reload();
    } catch (e) {
      setErr(String(e));
    }
  };

  const toggleGlobal = async () => {
    if (!status) return;
    try {
      await api.setPrivacyGlobal(!status.globalDefaultOn);
      setErr(null);
      reload();
    } catch (e) {
      setErr(String(e));
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
    } catch (e) {
      setErr(String(e));
    }
  };

  const removeItem = async (id: string) => {
    try {
      await api.removePrivacyEntity(id);
      reload();
    } catch (e) {
      setErr(String(e));
    }
  };

  const saveConcepts = async () => {
    const concepts = conceptDraft
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);
    const editsAtSave = conceptEdits.current;
    // Blur fires on every pass through the box, so only a blur that follows
    // typing is allowed to claim anything was written.
    const wasEdited = conceptsDirty.current;
    try {
      await api.setPrivacyConcepts(concepts);
      // Cleared only once the store HAS the typing. Cleared before the await,
      // a rejected save (room locked, DB write failure) showed its error and
      // left the box unprotected: the next background scan's terminal event
      // ran `reload`, which then overwrote the topics with the stored list —
      // losing what the user typed without them touching anything. And only
      // when the box still holds what was sent: blur saves, so a click back
      // into the box and a keystroke can both land while this call is in
      // flight, and clearing then would hand the newer typing to the same
      // `reload`.
      const stillCurrent = conceptEdits.current === editsAtSave;
      if (stillCurrent) conceptsDirty.current = false;
      setErr(null);
      setConceptsErr(null);
      // "Saved" sits under the box, so it is a claim about what the box holds
      // NOW: typing that landed while this call was in flight is not saved yet.
      if (wasEdited && stillCurrent) {
        setConceptsSaved(true);
        window.setTimeout(() => setConceptsSaved(false), 1600);
      }
      reload();
    } catch (e) {
      setConceptsErr(String(e));
    }
  };

  return (
    <section id="set-cloud-privacy">
      <h3>Cloud privacy</h3>
      <p className="settings-hint">
        When a question goes to a cloud model, private details are replaced
        with neutral tags like “[Person A]” before anything leaves this Mac —
        and put back in the answer you read. Local models never need this.
      </p>
      {workspaceRoom && (
        <p className="set-note set-note--flag nb-sem-pending">
          The room password encrypts Arcelle's private state: chats, memory,
          search, agent history, and recovery versions. Current files in the
          workspace folder are normal files and remain readable in Finder,
          including while the room is locked.
        </p>
      )}

      <label className="settings-label">Hide private details from cloud AI</label>
      {/* `set-consequence` lifts the sentence beside the switch to --fs-lead:
          it is not a caption for the control, it is the statement of what this
          room does with your data, and it was being set two rungs below the
          paragraph that introduces it. */}
      <div
        className="settings-toggle-row set-consequence"
        data-agent-blocked="true"
      >
        <label className="switch">
          <input type="checkbox" checked={effectiveOn} onChange={toggleRoom} />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
        </label>
        <span>
          {effectiveOn
            ? "On for this room — protected details never reach a cloud model."
            : "OFF — cloud models can see everything in this room."}
        </span>
      </div>
      {status?.roomSetting && (
        <p className="settings-hint cpv-inline-hint">
          This room has its own choice.{" "}
          <button type="button" className="linkish" onClick={followDefault}>
            Follow the app default instead
          </button>
          {status.globalDefaultOn ? " (currently on)." : " (currently off)."}
        </p>
      )}
      {!effectiveOn && (
        /* The marker label is the sentence's OWN opening clause, moved onto a
           strip of tape — not a word invented to decorate a warning. The
           copy is unchanged, and the red edge plus the sentence itself mean
           the state survives being read in greyscale. */
        <p className="cpv-off-warning set-note set-note--flag set-note--lead nb-sem-urgent">
          <span className="nb-tape set-note-tag">The door is open</span>:
          questions, documents and tool results go to cloud models with real
          names and details. Your stored blackouts are kept and enforcement
          resumes the moment you switch back on.
        </p>
      )}
      {/* The switch above governs every seam this section describes EXCEPT the
          outbound remote-connector one, which is deliberately switch-blind. So
          the warning right above this is complete for models and wrong for
          connectors, and this is the panel a user checks first when a lookup
          comes back empty — the 2026-07-24 misdiagnosis in miniature. Both
          notes read off `connectorArgsMasked`, the backend's own account of
          what that seam is doing, rather than restating the switch. */}
      {status && !effectiveOn && status.connectorArgsMasked && (
        <p className="cpv-seam-note set-note set-note--flag nb-sem-pending">
          One exception, and this switch does not control it: a{" "}
          <b>remote connector</b> is still sent placeholders instead of the
          items below, even with the door open. If a connector lookup comes
          back empty or off-target, check that first — it is Connectors →
          “Send remote connectors real values” that decides it.
        </p>
      )}
      {status && status.entities.length > 0 && !status.connectorArgsMasked && (
        <p className="cpv-seam-note set-note set-note--flag nb-sem-pending">
          {effectiveOn ? "Even with the door shut, one" : "One"} seam sends
          real values: a <b>remote connector</b> receives the items below as
          themselves, because Connectors → “Send remote connectors real values”
          is on. The switch above does not govern that seam either way.
        </p>
      )}
      <div className="settings-toggle-row" data-agent-blocked="true">
        <label className="switch">
          <input
            type="checkbox"
            checked={status?.globalDefaultOn ?? true}
            onChange={toggleGlobal}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
        </label>
        <span className="settings-hint cpv-inline-hint">
          Default for rooms without their own choice
          {status?.roomSetting
            ? " (this room has its own choice above)"
            : " (this room follows it)"}
        </span>
      </div>

      <label className="settings-label">Never share these</label>
      <p className="settings-hint">
        Exact words you add here are blocked mechanically on every request —
        guaranteed, no AI judgment involved.
      </p>
      <div className="cpv-add-row">
        <input
          placeholder="e.g. a name, address, phone number…"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addItem();
          }}
        />
        <select
          className="cpv-cat"
          value={newCat}
          onChange={(e) => setNewCat(e.target.value)}
        >
          <option value="person">Person</option>
          <option value="address">Address</option>
          <option value="phone">Phone</option>
          <option value="email">Email</option>
          <option value="id">ID number</option>
          <option value="org">Organization</option>
          <option value="concept">Other</option>
        </select>
        <button type="button" className="primary" onClick={addItem}>
          Add
        </button>
      </div>
      {status && status.entities.length > 0 && (
        <ul className="cpv-list">
          {status.entities.map((e) => (
            <li key={e.id} className="cpv-item">
              <span className="cpv-real">{e.realText}</span>
              <span className="cpv-arrow" aria-hidden="true">
                →
              </span>
              <span className="cpv-placeholder">{e.placeholder}</span>
              <span
                className={`cpv-source ${e.source === "user" ? "user" : "scan"}`}
              >
                {e.source === "user" ? "guaranteed" : "found by scan"}
              </span>
              <button
                type="button"
                className="cpv-remove"
                title={
                  e.source === "user"
                    ? "Remove from the block list"
                    : "Not private — stop hiding this"
                }
                data-agent-blocked="true"
                onClick={() => removeItem(e.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

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
        onChange={(e) => {
          conceptsDirty.current = true;
          conceptEdits.current += 1;
          setConceptDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          // This box only saves on blur, so letting Escape reach the modal
          // closed Settings and threw the typing away. Same guard as
          // BehaviorSection's two textareas, for the same reason.
          if (e.key === "Escape") e.stopPropagation();
        }}
        onBlur={saveConcepts}
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

      <label className="settings-label">Document scan</label>
      <p className="settings-hint">
        A local model reads each imported file once and marks private details.
        Open any file’s “Cloud view” to see exactly what a cloud model would
        receive.
      </p>
      <div className="cpv-scan-row">
        {scan?.running ? (
          <span className="settings-hint">
            {scan.total > 0
              ? `Scanning ${Math.min(scan.done + 1, scan.total)} of ${scan.total}`
              : "Starting the scan"}
            {scan.label ? ` — ${scan.label}` : ""}…
          </span>
        ) : status && status.pendingFiles > 0 ? (
          <span className="settings-hint">
            {status.pendingFiles} file{status.pendingFiles === 1 ? "" : "s"}{" "}
            awaiting scan.
          </span>
        ) : (
          <span className="settings-hint">All files scanned.</span>
        )}
        <button
          type="button"
          className="subtle"
          disabled={scan?.running === true || status?.scanning === true}
          onClick={() => {
            setScan({ running: true, done: 0, total: 0 });
            // Clear the optimistic "running" if the scan never starts. It used
            // to be painted unconditionally and no event ever took it back, so
            // a refusal left the panel saying a scan was under way forever.
            api.startPrivacyScan().catch((e) => {
              setScan(null);
              setErr(String(e));
            });
          }}
        >
          Scan now
        </button>
      </div>
      {scan?.error && <div className="gate-error">{scan.error}</div>}

      {/* The paragraph that admits what this feature cannot do. It used to be
          dimmed with opacity — the one paragraph on the surface that should
          never be the faintest. Quiet by position and by a pencil edge now,
          at full legibility. */}
      <p className="cpv-honesty set-note">
        Honest limits: hiding names can’t stop every inference from remaining
        context, and anything already sent to a cloud can’t be recalled.
        Images never go to cloud models while the door is on.
      </p>
      {err && <div className="gate-error">{err}</div>}
    </section>
  );
}
