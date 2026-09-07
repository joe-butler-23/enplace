# RecipeClipper: unfamiliar-page source audit — 2026-09-06

## Result and next action

Prioritise **field boundaries**, not broader recipe detection. All eight intended
recipes were found, and their original ingredient quantities and required cooking
steps survived. That does not make all eight imports accurate: one also absorbed
shopping cards into its ingredients; four added non-step text; two lost meaningful
ingredient-group boundaries. Every explicitly stated overall serving count was
omitted (six pages).

The strongest defect is the Brindisa import: a shopping-section heading and
**20 commercial rows** follow the real ingredients. Retail pack sizes, prices,
product descriptions and buying controls must not become recipe quantities.
River Cottage also loses the dressing boundary even though its method depends on
that grouping. These are more consequential than the stray attribution lines.

No source, runtime, production cookbook or deployment was changed for this audit.
This report records a baseline, **not an accuracy improvement**.

## Test design and limits

- Source: released Enplace commit `ea3016393f8d5d0f71e3eda5114403ec55e002d4`;
  exact module SHA-256 is in [the summary](evidence/recipe-clipper-fresh-2026-09-06/summary.json).
- Eight complete recipe pages from eight domains absent the established
  638-domain exposed corpus, plus four recipe-like non-recipe pages.
- Two annotators selected pages from disjoint predeclared pools and recorded
  page-content ingredients, steps, groups and servings **before** any extractor
  run. They then cross-reviewed the other group against the frozen annotations.
  The lead inspected the full outputs, disputed boundaries and structured data.
- Selection used 33 bounded Pi-routed reads, including discovery and failed URLs.
  Access failures and rejected selections remain in the private evidence. A
  proposed negative containing real embedded recipes was rejected before testing.
  Nigel Slater's links led to an excluded domain; the assigned Pipers Farm
  substitute declares Edenmoor as canonical. No page was dropped after extraction.
- The declared HTML canonical URL was used as document identity where available,
  consistently and before extraction. This is not evidence of an HTTP redirect.
- Native Node 24.19.0, Playwright 1.58.2 and Chromium performed detached-document
  extraction with networking blocked. All candidates and fields were saved.
  Two separate runs produced identical outputs; zero exceptions, page errors or
  attempted network requests. Frozen annotations and HTML hashes still matched.
- This is a small English-language convenience sample, not an overall accuracy
  estimate, randomized holdout, competitor comparison or UI test. It cannot rule
  out rare errors. These pages are now exposed development evidence.

## Recipes

Every row produced one candidate; there was no alternative candidate rescuing an
error. Every original ingredient-to-amount association and required cooking step
was retained. Additional material, missing groups and missing metadata are scored
separately rather than hidden by that retention result.

| Page | Additional text or lost structure | Overall servings |
| --- | --- | --- |
| [Borough Market chicken skewers](https://boroughmarket.org.uk/recipes/chicken-shish-kebabs-with-roasted-vegetables/) | Image/book credits become two steps. The credits already occur in the publisher's JSON-LD instructions. Ingredient groups remain present. | 3–4 omitted |
| [River Cottage cabbage](https://rivercottage.net/recipes/hughs-roast-hispi-and-shallots-with-miso-dressing/) | Dressing group lost; method refers to the ingredients for that component. | 4 omitted |
| [Brindisa bean salad](https://brindisa.com/blogs/spanish-food-recipes/bean-salad-with-anchoiade-and-sauce-vierge) | Shopping cards become ingredients. Relevant substitution note and a repeated sentence become steps. Existing source overlap between branded products and component lists was not counted as a new defect. | 4–6 omitted |
| [Belazu broccoli salad](https://belazu.com/recipe/chopped-broccoli-salad-with-apple-and-tahini-/) | Ingredient groups and cooking content retained without added field noise. | 6 omitted |
| [Hodmedod's rolls and ragù](https://hodmedods.co.uk/blogs/recipes/sloppy-joes-with-mandolin-salad) | Sharing label becomes a step. Separate component yield remains in its method heading; it must not replace the overall yield. | 4 omitted |
| [Ottolenghi chicken and corn](https://ottolenghi.co.uk/pages/recipes/slow-cooked-chicken-crisp-corn-crust) | Sweetcorn batter group lost; quantities and steps unchanged. | 6 omitted |
| [Sous Chef pasta](https://www.souschef.co.uk/blogs/the-bureau-of-taste/italian-herbs-mix) | Copyright line becomes a step. | Not explicitly stated; not scored |
| [Edenmoor baked rigatoni](https://www.edenmoor.com/blogs/recipes/baked-rigatoni-with-chicken-mushrooms-sage-leeks) | No mismatch in the annotated fields. Retail cheese weight below the recipe correctly stays out. | Not explicitly stated; not scored |

The step-text count includes a relevant note and duplicate sentence on Brindisa,
not four invented cooking procedures. No original quantity swaps were observed;
Brindisa's additional retail quantities are a **separate** ingredient-pollution
problem. Missing ingredient groups can change how a cook assigns ingredients to
components even when every individual row survives.

## Non-recipe controls

| Page | Result |
| --- | --- |
| [Brindisa chorizo product](https://brindisa.com/products/brindisa-chorizo-picante) | No candidate |
| [Belazu harissa product](https://belazu.com/shop-all/rose-harissa/) | Explicit incomplete candidate, missing instructions; storage/allergen text pollutes its ingredient field |
| [Ottolenghi chicken inspiration](https://ottolenghi.co.uk/blogs/stories/chicken-thigh-recipes) | No candidate |
| [Sous Chef temperature guide](https://www.souschef.co.uk/blogs/the-bureau-of-taste/meat-temperatures-the-quick-guide) | Explicit incomplete candidate, missing instructions; navigation text becomes its ingredient |

**Zero complete false recipes out of four controls** does not mean all four were
cleanly rejected. Two noisy partial candidates were returned. The control label
classifies page completeness, not the medical or food-safety validity of its text.

## Follow-up boundaries

1. **Stop commercial and peripheral text crossing field boundaries.** Inspect
   `markup` → `captionFields` region ownership and `readSelectors`/`content` in
   `src/recipe-import/recipe-clipper.js`; separately account for contamination
   already present in publisher JSON-LD before `normalize`. Expected effect:
   remove shopping rows, sharing/footer text and misfiled notes without removing
   real ingredients or instructions. High confidence in the defects; a safe
   general implementation is not yet demonstrated. Do not add site/phrase lists.
2. **Preserve component boundaries.** Inspect caption retention in `readable`,
   `content`, and structured-data enrichment. Expected effect: preserve dressing
   and batter ownership without promoting arbitrary page headings. High
   confidence in these two omissions; generalisation remains untested.
3. **Recover explicitly scoped servings.** Inspect `fields.recipeYield`,
   `markup` metadata reads and enrichment before `normalize`. Expected effect:
   retain the overall source yield without borrowing a subrecipe's count or
   inventing a value from prose. High confidence in six omissions; no repair run.

None of this reopens the rejected shared-reader trial automatically. Its recipe
admission, method ownership and executable-size stop rules still apply. Any
future change must be checked against the full exposed corpus and the independent
negative cases, not just these newly revealed examples.

## Evidence

Public summary: [field counts and immutable identities](evidence/recipe-clipper-fresh-2026-09-06/summary.json).
Raw HTML, acquisition records, blinded annotations, cross-reviews, frozen module,
driver, and both captures are retained privately in the owning repository at
`tmp/recipe-clipper-fresh-2026-09-06/raw-evidence.tar.gz`. Its SHA-256 is recorded
in the summary. Source pages and full recipe text are not republished here.
The archive preserves the original scratch paths in its records; it is evidence,
not a new application dependency. Bead `mise-en-place-5f1` owns this audit.
