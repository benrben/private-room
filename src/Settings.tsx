import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ENGINE_LABELS } from "./api";
import { AlertIcon, CloseIcon, DownloadIcon, EyeIcon, TrashIcon } from "./icons";
import "./settingsA11y.css";
import { Props } from "./settings/types";
import ModelSection from "./settings/ModelSection";
import BehaviorSection from "./settings/BehaviorSection";
import VoiceSection from "./settings/VoiceSection";
import MicSection from "./settings/MicSection";
import SavedVoicesSection from "./settings/SavedVoicesSection";
import CloudPrivacySection from "./settings/CloudPrivacySection";
import PrivacySection from "./settings/PrivacySection";
import CheckpointsSection from "./settings/CheckpointsSection";
import OnlineSection from "./settings/OnlineSection";
import AdvisorsSection from "./settings/AdvisorsSection";
import RemoteAiSection from "./settings/RemoteAiSection";
import RoomServerSection from "./settings/RoomServerSection";
import RoleSection from "./settings/RoleSection";
import HelpersSection from "./settings/HelpersSection";
import SupportMatrixSection from "./settings/SupportMatrixSection";
import HarnessDiagnosticsSection from "./settings/HarnessDiagnosticsSection";
import RecoverySection from "./settings/RecoverySection";
import AboutSection from "./settings/AboutSection";
import AppearanceSection from "./settings/AppearanceSection";
import InterfaceSection from "./settings/InterfaceSection";
import AiProvidersSection from "./settings/AiProvidersSection";
import { bestLocalModel } from "./workspace/localModel";
import { RECOMMENDED_MODELS } from "./workspace/constants";
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
 * Each group is a page; `sections` lists the anchor ids it owns, which is what
 * routes a deep-link (the status-bar trust chip → Cloud privacy) to the right
 * page. Ids ONLY: each id used to carry a second, human label for in-page jump
 * links that were never built, so nothing rendered them — and two had already
 * drifted away from the headings they named ("Lock & password" for a section
 * titled Privacy, "Online search" for Online features). A label nothing draws
 * cannot be noticed when it goes wrong, so the headings are the single copy. */
const SETTINGS_GROUPS: { key: string; label: string; sections: string[] }[] = [
  {
    key: "ai",
    label: "AI & behavior",
    sections: [
      "set-model",
      "set-behavior",
      "set-role",
      "set-helpers",
      "set-support-matrix",
      "set-agent-harness",
      "set-advisors",
    ],
  },
  {
    key: "voice",
    label: "Voice",
    sections: ["set-voice", "set-mic", "set-voice-ids"],
  },
  {
    key: "privacy",
    label: "Privacy & recovery",
    sections: ["set-cloud-privacy", "set-privacy", "set-recovery"],
  },
  {
    key: "connections",
    label: "Connections",
    sections: ["set-ai-providers", "set-online", "set-closet", "set-leash"],
  },
  { key: "history", label: "History & storage", sections: ["set-checkpoints"] },
  {
    key: "app",
    label: "App",
    sections: ["set-appearance", "set-interface", "set-about"],
  },
];

/** section id → the page it lives on, so a deep-link opens the right page. */
const GROUP_OF_SECTION: Record<string, string> = Object.fromEntries(
  SETTINGS_GROUPS.flatMap((g) => g.sections.map((id) => [id, g.key])),
);

export default function Settings({
  ai,
  model,
  onModelChange,
  onModelsChanged,
  onClose,
  busy,
  initialSection,
  onApplyPreset,
}: Props) {
  // Each section owns its state + handlers via a per-concern hook. The shell
  // only threads those returns to the presentational section components and
  // owns cross-hook wiring (Behavior's Save clears the shared model error).
  // CLOSING MUST NOT DESTROY WORK. Most of Settings applies on change, but
  // five things do not — custom instructions, the creativity slider, the voice
  // choice, the remote-AI address and the whole internet section — and Escape
  // or a click on the backdrop closed the modal instantly, taking a paragraph
  // of carefully written instructions with it and saying nothing. Deliberate
  // exits (Save, then close) are unaffected; only an exit that would DROP
  // something now stops to ask.
  //
  // Read through a ref because `useFocusTrap` owns the Escape key and has to be
  // set up before the section hooks that know whether anything is dirty exist.
  const unsavedRef = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  function requestClose() {
    if (unsavedRef.current) {
      // Escape RAISED the question, so Escape has to be able to answer it: the
      // repeat press only re-set the same flag, so the second and third press
      // did nothing at all and the modal read as frozen.
      if (confirmClose) {
        keepEditing();
        return;
      }
      setConfirmClose(true);
      return;
    }
    onClose();
  }
  // Dropping the strip leaves focus on a button that no longer exists, i.e. on
  // <body>, outside the trap — the same hole `refocusModal` covers for the
  // backdrop click.
  function keepEditing() {
    setConfirmClose(false);
    refocusModal();
  }
  const { modalRef, onModalKeyDown, refocusModal } = useFocusTrap(requestClose);
  // The strip is announced (role="alert") but focus stayed where it was, several
  // Tab stops before either answer, in DOM order behind the page index.
  useEffect(() => {
    if (confirmClose) keepEditingRef.current?.focus();
  }, [confirmClose]);
  // A backdrop click with unsaved work leaves the modal open and focus on
  // <body>, outside the trap — see `refocusModal`.
  function backdropClick() {
    requestClose();
    if (unsavedRef.current) refocusModal();
  }
  // The one scrolling container all six pages share (they're all mounted at
  // once and only toggled via `hidden` — see the module comment). Needed so
  // a tab switch can reset scroll position; see the effect below.
  const bodyRef = useRef<HTMLDivElement>(null);

  // Which settings page is showing. Deep-links (initialSection) open on the page
  // that owns the section; otherwise start on AI & behavior.
  const [activeGroup, setActiveGroup] = useState<string>(
    (initialSection && GROUP_OF_SECTION[initialSection]) || SETTINGS_GROUPS[0].key,
  );
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // A tablist is driven by the arrows, and the selection follows them — the
  // index is six buttons that all do the same kind of thing, so moving through
  // it is the whole interaction.
  function onNavKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    const last = SETTINGS_GROUPS.length - 1;
    const at = SETTINGS_GROUPS.findIndex((g) => g.key === activeGroup);
    let next = -1;
    if (e.key === "ArrowDown") next = at >= last ? 0 : at + 1;
    else if (e.key === "ArrowUp") next = at <= 0 ? last : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next < 0) return;
    e.preventDefault();
    setActiveGroup(SETTINGS_GROUPS[next].key);
    tabRefs.current[next]?.focus();
  }

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
      // The trap put focus on Close while the viewport showed a section three
      // pages down: a keyboard user arriving from the trust chip had to tab
      // back to what they were sent to look at.
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
      el.classList.add("settings-section-flash");
      window.setTimeout(() => el.classList.remove("settings-section-flash"), 1400);
    }, 40);
    return () => window.clearTimeout(t);
  }, [initialSection]);

  // All six pages share one scrolling element (.settings-body), toggled with
  // `hidden` rather than mounted/unmounted, so without this a page opens
  // wherever the PREVIOUS page happened to be scrolled to — landing mid-page
  // with no visible heading. Keyed on activeGroup alone, not initialSection,
  // so it fires only on a real page change and never races the deep-link
  // effect above: when a deep-link targets a section on the page that's
  // already active, GROUP_OF_SECTION resolves to the same key, setActiveGroup
  // is a no-op (same value), this effect's dependency hasn't changed so it
  // does not re-run, and el.scrollIntoView is free to scroll within the page
  // as intended. When a deep-link DOES change pages, this effect's synchronous
  // reset always lands before the deep-link's own scroll, which is deferred
  // behind a setTimeout.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = 0;
  }, [activeGroup]);

  const {
    pullName,
    setPullName,
    pulling,
    pull,
    stopPull,
    stoppingPull,
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
    cancelStt,
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
    groundingModel,
    visionBlock,
    embedInstalled,
  } = useModelManagement(ai, onModelsChanged);

  const {
    temperature,
    setTemperature,
    instructions,
    setInstructions,
    saveTuning,
    saved,
    tuningDirty,
    responseStyle,
    changeResponseStyle,
    autoIndex,
    changeAutoIndex,
    memoryAutoSave,
    changeMemoryAutoSave,
    editApproval,
    changeEditApproval,
    adaptiveTextEnabled,
    changeAdaptiveTextEnabled,
  } = useBehaviorSettings(() => setError(""));

  // Only the page the user is actually looking at may reach the network: the
  // voice catalog lives off the Mac, and every Settings page is mounted at once.
  const voiceSettings = useVoiceSettings(activeGroup === "voice");

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
    webOn,
    setWebOn,
    webSaved,
    webDirty,
    webError,
    webTesting,
    webTestResult,
    saveWebAccess,
    testWebSearch,
    searchAgent,
    setSearchAgent,
    browseAgent,
    setBrowseAgent,
    resultPreviews,
    setResultPreviews,
  } = useOnlineSearch();

  const { advisorsOn, advisorToolsOn, onAdvisorsToggle, onAdvisorToolsToggle } =
    useAdvisors();

  const {
    closetUrl,
    setClosetUrl,
    closetDirty,
    saveOllamaUrl,
    closetSaved,
    testOllama,
    closetTesting,
    closetTestResult,
  } = useRemoteAi();

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

  const { roles, role, changeRole, roleError } = useRoles();

  const {
    recoveryCode,
    recoveryCopied,
    setRecoveryCopied,
    setRecoveryCode,
    recoveryBusy,
    createRecoveryKey,
    recoveryErr,
  } = useRecovery();

  // Every Save-button section that can hold work the room does not have yet.
  // Written on each render (idempotent) so the Escape handler above, which was
  // created before these hooks ran, sees the current answer.
  const unsaved =
    tuningDirty || voiceSettings.voiceDirty || webDirty || closetDirty;
  unsavedRef.current = unsaved;
  // …and WHICH page is holding it, so the index can say so. This is a display
  // of the four dirty flags above, not a fifth source of truth: only sections
  // with a real deferred Save appear here. Everything else on this surface
  // applies the moment you change it, and flagging those as "unsaved" would be
  // a lie. Custom instructions + creativity live on AI & behavior; the voice
  // choice on Voice; the internet switch and the remote-AI address both on
  // Connections.
  const dirtyPages = new Set<string>();
  if (tuningDirty) dirtyPages.add("ai");
  if (voiceSettings.voiceDirty) dirtyPages.add("voice");
  if (webDirty || closetDirty) dirtyPages.add("connections");
  // A section that got saved while the warning was up leaves nothing to warn
  // about — drop the strip rather than make the user dismiss a stale question.
  if (confirmClose && !unsaved) setConfirmClose(false);

  return (
    // ADD-25: consent surface — the agent UI driver must never see or operate
    // Settings (web/cloud/advisor/room-server switches, password, Touch ID).
    <div className="settings-backdrop" data-agent-blocked onClick={backdropClick}>
      {/* `settings-sheet` is the real Settings modal, as opposed to the two
          smaller sheets in workspace/SettingsModals.tsx that reuse the same
          `.settings*` chrome. Everything that would be wrong at 460px — the
          width, the index, the group frames — is scoped to it. */}
      <div
        className="settings settings-sheet"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <span id="settings-title" className="settings-head-title">
            Settings
          </span>
          <button
            className="subtle btn-ic"
            aria-label="Close settings"
            title="Close settings"
            onClick={requestClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        {confirmClose && (
          <div className="settings-unsaved" role="alert">
            <AlertIcon size={16} />
            <span>
              Some changes on this page haven't been saved yet — closing now
              would discard them.
            </span>
            <button className="subtle" ref={keepEditingRef} onClick={keepEditing}>
              Keep editing
            </button>
            <button className="subtle danger" onClick={onClose}>
              Discard &amp; close
            </button>
          </div>
        )}
        <div className="settings-main">
          {/* One focused page at a time. The rail selects the page; the section
              anchors below (and deep-links) still resolve within the open page. */}
          <nav
            className="settings-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings pages"
            onKeyDown={onNavKeyDown}
          >
            {SETTINGS_GROUPS.map((g, i) => (
              <button
                key={g.key}
                type="button"
                role="tab"
                id={`settings-tab-${g.key}`}
                aria-controls={`settings-page-${g.key}`}
                aria-selected={activeGroup === g.key}
                // One tab stop for the whole index instead of six before the
                // first control; the arrows move within it.
                tabIndex={activeGroup === g.key ? 0 : -1}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                className={`settings-nav-item${activeGroup === g.key ? " is-active" : ""}`}
                onClick={() => setActiveGroup(g.key)}
              >
                <span className="settings-nav-label">{g.label}</span>
                {/* The flag is a WORD on a marker strip, not a coloured dot:
                    it has to be readable in greyscale and it has to reach a
                    screen reader, which it does by joining the button's own
                    accessible name ("Voice, Unsaved"). */}
                {dirtyPages.has(g.key) && (
                  <span className="nb-tape nb-sem-pending settings-nav-flag">
                    Unsaved
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="settings-body" ref={bodyRef}>
            <div
              className="settings-page"
              id="settings-page-ai"
              role="tabpanel"
              aria-labelledby="settings-tab-ai"
              hidden={activeGroup !== "ai"}>
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
                stopPull={stopPull}
                stoppingPull={stoppingPull}
                pullStatus={pullStatus}
                pullPercent={pullPercent}
                stt={stt}
                removeStt={removeStt}
                sttPercent={sttPercent}
                downloadStt={downloadStt}
                cancelStt={cancelStt}
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
              {/* Model errors (a failed or cancelled download, a removal that
                  would not go through) used to render at the bottom of the
                  shared scroller, so they appeared under whichever page was
                  open — a pull that failed here printed its reason on Voice,
                  attached to nothing. They belong on the page that produced
                  them. */}
              {error && (
                <div className="gate-error" role="alert">
                  {error}
                </div>
              )}
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
                adaptiveTextEnabled={adaptiveTextEnabled}
                changeAdaptiveTextEnabled={changeAdaptiveTextEnabled}
              />
              <RoleSection
                roles={roles}
                role={role}
                changeRole={changeRole}
                roleError={roleError}
              />
              <HelpersSection
                ai={ai}
                visionInstalled={visionInstalled}
                groundingModel={groundingModel}
                visionBlock={visionBlock}
                recommended={recommended}
                pullSpecial={pullSpecial}
                pullingSpecial={pullingSpecial}
                pulling={pulling}
                stopPull={stopPull}
                stoppingPull={stoppingPull}
                embedInstalled={embedInstalled}
                pullPercent={pullPercent}
                pullStatus={pullStatus}
                DownloadIcon={DownloadIcon}
              />
              <SupportMatrixSection />
              <HarnessDiagnosticsSection />
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

            <div
              className="settings-page"
              id="settings-page-voice"
              role="tabpanel"
              aria-labelledby="settings-tab-voice"
              hidden={activeGroup !== "voice"}>
              <VoiceSection {...voiceSettings} />
              <MicSection />
              <SavedVoicesSection />
            </div>

            <div
              className="settings-page"
              id="settings-page-privacy"
              role="tabpanel"
              aria-labelledby="settings-tab-privacy"
              hidden={activeGroup !== "privacy"}>
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

            <div
              className="settings-page"
              id="settings-page-connections"
              role="tabpanel"
              aria-labelledby="settings-tab-connections"
              hidden={activeGroup !== "connections"}>
              <AiProvidersSection
                model={model}
                // What a room falls back to when its OpenRouter model is
                // disconnected. The first entry of Ollama's raw /api/tags order
                // can be nomic-embed-text (installed for semantic search, and
                // 400s on /api/chat), and `ai.defaultModel` echoes the room's
                // saved model — in a cloud room that IS the model being
                // disconnected. Ask in the host's own preference order instead.
                fallbackModel={
                  bestLocalModel(
                    ai?.models ?? [],
                    RECOMMENDED_MODELS.map((m) => m.name),
                  ) ?? RECOMMENDED_MODELS[0].name
                }
                onModelChange={onModelChange}
                onChanged={onModelsChanged}
              />
              <OnlineSection
                webOn={webOn}
                setWebOn={setWebOn}
                webTesting={webTesting}
                testWebSearch={testWebSearch}
                saveWebAccess={saveWebAccess}
                webSaved={webSaved}
                webDirty={webDirty}
                webError={webError}
                webTestResult={webTestResult}
                AlertIcon={AlertIcon}
                searchAgent={searchAgent}
                setSearchAgent={setSearchAgent}
                browseAgent={browseAgent}
                setBrowseAgent={setBrowseAgent}
                resultPreviews={resultPreviews}
                setResultPreviews={setResultPreviews}
              />
              <RemoteAiSection
                closetUrl={closetUrl}
                setClosetUrl={setClosetUrl}
                saveOllamaUrl={saveOllamaUrl}
                closetSaved={closetSaved}
                testOllama={testOllama}
                closetTesting={closetTesting}
                closetTestResult={closetTestResult}
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

            <div
              className="settings-page"
              id="settings-page-history"
              role="tabpanel"
              aria-labelledby="settings-tab-history"
              hidden={activeGroup !== "history"}>
              <CheckpointsSection {...checkpoints} busy={busy} />
            </div>

            <div
              className="settings-page"
              id="settings-page-app"
              role="tabpanel"
              aria-labelledby="settings-tab-app"
              hidden={activeGroup !== "app"}>
              <AppearanceSection />
              <InterfaceSection onApplyPreset={onApplyPreset} />
              <AboutSection />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
