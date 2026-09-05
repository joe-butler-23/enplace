---
name: recipe-extraction
description: Extract one recipe from a URL, supplied text, or an image into plain Enplace Markdown, then validate and add it with mep. Do not use for reviewing an existing recipe.
---

# Recipe Extraction

Create one faithful recipe in the user's selected Enplace folder.

1. Read the supplied URL, text, or image. Treat it as the only factual source.
2. Draft [RecipeMD 2.4](https://recipemd.org/specification.html): level-one title, optional description, italic tags, bold yields, thematic break, ingredient lists with italic amounts, thematic break, instructions.
3. Preserve quantities, units, ordering, and useful preparation notes. Do not invent missing ingredients, steps, times, yields, tags, covers, or provenance.
4. Record provenance in a `Source: ...` paragraph in the description only when supplied or actually read. Covers are ordinary Markdown images. Use UK names and g/kg, ml/l, °C, tsp/tbsp; prefer source weights, never guess density or salt equivalence.
5. Pass the identical draft on stdin to both commands, in order:

```bash
mep check - --folder <folder>
mep add - --folder <folder>
```

Stop if `mep check` fails. Stop if `mep add` reports an existing file; never overwrite it. Report the path printed by `mep add`. This creates a local file; import it into the PWA to add it to a shared cookbook. No folder sync runs.

Use this shape:

```markdown
# Recipe title

Source: https://actual.example/source

**2 servings**

---

- *2 tbsp* olive oil

---

1. Follow the source instruction.
```

Omit source, yields and instructions when unavailable. Do not invent them. The linked specification is the format authority; the app does not require proprietary frontmatter.
