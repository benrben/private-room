import type { MenuItemConstructorOptions } from "electron";

export type Row =
  | { kind: "platform"; role: MenuItemConstructorOptions["role"] }
  | { kind: "separator" }
  | { kind: "command"; id: string; label: string; accelerator?: string }
  | { kind: "check"; id: string; label: string; accelerator?: string }
  | { kind: "nested"; label: string; rows: Row[] };

export interface Section {
  id: string;
  label: string | null;
  rows: Row[];
}

export interface ViewMenuState {
  enabled: boolean;
  library: boolean;
  assistant: boolean;
  focus: boolean;
  railLabels: boolean;
  railLabelsSettable: boolean;
  sidebar: string;
}

export interface MainWindowLike {
  webContents: { send: (channel: string, ...args: unknown[]) => void };
  close: () => void;
}

export interface QuitDoorLike {
  holdForUnsaved(code: number | null): boolean;
}

export interface DispatchDeps {
  quitDoor: QuitDoorLike;
  getMainWindow: () => MainWindowLike | null | undefined;
  isRoomOpen: () => boolean;
  appExit: () => void;
}
