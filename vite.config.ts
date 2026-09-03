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
      // Precache only what a launch and offline reading need. The editor, the sample pack,
      // non-Latin font subsets, and the large icon are cached on first use instead.
      const files = new Set(["/", "/index.html", "/manifest.webmanifest", "/enplace-mark.png", "/icons/icon-192.png"]);
      // Only chunks that nothing but the editor imports are deferred; a chunk shared with the
      // entry graph must be precached, because first-visit loads happen before the worker
      // controls the page and so are never runtime-cached.
      const deferred = /(?:^|\/)(?:editor-vendor~RecipeEditor|RecipeEditor)-[^/]+\.(?:js|css)$|\.(?:md|webp)$|vietnamese|latin-ext/;
      for (const output of Object.values(bundle)) if (!deferred.test(output.fileName)) files.add(`/${output.fileName}`);
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
