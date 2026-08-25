#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function evaluateBudget(bundle, benchmark, budgets) {
  const failures = [];
  if (bundle.initialRouteGzipBytes > budgets.initialRouteGzipBytes) {
    failures.push(
      "initial route gzip " + bundle.initialRouteGzipBytes + " > " + budgets.initialRouteGzipBytes
    );
  }
  const benchmarkBudget = budgets.benchmark;
  if (benchmark.p95FrameGap?.p95 > benchmarkBudget.p95FrameGapMs) {
    failures.push(
      "benchmark p95 frame gap " + benchmark.p95FrameGap.p95 + "ms > " + benchmarkBudget.p95FrameGapMs + "ms"
    );
  }
  if (benchmark.readinessMs?.cold?.p95 > benchmarkBudget.coldReadinessP95Ms) {
    failures.push(
      "benchmark cold readiness p95 " + benchmark.readinessMs.cold.p95 + "ms > " + benchmarkBudget.coldReadinessP95Ms + "ms"
    );
  }
  if (benchmark.readinessMs?.warm?.p95 > benchmarkBudget.warmReadinessP95Ms) {
    failures.push(
      "benchmark warm readiness p95 " + benchmark.readinessMs.warm.p95 + "ms > " + benchmarkBudget.warmReadinessP95Ms + "ms"
    );
  }
  if (benchmark.readinessMs?.warm?.median > benchmarkBudget.warmReadinessMedianMs) {
    failures.push(
      "benchmark warm readiness median " + benchmark.readinessMs.warm.median + "ms > " + benchmarkBudget.warmReadinessMedianMs + "ms"
    );
  }
  if (benchmark.firstVisibleCoverMs?.cold?.p95 > benchmarkBudget.coldFirstVisibleCoverP95Ms) {
    failures.push(
      "benchmark cold first-visible-cover p95 " + benchmark.firstVisibleCoverMs.cold.p95 + "ms > " + benchmarkBudget.coldFirstVisibleCoverP95Ms + "ms"
    );
  }
  if (benchmark.firstVisibleCoverMs?.warm?.p95 > benchmarkBudget.warmFirstVisibleCoverP95Ms) {
    failures.push(
      "benchmark warm first-visible-cover p95 " + benchmark.firstVisibleCoverMs.warm.p95 + "ms > " + benchmarkBudget.warmFirstVisibleCoverP95Ms + "ms"
    );
  }
  if (benchmark.totalSevereFrames > benchmarkBudget.severeFrames) {
    failures.push(
      "benchmark severe frames " + benchmark.totalSevereFrames + " > " + benchmarkBudget.severeFrames
    );
  }
  for (const key of ["maxEmptyCovers", "maxBlankCovers", "maxErrorCovers", "maxIncompleteImages", "maxSyntheticImages"]) {
    if (benchmark[key] > benchmarkBudget[key]) {
      failures.push("benchmark " + key + " " + benchmark[key] + " > " + benchmarkBudget[key]);
    }
  }
  const scrollImageResponses = Math.max(
    benchmark.imageTransport?.coldScrollResponses?.max ?? 0,
    benchmark.imageTransport?.warmScrollResponses?.max ?? 0
  );
  const scrollImageBytes = Math.max(
    benchmark.imageTransport?.coldScrollBytes?.max ?? 0,
    benchmark.imageTransport?.warmScrollBytes?.max ?? 0
  );
  if (scrollImageResponses > benchmarkBudget.scrollImageResponses) {
    failures.push("benchmark scroll image responses " + scrollImageResponses + " > " + benchmarkBudget.scrollImageResponses);
  }
  if (scrollImageBytes > benchmarkBudget.scrollImageBytes) {
    failures.push("benchmark scroll image bytes " + scrollImageBytes + " > " + benchmarkBudget.scrollImageBytes);
  }
  return failures;
}

function printAttribution(bundle) {
  console.error("Bundle attribution (gzip bytes):");
  for (const chunk of bundle.chunks.filter((chunk) => chunk.type === "javascript" || chunk.type === "stylesheet")) {
    console.error(
      "  " + chunk.role.padEnd(16) + String(chunk.gzipBytes).padStart(8) + "  " + chunk.name
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const bundlePath = path.resolve(value("--bundle", "target/release-evidence/bundle.json"));
  const benchmarkPath = path.resolve(value("--benchmark", "target/release-evidence/benchmark.json"));
  const budgetsPath = path.resolve(value("--budgets", new URL("./release-budgets.json", import.meta.url).pathname));
  const bundle = await readJson(bundlePath);
  const benchmark = await readJson(benchmarkPath);
  const budgets = await readJson(budgetsPath);
  const failures = evaluateBudget(bundle, benchmark, budgets);
  console.log("initial-route-gzip=" + bundle.initialRouteGzipBytes + " budget=" + budgets.initialRouteGzipBytes);
  console.log("benchmark-p95=" + benchmark.p95FrameGap.p95 + "ms budget=" + budgets.benchmark.p95FrameGapMs + "ms");
  console.log("cold-readiness-p95=" + benchmark.readinessMs.cold.p95 + "ms budget=" + budgets.benchmark.coldReadinessP95Ms + "ms");
  console.log("warm-readiness-p95=" + benchmark.readinessMs.warm.p95 + "ms budget=" + budgets.benchmark.warmReadinessP95Ms + "ms");
  console.log("warm-readiness-median=" + benchmark.readinessMs.warm.median + "ms budget=" + budgets.benchmark.warmReadinessMedianMs + "ms");
  console.log("cold-first-visible-cover-p95=" + benchmark.firstVisibleCoverMs.cold.p95 + "ms budget=" + budgets.benchmark.coldFirstVisibleCoverP95Ms + "ms");
  console.log("warm-first-visible-cover-p95=" + benchmark.firstVisibleCoverMs.warm.p95 + "ms budget=" + budgets.benchmark.warmFirstVisibleCoverP95Ms + "ms");
  console.log("severe-frames=" + benchmark.totalSevereFrames + " budget=" + budgets.benchmark.severeFrames);
  console.log("visible-cover-invariants=empty:" + benchmark.maxEmptyCovers + " blank:" + benchmark.maxBlankCovers + " error:" + benchmark.maxErrorCovers + " incomplete:" + benchmark.maxIncompleteImages + " synthetic:" + benchmark.maxSyntheticImages);
  if (failures.length) {
    for (const failure of failures) console.error("budget failed: " + failure);
    printAttribution(bundle);
    process.exitCode = 1;
    return;
  }
  console.log("release budgets passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("release budget check failed: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}

export { evaluateBudget };
