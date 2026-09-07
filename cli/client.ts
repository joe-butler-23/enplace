import { openCookingSession } from "../src/agent/session";
import { readAssociation } from "./association";

type CookbookCall = (operation: string, args: Record<string, unknown>) => Promise<unknown>;

/** Reuse the configured encrypted connection; every mutation still awaits its durable save. */
export async function withCookbook<T>(callback: (call: CookbookCall) => T | Promise<T>, options: { config?: string; signal?: AbortSignal } = {}): Promise<T> {
  const session = await openCookingSession({ ...await readAssociation(options.config), signal: options.signal });
  let accepting = true, stopped = false;
  let pending: Promise<unknown> = Promise.resolve();
  const call: CookbookCall = (operation, args) => {
    if (!accepting) return Promise.reject(new Error("Cookbook client is closed."));
    const next = pending.then(() => {
      if (stopped) throw new Error("Cookbook client is closed.");
      return session.execute(operation, args, { signal: options.signal });
    });
    pending = next;
    // Keep failure in the chain, but observe ignored calls until the callback finishes.
    void next.catch(() => {});
    return next;
  };
  try {
    const result = await callback(call);
    accepting = false;
    await pending;
    return result;
  } finally {
    accepting = false;
    stopped = true;
    await pending.catch(() => {});
    await session.close();
  }
}
