import type { CookingAssistantSettings } from "@/settings";

export type StandaloneSettings = CookingAssistantSettings & {
  /** Legacy bootstrap input; browser commands ignore it. */
  vaultPath?: string;
};

export const DEFAULT_STANDALONE_SETTINGS: StandaloneSettings = {
  databaseSort: "added-desc",
  databaseMarkedFilter: "all",
  databaseScheduledFilter: "all",
  dayNotes: {},
  weeklyOrganiserMarkedWidth: 240
};
