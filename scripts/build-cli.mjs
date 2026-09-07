import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist-cli", { recursive: true, force: true });
await build({
  entryPoints: ["cli/index.ts", "cli/client.ts", "src/core.ts", "src/agent/session.ts"],
  outbase: ".", outdir: "dist-cli", bundle: true, splitting: true, packages: "external",
  platform: "node", target: "node24", format: "esm",
});
