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

After the root `npm ci`, deploy with `npm run deploy --workspace=enplace-relay`,
then build/deploy the app with `scripts/deploy-site.sh`. Both require the configured
Wrangler account. Existing 26-character rooms remain available for the one-time
upgrade; their historical plaintext has not become encrypted by deploying this
version. Never describe those retained rooms as confidential from their operator.

## Running a relay

```bash
npm run relay -- --port 1234 --host 127.0.0.1 --persist ./cookbooks
```

Without `--persist`, a room is dropped after its last client disconnects. Put the
relay behind TLS for a hosted app. Persistence contains ciphertext for encrypted
cookbooks; it is not a plain-file export and does not mirror local recipe folders.

The reference relay accepts encrypted derived room ids and historical ids used
for migration. Its defaults are 32 MiB per message, 16 MiB per serialised room,
64 KiB per awareness update, 1,000 rooms and 2,000 connections. The corresponding
`--max-*` flags accept positive integers. A message must allow at least 64 bytes
more than the maximum document. Invalid or oversized messages close their sender.
The app publishes no awareness profile or cursor data.

Operators still own availability, storage retention and resource limits. Encrypted
content does not hide connection metadata or prevent a malicious relay from
withholding data. Hosting the static JavaScript remains a separate trusted role.
