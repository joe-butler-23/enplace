import { isIsoDateString } from "./scheduled-dates";

export async function removePlannerRecipe(
  sourceColumnId: string | undefined,
  removeDateOccurrence: (date: string) => Promise<void>,
  unmarkRecipe: () => Promise<void>
): Promise<void> {
  if (isIsoDateString(sourceColumnId)) {
    await removeDateOccurrence(sourceColumnId);
    return;
  }
  await unmarkRecipe();
}
