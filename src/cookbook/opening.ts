import type { CookbookConnection, OpenCookbookOptions } from "../host-client/cookbook-storage";
import { openCookbook } from "../host-client/cookbook-storage";

const OPENING_WARNING_DEADLINE_MS = 5_000;
export type OpeningWarning = "storage" | "connection";

// The deadline bounds silence, not recovery. Only readiness ends a successful attempt.
export async function openCookbookAttempt(
  options: OpenCookbookOptions,
  signal: AbortSignal,
  warn: (warning: OpeningWarning) => void,
): Promise<CookbookConnection | null> {
  signal.throwIfAborted();
  let connection: CookbookConnection | undefined;
  let stopped = false;
  let unsubscribeCopy = (): void => {};
  let unsubscribeStatus = (): void => {};
  let cancel = (): void => {};
  const deadline = setTimeout(() => {
    if (!stopped) warn(connection && !connection.remoteSynced() ? "connection" : "storage");
  }, OPENING_WARNING_DEADLINE_MS);
  const cleanup = (): void => {
    stopped = true;
    clearTimeout(deadline);
    unsubscribeCopy();
    unsubscribeStatus();
    signal.removeEventListener("abort", cancel);
  };
  const close = (value: CookbookConnection): void => {
    void value.close().catch(() => {});
  };
  return new Promise<CookbookConnection | null>((resolve, reject) => {
    cancel = () => {
      cleanup();
      if (connection) close(connection);
      resolve(null);
    };
    signal.addEventListener("abort", cancel, { once: true });
    void openCookbook({ ...options, signal }).then((value) => {
      connection = value;
      if (stopped) { close(value); return; }
      const inspect = (): void => {
        if (stopped) return;
        const copy = value.localCopy();
        if (copy === "ready") { cleanup(); resolve(value); }
        else if (copy instanceof Error) { cleanup(); close(value); reject(copy); }
        else if (!value.remoteSynced() && (value.status() === "offline" || value.status() === "local-only")) warn("connection");
      };
      unsubscribeCopy = value.onLocalCopy(inspect);
      unsubscribeStatus = value.onStatus(inspect);
      inspect();
    }, (error) => {
      if (stopped) return;
      cleanup();
      reject(error);
    });
  });
}
