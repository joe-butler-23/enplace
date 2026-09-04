import type { CookbookConnection } from "@/host-client/cookbook-storage";

let active: CookbookConnection | null = null;
const listeners = new Set<() => void>();
export const currentCookbookConnection = (): CookbookConnection | null => active;
export function setCurrentCookbookConnection(connection: CookbookConnection | null): void {
  active = connection;
  listeners.forEach((listener) => listener());
}
export function onCurrentCookbookConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
