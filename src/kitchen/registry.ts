import { isKitchenId } from "./doc";

const CURRENT_KITCHEN_KEY = "enplace-current-kitchen";

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function currentKitchenId(): string | null {
  const value = storage()?.getItem(CURRENT_KITCHEN_KEY) ?? "";
  return isKitchenId(value) ? value : null;
}

export function setCurrentKitchenId(id: string): void {
  if (!isKitchenId(id)) throw new Error("Invalid kitchen id.");
  storage()?.setItem(CURRENT_KITCHEN_KEY, id);
}

export function clearCurrentKitchenId(): void {
  storage()?.removeItem(CURRENT_KITCHEN_KEY);
}
