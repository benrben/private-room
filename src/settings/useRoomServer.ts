import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RoomServerStatus } from "./types";

/** THE LEASH — expose the unlocked room as an MCP server (room_server_status /
 * set_room_server). Status carries running/url/config; allow-cloud is an arg
 * we track locally (the status doesn't echo it back). */
export function useRoomServer() {
  const [leash, setLeash] = useState<RoomServerStatus>({
    running: false,
    url: "",
    config: "",
  });
  const [allowCloud, setAllowCloud] = useState(false);
  const [leashBusy, setLeashBusy] = useState(false);
  const [leashErr, setLeashErr] = useState("");
  const [leashCopied, setLeashCopied] = useState(false);

  useEffect(() => {
    invoke<RoomServerStatus>("room_server_status")
      .then(setLeash)
      .catch(() => {});
  }, []);

  // THE LEASH — start/stop the room MCP server, re-applying allow-cloud.
  async function applyRoomServer(enabled: boolean, cloud: boolean) {
    setLeashErr("");
    setLeashBusy(true);
    try {
      // CONTRACT-NOTE: intended wrapper setRoomServer(enabled, allowCloud);
      // invoke keys are camelCase (enabled, allowCloud).
      const st = await invoke<RoomServerStatus>("set_room_server", {
        enabled,
        allowCloud: cloud,
      });
      setLeash(st);
    } catch (e) {
      setLeashErr(String(e));
    } finally {
      setLeashBusy(false);
    }
  }

  function toggleLeash() {
    applyRoomServer(!leash.running, allowCloud);
  }

  // Flipping allow-cloud while the server runs restarts it with the new policy.
  function toggleAllowCloud(next: boolean) {
    setAllowCloud(next);
    if (leash.running) applyRoomServer(true, next);
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
    leashBusy,
    leashErr,
    leashCopied,
    toggleLeash,
    toggleAllowCloud,
    copyLeashConfig,
  };
}
