import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScrollArtifact, isExpectedWatchAbort } from "./benchmark-recipe-scroll.mjs";

function transport(count = 0, invokeCommands = [], detailCount = 0) {
  return {
    requests: count + detailCount,
    responses: count + detailCount,
    failedResponses: 0,
    transferredBytes: (count + detailCount) * 100,
    uniqueImages: count + detailCount,
    variants: {
      "v4-320": { requests: count, responses: count, transferredBytes: count * 100, uniqueImages: count },
      "v4-640": { requests: detailCount, responses: detailCount, transferredBytes: detailCount * 100, uniqueImages: detailCount },
      other: { requests: 0, responses: 0, transferredBytes: 0, uniqueImages: 0 }
    },
    timing: {
      responseCountWithTiming: count,
      duplicateRequestCount: 0,
      invokeEvents: invokeCommands.map((command) => ({ command, status: 200, startedAtOffsetMs: 10, responseAtOffsetMs: 20, durationMs: 10 }))
    }
  };
}

function phase(readinessMs = 1000) {
  return {
    readinessMs,
    firstVisibleCoverMs: readinessMs / 2,
    readinessTransport: transport(500, ["mep_recipe_database_stream", "mep_prepare_database_thumbnails", "mep_prepare_database_thumbnails"]),
    scroll: {
      frameP95Ms: 16.5,
      frameMaxMs: 24,
      longFrames: 0,
      severeFrames: 0,
      minVisibleCards: 8,
      maxEmptyCovers: 0,
      maxBlankCovers: 0,
      maxErrorCovers: 0,
      maxIncompleteImages: 0,
      maxSyntheticImages: 0,
      transport: transport()
    }
  };
}

function phaseMarks() {
  return {
    navigationStarted: { timestamp: new Date().toISOString(), elapsedMs: 0 },
    databaseCountReady: { timestamp: new Date().toISOString(), elapsedMs: 10 },
    gridReady: { timestamp: new Date().toISOString(), elapsedMs: 20 },
    scrollStarted: { timestamp: new Date().toISOString(), elapsedMs: 30 },
    scrollCompleted: { timestamp: new Date().toISOString(), elapsedMs: 40 }
  };
}

function validArtifact() {
  const runMetrics = Array.from({ length: 5 }, (_, index) => ({
    run: index + 1,
    environment: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64", cpuCount: 8, browserUserAgent: "HeadlessChrome/test" },
    phaseTimestamps: { cold: { marks: phaseMarks() }, warm: { marks: phaseMarks() } },
    performanceEvidence: {
      cold: { readiness: { longTaskSupported: true, longTaskCount: 0, longTasks: [] }, scroll: { longTaskSupported: true, longTaskCount: 0, longTasks: [] } },
      warm: { readiness: { longTaskSupported: true, longTaskCount: 0, longTasks: [] }, scroll: { longTaskSupported: true, longTaskCount: 0, longTasks: [] } }
    },
    cold: phase(900 + index * 10),
    warm: phase(1200 + index * 10)
  }));
  return {
    runs: 5,
    completedRuns: 5,
    workload: { recipes: 500, raster: "png", phases: ["cold", "warm"] },
    artifactGeneratedAt: new Date().toISOString(),
    buildIdentity: {
      gitHead: "0123456789abcdef0123456789abcdef01234567",
      worktreeDirty: true,
      worktreeStatusSha256: "a".repeat(64),
      benchmarkScriptSha256: "b".repeat(64)
    },
    thresholds: {
      frameP95Ms: 18,
      coldReadinessP95Ms: 30000,
      warmReadinessP95Ms: 5000,
      firstVisibleCoverP95Ms: 30000,
      scrollImageResponses: 0,
      scrollImageBytes: 0
    },
    runMetrics,
    readinessMs: {
      cold: { p95: 940 },
      warm: { p95: 1240 }
    },
    firstVisibleCoverMs: {
      cold: { p95: 470 },
      warm: { p95: 620 }
    },
    p95FrameGap: { p95: 16.5 },
    totalSevereFrames: 0,
    maxEmptyCovers: 0,
    maxBlankCovers: 0,
    maxErrorCovers: 0,
    maxIncompleteImages: 0,
    maxSyntheticImages: 0,
    imageTransport: {
      coldScrollResponses: { max: 0 },
      warmScrollResponses: { max: 0 },
      coldScrollBytes: { max: 0 },
      warmScrollBytes: { max: 0 },
      coldScrollUniqueImages: { max: 0 },
      warmScrollUniqueImages: { max: 0 }
    },
    consoleDiagnostics: [],
    failedRequests: []
  };
}

test("accepts one database stream and exactly two thumbnail preparation invokes", () => {
  assert.deepEqual(evaluateScrollArtifact(validArtifact()), []);
});

test("rejects one or three thumbnail preparation invokes", () => {
  for (const count of [1, 3]) {
    const artifact = validArtifact();
    artifact.runMetrics[0].warm.readinessTransport = transport(500, [
      "mep_recipe_database_stream",
      ...Array.from({ length: count }, () => "mep_prepare_database_thumbnails")
    ]);
    const failures = evaluateScrollArtifact(artifact);
    assert.ok(failures.some((failure) => failure.includes(`run 1 warm mep_prepare_database_thumbnails count ${count} !== 2`)));
  }
});

test("keeps the database stream invoke count exact", () => {
  for (const count of [0, 2]) {
    const artifact = validArtifact();
    artifact.runMetrics[0].warm.readinessTransport = transport(500, [
      ...Array.from({ length: count }, () => "mep_recipe_database_stream"),
      "mep_prepare_database_thumbnails",
      "mep_prepare_database_thumbnails"
    ]);
    const failures = evaluateScrollArtifact(artifact);
    assert.ok(failures.some((failure) => failure.includes(`run 1 warm mep_recipe_database_stream count ${count} !== 1`)));
  }
});

test("classifies only exact watch request aborts as expected teardown", () => {
  const watchUrl = "http://127.0.0.1:4173/api/watch?generation=0";
  assert.equal(isExpectedWatchAbort(watchUrl, "net::ERR_ABORTED"), true);
  assert.equal(isExpectedWatchAbort(watchUrl, "net::ERR_FAILED"), false);
  assert.equal(isExpectedWatchAbort(watchUrl, "HTTP 503"), false);
  assert.equal(isExpectedWatchAbort("http://127.0.0.1:4173/api/watchdog?generation=0", "net::ERR_ABORTED"), false);
  assert.equal(isExpectedWatchAbort("http://127.0.0.1:4173/api/other?next=/api/watch", "net::ERR_ABORTED"), false);
});

test("rejects incomplete and stale-shaped scroll evidence", () => {
  const artifact = validArtifact();
  artifact.runs = 4;
  artifact.completedRuns = 4;
  artifact.thresholds.warmReadinessP95Ms = 5120;
  artifact.runMetrics.pop();
  delete artifact.artifactGeneratedAt;
  delete artifact.buildIdentity;
  const failures = evaluateScrollArtifact(artifact);
  assert.ok(failures.some((failure) => failure.includes("runs 4 !== 5")));
  assert.ok(failures.some((failure) => failure.includes("warm readiness threshold 5120 !== 5000")));
  assert.ok(failures.some((failure) => failure.includes("artifact timestamp missing")));
  assert.ok(failures.some((failure) => failure.includes("build identity missing")));
  assert.ok(failures.some((failure) => failure.includes("runMetrics length 4 !== 5")));
});

test("rejects an individual warm-phase regression even when aggregate fields look clean", () => {
  const artifact = validArtifact();
  artifact.runMetrics[2].warm.readinessMs = 5001;
  artifact.runMetrics[2].warm.scroll.frameP95Ms = 18.1;
  const failures = evaluateScrollArtifact(artifact);
  assert.ok(failures.some((failure) => failure.includes("run 3 warm readiness 5001ms > 5000ms")));
  assert.ok(failures.some((failure) => failure.includes("run 3 warm frame p95 18.1ms > 18ms")));
});

test("does not let legitimate detail prewarm traffic mask a card-count defect", () => {
  const artifact = validArtifact();
  artifact.runMetrics[0].warm.readinessTransport = transport(499, ["mep_recipe_database_stream", "mep_prepare_database_thumbnails"], 12);
  const failures = evaluateScrollArtifact(artifact);
  assert.ok(failures.some((failure) => failure.includes("run 1 warm readiness card transport 499/499/499")));
});
