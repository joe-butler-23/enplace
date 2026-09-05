# Cookbook Relay

The relay speaks y-websocket and stores an opaque Yjs map of encrypted records.
The browser owns the plaintext cookbook, encryption, authenticated decryption,
and compaction; the relay never receives a new cookbook's link secret. See
[security-baseline.md](security-baseline.md) for the encryption and trust boundary.

## Configuration

`.env.static` supplies the production `VITE_ENPLACE_RELAY_URL`; an environment
value overrides it at build time. The build restricts CSP connections to that
relay origin. Production requires `wss:`; loopback `ws:` is available for local
development and synthetic tests. With no relay, cookbooks remain on the device.

An untouched seeded cookbook stays local. Its first edit or opening the sharing
section publishes the encrypted copy. A linked device connects immediately and
waits for an authenticated record before treating an empty cookbook as ready.
A device with an existing committed copy can open offline.

## Hosted relay

`relay/` is a Cloudflare Worker with one Durable Object per room (`y-partyserver`).
It is deployed as `enplace-relay`; encrypted clients connect to
`/parties/kitchen/e1-<derived-room-id>`. The historical `Kitchen` class and route
remain wire identifiers. Storage holds chunked Yjs updates of the encrypted
projection. A room expires after 180 days without a connection; a device with
its saved copy can repopulate it.

The Durable Object hibernates (`static options = { hibernate: true }`): Cloudflare can
evict it from memory while a tab is left open with an idle socket, so duration is
billed only while a message is actually being handled, not for every second a
connection stays open. Every document-changing message is flushed to storage
synchronously in the same message handler before it is acknowledged, so no update
depends on an in-memory debounce timer that hibernation (or an isolate eviction)
could discard; the room's own state, not a timer, decides when it is safe to
consider a room idle. The 180-day retention alarm is unrelated to this flush path
and unaffected by it.

The hosted relay enforces the same byte caps as the reference relay below, with a
smaller message cap (20 MiB instead of 32 MiB) because Cloudflare's own WebSocket
transport refuses frames near 32 MiB before any application code runs; the document
(16 MiB) and awareness (64 KiB) caps are unchanged. Unlike the reference relay's
global 2,000-connection ceiling, the per-room connection cap here is 64 — realistic
for the devices in one household sharing a cookbook, while still bounding the
broadcast cost of one edit. New-room creation is throttled to 20 handshakes per
minute per client IP (a Workers Rate Limiting binding, `NEW_ROOM_LIMITER` in
`wrangler.jsonc`); reconnecting to a room that already has stored content or an
open connection is never throttled by this.

After the root `npm ci`, deploy with `npm run deploy --workspace=enplace-relay`,
then build/deploy the app with `scripts/deploy-site.sh`. Both require the configured
Wrangler account. Only encrypted rooms are accepted; rooms from before
encryption expire under the retention alarm and are not readable by this version.

## Running a relay

```bash
npm run relay -- --port 1234 --host 127.0.0.1 --persist ./cookbooks
```

Without `--persist`, a room is dropped after its last client disconnects. Put the
relay behind TLS for a hosted app. Persistence contains ciphertext for encrypted
cookbooks; it is not a plain-file export and does not mirror local recipe folders.

The reference relay accepts only encrypted `e1-` derived room ids; historical
ids from before encryption are rejected. Its defaults are 32 MiB per message, 16 MiB per serialised room,
64 KiB per awareness update, 1,000 rooms and 2,000 connections. The corresponding
`--max-*` flags accept positive integers. A message must allow at least 64 bytes
more than the maximum document. Invalid or oversized messages close their sender.
The app publishes no awareness profile or cursor data.

Both relays enforce their own per-message, per-document, per-awareness-update and
per-connection limits, and the hosted relay additionally throttles new-room
creation; operators still own overall availability, storage retention, and the
Cloudflare account's billing plan and quotas. Encrypted content does not hide
connection metadata or prevent a malicious relay from withholding data. Hosting
the static JavaScript remains a separate trusted role.
