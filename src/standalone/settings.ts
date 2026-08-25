import type { CookingAssistantSettings } from "@/settings";

export type StandaloneSettings = CookingAssistantSettings & {
  vaultPath: string;
};

export const DEFAULT_STANDALONE_SETTINGS: StandaloneSettings = {
  recipesFolder: "recipes",
  imagesFolder: "recipes/images",
  databaseSort: "added-desc",
  databaseMarkedFilter: "all",
  databaseScheduledFilter: "all",
  databaseCardMinWidth: 220,
  databaseMaxCards: 500,
  dayNotes: {},
  eventsFolder: "events",
  weeklyOrganiserMarkedWidth: 240,
  vaultPath: "~/vault"
};
