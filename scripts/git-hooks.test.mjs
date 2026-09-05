import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vitest";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];
const exactWranglerDeploy = './node_modules/.bin/wrangler pages deploy dist-static --project-name "$PROJECT" --branch main --commit-dirty=true';
const unsafeWranglerPatterns = [
  /^(?=[^\n]*\bwrangler\b)(?=[^\n]*\bnpx\b).*$/m,
  /^(?=[^\n]*\bwrangler\b)(?=[^\n]*\bnpm\b[^\n]*\b(?:exec|x)\b).*$/m,
  /^\s*(?:command\s+(?:-\S+\s+)*)?wrangler\b/m,
  /(?:^|\n)\s*(?:export\s+)?WRANGLER(?:_BIN)?\s*=/,
  /\$(?:WRANGLER(?:_BIN)?\b|\{WRANGLER(?:_BIN)?\})/,
  /(?:~|\$(?:HOME|\{HOME\}))\/(?:\.cache|\.npm)\/[^\n]*wrangler/,
  /\$(?:XDG_CACHE_HOME|npm_config_cache)[^\n]*wrangler/,
];
const rootLifecycleHooks = ["prebuild:release"];
const relayLifecycleHooks = ["pretypes", "pretypecheck", "prebuild", "postbuild"];

const structuredMutations = [
  ["npm engine enforcement", (state) => { state.npmrc = "engine-strict=false\n"; }],
  ["relay-owned TypeScript", (state) => { state.relayPackage.devDependencies = { typescript: "5.9.3" }; }],
  ["lock root Node engine", (state) => { state.lock.packages[""].engines.node = ">=22"; }],
  ["lock root Wrangler range", (state) => { state.lock.packages[""].devDependencies.wrangler = "^4.128.0"; }],
  ["lock root workspace", (state) => { state.lock.packages[""].workspaces = ["relay", "other"]; }],
  ["missing relay package", (state) => { delete state.lock.packages.relay; }],
  ["missing relay link", (state) => { delete state.lock.packages["node_modules/enplace-relay"]; }],
  ["nested Wrangler", (state) => { state.lock.packages["relay/node_modules/wrangler"] = { version: "4.128.0" }; }],
  ["relay pretypes lifecycle", (state) => { state.relayPackage.scripts.pretypes = "tsc"; }],
  ["relay pretypecheck lifecycle", (state) => { state.relayPackage.scripts.pretypecheck = "tsc"; }],
  ["relay prebuild lifecycle", (state) => { state.relayPackage.scripts.prebuild = "wrangler deploy"; }],
  ["disabled static build", (state) => { state.rootPackage.scripts["build:static"] = "true"; }],
  ["disabled CLI build", (state) => { state.rootPackage.scripts["build:cli"] = "true"; }],
  ["disabled release entry", (state) => { state.rootPackage.scripts["preflight:release"] = "true"; }],
  ["disabled app typecheck", (state) => { state.rootPackage.scripts["typecheck:app"] = "true"; }],
  ["root release prebuild", (state) => { state.rootPackage.scripts["prebuild:release"] = "npx --offline wrangler deploy"; }],
  ["relay postbuild", (state) => { state.relayPackage.scripts.postbuild = "wrangler deploy"; }],
  ["relay optional TypeScript", (state) => { state.relayPackage.optionalDependencies = { typescript: "5.9.3" }; }],
];

const wranglerScriptMutations = [
  ["npx", "npx --offline wrangler pages deploy dist-static"],
  ["npm exec", "npm --silent exec --package=wrangler -- wrangler pages deploy dist-static"],
  ["npm x", "npm x -- wrangler pages deploy dist-static"],
  ["global", "wrangler pages deploy dist-static"],
  ["command", "command wrangler pages deploy dist-static"],
  ["Nix store", "/nix/store/fake-wrangler/bin/wrangler pages deploy dist-static"],
  ["cache", '"$HOME/.cache/wrangler" pages deploy dist-static'],
  ["variable", 'WRANGLER=wrangler\n"$WRANGLER" pages deploy dist-static'],
];

function run(cwd, command, args, input, env = {}) {
  return spawnSync(command, args, { cwd, input, encoding: "utf8", env: { ...process.env, ...env, LC_ALL: "C" } });
}

function git(cwd, ...args) {
  const result = run(cwd, "git", args);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function copyExecutable(source, target) {
  await copyFile(path.join(repositoryRoot, source), target);
  await chmod(target, 0o755);
}

async function executable(filename, contents) {
  await writeFile(filename, contents);
  await chmod(filename, 0o755);
}

async function temporaryRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function releaseState() {
  const read = (relative) => readFile(path.join(repositoryRoot, relative), "utf8");
  const [rootPackage, relayPackage, lock, nodePin, npmrc, relayConfig, prepush, release, deploy, relayLockExists] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("relay/package.json").then(JSON.parse),
    read("package-lock.json").then(JSON.parse),
    read(".nvmrc"),
    read(".npmrc"),
    read("relay/wrangler.jsonc").then((text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""))),
    read("scripts/pre-push.sh"),
    read("scripts/preflight-release.sh"),
    read("scripts/deploy-site.sh"),
    exists(path.join(repositoryRoot, "relay/package-lock.json")),
  ]);
  return { rootPackage, relayPackage, lock, nodePin, npmrc, relayConfig, prepush, release, deploy, relayLockExists };
}

function assertReleaseContract(state) {
  const { rootPackage, relayPackage, lock } = state;
  assert.match(state.nodePin.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(rootPackage.engines.node, state.nodePin.trim().split(".")[0] + ".x");
  assert.equal(state.npmrc.trim(), "engine-strict=true");
  assert.deepEqual(rootPackage.workspaces, ["relay"]);
  assert.equal(state.relayLockExists, false);

  assert.equal(rootPackage.devDependencies.wrangler, "4.128.0");
  for (const section of ["dependencies", "devDependencies"]) {
    assert.equal(relayPackage[section]?.wrangler, undefined);
    assert.equal(relayPackage[section]?.typescript, undefined);
  }
  assert.equal(relayPackage.optionalDependencies?.typescript, undefined);

  const lockRoot = lock.packages[""];
  assert.deepEqual(lockRoot.workspaces, ["relay"]);
  assert.equal(lockRoot.engines.node, rootPackage.engines.node);
  assert.equal(lockRoot.devDependencies.wrangler, "4.128.0");
  assert.ok(lock.packages.relay);
  assert.equal(lock.packages["node_modules/enplace-relay"]?.link, true);
  const lockedWranglers = Object.entries(lock.packages)
    .filter(([name]) => name === "node_modules/wrangler" || name.endsWith("/node_modules/wrangler"));
  assert.deepEqual(lockedWranglers.map(([name, value]) => [name, value.version]), [["node_modules/wrangler", "4.128.0"]]);

  assert.equal(rootPackage.scripts["preflight:release"], "./scripts/preflight-release.sh");
  assert.equal(rootPackage.scripts["typecheck:app"], "tsc --noEmit");
  assert.equal(rootPackage.scripts.typecheck, "npm run typecheck:app && npm run typecheck --workspace=enplace-relay");
  assert.equal(rootPackage.scripts["build:static"], "npm run build:sample-pack && vite build --mode static");
  assert.equal(rootPackage.scripts["build:cli"], "rm -rf dist-cli && tsc -p tsconfig.cli.json");
  assert.equal(rootPackage.scripts["build:release"], "npm run build:static && npm run build:cli && npm run build --workspace=enplace-relay");
  for (const hook of rootLifecycleHooks) assert.equal(rootPackage.scripts[hook], undefined);
  assert.equal(relayPackage.scripts.types, "wrangler types");
  assert.equal(relayPackage.scripts.typecheck, "npm run types && tsc --noEmit");
  assert.equal(relayPackage.scripts.build, "wrangler deploy --dry-run");
  for (const hook of relayLifecycleHooks) assert.equal(relayPackage.scripts[hook], undefined);
  assert.equal(state.relayConfig.$schema, "../node_modules/wrangler/config-schema.json");

  assert.match(state.release, /required_node="\$\(tr -d '\[:space:\]' < \.nvmrc\)"/);
  assert.match(state.release, /actual_node="\$\(node -p 'process\.versions\.node'\)"/);
  assert.match(state.release, /if \[\[ "\$actual_node" != "\$required_node" \]\]/);
  assert.match(state.prepush, /^\s*npm run typecheck\s*$/m);
  assert.match(state.prepush, /^\s*npm test\s*$/m);
  assert.match(state.prepush, /^\s*npm run test:cli-package\s*$/m);
  assert.match(state.prepush, /^\s*npm run test:static-pwa\s*$/m);
  assert.match(state.release, /npm ci/);
  assert.match(state.release, /npm audit --workspaces --include-workspace-root --audit-level=high --ignore-scripts/);
  assert.match(state.release, /npm run build:release/);
  assert.match(state.deploy, /^\[\[ -x \.\/node_modules\/\.bin\/wrangler \]\] \|\| \{$/m);
  assert.match(state.deploy, new RegExp(`^${exactWranglerDeploy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

  const releaseScripts = `${state.release}\n${state.deploy}`.replace(/\\\r?\n/g, " ");
  assert.doesNotMatch(releaseScripts, /(?:^|[\s/])nix(?:-shell)?(?:[\s/]|$)|\/nix\/store|PLAYWRIGHT_BROWSERS_PATH/);
  for (const pattern of unsafeWranglerPatterns) assert.doesNotMatch(releaseScripts, pattern);
}

async function preflightFixture() {
  const root = await temporaryRoot("enplace-preflight-");
  const scripts = path.join(root, "scripts");
  const bin = path.join(root, "bin");
  await Promise.all([mkdir(scripts), mkdir(bin), mkdir(path.join(root, "node_modules"))]);
  await Promise.all([
    copyExecutable("scripts/preflight-release.sh", path.join(scripts, "preflight-release.sh")),
    copyExecutable("scripts/pre-push.sh", path.join(scripts, "pre-push.sh")),
  ]);
  await writeFile(path.join(root, ".nvmrc"), "22.23.1\n");
  await executable(path.join(bin, "node"), `#!/usr/bin/env bash
version="\${NODE_VERSION:-22.23.1}"
if [[ "$1" == "-p" ]]; then printf '%s\\n' "$version"; else printf 'v%s\\n' "$version"; fi
`);
  await executable(path.join(bin, "npm"), `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$RELEASE_LOG"
[[ "\${FAIL_NPM:-}" != "$*" ]] || exit 41
`);
  await executable(path.join(scripts, "residue-scan.sh"), `#!/usr/bin/env bash
printf 'residue-scan\\n' >> "$RELEASE_LOG"
`);
  await executable(path.join(scripts, "pre-commit.sh"), `#!/usr/bin/env bash
printf 'precommit\\n' >> "$RELEASE_LOG"
`);
  return { root, bin, log: path.join(root, "release.log") };
}

function runPreflight(fixture, env = {}) {
  return run(fixture.root, "bash", ["scripts/preflight-release.sh"], undefined, {
    PATH: `${fixture.bin}:${process.env.PATH}`,
    RELEASE_LOG: fixture.log,
    ...env,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release and Git hook composition", () => {
  it("keeps the checked-in release authority and kills structured contract mutations", async () => {
    const state = await releaseState();
    assertReleaseContract(state);

    for (const [name, mutate] of structuredMutations) {
      const mutant = structuredClone(state);
      mutate(mutant);
      expect(() => assertReleaseContract(mutant), name).toThrow();
    }
  });

  it("kills executable Wrangler fallback mutations", async () => {
    const state = await releaseState();
    for (const [name, fallback] of wranglerScriptMutations) {
      const mutant = structuredClone(state);
      mutant.deploy = mutant.deploy.replace(exactWranglerDeploy, `${exactWranglerDeploy}\n${fallback}`);
      expect(mutant.deploy, `${name} mutation was not planted`).not.toBe(state.deploy);
      expect(() => assertReleaseContract(mutant), name).toThrow();
    }
  });

  it("runs only the repository-local Wrangler and refuses when it is absent", async () => {
    const root = await temporaryRoot("enplace-deploy-");
    const scripts = path.join(root, "scripts");
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    const localBin = path.join(root, "node_modules", ".bin");
    const cache = path.join(home, ".cache");
    await Promise.all([mkdir(scripts), mkdir(bin), mkdir(path.join(cache, "enplace"), { recursive: true })]);
    await copyExecutable("scripts/deploy-site.sh", path.join(scripts, "deploy-site.sh"));
    const fallbackLog = path.join(root, "fallback.log");
    const localLog = path.join(root, "local.log");
    await executable(path.join(bin, "npm"), `#!/usr/bin/env bash
if [[ "$*" == "run build:static" ]]; then
  mkdir -p dist-static/assets
  printf 'wss://relay.example.test/parties/kitchen' > dist-static/assets/index-test.js
else
  printf 'npm %s\n' "$*" >> "$FALLBACK_LOG"
fi
`);
    const fallback = `#!/usr/bin/env bash
printf 'fallback %s\n' "$*" >> "$FALLBACK_LOG"
`;
    await Promise.all([
      executable(path.join(bin, "npx"), fallback),
      executable(path.join(bin, "wrangler"), fallback),
      executable(path.join(cache, "wrangler"), fallback),
      executable(path.join(cache, "enplace", "wrangler"), fallback),
    ]);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      FALLBACK_LOG: fallbackLog,
      LOCAL_LOG: localLog,
    };

    const missing = run(root, "bash", ["scripts/deploy-site.sh"], undefined, env);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("deploy-site: ./node_modules/.bin/wrangler is missing or not executable; run npm ci at the repository root\n");
    expect(await exists(fallbackLog)).toBe(false);

    await mkdir(localBin, { recursive: true });
    await executable(path.join(localBin, "wrangler"), `#!/usr/bin/env bash
printf 'local %s\n' "$*" >> "$LOCAL_LOG"
`);
    const deployed = run(root, "bash", ["scripts/deploy-site.sh"], undefined, env);
    expect(deployed.status, deployed.stderr).toBe(0);
    expect(await readFile(localLog, "utf8")).toBe("local pages deploy dist-static --project-name enplace-trial --branch main --commit-dirty=true\n");
    expect(await exists(fallbackLog)).toBe(false);
  });
  it("enforces exact Node and stops at each failed preflight phase", async () => {
    const skipped = await preflightFixture();
    const skip = runPreflight(skipped, { SKIP_MEP_PREPUSH: "1" });
    expect(skip.status).toBe(1);
    expect(skip.stderr).toContain("refuses SKIP_MEP_PREPUSH=1");
    expect(await exists(skipped.log)).toBe(false);

    const wrongNode = await preflightFixture();
    const wrong = runPreflight(wrongNode, { NODE_VERSION: "22.23.0" });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("requires Node 22.23.1; found v22.23.0");
    expect(await exists(wrongNode.log)).toBe(false);

    const calls = [
      "npm ci",
      "npm run check:playwright-runtime",
      "residue-scan",
      "precommit",
      "npm run typecheck",
      "npm test",
      "npm run test:cli-package",
      "npm run test:static-pwa",
      "npm audit --workspaces --include-workspace-root --audit-level=high --ignore-scripts",
      "npm run build:release",
      "npm run test:pages-boundary",
    ];
    const passing = await preflightFixture();
    const passed = runPreflight(passing);
    expect(passed.status, passed.stderr).toBe(0);
    expect((await readFile(passing.log, "utf8")).trim().split("\n")).toEqual(calls);

    for (const [failedCall, expectedCalls] of [
      ["ci", calls.slice(0, 1)],
      ["run check:playwright-runtime", calls.slice(0, 2)],
      ["run typecheck", calls.slice(0, 5)],
      ["run build:release", calls.slice(0, 10)],
      ["run test:pages-boundary", calls.slice(0, 11)],
    ]) {
      const fixture = await preflightFixture();
      const result = runPreflight(fixture, { FAIL_NPM: failedCall });
      expect(result.status, failedCall).toBe(41);
      expect((await readFile(fixture.log, "utf8")).trim().split("\n"), failedCall).toEqual(expectedCalls);
      expect(result.stdout, failedCall).not.toContain("MANUAL STEP REQUIRED");
      expect(result.stdout, failedCall).not.toContain("Automated preflight release checks passed");
    }
  });

  it("runs the Beads hook and blocks a planted violation through the real pre-push hook", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "enplace-hooks-"));
    temporaryRoots.push(root);
    await Promise.all([
      mkdir(path.join(root, ".githooks"), { recursive: true }),
      mkdir(path.join(root, ".beads", "hooks"), { recursive: true }),
      mkdir(path.join(root, "bin"), { recursive: true }),
      mkdir(path.join(root, "scripts"), { recursive: true })
    ]);
    await copyExecutable(".githooks/pre-push", path.join(root, ".githooks", "pre-push"));
    await copyExecutable("scripts/pre-push.sh", path.join(root, "scripts", "pre-push.sh"));
    await copyExecutable("scripts/residue-scan.sh", path.join(root, "scripts", "residue-scan.sh"));
    await copyExecutable("scripts/install-git-hooks.sh", path.join(root, "scripts", "install-git-hooks.sh"));
    await writeFile(path.join(root, "bin", "bd"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > bd-call.txt\n");
    await chmod(path.join(root, "bin", "bd"), 0o755);
    await writeFile(
      path.join(root, ".beads", "hooks", "pre-push"),
      "#!/usr/bin/env bash\nIFS= read -r ref\nprintf '%s\\n' \"$ref\" > beads-input.txt\n"
    );
    await chmod(path.join(root, ".beads", "hooks", "pre-push"), 0o755);
    await writeFile(path.join(root, "README.md"), "Safe fixture\n");
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture User");
    git(root, "config", "user.email", "fixture@example.test");
    const installed = run(root, "bash", ["scripts/install-git-hooks.sh"], undefined, {
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(git(root, "config", "core.hooksPath")).toBe(".githooks");
    await expect(readFile(path.join(root, "bd-call.txt"), "utf8")).resolves.toBe("hooks install --beads\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "safe base");
    const base = git(root, "rev-parse", "HEAD");

    const plantedCredential = `g${"hp_"}${"A".repeat(32)}`;
    await writeFile(path.join(root, "private.txt"), `${plantedCredential}\n`);
    git(root, "add", "private.txt");
    git(root, "commit", "-qm", "plant violation");
    const local = git(root, "rev-parse", "HEAD");
    const refs = `refs/heads/main ${local} refs/heads/main ${base}\n`;

    const result = run(root, "bash", [".githooks/pre-push", "origin", "fixture"], refs);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Push blocked");
    expect(await readFile(path.join(root, "beads-input.txt"), "utf8")).toBe(refs);
  });
});
