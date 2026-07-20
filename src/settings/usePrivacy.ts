import { useEffect, useState } from "react";
import { api, hasRecoveryKey } from "../api";

/** Privacy section (Wave 2): auto-lock, change password, Touch ID unlock,
 * duplicate room, and compact. */
export function usePrivacy() {
  // SEC-3: per-room auto-lock choice (Workspace enforces it; here we only persist).
  const [autolock, setAutolock] = useState("15");
  // SEC-4: change password.
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwRepeat, setPwRepeat] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSaved, setPwSaved] = useState(false);
  // Changing the password re-issues the recovery key (the old code wrapped
  // the old password); it is shown once, like the Recovery section's.
  const [pwRecoveryCode, setPwRecoveryCode] = useState<string | null>(null);
  const [pwRecoveryCopied, setPwRecoveryCopied] = useState(false);

  // ADD-11: Touch ID unlock. Needs the open room's path (from room_info).
  const [roomPath, setRoomPath] = useState("");
  const [touchIdOn, setTouchIdOn] = useState(false);
  const [touchIdErr, setTouchIdErr] = useState("");
  // ADD-4: duplicate room.
  const [dupDest, setDupDest] = useState("");
  const [dupPassword, setDupPassword] = useState("");
  const [dupRepeat, setDupRepeat] = useState("");
  const [dupError, setDupError] = useState("");
  const [dupDone, setDupDone] = useState(false);
  // SEC-7: compact room.
  const [compacting, setCompacting] = useState(false);
  const [compactMsg, setCompactMsg] = useState("");
  const [compactErr, setCompactErr] = useState("");
  const [compactArmed, setCompactArmed] = useState(false);

  useEffect(() => {
    api.getSetting("autolock_minutes").then((v) => {
      if (v) setAutolock(v);
    });
    // ADD-11: learn the open room's path, then whether Touch ID is enabled.
    api
      .roomInfo()
      .then((info) => {
        if (!info) return;
        setRoomPath(info.path);
        api.touchIdHas(info.path).then(setTouchIdOn).catch(() => {});
      })
      .catch(() => {});
  }, []);

  // SEC-3: persist the auto-lock choice; the Workspace timer reads it.
  function changeAutolock(value: string) {
    setAutolock(value);
    api.setSetting("autolock_minutes", value);
  }

  // SEC-4: verify + rekey via the existing command.
  async function changePassword() {
    setPwError("");
    if (pwNew !== pwRepeat) {
      setPwError("The new passwords do not match.");
      return;
    }
    if (pwNew.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    try {
      // change_password returns null both when the room never had a recovery
      // sidecar AND when re-wrapping failed (sidecar deleted) — check up
      // front so a silent revocation gets surfaced.
      const hadRecovery = roomPath
        ? await hasRecoveryKey(roomPath).catch(() => false)
        : false;
      const freshCode = await api.changePassword(pwCurrent, pwNew);
      setPwCurrent("");
      setPwNew("");
      setPwRepeat("");
      setPwSaved(true);
      setPwRecoveryCopied(false);
      setPwRecoveryCode(freshCode);
      if (hadRecovery && freshCode === null) {
        setPwError(
          "Your recovery key could not be re-issued and has been revoked — create a new one in Settings → Recovery key.",
        );
      }
      window.setTimeout(() => setPwSaved(false), 2400);
    } catch (e) {
      setPwError(String(e));
    }
  }

  // ADD-11: flip Touch ID unlock for this room. On = store the open room's
  // password in the Keychain behind biometrics; off = delete the entry.
  async function toggleTouchId() {
    setTouchIdErr("");
    try {
      if (touchIdOn) {
        await api.touchIdDisable(roomPath);
        setTouchIdOn(false);
      } else {
        await api.touchIdEnable();
        setTouchIdOn(true);
      }
    } catch (e) {
      setTouchIdErr(String(e));
    }
  }

  // ADD-4: pick a destination file for the copy.
  async function chooseDupDest() {
    const p = await api.chooseSavePath({
      defaultPath: "Copy of room.arcelle",
      filters: [{ name: "Arcelle Workspace", extensions: ["arcelle", "roomai"] }],
    });
    if (p) setDupDest(p);
  }

  async function duplicate() {
    setDupError("");
    if (!dupDest) {
      setDupError("Choose where to save the copy first.");
      return;
    }
    let newPassword: string | null = null;
    if (dupPassword) {
      if (dupPassword !== dupRepeat) {
        setDupError("The new passwords do not match.");
        return;
      }
      if (dupPassword.length < 8) {
        setDupError("New password must be at least 8 characters.");
        return;
      }
      newPassword = dupPassword;
    }
    try {
      await api.duplicateRoom(dupDest, newPassword);
      setDupDest("");
      setDupPassword("");
      setDupRepeat("");
      setDupDone(true);
      window.setTimeout(() => setDupDone(false), 2400);
    } catch (e) {
      setDupError(String(e));
    }
  }

  // SEC-7: reclaim space left by deleted files.
  async function compact() {
    setCompacting(true);
    setCompactMsg("");
    setCompactErr("");
    try {
      setCompactMsg(await api.compactRoom());
    } catch (e) {
      setCompactErr(String(e));
    } finally {
      setCompacting(false);
    }
  }

  return {
    autolock,
    changeAutolock,
    pwCurrent,
    setPwCurrent,
    pwNew,
    setPwNew,
    pwRepeat,
    setPwRepeat,
    pwError,
    pwSaved,
    changePassword,
    pwRecoveryCode,
    setPwRecoveryCode,
    pwRecoveryCopied,
    setPwRecoveryCopied,
    touchIdOn,
    toggleTouchId,
    touchIdErr,
    chooseDupDest,
    dupDest,
    dupPassword,
    setDupPassword,
    dupRepeat,
    setDupRepeat,
    dupError,
    duplicate,
    dupDone,
    compactMsg,
    setCompactMsg,
    compactArmed,
    setCompactArmed,
    compact,
    compacting,
    compactErr,
  };
}
