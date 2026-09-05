# Security Baseline

Enplace is a static PWA. Cloudflare Pages serves application assets. Browsers
persist only the encrypted projection of the cookbook in IndexedDB, under its
public room name, rebuild the plaintext in memory, and send that same projection
through the relay. The web app manifest is a data: URL written by the page so the
installed app's start URL can carry the link fragment without a network request. File import/export is explicit;
there is no folder mirror or filesystem write API.

## Encryption and sharing

A new link carries a 260-bit random secret in `#k=e1_…`. HKDF-SHA-256 derives an
AES-256-GCM content key and an independent public room identifier using separate
`content` and `room` contexts. The secret and content key are never sent to the
relay. Each record uses a fresh random 96-bit nonce and a 128-bit authentication
tag; associated data binds the protocol version, room, and record identity.
Tampered, substituted, truncated, and wrong-key records fail authentication
before their Yjs updates enter the cookbook.

The relay synchronises a Yjs map of opaque records, not the plaintext cookbook.
Browsers compact this projection by replacing only records already decrypted
into the new snapshot. Concurrent unseen records remain; concurrent encrypted
snapshots merge through the original Yjs document. This preserves offline edits
without teaching the relay the cookbook schema or giving it a decryption key.

Anyone with the full private link can read and change the cookbook. Losing the
link and every local copy loses access; sharing a new link after an upgrade is
an explicit household action. Encryption does not prevent an authorised partner
from deleting shared content, and a relay can still withhold, replay or delete
ciphertext. It sees room identifiers, connection metadata, timing and sizes.
The app does not promise authenticated global freshness against a malicious
relay.

The static application origin, its JavaScript dependencies, and the user's
browser remain trusted: code running as the app can read its key and local data.
CSP and encryption do not protect against a malicious replacement of the app
itself. Exports are deliberately ordinary unencrypted files.

## Previous cookbooks

Old 26-character links were also relay room names and cannot safely become
secret encryption keys. Opening one offers a one-time upgrade: read its previous
shared copy without sending document updates, merge the device's saved copy,
commit a new cookbook locally, then open a fresh encrypted link. The user sends
that link to their partner. The previous IndexedDB copy and room are retained
for recovery; historical plaintext is not retroactively made private. An
unavailable relay blocks upgrading so recent partner changes are not silently
omitted; the saved local copy remains downloadable.

Only new encrypted rooms have the ciphertext-only guarantee. Retiring historical
rooms requires a separate data-retention decision after users have migrated.

## Rendering and network boundary

`RecipeMarkdown.tsx` escapes user-authored HTML, renders Markdown with `marked`,
then sanitises the result with DOMPurify and explicit tag/attribute allowlists.
Links allow HTTP, HTTPS, mailto, tel and relative paths; protocol-relative and
executable/data schemes are inert. Image attributes accept only resolved local
resources. The final sanitised string goes directly to the DOM.

The build fills the CSP relay source from the configured WebSocket URL. It allows
same-origin application requests and that exact relay origin, not arbitrary
`wss:` destinations. Scripts are same-origin with no inline script or eval;
objects, framing, forms and base-URL changes are blocked. Images allow same-origin,
blob and data resources; the manifest is a data: URL only. Inline styles remain necessary for the app's existing
layout and styles. Responses also set `nosniff` and `Referrer-Policy: no-referrer`.

The service worker caches the app shell, not cookbook content. The link fragment
is not part of static page requests. Browser storage can be cleared or lost;
relay persistence and plain-file exports provide separate recovery paths.

## Proof

The release gate checks the served Pages headers and the three browser engines.
Crypto tests reject wrong keys and altered/substituted records. Relay integration
inspects persisted wire bytes and restores a cookbook after every client and the
relay stop. Browser security tests inspect actual sent WebSocket frames, exercise
shared shopping, fire the built CSP, and inspect malicious Markdown in a real DOM.
These are executed implementation checks, not an independent cryptographic audit.

Primitive references: [Web Crypto AES-GCM](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams),
[HKDF derivation](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey),
[DOMPurify security model](https://github.com/cure53/DOMPurify).
