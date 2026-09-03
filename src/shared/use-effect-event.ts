import { useCallback, useInsertionEffect, useRef } from "react";

/** Stable callback that always calls the implementation from the latest committed render. */
export function useEffectEvent<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useInsertionEffect(() => { callbackRef.current = callback; }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
