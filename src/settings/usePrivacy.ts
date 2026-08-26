import { useEffect, useState } from "react";
import { api, hasRecoveryKey } from "../api";
import { MIN_PASSWORD, ROOM_FILTER } from "../rooms/constants";
import { duplicateDestinationSuggestion } from "../rooms/helpers";
import {
  newPasswordProblem,
  revokedRecoveryWarning,
  strandedCheckpointWarning,
  touchIdLostWarning,
} from "../rooms/passwordChange";

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
    const problem = newPasswordProblem(pwNew, pwRepeat, MIN_PASSWORD);
    if (problem) {
      setPwError(problem);
      return;
    }
    try {
      // Asked BEFORE the change, because afterwards a room that never had a
      // recovery key and one whose key was just lost look identical.
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
      // Two independent things can fail AFTER the password itself changed, and
      // they used to share one string slot — the checkpoint warning below was
      // written over this one, so the credential that is now permanently gone
      // went unmentioned. Accumulate: whichever happened gets said, and when
      // both happened both get said.
      const warnings: string[] = [];
      const revoked = revokedRecoveryWarning(hadRecovery, freshCode);
      if (revoked) {
        warnings.push(revoked);
        // Painted before the stranded-checkpoint query, which is a round trip.
        setPwError(warnings.join(" "));
      }
      const strandedWarning = strandedCheckpointWarning(
        await api.listStrandedCheckpoints().catch(() => []),
      );
      if (strandedWarning) {
        warnings.push(strandedWarning);
        setPwError(warnings.join(" "));
      }
      // Ask the Keychain rather than assume either way.
      if (roomPath) {
        const still = await api.touchIdHas(roomPath).catch(() => touchIdOn);
        setTouchIdOn(still);
        const lost = touchIdLostWarning(touchIdOn, still);
        if (lost) setTouchIdErr(lost);
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

  // ADD-4: pick a destination file or folder for the copy.
  async function chooseDupDest() {
    setDupError("");
    try {
      // Ask at click time instead of guessing from the path extension. A
      // workspace can have any outer-folder name, including one inherited
      // from an old buggy `.arcelle` suggestion.
      const kind = (await api.roomStorageUsage()).kind;
      const suggestion = duplicateDestinationSuggestion(roomName, kind);
      const p = await api.chooseSavePath({
        ...suggestion,
        ...(kind === "legacy" ? { filters: ROOM_FILTER } : {}),
      });
      if (p) setDupDest(p);
    } catch (e) {
      setDupError(String(e));
    }
  }

  async function duplicate() {
    setDupError("");
    if (!dupDest) {
      setDupError("Choose where to save the copy first.");
      return;
    }
    let newPassword: string | null = null;
    if (dupPassword) {
      const problem = newPasswordProblem(dupPassword, dupRepeat, MIN_PASSWORD);
      if (problem) {
        setDupError(problem);
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
