import { afterEach, describe, expect, it } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scannerSource = path.join(repositoryRoot, "scripts", "residue-scan.sh");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(cwd, command, args, input) {
  return spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" }
  });
}

function git(cwd, ...args) {
  const result = run(cwd, "git", args);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function fixtureRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "enplace-residue-scan-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "scripts"));
  await copyFile(scannerSource, path.join(root, "scripts", "residue-scan.sh"));
  await chmod(path.join(root, "scripts", "residue-scan.sh"), 0o755);
  await writeFile(path.join(root, "README.md"), "Safe public fixture\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture User");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "safe base");
  return root;
}

describe("publication residue scanner", () => {
  it("ignores its pattern definitions but scans the rest of its own source", async () => {
    const root = await fixtureRepository();
    const result = run(root, "bash", ["scripts/residue-scan.sh"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Residue scan passed");

    const scanner = path.join(root, "scripts", "residue-scan.sh");
    const credential = `g${"hp_"}${"A".repeat(32)}`;
    await writeFile(scanner, `${await readFile(scanner, "utf8")}\n# ${credential}\n`);
    const planted = run(root, "bash", ["scripts/residue-scan.sh"]);
    expect(planted.status).toBe(1);
    expect(planted.stderr).toContain("scripts/residue-scan.sh");
  });

  it("parses Git's four-field pre-push records and blocks a planted credential", async () => {
    const root = await fixtureRepository();
    const base = git(root, "rev-parse", "HEAD");
    const plantedCredential = `g${"hp_"}${"A".repeat(32)}`;
    await writeFile(path.join(root, "private.txt"), `/home/student/vault ${plantedCredential}\n`);
    git(root, "add", "private.txt");
    git(root, "commit", "-qm", "plant violation");
    const local = git(root, "rev-parse", "HEAD");
    const refs = `refs/heads/main ${local} refs/heads/main ${base}\n`;

    const result = run(root, "bash", ["scripts/residue-scan.sh", "--pre-push"], refs);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Push blocked");
    expect(result.stderr).toContain("private.txt");
  });

  it("blocks residue introduced and removed inside the outgoing history", async () => {
    const root = await fixtureRepository();
    const base = git(root, "rev-parse", "HEAD");
    const plantedCredential = `g${"hp_"}${"A".repeat(32)}`;
    await mkdir(path.join(root, ".codex"));
    await writeFile(path.join(root, ".codex", "local.md"), "local only\n");
    await writeFile(path.join(root, "private.txt"), `${plantedCredential}\n`);
    git(root, "add", ".codex/local.md", "private.txt");
    git(root, "commit", "-qm", "plant then remove violations");
    await rm(path.join(root, ".codex"), { recursive: true });
    await rm(path.join(root, "private.txt"));
    git(root, "add", "-u");
    git(root, "commit", "-qm", "remove violations from tip");
    const local = git(root, "rev-parse", "HEAD");

    const result = run(root, "bash", ["scripts/residue-scan.sh", "--pre-push"],
      `refs/heads/main ${local} refs/heads/main ${base}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".codex/local.md");
    expect(result.stderr).toContain("private.txt");
  });

  it("scans only unpublished commits when the push creates a new remote branch", async () => {
    const root = await fixtureRepository();
    const plantedCredential = `g${"hp_"}${"A".repeat(32)}`;
    await writeFile(path.join(root, "historic.txt"), `${plantedCredential}\n`);
    git(root, "add", "historic.txt");
    git(root, "commit", "-qm", "historic violation already published");
    const published = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", "refs/remotes/origin/main", published);

    await writeFile(path.join(root, "feature.txt"), "clean feature work\n");
    git(root, "add", "feature.txt");
    git(root, "commit", "-qm", "clean feature commit");
    const clean = git(root, "rev-parse", "HEAD");
    const newBranchRefs = (sha) =>
      `refs/heads/feature ${sha} refs/heads/feature ${"0".repeat(40)}\n`;

    const cleanResult = run(root, "bash", ["scripts/residue-scan.sh", "--pre-push"], newBranchRefs(clean));
    expect(cleanResult.status, cleanResult.stderr).toBe(0);
    expect(cleanResult.stdout).toContain("Residue scan passed");

    await writeFile(path.join(root, "fresh.txt"), `${plantedCredential}\n`);
    git(root, "add", "fresh.txt");
    git(root, "commit", "-qm", "fresh violation");
    const dirty = git(root, "rev-parse", "HEAD");

    const dirtyResult = run(root, "bash", ["scripts/residue-scan.sh", "--pre-push"], newBranchRefs(dirty));
    expect(dirtyResult.status).toBe(1);
    expect(dirtyResult.stderr).toContain("fresh.txt");
    expect(dirtyResult.stderr).not.toContain("historic.txt");
  });

  it("fails closed when pre-push input cannot be inspected", async () => {
    const root = await fixtureRepository();
    const local = git(root, "rev-parse", "HEAD");
    for (const [input, message] of [
      ["two fields\n", "malformed pre-push ref record"],
      [`refs/heads/main ${local} refs/heads/main ${"0".repeat(39)}1\n`, "cannot enumerate outgoing commits"]
    ]) {
      const result = run(root, "bash", ["scripts/residue-scan.sh", "--pre-push"], input);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stdout).not.toContain("Residue scan passed");
    }
  });
});
