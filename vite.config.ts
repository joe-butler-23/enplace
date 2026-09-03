import { defineConfig } from "vite";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

function appShellServiceWorker(): Plugin {
  return {
    name: "enplace-app-shell-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = new Set(["/", "/index.html", "/manifest.webmanifest", "/enplace-mark.png", "/icons/icon-192.png", "/icons/icon-512.png"]);
      for (const output of Object.values(bundle)) files.add(`/${output.fileName}`);
      const precache = [...files].sort();
      const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 12);
      const template = readFileSync(path.resolve(__dirname, "src/pwa/service-worker.js"), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template
          .replace("__MEP_CACHE_NAME__", `enplace-shell-${version}`)
          .replace("__MEP_PRECACHE__", JSON.stringify(precache)),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  return {
    plugins: [appShellServiceWorker()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
      dedupe: ["react", "react-dom"],
    },
    define: {
      __MEP_DEV__: JSON.stringify(mode === "development"),
      global: "globalThis",
    },
    server: {
      host: "127.0.0.1",
      port: 5174,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
      fs: {
        allow: [path.resolve(__dirname)],
      },
    },
    base: "/",
    build: {
      target: "es2020",
      outDir: "dist-static",
      emptyOutDir: true,
      manifest: true,
      rolldownOptions: {
        output: {
          codeSplitting: {
            includeDependenciesRecursively: true,
            groups: [{
              name: "editor-vendor",
              test: /\/node_modules\/(?:@mdxeditor|@lexical|lexical|prismjs)\//,
              entriesAware: true,
            }],
          },
        },
      },
    },
  };
});
