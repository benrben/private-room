import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import { RoomRole } from "./types";

/** ROLES — a stance for this room's AI (list_roles + set_setting room_role). */
export function useRoles() {
  const [roles, setRoles] = useState<RoomRole[]>([]);
  const [role, setRole] = useState("default");

  useEffect(() => {
    invoke<RoomRole[]>("list_roles")
      .then(setRoles)
      .catch(() => setRoles([]));
    api.getSetting("room_role").then((v) => {
      if (v) setRole(v);
    });
  }, []);

  // ROLES — persist the chosen stance; the app injects its instructions.
  function changeRole(id: string) {
    setRole(id);
    api.setSetting("room_role", id);
  }

  return { roles, role, changeRole };
}
