# Agent integration

The agent operates on the same encrypted cookbook as the PWA. Recipes, `Plan.md`, `Shopping.md` and `Aisles.md` keep their existing authority and Markdown format. There is no background folder mirror, second meal schedule or new listening service.

## Connect and use

Build under the Node version in `.nvmrc` with `npm ci` and `npm run build:cli`, or install the packaged CLI. Open Settings in the PWA first; this publishes a previously device-only cookbook. Copy its private link, then run:

```sh
mep cookbook use
mep chat
```

Paste the link at the hidden prompt, not in a command argument or a model conversation. The association is an owner-only `~/.config/enplace/cookbook.json` containing the link secret and relay address. `XDG_CONFIG_HOME` and explicit `--config` select its location; `--relay` on setup selects a self-hosted relay. No recipe content is written there.

`mep chat` requires a terminal and opens the existing signed-in Claude Code with only the Enplace tools. The user can discuss options and revise their request throughout the conversation. Model prose stays in that direct user session.

For another assistant delegating a task:

```sh
mep agent 'Add a lentil soup recipe, plan it for Wednesday, and build the shopping list.'
```

This mode returns only code-produced read/write counts. It never returns recipe prose, model-written summaries or model diagnostics to the calling assistant. A completion receipt proves successful tool calls, not that the model satisfied every aspect of the request. An interrupted request may have committed earlier operations; inspect the cookbook before issuing a different intent.

`mep --help` lists terminal commands; `mep tools` lists operation schemas. `mep mcp` serves those tools over stdio. `mep export cookbook.zip` explicitly exports plaintext files without overwriting an existing destination. `--folder` retains deliberate file workflows.

## Cooking capability

- Recipes: lightweight list/search, complete RecipeMD reads and amendments, collision-resistant creation, deletion and recovery. Amendments retain the read base and use the app's three-way merge; overlapping edits produce explicit conflict blocks. Metadata, source provenance, yields, ingredients and instructions remain ordinary editable Markdown. Recipe images resolve only from stored cookbook content; the PWA owns image import.
- Planning: read the plan, mark recipes, add/move/remove dated occurrences and edit day notes.
- Shopping: read individual rows and merged groups, build from a week, add/edit/remove manual rows, check/uncheck exact rows or all members of a group, reset the list and maintain aisle assignments.

Every mutation requires an `operationId`. Reuse that id and identical arguments when retrying the same uncertain operation. Destructive and selection-based operations require a revision obtained from the corresponding read. A known changed selection is rejected so the agent can read it again. These checks do not lock an offline partner or turn Yjs into a distributed database transaction.

Compact retry receipts and deleted-recipe recovery records live inside the encrypted cookbook, outside plain-file exports. A replay returns the applied receipt and names the operation to read current state. Retry support covers serialized calls and reconnects; disconnected agents concurrently issuing the same token can still produce independent edits. Keep one cooking executor active for a delegated intent.

## Connection and storage guarantees

An MCP conversation holds one encrypted connection in memory. Every call checks the current connection handshake and authenticated hydration. Mutations wait for queued encryption to finish and for a nonce-bound receipt from the relay after durable persistence. A connection acknowledgement alone is insufficient. Cancellation, disconnect, authentication failure, sealing failure, a nonpersistent reference relay or a missing receipt fails the operation instead of claiming it was saved.

The production relay and persistent reference relay implement the same commit barrier. Old relay deployments remain compatible with browsers, but cannot acknowledge agent writes until upgraded. Use `node scripts/cookbook-relay.mjs --persist <private-directory>` for a self-hosted durable relay. The CLI does not keep a persistent cookbook cache.

## Execution boundary

MCP alone does not restrict an agent which also has shell, file or unrelated connector tools. The supplied launcher runs a clean Claude Code session with built-in tools disabled, only the Enplace MCP configuration, no discovered skills/plugins/hooks/project instructions and a scrubbed environment. Automated mode checks the actual advertised tool inventory and stops on unexpected authority. The existing credential store remains owned by Claude Code; its contents are never copied into model context.

The cooking model has no filesystem, shell, SSH, PTT, browser or arbitrary-fetch tool. In particular it cannot choose a network destination for recipe text. A user can supply extracted recipe text as input, or use the PWA's existing page/image importer. The private cookbook capability remains inside the connector. A malicious recipe can still mislead the model into an unwanted cooking change; it cannot create a host operation through this tool set. This is a restriction of model capabilities, not an operating-system sandbox against a compromised agent executable or trusted local user.

The launcher uses current Claude Code restriction flags and fails closed if unsupported. Direct terminal chat shares those flags and keeps the full conversation with the user. Adding these MCP tools to an unrestricted assistant yourself does not provide that boundary.

## Verification

The normal release gate covers operations, connection failures, the installed MCP package and shared-PWA edits. `npm run benchmark:agent` measures cold and reused connections through the built CLI. See the [recorded evidence](evidence/agent-integration-2026-09-07/README.md) for results and their limits.
