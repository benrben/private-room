import type { PrivacyScanProgress, PrivacyStatus } from "../apiTypes";

export type PrivacyActions = {
  toggleRoom: () => void;
  followDefault: () => void;
  toggleGlobal: () => void;
  addItem: () => void;
  removeItem: (id: string) => void;
  updateNewItem: (value: string) => void;
  updateCategory: (value: string) => void;
  updateConceptDraft: (value: string) => void;
  saveConcepts: () => void;
  startScan: () => void;
};

export type PrivacyPanelState = {
  status: PrivacyStatus | null;
  scan: PrivacyScanProgress | null;
  newItem: string;
  newCat: string;
  conceptDraft: string;
  err: string | null;
  conceptsSaved: boolean;
  conceptsErr: string | null;
  workspaceRoom: boolean;
  effectiveOn: boolean;
};

export function stopEscape(event: { key: string; stopPropagation: () => void }) {
  if (event.key === "Escape") event.stopPropagation();
}

export function scanIsRunning(
  scan: PrivacyScanProgress | null,
  status: PrivacyStatus | null,
) {
  return scan?.running === true || status?.scanning === true;
}

export function privacyConceptLines(draft: string) {
  return draft.split("\n").map((concept) => concept.trim()).filter(Boolean);
}
