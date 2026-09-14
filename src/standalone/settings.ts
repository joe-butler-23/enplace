import type { CookingAssistantSettings } from "@/settings";

export type StandaloneSettings = CookingAssistantSettings & {
  acknowledgedCookbookIds: string[];
  helpAcknowledged: boolean;
};

export const DEFAULT_STANDALONE_SETTINGS: StandaloneSettings = {
  databaseSort: "added-desc",
  databaseMarkedFilter: "all",
  databaseScheduledFilter: "all",
  acknowledgedCookbookIds: [],
  helpAcknowledged: false,
};
