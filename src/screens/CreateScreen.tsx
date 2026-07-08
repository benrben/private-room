import { MIN_PASSWORD, ROOM_TEMPLATES, RoomRole } from "../rooms/constants";
import { passwordCriteria, passwordStrength } from "../rooms/helpers";

type CreateScreenProps = {
  roomName: string;
  setRoomName: (v: string) => void;
  templateKey: string;
  setTemplateKey: (v: string) => void;
  roles: RoomRole[];
  roleId: string;
  setRoleId: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  confirm: string;
  setConfirm: (v: string) => void;
  error: string;
  setError: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
};

export function CreateScreen({
  roomName,
  setRoomName,
  templateKey,
  setTemplateKey,
  roles,
  roleId,
  setRoleId,
  password,
  setPassword,
  confirm,
  setConfirm,
  error,
  setError,
  busy,
  onSubmit,
  onBack,
}: CreateScreenProps) {
  const strength = passwordStrength(password);
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <form
      className="gate-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="gate-sub">Name your room</p>
      <input
        type="text"
        placeholder="e.g. Personal, Work, Journal"
        value={roomName}
        autoFocus
        onChange={(e) => setRoomName(e.target.value)}
      />
      <div className="tpl-picker">
        <div className="tpl-label">Start from a template</div>
        <div className="tpl-chips">
          {ROOM_TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              type="button"
              className={`tpl-chip${
                templateKey === tpl.key ? " active" : ""
              }`}
              aria-pressed={templateKey === tpl.key}
              onClick={() => setTemplateKey(tpl.key)}
            >
              {tpl.label}
            </button>
          ))}
        </div>
        <p className="tpl-blurb">
          {ROOM_TEMPLATES.find((t) => t.key === templateKey)?.blurb}
        </p>
      </div>
      {roles.length > 0 && (
        <div className="tpl-picker">
          <div className="tpl-label">Give it a role (optional)</div>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="tpl-blurb">
            {roles.find((r) => r.id === roleId)?.blurb}
          </p>
        </div>
      )}
      <input
        type="password"
        placeholder="Choose a password"
        className={tooShort ? "invalid" : undefined}
        aria-invalid={tooShort}
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          if (error) setError("");
        }}
      />
      {password && (
        <>
          <div className={`pw-meter ${strength.level}`}>
            <div className="pw-meter-track">
              <div className="pw-meter-fill" />
            </div>
            <span className="pw-meter-label">{strength.label}</span>
          </div>
          <ul className="pw-criteria">
            {passwordCriteria(password).map((c) => (
              <li
                key={c.label}
                className={c.met ? "met" : undefined}
              >
                {c.met ? "✓" : "○"} {c.label}
              </li>
            ))}
          </ul>
        </>
      )}
      <input
        type="password"
        placeholder="Repeat password"
        className={mismatch ? "invalid" : undefined}
        aria-invalid={mismatch}
        value={confirm}
        onChange={(e) => {
          setConfirm(e.target.value);
          if (error) setError("");
        }}
      />
      {mismatch && !error && (
        <div className="gate-error" role="alert">
          <span className="gate-error-ic" aria-hidden="true">!</span>
          Passwords do not match.
        </div>
      )}
      {error && (
        <div className="gate-error" role="alert">
          <span className="gate-error-ic" aria-hidden="true">!</span>
          {error}
        </div>
      )}
      <div className="gate-actions">
        <button
          className="primary"
          type="submit"
          disabled={
            busy ||
            password.length < MIN_PASSWORD ||
            password !== confirm
          }
        >
          {busy ? "Creating…" : "Create & Enter"}
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
      <p className="gate-note">
        Longer is stronger. You'll get a one-time recovery code next.
      </p>
    </form>
  );
}
