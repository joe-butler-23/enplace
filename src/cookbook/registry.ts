import { isCookbookId } from "./doc";

// Historical kitchen key stays unchanged so existing selections still open.
const CURRENT_COOKBOOK_KEY = "enplace-current-kitchen";

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function currentCookbookId(): string | null {
  const value = storage()?.getItem(CURRENT_COOKBOOK_KEY) ?? "";
  return isCookbookId(value) ? value : null;
}

export function setCurrentCookbookId(id: string): void {
  if (!isCookbookId(id)) throw new Error("Invalid cookbook id.");
  storage()?.setItem(CURRENT_COOKBOOK_KEY, id);
}

export function clearCurrentCookbookId(): void {
  storage()?.removeItem(CURRENT_COOKBOOK_KEY);
}
