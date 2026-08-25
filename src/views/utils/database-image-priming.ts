export function isDatabaseImagePriming(
  databaseDemanded: boolean,
  databaseIsPending: boolean,
  items: readonly unknown[],
  coversSettled: boolean
): boolean {
  return databaseDemanded && (databaseIsPending || (
    items.length > 0 && !coversSettled
  ));
}

export function shouldIssueDetailPrewarm(activeView: string, databaseImagesArePriming: boolean): boolean {
  return activeView !== "database" && !databaseImagesArePriming;
}
