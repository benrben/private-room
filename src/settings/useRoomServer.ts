import { useEffect, useState } from "react";
import {
  regenerateLeashToken,
  roomServerStatus,
  setRoomServer,
} from "../api";
import { RoomServerStatus } from "./types";

/** THE LEASH — expose the unlocked room as an MCP server (room_server_status /
 * set_room_server). Wave 1a: the status echoes scope/stable/allowCloud, so the
 * local controls are SEEDED from the fetch — a reopened Settings shows the
 * truth instead of reset defaults, and a tier flip never re-applies stale
 * policy. */
export function useRoomServer() {
  const [leash, setLeash] = useState<RoomServerStatus>({
    running: false,
    url: "",
    config: "",
    scope: "files",
    stable: false,
    allowCloud: false,
  });
  const [allowCloud, setAllowCloud] = useState(false);
  const [scope, setScope] = useState<"files" | "full">("files");
  const [leashBusy, setLeashBusy] = useState(false);
  const [leashErr, setLeashErr] = useState("");
  const [leashCopied, setLeashCopied] = useState(false);

  useEffect(() => {
    roomServerStatus()
      .then((st) => {
        setLeash(st);
        if (st.running) {
          setAllowCloud(st.allowCloud);
          setScope(st.scope);
        }
      })
      .catch(() => {});
  }, []);

  // THE LEASH — start/stop/restart the room MCP server with the full policy
  // (a scope or cloud flip while running restarts the bridge, severing the
  // old tier's live connections).
  async function applyRoomServer(
    enabled: boolean,
    cloud: boolean,
    tier: "files" | "full",
  ) {
    setLeashErr("");
    setLeashBusy(true);
    try {
      const st = await setRoomServer(enabled, cloud, tier);
      setLeash(st);
      if (st.running) {
        setAllowCloud(st.allowCloud);
        setScope(st.scope);
      }
    } catch (e) {
      setLeashErr(String(e));
    } finally {
      setLeashBusy(false);
    }
  }

  function toggleLeash() {
    applyRoomServer(!leash.running, allowCloud, scope);
  }

  // Flipping allow-cloud while the server runs restarts it with the new policy.
  function toggleAllowCloud(next: boolean) {
    setAllowCloud(next);
    if (leash.running) applyRoomServer(true, next, scope);
  }

  // Wave 1a: switching the access level restarts the bridge at the new tier.
  function changeScope(next: "files" | "full") {
    setScope(next);
    if (leash.running) applyRoomServer(true, allowCloud, next);
  }

  // Wave 1a: revoke the full tier's long-lived token (the pasted configs and
  // leash.json get a fresh one; live connections holding the old one die).
  async function regenerateToken() {
    setLeashErr("");
    setLeashBusy(true);
    try {
      setLeash(await regenerateLeashToken());
    } catch (e) {
      setLeashErr(String(e));
    } finally {
      setLeashBusy(false);
    }
  }

  async function copyLeashConfig() {
    try {
      await navigator.clipboard.writeText(leash.config);
      setLeashCopied(true);
      window.setTimeout(() => setLeashCopied(false), 1600);
    } catch {
      // Clipboard blocked — the box is selectable, so the user can copy by hand.
    }
  }

  return {
    leash,
    allowCloud,
    scope,
    leashBusy,
    leashErr,
    leashCopied,
    toggleLeash,
    toggleAllowCloud,
    changeScope,
    regenerateToken,
    copyLeashConfig,
  };
}
