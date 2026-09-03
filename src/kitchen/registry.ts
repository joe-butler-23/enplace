import { isKitchenId } from "./doc";

const CURRENT_KITCHEN_KEY = "enplace-current-kitchen";
const RECENT_KITCHENS_KEY = "enplace-recent-kitchens";
const MAX_RECENT_KITCHENS = 8;

export type RecentKitchen = {
  id: string;
  label: string;
  lastOpened: number;
};

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function readRecentKitchens(): RecentKitchen[] {
  const value = storage()?.getItem(RECENT_KITCHENS_KEY);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentKitchen => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<RecentKitchen>;
      return typeof candidate.id === "string" && isKitchenId(candidate.id)
        && typeof candidate.label === "string" && candidate.label.length > 0
        && typeof candidate.lastOpened === "number" && Number.isFinite(candidate.lastOpened);
    });
  } catch {
    return [];
  }
}

function writeRecentKitchens(kitchens: RecentKitchen[]): void {
  storage()?.setItem(RECENT_KITCHENS_KEY, JSON.stringify(kitchens.slice(0, MAX_RECENT_KITCHENS)));
}

export function currentKitchenId(): string | null {
  const value = storage()?.getItem(CURRENT_KITCHEN_KEY) ?? "";
  return isKitchenId(value) ? value : null;
}

export function setCurrentKitchenId(id: string): void {
  if (!isKitchenId(id)) throw new Error("Invalid kitchen id.");
  storage()?.setItem(CURRENT_KITCHEN_KEY, id);
  const recent = readRecentKitchens();
  const existing = recent.find((kitchen) => kitchen.id === id);
  if (existing) rememberKitchen(id, existing.label);
}

export function clearCurrentKitchenId(): void {
  storage()?.removeItem(CURRENT_KITCHEN_KEY);
}

export function recentKitchens(): RecentKitchen[] {
  return readRecentKitchens().sort((left, right) => right.lastOpened - left.lastOpened);
}

export function rememberKitchen(id: string, label: string, lastOpened = Date.now()): void {
  if (!isKitchenId(id)) throw new Error("Invalid kitchen id.");
  const normalizedLabel = label.trim() || "Empty kitchen";
  const recent = readRecentKitchens().filter((kitchen) => kitchen.id !== id);
  writeRecentKitchens([{ id, label: normalizedLabel, lastOpened }, ...recent]);
}
