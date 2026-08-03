import { useEffect, useState } from "react";
import { api, hasRecoveryKey } from "../api";
import { MIN_PASSWORD, ROOM_FILTER } from "../rooms/constants";
import { duplicateFileName } from "../rooms/helpers";

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
  // The open room's own name, so the copy is suggested under it rather than
  // under a generic "Copy of room" the app already knows is wrong.
  const [roomName, setRoomName] = useState("");
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
        setRoomName(info.name);
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
    if (pwNew.length < MIN_PASSWORD) {
      setPwError(`New password must be at least ${MIN_PASSWORD} characters.`);
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
      // Same doctrine, one boundary further out: a checkpoint whose re-key
      // failed leaves the password change reporting a clean success while that
      // restore point quietly stops working. Name them NOW, while the old
      // password is still fresh in the user's mind — the alternative is finding
      // out weeks later from a rollback that says the current password is wrong.
      const stranded = await api.listStrandedCheckpoints().catch(() => []);
      if (stranded.length > 0) {
        setPwError(
          `${stranded.length} restore point${stranded.length === 1 ? "" : "s"} could not be re-locked with the new password (${stranded.join(", ")}). ` +
            "Only your PREVIOUS password opens them — keep it somewhere safe, or delete them under Settings → Restore points.",
        );
      }
      // The Keychain entry holds the OLD password, so `change_password`
      // re-saves it behind Touch ID — and when that re-save fails it safely
      // DELETES the entry instead (safety.rs). Settings kept showing the switch
      // as on until it was reopened, so the room read as biometric-unlockable
      // when only typing worked. Ask the Keychain rather than assume either way.
      if (roomPath) {
        const still = await api.touchIdHas(roomPath).catch(() => touchIdOn);
        setTouchIdOn(still);
        if (touchIdOn && !still) {
          setTouchIdErr(
            "Touch ID unlock was turned off: the new password could not be stored behind it. Turn it back on to re-enable it.",
          );
        }
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
    // The save sheet used to suggest "Copy of room.arcelle" for every room,
    // even though the app knows this room's name — so two rooms called the same
    // thing ended up in files called the same generic thing.
    const p = await api.chooseSavePath({
      defaultPath: `${duplicateFileName(roomName)}.arcelle`,
      filters: ROOM_FILTER,
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
      if (dupPassword.length < MIN_PASSWORD) {
        setDupError(`New password must be at least ${MIN_PASSWORD} characters.`);
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
    roomName,
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
