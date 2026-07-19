import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
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
  const conceptsDirty = useRef(false);

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
    conceptsDirty.current = false;
    const concepts = conceptDraft
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);
    try {
      await api.setPrivacyConcepts(concepts);
      setErr(null);
      reload();
    } catch (e) {
      setErr(String(e));
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

      <label className="settings-label">Hide private details from cloud AI</label>
      <div className="settings-toggle-row" data-agent-blocked="true">
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
      {!effectiveOn && (
        <p className="cpv-off-warning">
          The door is open: questions, documents and tool results go to cloud
          models with real names and details. Your stored blackouts are kept
          and enforcement resumes the moment you switch back on.
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
          setConceptDraft(e.target.value);
        }}
        onBlur={saveConcepts}
        placeholder={"my health\nmy family"}
      />

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
            api.startPrivacyScan().catch((e) => setErr(String(e)));
          }}
        >
          Scan now
        </button>
      </div>
      {scan?.error && <div className="gate-error">{scan.error}</div>}

      <p className="settings-hint cpv-honesty">
        Honest limits: hiding names can’t stop every inference from remaining
        context, and anything already sent to a cloud can’t be recalled.
        Images never go to cloud models while the door is on.
      </p>
      {err && <div className="gate-error">{err}</div>}
    </section>
  );
}
