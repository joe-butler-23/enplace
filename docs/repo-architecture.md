# Repository Architecture

## Purpose

Enplace is one static PWA over a shared cookbook document. A cookbook is a Yjs document keyed by folder-relative path: Markdown and other text files are merging text, everything else is bytes. Every device persists the encrypted Yjs projection of the cookbook in IndexedDB and rebuilds the plaintext in memory, so it works offline; the same projection carries changes through a y-websocket relay; the cookbook id travels in the URL fragment (`#k=<id>`).

## Runtime surface

- `src/core.ts` is the pure TypeScript cooking model. It parses recipes, `Plan.md`, and `Shopping.md`, resolves recipe links and cover paths, and renders paste imports. It does not know where files live.
- `src/cookbook/doc.ts` is the cookbook schema: path normalisation, text-versus-bytes, minimal-diff writes so concurrent edits merge, cookbook ids and link helpers. Shared by browser code and tests.
- `src/host-client/browser-storage.ts` defines the storage adapter contract and the storage helpers used by the application.
- `src/host-client/cookbook-storage.ts` implements the contract over the cookbook document. The encrypted wire document is the persisted copy (`y-indexeddb`, named by the public room) and the transport (`y-websocket`), so a reconnect exchanges only the records each side lacks and offline edits are already sealed records waiting in it. Local-copy readiness means at least one record is committed, independently of transport status and first remote sync.
- `src/cookbook/crypto.ts` derives independent content and room keys from a fresh 260-bit fragment secret. `encrypted-provider.ts` seals inner Yjs updates into the wire Y.Map, one record per burst of edits, and folds small records together so the record count stays bounded without re-sending content; a full snapshot rewrites the log only when it holds more than twice the live cookbook. Folding and snapshots delete only records already decrypted here. The relay merges this map without seeing cookbook text or paths.
- `src/cookbook/opening.ts` owns the opening subscription, cancellation and warning deadline, including local initialization. A warning leaves recovery active; only durable readiness opens the editor.
- `src/cookbook/store.ts` is the one live read model: parsed recipes, plan, shopping list, paths, and cover URLs, published from every cookbook transaction through `observeCookbook` and read by React with `useSyncExternalStore`. `src/cookbook/actions.ts` holds every domain write as a pure function applied to the live text.
- `src/cookbook/registry.ts`, `sample-pack.ts`, `current.ts`, and `CookbookPanel.tsx` own the current-cookbook record, first-run seeding, and the Settings panel for sharing, export, import, and switching cookbooks. Seeding is two packs: `sample-pack.pack` (recipes and card thumbnails) is awaited before the app mounts, and `sample-covers.pack` (full-size covers) is fetched after mount, only by the visit that seeded the cookbook.
- `src/entry.tsx` boots the cookbook id from the link or the registry, otherwise a new seeded cookbook.
- `src/App.tsx` is routing, planner wiring, settings, the command palette, and view composition; views under `src/views/` render from the store.
- `src/pwa/` owns the offline app shell.
- `cli/index.ts` is the optional Node CLI: `check`, `add`, `convert`, `list`, and `shop` on a folder. Files cross the app boundary only by import/export; the CLI has no relay connection.
- `tests/static-pwa/` is the primary browser contract: fresh cookbook, persistence across reload, two contexts converging through a relay, import and export, offline reload, and installability.

## Layering rules

1. The cookbook document is the only authority for recipes and app state. A folder exists only as a deliberate import or plain-file export of it.
2. Browser-private storage holds the cookbook's persisted copy, the current cookbook id, and UI preferences. The relay URL comes from the build-time environment.
3. Domain transformations stay pure and independent of React and storage.
4. All storage access goes through the adapter contract; the app never touches Yjs or the filesystem directly.
5. The encrypted relay is the only ongoing network transport. There is no server logic, account, native runtime, sidecar, or JSON state.

## Placement checks

```bash
npm run typecheck
npm test
npm run build:static
npm run test:static-pwa
```
