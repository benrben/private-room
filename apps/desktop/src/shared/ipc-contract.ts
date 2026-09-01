/** Stable IPC contract facade assembled from disjoint command domains. */
import type { AutomationCommands } from "./ipcAutomationCommands.js";
import type { MediaCommands } from "./ipcMediaCommands.js";
import type { RoomCommands } from "./ipcRoomCommands.js";

export interface Commands extends RoomCommands, AutomationCommands, MediaCommands {}

export * from "./ipcAutomationCommands.js";
export * from "./ipcMediaCommands.js";
export * from "./ipcRoomCommands.js";
