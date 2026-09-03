import type { RecipePlanning } from "@/core";
import { isIsoDateString } from "./scheduled-dates";

export { isIsoDateString };

export type RecipeDateRemovalResult = {
  removedSourceDate: boolean;
  remainingDates: string[];
  marked: boolean;
};

export type RecipeDateRemovalOptions = {
  markWhenEmpty?: boolean;
};

export function removeRecipeScheduledDateOccurrence(
  planning: RecipePlanning,
  sourceDate: string,
  options: RecipeDateRemovalOptions = {}
): RecipeDateRemovalResult {
  const nextDates = [...planning.scheduledDates];
  const sourceIndex = nextDates.indexOf(sourceDate);
  const removedSourceDate = sourceIndex !== -1;
  const markWhenEmpty = options.markWhenEmpty ?? true;

  if (removedSourceDate) {
    nextDates.splice(sourceIndex, 1);
  }

  planning.scheduledDates = nextDates;
  const marked = markWhenEmpty && nextDates.length === 0;
  planning.marked = marked;

  return {
    removedSourceDate,
    remainingDates: [...nextDates],
    marked
  };
}
