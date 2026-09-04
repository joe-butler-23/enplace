import type { CookingAssistantSettings } from "@/settings";

export type StandaloneSettings = CookingAssistantSettings;

export const DEFAULT_STANDALONE_SETTINGS: StandaloneSettings = {
  databaseSort: "added-desc",
  databaseMarkedFilter: "all",
  databaseScheduledFilter: "all",
  weeklyOrganiserMarkedWidth: 240
};
