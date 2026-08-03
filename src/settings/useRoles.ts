import { useEffect, useState } from "react";
import { api, listRoles } from "../api";
import { RoomRole } from "./types";

/** ROLES — a stance for this room's AI (list_roles + set_setting room_role). */
export function useRoles() {
  const [roles, setRoles] = useState<RoomRole[]>([]);
  const [role, setRole] = useState("default");
  /** Why the last pick did not stick, or "" when nothing is wrong. The screen
   * used to switch to the new stance unconditionally and never look at the
   * write: a failed save left the picker showing one persona while the
   * assistant kept using the other, and said nothing. */
  const [roleError, setRoleError] = useState("");

  useEffect(() => {
    // Through the typed wrapper, not a hand-rolled `invoke`: the command name
    // and its return shape then live in exactly one place (api.ts).
    listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
    api.getSetting("room_role").then((v) => {
      if (v) setRole(v);
    });
  }, []);

  // ROLES — persist the chosen stance; the app injects its instructions.
  // The pick is only shown as made once the write came back: a rejected save
  // puts the previous stance back, so the picker and the assistant agree.
  async function changeRole(id: string) {
    const previous = role;
    setRole(id);
    setRoleError("");
    try {
      await api.setSetting("room_role", id);
    } catch (e) {
      setRole(previous);
      setRoleError(
        `Could not save that stance (${String(e)}) — the room is still using “${previous}”.`,
      );
    }
  }

  return { roles, role, changeRole, roleError };
}
