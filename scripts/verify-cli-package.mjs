#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMAND_DEADLINE_MS = 5 * 60_000;

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

async function main() {
  assert.equal(process.platform, "linux", `CLI package verification requires Linux process-group signals; found ${process.platform}`);
  assert.equal(process.versions.node.split(".")[0] + ".x", JSON.parse(await readFile("package.json", "utf8")).engines.node, `CLI package verification requires the supported Node major; found ${process.version}`);

  const scratch = await mkdtemp(path.join(os.tmpdir(), "enplace-cli-package-"));
  const packDirectory = path.join(scratch, "pack");
  const consumer = path.join(scratch, "consumer");
  const fixture = path.join(scratch, "fixture");

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
      "dist-cli/src/core.js",
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
    assert.deepEqual(installedPackage.dependencies, { marked: "^18.0.11" });
    await assert.rejects(access(path.join(consumer, "node_modules/ws")));
    for (const browserOnly of [
      "@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities",
      "fflate", "pikaday", "preact", "qrcode", "y-indexeddb", "yjs", "y-websocket",
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
    console.log(`Verified ${manifest.filename} (${manifest.size} packed bytes) with a Node production-only install.`);
    console.log("Installed check/add/list/shop commands passed with no browser or sync dependencies.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
