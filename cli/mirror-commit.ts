import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type Bytes = Uint8Array | null;
type CommitContext = {
  current: () => boolean;
  recoveryName: string;
};
type CommitResult = { result: "committed" | "retry"; recovery?: string };

/** Atomically publishes mirror-owned state inside an already validated private directory. */
export async function writePrivateFile(
  file: string,
  bytes: Uint8Array,
  existing: "replace" | "keep" = "replace",
): Promise<"written" | "exists"> {
  const operation = await mkdtemp(path.join(path.dirname(file), ".write-"));
  const replacement = path.join(operation, "replacement");
  try {
    await writeFile(replacement, bytes, { flag: "wx", mode: 0o600 });
    if (existing === "keep") return await noClobberLink(replacement, file) ? "written" : "exists";
    await rename(replacement, file);
    return "written";
  } finally {
    await unlinkIfPresent(replacement);
    await rmdir(operation);
  }
}

export async function createPrivateOperation(parent: string): Promise<string> {
  const privateRoot = await privateDirectory(parent, [".mep-mirror"], "mirror recovery");
  return mkdtemp(path.join(privateRoot, "operation-"));
}

export async function unlinkIfPresent(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function equal(left: Bytes, right: Bytes): boolean {
  if (left === null || right === null) return left === right;
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}
export async function optionalLstat(file: string) {
  try { return await lstat(file); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
export async function readOptional(file: string): Promise<Buffer | null> {
  try { return await readFile(file); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
export async function privateDirectory(root: string, parts: string[], label: string): Promise<string> {
  let candidate = root;
  for (const part of parts) {
    candidate = path.join(candidate, part);
    await mkdir(candidate, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`refusing invalid ${label} directory: ${candidate}`);
    }
    await chmod(candidate, 0o700);
  }
  return candidate;
}
export async function noClobberLink(source: string, target: string): Promise<boolean> {
  try { await link(source, target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
async function moveToRecovery(file: string, recovery: string): Promise<boolean> {
  try { await rename(file, recovery); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function atomicCommit(
  file: string,
  expected: Bytes,
  desired: Bytes,
  context: CommitContext,
): Promise<CommitResult> {
  const operation = await createPrivateOperation(path.dirname(file));
  const recovery = path.join(operation, context.recoveryName);
  const replacement = path.join(operation, "replacement");
  let captured: string | undefined;
  try {
    if (desired !== null) await writeFile(replacement, desired, { flag: "wx", mode: 0o600 });
    let mode = 0o600;
    if (expected === null && !context.current()) return { result: "retry" };
    if (expected !== null) {
      if (!await moveToRecovery(file, recovery)) return { result: "retry" };
      captured = recovery;
      const info = await lstat(recovery);
      if (!info.isFile()) throw new Error("mirror found a non-regular path after the atomic move");
      mode = info.mode & 0o777;
      const actual = await readFile(recovery);
      if (!equal(actual, expected) || !context.current()) {
        await noClobberLink(recovery, file);
        return { result: "retry", recovery };
      }
    }

    if (desired === null) return { result: "committed", recovery };
    await chmod(replacement, mode);
    const published = await noClobberLink(replacement, file);
    const result = published && equal(await readOptional(file), desired) && context.current()
      ? "committed" : "retry";
    return { result, recovery: captured };
  } catch (error) {
    if (!captured) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`mirror stopped after ${reason}; captured path kept at ${captured}`, { cause: error });
  } finally {
    await unlinkIfPresent(replacement);
    if (!captured) await rmdir(operation);
  }
}
