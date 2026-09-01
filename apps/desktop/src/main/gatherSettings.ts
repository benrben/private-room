import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting } from "./db-host/settings.js";

export function modelSetting(db: Database.Database): string | null {
  return getSetting(db, "model");
}

export function webAccessEnabled(db: Database.Database): boolean {
  const value = getSetting(db, "web_provider");
  return value !== null && value !== "" && value !== "off";
}

export function advisorsEnabled(db: Database.Database): boolean {
  return getSetting(db, "advisors_enabled") === "on";
}

export function advisorToolsEnabled(db: Database.Database): boolean {
  return getSetting(db, "advisor_tools_enabled") === "on";
}

export function parseTemperature(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
