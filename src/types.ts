export type Language = "zh" | "en";
export type ConfigView = {
  exists: boolean;
  base_url: string;
  model: string;
  key_present: boolean;
  encrypted: boolean;
  revision: string;
};
export type Settings = {
  silent_start: boolean;
  close_to_tray: boolean;
  language: Language;
  autostart: boolean;
  version: string;
  platform: string;
  tray_available: boolean;
  autostart_known?: boolean;
  warnings?: string[];
};
export type HistoryEntry = {
  id: string;
  timestamp: string;
  diff: { field: string; before: string | null; after: string | null }[];
  sha256: string;
  source: string;
};
