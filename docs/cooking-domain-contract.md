# Cooking-domain contract lock

This is the golden contract for cooking data shared by the CLI,
the standalone TypeScript surface, the web-host bridge, and recipe files. It locks
the observed behavior; it does not make either implementation the owner of the
other surface's semantics. Golden inputs and expected outputs live in
[`fixtures/cooking-domain/golden.json`](../fixtures/cooking-domain/golden.json).

## Canonical persisted representation

Recipe ingredient bullets have exactly three pipe-delimited segments:

```text
- {quantity} | {ingredient} | {label}
```

- Quantity is an opaque string at persistence boundaries and may be blank.
- Ingredient is trimmed and lowercase in the Rust parser; a name shorter than
  two characters is invalid.
- Label is trimmed. The Rust CLI validates it against the configured label
  vocabulary; the shared parser itself does not validate labels.
- A pipe inside any segment is invalid because it creates a fourth segment.
- Markdown uses the `## Ingredients` and `## Method` sibling sections. Method
  order is preserved and rendered as numbered steps.

The checked-in markdown fixture is the exact shape written by the CLI renderer:
[`fixtures/cooking-domain/recipe.md`](../fixtures/cooking-domain/recipe.md).

## Quantity and unit semantics

The two shopping implementations currently differ and both behaviors are
contract-locked until the migration explicitly chooses one:

| Input | TypeScript shopping aggregation | Rust `mep sl add-recipe` |
| --- | --- | --- |
| `1kg` + `500g` | Converts to a common metric bucket: `1.5kg` | Keeps unit buckets: `500 g, 1 kg` |
| `1 tbsp` | Converts to `15ml` | Keeps `1 tbsp` |
| `1 lb` | Converts to rounded metric: `454g` | Keeps `1 lb` |
| `1` / blank unit | Count quantity; pluralizes names when needed | Numeric quantity with an empty unit bucket |
| non-numeric quantity | Preserves no-quantity/raw text | Preserves raw quantity alongside numeric buckets |

The TypeScript parser also recognizes count units (`clove`, `sprig`, `can`,
etc.), strips preparation phrases, excludes water-like ingredients, and applies
lexical aliases such as `parmesan cheese` → `parmesan`. Rust does not perform
those transformations in its pipe parser.

## Labels, ignore, and merge

Rust reads `$MEP_CONFIG_DIR/cooking.toml`. Its default label vocabulary uses
spaced names such as `fruit & veg`, `bakery`, and `tins & jars`; ignore values
and merge keys are normalized to lowercase, and merge is applied before the
second ignore check. Label selection follows configured label order.

TypeScript has a separate built-in vocabulary using hyphenated names such as
`fruit-and-veg`, plus `baking`, `household`, and `toiletries`. Its built-in
ignore list is `water`, `salt`, and `pepper`; its labeler uses lexical keyword
rules and hard-coded aliases. It does not read the Rust `cooking.toml` merge
map in `buildShoppingItems`.

This is an explicit incompatibility, not a normalization rule. For example,
the golden input's `extra virgin olive oil` is merged into `olive oil` by Rust,
but remains a separate TypeScript item; `plain flour` is labeled `bakery` by
the pipe label/Rust config and `baking` by the TypeScript labeler. The same
lexical rules classify `extra virgin olive oil` as `drinks` today because
`virgin` contains the `gin` keyword; that observed false positive is also
preserved in the golden output.

## Deterministic ordering and source attribution

- TypeScript uses insertion-ordered maps and sets. Item order follows the first
  surviving ingredient key, and source labels follow first-seen recipe order.
  Recipe titles are abbreviated and rendered in brackets, e.g.
  `[zulu recipe, alpha recipe]`.
- Rust groups in ordered maps/sets. Item order is ingredient-key order, source
  titles are retained as a sorted structured `sources` field, and display text
  stays source-free so recipe provenance changes do not change item identity.
- Rust recipe path selection sorts and deduplicates explicit paths before
  loading; TypeScript receives the caller's recipe order.
- The TypeScript normalizer collapses simple plural names (`onion`/`onions`),
  while Rust keys the literal parsed ingredient (`onion` and `onions` remain
  separate).

The golden fixture deliberately uses `Zulu Recipe` before `Alpha Recipe` so
that this distinction remains visible in tests.

## Hand-added shopping items

Items added directly on the shopping list carry `manual: true` and are the one
class of item a recipe rebuild does not own:

- `add_shopping_item` inserts at the item's canonical id position, so the list
  stays id-ordered whatever route added the item. Re-adding the same content and
  labels is an error, not a duplicate.
- `apply_shopping_list` retains manual items that the week's recipes do not
  produce, keeping their checked state. Their absence from `desiredItems` is not
  a deletion, so `deleteCount` excludes them and `manualCount` reports how many
  the apply will keep.
- When recipes start producing an item that already exists as manual, the ids
  collide and the recipe-derived item wins: it keeps the checked state, gains
  structured `sources`, and stops being manual. Provenance always beats a
  hand-add for the same content.
- Manual items have no `sources`, so the UI marks them as added rather than
  attributing them to a recipe.

## `.machine` sidecar schema

The sidecar is JSON at `recipes/.machine/{slug}.json` with:

- `schema_version: "1.0.0"`
- `recipe_id`, `markdown_path`, and `generated_at`
- `sync.renderer: "RecipeWriter"` (the schema's persisted renderer identifier)
- `sync.source_job` with `type` and optional source metadata
- `recipe.title`, `source`, `cover`, `added`, `ingredients`, `method`,
  `prep_time`, `cook_time`, and `servings`
- Each structured ingredient uses snake_case fields: `normalized_text`,
  `resolved_ingredient_id`, `resolved_display_name`, `resolution_status`,
  `confidence`, `review_required`, and `resolution_reason`.

The checked-in schema fixture is
[`fixtures/cooking-domain/sidecar.json`](../fixtures/cooking-domain/sidecar.json).
`generated_at` is runtime metadata and must not be compared as a fixed value in
behavior tests.

`mep recipe import` is the only recipe writer. Its sidecar stores
`markdown_path` relative to the recipes directory.

## Host command payload

Rust structs use snake_case internally where that matches the sidecar schema,
but command payloads are serialized with `#[serde(rename_all = "camelCase")]`.
The TypeScript bridge therefore consumes keys such as `resolvedIngredientId`,
`resolvedDisplayName`, `resolutionStatus`, `resolutionPath`, and
`reviewRequired`. The checked-in payload fixture is
[`fixtures/cooking-domain/host-invoke-resolution.json`](../fixtures/cooking-domain/host-invoke-resolution.json).

Snake_case sidecar fields and camelCase host-command fields are intentional boundary
formats; tests must fail if either boundary silently changes. The Rust payload
currently emits required `raw` and `resolutionPath` values while the
TypeScript `IngredientResolutionPayload` type marks `raw` optional and does not
declare `resolutionPath`; this is a documented wire/type incompatibility, not a
reason to silently drop the field during migration.
