import { defineConfig } from "vite";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const EARLY_HINT_ROUTES = ["/", "/index.html", "/shopping", "/planner", "/settings"] as const;
// Cloudflare Pages counts the header name and value in its 2,000-character per-line limit.
const HEADER_LINE_LIMIT = 2_000;

function stylesheetHrefs(html: string): string[] {
  return [...html.matchAll(/<link(?=[^>]*\srel=["']stylesheet["'])[^>]*\shref=["']([^"']+)["'][^>]*>/gi)]
    .map(([, href]) => href);
}

function preloadFontHrefs(html: string): string[] {
  return [...html.matchAll(/<link(?=[^>]*\srel=["']preload["'])(?=[^>]*\sas=["']font["'])[^>]*\shref=["']([^"']+)["'][^>]*>/gi)]
    .map(([, href]) => href);
}

function appShellServiceWorker(): Plugin {
  return {
    name: "enplace-app-shell-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle);
      const mount = outputs.find((output) =>
        output.type === "chunk" && output.facadeModuleId?.endsWith("/src/mount.tsx")
      );
      const html = bundle["index.html"];
      if (!mount || html?.type !== "asset") this.error("Could not create cold-boot preload hints.");
      const htmlSource = String(html.source);
      if (!htmlSource.includes("  </head>")) this.error("Could not insert cold-boot preload hints.");

      const staticImports = new Set<string>();
      const collectImports = (fileName: string): void => {
        const output = bundle[fileName];
        if (!output || output.type !== "chunk" || output.isEntry || staticImports.has(fileName)) return;
        staticImports.add(fileName);
        output.imports.forEach(collectImports);
      };
      mount.imports.forEach(collectImports);
      const importedCss = [...((mount as typeof mount & {
        viteMetadata?: { importedCss?: Set<string> };
      }).viteMetadata?.importedCss ?? [])];
      const modulePreloads = [mount.fileName, ...staticImports];
      const hints = [
        ...modulePreloads.map((fileName) =>
          `    <link rel="modulepreload" crossorigin href="/${fileName}">`
        ),
        ...importedCss.map((fileName) =>
          `    <link rel="stylesheet" crossorigin href="/${fileName}">`
        ),
      ].join("\n");
      html.source = htmlSource.replace("  </head>", `${hints}\n  </head>`);

      const renderedHtml = String(html.source);
      const stylesheets = stylesheetHrefs(renderedHtml);
      const fontPreloads = preloadFontHrefs(renderedHtml);
      if (fontPreloads.length !== 2) this.error(`Expected two font preloads, found ${fontPreloads.length}.`);
      const earlyHints = [
        ...modulePreloads.map((fileName) => `</${fileName}>; rel=modulepreload; crossorigin`),
        ...stylesheets.map((href) => `<${href}>; rel=preload; as=style; crossorigin`),
        ...fontPreloads.map((href) => `<${href}>; rel=preload; as=font; type="font/woff2"; crossorigin`),
      ];
      const linkHeader = `  Link: ${earlyHints.join(", ")}`;
      if (linkHeader.length > HEADER_LINE_LIMIT) {
        this.error(`Generated Link header is ${linkHeader.length} characters; Cloudflare Pages permits ${HEADER_LINE_LIMIT}.`);
      }
      const trackedHeaders = readFileSync(path.resolve(__dirname, "public/_headers"), "utf8").trimEnd();
      const navigationHeaders = EARLY_HINT_ROUTES
        .map((route) => `${route}\n  Cache-Control: no-store\n${linkHeader}`)
        .join("\n\n");
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: `${trackedHeaders}\n\n# Generated from this build's navigation-shell assets.\n${navigationHeaders}\n`,
      });

      // Precache only what launch and offline reading need. Both sample packs and the large
      // icon are cached on first use instead. Cache the canonical root so hosts that redirect
      // /index.html never leave a redirected response that Chromium rejects for navigation.
      const files = new Set(["/", "/manifest.webmanifest", "/enplace-mark.png", "/icons/icon-192.png"]);
      const deferred = /(?:^|\/)sample-(?:pack|covers)-[^/]+\.pack$|(?:^|\/)browser-[^/]+\.js$/;
      for (const output of outputs) {
        if (output.fileName !== "index.html" && !deferred.test(output.fileName)) files.add(`/${output.fileName}`);
      }
      const precache = [...files].sort();
      const template = readFileSync(path.resolve(__dirname, "src/pwa/service-worker.js"), "utf8");
      const version = createHash("sha256")
        .update(precache.join("\n"))
        .update("\0")
        .update(template)
        .update("\0")
        .update(String(html.source))
        .digest("hex")
        .slice(0, 12);
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

export default defineConfig({
  plugins: [appShellServiceWorker()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "react/jsx-runtime": "preact/jsx-runtime",
      "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
      "react-dom/client": "preact/compat/client",
      "react-dom/server": "preact/compat/server",
      "react-dom/test-utils": "preact/test-utils",
      "react-dom": "preact/compat",
      "react": "preact/compat",
    },
    dedupe: ["preact"],
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
  },
});
