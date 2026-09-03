# Security Baseline

Enplace is a static PWA. It has no backend logic, accounts, or native sidecar.
Cloudflare Pages serves only the built application. The one network peer is a
y-websocket relay that stores and fans out kitchen documents; it runs no
Enplace code and the app treats it as untrusted transport.

## Kitchen Boundary

- A kitchen is addressed by 130 random bits carried in the URL fragment, which
  browsers never send with the page request, so the static host never sees it.
  The relay does: the id is the room name in the WebSocket path, so relay
  access logs hold it, and a relay operator can open any kitchen it hosts until
  end-to-end encryption lands. Anyone holding the link holds the kitchen;
  sharing the link is the sharing model. The share dialog states, “Anyone with
  this private link can view and change this kitchen.” Its reset-link action
  copies the current document to a new kitchen id, leaving the old room as-is
  while people with the old link lose access to future changes.
- The kitchen document is the sole authority for user content and state. Every
  device keeps its own full copy in IndexedDB; the relay keeps a copy for
  fan-out. Clearing browser storage removes this device's copy only.
- The relay URL is configured at build time with `VITE_ENPLACE_RELAY_URL`, so a
  household can build the app against a relay it runs itself. The
  Content-Security-Policy allows `wss:` connections only.
- Export is always available as a zip of plain files, and `mep mirror` keeps a
  folder replica, so no data is reachable only through the app.
- End-to-end encryption of the document with the key in the fragment is a
  planned follow-up; until then the relay operator can read kitchen content.

## Static Deployment Boundary

Cloudflare Pages builds with Node 22 using `npm run build:static` and publishes
`dist-static`. The deployment contains HTML, JavaScript, CSS, images, the web
manifest, and the service worker only. There is no server process or API.

`public/_redirects` maps browser navigation routes to `index.html`. The service
worker precaches the application shell and uses cached `index.html` when a
navigation fails or returns a non-success response. It does not cache or upload
kitchen contents.

## Security Headers

`public/_headers` applies these headers to every static response:

- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src
  'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' wss:;
  frame-ancestors 'none'; object-src 'none'; base-uri 'self'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`

Scripts and connections are same-origin only, and dynamic code generation is not allowed.
Inline styles remain allowed because the built `index.html` contains its small
initial-page style and the UI uses inline style attributes. Images may also come
from local blobs and data URLs. The app cannot be framed, load plugins, or
change its base URL.

## Verification

Build with `npm run build:static`, then confirm `_headers` and `_redirects` are
present in `dist-static`. Browser verification must serve those headers, load
the app, reload it offline, and open a deep link such as `/shopping`.
