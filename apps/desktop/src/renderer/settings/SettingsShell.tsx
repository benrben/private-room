import { useEffect } from "react";
import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AlertIcon } from "../icons";
import { bestLocalModel } from "../workspace/localModel";
import { RECOMMENDED_MODELS } from "../workspace/constants";
import AppearanceSection from "./AppearanceSection";
import AboutSection from "./AboutSection";
import CheckpointsSection from "./CheckpointsSection";
import InterfaceSection from "./InterfaceSection";
import VoiceSection from "./VoiceSection";
import MicSection from "./MicSection";
import SavedVoicesSection from "./SavedVoicesSection";
import type { Props } from "./types";

export const SETTINGS_GROUPS: {
  key: string;
  label: string;
  sections: string[];
}[] = [
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

const GROUP_OF_SECTION: Record<string, string> = Object.fromEntries(
  SETTINGS_GROUPS.flatMap((group) =>
    group.sections.map((section) => [section, group.key]),
  ),
);

const GROUP_NAVIGATION: Record<
  string,
  (current: number, last: number) => number
> = {
  ArrowDown: (current, last) => (current >= last ? 0 : current + 1),
  ArrowUp: (current, last) => (current <= 0 ? last : current - 1),
  Home: () => 0,
  End: (_current, last) => last,
};

export function initialSettingsGroup(
  initialSection: string | null | undefined,
): string {
  if (initialSection === null || initialSection === undefined) {
    return SETTINGS_GROUPS[0].key;
  }
  return GROUP_OF_SECTION[initialSection] ?? SETTINGS_GROUPS[0].key;
}

export function settingsGroupNavigationTarget(
  key: string,
  activeGroup: string,
): number | null {
  const navigate = GROUP_NAVIGATION[key];
  if (navigate === undefined) return null;
  const current = SETTINGS_GROUPS.findIndex(
    (group) => group.key === activeGroup,
  );
  return navigate(current, SETTINGS_GROUPS.length - 1);
}

export function useInitialSectionNavigation(
  initialSection: string | null | undefined,
  setActiveGroup: (group: string) => void,
): void {
  useEffect(() => {
    if (!initialSection) return;
    const group = GROUP_OF_SECTION[initialSection];
    if (group) setActiveGroup(group);
    const timer = window.setTimeout(() => {
      const element = document.getElementById(initialSection);
      if (!element) return;
      element.scrollIntoView({ block: "start" });
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
      element.classList.add("settings-section-flash");
      window.setTimeout(
        () => element.classList.remove("settings-section-flash"),
        1400,
      );
    }, 40);
    return () => window.clearTimeout(timer);
  }, [initialSection, setActiveGroup]);
}

export function useSettingsPageScroll(
  activeGroup: string,
  bodyRef: { current: HTMLDivElement | null },
): void {
  useEffect(() => {
    const element = bodyRef.current;
    if (element) element.scrollTop = 0;
  }, [activeGroup, bodyRef]);
}

export function settingsDirtyPages(
  tuningDirty: boolean,
  voiceDirty: boolean,
  webDirty: boolean,
  closetDirty: boolean,
): Set<string> {
  const pageStates = {
    ai: tuningDirty,
    voice: voiceDirty,
    connections: webDirty || closetDirty,
  };
  return new Set(
    Object.entries(pageStates).flatMap(([page, dirty]) =>
      dirty ? [page] : [],
    ),
  );
}

export function hasUnsavedSettingsWork(...dirtyStates: boolean[]): boolean {
  return dirtyStates.some(Boolean);
}

export function dismissStaleCloseConfirmation(
  confirmClose: boolean,
  unsaved: boolean,
  setConfirmClose: (visible: boolean) => void,
): void {
  if (confirmClose && !unsaved) setConfirmClose(false);
}

export function SettingsClosePrompt({
  visible,
  keepEditingRef,
  onKeepEditing,
  onDiscard,
}: {
  visible: boolean;
  keepEditingRef: { current: HTMLButtonElement | null };
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="settings-unsaved" role="alert">
      <AlertIcon size={16} />
      <span>
        Some changes on this page haven't been saved yet — closing now would
        discard them.
      </span>
      <button className="subtle" ref={keepEditingRef} onClick={onKeepEditing}>
        Keep editing
      </button>
      <button className="subtle danger" onClick={onDiscard}>
        Discard &amp; close
      </button>
    </div>
  );
}

export function SettingsModelError({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div className="gate-error" role="alert">
      {error}
    </div>
  );
}

export function defaultAiFallbackModel(ai: Props["ai"]): string {
  const models = ai?.models ?? [];
  return (
    bestLocalModel(
      models,
      RECOMMENDED_MODELS.map((model) => model.name),
    ) ?? RECOMMENDED_MODELS[0].name
  );
}

export function SettingsNavigation({
  activeGroup,
  dirtyPages,
  tabRefs,
  onKeyDown,
  setActiveGroup,
}: {
  activeGroup: string;
  dirtyPages: Set<string>;
  tabRefs: { current: (HTMLButtonElement | null)[] };
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  setActiveGroup: (group: string) => void;
}) {
  return (
    <nav
      className="settings-nav"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Settings pages"
      onKeyDown={onKeyDown}
    >
      {SETTINGS_GROUPS.map((group, index) => (
        <button
          key={group.key}
          type="button"
          role="tab"
          id={`settings-tab-${group.key}`}
          aria-controls={`settings-page-${group.key}`}
          aria-selected={activeGroup === group.key}
          tabIndex={activeGroup === group.key ? 0 : -1}
          ref={(element) => {
            tabRefs.current[index] = element;
          }}
          className={`settings-nav-item${activeGroup === group.key ? " is-active" : ""}`}
          onClick={() => setActiveGroup(group.key)}
        >
          <span className="settings-nav-label">{group.label}</span>
          {dirtyPages.has(group.key) && (
            <span className="nb-tape nb-sem-pending settings-nav-flag">
              Unsaved
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

export function SettingsVoicePage({
  activeGroup,
  voiceSettings,
}: {
  activeGroup: string;
  voiceSettings: ComponentProps<typeof VoiceSection>;
}) {
  return (
    <div
      className="settings-page"
      id="settings-page-voice"
      role="tabpanel"
      aria-labelledby="settings-tab-voice"
      hidden={activeGroup !== "voice"}
    >
      <VoiceSection {...voiceSettings} />
      <MicSection />
      <SavedVoicesSection />
    </div>
  );
}

export function SettingsHistoryPage({
  activeGroup,
  checkpoints,
  busy,
}: {
  activeGroup: string;
  checkpoints: Omit<ComponentProps<typeof CheckpointsSection>, "busy">;
  busy: Props["busy"];
}) {
  return (
    <div
      className="settings-page"
      id="settings-page-history"
      role="tabpanel"
      aria-labelledby="settings-tab-history"
      hidden={activeGroup !== "history"}
    >
      <CheckpointsSection {...checkpoints} busy={busy} />
    </div>
  );
}

export function SettingsAppPage({
  activeGroup,
  onApplyPreset,
}: {
  activeGroup: string;
  onApplyPreset: Props["onApplyPreset"];
}) {
  return (
    <div
      className="settings-page"
      id="settings-page-app"
      role="tabpanel"
      aria-labelledby="settings-tab-app"
      hidden={activeGroup !== "app"}
    >
      <AppearanceSection />
      <InterfaceSection onApplyPreset={onApplyPreset} />
      <AboutSection />
    </div>
  );
}
