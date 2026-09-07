import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "./cookbook-relay.mjs";

const directory = await mkdtemp(join(tmpdir(), "enplace-pwa-relay-"));
let relay;
try { relay = await startRelay({ port: Number(process.argv[2]), persist: directory }); }
catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try { await relay.close(); }
  finally { await rm(directory, { recursive: true, force: true }); }
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
