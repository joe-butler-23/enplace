import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string };

type GitState = { commit: string; shortCommit: string; dirty: boolean };

function gitOutput(args: string[], state: string): string {
  try {
    return execFileSync("git", args, {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new Error(`Cannot build portable kanban artifacts without an exact Git ${state}.`, { cause });
  }
}

function readGitState(): GitState {
  const commit = gitOutput(["rev-parse", "--verify", "HEAD^{commit}"], "source commit");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
    throw new Error(`Cannot build portable kanban artifacts: Git returned an invalid commit "${commit}".`);
  }
  return {
    commit,
    shortCommit: commit.slice(0, 8),
    dirty: gitOutput(["status", "--porcelain", "--untracked-files=normal"], "working-tree state").length > 0,
  };
}

export default defineConfig(() => {
  const git = readGitState();
  return {
    publicDir: path.resolve(__dirname, "src/kanban-component/licenses"),
    plugins: [{
      name: "kanban-provenance",
      enforce: "post" as const,
      generateBundle: {
        order: "post" as const,
        handler(_options, bundle) {
          const provenance = JSON.parse(readFileSync(
            path.resolve(__dirname, "src/kanban-component/PROVENANCE.json"),
            "utf8",
          )) as {
            source: { commit: string; dirty: boolean };
            artifact: { files: Array<{ path: string; bytes: number; sha256: string }> };
          };
          provenance.source.commit = git.commit;
          provenance.source.dirty = git.dirty;
          provenance.artifact.files = Object.values(bundle)
            .filter((output) => output.fileName.endsWith(".mjs") || output.fileName.endsWith(".css"))
            .map((output) => {
              const bytes = Buffer.from(output.type === "chunk" ? output.code : output.source);
              return {
                path: output.fileName,
                bytes: bytes.byteLength,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              };
            })
            .sort((left, right) => left.path.localeCompare(right.path));
          this.emitFile({
            type: "asset",
            fileName: "PROVENANCE.json",
            source: `${JSON.stringify(provenance, null, 2)}
`,
          });
        },
      },
    }],
    build: {
      outDir: "dist-kanban-client",
      emptyOutDir: true,
      target: "esnext",
      minify: true,
      lib: {
        entry: path.resolve(__dirname, "src/kanban-component/client.ts"),
        formats: ["es"],
        fileName: () => "kanban-client.mjs",
        cssFileName: "kanban-client",
      },
      rolldownOptions: {
        output: {
          banner: `/*!
 * kanban-client v${pkg.version} (${git.shortCommit}${git.dirty ? "-dirty" : ""})
 * Portable jKanban 1.3.1 + Dragula 3.7.3 client; see PROVENANCE.json and bundled licences.
 * Generated for the kanban client browser contract. Do not edit.
 */`,
        },
      },
    },
  };
});
