#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { startRelay } from "./cookbook-relay.mjs";

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

function installedCli(bin, consumer, env = {}) {
  const options = { cwd: consumer, env: { ...process.env, NODE_PATH: "", ...env } };
  return {
    run: (args) => run(bin, args, options),
    successful: (args) => successful(bin, args, options),
  };
}

async function interactiveSession(bin, consumer, config, work) {
  const running = startProcess(bin, ["session", "--config", config], { cwd: consumer });
  const lines = createInterface({ input: running.child.stdout, crlfDelay: Infinity });
  const responses = lines[Symbol.asyncIterator]();
  const deadline = setTimeout(() => killProcessTree(running, "SIGKILL"), COMMAND_DEADLINE_MS);
  const call = async (operation, args) => {
    running.child.stdin.write(JSON.stringify({ operation, args }) + "\n");
    const response = await responses.next();
    assert.equal(response.done, false, "session exited before responding while stdin was open");
    return JSON.parse(response.value);
  };
  try {
    await work(call, running.child.stdin);
    running.child.stdin.end();
    return await running.closed;
  } finally {
    clearTimeout(deadline);
    lines.close();
    if (!running.isClosed()) { killProcessTree(running, "SIGKILL"); await running.closed; }
  }
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
    assert.deepEqual(installedPackage.dependencies, JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).dependencies);
    await assert.rejects(access(path.join(consumer, "node_modules/ws")));
    for (const browserOnly of [
      "@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities",
      "pikaday", "preact", "qrcode", "happy-dom",
    ]) {
      await assert.rejects(access(path.join(consumer, "node_modules", ...browserOnly.split("/"))), `${browserOnly} leaked into the production install`);
    }

    const bin = path.join(consumer, "node_modules/.bin/mep");
    const cli = installedCli(bin, consumer);
    const recipe = "# Soup\n\n## Ingredients\n- 2 onions\n";
    const input = path.join(scratch, "soup.md");
    await writeFile(input, recipe);
    const unassociated = path.join(scratch, "unassociated");
    await mkdir(unassociated);
    const disconnectedCli = installedCli(bin, unassociated, { XDG_CONFIG_HOME: path.join(scratch, "empty-config") });
    for (const args of [["add", input], ["shop"]]) {
      const result = await disconnectedCli.run(args);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Connect a cookbook first/);
    }
    assert.deepEqual(await readdir(unassociated), []);
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
    const relay = await startRelay({ port: 0, persist: path.join(scratch, "relay") });
    const id = "e1_" + "a".repeat(52), relayUrl = relay.url;
    const config = path.join(scratch, "cookbook.json");
    await writeFile(config, JSON.stringify({ id, relayUrl }), { mode: 0o600 });
    await successful(process.execPath, ["--input-type=module", "-e", `
      import { openCookingSession } from './node_modules/enplace/dist-cli/src/agent/session.js';
      import { readFile } from 'node:fs/promises';
      const association = JSON.parse(await readFile(process.argv[1], 'utf8'));
      const session = await openCookingSession({ ...association, create: true });
      try {
        await session.execute('recipe.create', { operationId: 'installed-prose-only', markdown: '# A vegetarian quick suggestion\\n\\n---\\n\\n- *2* onions\\n\\n---\\n\\n1. Cook.\\n' });
        await session.execute('recipe.create', { operationId: 'installed-meat-soup', markdown: '# B meat soup\\n\\n*non-vegetarian, quick*\\n\\n---\\n\\n- *2* onions\\n\\n---\\n\\n1. Cook.\\n' });
        await session.cookbook.commit();
      } finally { await session.close(); }
    `, config], { cwd: consumer });
    const call = async (operation, args) => {
      const input = path.join(scratch, "operation.json");
      await writeFile(input, JSON.stringify(args));
      return JSON.parse((await cli.successful(["call", operation, input, "--config", config])).stdout);
    };
    try {
      const tools = JSON.parse((await cli.successful(["tools"])).stdout);
      assert.equal(tools.length, 24);
      assert(tools.some(tool => tool.name === "recipe.update"));
      await assert.rejects(call("recipe.delete", { path: "../../secret" }), /arguments must have required property 'operationId'/);
      const added = await call("recipe.create", { operationId: "installed-create-soup", markdown: "# Installed soup\n\n*vegetarian, quick*\n\n---\n\n- *2* onions\n\n---\n\n1. Simmer.\n" });
      const original = await call("recipe.get", { path: added.path });
      assert.match(original.markdown, /2.*onions/);
      const selected = await call("recipe.search", { tags: ["VeGeTaRiAn", "QUICK"], query: "onions", includeIngredients: true, limit: 1 });
      assert.deepEqual(selected.recipes.map(recipe => recipe.path), [added.path]);
      assert.deepEqual(selected.recipes[0].ingredients, original.recipe.ingredients);
      assert.deepEqual((await call("recipe.search", { tags: ["vegetarian"], query: "bake" })).recipes, []);
      await assert.rejects(call("recipe.search", { tags: ["vegetarian"], includeIngredients: "true" }), /must be boolean/);
      const amended = original.markdown.replace("Simmer.", "Simmer for 20 minutes.");
      await call("recipe.update", { operationId: "installed-amend-soup", path: added.path, base: original.markdown, markdown: amended });
      const plan = await call("plan.read", {});
      await call("plan.add", { operationId: "installed-plan-soup", path: added.path, date: "2026-09-09", expectedRevision: plan.revision });
      const currentPlan = await call("plan.read", {});
      const currentShopping = await call("shopping.read", {});
      const generated = await call("shopping.build", { operationId: "installed-build-soup", week: "2026-09-07", expectedRevision: currentShopping.revision, planRevision: currentPlan.revision });
      assert(generated.items.some(item => item.content.includes("onions")));
      const readback = await cli.successful(["show", added.path, "--config", config]);
      assert.match(readback.stdout, /Installed soup/);
      assert.match(readback.stdout, /Simmer for 20 minutes/);
      const listed = await cli.successful(["list", "--config", config, "--json"]);
      assert.equal(JSON.parse(listed.stdout).recipes.length, 3);
      const configHome = path.join(scratch, "config");
      await mkdir(path.join(configHome, "enplace"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(configHome, "enplace/cookbook.json"), JSON.stringify({ id, relayUrl }), { mode: 0o600 });
      const localShopping = path.join(consumer, "Shopping.md");
      await writeFile(localShopping, "Local folder must remain untouched.\n");
      const liveCli = installedCli(bin, consumer, { XDG_CONFIG_HOME: configHome });
      const built = await liveCli.successful(["shop", "--week", "2026-09-07"]);
      assert(JSON.parse(built.stdout).items.some(item => item.content.includes("onions")));
      assert.equal(await readFile(localShopping, "utf8"), "Local folder must remain untouched.\n");

      const shared = await interactiveSession(bin, consumer, config, async session => {
        const recipe = await session("recipe.get", { path: added.path });
        await session("recipe.update", { operationId: "session-amend-soup", path: added.path, base: recipe.markdown, markdown: recipe.markdown.replace("20 minutes", "25 minutes") });
        const plan = await session("plan.read", {});
        const note = { operationId: "session-plan-note", date: "2026-09-09", note: "Session dinner", expectedRevision: plan.revision };
        await session("plan.note", note);
        assert.equal((await session("plan.note", note)).replayed, true);
        const shopping = await session("shopping.add", { operationId: "session-shopping-add", content: "Session limes" });
        const item = shopping.items.find(item => item.content === "Session limes");
        const checked = await session("shopping.check", { operationId: "session-shopping-check", itemIds: [item.id], expectedRevision: shopping.revision });
        assert(checked.items.find(candidate => candidate.content === item.content).checked);
      });
      assert.equal(shared.code, 0, shared.stderr);
      assert.equal(shared.stderr, "");
      assert.equal(shared.stdout.trim().split("\n").length, 7);
      assert.match((await call("recipe.get", { path: added.path })).markdown, /25 minutes/);
      assert((await call("shopping.read", {})).items.some(item => item.content === "Session limes" && item.checked));

      const stopped = await interactiveSession(bin, consumer, config, async (session, stdin) => {
        const before = await session("plan.read", {});
        await session("plan.note", { operationId: "session-before-failure", date: "2026-09-10", note: "Saved before failure", expectedRevision: before.revision });
        stdin.write(JSON.stringify({ operation: "plan.note", args: { operationId: "session-stale-note", date: "2026-09-11", note: "Stale must fail", expectedRevision: before.revision } }) + "\n");
        stdin.write(JSON.stringify({ operation: "shopping.add", args: { operationId: "session-after-failure", content: "Must not be saved" } }) + "\n");
      });
      assert.equal(stopped.code, 1);
      assert.match(stopped.stderr, /Plan.md changed/);
      assert.equal(stopped.stdout.trim().split("\n").length, 2);
      assert.match((await call("plan.read", {})).markdown, /Saved before failure/);
      assert(!(await call("shopping.read", {})).items.some(item => item.content === "Must not be saved"));
    } finally { await relay.close(); }
    console.log(`Verified ${manifest.filename} (${manifest.size} packed bytes) with a Node production-only install.`);
    console.log("Installed folder commands and direct live recipe/plan/shopping calls passed; browser rendering dependencies absent.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
