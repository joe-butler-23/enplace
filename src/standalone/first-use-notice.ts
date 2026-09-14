export function shouldShowFirstUseNotice(
  cookbookId: string,
  acknowledgedCookbookIds: readonly string[],
  untouched: boolean,
): boolean {
  return !untouched && !acknowledgedCookbookIds.includes(cookbookId);
}

export function acknowledgeCookbookLink(
  acknowledgedCookbookIds: readonly string[],
  cookbookId: string,
): string[] {
  return acknowledgedCookbookIds.includes(cookbookId)
    ? [...acknowledgedCookbookIds]
    : [...acknowledgedCookbookIds, cookbookId];
}
