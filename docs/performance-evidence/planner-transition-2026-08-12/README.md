# Database → Planner transition campaign (2026-08-12)

Frozen control product base: `bf71565d6bc1bf8871329621d170941c80d613ef`.
Instrumentation/harness head: `e8a1727` (product scheduling unchanged).
Harness SHA-256: `c5908d628c156e27b035b98e5ef5a2c400d31098e94693a6fb250fdf745d8702`.
Baseline raw SHA-256: `89296922a45e538f78de9c84085b9ebf69c7308f315c3d7e45dfd58689729e61`.

## Frozen authority

The resident `/database` workload uses one trusted 80 ms physical press, buffered `PerformanceElementTiming.renderTime` for the exact week-range and anchor-card title, and full ordered mixed-type semantic identity. No DOM, layout, screenshots, hashing, polling, or injected work occurs between pointerdown and exact presentation. Post-window DOM is a correctness diagnostic only.

## Three-sample baseline pilot

All three valid samples exactly presented `mep:planner-placeholder:suspense` before the correct board, so all are correctly `UNDERIVABLE` for an admissible final result. The correct mixed board later appeared in every sample with exact eight-lane order and one recipe/task/reminder/exercise fixture card per intended lane.

Raw diagnostic click → exact target latencies were **351.7, 412.0, and 394.2 ms** (median **394.2 ms**); pointerdown → target was **441.9, 496.6, and 477.6 ms**. Suspense painted **27.7–28.2 ms after click**. Semantic-ready followed **323.1–349.7 ms after click**. Week/card targets painted together in sample 1; the anchor lagged the toolbar by 56 ms and 40 ms in samples 2–3, exactly reproducing an intermediate toolbar-first frame.

Two earlier browser attempts lost click synthesis when an icon hit node was replaced during the physical dwell; one earlier valid sample reproduced the same Suspense fallback. The frozen input was corrected to the stable label side before the three evidence samples above. Three pre-window helper/selector failures generated no pointerdown and are infrastructure attempts, not measured samples.


## Final candidate and result

Final candidate: `73f7a1a8cdc9b592150f4051fe49319849a40f4a`. Frozen control harness/product: `f72c19b7199d8705100e552d0b9c24c6f0185205` over the original rebuilding mechanism. The final mechanism performs the authoritative full-vault refresh as app-owned background work, builds the complete mixed Planner while Database remains visible, and switches only after owned board-ready acknowledgement. A Planner press can promote the already-required refresh; cancellation does not cancel app-owned data work. Direct Planner startup is dataset-gated, refresh/retry is single-flight, initialization continuations are generation-fenced, and board construction has an explicit retryable error channel.

The final harness makes both frozen budgets binding: **click→exact presentation ≤50 ms** and **pointerdown→exact presentation ≤130 ms**. `status: OK` alone is not sufficient. Five predeclared alternating pairs all passed for the candidate and all controls presented the exact Suspense negative:

| pair | candidate click | candidate pointerdown | control |
|---:|---:|---:|---|
| 1 | 28.5 ms | 117.6 ms | exact Suspense negative |
| 2 | 33.6 ms | 118.9 ms | exact Suspense negative |
| 3 | 36.5 ms | 121.0 ms | exact Suspense negative |
| 4 | 29.9 ms | 113.9 ms | exact Suspense negative |
| 5 | 32.4 ms | 117.0 ms | exact Suspense negative |

All candidate samples exactly co-presented the week range and anchor title, retained the full ordered eight-lane recipe/task/reminder/exercise identity, and had no placeholder, early shell, long task, layout shift, console/network error, or residual loading surface. Three early-database samples also passed (click 28.7–31.7 ms; pointerdown 112.6–116.7 ms). Three real EACCES samples emitted one post-pointer, generation-bearing navigation failure and recovered through a distinct successful retry. Direct and embedded isolated-host smoke observed dataset readiness before the first board DOM and the mixed task after completion.

Independent falsification initially rejected `9a8ea67` for partial direct Planner rendering, embedded refresh deadlock, pre-click failure evidence, duplicate retry races, incomplete initialization fencing, and missing board-error ownership. Those defects were corrected. The final exact-head review in `independent-review.md` accepts `73f7a1a` and reproduces the latency/correctness conclusions.

### Counterevidence retained

The result is not claimed to be load-independent. Before latency budgets were made executable pass/fail, product-equivalent exact-head runs on a thermally saturated laptop produced over-budget samples, including one paired sample at 79.3 ms click / 165.0 ms pointerdown and early samples up to 60.3 / 150.1 ms. Those raw runs were reviewed and dispositioned during the campaign (raw capture files were later removed from the repository ahead of public republish); they are not excluded measurements or described as passes. The final predeclared certification used unchanged `powersave` policy, full battery/AC, no process or governor manipulation, and recorded cool-start temperature/load before every arm in a retained environment provenance capture. This establishes the target under the declared cooled benchmark condition, not an unconditional guarantee under arbitrary host saturation.

### Evidence files

The campaign's raw sample captures (three early samples, three failure/retry samples, ten paired samples, environment provenance, native launch evidence, and pre-binding counterevidence) were removed from the repository ahead of public republish; the independent review in `independent-review.md` records what was verified against them. Launched native parity passed at exact candidate `73f7a1a`: direct `/database` showed all 500 cards ready and the complete mixed Planner already resident, dataset-ready, and hidden; clicking revealed the same exact eight-lane identity with no loading/alert/error surface. Reminder filtering removed and restored only the reminder. Page console replay had zero warnings/errors and network replay zero failures. No live vault, appdata, main branch, or live service participated in collection.
