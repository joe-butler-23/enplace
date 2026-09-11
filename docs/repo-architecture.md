# Repository Architecture

## Purpose

Enplace is one static PWA over a shared cookbook document. See [cooking contracts](cooking-domain-contract.md) for its schema and [security boundaries](security-baseline.md) for encryption and sharing.

## Runtime surface

- `src/core.ts` is the pure TypeScript cooking model. It parses recipes, `Plan.md`, `Shopping.md`, and the household noun-to-aisle map in `Aisles.md`, resolves recipe links and cover paths, and renders paste imports. It does not know where files live.
- `src/recipe-import/` turns outside material into new cookbook files and never overwrites: `paste-import.ts` validates RecipeMD and writes it with an optional cover; `page-import.ts` reads a pasted or opened HTML page with the Enplace-maintained RecipeClipper module (`recipe-clipper.js`, MIT browser-rewrite ancestry retained in its header, no network) and renders each published recipe as RecipeMD for the chooser in `views/components/ImportPageForm.tsx`. `docs/recipe-clipper.md` owns its evaluation interface and measured retentions.
- `src/cookbook/doc.ts` is the cookbook schema: path normalisation, text-versus-bytes, minimal-diff writes so concurrent edits merge, cookbook ids and link helpers. Shared by browser code and tests.
- `src/host-client/browser-storage.ts` defines the storage adapter contract and the storage helpers used by the application.
- `src/host-client/cookbook-storage.ts` implements the contract over the cookbook document. The encrypted wire document is the persisted copy (`y-indexeddb`, named by the public room) and the transport (`y-websocket`), so a reconnect exchanges only the records each side lacks and offline edits are already sealed records waiting in it. Local-copy readiness means at least one record is committed, independently of transport status and first remote sync.
- `src/cookbook/crypto.ts` owns key derivation and authenticated encryption; `encrypted-provider.ts` owns sealing, decryption and compaction of the wire projection.
- `src/cookbook/opening.ts` owns the opening subscription, cancellation and warning deadline, including local initialization. A warning leaves recovery active; only durable readiness opens the editor.
- `src/cookbook/store.ts` is the one live read model: parsed recipes, plan, shopping list projected from `Shopping.md` and `Aisles.md`, paths, and cover URLs, published from every cookbook transaction through `observeCookbook` and read by React with `useSyncExternalStore`. `src/cookbook/actions.ts` holds every domain write as a pure function applied to the live text.
- `src/cookbook/registry.ts`, `sample-pack.ts`, `current.ts`, and `CookbookPanel.tsx` own the current-cookbook record, first-run seeding, and the Settings panel for sharing, export, import, and switching cookbooks. Seeding is two packs: `sample-pack.pack` (recipes and card thumbnails) is awaited before the app mounts, and `sample-covers.pack` (full-size covers) is fetched after mount, only by the visit that seeded the cookbook.
- `src/entry.tsx` boots the cookbook id from the link or the registry, otherwise a new seeded cookbook.
- `src/App.tsx` is routing, planner wiring, settings, the command palette, and view composition; views under `src/views/` render from the store.
- `src/styles/` holds the stylesheets, one per surface, imported in order by `src/entry.tsx`: `base.css` owns the tokens, element defaults and shared primitives (buttons, icon buttons, menus, the small-label voice, tick boxes); `shell`, `dialogs`, `database`, `planner`, `recipe` and `shopping` style only their own surface and read those tokens.
- `src/pwa/` owns the offline app shell.
- `src/agent/operations.ts` owns structured recipe, planning, shopping and recovery operations over the same cookbook. Local mutations and compact retry receipts share one transaction. `src/agent/session.ts` serializes operations, rechecks authenticated connection readiness and waits for durable relay acknowledgement after mutations.
- `cli/` provides direct cookbook commands and private connection setup. Each command holds one in-memory encrypted peer. Explicit folder commands remain available with `--folder`; files cross the live cookbook boundary only through explicit input/export. See [agent integration](agent-integration.md).
- `tests/static-pwa/` is the primary browser contract: fresh cookbook, persistence across reload, two contexts converging through a relay, import and export, offline reload, and installability.

## Layering rules

1. The cookbook document is the only authority for recipes and app state. A folder exists only as a deliberate import or plain-file export of it.
2. Browser-private storage holds the cookbook's persisted copy, the current cookbook id, and UI preferences. The relay URL comes from the build-time environment.
3. Domain transformations stay pure and independent of React and storage.
4. All storage access goes through the adapter contract; the app never touches Yjs or the filesystem directly.
5. The encrypted relay is the only ongoing cookbook network transport. The CLI opens no listening port and persists no cookbook cache. The app needs no account or model provider.
