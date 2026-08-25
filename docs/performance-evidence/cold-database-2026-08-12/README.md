# Cold Recipe Database Latency Experiment Ledger — 2026-08-12

## Frozen contract

- Workload: 500 deterministic recipe Markdown files and 500 unique 256×144 PNG covers, direct `/database`, 1440×1000, isolated synthetic vault only.
- Primary boundary: navigation start to the latest exact `PerformanceElementTiming.renderTime` among the first four paths declared by `mep:database:semantic-ready`.
- Cold state: fresh web-host/helper process, host recipe index, appdata/derived-thumbnail cache, Chromium process and browser context for every sample. Source fixture files are freshly generated but may be resident in the OS page cache.
- Presentation authority: buffered `PerformanceObserver`, exact `elementtiming` identifiers. No DOM, screenshot or layout query occurs inside the primary window. DOM correctness runs after the endpoint.
- Repeats: 3-sample pilot, exactly 5 baseline samples, at least 2 per candidate, exactly 5 final samples. Nearest-rank percentiles; no replacement samples.
- Correctness: 500 exact ordered paths, reported count 500, every expected cover `ready`, complete and natural 256×144, zero image/page/request errors.
- Initial target: first-four p95 ≤2,500ms and ≥50% below baseline; semantic-ready p95 ≤1,000ms; all-cover completion no more than 15% slower. The absolute target was met; the deliberately ambitious relative stretch was not.

The full frozen contract, including guardrails and hypothesis budget, is recorded on Bead `mise-en-place-j3g` before product edits.

## Results

| Metric (cold, fixture, observer) | Baseline p95 | Final p95 | Change |
|---|---:|---:|---:|
| database semantic-ready | 729.9ms | 718.5ms | −1.6% |
| first exact cover presentation | 1,372ms | 852ms | **−37.9%** |
| first four exact cover presentations | 1,372ms | 852ms | **−37.9%** |
| all 500 covers decoded/terminal | 3,912.1ms | 3,877.7ms | −0.9% |

All five baseline and five final samples were derivable and passed exact count/order/image correctness. Thumbnail transport stayed at 500 unique responses and 15,868,758 bytes in the complete final resource record: the win does not skip images or bytes.

Raw per-sample capture files (`baseline.json`, `final.json`) were removed from the repository ahead of public republish; the summary tables above record the authoritative results. Baseline resource timing was capped by Chromium's default 250-entry buffer (225 thumbnails recorded); `e13b953` increased only the diagnostic buffer to 2,000 before final capture. This did not change the primary authority. A comparable post-change two-sample control at the baseline product recorded primary 1,232/1,400ms and long-task totals 109/113ms; the final median long-task total was 110ms. This shows the apparent 76→139ms p95 delta in the non-comparable five-run artifacts is dominated by the diagnostic-buffer change and one final outlier, not a median product regression.

Environment: AC charging, Linux `powersave` governor, one benchmark worker. The baseline and final runs used the same source-fixture generator and benchmark semantics; build and fixture creation were outside each timed sample.

## Experiments

1. **KEEP — two-stage visible-first preparation (first 5, then remaining 495).** The old single 500-path `mepPrepareDatabaseThumbnails` call blocked every cover. Preparing the complete first visible row first and scheduling it immediately reduced exact first-four p95 by 37.9%; the second stage still prepares both 320 and 640 variants for every remaining cover.
2. **TUNE — first tranche 24 → 8 → 5.** Two-sample first-four p95 was 892ms at 24, 820ms at 8, and 736ms at 5. Five is the exact first row at the frozen viewport, retains near-visible progress, and gave the best bounded candidate.
3. **REJECT — card-only first stage followed by all-path dual preparation.** Two-sample first-four p95 worsened to 808ms; reverted.
4. **REJECT — wait for first-stage resource-store settlement before starting background preparation.** Two-sample first-four p95 was 768ms, no improvement; reverted.
5. **REJECT — database image load concurrency 128 → 16.** All-cover p95 rose to 4,675.8ms (+19.5% versus baseline), beyond the 15% guardrail; reverted.
6. **REJECT — web-host bounded parallel Markdown reads.** Two-sample first-four p95 was 764ms with no clear gain over the simpler candidate; reverted.
7. **REJECT — remove frontend completion re-sort.** Expected sub-millisecond benefit; two-sample first-four results (832/852ms) showed no measurable primary improvement. Reverted while retaining this ledger entry.

## Residual scope

- This proof covers true cold web-host process/index/derived-cache/browser state. A durable-thumbnail restart lane remains useful but was not required to establish this regression win.
- Web evidence cannot prove native Tauri `asset://` rendering. Static asset-protocol checks and the native Rust test suite are release gates; a launched native database visual check remains a manual parity item.
- Native scan/type-gate and startup metadata work remain secondary measured opportunities; they were not mixed into the accepted image-barrier change.

## Verification

- `npm run typecheck`: pass.
- `npm test`: 53 files / 356 tests pass.
- `npm run build:web`: pass.
- `node --test scripts/benchmark-database-latency.node-test.mjs`: pass.
- `cargo test --workspace`: pass (including thumbnail ordering/dual-variant tests and Tauri recipe-database tests).
- `scripts/lint-tauri-asset-protocol.sh`: pass.
- `npm run perf:release`: bundle stage passed, but the scroll stage correctly refused to benchmark after the laptop changed from charging to discharging. No battery result was forced or represented as valid evidence. The fixed exact-presentation benchmark and post-boundary all-cover gate provide the performance/correctness evidence above; the existing full scroll gate should be rerun on AC before release.
