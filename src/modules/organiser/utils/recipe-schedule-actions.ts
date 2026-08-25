import {
  isIsoDateString,
  readScheduledDateList,
  writeScheduledDateList,
} from "./scheduled-dates";

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
  frontmatter: Record<string, unknown>,
  sourceDate: string,
  options: RecipeDateRemovalOptions = {}
): RecipeDateRemovalResult {
  const nextDates = readScheduledDateList(frontmatter);
  const sourceIndex = nextDates.indexOf(sourceDate);
  const removedSourceDate = sourceIndex !== -1;
  const markWhenEmpty = options.markWhenEmpty ?? true;

  if (removedSourceDate) {
    nextDates.splice(sourceIndex, 1);
  }

  writeScheduledDateList(frontmatter, nextDates);

  const marked = markWhenEmpty && nextDates.length === 0;
  if (marked) {
    frontmatter.marked = true;
  } else {
    delete frontmatter.marked;
  }

  return {
    removedSourceDate,
    remainingDates: [...nextDates],
    marked
  };
}
