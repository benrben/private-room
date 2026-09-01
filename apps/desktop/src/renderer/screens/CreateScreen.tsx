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

function clearError(error: string, setError: (value: string) => void) {
  if (error) setError("");
}

function PasswordFeedback({ password }: { password: string }) {
  const strength = passwordStrength(password);
  return (
    <div
      className={`pw-feedback${password ? "" : " reserved"}`}
      aria-hidden={!password}
    >
      <div className={`pw-meter ${strength.level}`}>
        <div className="pw-meter-track">
          <div className="pw-meter-fill" />
        </div>
        <span className="pw-meter-label">{strength.label}</span>
      </div>
      <ul className="pw-criteria">
        {passwordCriteria(password).map((criterion) => (
          <li
            key={criterion.label}
            className={criterion.met ? "met" : undefined}
          >
            {criterion.met ? "✓" : "○"} {criterion.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TemplatePicker({
  templateKey,
  setTemplateKey,
}: Pick<CreateScreenProps, "templateKey" | "setTemplateKey">) {
  const selected = ROOM_TEMPLATES.find(
    (template) => template.key === templateKey,
  );
  return (
    <div className="tpl-picker">
      <div className="tpl-label">Start from a template</div>
      <div className="tpl-chips">
        {ROOM_TEMPLATES.map((template) => (
          <button
            key={template.key}
            type="button"
            className={`nb-chip nb-chip-btn tpl-chip${templateKey === template.key ? " is-on" : ""}`}
            aria-pressed={templateKey === template.key}
            onClick={() => setTemplateKey(template.key)}
          >
            {template.label}
          </button>
        ))}
      </div>
      <p className="tpl-blurb">{selected?.blurb}</p>
    </div>
  );
}

function RolePicker({
  roles,
  roleId,
  setRoleId,
}: Pick<CreateScreenProps, "roles" | "roleId" | "setRoleId">) {
  if (roles.length === 0) return null;
  const selected = roles.find((role) => role.id === roleId);
  return (
    <div className="tpl-picker">
      <div className="tpl-label">Give it a role (optional)</div>
      <select
        value={roleId}
        onChange={(event) => setRoleId(event.target.value)}
      >
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      <p className="tpl-blurb">{selected?.blurb}</p>
    </div>
  );
}

function PasswordFields({
  password,
  setPassword,
  confirm,
  setConfirm,
  error,
  setError,
}: Pick<
  CreateScreenProps,
  "password" | "setPassword" | "confirm" | "setConfirm" | "error" | "setError"
>) {
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && password !== confirm;
  return (
    <>
      <input
        type="password"
        placeholder="Choose a password"
        className={tooShort ? "invalid" : undefined}
        aria-invalid={tooShort}
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          clearError(error, setError);
        }}
      />
      <PasswordFeedback password={password} />
      <input
        type="password"
        placeholder="Repeat password"
        className={mismatch ? "invalid" : undefined}
        aria-invalid={mismatch}
        value={confirm}
        onChange={(event) => {
          setConfirm(event.target.value);
          clearError(error, setError);
        }}
      />
      <PasswordError mismatch={mismatch} error={error} />
    </>
  );
}

function PasswordError({
  mismatch,
  error,
}: {
  mismatch: boolean;
  error: string;
}) {
  if (error)
    return (
      <div className="gate-error" role="alert">
        <span className="gate-error-ic" aria-hidden="true">
          !
        </span>
        {error}
      </div>
    );
  if (!mismatch) return null;
  return (
    <div className="gate-error" role="alert">
      <span className="gate-error-ic" aria-hidden="true">
        !
      </span>
      Passwords do not match.
    </div>
  );
}

function CreateActions({
  busy,
  password,
  confirm,
  onBack,
}: Pick<CreateScreenProps, "busy" | "password" | "confirm" | "onBack">) {
  const unavailable =
    busy || password.length < MIN_PASSWORD || password !== confirm;
  return (
    <div className="gate-actions">
      <button className="primary" type="submit" disabled={unavailable}>
        {busy ? "Creating…" : "Create & Enter"}
      </button>
      <button type="button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}

export function CreateScreen(props: CreateScreenProps) {
  return (
    <form
      className="gate-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <p className="gate-sub">Name your room</p>
      <input
        type="text"
        placeholder="e.g. Personal, Work, Journal"
        value={props.roomName}
        autoFocus
        onChange={(event) => props.setRoomName(event.target.value)}
      />
      <TemplatePicker
        templateKey={props.templateKey}
        setTemplateKey={props.setTemplateKey}
      />
      <RolePicker
        roles={props.roles}
        roleId={props.roleId}
        setRoleId={props.setRoleId}
      />
      <PasswordFields
        password={props.password}
        setPassword={props.setPassword}
        confirm={props.confirm}
        setConfirm={props.setConfirm}
        error={props.error}
        setError={props.setError}
      />
      <CreateActions
        busy={props.busy}
        password={props.password}
        confirm={props.confirm}
        onBack={props.onBack}
      />
      <p className="gate-note gate-note-warn">
        Longer is stronger. There is no password reset — if you forget this
        password, only the one-time recovery code on the next screen can reopen
        the room, and nobody (including us) can recover either one for you.
      </p>
    </form>
  );
}
