// Player settings, persisted in localStorage.
import type { Quality } from "../render/worldView";

export interface Settings {
  /** Radians per mouse pixel = sensitivity * 0.0022. */
  sensitivity: number;
  /** Extra multiplier while aiming (ADS). */
  aimSensitivity: number;
  invertY: boolean;
  fov: number;
  volume: number;
  quality: Quality;
  shoulder: 1 | -1;
  showFps: boolean;
}

const KEY = "isola.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1,
  aimSensitivity: 0.7,
  invertY: false,
  fov: 72,
  volume: 0.8,
  quality: "medium",
  shoulder: 1,
  showFps: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* private mode etc. */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
