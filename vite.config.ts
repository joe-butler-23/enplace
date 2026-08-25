import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig(({ mode }) => {
  return {
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        obsidian: path.resolve(__dirname, "src/platform.ts"),
        "@joe-butler-23/ptt-node": path.resolve(__dirname, "src/shims/ptt-node.ts"),
        "ptt-node": path.resolve(__dirname, "src/shims/ptt-node.ts"),
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
      outDir: "dist-web",
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
