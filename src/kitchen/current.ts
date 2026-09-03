import type { KitchenConnection } from "@/host-client/kitchen-storage";

let active: KitchenConnection | null = null;
const listeners = new Set<() => void>();
export const currentKitchenConnection = (): KitchenConnection | null => active;
export function setCurrentKitchenConnection(connection: KitchenConnection | null): void {
  active = connection;
  listeners.forEach((listener) => listener());
}
export function onCurrentKitchenConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
