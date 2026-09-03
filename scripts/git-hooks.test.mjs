import { afterEach, describe, expect, it } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

describe("tracked Git hook composition", () => {
  it("refuses to certify a release with the expensive gate bypassed", () => {
    const result = spawnSync("bash", ["scripts/preflight-release.sh"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, SKIP_MEP_PREPUSH: "1" }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refuses SKIP_MEP_PREPUSH=1");
  });

  it("keeps static PWA and manual install certification explicit", async () => {
    const [prepush, release] = await Promise.all([
      readFile(path.join(repositoryRoot, "scripts/pre-push.sh"), "utf8"),
      readFile(path.join(repositoryRoot, "scripts/preflight-release.sh"), "utf8")
    ]);
    expect(prepush).toContain("npm run test:static-pwa");
    expect(release).toContain("npm audit --audit-level=high --ignore-scripts");
    expect(release).not.toContain("Cargo.lock");
    expect(release).toContain(
      "Automated preflight release checks passed; manual installed-PWA certification remains required."
    );
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
