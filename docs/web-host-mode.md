# Web Host Mode

Web host mode keeps the vault on one machine and serves the browser UI plus a small vault API from that same machine.

## Start

Build and start the host:

```bash
cd mise-en-place
npm run build:remote-helper
npm run host:web
```

The host uses `--rust-helper /absolute/path/to/mep-remote-host-helper` when
provided; otherwise it resolves `mep-remote-host-helper` from
`MEP_REMOTE_HOST_HELPER`, `target/release`, or `target/debug` (in that order).
It never invokes Cargo while serving a request.

Web host mode owns its vault mount and persisted folder settings independently of any other runtime. With no `--vault` flag or `MEP_HOST_VAULT_PATH`, an interactive start explains what the vault is and offers the default before creating anything; it creates `~/Enplace` when the default is accepted. Pass a root explicitly to skip the prompt:

```bash
npm run host:web -- --vault /path/to/your/vault
```

Defaults:

- Bind address: `127.0.0.1`
- Port: `4173`
- Real vault root: `~/Enplace` (chosen on first run; see above)
- Virtual vault path inside the app: `/home/vault`
- Host app-data directory: `~/.mep-web-host`
- Recipe folder inside the vault: `cooking/recipes`

Optional flags:

```bash
node ./scripts/start-web-host.mjs --port 4173 --host 127.0.0.1 --appdata ~/.mep-web-host
```

## Access

On the host machine:

- Open `http://127.0.0.1:4173/`

From another device over Tailscale:

1. Start the host server on the host machine.
2. Publish it to the tailnet:

```bash
tailscale serve --bg 4173
```

3. Open the HTTPS URL that Tailscale prints, typically:

```text
https://<machine>.<tailnet>.ts.net
```

Keep the host server bound to `127.0.0.1` and let Tailscale proxy it.

The web host accepts the tailnet DNS name only on a loopback bind and only when Tailscale Serve supplies its user identity header. Funnel traffic does not carry that identity and is not an accepted host route.

## Behavior

- All clients read and write the same host vault.
- Folder selection is disabled in hosted mode. The host server owns the vault path.
- Browser clients do not get direct filesystem access to the host machine. They only use the host API.

Shopping-list authority is deliberately per runtime. A local native installation
has its own app-data `shopping-list.json`. Shared hosted mode has exactly one host
app-data `shopping-list.json`, consumed by every browser client. Clients must not
sync competing app-data copies.

## Notes

- This is local-first, not SaaS. The source of truth stays on the host machine.
- Tailnet users can reach the app if your Tailscale ACLs allow it.
- Secrets still need care. Hosted mode is intended for a trusted private setup, not an internet-facing multi-tenant deployment.
