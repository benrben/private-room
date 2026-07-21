import { useEffect, useState } from "react";
import { ENGINE_LABELS } from "./api";
import { AlertIcon, CloseIcon, DownloadIcon, EyeIcon, TrashIcon } from "./icons";
import "./settingsA11y.css";
import { Props } from "./settings/types";
import ModelSection from "./settings/ModelSection";
import BehaviorSection from "./settings/BehaviorSection";
import VoiceSection from "./settings/VoiceSection";
import CloudPrivacySection from "./settings/CloudPrivacySection";
import PrivacySection from "./settings/PrivacySection";
import CheckpointsSection from "./settings/CheckpointsSection";
import OnlineSection from "./settings/OnlineSection";
import AdvisorsSection from "./settings/AdvisorsSection";
import RemoteAiSection from "./settings/RemoteAiSection";
import RoomServerSection from "./settings/RoomServerSection";
import RoleSection from "./settings/RoleSection";
import HelpersSection from "./settings/HelpersSection";
import RecoverySection from "./settings/RecoverySection";
import AboutSection from "./settings/AboutSection";
import { useFocusTrap } from "./settings/useFocusTrap";
import { useModelManagement } from "./settings/useModelManagement";
import { useBehaviorSettings } from "./settings/useBehaviorSettings";
import { useVoiceSettings } from "./settings/useVoiceSettings";
import { usePrivacy } from "./settings/usePrivacy";
import { useCheckpoints } from "./settings/useCheckpoints";
import { useOnlineSearch } from "./settings/useOnlineSearch";
import { useAdvisors } from "./settings/useAdvisors";
import { useRemoteAi } from "./settings/useRemoteAi";
import { useRoomServer } from "./settings/useRoomServer";
import { useRoles } from "./settings/useRoles";
import { useRecovery } from "./settings/useRecovery";

/** Settings is split into focused PAGES rather than one long technical scroll.
 * Each group is a page; its `sections` are the anchor ids used by the in-page
 * jump links and by deep-links (the status-bar trust chip → Cloud privacy). */
const SETTINGS_GROUPS: { key: string; label: string; sections: [string, string][] }[] = [
  {
    key: "ai",
    label: "AI & behavior",
    sections: [
      ["set-model", "Model"],
      ["set-behavior", "Behavior"],
      ["set-role", "Room role"],
      ["set-helpers", "AI helpers"],
      ["set-advisors", "AI advisors"],
    ],
  },
  { key: "voice", label: "Voice", sections: [["set-voice", "Spoken voice"]] },
  {
    key: "privacy",
    label: "Privacy & recovery",
    sections: [
      ["set-cloud-privacy", "Cloud privacy"],
      ["set-privacy", "Lock & password"],
      ["set-recovery", "Recovery key"],
    ],
  },
  {
    key: "connections",
    label: "Connections",
    sections: [
      ["set-online", "Online search"],
      ["set-closet", "Remote AI"],
      ["set-leash", "Room server"],
    ],
  },
  { key: "history", label: "History & storage", sections: [["set-checkpoints", "Checkpoints"]] },
  { key: "app", label: "App", sections: [["set-about", "Updates & version"]] },
];

/** section id → the page it lives on, so a deep-link opens the right page. */
const GROUP_OF_SECTION: Record<string, string> = Object.fromEntries(
  SETTINGS_GROUPS.flatMap((g) => g.sections.map(([id]) => [id, g.key])),
);

export default function Settings({
  ai,
  model,
  onModelChange,
  onModelsChanged,
  onClose,
  busy,
  initialSection,
}: Props) {
  // Each section owns its state + handlers via a per-concern hook. The shell
  // only threads those returns to the presentational section components and
  // owns cross-hook wiring (Behavior's Save clears the shared model error).
  const { modalRef, onModalKeyDown } = useFocusTrap(onClose);

  // Which settings page is showing. Deep-links (initialSection) open on the page
  // that owns the section; otherwise start on AI & behavior.
  const [activeGroup, setActiveGroup] = useState<string>(
    (initialSection && GROUP_OF_SECTION[initialSection]) || SETTINGS_GROUPS[0].key,
  );

  // Deep-link (e.g. the status-bar trust chip → Cloud privacy): switch to the
  // owning page, then once it has painted jump to the section and flag it.
  useEffect(() => {
    if (!initialSection) return;
    const group = GROUP_OF_SECTION[initialSection];
    if (group) setActiveGroup(group);
    const t = window.setTimeout(() => {
      const el = document.getElementById(initialSection);
      if (!el) return;
      el.scrollIntoView({ block: "start" });
      el.classList.add("settings-section-flash");
      window.setTimeout(() => el.classList.remove("settings-section-flash"), 1400);
    }, 40);
    return () => window.clearTimeout(t);
  }, [initialSection]);

  const {
    pullName,
    setPullName,
    pulling,
    pull,
    pullStatus,
    pullPercent,
    error,
    setError,
    confirmModel,
    askRemoveModel,
    cancelRemoveModel,
    confirmRemoveModel,
    stt,
    sttPercent,
    sttErr,
    downloadStt,
    removeStt,
    dictTranslate,
    dictMode,
    onDictTranslateChange,
    onDictModeChange,
    caps,
    recommended,
    pullingSpecial,
    pullSpecial,
    visionInstalled,
    embedInstalled,
  } = useModelManagement(ai, onModelsChanged);

  const {
    temperature,
    setTemperature,
    instructions,
    setInstructions,
    saveTuning,
    saved,
    responseStyle,
    changeResponseStyle,
    autoIndex,
    changeAutoIndex,
    memoryAutoSave,
    changeMemoryAutoSave,
    editApproval,
    changeEditApproval,
  } = useBehaviorSettings(() => setError(""));

  const voiceSettings = useVoiceSettings();

  const {
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
  } = usePrivacy();

  const checkpoints = useCheckpoints();

  const {
    webProvider,
    setWebProvider,
    webEndpoint,
    setWebEndpoint,
    webSaved,
    webTesting,
    webTestResult,
    saveWebAccess,
    testWebSearch,
  } = useOnlineSearch();

  const { advisorsOn, advisorToolsOn, onAdvisorsToggle, onAdvisorToolsToggle } =
    useAdvisors();

  const { closetUrl, setClosetUrl, saveOllamaUrl, closetSaved } = useRemoteAi();

  const {
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
  } = useRoomServer();

  const { roles, role, changeRole } = useRoles();

  const {
    recoveryCode,
    recoveryCopied,
    setRecoveryCopied,
    setRecoveryCode,
    recoveryBusy,
    createRecoveryKey,
    recoveryErr,
  } = useRecovery();

  return (
    // ADD-25: consent surface — the agent UI driver must never see or operate
    // Settings (web/cloud/advisor/room-server switches, password, Touch ID).
    <div className="settings-backdrop" data-agent-blocked onClick={onClose}>
      <div
        className="settings"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <span id="settings-title">Settings</span>
          <button
            className="subtle btn-ic"
            aria-label="Close settings"
            title="Close settings"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="settings-main">
          {/* One focused page at a time. The rail selects the page; the section
              anchors below (and deep-links) still resolve within the open page. */}
          <nav className="settings-nav" aria-label="Settings pages">
            {SETTINGS_GROUPS.map((g) => (
              <button
                key={g.key}
                type="button"
                className={`settings-nav-item${activeGroup === g.key ? " is-active" : ""}`}
                aria-current={activeGroup === g.key ? "page" : undefined}
                onClick={() => setActiveGroup(g.key)}
              >
                {g.label}
              </button>
            ))}
          </nav>
          <div className="settings-body">
            <div className="settings-page" hidden={activeGroup !== "ai"}>
              <ModelSection
                ai={ai}
                model={model}
                onModelChange={onModelChange}
                caps={caps}
                confirmModel={confirmModel}
                confirmRemoveModel={confirmRemoveModel}
                cancelRemoveModel={cancelRemoveModel}
                askRemoveModel={askRemoveModel}
                pullName={pullName}
                setPullName={setPullName}
                pulling={pulling}
                pull={pull}
                pullStatus={pullStatus}
                pullPercent={pullPercent}
                stt={stt}
                removeStt={removeStt}
                sttPercent={sttPercent}
                downloadStt={downloadStt}
                sttErr={sttErr}
                dictTranslate={dictTranslate}
                onDictTranslateChange={onDictTranslateChange}
                dictMode={dictMode}
                onDictModeChange={onDictModeChange}
                AlertIcon={AlertIcon}
                EyeIcon={EyeIcon}
                TrashIcon={TrashIcon}
                DownloadIcon={DownloadIcon}
              />
              <BehaviorSection
                temperature={temperature}
                setTemperature={setTemperature}
                instructions={instructions}
                setInstructions={setInstructions}
                saveTuning={saveTuning}
                saved={saved}
                responseStyle={responseStyle}
                changeResponseStyle={changeResponseStyle}
                autoIndex={autoIndex}
                changeAutoIndex={changeAutoIndex}
                memoryAutoSave={memoryAutoSave}
                changeMemoryAutoSave={changeMemoryAutoSave}
                editApproval={editApproval}
                changeEditApproval={changeEditApproval}
              />
              <RoleSection roles={roles} role={role} changeRole={changeRole} />
              <HelpersSection
                ai={ai}
                visionInstalled={visionInstalled}
                recommended={recommended}
                pullSpecial={pullSpecial}
                pullingSpecial={pullingSpecial}
                pulling={pulling}
                embedInstalled={embedInstalled}
                pullPercent={pullPercent}
                pullStatus={pullStatus}
                DownloadIcon={DownloadIcon}
              />
              <AdvisorsSection
                ai={ai}
                advisorsOn={advisorsOn}
                onAdvisorsToggle={onAdvisorsToggle}
                advisorToolsOn={advisorToolsOn}
                onAdvisorToolsToggle={onAdvisorToolsToggle}
                ENGINE_LABELS={ENGINE_LABELS}
                AlertIcon={AlertIcon}
              />
            </div>

            <div className="settings-page" hidden={activeGroup !== "voice"}>
              <VoiceSection {...voiceSettings} />
            </div>

            <div className="settings-page" hidden={activeGroup !== "privacy"}>
              <CloudPrivacySection />
              <PrivacySection
                autolock={autolock}
                changeAutolock={changeAutolock}
                pwCurrent={pwCurrent}
                setPwCurrent={setPwCurrent}
                pwNew={pwNew}
                setPwNew={setPwNew}
                pwRepeat={pwRepeat}
                setPwRepeat={setPwRepeat}
                pwError={pwError}
                pwSaved={pwSaved}
                // Cross-hook wiring: this sheet and the Recovery section's show
                // one-time codes for the SAME sidecar — starting a re-issue here
                // dismisses the other sheet so two codes never contradict.
                changePassword={() => {
                  setRecoveryCode(null);
                  changePassword();
                }}
                pwRecoveryCode={pwRecoveryCode}
                setPwRecoveryCode={setPwRecoveryCode}
                pwRecoveryCopied={pwRecoveryCopied}
                setPwRecoveryCopied={setPwRecoveryCopied}
                touchIdOn={touchIdOn}
                toggleTouchId={toggleTouchId}
                touchIdErr={touchIdErr}
                chooseDupDest={chooseDupDest}
                dupDest={dupDest}
                dupPassword={dupPassword}
                setDupPassword={setDupPassword}
                dupRepeat={dupRepeat}
                setDupRepeat={setDupRepeat}
                dupError={dupError}
                duplicate={duplicate}
                dupDone={dupDone}
                compactMsg={compactMsg}
                compactArmed={compactArmed}
                setCompactArmed={setCompactArmed}
                compact={compact}
                compacting={compacting}
                setCompactMsg={setCompactMsg}
                compactErr={compactErr}
              />
              <RecoverySection
                recoveryCode={recoveryCode}
                recoveryCopied={recoveryCopied}
                setRecoveryCopied={setRecoveryCopied}
                setRecoveryCode={setRecoveryCode}
                recoveryBusy={recoveryBusy}
                // Cross-hook wiring: see PrivacySection's changePassword above.
                createRecoveryKey={() => {
                  setPwRecoveryCode(null);
                  createRecoveryKey();
                }}
                recoveryErr={recoveryErr}
              />
            </div>

            <div className="settings-page" hidden={activeGroup !== "connections"}>
              <OnlineSection
                webProvider={webProvider}
                setWebProvider={setWebProvider}
                webEndpoint={webEndpoint}
                setWebEndpoint={setWebEndpoint}
                webTesting={webTesting}
                testWebSearch={testWebSearch}
                saveWebAccess={saveWebAccess}
                webSaved={webSaved}
                webTestResult={webTestResult}
                AlertIcon={AlertIcon}
              />
              <RemoteAiSection
                closetUrl={closetUrl}
                setClosetUrl={setClosetUrl}
                saveOllamaUrl={saveOllamaUrl}
                closetSaved={closetSaved}
                AlertIcon={AlertIcon}
              />
              <RoomServerSection
                leash={leash}
                leashBusy={leashBusy}
                toggleLeash={toggleLeash}
                allowCloud={allowCloud}
                toggleAllowCloud={toggleAllowCloud}
                scope={scope}
                changeScope={changeScope}
                regenerateToken={regenerateToken}
                copyLeashConfig={copyLeashConfig}
                leashCopied={leashCopied}
                leashErr={leashErr}
                AlertIcon={AlertIcon}
              />
            </div>

            <div className="settings-page" hidden={activeGroup !== "history"}>
              <CheckpointsSection {...checkpoints} busy={busy} />
            </div>

            <div className="settings-page" hidden={activeGroup !== "app"}>
              <AboutSection />
            </div>

            {error && <div className="gate-error">{error}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
