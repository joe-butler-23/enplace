#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { startRelay } from "./cookbook-relay.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMAND_DEADLINE_MS = 5 * 60_000;
const CONVERGENCE_DEADLINE_MS = 10_000;

function startProcess(command, args, { cwd = ROOT, env = process.env } = {}) {
  const child = spawn(command, args, { cwd, env, detached: true });
  let stdout = "";
  let stderr = "";
  let spawnError;
  let didClose = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      didClose = true;
      resolve({ code, signal, stdout, stderr, spawnError });
    });
  });
  return { child, closed, isClosed: () => didClose };
}

function killProcessTree(running, signal) {
  if (running.child.pid === undefined) return;
  try {
    process.kill(-running.child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function run(command, args, options) {
  const running = startProcess(command, args, options);
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    killProcessTree(running, "SIGKILL");
  }, COMMAND_DEADLINE_MS);
  const result = await running.closed;
  clearTimeout(deadline);
  if (result.spawnError) throw result.spawnError;
  if (timedOut) {
    throw new Error(`${command} exceeded its ${COMMAND_DEADLINE_MS}ms command deadline:\n${result.stderr}${result.stdout}`);
  }
  return result;
}

async function successful(command, args, options) {
  const result = await run(command, args, options);
  assert.equal(result.code, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
  assert.equal(result.signal, null);
  return result;
}

function installedCli(bin, consumer) {
  const options = { cwd: consumer, env: { ...process.env, NODE_PATH: "" } };
  return {
    run: (args) => run(bin, args, options),
    successful: (args) => successful(bin, args, options),
    start: (args) => startProcess(bin, args, options),
  };
}

async function waitFor(description, predicate, failure = () => null) {
  const deadline = performance.now() + CONVERGENCE_DEADLINE_MS;
  let lastError;
  while (performance.now() < deadline) {
    const fatal = await failure();
    if (fatal) throw fatal;
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`);
}

async function waitForSync(provider) {
  if (provider.synced) return;
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error("native WebSocket client did not initially sync")), CONVERGENCE_DEADLINE_MS);
    const onSync = (synced) => { if (synced) finish(); };
    const finish = (error) => {
      clearTimeout(deadline);
      provider.off("sync", onSync);
      if (error) reject(error);
      else resolve();
    };
    provider.on("sync", onSync);
    if (provider.synced) finish();
  });
}

async function stopInstalledCli(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    const result = await running.closed;
    throw new Error(`continuous mirror exited early (${result.code ?? result.signal}):\n${result.stderr}${result.stdout}`);
  }

  let forced = false;
  const deadline = setTimeout(() => {
    forced = true;
    killProcessTree(running, "SIGKILL");
  }, CONVERGENCE_DEADLINE_MS);
  running.child.kill("SIGINT");
  const result = await running.closed;
  clearTimeout(deadline);
  if (result.spawnError) throw result.spawnError;
  if (forced) {
    throw new Error(`continuous mirror did not stop before its shutdown deadline:\n${result.stderr}${result.stdout}`);
  }
  assert.equal(result.code, 0, `continuous mirror failed:\n${result.stderr}${result.stdout}`);
  assert.equal(result.signal, null);
  return result;
}

async function killAndClose(running) {
  if (!running.isClosed()) killProcessTree(running, "SIGKILL");
  await running.closed;
}

async function main() {
  assert.equal(process.platform, "linux", `CLI package verification requires Linux process-group signals; found ${process.platform}`);
  assert.equal(process.versions.node.split(".")[0] + ".x", JSON.parse(await readFile("package.json", "utf8")).engines.node, `CLI package verification requires the supported Node major; found ${process.version}`);
  assert.equal(globalThis.WebSocket?.name, "WebSocket", "Node native WebSocket is unavailable");

  const scratch = await mkdtemp(path.join(os.tmpdir(), "enplace-cli-package-"));
  const packDirectory = path.join(scratch, "pack");
  const consumer = path.join(scratch, "consumer");
  const fixture = path.join(scratch, "fixture");
  let relay;
  const providers = [];
  const documents = [];
  let continuous;

  try {
    await mkdir(packDirectory);
    await mkdir(consumer);
    await mkdir(fixture);
    await writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');

    const packed = await successful("npm", ["pack", "--silent", "--json", "--pack-destination", packDirectory]);
    const manifest = JSON.parse(packed.stdout)[0];
    const packedPaths = new Set(manifest.files.map((entry) => entry.path));
    for (const required of [
      "package.json",
      "dist-cli/cli/index.js",
      "dist-cli/cli/mirror.js",
      "dist-cli/src/core.js",
      "dist-cli/src/cookbook/doc.js",
      "dist-cli/src/cookbook/merge.js",
    ]) assert(packedPaths.has(required), `packed CLI is missing ${required}`);
    for (const packedPath of packedPaths) {
      assert(
        packedPath === "package.json" || packedPath === "README.md" || packedPath === "LICENSE" || packedPath.startsWith("dist-cli/"),
        `packed CLI unexpectedly contains ${packedPath}`,
      );
    }

    const tarball = path.join(packDirectory, manifest.filename);
    await successful("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumer });
    const installedPackage = JSON.parse(await readFile(path.join(consumer, "node_modules/enplace/package.json"), "utf8"));
    assert.deepEqual(installedPackage.dependencies, { marked: "^18.0.11", "y-websocket": "^3.1.0", yjs: "^13.6.32" });
    await assert.rejects(access(path.join(consumer, "node_modules/ws")));
    for (const browserOnly of [
      "@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities",
      "fflate", "pikaday", "preact", "qrcode", "y-indexeddb",
    ]) {
      await assert.rejects(access(path.join(consumer, "node_modules", ...browserOnly.split("/"))), `${browserOnly} leaked into the production install`);
    }

    const bin = path.join(consumer, "node_modules/.bin/mep");
    const cli = installedCli(bin, consumer);
    const recipe = "# Soup\n\n## Ingredients\n- 2 onions\n";
    const input = path.join(scratch, "soup.md");
    await writeFile(input, recipe);
    const inputFromConsumer = path.relative(consumer, input);
    const fixtureFromConsumer = path.relative(consumer, fixture);

    // Removing both mirror-only dependency roots proves ordinary dispatch never evaluates them.
    const blocked = [];
    for (const dependency of ["y-websocket", "yjs"]) {
      const source = path.join(consumer, "node_modules", dependency);
      const destination = path.join(consumer, "node_modules", `.blocked-${dependency}`);
      await rename(source, destination);
      blocked.push([source, destination]);
    }
    try {
      const check = await cli.successful(["check", inputFromConsumer, "--folder", fixtureFromConsumer]);
      assert.equal(check.stdout, "OK: Soup -> soup.md\n");
      assert.equal(check.stderr, "");
      const add = await cli.successful(["add", inputFromConsumer, "--folder", fixtureFromConsumer]);
      assert.equal(add.stdout, "soup.md\n");
      assert.equal(add.stderr, "");
      const list = await cli.successful(["list", "--folder", fixtureFromConsumer]);
      assert.equal(list.stdout, "soup.md\tSoup\t\tno cover\n");
      assert.equal(list.stderr, "");
      await writeFile(path.join(fixture, "Plan.md"), "## 2026-09-07\n- [[soup]]\n");
      await writeFile(path.join(fixture, "Shopping.md"), "# Shopping\n");
      const shop = await cli.successful(["shop", "--week", "2026-09-07", "--folder", fixtureFromConsumer]);
      assert.equal(shop.stderr, "");
      assert.equal(shop.stdout, await readFile(path.join(fixture, "Shopping.md"), "utf8"));
      assert.match(shop.stdout, /- \[ \] 2 onions/);
      const invalidRoutes = [
        [["--"], "mep: unknown option: --\n"],
        [["list", "--folder"], "mep: --folder needs a value\n"],
        [["check", "--folder", fixtureFromConsumer], "mep: check needs one <file|->\n"],
        [["list", "--week", "2026-09-07"], "mep: --week is only valid with shop\n"],
        [["list", "--cookbook", "id"], "mep: --cookbook, --relay, and --once are only valid with mirror\n"],
        [["mirror"], "mep: mirror needs --folder <dir>\n"],
        [["mirror", "--folder", fixtureFromConsumer], "mep: mirror needs --cookbook <link-or-id>\n"],
        [["mirror", "--folder", fixtureFromConsumer, "--cookbook", "id", "--json"], "mep: --json is not valid with mirror\n"],
      ];
      for (const [args, stderr] of invalidRoutes) {
        const invalidRoute = await cli.run(args);
        assert.deepEqual(
          { code: invalidRoute.code, signal: invalidRoute.signal, stdout: invalidRoute.stdout, stderr: invalidRoute.stderr },
          { code: 1, signal: null, stdout: "", stderr },
        );
      }

      const invalidInput = path.join(scratch, "invalid.md");
      await writeFile(invalidInput, "# Not a recipe\n");
      const invalid = await cli.run(["check", path.relative(consumer, invalidInput), "--folder", fixtureFromConsumer]);
      assert.equal(invalid.code, 1);
      assert.equal(invalid.stdout, "");
      assert.equal(invalid.stderr, "mep: recipe needs valid RecipeMD (https://recipemd.org/specification.html) or an existing ## Ingredients section\n");
    } finally {
      for (const [source, destination] of blocked.reverse()) await rename(destination, source);
    }

    const { readCookbookText, writeCookbookText } = await import("../dist-cli/src/cookbook/doc.js");
    const relayState = path.join(scratch, "relay-state");
    relay = await startRelay({ persist: relayState });
    const nativeClient = async (cookbook) => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(relay.url, cookbook, doc, { disableBc: true });
      assert.equal(provider._WS, globalThis.WebSocket, "y-websocket did not select Node native WebSocket");
      providers.push(provider);
      documents.push(doc);
      await waitForSync(provider);
      return { doc, provider };
    };

    const onceFolder = path.join(scratch, "mirror-once");
    await mkdir(onceFolder);
    await writeFile(path.join(onceFolder, "once.md"), "once through native WebSocket\n");
    const onceCookbook = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { doc: onceDoc } = await nativeClient(onceCookbook);
    const once = await cli.successful([
      "mirror", "--folder", path.relative(consumer, onceFolder), "--cookbook", onceCookbook, "--relay", relay.url, "--once",
    ]);
    assert.equal(once.stdout, "");
    assert.equal(once.stderr, "");
    await waitFor("one-shot mirror upload", () => readCookbookText(onceDoc, "once.md") === "once through native WebSocket\n");

    const continuousFolder = path.join(scratch, "mirror-continuous");
    await mkdir(continuousFolder);
    const continuousCookbook = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { doc: continuousDoc, provider: continuousProvider } = await nativeClient(continuousCookbook);
    continuous = cli.start([
      "mirror", "--folder", path.relative(consumer, continuousFolder), "--cookbook", continuousCookbook, "--relay", relay.url,
    ]);
    const mirrorFailure = async () => {
      if (continuous.child.exitCode === null && continuous.child.signalCode === null) return null;
      const result = await continuous.closed;
      return new Error(`continuous mirror exited early (${result.code ?? result.signal}):\n${result.stderr}${result.stdout}`);
    };
    writeCookbookText(continuousDoc, "remote.md", "remote through native WebSocket\n");
    const mirroredFile = path.join(continuousFolder, "remote.md");
    await waitFor("continuous relay-to-disk mirror", async () => {
      try { return await readFile(mirroredFile, "utf8") === "remote through native WebSocket\n"; }
      catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    }, mirrorFailure);
    await writeFile(mirroredFile, "disk through native WebSocket\n");
    await waitFor(
      "continuous disk-to-relay mirror",
      () => readCookbookText(continuousDoc, "remote.md") === "disk through native WebSocket\n",
      mirrorFailure,
    );

    const relayPort = Number(new URL(relay.url).port);
    await relay.close();
    relay = null;
    await waitFor("native client to observe relay interruption", () => !continuousProvider.synced, mirrorFailure);
    assert.equal(continuous.child.exitCode, null, "continuous mirror exited during a transient relay interruption");
    relay = await startRelay({ port: relayPort, persist: relayState });
    await waitFor("native client to reconnect", () => continuousProvider.synced, mirrorFailure);
    writeCookbookText(continuousDoc, "remote.md", "remote after reconnect\n");
    await waitFor("post-reconnect relay-to-disk mirror", async () => {
      try { return await readFile(mirroredFile, "utf8") === "remote after reconnect\n"; }
      catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    }, mirrorFailure);
    const localAfterReconnect = path.join(continuousFolder, "local-after-reconnect.md");
    await writeFile(localAfterReconnect, "disk after reconnect\n");
    await waitFor(
      "post-reconnect disk-to-relay mirror",
      () => readCookbookText(continuousDoc, "local-after-reconnect.md") === "disk after reconnect\n",
      mirrorFailure,
    );

    const stopped = await stopInstalledCli(continuous);
    continuous = undefined;
    assert.equal(stopped.stderr, "");
    assert.match(stopped.stdout, /wrote remote\.md\n/);
    assert.match(stopped.stdout, /updated cookbook from remote\.md\n/);
    assert.match(stopped.stdout, /preserved local copy as .*remote\.local-/);
    assert.match(stopped.stdout, /updated cookbook from local-after-reconnect\.md\n/);

    console.log(`Verified ${manifest.filename} (${manifest.size} packed bytes) with a Node production-only install.`);
    console.log("Ordinary check/add/list/shop commands loaded no mirror dependencies.");
    console.log("One-shot and restart-safe continuous mirror converged over Node native WebSocket.");
  } finally {
    if (continuous) await killAndClose(continuous);
    for (const provider of providers) provider.destroy();
    for (const doc of documents) doc.destroy();
    await relay?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
