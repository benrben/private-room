import { useState } from "react";
import { writeRecoveryKey } from "../api";

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
      const code = await writeRecoveryKey();
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
