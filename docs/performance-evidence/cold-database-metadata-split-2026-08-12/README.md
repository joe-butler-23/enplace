# Cold Recipe Database Metadata Split — 2026-08-12

## Contract and scope

This follow-up keeps the frozen cold workload and primary authority from `../cold-database-2026-08-12`: 500 deterministic Markdown recipes with 500 unique PNG covers, isolated web host and derived state, direct `/database`, 1440×1000, and exact buffered `PerformanceElementTiming.renderTime` for the first four paths named by the semantic-ready mark. Five balanced interleaved control/candidate pairs were collected sequentially on AC with load1m ≤2.0; no samples, outliers, or replacements were excluded. All-cover completion could not regress more than 15%. Every sample had to preserve 500 exact ordered ready/natural covers, zero image errors, three invokes/173,959 bytes, and 500 thumbnail responses/15,868,758 bytes.

This evidence is synthetic web-host evidence. Separate launched-native and Planner-navigation checks are recorded below rather than inferred from it.

## Experiments

1. **REJECT — V1 metadata split (`a5efe6d`).** Direct `/database` avoided eager Markdown parsing and improved exact first-four presentation in every pair (median −116ms/−27.1%) and all-cover median (−155.7ms/−9.4%), but semantic-ready regressed by +1,157.4ms because current-generation cover settlement gated the foreground. It also left required metadata/vault refresh completion outside the observed lifetime. Rejected under the frozen semantic/no-shift contract.
2. **REJECT — frontend metadata-snapshot index reuse.** The uncommitted diagnostic required frontend/backend manifest authority, fallback scans, generations, native watcher epochs, and migration semantics; focused platform/native checks remained red. Rejected as incorrect and non-lean. Any future reuse must be backend-owned with one stream authority and watcher epochs covering completed and in-flight roots.
3. **KEEP — V2 completion-owned metadata hydration (`82a5349`).** Hydration starts after exact current-query/current-items first-five scheduling rather than all-cover settlement; the Database semantic gate uses source pending while current-generation settlement still throttles detail prewarm. Five pairs improved semantic-ready by −69.2ms/−21.2% and exact first-four by −76ms/−20.0%; all-cover median improved −55.3ms/−3.48%. Exactly one metadata-complete mark occurred before all-cover in every sample. Full-vault refresh completion was still unknown, so V2 was not final.
4. **KEEP — V3 authoritative refresh evidence (`0849763`).** A generation-fenced, success-only performance mark proves completion of the existing awaited full-vault refresh without changing scheduling. The final five control/V3 pairs improved semantic-ready in all pairs (median −54.6ms/−19.5%) and exact first-four in all pairs (−48ms/−15.2%). All-cover median improved −24.3ms/−1.63%; the two slower pairs were only +1.43%/+1.65%, inside the 15% guardrail. Each V3 sample emitted exactly one metadata completion followed by exactly one current-generation refresh success 1.07–1.18s before all-cover.
5. **KEEP — exact native direct route (`2745684`).** Launched-native verification exposed that a Tauri target at `/database` still initialized Planner. The minimal fix maps exact native `/database` to Database while native default/unknown paths remain Planner and remote routing/history are unchanged.

## Final paired result

| Metric (cold, fixture, observer) | Control p95 | V3 p95 | Paired median V3−control |
|---|---:|---:|---:|
| semantic-ready | 307.6ms | 236.4ms | **−54.6ms / −19.5%** |
| exact first-four presentation | 376ms | 308ms | **−48ms / −15.2%** |
| all 500 covers | 1,594.6ms | 1,557.0ms | −24.3ms / −1.63% |

All ten samples were valid. V3 won all semantic and exact-presentation pairs. Correctness, transport, all-cover, metadata-completion, and vault-refresh-completion gates passed. Control long-task totals were all zero; V3 totals were `[0, 51, 0, 0, 0]ms`. The single post-primary 51ms task is retained as a trade-off; no frozen long-task rejection budget existed.

Each version (`v1`, `v2`, `v3-final`) was captured as a frozen precollection plan plus ten raw samples and a derived paired result; those raw capture directories were removed from the repository ahead of public republish. The final V3 result SHA-256 is `4f5494604a79b6a3dd8491f78e297b90bf69ea73634876bb758c3c474250a31c`; the independently reproduced plan SHA-256 is `e85c3c9126fab50cf72a3ab2c149ffb79d6e6a8a69df2563d86290de4a2774d2`. Independent read-only review reproduced every raw hash, the schedule, arithmetic, correctness/transport checks, and both anti-shift gates.

## Cross-surface proof

- **Immediate Database→Planner:** exact V3 passed an isolated deterministic Playwright runtime check. Earliest actionable navigation showed owned metadata loading, never an empty ready board; completion produced the exact four scheduled recipes. A real filesystem EACCES produced the visible error state and a distinct retry performed a fresh successful batch read. Raw scratch log SHA-256: `7ea046f67e9684b7d687fea5b7110153d4780e807d0b8cc4070eb013f321eba8`.
- **Native Tauri:** exact final product `2745684` launched with fresh isolated HOME/XDG state and the 500-recipe fixture. `/database` initially rendered Recipe Database without a click; 500 cards were ready. The visible first row decoded at 256×144. Native `convertFileSrc` produced an `asset://localhost/...jpg` URL whose fetch returned 200/image/jpeg/32,985 bytes and decoded at 256×144. The unchanged V3 parent additionally passed a full far-scroll check. Console inspection and `test-tauri-console.sh --fail-on-match` reported no relevant warning/error; Planner navigation remained functional. No live vault or appdata was opened.

## Release scroll gate

`npm run perf:release` initially exposed two stale evidence assertions that failed identically on control `edd4fe4` and the final candidate: it still required one thumbnail-preparation invoke although the accepted two-stage product deliberately performs exactly two, and it counted the long-poll `/api/watch` cancellation caused by each benchmark page teardown as a request failure. Commit `1a31e3b` makes the gate exact to current behavior (one database stream, exactly two preparation invokes) and ignores only the exact watch pathname with Playwright's exact `net::ERR_ABORTED`; all other watch errors and HTTP failures remain diagnostics. Focused tests reject one or three prepare invokes and non-matching aborts.

On AC, the corrected unchanged-workload five-pass release lane passed at clean `1a31e3b`: frame-gap p95 16.8ms (budget 18ms), cold readiness p95 1,760ms, warm readiness p95 1,213ms, cold first-visible-cover p95 1,008ms, warm first-visible-cover p95 514ms, zero severe frames, and zero empty/blank/error/incomplete/synthetic visible covers. `release-scroll/` preserves the generated summary (the `bundle.json` and `benchmark.json` captures were removed ahead of public republish); benchmark SHA-256 was `c95443fa1bca1959ab55865c9dc9b6418aa43fdd5711b3fc409c3ed8cde7d28b`.

## Residual scope

The result proves the frozen synthetic cold web-host workload and launched synthetic native parity, not latency on the live vault. Full refresh is now observed within the synthetic harness rather than shifted beyond it. A backend-owned authoritative index remains a separate potential intervention; the rejected frontend snapshot should not be revived.
