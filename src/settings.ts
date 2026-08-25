import type { RecipeIndexSort } from "./modules/cooking/services/RecipeIndexService";
import settingsDefaults from "./settings.defaults.json";

export interface CookingAssistantSettings {
  recipesFolder: string;
  imagesFolder: string;
  databaseSort: RecipeIndexSort;
  databaseMarkedFilter: "all" | "marked" | "unmarked";
  databaseScheduledFilter: "all" | "scheduled" | "unscheduled";
  databaseCardMinWidth: number;
  databaseMaxCards: number;
  dayNotes: Record<string, string>;
  eventsFolder: string;
  weeklyOrganiserMarkedWidth: number;
}

const DEFAULT_SETTINGS: CookingAssistantSettings = settingsDefaults as CookingAssistantSettings;
