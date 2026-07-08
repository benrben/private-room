import type { RoomRole } from "./types";

interface Props {
  roles: RoomRole[];
  role: string;
  changeRole: (id: string) => void;
}

export default function RoleSection({ roles, role, changeRole }: Props) {
  return (
    // ROLES — a stance for this room's AI.
    <section id="set-role">
      <h3>Room role</h3>
            <p className="settings-hint">
              Give this room's AI a stance. It shapes how answers are framed —
              your files and privacy are unchanged.
            </p>
            {roles.length > 0 ? (
              <div className="model-list">
                {roles.map((r) => (
                  <label
                    key={r.id}
                    className={`model-row ${r.id === role ? "active" : ""}`}
                    style={{
                      alignItems: "flex-start",
                      gap: 8,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="room-role"
                      checked={r.id === role}
                      onChange={() => changeRole(r.id)}
                      style={{ marginTop: 3 }}
                    />
                    <span
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                        flex: 1,
                      }}
                    >
                      <span className="model-label">{r.name}</span>
                      <span className="settings-hint" style={{ margin: 0 }}>
                        {r.blurb}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="settings-hint">Roles aren't available right now.</p>
            )}
    </section>
  );
}
