import path from "node:path";
import { lstat, realpath, readdir, stat } from "node:fs/promises";

function ensureWithin(root, candidate) {
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes the vault root: ${candidate}`);
  }
  return candidate;
}

async function canonicalPath(target) {
  let candidate = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      return path.join(await realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        if ((await lstat(candidate)).isSymbolicLink()) throw new Error(`Path escapes the vault root: ${target}`);
      } catch (lstatError) {
        if (lstatError?.code !== "ENOENT") throw lstatError;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function canonicalContainedPath(root, candidate) {
  const [canonicalRoot, canonicalTarget] = await Promise.all([canonicalPath(root), canonicalPath(candidate)]);
  return ensureWithin(canonicalRoot, canonicalTarget);
}

export async function resolveContainedVaultImage(rawPath, recipeDir, vaultRoot) {
  const value = String(rawPath || "").trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const cleaned = value.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
  if (!cleaned) return null;
  const candidates = cleaned.startsWith("/")
    ? [path.join(vaultRoot, cleaned)]
    : [path.join(recipeDir, cleaned), path.join(vaultRoot, cleaned)];
  for (const candidate of candidates) {
    try {
      const contained = await canonicalContainedPath(vaultRoot, candidate);
      if ((await stat(contained)).isFile()) return contained;
    } catch (error) {
      try {
        await lstat(candidate);
      } catch (missing) {
        if (missing?.code === "ENOENT") continue;
      }
      throw error;
    }
  }
  return null;
}

export async function collectContainedMarkdownFiles(vaultRoot, sourceRoot) {
  const results = [];
  const visited = new Set();
  async function walk(current) {
    const contained = await canonicalContainedPath(vaultRoot, current);
    if (visited.has(contained)) return;
    visited.add(contained);
    for (const entry of await readdir(contained, { withFileTypes: true })) {
      const target = await canonicalContainedPath(vaultRoot, path.join(contained, entry.name));
      const info = await stat(target);
      if (info.isDirectory()) await walk(target);
      else if (info.isFile() && entry.name.toLowerCase().endsWith(".md")) results.push(target);
    }
  }
  await walk(sourceRoot);
  return results;
}
