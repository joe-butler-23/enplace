import * as React from "react";
import { useEffectEvent } from "./use-effect-event";

/**
 * Closes an open menu on Escape or on a pointer press that lands outside it. Listeners attach in
 * the commit that opens the menu, so there is no frame in which it is open but not dismissible.
 */
export function useDismiss(open: boolean, inside: (target: Element) => boolean, close: () => void): void {
  const isInside = useEffectEvent(inside);
  const dismiss = useEffectEvent(close);
  React.useLayoutEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !isInside(event.target)) dismiss();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", key);
    };
  }, [open, isInside, dismiss]);
}
