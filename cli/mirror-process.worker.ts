import { describe, it } from "vitest";
import { ftruncateSync, fsyncSync, openSync, statSync, watch, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicCommit } from "./mirror-commit";

describe("mirror process-loss worker", () => {
  it("writes through the displaced inode and awaits forced death", async () => {
    const root = process.env.MEP_PROCESS_LOSS_ROOT!;
    const target = path.join(root, "cover.webp");
    const expected = await readFile(target);
    const descriptor = openSync(target, "r+");
    let acknowledged = false;
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      const relative = filename?.toString();
      if (acknowledged || !relative?.includes(".local-")) return;
      const recovery = path.join(root, relative);
      try { if (!statSync(recovery).isFile()) return; } catch { return; }
      acknowledged = true;
      const late = Buffer.from([0x00, 0xff, 0x80, 0x41]);
      ftruncateSync(descriptor, 0);
      writeSync(descriptor, late, 0, late.length, 0);
      fsyncSync(descriptor);
      writeSync(1, `MEP_RECOVERY_ACK:${relative}\n`);
      process.kill(process.pid, "SIGSTOP");
    });
    void atomicCommit(target, expected, Buffer.from([0xde, 0xad, 0x00, 0xbe]), {
      current: () => true,
      recoveryName: "cover.local-20260910-123456.webp",
    });
    await new Promise(() => undefined);
  }, 30_000);
});
