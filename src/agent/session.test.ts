import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { newCookbookId } from "../cookbook/doc";
import { openCookingSession } from "./session";
// @ts-expect-error The reference relay is a JavaScript executable.
import { startRelay } from "../../scripts/cookbook-relay.mjs";

it("does not report a disconnected local snapshot as a current successful read", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "enplace-session-read-"));
  const relay = await startRelay({ port: 0, persist: directory });
  const session = await openCookingSession({ id: newCookbookId(), relayUrl: relay.url, create: true, timeoutMs: 100 });
  try {
    await session.execute("shopping.add", { operationId: "offline-read-fixture", content: "Lemons" });
    const disconnected = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { stop(); reject(new Error("Relay disconnect was not observed.")); }, 2000);
      const stop = session.cookbook.onStatus(status => {
        if (status !== "offline") return;
        stop(); clearTimeout(deadline); resolve();
      });
    });
    await relay.close();
    await disconnected;
    await expect(session.execute("shopping.read", {})).rejects.toThrow();
  } finally { await session.close(); await relay.close(); await rm(directory, { recursive: true, force: true }); }
});
