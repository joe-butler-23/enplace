import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openCookingSession } from "../dist-cli/src/agent/session.js";
import { startRelay } from "./cookbook-relay.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "enplace-agent-benchmark-"));
const relay = await startRelay({ port: 0, persist: directory });
const relayUrl = relay.url;
const id = "e1_" + "a".repeat(52); // Synthetic room on this isolated loopback relay.
let received = 0;
const NativeWebSocket = globalThis.WebSocket;
class CountingSocket extends NativeWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    this.addEventListener("message", (event) => {
      const data = event.data;
      received += data instanceof ArrayBuffer ? data.byteLength : data instanceof Blob ? data.size : typeof data === "string" ? Buffer.byteLength(data) : 0;
    });
  }
}
globalThis.WebSocket = CountingSocket;
const seed = await openCookingSession({ id, relayUrl, create: true });
try {
  const encoder = new TextEncoder();
  const files = Array.from({ length: 250 }, (_, index) => [
    `recipe-${index}.md`, encoder.encode(`# Recipe ${index}\n\n---\n\n- *200 g* lentils\n\n---\n\n1. Simmer gently.\n`),
  ]);
  files.push(["images/cover.webp", new Uint8Array(randomBytes(1024 * 1024))]);
  await seed.cookbook.adapter.writeNewBytesBatch(files);
  await seed.cookbook.commit();
  await seed.close();
  const warm = await openCookingSession({ id, relayUrl });
  try {
    // Pilots establish the callable/readback boundaries before the retained samples.
    for (let index = 0; index < 2; index++) {
      assert.equal((await warm.execute("recipe.list", {})).recipes.length, 250);
      const cold = await openCookingSession({ id, relayUrl }); await cold.execute("recipe.list", {}); await cold.close();
    }
    const samples = [];
    for (let pair = 0; pair < 10; pair++) {
      for (const mode of pair % 2 ? ["session", "cold"] : ["cold", "session"]) {
        const bytes = received, start = performance.now();
        const session = mode === "cold" ? await openCookingSession({ id, relayUrl }) : warm;
        const result = await session.execute("recipe.list", {});
        assert.equal(result.recipes.length, 250);
        if (mode === "cold") await session.close();
        samples.push({ mode, ms: performance.now() - start, receivedBytes: received - bytes });
      }
    }
    const summary = Object.fromEntries(["cold", "session"].map(mode => {
      const rows = samples.filter(sample => sample.mode === mode), times = rows.map(sample => sample.ms).sort((a, b) => a - b);
      return [mode, { samples: rows.length, medianMs: (times[4] + times[5]) / 2, p95Ms: times[9], receivedBytes: rows.map(sample => sample.receivedBytes) }];
    }));
    assert(samples.filter(sample => sample.mode === "session").every(sample => sample.receivedBytes === 0));
    assert(samples.filter(sample => sample.mode === "cold").every(sample => sample.receivedBytes > 1024 * 1024));
    console.log(JSON.stringify({ node: process.version, transport: "loopback persisted relay; no model time or WAN latency", fixture: { recipes: 250, coverBytes: 1048576 }, summary, samples }, null, 2));
  } finally { await warm.close(); }
} finally { await seed.close(); await relay.close(); await rm(directory, { recursive: true, force: true }); globalThis.WebSocket = NativeWebSocket; }
