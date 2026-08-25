#!/usr/bin/env node

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

function argument(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function gzipBytes(buffer) {
  return gzipSync(buffer, { level: 9 }).byteLength;
}

function assetReferences(source) {
  const references = new Set();
  const pattern = /["']\.\/([^"']+\.(?:js|css))["']/g;
  for (const match of source.matchAll(pattern)) references.add(match[1]);
  return [...references].sort();
}

function classify(name, initial) {
  return initial.has(name) ? "initial-preload" : "lazy-or-route";
}

async function collectBundle(distDir) {
  const indexPath = path.join(distDir, "index.html");
  const indexHtml = await readFile(indexPath, "utf8");
  const entryMatch = indexHtml.match(/<script[^>]+src=["']\.?\/assets\/([^"']+\.js)["']/);
  if (!entryMatch) throw new Error("No JavaScript entry found in " + indexPath);
  const entry = entryMatch[1];
  const initial = new Set([entry]);
  for (const match of indexHtml.matchAll(/rel=["']modulepreload["'][^>]+href=["']\.?\/assets\/([^"']+\.js)["']/g)) {
    initial.add(match[1]);
  }
  const stylesheets = [...indexHtml.matchAll(/rel=["']stylesheet["'][^>]+href=["']\.?\/assets\/([^"']+\.css)["']/g)].map((match) => match[1]);
  const assetsDir = path.join(distDir, "assets");
  const names = (await readdir(assetsDir)).filter((name) => /\.(?:js|css)$/.test(name)).sort();
  const chunks = [];
  for (const name of names) {
    const filename = path.join(assetsDir, name);
    const bytes = await readFile(filename);
    const source = name.endsWith(".js") ? bytes.toString("utf8") : "";
    const imports = source ? assetReferences(source).filter((dependency) => names.includes(dependency)) : [];
    chunks.push({
      name,
      type: name.endsWith(".js") ? "javascript" : "stylesheet",
      role: name.endsWith(".js") ? classify(name, initial) : stylesheets.includes(name) ? "initial-preload" : "lazy-or-route",
      bytes: bytes.byteLength,
      gzipBytes: gzipBytes(bytes),
      imports
    });
  }
  const javascript = chunks.filter((chunk) => chunk.type === "javascript");
  const styles = chunks.filter((chunk) => chunk.type === "stylesheet");
  const initialJavaScript = javascript.filter((chunk) => initial.has(chunk.name));
  const initialStyles = styles.filter((chunk) => stylesheets.includes(chunk.name));
  return {
    entry,
    initialAssets: [...initial].sort(),
    initialStylesheets: stylesheets,
    initialJavaScriptGzipBytes: initialJavaScript.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    initialStylesheetGzipBytes: initialStyles.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    initialRouteGzipBytes: [...initialJavaScript, ...initialStyles].reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    chunks
  };
}

function formatBytes(bytes) {
  return (bytes / 1024).toFixed(1) + " KiB";
}

function printReport(report) {
  console.log("entry=" + report.entry);
  console.log("initial-route-gzip=" + formatBytes(report.initialRouteGzipBytes) + " (javascript=" + formatBytes(report.initialJavaScriptGzipBytes) + " styles=" + formatBytes(report.initialStylesheetGzipBytes) + ")");
  for (const chunk of report.chunks) {
    const imports = chunk.imports.length ? " imports=" + chunk.imports.join(",") : "";
    console.log((chunk.role + "                ").slice(0, 16) + " " + (chunk.type + "            ").slice(0, 12) + " " + formatBytes(chunk.gzipBytes).padStart(10) + " " + chunk.name + imports);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const distDir = path.resolve(argument(argv, "--dist", "dist-web"));
  const output = argument(argv, "--output", "");
  const report = await collectBundle(distDir);
  if (output) {
    const outputPath = path.resolve(output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log("wrote=" + output);
  }
  printReport(report);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("bundle report failed: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}

export { assetReferences, collectBundle, gzipBytes };
