import { setDayNote } from "../cookbook/plan-notes";
import { DEFAULT_STANDALONE_SETTINGS, type StandaloneSettings } from "./settings";

const SETTINGS_KEY = "enplace.preferences";
const persistedKeys = [
  "databaseSort",
  "databaseMarkedFilter",
  "databaseScheduledFilter",
  "weeklyOrganiserMarkedWidth"
] as const satisfies ReadonlyArray<keyof StandaloneSettings>;

export async function loadSettings(): Promise<StandaloneSettings> {
  const raw = window.localStorage.getItem(SETTINGS_KEY);
  if (raw === null || raw.trim() === "") return { ...DEFAULT_STANDALONE_SETTINGS };
  let stored: Partial<StandaloneSettings>;
  try {
    const parsed: unknown = JSON.parse(raw);
    stored = parsed && typeof parsed === "object" ? parsed as Partial<StandaloneSettings> : {};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid browser preferences: ${reason}`);
  }
  return Object.assign(
    { ...DEFAULT_STANDALONE_SETTINGS },
    Object.fromEntries(persistedKeys.map((key) => [key, stored[key] ?? DEFAULT_STANDALONE_SETTINGS[key]]))
  );
}

export async function saveSettings(settings: StandaloneSettings): Promise<void> {
  window.localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify(Object.fromEntries(persistedKeys.map((key) => [key, settings[key]])))
  );
}

export async function prepareStandaloneStartup(settings: StandaloneSettings): Promise<StandaloneSettings> {
  const raw = window.localStorage.getItem(SETTINGS_KEY);
  if (raw === null || raw.trim() === "") return settings;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return settings;
  const stored = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(stored, "dayNotes")) return settings;
  const notes = stored.dayNotes;
  if (notes && typeof notes === "object" && !Array.isArray(notes)) {
    for (const [date, note] of Object.entries(notes)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof note === "string" && note.trim()) {
        await setDayNote(date, note);
      }
    }
  }
  await saveSettings(settings);
  return settings;
}
