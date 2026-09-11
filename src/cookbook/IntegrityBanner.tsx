import * as React from "react";
import { useSyncExternalStore } from "react";
import { currentCookbookConnection, onCurrentCookbookConnection } from "./current";

// One module-level binding mirrors store.ts: the current connection can change (a new
// cookbook opened), so the subscription follows it rather than being fixed at mount.
let bound = currentCookbookConnection();
let unsubscribeIntegrity: (() => void) | null = null;
let unreadable = bound?.integrity() ?? 0;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((listener) => listener());

function bind(): void {
  const next = currentCookbookConnection();
  if (next === bound && unsubscribeIntegrity) return;
  unsubscribeIntegrity?.();
  bound = next;
  unreadable = bound?.integrity() ?? 0;
  unsubscribeIntegrity = bound ? bound.onIntegrity((count) => { unreadable = count; emit(); }) : null;
  emit();
}
onCurrentCookbookConnection(bind);
bind();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getUnreadable = (): number => unreadable;

/**
 * A record that failed to authenticate is quarantined, not applied, and never deleted — so it
 * stays readable for another device even though this one cannot open it. This banner reports
 * that count plainly and permanently; it never dismisses itself, because the quarantined
 * records remain until the household exports and re-shares the cookbook from Settings.
 */
export function IntegrityBanner(): React.JSX.Element | null {
  const count = useSyncExternalStore(subscribe, getUnreadable, getUnreadable);
  if (!count) return null;
  return (
    <div role="alert" className="mep-integrity-banner">
      {count} shared records could not be read and were skipped. Export a copy from Settings.
    </div>
  );
}
