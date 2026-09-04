import type { RecipeIndexSort } from "./modules/cooking/types";

export interface CookingAssistantSettings {
  databaseSort: RecipeIndexSort;
  databaseMarkedFilter: "all" | "marked" | "unmarked";
  databaseScheduledFilter: "all" | "scheduled" | "unscheduled";
}
