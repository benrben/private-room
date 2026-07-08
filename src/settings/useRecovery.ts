import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** RECOVERY — one-time code that can reopen the room (write_recovery_key). */
export function useRecovery() {
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryErr, setRecoveryErr] = useState("");

  // RECOVERY — mint a one-time recovery code for the open room.
  async function createRecoveryKey() {
    setRecoveryErr("");
    setRecoveryBusy(true);
    try {
      // CONTRACT-NOTE: intended wrapper writeRecoveryKey(); uses the open room.
      const code = await invoke<string>("write_recovery_key");
      setRecoveryCopied(false);
      setRecoveryCode(code);
    } catch (e) {
      setRecoveryErr(String(e));
    } finally {
      setRecoveryBusy(false);
    }
  }

  return {
    recoveryCode,
    recoveryCopied,
    setRecoveryCopied,
    setRecoveryCode,
    recoveryBusy,
    createRecoveryKey,
    recoveryErr,
  };
}
