# Cookbook Relay

A cookbook syncs between devices through a y-websocket relay: a small server that speaks the Yjs websocket protocol, keeps a copy of each document by room name, and fans updates out to connected clients. The room name is the cookbook id. Enplace runs no code on the relay.

## Configuration

- Build-time default: `.env.static` carries the production relay URL, so `npm run build:static` always bakes it in; a `VITE_ENPLACE_RELAY_URL` in the environment overrides it, which the browser suite uses for its local relay.
- CLI: `mep mirror --relay wss://…` or `ENPLACE_RELAY_URL`.

When a mirror folder is a symlink, the CLI resolves it once, logs the physical directory, and uses that physical directory as the configured root for descendant path and symlink checks. Mirror filesystem safety assumes the caller owns that physical root and its ancestors: no hostile process may exchange an ancestor symlink or mount while an operation is awaiting Node filesystem calls. Pre-existing symlinks are still refused, and ordinary concurrent file writers are handled by atomic quarantine, no-clobber publication, and recovery. This is a local concurrency contract, not a security boundary against a hostile same-user process or mount administrator.

With no relay configured, a cookbook lives only on the device that made it. The app says so in the Settings panel.

A cookbook created on this device stays local until its first non-seed edit, so an untouched sample cookbook never creates relay state. Cookbooks opened from a link or remembered registry connect immediately, while a locally cached cookbook can open without waiting for that connection.

## The hosted relay

Production runs `relay/`: a Cloudflare Worker with one Durable Object per cookbook (`y-partyserver`), deployed as `enplace-relay` on the account's `workers.dev` subdomain. Clients connect to `wss://enplace-relay.joesdownloads.workers.dev/parties/kitchen/<cookbook-id>`, so the app is built with `VITE_ENPLACE_RELAY_URL=wss://enplace-relay.joesdownloads.workers.dev/parties/kitchen`. Each cookbook is persisted in its object's storage as chunks of one Yjs update, so it survives every client leaving. The hosted Worker limits each WebSocket frame to 4 MiB and each stored Yjs document to 16 MiB; an oversized frame or document closes only its sending socket. A Durable Object deletes its stored room after 180 days with no connection. After the one root `npm ci`, deploy the relay with `npm run deploy --workspace=enplace-relay`, and the site with `scripts/deploy-site.sh`, which builds against `.env.static` and uploads `dist-static` (both need a logged-in `wrangler`); the free plan covers it.

## Running one yourself

The repository includes the reference y-websocket relay:

```bash
npm run relay -- --port 1234 --host 127.0.0.1
```

Add `--persist ./cookbooks` to write each room as a Yjs update file. Without it, a room is dropped when its last client disconnects. Put the relay behind TLS so the app can connect with `wss:`.

Hosted options that speak the same protocol include Cloudflare Workers with Durable Objects (`y-partyserver`), which has a free tier large enough for hundreds of households. Relays are interchangeable because the document format is Yjs; moving between them is a matter of pointing the URL elsewhere and letting devices resync.

## Limits

The reference relay accepts only canonical 26-character cookbook ids and applies these defaults:

- 32 MiB per WebSocket message (`--max-message-bytes`)
- 16 MiB serialized Yjs document per room (`--max-document-bytes`)
- 64 KiB per awareness update (`--max-awareness-bytes`)
- 1,000 concurrent rooms (`--max-rooms`)
- 2,000 concurrent connections (`--max-connections`)

Each flag takes a positive byte or count value. The message limit must be at least 64 bytes greater than the document limit so a whole room can sync in one protocol message. Each connection may publish one awareness client. An oversized message or document closes only that WebSocket. A room is removed from memory after its final connection closes in both transient and persistent modes; persistent rooms finish their pending write first and reload from disk when next opened.

## Operator obligations

- Publish a privacy notice: the relay holds cookbook content until end-to-end encryption lands.
- Cap document size per room and expire rooms after long inactivity.
- Local development uses `ws://127.0.0.1:<port>`; the production Content-Security-Policy allows `wss:` only.
