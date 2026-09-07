import { openCookbook, type CookbookConnection } from "../host-client/cookbook-storage";
import { COOKING_OPERATIONS, executeCookingOperation } from "./operations";

export type CookingSessionOptions = {
  id: string;
  relayUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  create?: boolean;
};

/** One in-memory encrypted peer. Successful mutations wait for durable relay persistence. */
export async function openCookingSession(options: CookingSessionOptions) {
  const cookbook: CookbookConnection = await openCookbook({
    id: options.id, relayUrl: options.relayUrl, persist: false,
    signal: options.signal, ...(options.create ? { seed: () => {} } : {}),
  });
  const wait = { signal: options.signal, timeoutMs: options.timeoutMs ?? 20_000 };
  try { await cookbook.ready(wait); } catch (error) { await cookbook.close(); throw error; }
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;
  return {
    cookbook,
    execute(name: string, args: Record<string, unknown>, request: { signal?: AbortSignal } = {}): Promise<unknown> {
      if (closed) return Promise.reject(new Error("Cooking session is closed."));
      const signals = [options.signal, request.signal].filter((signal): signal is AbortSignal => !!signal);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      const requestWait = { ...wait, signal };
      const next = pending.then(async () => {
        signal?.throwIfAborted();
        await cookbook.ready(requestWait);
        const definition = COOKING_OPERATIONS.find((operation) => operation.name === name);
        if (!definition) throw new Error("Unknown cooking operation.");
        const result = await executeCookingOperation({
          doc: cookbook.doc,
          mutate: (operation) => cookbook.mutate(() => {
            signal?.throwIfAborted();
            return operation();
          }),
        }, name, args);
        if (definition.mutates) await cookbook.commit(requestWait);
        return result;
      });
      pending = next.catch(() => {});
      return next;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pending;
      await cookbook.close();
    },
  };
}
