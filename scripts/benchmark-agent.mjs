import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { openCookingSession } from "../dist-cli/src/agent/session.js";
import { startRelay } from "./cookbook-relay.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "enplace-agent-benchmark-"));
const relay = await startRelay({ port: 0, persist: directory });
const relayUrl = relay.url;
const id = "e1_" + "a".repeat(52); // Synthetic room on this isolated loopback relay.
const run = promisify(execFile);
const cli = path.resolve("dist-cli/cli/index.js");
const config = path.join(directory, "cookbook.json");
const seed = await openCookingSession({ id, relayUrl, create: true });
try {
  await writeFile(config, JSON.stringify({ id, relayUrl }), { mode: 0o600, flag: "wx" });
  const encoder = new TextEncoder();
  const files = Array.from({ length: 250 }, (_, index) => [
    `recipe-${index}.md`, encoder.encode(`# Recipe ${index}\n\n---\n\n- *200 g* lentils\n\n---\n\n1. Simmer gently.\n`),
  ]);
  files.push(["images/cover.webp", new Uint8Array(randomBytes(1024 * 1024))]);
  await seed.cookbook.adapter.writeNewBytesBatch(files);
  await seed.cookbook.commit();
  await seed.close();
  const expectedPaths = files.slice(0, 250).map(([name]) => name).sort();
  const samples = [];
  for (let index = 0; index < 12; index++) {
    const start = performance.now();
    const { stdout, stderr } = await run(process.execPath, [cli, "list", "--json", "--config", config], {
      cwd: directory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    assert.equal(stderr, "");
    assert.deepEqual(result.recipes.map(recipe => recipe.path).sort(), expectedPaths);
    assert.deepEqual(result.invalidRecipes, []);
    if (index >= 2) samples.push({ ms: performance.now() - start });
  }
  const times = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const summary = { samples: samples.length, medianMs: (times[4] + times[5]) / 2, maxMs: times.at(-1) };
  console.log(JSON.stringify({ node: process.version, transport: "actual CLI commands over a loopback persisted relay; includes Node startup, hydration, verified readback and exit; excludes model, WAN and UI", fixture: { recipes: 250, coverBytes: 1048576 }, pilots: 2, summary, samples }, null, 2));
} finally { await seed.close(); await relay.close(); await rm(directory, { recursive: true, force: true }); }
