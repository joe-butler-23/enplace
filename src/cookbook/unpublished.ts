// Historical kitchens key stays unchanged so unpublished state survives the rename.
const UNPUBLISHED_COOKBOOKS_KEY = "enplace-unpublished-kitchens";

function unpublishedCookbookIds(): Set<string> {
  try {
    const ids = JSON.parse(localStorage.getItem(UNPUBLISHED_COOKBOOKS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** A cookbook seeded on this device that has not yet received a local write. */
export function isCookbookUnpublished(id: string): boolean {
  return unpublishedCookbookIds().has(id);
}

export function setCookbookUnpublished(id: string, unpublished: boolean): void {
  const ids = unpublishedCookbookIds();
  if (unpublished) ids.add(id);
  else ids.delete(id);
  if (ids.size) localStorage.setItem(UNPUBLISHED_COOKBOOKS_KEY, JSON.stringify([...ids]));
  else localStorage.removeItem(UNPUBLISHED_COOKBOOKS_KEY);
}
