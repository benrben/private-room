import { ENGINE_LABELS } from "./api";
import { AlertIcon, CloseIcon, DownloadIcon, EyeIcon, TrashIcon } from "./icons";
import "./settingsA11y.css";
import { Props } from "./settings/types";
import ModelSection from "./settings/ModelSection";
import BehaviorSection from "./settings/BehaviorSection";
import PrivacySection from "./settings/PrivacySection";
import OnlineSection from "./settings/OnlineSection";
import AdvisorsSection from "./settings/AdvisorsSection";
import McpSection from "./settings/McpSection";
import RemoteAiSection from "./settings/RemoteAiSection";
import RoomServerSection from "./settings/RoomServerSection";
import RoleSection from "./settings/RoleSection";
import HelpersSection from "./settings/HelpersSection";
import RecoverySection from "./settings/RecoverySection";
import { useFocusTrap } from "./settings/useFocusTrap";
import { useModelManagement } from "./settings/useModelManagement";
import { useBehaviorSettings } from "./settings/useBehaviorSettings";
import { usePrivacy } from "./settings/usePrivacy";
import { useOnlineSearch } from "./settings/useOnlineSearch";
import { useAdvisors } from "./settings/useAdvisors";
import { useMcpConfig } from "./settings/useMcpConfig";
import { useRemoteAi } from "./settings/useRemoteAi";
import { useRoomServer } from "./settings/useRoomServer";
import { useRoles } from "./settings/useRoles";
import { useRecovery } from "./settings/useRecovery";

export default function Settings({
  ai,
  model,
  onModelChange,
  onModelsChanged,
  onClose,
}: Props) {
  // Each section owns its state + handlers via a per-concern hook. The shell
  // only threads those returns to the presentational section components and
  // owns cross-hook wiring (Behavior's Save clears the shared model error).
  const { modalRef, onModalKeyDown } = useFocusTrap(onClose);

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
  } = useBehaviorSettings(() => setError(""));

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

  const {
    mcpConfig,
    setMcpConfig,
    mcpStatuses,
    mcpError,
    connName,
    setConnName,
    connCmd,
    setConnCmd,
    connArgs,
    setConnArgs,
    applyMcp,
    addConnector,
  } = useMcpConfig();

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
          <button className="subtle btn-ic" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="settings-main">
          <nav className="settings-nav">
            {(
              [
                ["set-model", "Model"],
                ["set-behavior", "Behavior"],
                ["set-privacy", "Privacy"],
                ["set-online", "Online"],
                ["set-advisors", "AI advisors"],
                ["set-mcp", "Connections"],
                ["set-closet", "Remote AI"],
                ["set-leash", "Room server"],
                ["set-role", "Room role"],
                ["set-helpers", "AI helpers"],
                ["set-recovery", "Recovery key"],
              ] as [string, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="settings-nav-item"
                onClick={() =>
                  document
                    .getElementById(id)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-body">
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
            />

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

            <AdvisorsSection
              ai={ai}
              advisorsOn={advisorsOn}
              onAdvisorsToggle={onAdvisorsToggle}
              advisorToolsOn={advisorToolsOn}
              onAdvisorToolsToggle={onAdvisorToolsToggle}
              ENGINE_LABELS={ENGINE_LABELS}
              AlertIcon={AlertIcon}
            />

            <McpSection
              connName={connName}
              setConnName={setConnName}
              connCmd={connCmd}
              setConnCmd={setConnCmd}
              connArgs={connArgs}
              setConnArgs={setConnArgs}
              addConnector={addConnector}
              mcpConfig={mcpConfig}
              setMcpConfig={setMcpConfig}
              applyMcp={applyMcp}
              mcpStatuses={mcpStatuses}
              mcpError={mcpError}
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

          {error && <div className="gate-error">{error}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
