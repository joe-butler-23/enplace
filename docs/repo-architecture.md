# Repository Architecture

## Purpose

Enplace is one static PWA over a shared kitchen document. A kitchen is a Yjs document keyed by folder-relative path: Markdown and other text files are merging text, everything else is bytes. Every device holds the whole kitchen in IndexedDB and works offline; a y-websocket relay fans changes between devices; the kitchen id travels in the URL fragment (`#k=<id>`).

## Runtime surface

- `src/core.ts` is the pure TypeScript cooking model. It parses recipes, `Plan.md`, and `Shopping.md`, resolves recipe links and cover paths, and renders paste imports. It does not know where files live.
- `src/kitchen/doc.ts` is the kitchen schema: path normalisation, text-versus-bytes, minimal-diff writes so concurrent edits merge, kitchen ids and link helpers. Shared by the browser adapter, the CLI mirror, and tests.
- `src/host-client/browser-storage.ts` defines the storage adapter contract and the storage helpers used by the application.
- `src/host-client/kitchen-storage.ts` implements the contract over the kitchen document with `y-indexeddb` persistence and a `y-websocket` provider.
- `src/kitchen/store.ts` is the one live read model: parsed recipes, plan, shopping list, paths, and cover URLs, published from every kitchen transaction through `observeKitchen` and read by React with `useSyncExternalStore`. `src/kitchen/actions.ts` holds every domain write as a pure function applied to the live text.
- `src/kitchen/registry.ts`, `sample-pack.ts`, `current.ts`, and `KitchenPanel.tsx` own the current-kitchen record, first-run seeding, and the Settings panel for sharing, export, import, and switching kitchens.
- `src/entry.tsx` boots the kitchen id from the link or the registry, otherwise a new seeded kitchen.
- `src/App.tsx` is routing, planner wiring, settings, the command palette, and view composition; views under `src/views/` render from the store.
- `src/pwa/` owns the offline app shell.
- `cli/index.ts` is the optional Node CLI: `check`, `add`, `list`, `shop` on a folder, and `mirror`, which keeps a folder and a kitchen in step through the relay.
- `tests/static-pwa/` is the primary browser contract: fresh kitchen, persistence across reload, two contexts converging through a relay, import and export, offline reload, and installability.

## Layering rules

1. The kitchen document is the only authority for recipes and app state. A folder exists only as a CLI mirror or plain-file export of it.
2. Browser-private storage holds the kitchen's persisted copy, the current kitchen id, and UI preferences. The relay URL comes from the build-time environment.
3. Domain transformations stay pure and independent of React and storage.
4. All storage access goes through the adapter contract; the app never touches Yjs or the filesystem directly.
5. The relay is the only network transport. There is no server logic, account, native runtime, sidecar, or JSON state.

## Placement checks

```bash
npm run typecheck
npm test
npm run build:static
npm run test:static-pwa
```
