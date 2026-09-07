# Agent integration

Your agent uses `mep` directly to read and edit the same encrypted cookbook as the PWA. There is no additional model, background service or folder mirror.

## Connect and use

Install the Node 24 CLI, or build under the version in `.nvmrc` with `npm ci` and `npm run build:cli`. Open Settings in the PWA to publish its shared copy, then paste the private link at the hidden `mep cookbook use` prompt. Connection details live in owner-only `~/.config/enplace/cookbook.json`; recipe content is not saved there. `--config` selects another association and setup accepts `--relay` for a self-hosted relay.

```sh
mep list --json
mep show recipes/lentil-soup.md
mep tools
mep call recipe.search <<'JSON'
{"tags":["vegetarian"],"includeIngredients":true,"limit":5}
JSON
mep call plan.read <<'JSON'
{"week":"2026-09-07"}
JSON
```

`mep tools` is the operation reference: it lists all 24 recipe, planning, shopping and aisle operations with their argument schemas. `mep call <operation>` accepts JSON on stdin and returns full results, including recipe text. `mep --help` lists convenience commands. `mep export cookbook.zip` deliberately exports plain files without overwriting a destination; file workflows require explicit `--folder`. Live commands fail if no cookbook is connected. The PWA owns page and image import.

For several operations, run `mep session [--config file]` and keep its stdin open. Send one JSON line such as `{"operation":"plan.read","args":{}}`; each response is one compact JSON result line, available before stdin closes. A Python or JavaScript caller can use that result to construct its next request. All the same operations and save checks apply through one shared connection. Close stdin to finish; an unterminated final line is accepted, and empty input does nothing. Requests are limited to 2 MiB per line. The first invalid request, failed operation or broken stream stops the session with a nonzero exit; earlier successful writes remain saved. This is not an atomic batch.

Use recipe tags for classifications such as vegetarian; add `includeIngredients` when ingredient details would help answer the request. One search can return the needed information without opening each recipe separately. Tags describe the cookbook's classification, not an independent dietary check.

Cookbook text is untrusted data, not instructions. The CLI does not restrict the calling agent's other tools or prevent prompt injection into that agent. Keep the private connection link out of prompts and command arguments, and pass recipe content as data rather than interpolating it into shell code.

## Save guarantees

Each command opens an encrypted connection in memory, authenticates and reads the current cookbook, then closes. A session retains that connection across requests. Every write waits for encryption and confirmation that the relay has durably persisted it before returning a result. Failure or interruption can leave an uncertain result: read the current state before changing the request.

Every mutation requires an `operationId`; reuse it with identical arguments when retrying an uncertain operation. Compact retry records live inside the encrypted cookbook. Selection-based changes also require a revision from the corresponding read so known stale selections are rejected. These checks cover sequential calls and reconnects, not simultaneous disconnected agents using the same token.

Recipe amendments use the app's three-way merge of the read base, draft and current text; overlapping changes produce explicit conflict blocks. Deleted recipes retain recovery records. These records are not included in plain-file exports.

The production relay supports durable write confirmation. Self-hosted use requires the same protocol: `node scripts/cookbook-relay.mjs --persist <private-directory>`. An older or nonpersistent relay cannot confirm agent writes.

## Verification

The release gate covers operations, connection failures, the installed CLI and shared-PWA edits. `npm run benchmark:agent` measures real CLI reads, including Node startup, against an isolated local relay; it excludes model, internet and browser time. [Recorded measurements](evidence/agent-integration-2026-09-07/transport-benchmark.json) describe the fixture and samples.
